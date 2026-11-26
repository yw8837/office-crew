// 두 갈래(결정 0031): 목표의 회의가 정체로 끝났거나 결론에 남은 이견이 있고, 참석자(진행자·반대편 빼고)의 입장 줄이 정확히 두 안으로 묶이면
// 안마다 그 안을 민 사람이 한 장 요약을 쓰고(한 번 실행·읽기 전용), 사용자가 나란히 보고 고른다. 본 요약과 저장된 요약이 같을 때만 반영한다.
// 가짜 CLI, 실제 AI 사용량 0
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server/index.js';
import { forkOptions, forkHash, forkPrompt, forkMode, forkCan, FORK_CALLS, BLOCK_ACCEPTS, blockPart } from '../server/mission.js';
import { positionOf } from '../server/meeting.js';
import { sumEstimate } from '../public/js/mission-numbers.js';
import { answerKind } from '../public/js/usage-numbers.js';
import { stageModel, holdKind } from '../public/js/stage-model.js';
import { PROVIDERS } from '../server/providers/index.js';
import { bindLang } from '../server/i18n.js';
import { startTestApp, freePort } from './helpers.js';

bindLang(() => 'ko'); // 순수 함수의 문구(한국어 원문)를 검사한다
let t = null;
const sent = []; // 프로바이더에 넘긴 프롬프트 전체(가짜 CLI 기록은 앞 5,000자만)
const keepRun = {};
const app = async () => {
  if (t) return t;
  t = await startTestApp();
  const p = PROVIDERS.claude;
  keepRun.claude = p.run;
  p.run = (opts, emit) => { sent.push({ agent: opts.agent?.name, id: opts.agent?.id, permission: opts.agent?.permission, prompt: String(opts.prompt || '') }); return keepRun.claude.call(p, opts, emit); };
  return t;
};
const opened = [];
after(async () => {
  if (keepRun.claude) PROVIDERS.claude.run = keepRun.claude;
  for (const a of opened) { try { await a.close(); } catch { /* 이미 닫힘 */ } }
  if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } }
});

const S = (id) => t.app.store.getSession(id);
const idle = (sid) => !t.app.orch.ctx.has(sid);
const mk = async (name, role = '분석', extra = {}) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual', skills: [], ...extra })).json;
const mkTeam = async (name, stages, extra = {}) => (await t.api('POST', '/api/teams', { name, stages, ...extra })).json;
const mark = () => sent.length;
const sentFrom = (from) => sent.slice(from);
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides });
const ctl = (sid, body, api = t.api) => api('POST', `/api/sessions/${sid}/control`, body);
const SUMMARY_HEAD = /^\[두 갈래 — 안 [A-Z] 한 장 요약\]$/m;
const DECIDED_HEAD = '[사용자가 정한 것 — 회의에서 물어 사용자가 답함. 이 답대로 해]';

