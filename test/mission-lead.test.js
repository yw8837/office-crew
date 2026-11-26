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
import { hideAsks, agentWrote } from '../public/js/chat-tools.js';
import { PROVIDERS } from '../server/providers/index.js';
import { bindLang } from '../server/i18n.js';
import { startTestApp, freePort } from './helpers.js';

bindLang(() => 'ko');
let t = null;
const sent = [];
const keepRun = {};
const hooks = new Set(); // 프롬프트를 넘기기 직전에 부르는 시험용 고리(한도·상한을 그 순간에 바꾸려고)
const app = async () => {
  if (t) return t;
  t = await startTestApp();
  const p = PROVIDERS.claude;
  keepRun.claude = p.run;
  p.run = (opts, emit) => {
    const rec = { agent: opts.agent?.name, id: opts.agent?.id, permission: opts.agent?.permission, readOnlyRun: opts.agent?.readOnlyRun || null, resumeId: opts.resumeId || null, prompt: String(opts.prompt || '') };
    sent.push(rec);
    for (const h of hooks) h(rec);
    return keepRun.claude.call(p, opts, emit);
  };
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
// 시험 에이전트는 고칠 수 있는 권한(edit)으로 만든다: 진행자 답·작은 회의가 그 실행만 읽기 전용(plan)으로 도는지 보려고
const mk = async (name, role = '분석', extra = {}) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'edit', routing: 'manual', skills: [], ...extra })).json;
const mkTeam = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const mark = () => sent.length;
const sentFrom = (from) => sent.slice(from);
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides });
const ctl = (sid, body, api = t.api) => api('POST', `/api/sessions/${sid}/control`, body);
const LEAD_HEAD = /^\[진행자에게 온 질문 — 카드 k\d+\]$/m;
const REPLY_HEAD = /^\[진행자의 답 — 카드 k\d+/m;

// 진행자 L(분석), 작업 P·Q·W(정리), 검수 R → 일 카드 계획: k1 은 명단 첫 사람(L), k2 는 둘째(P). PLAN3 이면 k3 은 셋째(Q)
async function leadTeam(tag) {
  const l = await mk(`${tag}진행`, '분석'), p = await mk(`${tag}피`, '정리'), q = await mk(`${tag}큐`, '정리'), w = await mk(`${tag}더블`, '정리'), r = await mk(`${tag}검수`, '검수');
  const tm = await mkTeam(`${tag}팀`, [{ label: '분석', agentIds: [l.id] }, { label: '작업', agentIds: [p.id, q.id, w.id] }, { label: '검수', agentIds: [r.id] }]);
  return { l, p, q, w, r, tm };
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
// 진행자 프롬프트의 작은 회의 참석자 명단(이름)
const meetNames = (prompt) => (prompt.split('[팀 명단 — 작은 회의 참석자는 이 이름 그대로]\n')[1] || '').split('\n\n')[0].split('\n').map((l) => l.match(/^- (.+) \([^()]*\)$/)?.[1]).filter(Boolean);
// 목표가 끝날 때까지: 질문 창은 pick 번째 보기로 답하고(답한 수를 센다), 호출 상한 질문은 "20번 더", 구독 한도 상한 질문은 "계속"
async function drive(sid, pick = () => 0) {
  let asked = 0;
  for (;;) {
    const got = await t.waitFor(() => {
      const o = openAsk(S, sid);
      if (o) return o;
      const h = S(sid).runs.at(-1)?.hold;
      if (idle(sid) || !h) return idle(sid) && !['active', 'waiting'].includes(S(sid).mission.status) ? 'end' : null;
      return ['cap', 'limitcap'].includes(h.reason) ? h.reason : null;
    }, 60000, '질문·상한·끝').catch((e) => { throw new Error(`${e.message}: ${JSON.stringify({ status: S(sid).mission?.status, hold: S(sid).runs.at(-1)?.hold || null, log: (S(sid).mission?.log || []).slice(-6).map((x) => x.text) })}`); });
    if (got === 'end') return asked;
    if (got === 'cap') { await ctl(sid, { action: 'more' }); await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason !== 'cap', 10000, '상한 넘김'); continue; }
    if (got === 'limitcap') { await ctl(sid, { action: 'accept' }); await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason !== 'limitcap', 10000, '한도 상한 넘김'); continue; }
    await ctl(sid, { action: 'answer', askId: got.a.id, answers: [{ picked: [pick(asked, got)] }] });
    asked++;
  }
}
const HIGH = () => ({ windows: { five_hour: { pct: 95, resetsAt: Math.floor(Date.now() / 1000) + 3600 } }, observedAt: Date.now() });
// 구독 한도 상한 시험: 상한을 90% 로 두고, when(프롬프트) 이 처음 맞는 순간부터 Claude 의 5시간 창을 95% 로 고정한다(가짜 CLI 가 보내는 25% 로 덮이지 않게). 끝나면 되돌린다
async function withLimit(when, fn) {
  const st = t.app.store;
  const was = st.settings.limitCap;
  const limits = (st.usage.limits ||= {});
  const keep = limits.claude;
  const hook = (x) => { if (when(x)) { const v = HIGH(); Object.defineProperty(limits, 'claude', { get: () => v, set: () => {}, configurable: true, enumerable: true }); hooks.delete(hook); } };
  st.settings.limitCap = 90;
  hooks.add(hook);
  try { return await fn(); } finally {
    hooks.delete(hook);
    delete limits.claude;
    if (keep) limits.claude = keep;
    st.settings.limitCap = was;
  }
}

