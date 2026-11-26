// 진행자에게 질문(결정 0031): 일 카드 답 끝의 oc-lead 블록 → 카드는 "진행자에게 질문 중" → 진행자가 한 번 실행·읽기 전용으로 답 → 카드 담당이 같은 대화를 이어 간다(카드 시작 수에 안 센다).
// 진행자가 사람이 정할 일이라 보면 oc-ask 로 사용자에게(질문 창, 답은 mission.decided), 팀이 짧게 의논해야 풀리면 oc-meet 로 작은 회의를 청한다(사용자가 허락해야 열린다).
// 가짜 CLI, 실제 AI 사용량 0
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { parseLead, parseMeet, leadPrompt, leadRule, leadReply, smallMeetCalls, LEAD_MAX, SMALL_MEET_MAX, BLOCK_ACCEPTS, blockPart } from '../server/mission.js';
import { answerKind } from '../public/js/usage-numbers.js';
import { PROVIDERS } from '../server/providers/index.js';
import { bindLang } from '../server/i18n.js';
import { startTestApp, freePort } from './helpers.js';

bindLang(() => 'ko');
let t = null;
const sent = [];
const keepRun = {};
const app = async () => {
  if (t) return t;
  t = await startTestApp();
  const p = PROVIDERS.claude;
  keepRun.claude = p.run;
  p.run = (opts, emit) => { sent.push({ agent: opts.agent?.name, id: opts.agent?.id, permission: opts.agent?.permission, resumeId: opts.resumeId || null, prompt: String(opts.prompt || '') }); return keepRun.claude.call(p, opts, emit); };
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
const mkTeam = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const mark = () => sent.length;
const sentFrom = (from) => sent.slice(from);
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides });
const ctl = (sid, body, api = t.api) => api('POST', `/api/sessions/${sid}/control`, body);
const LEAD_HEAD = /^\[진행자에게 온 질문 — 카드 k\d+\]$/m;
const REPLY_HEAD = /^\[진행자의 답 — 카드 k\d+/m;

// 진행자 L(분석), 작업 P·Q(정리), 검수 R → 일 카드 계획: k1 은 명단 첫 사람(L), k2 는 둘째(P)
async function leadTeam(tag) {
  const l = await mk(`${tag}진행`, '분석'), p = await mk(`${tag}피`, '정리'), q = await mk(`${tag}큐`, '정리'), r = await mk(`${tag}검수`, '검수');
  const tm = await mkTeam(`${tag}팀`, [{ label: '분석', agentIds: [l.id] }, { label: '작업', agentIds: [p.id, q.id] }, { label: '검수', agentIds: [r.id] }]);
  return { l, p, q, r, tm };
}
async function goal(teamId, signal, { h = null, work = 'cards' } = {}) {
  const api = h ? h.api : t.api;
  const get = h ? h.S : S;
  const s = (await api('POST', '/api/sessions', { teamId })).json;
  assert.equal((await api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await api('POST', `/api/sessions/${s.id}/messages`, { text: '정리해 줘' });
  await t.waitFor(() => get(s.id).mission?.status === 'draft' && !(h ? h.app : t.app).orch.ctx.has(s.id), 20000, '목표 카드');
  const c = get(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const r = await api('POST', `/api/sessions/${s.id}/mission/confirm`, { missionId: get(s.id).mission.id, expected: shown(c), edited: { ...shown(c), goal: `${signal} 목표` }, review, prep: { research: false, meeting: false }, work });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return s.id;
}
const goalDone = (sid, get = S, isIdle = idle) => t.waitFor(() => isIdle(sid) && !['active', 'waiting'].includes(get(sid).mission.status), 60000, '목표 끝').catch((e) => {
  const s = get(sid);
  throw new Error(`${e.message}: ${JSON.stringify({ status: s.mission?.status, hold: s.runs.at(-1)?.hold || null, log: (s.mission?.log || []).slice(-5).map((x) => x.text) })}`);
});
const openAsk = (get, sid) => { for (const m of get(sid).messages) for (const a of m.asks || []) if (a.status === 'open') return { m, a }; return null; };
const card = (sid, id, get = S) => (get(sid).mission.cards || []).find((c) => c.id === id);

test('1. 순수 함수: oc-lead 읽기(맨 끝 블록만, 질문 한 줄 300자, 맥락 600자), oc-meet 읽기(주제 한 줄, 참석자 2~3명), 프롬프트 조각, 블록 표, 사용량 종류', () => {
  const p = parseLead('일했어.\n\n```oc-lead\n{"question":"어느 파일을\\n고칠까?","context":"맥락 1\\n맥락 2"}\n```');
  assert.deepEqual([p.question, p.context], ['어느 파일을 고칠까?', '맥락 1\n맥락 2']);
  assert.ok(p.from > 0 && p.to > p.from);
  assert.equal(parseLead('```oc-lead\n{"question":"q"}\n```\n\n뒤에 글'), null, '맨 끝 블록만');
  assert.equal(parseLead('```oc-lead\n{"context":"질문 없음"}\n```').error, 'shape');
  assert.equal(parseLead('```oc-lead\n{망가짐\n```').error, 'json');
  assert.equal([...parseLead(`\`\`\`oc-lead\n${JSON.stringify({ question: 'ㄱ'.repeat(500), context: 'ㄴ'.repeat(900) })}\n\`\`\``).question].length, 300);
  const mt = parseMeet('같이 보자.\n\n```oc-meet\n{"topic":"주제","people":["가","나","다","라"]}\n```');
  assert.deepEqual([mt.topic, mt.people], ['주제', ['가', '나', '다']], '참석자는 3명까지');
  assert.equal(parseMeet('```oc-meet\n{"topic":"주제","people":["가"]}\n```').error, 'shape', '2명 미만');
  assert.equal(parseMeet('```oc-meet\n{"people":["가","나"]}\n```').error, 'shape', '주제 없음');
  assert.deepEqual([LEAD_MAX, SMALL_MEET_MAX, smallMeetCalls(2), smallMeetCalls(3)], [2, 2, 3, 4], '작은 회의: 의견 사람 수 + 결론 1');
  const rule = leadRule(1);
  assert.ok(rule.includes('```oc-lead') && rule.includes('남은 질문: 1번'));
  const lp = leadPrompt({ head: '[확정]', id: 'k1', owner: '담당', card: { title: '제목', kind: 'build', done: '', files: [], not: '' }, question: '<질문>', context: '맥락', roster: [{ name: '가', role: '정리' }, { name: '나', role: '조사' }], canAsk: true, canMeet: true, mark: '0'.repeat(8) });
  assert.match(lp, LEAD_HEAD);
  assert.ok(lp.includes('--- 질문 00000000 시작 ---') && lp.includes('＜질문＞'), '담당이 쓴 질문은 표식 안(< > 전각)');
  assert.ok(lp.includes('```oc-ask') && lp.includes('```oc-meet') && lp.includes('- 가 (정리)'));
  const lp2 = leadPrompt({ head: '', id: 'k1', card: { title: '' }, question: 'q', canAsk: false, canMeet: false, mark: '0'.repeat(8) });
  assert.ok(!lp2.includes('```oc-ask') && !lp2.includes('```oc-meet'), '물을 수 없거나 작은 회의 상한이면 그 안내를 빼고');
  const rp = leadReply({ id: 'k1', question: 'q?', answer: '진행자 답', meet: '작은 회의 결론', mark: '0'.repeat(8) });
  assert.match(rp, REPLY_HEAD);
  assert.ok(rp.includes('--- 답 00000000 시작 ---') && rp.includes('진행자 답') && rp.includes('작은 회의 결론'));
  assert.ok(BLOCK_ACCEPTS.cards.includes('oc-lead') && !BLOCK_ACCEPTS.work.includes('oc-lead'), '일 카드에서만 받는다');
  assert.deepEqual(BLOCK_ACCEPTS.lead, ['oc-ask', 'oc-meet']);
  assert.deepEqual(BLOCK_ACCEPTS.meet, []);
  assert.deepEqual([blockPart({ prep: { kind: 'lead' } }), blockPart({ prep: { kind: 'meet' } })], ['lead', 'meet']);
  assert.deepEqual([answerKind({ prep: { kind: 'lead' } }), answerKind({ prep: { kind: 'meet' } })], ['lead', 'meeting']);
});

test('2. 카드가 진행자에게 묻는다: 카드는 "질문 중"으로 멈추고, 진행자가 읽기 전용 한 번 실행으로 답하고, 카드는 같은 대화를 이어 간다(시작 수는 그대로). 고정 지시에 oc-lead 안내', async () => {
  await app();
  const { l, p, tm } = await leadTeam('묻');
  const from = mark();
  const sid = await goal(tm.id, `LEADQ:${p.name} LEADSLOW`);
  // 진행자가 답하는 동안 k2 는 질문 중
  const asking = await t.waitFor(() => card(sid, 'k2')?.lead, 30000, '카드 질문 중');
  assert.ok(asking.question.includes('LEADQ'));
  await goalDone(sid);
  const m = S(sid).mission;
  assert.equal(m.status, 'done');
  const k2 = card(sid, 'k2');
  assert.equal(k2.status, 'done');
  assert.equal(k2.lead, undefined, '답을 받으면 질문 중 표시를 지운다');
  assert.equal(k2.leadAsks, 1);
  assert.equal(k2.starts, 1, '진행자 답 뒤 이어 쓰기는 같은 시작(카드 시작 수에 안 센다)');
  const ps = sentFrom(from);
  const lead = ps.filter((x) => LEAD_HEAD.test(x.prompt));
  assert.equal(lead.length, 1);
  assert.equal(lead[0].id, l.id, '목표의 진행자가 답한다');
  assert.equal(lead[0].permission, 'plan', '읽기 전용(그 실행만)');
  assert.ok(lead[0].prompt.includes('LEADQ 어떻게 할까?') && lead[0].prompt.includes('가짜 맥락'), '질문과 맥락');
  const cont = ps.find((x) => REPLY_HEAD.test(x.prompt));
  assert.ok(cont, '카드 담당에게 진행자의 답');
  assert.equal(cont.id, p.id);
  assert.ok(cont.resumeId, '같은 대화를 이어 간다');
  assert.ok(cont.prompt.includes('LEADANSWER 진행자 답') && /--- 답 [0-9a-f]{8} 시작 ---/.test(cont.prompt), '진행자의 답은 표식 안의 참고 자료');
  const cardPrompt = ps.find((x) => x.id === p.id && /^\[일 카드 k2\]$/m.test(x.prompt));
  assert.ok(cardPrompt.prompt.includes('```oc-lead'), '일 카드 고정 지시에 oc-lead 안내');
  const l1 = ps.find((x) => x.id === l.id && /^\[일 카드 k1\]$/m.test(x.prompt));
  assert.ok(l1 && !l1.prompt.includes('```oc-lead'), '진행자가 맡은 카드에는 안내하지 않는다(자기에게 묻지 않는다)');
  const kmsg = S(sid).messages.find((x) => x.card?.id === 'k2' && !x.cardTail);
  assert.ok(kmsg.text.includes('LEADCONT-k2'), '이어 쓴 글은 같은 카드 답에');
  assert.ok(kmsg.leadAsks?.length === 1 && kmsg.leadAsks[0].msgId, '블록 자리와 진행자 답 메시지');
  const lm = S(sid).messages.find((x) => x.id === kmsg.leadAsks[0].msgId);
  assert.ok(lm.once && lm.prep?.kind === 'lead' && answerKind(lm) === 'lead');
  assert.ok(m.log.some((x) => x.kind === 'lead' && x.text.includes('k2') && x.text.includes('진행자에게 물었어')));
  const report = S(sid).messages.find((x) => x.id === m.reportMsgId);
  assert.equal(report.answers.lead, 1, '완주 보고의 종류별 답 수에 진행자 답');
});

test('3. 상한: 카드당 진행자 질문 2번. 넘으면 블록을 무시하고 기록 한 줄(그 답은 끝의 두 칸을 다시 받는다)', async () => {
  await app();
  const { p, tm } = await leadTeam('상한');
  const from = mark();
  const sid = await goal(tm.id, `LEADQMORE:${p.name}`);
  await goalDone(sid);
  const k2 = card(sid, 'k2');
  assert.equal(k2.leadAsks, LEAD_MAX);
  assert.equal(sentFrom(from).filter((x) => LEAD_HEAD.test(x.prompt)).length, LEAD_MAX, '진행자는 2번만');
  assert.ok(S(sid).mission.log.some((x) => x.kind === 'lead' && x.text.includes('상한')), '넘은 블록은 무시하고 기록');
});

test('4. 진행자가 사람이 정할 일이라 보면 질문 블록으로 사용자에게: 질문 창 → 답은 mission.decided(카드 표시)와 사용자 선택 줄, 카드 이어 쓰기와 뒤 검수에 지시로', async () => {
  await app();
  const { p, tm } = await leadTeam('사람');
  const from = mark();
  const sid = await goal(tm.id, `LEADQ:${p.name} LEADASK`);
  const { m: lm, a } = await t.waitFor(() => openAsk(S, sid), 30000, '질문 창');
  assert.equal(lm.prep?.kind, 'lead', '진행자 답 메시지에 단다');
  assert.ok(card(sid, 'k2').lead, '카드는 아직 질문 중');
  await ctl(sid, { action: 'answer', askId: a.id, answers: [{ picked: [1] }] });
  await goalDone(sid);
  const m = S(sid).mission;
  const d = (m.decided || []).find((x) => x.card === 'k2');
  assert.ok(d && d.answer === '나' && d.question.includes('LEADASK') && d.about === '싼 쪽');
  assert.ok(m.log.some((x) => x.by === 'user' && x.text.includes('LEADASK')));
  const cont = sentFrom(from).find((x) => REPLY_HEAD.test(x.prompt));
  assert.ok(cont.prompt.includes('[사용자가 정한 것') && cont.prompt.includes('사용자의 답: 나'), '카드 이어 쓰기에 사용자의 답이 지시로');
  const rv = sentFrom(from).find((x) => x.prompt.includes('[기준 판정 — 1번째 검수]'));
  assert.ok(rv.prompt.includes('사용자의 답: 나'), '검수에도');
});

test('5. 진행자가 작은 회의를 청하면 사용자에게 묻는다: 허락 → 1바퀴(의견 → 결론, 조사·반대편 없음) → 결론을 카드에 참고 자료로. 안 열면 진행자 답만', async () => {
  await app();
  const { p, q, tm } = await leadTeam('작회');
  const from = mark();
  const sid = await goal(tm.id, `LEADQ:${p.name} LEADMEET`);
  const { m: lm, a } = await t.waitFor(() => openAsk(S, sid), 30000, '작은 회의 질문');
  assert.equal(lm.prep?.kind, 'lead');
  const qq = lm.asks.at(-1).questions[0];
  assert.ok(qq.question.includes('작은 회의를 열까') && /추가 호출 약 \d+번/.test(qq.question), '추가 호출 수를 같이 묻는다');
  await ctl(sid, { action: 'answer', askId: a.id, answers: [{ picked: [0] }] });
  await goalDone(sid);
  const m = S(sid).mission;
  assert.equal(m.smallMeets, 1);
  const ps = sentFrom(from);
  const ops = ps.filter((x) => /^\[작은 회의 — 의견\]$/m.test(x.prompt));
  assert.equal(ops.length, 2, '청한 두 사람의 의견');
  assert.ok(ops.every((x) => x.permission === 'plan'), '읽기 전용');
  assert.equal(ps.filter((x) => /^\[작은 회의 — 결론\]$/m.test(x.prompt)).length, 1, '진행자 결론 1번');
  assert.ok(!ps.some((x) => x.prompt.includes('[회의 — 차례 발언') || x.prompt.includes('회의에서 나온 질문 하나를 도구로')), '차례·조사 없음');
  const cont = ps.find((x) => REPLY_HEAD.test(x.prompt));
  assert.ok(cont.prompt.includes('SMALLCON 결론') && cont.prompt.includes('같이 정하자'), '진행자 답과 작은 회의 결론이 참고 자료로');
  assert.ok(m.log.some((x) => x.by === 'user' && x.text.includes('작은 회의')));
  // 안 열기
  const t2 = await leadTeam('안열');
  const from2 = mark();
  const sid2 = await goal(t2.tm.id, `LEADQ:${t2.p.name} LEADMEET`);
  const o2 = await t.waitFor(() => openAsk(S, sid2), 30000, '작은 회의 질문');
  await ctl(sid2, { action: 'answer', askId: o2.a.id, answers: [{ picked: [1] }] });
  await goalDone(sid2);
  assert.equal(S(sid2).mission.smallMeets || 0, 0);
  assert.equal(sentFrom(from2).filter((x) => /^\[작은 회의 — /m.test(x.prompt)).length, 0);
  assert.ok(sentFrom(from2).find((x) => REPLY_HEAD.test(x.prompt)).prompt.includes('같이 정하자'), '진행자의 원래 답만으로');
  void q;
});

test('6. 블록이 그 차례에서 허용 안 되면 읽지 않고 기록: 단계표 일 단계의 oc-lead · 작은 회의 참석자 이름이 팀에 없음', async () => {
  await app();
  const a = await mk('단진행', '분석'), b = await mk('단빌드', '빌드'), r = await mk('단검수', '검수');
  const tm = await mkTeam('단팀', [{ label: '분석', agentIds: [a.id] }, { label: '빌드', agentIds: [b.id] }, { label: '검수', agentIds: [r.id] }]);
  const from = mark();
  const sid = await goal(tm.id, 'WORKLEAD', { work: 'stages' });
  await goalDone(sid);
  assert.ok(S(sid).mission.log.some((x) => x.kind === 'block' && x.text.includes('oc-lead')), '단계표 일 단계는 oc-lead 를 받지 않는다');
  assert.equal(sentFrom(from).filter((x) => LEAD_HEAD.test(x.prompt)).length, 0);
  const t2 = await leadTeam('없는');
  const sid2 = await goal(t2.tm.id, `LEADQ:${t2.p.name} LEADMEETBAD`);
  await goalDone(sid2);
  assert.ok(S(sid2).mission.log.some((x) => x.kind === 'lead' && x.text.includes('작은 회의')), '못 읽은 작은 회의 블록은 기록하고 진행자 답만으로');
  assert.equal(openAsk(S, sid2), null);
});

test('7. 호출 상한: 남은 호출이 2번(진행자 답 + 이어 쓰기)보다 적으면 묻지 않고 기록 한 줄', async () => {
  await app();
  const { p, tm } = await leadTeam('호상');
  const sid = await goal(tm.id, `LEADQ:${p.name}`);
  // 계획이 끝나면 남은 호출을 줄인다(카드 단계 상한 질문은 "20번 더"로 넘기고, 진행자 질문 앞에서 다시 줄인다)
  await t.waitFor(() => S(sid).mission.cards?.length, 30000, '계획');
  const m = S(sid).mission;
  const hold = await t.waitFor(() => (card(sid, 'k2')?.status === 'running' ? 'run' : S(sid).runs.at(-1)?.hold?.reason === 'cap' ? 'cap' : null), 30000, '카드 시작');
  if (hold === 'cap') await ctl(sid, { action: 'more' });
  m.calls.cap = m.calls.used + 1;
  await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'cap' || (idle(sid) && m.status !== 'active'), 60000, '다음 상한 질문');
  assert.ok(m.log.some((x) => x.kind === 'lead' && x.text.includes('호출 상한')), '진행자에게 묻지 않았다');
  assert.equal(card(sid, 'k2').leadAsks || 0, 0);
  while (S(sid).runs.at(-1)?.hold?.reason === 'cap') { await ctl(sid, { action: 'more' }); await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason !== 'cap' || idle(sid), 30000, '상한 넘김'); }
  await goalDone(sid);
});

async function reopen() {
  const a = createApp({ home: path.join(t.root, 'home'), port: 0, detect: false });
  a.store.settings.lang = 'ko';
  const port = await a.listen(await freePort());
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

test('8. 끊김·이어서: 진행자에게 묻는 중에 끊기면 그 카드를 새 대화로 다시 시작하고(질문 중 표시는 지운다), 쓴 질문 수는 남는다', async () => {
  await app();
  const { p, tm } = await leadTeam('끊');
  const h1 = await reopen();
  const sid = await goal(tm.id, `LEADQ:${p.name} LEADSLOW`, { h: h1 });
  const file = path.join(h1.app.store.dirs.sessions, `${sid}.json`);
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  await t.waitFor(() => read()?.mission?.cards?.find((c) => c.id === 'k2')?.lead, 30000, '디스크에 질문 중');
  h1.app.store.closed = true;
  h1.app.store.close = () => {};
  await h1.app.close();
  const h2 = await reopen();
  assert.equal(h2.S(sid).mission.status, 'cut');
  const r = await h2.api('POST', `/api/sessions/${sid}/mission/resume`, { missionId: h2.S(sid).mission.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await goalDone(sid, h2.S, h2.idle);
  const k2 = card(sid, 'k2', h2.S);
  assert.equal(k2.lead, undefined);
  assert.equal(k2.leadAsks, 2, '끊기 전 질문 1번 + 다시 시작한 카드가 한 번 더 물었다(상한 안)');
  assert.equal(k2.status, 'done');
});