// 목표 안 팀 회의 단계: 진행자 a, 반대편 o, 참석자 x·y(정리) → 빌드 b. rounds: 회의 바퀴 수
async function forkTeam(tag, { rounds = 3, team = {} } = {}) {
  const a = await mk(`${tag}진행`, '분석'), o = await mk(`${tag}반대`, '정리'), x = await mk(`${tag}엑스`, '정리'), y = await mk(`${tag}와이`, '정리'), b = await mk(`${tag}빌드`, '빌드');
  const tm = await mkTeam(`${tag}팀`, [{ label: '회의', agentIds: [a.id, o.id, x.id, y.id], meeting: { rounds, chairId: a.id, opposeId: o.id } }, { label: '빌드', agentIds: [b.id] }], team);
  return { a, o, x, y, b, tm };
}
// 요청 → 목표 카드 → 확인. signal: 확정 목표 줄에 넣을 신호어(고쳐서 확인), fork: 확인 본문의 두 갈래 값(없으면 보내지 않는다), h: 따로 켠 앱
async function goal(teamId, request, { signal = '', fork, h = null, before = null } = {}) {
  const api = h ? h.api : t.api;
  const get = h ? h.S : S;
  const s = (await api('POST', '/api/sessions', { teamId })).json;
  assert.equal((await api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await api('POST', `/api/sessions/${s.id}/messages`, { text: request });
  await t.waitFor(() => get(s.id).mission?.status === 'draft' && !(h ? h.app : t.app).orch.ctx.has(s.id), 20000, '목표 카드');
  const c = get(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  if (before) before(get(s.id), c);
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const body = { missionId: get(s.id).mission.id, expected: shown(c), review, prep: { research: false, meeting: false }, work: 'stages', ...(fork !== undefined ? { fork } : {}) };
  if (signal) body.edited = { ...shown(c), goal: `${signal} 목표` };
  const r = await api('POST', `/api/sessions/${s.id}/mission/confirm`, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { sid: s.id, card: c };
}
const goalDone = (sid, get = S, isIdle = idle) => t.waitFor(() => isIdle(sid) && !['active', 'waiting'].includes(get(sid).mission.status), 60000, '목표 끝').catch((e) => {
  const s = get(sid);
  throw new Error(`${e.message}: ${JSON.stringify({ status: s.mission?.status, hold: s.runs.at(-1)?.hold || null, log: (s.mission?.log || []).slice(-5).map((x) => x.text) })}`);
});
const forkCard = (sid, get = S) => get(sid).messages.findLast((m) => m.role === 'proposal' && m.kind === 'fork');
const holdOf = (sid, get = S) => get(sid).runs.at(-1)?.hold || null;
const waitHold = (sid, step, get = S) => t.waitFor(() => { const h = holdOf(sid, get); return h?.reason === 'fork' && h.step === step ? h : null; }, 30000, `두 갈래 대기(${step})`);
const hashOf = (card) => createHash('sha256').update(JSON.stringify(card.options.map((o) => [o.key, o.position, o.summary || '']))).digest('hex');

test('1. 순수 함수: 입장 묶기(진행자·반대편은 부르는 쪽이 뺀다, 입장 줄이 하나라도 없으면 null), 정규화(대소문자·앞뒤 문장 부호), 해시, 요약 프롬프트의 네 줄, 모드·참석자 수, 블록 표', () => {
  const op = (id, text) => ({ agent: { id }, text, round: 1, phase: 'opinion' });
  const tn = (id, text, round = 2) => ({ agent: { id }, text, round, phase: 'turn' });
  // 사람마다 가장 늦은 입장 줄(차례가 있으면 차례, 없으면 의견)
  const two = forkOptions([op('x', '입장: A안'), op('y', '입장: B안'), tn('x', '- 입장: **a안.**'), tn('y', '입장: B안')], ['x', 'y']);
  assert.deepEqual(two.map((o) => [o.key, o.agentIds]), [['a', ['x']], ['b', ['y']]], '대소문자·굵게·마침표가 달라도 같은 안');
  assert.equal(two[0].position, 'a안', '보일 글은 그 사람의 마지막 입장 줄(대소문자 그대로, 앞뒤 기호만 떼고)');
  const same = forkOptions([op('x', '입장: A안'), op('y', '입장: A안'), op('z', '입장: B안')], ['x', 'y', 'z']);
  assert.deepEqual(same.map((o) => o.agentIds), [['x', 'y'], ['z']], '같은 안은 한 갈래로 묶고 처음 나온 순서');
  assert.equal(forkOptions([op('x', '입장: A안'), op('y', '그냥 의견')], ['x', 'y']), null, '입장 줄이 없는 사람이 있으면 묶지 않는다(지어내지 않는다)');
  assert.equal(forkOptions([op('x', '입장: A안'), op('y', '입장: B안'), op('z', '입장: C안')], ['x', 'y', 'z']).length, 3, '셋이면 셋(부르는 쪽이 둘일 때만 연다)');
  // 해시: 키·입장·요약 글 그대로
  const opts = [{ key: 'a', position: 'A안', summary: '요약 A' }, { key: 'b', position: 'B안', summary: '요약 B' }];
  assert.equal(forkHash(opts), createHash('sha256').update(JSON.stringify([['a', 'A안', '요약 A'], ['b', 'B안', '요약 B']])).digest('hex'));
  assert.notEqual(forkHash(opts), forkHash([{ ...opts[0], summary: '요약 A!' }, opts[1]]));
  // 요약 프롬프트: 네 줄 형식, 표식 안의 회의 말, 블록·파일 고치기 금지
  const p = forkPrompt({ head: '[확정]', label: '회의', key: 'A', mine: '<A안>', other: 'B안', talk: '### 누구\n말', mark: '0'.repeat(8) });
  assert.match(p, SUMMARY_HEAD);
  for (const h of ['- 무엇을:', '- 왜:', '- 치르는 값:', '- 되돌릴 수 있는지:']) assert.ok(p.includes(h), h);
  assert.ok(p.includes('--- 회의 00000000 시작 ---') && p.includes('＜A안＞'), '에이전트가 쓴 입장·말은 표식 안(< > 전각)');
  assert.deepEqual([forkMode('auto'), forkMode('off'), forkMode('ask'), forkMode(undefined), forkMode('x')], ['auto', 'off', 'ask', 'ask', 'ask']);
  assert.deepEqual([forkCan(3), forkCan(4), forkCan(5)], [false, true, true], '진행자·반대편을 빼고 둘 이상');
  assert.equal(FORK_CALLS, 2);
  assert.deepEqual(BLOCK_ACCEPTS.fork, [], '갈래 요약은 블록을 받지 않는다');
  assert.equal(blockPart({ prep: { kind: 'fork' } }), 'fork');
  assert.equal(answerKind({ prep: { kind: 'fork' }, missionId: 'x' }), 'fork', '사용량 종류: 갈래 요약');
  assert.equal(positionOf('입장: A안', true), 'A안', '원문 그대로 읽기(대소문자)');
});

test('2. 호출 어림: 두 갈래가 켜져 있고 갈릴 수 있는 회의가 있으면 최대에만 2번씩 더한다(끄거나 값이 없으면 그대로)', () => {
  const est = { spent: 1, cap: 40, research: { can: false }, meeting: { can: true, min: 6, max: 9 }, review: 1, returns: 1, cards: null, stages: [{ index: 0, min: 5, max: 9, review: false, drop: false, last: 1 }], fork: { calls: 2, prep: true, stages: 1 } };
  const base = sumEstimate(est, { work: 'stages', meeting: true });
  assert.deepEqual(sumEstimate(est, { work: 'stages', meeting: true, fork: 'ask' }), { ...base, max: base.max + 4 }, '준비 회의 1 + 팀 회의 단계 1');
  assert.deepEqual(sumEstimate(est, { work: 'stages', meeting: false, fork: 'auto' }), { ...base, min: base.min - 6, max: base.max - 9 + 2 }, '준비 회의를 안 하면 팀 회의 단계 몫만');
  assert.deepEqual(sumEstimate(est, { work: 'stages', meeting: true, fork: 'off' }), base);
  const withCards = { ...est, cards: { min: 2, max: 7, last: 2 } };
  assert.deepEqual(sumEstimate(withCards, { work: 'cards', meeting: true, fork: 'ask' }).max, sumEstimate(withCards, { work: 'cards', meeting: true }).max + 2, '일 카드는 팀 단계를 돌지 않아 준비 회의 몫만');
});

test('3. 정체 + 두 안: 묻고 시작(기본) → 요약 받기 → 두 요약(읽기 전용 한 번 실행) → 안 A → 확정 지시로 뒤 단계·검수에, 진 안은 버린 안으로 보고에', async () => {
  await app();
  const { x, y, b, tm } = await forkTeam('갈');
  const from = mark();
  const { sid, card: gc } = await goal(tm.id, `POSSAME STANCEB:${y.name} 정해 줘`);
  assert.deepEqual(gc.fork, { mode: 'ask', can: true, calls: FORK_CALLS }, '목표 카드가 두 갈래 값과 추가 호출 수를 보여 준다');
  const h0 = await waitHold(sid, 'offer');
  const c0 = forkCard(sid);
  assert.equal(h0.msgId, c0.id);
  assert.equal(c0.status, 'offer');
  assert.deepEqual(c0.options.map((o) => [o.key, o.position, o.agentIds, o.writerId]), [['a', 'A안', [x.id], x.id], ['b', 'B안', [y.id], y.id]], '안마다 민 사람(진행자·반대편은 빼고)');
  assert.equal(c0.calls, FORK_CALLS);
  assert.equal(sentFrom(from).filter((p) => SUMMARY_HEAD.test(p.prompt)).length, 0, '묻기 전에는 요약을 쓰지 않는다');
  assert.equal(S(sid).mission.status, 'waiting');
  assert.ok(S(sid).mission.forkAt && S(sid).mission.forkAt.msgId === c0.id, '끊겨도 다시 띄울 수 있게 적어 둔다');
  // 고를 수 없는 값은 받지 않는다
  assert.equal((await ctl(sid, { action: 'fork', pick: 'a' })).json.ok, false, '묻는 단계에서는 요약 받기·팀이 정해만');
  const used0 = S(sid).mission.calls.used;
  assert.equal((await ctl(sid, { action: 'fork', pick: 'write' })).json.ok, true);
  const h1 = await waitHold(sid, 'pick');
  const c1 = forkCard(sid);
  assert.equal(c1.status, 'open');
  const sums = sentFrom(from).filter((p) => SUMMARY_HEAD.test(p.prompt));
  assert.deepEqual(sums.map((p) => p.id).sort(), [x.id, y.id].sort(), '안마다 그 안을 민 사람이 한 번');
  assert.ok(sums.every((p) => p.permission === 'plan'), '읽기 전용(그 실행만)');
  assert.ok(c1.options.every((o) => o.state === 'done' && o.summary.includes('- 무엇을:') && o.msgId));
  assert.equal(c1.spent, S(sid).mission.calls.used - used0, '추가로 든 호출 수');
  assert.equal(c1.spent, 2);
  assert.equal(c1.hash, hashOf(c1));
  assert.equal(h1.msgId, c1.id);
  const sm = S(sid).messages.filter((m) => m.prep?.kind === 'fork');
  assert.equal(sm.length, 2);
  assert.ok(sm.every((m) => m.once && answerKind(m) === 'fork'), '갈래 요약 답(한 번 실행)');
  const before = mark();
  const r = await ctl(sid, { action: 'fork', pick: 'a', hash: hashOf(c1) });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  await goalDone(sid);
  const m = S(sid).mission;
  assert.equal(m.status, 'done');
  assert.equal(m.forkAt, undefined, '고르면 지운다');
  assert.equal(forkCard(sid).status, 'picked');
  assert.equal(forkCard(sid).picked, 'a');
  const d = m.decided.find((x0) => x0.fork);
  assert.ok(d && d.stageIndex === 0 && d.answer.includes('안 A') && d.about.includes('A안') && d.about.includes('가짜 안 A의 할 일'));
  // 뒤 단계(빌드)와 검수: 고른 안의 요약은 표식 안, "사용자가 골랐다"는 사실 줄만 표식 밖
  const ps = sentFrom(before);
  const work = ps.find((p) => p.id === b.id && p.prompt.includes('"빌드"를 네가 맡았어'));
  const rv = ps.find((p) => p.prompt.includes('[기준 판정 — 1번째 검수]'));
  for (const p of [work, rv]) {
    assert.ok(p, '뒤 단계·검수 프롬프트');
    const body = p.prompt.slice(p.prompt.indexOf(DECIDED_HEAD));
    const mm = body.match(/--- 질문 ([0-9a-f]{8}) 시작 ---\n([\s\S]*?)\n--- 질문 \1 끝 ---\n사용자의 답: ([^\n]*)/);
    assert.ok(mm, '확정 블록');
    assert.ok(mm[2].includes('가짜 안 A의 할 일') && mm[2].includes('고른 안(에이전트가 쓴 요약)'), '요약은 표식 안');
    assert.ok(!mm[3].includes('가짜') && mm[3].includes('안 A'), '표식 밖은 코드가 쓴 사실 줄');
  }
  // 진행 기록·완주 보고
  assert.ok(m.log.some((l) => l.kind === 'fork' && l.by === 'user' && l.text.includes('안 A')), '사용자 선택 줄');
  assert.ok(m.log.some((l) => l.kind === 'fork' && l.by === 'user' && l.text.includes('요약을 받아 보기로')), '요약 받기도 사용자 선택');
  const report = S(sid).messages.find((x0) => x0.id === m.reportMsgId);
  assert.deepEqual(report.forks.map((f) => [f.picked, f.chosen, f.dropped]), [['a', 'A안', ['B안']]], '진 안은 버린 안');
  assert.equal(report.answers.fork, 2, '종류별 답 수에 갈래 요약');
  // 무대: 대기 중에는 내 차례가 그 회의 역 안
  const run = S(sid).runs.findLast((r0) => r0.mission === 'work');
  const fake = { ...run, endedAt: null, status: 'waiting', stageIndex: 0, hold: { reason: 'fork', step: 'pick', stageIndex: 0, msgId: c1.id, at: 1 } };
  const sm2 = stageModel({ run: fake, mission: { ...m, status: 'waiting' }, agents: t.app.store.all('agents') });
  assert.deepEqual([sm2.ask?.kind, sm2.ask?.target, sm2.ask?.msgId, sm2.ask?.station, sm2.stations[0].state], ['fork', 'card', c1.id, 0, 'wait']);
  assert.equal(holdKind(fake, 0), 'fork');
});

test('4. 본 요약과 저장된 요약이 다르면 반영하지 않고 카드를 다시 보여 준다. 맞는 해시로 고르면 반영(안 B). "팀이 정해"는 확정 지시 없이 지금 결론대로', async () => {
  await app();
  const { y, tm } = await forkTeam('대');
  const { sid } = await goal(tm.id, `POSSAME STANCEB:${y.name} 정해 줘`, { fork: 'auto' });
  await waitHold(sid, 'pick');
  const c = forkCard(sid);
  const n = t.events.length;
  const bad = await ctl(sid, { action: 'fork', pick: 'b', hash: '0'.repeat(64) });
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.stale, true);
  assert.equal(holdOf(sid)?.reason, 'fork', '대기는 그대로');
  assert.ok(!(S(sid).mission.decided || []).some((d) => d.fork), '반영하지 않았다');
  assert.ok(t.events.slice(n).some((e) => e.type === 'message' && e.data.message?.id === c.id), '카드를 다시 보낸다');
  assert.ok(S(sid).mission.log.some((l) => l.kind === 'fork' && l.text.includes('본 요약과 저장된 요약이 달라')));
  assert.equal((await ctl(sid, { action: 'fork', pick: 'b', hash: hashOf(c) })).json.ok, true);
  await goalDone(sid);
  assert.equal(S(sid).mission.decided.find((d) => d.fork).answer.includes('안 B'), true);
  // 팀이 정해
  const t2 = await forkTeam('팀정');
  const g2 = await goal(t2.tm.id, `POSSAME STANCEB:${t2.y.name} 정해 줘`, { fork: 'auto' });
  await waitHold(g2.sid, 'pick');
  assert.equal((await ctl(g2.sid, { action: 'fork', pick: 'team' })).json.ok, true);
  await goalDone(g2.sid);
  const m2 = S(g2.sid).mission;
  assert.ok(!(m2.decided || []).some((d) => d.fork), '확정 지시 없음');
  assert.equal(forkCard(g2.sid).status, 'team');
  const rep = S(g2.sid).messages.find((x) => x.id === m2.reportMsgId);
  assert.deepEqual(rep.forks.map((f) => [f.picked, f.dropped.length]), [['team', 0]]);
});

test('5. 열지 않는 경우: 목표에서 끔 · 팀에서 끔 · 안이 하나(모두 같은 안) · 바로 시작(묻기 없이 요약부터) · 결론의 남은 이견만으로도 연다(2바퀴)', async () => {
  await app();
  const t1 = await forkTeam('끔');
  const g1 = await goal(t1.tm.id, `POSSAME STANCEB:${t1.y.name} 정해 줘`, { fork: 'off' });
  await goalDone(g1.sid);
  assert.equal(forkCard(g1.sid), undefined, '목표에서 끔');
  const t2 = await forkTeam('팀끔', { team: { fork: 'off' } });
  assert.equal(t.app.store.get('teams', t2.tm.id).fork, 'off', '팀에 저장');
  const g2 = await goal(t2.tm.id, `POSSAME STANCEB:${t2.y.name} 정해 줘`);
  assert.equal(g2.card.fork.mode, 'off', '목표 카드의 기본값은 팀 값');
  await goalDone(g2.sid);
  assert.equal(forkCard(g2.sid), undefined, '팀에서 끔');
  const t3 = await forkTeam('하나');
  const g3 = await goal(t3.tm.id, `POSSAME STANCEB:${t3.o.name} 정해 줘`); // 반대편만 B안: 나머지 둘은 같은 안
  await goalDone(g3.sid);
  assert.equal(forkCard(g3.sid), undefined, '안이 하나면 열지 않는다');
  assert.ok(S(g3.sid).mission.log.some((l) => l.kind === 'stall'), '정체는 그대로');
  // 2바퀴 회의(정체 없음) + 결론의 남은 이견 + 의견 입장 두 갈래 → 바로 시작이면 묻지 않고 요약부터
  const t4 = await forkTeam('이견', { rounds: 2 });
  const from = mark();
  const g4 = await goal(t4.tm.id, `STANCEB:${t4.y.name} 정해 줘`, { signal: 'CONCLUDEFMT', fork: 'auto' });
  await waitHold(g4.sid, 'pick');
  assert.ok(!S(g4.sid).mission.log.some((l) => l.kind === 'stall'), '정체가 아니라 남은 이견으로');
  assert.equal(sentFrom(from).filter((p) => SUMMARY_HEAD.test(p.prompt)).length, 2);
  assert.ok(!S(g4.sid).mission.log.some((l) => l.text.includes('요약을 받아 보기로')), '바로 시작은 묻지 않는다');
  await ctl(g4.sid, { action: 'fork', pick: 'team' });
  await goalDone(g4.sid);
});

test('6. 상한: 남은 호출이 2번보다 적거나 요약 쓸 사람의 AI 가 구독 한도 상한을 넘었으면 요약을 쓰지 않고 지금처럼 결론으로(기록 한 줄). 묻고 시작에서 "요약 받기"를 누를 때도 다시 본다', async () => {
  await app();
  // 호출 상한: 묻는 동안 남은 호출을 1번으로 줄여 둔다
  const t1 = await forkTeam('상한');
  const g1 = await goal(t1.tm.id, `POSSAME STANCEB:${t1.y.name} 정해 줘`);
  await waitHold(g1.sid, 'offer');
  const m1 = S(g1.sid).mission;
  m1.calls.cap = m1.calls.used + 1;
  const from = mark();
  assert.equal((await ctl(g1.sid, { action: 'fork', pick: 'write' })).json.ok, true);
  await t.waitFor(() => holdOf(g1.sid)?.reason === 'cap' || (idle(g1.sid) && m1.status !== 'active'), 30000, '다음 상한 질문');
  assert.equal(sentFrom(from).filter((p) => SUMMARY_HEAD.test(p.prompt)).length, 0, '요약을 쓰지 않았다');
  assert.equal(forkCard(g1.sid).status, 'skipped');
  assert.ok(m1.log.some((l) => l.kind === 'fork' && l.text.includes('호출 상한')), '기록 한 줄');
  if (holdOf(g1.sid)?.reason === 'cap') await ctl(g1.sid, { action: 'more' });
  await goalDone(g1.sid);
  assert.ok(!(m1.decided || []).some((d) => d.fork));
  // 구독 한도 상한: 묻는 동안 요약 쓸 사람(Claude)의 5시간 창을 상한 이상으로
  const t2 = await forkTeam('한도');
  const was = t.app.store.settings.limitCap;
  t.app.store.settings.limitCap = 90;
  const limits = (t.app.store.usage.limits ||= {});
  const keep = limits.claude;
  try {
    const g2 = await goal(t2.tm.id, `POSSAME STANCEB:${t2.y.name} 정해 줘`);
    await waitHold(g2.sid, 'offer');
    limits.claude = { windows: { five_hour: { pct: 95, resetsAt: Math.floor(Date.now() / 1000) + 3600 } }, observedAt: Date.now() };
    const from2 = mark();
    await ctl(g2.sid, { action: 'fork', pick: 'write' });
    await t.waitFor(() => holdOf(g2.sid)?.reason === 'limitcap', 30000, '다음 단계 앞 구독 한도 상한 질문');
    assert.equal(sentFrom(from2).filter((p) => SUMMARY_HEAD.test(p.prompt)).length, 0);
    assert.equal(forkCard(g2.sid).status, 'skipped');
    assert.ok(S(g2.sid).mission.log.some((l) => l.kind === 'fork' && l.text.includes('구독 한도 상한')));
    await ctl(g2.sid, { action: 'accept' });
    await goalDone(g2.sid);
  } finally { if (keep) limits.claude = keep; else delete limits.claude; t.app.store.settings.limitCap = was; }
});

test('7. 요약 하나가 실패하면 갈래 없이 결론으로 · 요약에 그 차례가 받지 않는 블록이 있으면 읽지 않고 기록 한 줄', async () => {
  await app();
  const t1 = await forkTeam('실');
  const g1 = await goal(t1.tm.id, `POSSAME STANCEB:${t1.y.name} 정해 줘`, { signal: `FORKFAIL:${t1.y.name}`, fork: 'auto' });
  await goalDone(g1.sid);
  const c1 = forkCard(g1.sid);
  assert.equal(c1.status, 'failed');
  assert.deepEqual(c1.options.map((o) => o.state), ['done', 'failed']);
  assert.ok(!(S(g1.sid).mission.decided || []).some((d) => d.fork));
  assert.ok(S(g1.sid).mission.log.some((l) => l.kind === 'fork' && l.text.includes('요약을 받지 못해서')));
  const t2 = await forkTeam('블');
  const g2 = await goal(t2.tm.id, `POSSAME STANCEB:${t2.y.name} 정해 줘`, { signal: 'FORKBLOCK', fork: 'auto' });
  await waitHold(g2.sid, 'pick');
  const lines = S(g2.sid).mission.log.filter((l) => l.kind === 'block');
  assert.equal(lines.length, 2, '요약 둘 다');
  assert.ok(lines.every((l) => l.text.includes('갈래 요약') && l.text.includes('oc-ask')));
  assert.equal(S(g2.sid).messages.filter((m) => (m.asks || []).length).length, 0, '질문 창을 띄우지 않았다');
  await ctl(g2.sid, { action: 'fork', pick: 'team' });
  await goalDone(g2.sid);
});

// 같은 데이터 폴더로 앱을 새로 만든다(끊김 흉내)
async function reopen() {
  const a = createApp({ home: path.join(t.root, 'home'), port: 0, detect: false });
  a.store.settings.lang = 'ko';
  const port = await a.listen(await freePort());
  a.store.settings.mockSpeed = 0.05;
  opened.push(a);
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Office-Token': a.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 비JSON */ }
    return { status: r.status, json };
  };
  return { app: a, api, S: (id) => a.store.getSession(id), idle: (id) => !a.orch.ctx.has(id) };
}
async function crash(h, sid, ready) {
  const file = path.join(h.app.store.dirs.sessions, `${sid}.json`);
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  await t.waitFor(() => ready(read()), 10000, '디스크에 끊길 자리');
  h.app.store.closed = true;
  h.app.store.close = () => {};
  await h.app.close();
  return reopen();
}

test('8. 끊김·이어서: 카드가 떠 있는 동안 끊기면 이어서 같은 카드를 호출 없이 다시 띄운다. 요약 하나만 쓰고 끊기면 쓴 것은 다시 쓰지 않는다', async () => {
  await app();
  const { y, tm } = await forkTeam('끊');
  const h1 = await reopen();
  const { sid } = await goal(tm.id, `POSSAME STANCEB:${y.name} 정해 줘`, { fork: 'auto', h: h1 });
  await t.waitFor(() => { const hd = h1.S(sid).runs.at(-1)?.hold; return hd?.reason === 'fork' && hd.step === 'pick'; }, 30000, '두 갈래 대기');
  const c0 = forkCard(sid, h1.S);
  const h2 = await crash(h1, sid, (d) => d?.mission?.forkAt && d.messages.some((m) => m.kind === 'fork' && m.status === 'open'));
  assert.equal(h2.S(sid).mission.status, 'cut');
  const from = mark();
  const r = await h2.api('POST', `/api/sessions/${sid}/mission/resume`, { missionId: h2.S(sid).mission.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const hold = await t.waitFor(() => { const hd = h2.S(sid).runs.at(-1)?.hold; return hd?.reason === 'fork' && hd.step === 'pick' ? hd : null; }, 20000, '다시 띄운 카드');
  assert.equal(sent.length, from, '호출 없이');
  assert.equal(hold.msgId, c0.id, '같은 카드');
  assert.ok(h2.S(sid).mission.log.some((l) => l.kind === 'resume' && l.text.includes('두 갈래')));
  assert.equal((await h2.api('POST', `/api/sessions/${sid}/control`, { action: 'fork', pick: 'a', hash: hashOf(forkCard(sid, h2.S)) })).json.ok, true);
  await goalDone(sid, h2.S, h2.idle);
  assert.equal(h2.S(sid).mission.status, 'done');
  assert.ok(h2.S(sid).mission.decided.some((d) => d.fork));
  // 요약 하나만 쓰고 끊김: y 의 요약만 늦게(3초) 끝난다
  const t2 = await forkTeam('반끊');
  const h3 = await reopen();
  const g2 = await goal(t2.tm.id, `POSSAME STANCEB:${t2.y.name} 정해 줘`, { fork: 'auto', h: h3, signal: `FORKSLOW:${t2.y.name}` });
  const h4 = await crash(h3, g2.sid, (d) => d?.messages?.some((m) => m.kind === 'fork' && m.options?.[0]?.state === 'done' && m.options?.[1]?.state !== 'done'));
  const c1 = forkCard(g2.sid, h4.S);
  assert.equal(c1.options[0].state, 'done');
  const from2 = mark();
  assert.equal((await h4.api('POST', `/api/sessions/${g2.sid}/mission/resume`, { missionId: h4.S(g2.sid).mission.id })).status, 200);
  await t.waitFor(() => { const hd = h4.S(g2.sid).runs.at(-1)?.hold; return hd?.reason === 'fork' && hd.step === 'pick'; }, 30000, '두 갈래 대기(이어서)');
  const again = sentFrom(from2).filter((p) => SUMMARY_HEAD.test(p.prompt));
  assert.deepEqual(again.map((p) => p.id), [t2.y.id], '쓰지 못한 요약만 다시');
  assert.equal(sentFrom(from2).filter((p) => p.prompt.includes('[회의 — ')).length, 0, '회의는 다시 돌지 않는다');
  await h4.api('POST', `/api/sessions/${g2.sid}/control`, { action: 'fork', pick: 'team' });
  await goalDone(g2.sid, h4.S, h4.idle);
});