test('1. 순수 함수: oc-lead 읽기(맨 끝 블록만, 질문 한 줄 300자, 맥락 600자), oc-meet 읽기(주제 한 줄, 이름은 8명까지 받고 자르기는 부르는 쪽), 프롬프트 조각, 이어 줄 글의 전각, 화면 숨김·표시, 블록 표, 사용량 종류', () => {
  const p = parseLead('일했어.\n\n```oc-lead\n{"question":"어느 파일을\\n고칠까?","context":"맥락 1\\n맥락 2"}\n```');
  assert.deepEqual([p.question, p.context], ['어느 파일을 고칠까?', '맥락 1\n맥락 2']);
  assert.ok(p.from > 0 && p.to > p.from);
  assert.equal(parseLead('```oc-lead\n{"question":"q"}\n```\n\n뒤에 글'), null, '맨 끝 블록만');
  assert.equal(parseLead('```oc-lead\n{"context":"질문 없음"}\n```').error, 'shape');
  assert.equal(parseLead('```oc-lead\n{망가짐\n```').error, 'json');
  assert.equal([...parseLead(`\`\`\`oc-lead\n${JSON.stringify({ question: 'ㄱ'.repeat(500), context: 'ㄴ'.repeat(900) })}\n\`\`\``).question].length, 300);
  const mt = parseMeet('같이 보자.\n\n```oc-meet\n{"topic":"주제","people":["가","나","다","라","가"]}\n```');
  assert.deepEqual([mt.topic, mt.people], ['주제', ['가', '나', '다', '라']], '블록의 이름은 겹친 것만 빼고 다 받는다(명단과 맞추고 진행자·물은 담당을 뺀 뒤 3명으로 자르는 건 부르는 쪽)');
  assert.equal(parseMeet(`\`\`\`oc-meet\n${JSON.stringify({ topic: '주제', people: Array.from({ length: 12 }, (_, k) => `이름${k}`) })}\n\`\`\``).people.length, 8, '8명까지');
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
  const rp2 = leadReply({ id: 'k1', question: '<q>', answer: '<답>', meet: '<결론>', mark: '0'.repeat(8) });
  assert.ok(rp2.includes('＜q＞') && rp2.includes('＜답＞') && rp2.includes('＜결론＞') && !/<(?:q|답|결론)>/.test(rp2), '이어 줄 글의 표식 안도 < > 전각');
  // 화면: 쓰는 중에는 끝의 oc-lead·oc-meet 블록을 감추고(서버가 읽기 전), 다 쓴 뒤에는 받은(또는 읽고 따르지 않은) 블록 자리만 감춘다
  assert.equal(hideAsks('일했어.\n\n```oc-lead\n{"question":"q', [], true), '일했어.\n\n');
  assert.equal(hideAsks('같이 보자.\n\n```oc-meet\n{"topic"', [], true), '같이 보자.\n\n');
  const doneText = '같이 보자.\n\n```oc-meet\n{"topic":"t","people":["a","b"]}\n```';
  assert.equal(hideAsks(doneText, [{ from: doneText.indexOf('```'), to: doneText.length }]), '같이 보자.\n\n');
  // 에이전트가 쓴 글 표시(결정 0022 개정): 갈래 요약·진행자 답·작은 회의 답. 다른 준비 답은 그대로
  const work = { id: 'r1', mission: 'work' };
  for (const kind of ['fork', 'lead', 'meet']) assert.equal(agentWrote({ runId: 'r1', once: true, prep: { kind, ...(kind === 'meet' ? { phase: 'opinion' } : {}) } }, work), true, kind);
  assert.equal(agentWrote({ runId: 'r1', once: true, prep: { kind: 'plan' } }, work), false);
  assert.equal(agentWrote({ runId: 'r2', once: true, prep: { kind: 'lead' } }, { id: 'r2' }), false, '목표 일 실행이 아니면 아니다');
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
  assert.deepEqual([lead[0].permission, lead[0].readOnlyRun], ['plan', 'talk'], '읽기 전용(그 실행만. 에이전트 설정은 edit)');
  assert.equal(ps.find((x) => x.id === p.id && /^\[일 카드 k2\]$/m.test(x.prompt)).permission, 'edit', '카드 차례는 에이전트 자기 권한 그대로');
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
  const { l, p, q, w, tm } = await leadTeam('작회');
  const from = mark();
  const sid = await goal(tm.id, `LEADQ:${p.name} LEADMEET`);
  const { m: lm, a } = await t.waitFor(() => openAsk(S, sid), 30000, '작은 회의 질문');
  assert.equal(lm.prep?.kind, 'lead');
  // 진행자에게 보이는 명단에서 진행자 자신과 물은 담당(P)은 뺀다
  assert.deepEqual(meetNames(sentFrom(from).find((x) => LEAD_HEAD.test(x.prompt)).prompt), [q.name, w.name]);
  void l;
  const qq = lm.asks.at(-1).questions[0];
  assert.ok(qq.question.includes('작은 회의를 열까') && /추가 호출 약 \d+번/.test(qq.question), '추가 호출 수를 같이 묻는다');
  await ctl(sid, { action: 'answer', askId: a.id, answers: [{ picked: [0] }] });
  await goalDone(sid);
  const m = S(sid).mission;
  assert.equal(m.smallMeets, 1);
  const ps = sentFrom(from);
  const ops = ps.filter((x) => /^\[작은 회의 — 의견\]$/m.test(x.prompt));
  assert.equal(ops.length, 2, '청한 두 사람의 의견');
  assert.deepEqual(ops.map((x) => x.id).sort(), [q.id, w.id].sort());
  const con = ps.filter((x) => /^\[작은 회의 — 결론\]$/m.test(x.prompt));
  assert.equal(con.length, 1, '진행자 결론 1번');
  assert.ok([...ops, ...con].every((x) => x.permission === 'plan' && x.readOnlyRun === 'talk'), '읽기 전용(그 실행만)');
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

test('9. 같은 물결의 두 카드가 같이 물으면 진행자는 차례로 답한다. 앞 질문의 작은 회의에 진행자 답을 기다리는 담당이 들면 그 기다림을 잠시 빌려 의견을 쓴다(서로 기다리지 않는다)', async () => {
  await app();
  const { l, p, q, w, tm } = await leadTeam('교착');
  const from = mark();
  // k1 L · k2 P · k3 Q. Q 가 먼저 묻고(P 는 3초 늦게 묻는다. 진행자의 k1 도 3초 늦게 끝나 진행자 답은 그 뒤에), 진행자는 작은 회의를 청한다: 명단 앞 두 사람(진행자·Q 를 빼면 P·W)
  const sid = await goal(tm.id, `PLAN3 LEADQ:${p.name} LEADQ:${q.name} SLOWBY:${p.name} SLOWK1 LEADMEET`);
  const asked = await drive(sid, (k) => (k === 0 ? 0 : 1)); // 첫 작은 회의는 열고, 둘째(P 의 질문)는 열지 않는다
  assert.equal(asked, 2, '두 질문 모두 진행자가 답했고 작은 회의 허락을 물었다');
  const m = S(sid).mission;
  assert.equal(m.status, 'done');
  assert.deepEqual(['k2', 'k3'].map((id) => [card(sid, id).status, card(sid, id).leadAsks]), [['done', 1], ['done', 1]]);
  assert.equal(m.smallMeets, 1);
  const ps = sentFrom(from);
  const leads = ps.filter((x) => LEAD_HEAD.test(x.prompt));
  assert.deepEqual(leads.map((x) => x.prompt.match(LEAD_HEAD)[0].match(/k\d+/)[0]), ['k3', 'k2'], '먼저 물은 카드부터');
  assert.deepEqual(meetNames(leads[0].prompt), [p.name, w.name], '진행자·물은 담당(Q)을 뺀 명단');
  assert.deepEqual(meetNames(leads[1].prompt), [q.name, w.name]);
  const ops = ps.filter((x) => /^\[작은 회의 — 의견\]$/m.test(x.prompt));
  assert.deepEqual(ops.map((x) => x.id).sort(), [p.id, w.id].sort(), '진행자 답을 기다리던 P 도 의견을 냈다');
  // 진행자(L)의 CLI 는 한 번에 하나만: 자기 카드·두 답·작은 회의 결론이 겹치지 않는다
  const run = S(sid).runs.findLast((r) => r.mission === 'work');
  const mine = S(sid).messages.filter((x) => x.role === 'agent' && x.runId === run.id && x.agentId === l.id).sort((a, b) => a.createdAt - b.createdAt);
  assert.ok(mine.length >= 4, '카드·답 둘·결론');
  for (let k = 1; k < mine.length; k++) assert.ok(mine[k].createdAt >= mine[k - 1].createdAt + mine[k - 1].usage.durationMs, `진행자 실행이 겹쳤다: ${k}`);
  const pm = S(sid).messages.find((x) => x.card?.id === 'k2' && !x.cardTail);
  assert.ok(pm.text.includes('LEADCONT-k2'), 'P 는 진행자 답을 받아 이어 썼다');
  assert.ok(S(sid).messages.some((x) => x.prep?.kind === 'meet' && x.prep.phase === 'opinion' && x.agentId === p.id && x.status === 'done'));
});

test('10. 작은 회의는 목표당 2번: 셋째 요청은 묻지 않고 기록 한 줄(진행자 프롬프트에서도 안내를 뺀다)', async () => {
  await app();
  const { p, q, tm } = await leadTeam('목상');
  const from = mark();
  const sid = await goal(tm.id, `PLAN3 LEADQMORE:${p.name} LEADQ:${q.name} LEADMEET`);
  const asked = await drive(sid);
  const m = S(sid).mission;
  assert.equal(asked, 2, '허락 질문은 2번만');
  assert.equal(m.smallMeets, 2);
  const leads = sentFrom(from).filter((x) => LEAD_HEAD.test(x.prompt));
  assert.equal(leads.length, 3, '진행자 답은 세 번(P 두 번, Q 한 번)');
  assert.ok(!leads[2].prompt.includes('```oc-meet'), '상한이면 작은 회의 안내를 빼고');
  assert.ok(m.log.some((x) => x.kind === 'lead' && x.text.includes('작은 회의 상한')), '셋째 요청은 기록만');
});

test('11. 작은 회의 앞 확인: 남은 호출이 (의견 + 결론 + 이어 쓰기)보다 적거나 참석자의 AI 가 구독 한도 상한을 넘었으면 묻지 않고 열지 않는다. 열지 않은 블록은 답 화면에서 감춘다', async () => {
  await app();
  // 호출 상한: 진행자 답을 띄우는 순간 남은 호출을 2번으로(작은 회의 2명은 의견 2 + 결론 1 + 이어 쓰기 1 = 4번)
  const t1 = await leadTeam('작상');
  let sid1 = null;
  const capHook = (x) => { if (sid1 && LEAD_HEAD.test(x.prompt)) { const m0 = S(sid1).mission; m0.calls.cap = m0.calls.used + 2; hooks.delete(capHook); } };
  sid1 = await goal(t1.tm.id, `LEADQ:${t1.p.name} LEADMEET`);
  hooks.add(capHook);
  try { assert.equal(await drive(sid1), 0, '허락을 묻지 않았다'); } finally { hooks.delete(capHook); }
  const m1 = S(sid1).mission;
  assert.equal(m1.smallMeets || 0, 0);
  assert.ok(m1.log.some((x) => x.kind === 'lead' && x.text.includes('호출 상한') && x.text.includes('작은 회의')), '기록 한 줄');
  const lm = S(sid1).messages.find((x) => x.prep?.kind === 'lead');
  assert.equal(lm.hidden?.length, 1, '열지 않은 작은 회의 블록 자리');
  assert.ok(lm.text.startsWith('```oc-meet', lm.hidden[0].from));
  // 구독 한도 상한: 진행자 답을 띄우는 순간부터 Claude 5시간 창 95%(상한 90%)
  const t2 = await leadTeam('작한');
  await withLimit((x) => LEAD_HEAD.test(x.prompt), async () => {
    const sid = await goal(t2.tm.id, `LEADQ:${t2.p.name} LEADMEET`);
    assert.equal(await drive(sid), 0, '허락을 묻지 않았다');
    const m = S(sid).mission;
    assert.equal(m.smallMeets || 0, 0);
    assert.ok(m.log.some((x) => x.kind === 'lead' && x.text.includes('구독 한도 상한') && x.text.includes('작은 회의')));
  });
});

test('12. 진행자 쪽 구독 한도 상한: 진행자의 AI 가 상한을 넘었으면 묻지 않고 기록 한 줄(블록은 무시)', async () => {
  await app();
  const { p, tm } = await leadTeam('진한');
  const from = mark();
  await withLimit((x) => /^\[일 카드 k2\]$/m.test(x.prompt), async () => {
    const sid = await goal(tm.id, `LEADQ:${p.name}`);
    await drive(sid);
    assert.equal(sentFrom(from).filter((x) => LEAD_HEAD.test(x.prompt)).length, 0, '진행자에게 묻지 않았다');
    assert.equal(card(sid, 'k2').leadAsks || 0, 0);
    assert.ok(S(sid).mission.log.some((x) => x.kind === 'lead' && x.text.includes('k2') && x.text.includes('구독 한도 상한')));
  });
});

test('13. 진행자 답을 기다리는 중에 그만: 기다리지 않고 멈추고, 질문 중 표시를 지우고, 이어 쓰기 호출을 하지 않는다', async () => {
  await app();
  const { p, tm } = await leadTeam('그만');
  const sid = await goal(tm.id, `LEADQ:${p.name} LEADSLOW`);
  await t.waitFor(() => card(sid, 'k2')?.lead, 30000, '질문 중');
  const from = mark();
  assert.equal((await ctl(sid, { action: 'stop' })).json.ok, true);
  await t.waitFor(() => idle(sid), 10000, '멈춤');
  assert.equal(S(sid).mission.status, 'stopped');
  assert.equal(card(sid, 'k2').lead, undefined);
  assert.equal(sentFrom(from).filter((x) => REPLY_HEAD.test(x.prompt)).length, 0);
  assert.equal(S(sid).messages.find((x) => x.card?.id === 'k2' && !x.cardTail).status, 'stopped', '카드 답은 멈춘 답으로 끝난다(다 한 답이 아니다)');
});

test('14. 진행자 답을 기다리는 카드를 건너뛰면 기다림을 끊고 그 카드를 건너뛴 것으로 끝낸다(이어 쓰기 호출을 쓰지 않는다)', async () => {
  await app();
  const { p, tm } = await leadTeam('건너');
  const sid = await goal(tm.id, `LEADQ:${p.name} LEADSLOW`);
  await t.waitFor(() => card(sid, 'k2')?.lead, 30000, '질문 중');
  const from = mark();
  const r = await ctl(sid, { action: 'skip', agentId: p.id });
  assert.equal(r.json.ok, true);
  await t.waitFor(() => card(sid, 'k2')?.status === 'skipped', 2500, '진행자 답(3초)을 기다리지 않고 건너뜀');
  await drive(sid);
  assert.equal(sentFrom(from).filter((x) => REPLY_HEAD.test(x.prompt)).length, 0, '이어 쓰기 호출 없음');
  assert.ok(S(sid).mission.log.some((x) => x.kind === 'lead' && x.text.includes('기다리다 건너뛰었어')));
  const lm = S(sid).messages.find((x) => x.prep?.kind === 'lead');
  assert.equal(lm.status, 'stopped', '답을 쓰던 진행자 실행은 멈춘다');
  // 진행자가 사용자에게 작은 회의 허락을 묻는 중에 건너뛰면 그 질문 창도 닫고 작은 회의를 열지 않는다
  const t2 = await leadTeam('건닫');
  const sid2 = await goal(t2.tm.id, `LEADQ:${t2.p.name} LEADMEET`);
  const o = await t.waitFor(() => openAsk(S, sid2), 30000, '작은 회의 허락 질문');
  const from2 = mark();
  assert.equal((await ctl(sid2, { action: 'skip', agentId: t2.p.id })).json.ok, true);
  await t.waitFor(() => card(sid2, 'k2')?.status === 'skipped', 5000, '건너뜀');
  assert.equal(S(sid2).messages.find((x) => x.id === o.m.id).asks.find((x) => x.id === o.a.id).status, 'cancelled', '진행자의 질문 창을 닫았다');
  assert.equal(openAsk(S, sid2), null);
  await drive(sid2);
  assert.equal(S(sid2).mission.smallMeets || 0, 0);
  assert.equal(sentFrom(from2).filter((x) => /^\[작은 회의 — /m.test(x.prompt) || REPLY_HEAD.test(x.prompt)).length, 0, '작은 회의·이어 쓰기 없음');
  assert.ok(!(S(sid2).mission.decided || []).some((d) => d.card === 'k2'), '사용자가 정한 것으로 남기지 않는다');
});

test('15. 묻지 않는 까닭을 따로 적는다: 진행자가 맡은 카드 · 진행자가 팀에서 빠짐', async () => {
  await app();
  const t1 = await leadTeam('자기');
  const g1 = await goal(t1.tm.id, `LEADQ:${t1.l.name}`);
  await drive(g1);
  assert.ok(S(g1).mission.log.some((x) => x.kind === 'lead' && x.text.includes('k1') && x.text.includes('진행자가 맡은 카드라')));
  // P 가 일하는 동안(3초) 팀에서 진행자를 뺀다
  const t2 = await leadTeam('빠짐');
  const from = mark();
  const g2 = await goal(t2.tm.id, `LEADQ:${t2.p.name} SLOWBY:${t2.p.name}`);
  await t.waitFor(() => card(g2, 'k2')?.status === 'running', 30000, 'k2 시작');
  const tm = t.app.store.get('teams', t2.tm.id);
  assert.equal((await t.api('PUT', `/api/teams/${t2.tm.id}`, { ...tm, stages: tm.stages.filter((st) => !st.agentIds.includes(t2.l.id)) })).status, 200);
  await drive(g2);
  assert.ok(S(g2).mission.log.some((x) => x.kind === 'lead' && x.text.includes('k2') && x.text.includes('지금 팀에 없어서')));
  assert.equal(sentFrom(from).filter((x) => LEAD_HEAD.test(x.prompt)).length, 0);
});

test('16. 작은 회의 참석자: 진행자가 자기와 물은 담당까지 적어도 빼고, 명단과 맞춘 뒤 3명까지만', async () => {
  await app();
  const { l, p, q, w, tm: base } = await leadTeam('여럿');
  const v = await mk('여럿브이', '정리'), u = await mk('여럿유', '정리');
  const tm = await mkTeam('여럿큰팀', [...t.app.store.get('teams', base.id).stages.map((st) => (st.label === '작업' ? { ...st, agentIds: [...st.agentIds, v.id, u.id] } : st))]);
  const from = mark();
  const sid = await goal(tm.id, `LEADQ:${p.name} LEADMEETALL`);
  const { m: lm, a } = await t.waitFor(() => openAsk(S, sid), 30000, '작은 회의 질문');
  const qq = lm.asks.at(-1).questions[0].question;
  assert.ok(qq.includes(`${q.name}, ${w.name}, ${v.name}`) && !qq.includes(u.name) && !qq.includes(l.name) && !qq.includes(p.name), '명단 순서로 3명(진행자·물은 담당 빼고)');
  assert.ok(qq.includes('추가 호출 약 4번'));
  await ctl(sid, { action: 'answer', askId: a.id, answers: [{ picked: [0] }] });
  await drive(sid);
  const ops = sentFrom(from).filter((x) => /^\[작은 회의 — 의견\]$/m.test(x.prompt));
  assert.deepEqual(ops.map((x) => x.id).sort(), [q.id, w.id, v.id].sort());
});
