// 목표 모드 2a-3(결정 0016): 끊긴 목표 이어서. 끊긴 자리(mission.at)를 단계마다 적어 두고, 사용자가 "이어서"를 누르면 그 자리부터 새 실행 하나로 이어 간다.
// 앞 단계는 다시 돌지 않고 결과를 앞 실행들의 메시지에서 다시 모은다. 끊긴 단계에서 일하던 에이전트는 새 대화로, 대기에서 끊겼으면 호출 없이 같은 질문을.
// 앱이 꺼지는 것은 그 순간 디스크에 있던 세션 파일을 떠 두었다가 같은 데이터 폴더로 앱을 새로 만들어 흉내 낸다(가짜 CLI, 실제 AI 사용량 0)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { bindLang } from '../server/i18n.js';
import { sameStages, resumePoint, pastOutputs, cutMission, newMission } from '../server/mission.js';
import { startTestApp, freePort } from './helpers.js';

bindLang(() => 'ko'); // 순수 함수의 문구(한국어 원문)를 검사한다
let t = null;
const app = async () => (t ||= await startTestApp());
const opened = []; // 다시 켠 앱(테스트가 끝나면 닫는다)
after(async () => {
  for (const a of opened) { try { await a.close(); } catch { /* 이미 닫힘·윈도우 파일 잠금 무시 */ } }
  if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 앱 하나를 다루는 손잡이: 처음 앱(t)과 다시 켠 앱이 같은 모양
const hd = (a, api) => ({
  app: a, api,
  S: (id) => a.store.getSession(id),
  idle: (id) => !a.orch.ctx.has(id),
  ctl: (sid, action, extra = {}) => api('POST', `/api/sessions/${sid}/control`, { action, ...extra }),
  resume: (sid, missionId) => api('POST', `/api/sessions/${sid}/mission/resume`, { missionId }),
});
const first = () => hd(t.app, t.api);
const mk = async (name, role, extra = {}) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual', ...extra })).json;
const mkTeam = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const S = (id) => t.app.store.getSession(id);
const cardOf = (sid) => S(sid).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides });
// 요청 → 카드 → (목표 문장을 신호어가 든 것으로 고쳐서) 확인. 카드가 보여 주던 검수 줄을 그대로 보낸다
async function goal(teamId, signal = '', { request = '정리해 줘', before = null } = {}) {
  const s = (await t.api('POST', '/api/sessions', { teamId })).json;
  assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: request });
  await t.waitFor(() => S(s.id).mission?.status === 'draft' && !t.app.orch.ctx.has(s.id), 20000, '목표 카드');
  const c = cardOf(s.id);
  if (before) await before(s.id);
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const r = await t.api('POST', `/api/sessions/${s.id}/mission/confirm`, { missionId: S(s.id).mission.id, expected: shown(c), review, ...(signal ? { edited: { ...shown(c), goal: `${signal} 목표` } } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return s.id;
}
// 가짜 CLI 기록을 프로세스 단위로: [{ args, texts }](시작 줄의 인자와 그 프로세스가 받은 차례 글). 단계가 차례로 도는 팀에서만 쓴다
const calls = (from) => {
  const out = [];
  for (const l of t.fakeLog().slice(from)) {
    if (l.cli !== 'claude') continue;
    if (l.args) out.push({ args: l.args, texts: [] });
    else if (l.text !== undefined && out.length) out.at(-1).texts.push(l.text);
  }
  return out;
};
const running = (h, sid, agentId, stageIndex, nth = 1) => {
  const s = h.S(sid);
  const mine = s.messages.filter((m) => m.role === 'agent' && m.agentId === agentId && m.stageIndex === stageIndex && m.runId === s.runs.at(-1)?.id && !m.review);
  return mine.length === nth && mine.at(-1).status === 'streaming';
};

// 같은 데이터 폴더로 앱을 새로 만든다(다시 켜기)
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
  return hd(a, api);
}
// 앱이 꺼진 모양: 그 순간 디스크에 있던 세션 파일을 떠 둔다(edit 로 고칠 수 있다). 이 앱의 실행은 멈추고(그 뒤 쓴 파일은 떠 둔 것으로 되돌린다) 다시 켠다
async function crash(h, sid, edit = null) {
  await sleep(200); // 방금 띄운 CLI 의 호출 수(0.05초 미뤄 저장)까지 디스크에 있게
  const file = path.join(h.app.store.dirs.sessions, `${sid}.json`);
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (edit) edit(snap);
  if (!h.idle(sid)) {
    await h.ctl(sid, 'stop');
    await t.waitFor(() => h.idle(sid), 30000, '앞 앱의 실행 멈춤');
  }
  await sleep(300); // 멈춘 뒤 미뤄 둔 저장이 끝나기를 기다린다
  h.app.store.saveSessionNow(snap);
  await sleep(500); // 목록(index.json)에 "실행 중"이 저장되기를 기다린다
  return { h2: await reopen(), snap };
}
// 다시 켠 뒤 저절로 돌지 않는다: 실행이 없고, 새 실행이 없고, CLI 를 띄우지 않는다
async function stays(h, sid, snap) {
  const n = t.fakeLog().length;
  await sleep(400);
  assert.equal(h.app.orch.ctx.size, 0, '다시 켠 뒤 실행이 없다');
  assert.equal(h.S(sid).runs.length, snap.runs.length, '새 실행을 만들지 않았다');
  assert.equal(t.fakeLog().length, n, 'CLI 를 띄우지 않았다');
  assert.equal(h.S(sid).mission.status, 'cut');
}

test('1. 순수 함수: 단계표 대조, 끊긴 자리 읽기, 앞 단계 결과 다시 모으기, 끊김은 끊긴 자리를 그대로 둔다', () => {
  const st = (label, agentIds, extra = {}) => ({ label, agentIds, approve: false, instruction: '', meeting: null, ...extra });
  const a = [st('정리', ['a']), st('분석', ['b', 'c'], { meeting: { chairId: 'b' } }), st('기준 판정', ['r'], { mission: 'review' })];
  // 같은 단계표(끊긴 실행의 단계에는 상태가 붙어 있다). 기준 판정 단계의 이름은 언어가 바뀌어도 같은 것으로 본다
  assert.equal(sameStages(a, a.map((x) => ({ ...x, status: 'done', note: 'x' }))), true);
  assert.equal(sameStages(a, a.map((x, k) => (k === 2 ? { ...x, label: 'Criteria check' } : x))), true);
  // 라벨·담당(순서)·승인·회의 여부·기준 판정 자리·단계 수가 다르면 다르다
  assert.equal(sameStages(a, a.map((x, k) => (k === 0 ? { ...x, label: '정리2' } : x))), false);
  assert.equal(sameStages(a, a.map((x, k) => (k === 1 ? { ...x, agentIds: ['c', 'b'] } : x))), false);
  assert.equal(sameStages(a, a.map((x, k) => (k === 0 ? { ...x, approve: true } : x))), false);
  assert.equal(sameStages(a, a.map((x, k) => (k === 1 ? { ...x, meeting: null } : x))), false);
  assert.equal(sameStages(a, a.map((x, k) => (k === 2 ? { ...x, mission: undefined } : x))), false);
  assert.equal(sameStages(a, a.slice(0, 2)), false);
  assert.equal(sameStages(null, a), false);
  // 끊긴 자리: 일 단계는 기준 판정 앞, 기준 판정 자리는 그 단계(검수자가 없으면 마지막 일 단계). 일하던 에이전트는 그 단계 담당만
  assert.deepEqual(resumePoint({ stageIndex: 1, phase: 'work', back: false, working: ['b', 'z', 'b'], wait: null }, a), { stageIndex: 1, phase: 'work', back: false, working: ['b'], wait: null });
  assert.deepEqual(resumePoint({ stageIndex: 1, phase: 'work', back: true, working: [], wait: { reason: 'cap' } }, a), { stageIndex: 1, phase: 'work', back: true, working: [], wait: { reason: 'cap' } });
  assert.deepEqual(resumePoint({ stageIndex: 2, phase: 'review', back: true, working: ['r'], wait: null }, a), { stageIndex: 2, phase: 'review', back: false, working: ['r'], wait: null });
  assert.deepEqual(resumePoint({ stageIndex: 2, phase: 'review', working: ['r'], wait: { reason: 'mission', kind: 'verdict' } }, a), { stageIndex: 2, phase: 'review', back: false, working: [], wait: { reason: 'mission', kind: 'verdict' } });
  const solo = a.slice(0, 2);
  assert.deepEqual(resumePoint({ stageIndex: 1, phase: 'review', wait: { reason: 'mission', kind: 'notes' } }, solo).wait, { reason: 'mission', kind: 'notes' });
  for (const bad of [null, {}, { stageIndex: 3, phase: 'work' }, { stageIndex: -1, phase: 'work' }, { stageIndex: 1.5, phase: 'work' }, { stageIndex: 2, phase: 'work' }, { stageIndex: 1, phase: 'review' },
    { stageIndex: 0, phase: 'goal' }, { stageIndex: 1, phase: 'work', wait: { reason: 'mission', kind: 'verdict' } }, { stageIndex: 2, phase: 'review', wait: { reason: 'mission', kind: 'x' } }, { stageIndex: 1, phase: 'work', wait: { reason: 'pause' } }]) {
    assert.equal(resumePoint(bad, a), null, JSON.stringify(bad));
  }
  assert.equal(resumePoint({ stageIndex: 0, phase: 'work' }, []), null);
  // 앞 단계 결과: 이 목표의 실행들에서만, 단계·에이전트마다 가장 최근의 끝난 답. 검수 답·목표 초안·인수인계 메모·끝나지 않은 답·빈 답은 뺀다.
  // 회의 단계는 결론(또는 되돌림에서 진행자 혼자 고친 답) 중 가장 최근 하나
  const msg = (id, runId, agentId, stageIndex, text, extra = {}) => ({ id, role: 'agent', runId, agentId, stageIndex, text, status: 'done', ...extra });
  const M = [
    msg('m1', 'r1', 'a', 0, '정리 1'), msg('m2', 'r2', 'a', 0, '정리 2'), msg('m3', 'r2', 'a', 0, '정리 3 멈춤', { status: 'stopped' }), msg('m4', 'rX', 'a', 0, '다른 목표'),
    msg('m5', 'r1', 'a', 0, '검수 답', { review: { round: 1 } }), msg('m6', 'r1', 'a', 0, '초안', { goalDraft: true }), msg('m7', 'r2', 'a', 0, '  '),
    msg('m8', 'r1', 'b', 1, '의견', { meeting: { phase: 'opinion' } }), msg('m9', 'r1', 'b', 1, '결론 1', { meeting: { phase: 'conclude' } }), msg('m10', 'r2', 'b', 1, '진행자 혼자 고침'),
    msg('m11', 'r2', 'c', 1, '차례', { meeting: { phase: 'turn' } }), { id: 'm12', role: 'user', runId: 'r2', stageIndex: 0, text: '사용자', status: 'done' },
  ];
  assert.deepEqual(pastOutputs(M, new Set(['r1', 'r2']), a, 2), [[{ agentId: 'a', text: '정리 2', msgId: 'm2' }], [{ agentId: 'b', text: '진행자 혼자 고침', msgId: 'm10' }]]);
  assert.deepEqual(pastOutputs(M, ['r1'], a, 2), [[{ agentId: 'a', text: '정리 1', msgId: 'm1' }], [{ agentId: 'b', text: '결론 1', msgId: 'm9' }]]);
  assert.deepEqual(pastOutputs(M, ['r9'], a, 1), [[]], '못 찾은 단계는 빈 목록');
  assert.deepEqual(pastOutputs(M, ['r1'], a, 0), []);
  // 일 단계(회의 아님)는 담당마다(단계에 적힌 순서), 회의의 차례 글은 일 단계 답이 아니다
  const two = [st('조사', ['x', 'y'])];
  assert.deepEqual(pastOutputs([msg('n1', 'r1', 'y', 0, 'y 답'), msg('n2', 'r1', 'x', 0, 'x 답'), msg('n3', 'r1', 'x', 0, 'x 차례', { meeting: { phase: 'turn' } })], ['r1'], two, 1),
    [[{ agentId: 'x', text: 'x 답', msgId: 'n2' }, { agentId: 'y', text: 'y 답', msgId: 'n1' }]]);
  // 끊김은 끊긴 자리를 건드리지 않는다
  const s = { mission: { ...newMission({ request: 'x' }), status: 'active', at: { stageIndex: 1, phase: 'work', back: false, working: ['b'], wait: null } } };
  assert.equal(cutMission(s), true);
  assert.deepEqual([s.mission.status, s.mission.at], ['cut', { stageIndex: 1, phase: 'work', back: false, working: ['b'], wait: null }]);
});

test('2. 일 단계 중 끊김 → 이어서: 끊긴 단계 담당만 새 대화로(--resume 없이) "[이어서]"와 함께, 앞 단계는 다시 안 돌고 결과는 다시 모아 뒤 단계에 넘긴다. 끝까지 가서 done', async () => {
  const t = await app();
  const a = await mk('잇기정리', '정리');
  const b = await mk('잇기분석', '분석');
  const c = await mk('잇기빌드', '빌드');
  const tm = await mkTeam('잇기팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }, { label: '빌드', agentIds: [c.id] }]);
  const sid = await goal(tm.id, '', { request: 'SLOW 정리해 줘' });
  assert.deepEqual(S(sid).mission.keep, [], '남기기를 고른 단계 번호를 적어 둔다');
  // 분석 단계가 도는 중: 끊긴 자리는 바로 디스크에 있다
  await t.waitFor(() => running(first(), sid, b.id, 1), 30000, '분석 중');
  const live = S(sid).mission.at;
  assert.deepEqual(live, { stageIndex: 1, phase: 'work', back: false, working: [b.id], wait: null });
  const { h2, snap } = await crash(first(), sid, (x) => {
    // 분석 담당이 이어 가던 대화가 있었다고 해 둔다(이어서 할 때 버려야 한다)
    x.providerSessions[b.id] = 'claude-sess-cutmark';
    (x.sessionProvider ||= {})[b.id] = 'claude';
    (x.noteHashes ||= {})[b.id] = 'hash-cutmark';
  });
  assert.deepEqual(snap.mission.at, live, '끊긴 자리는 단계를 시작할 때 바로 저장됐다');
  const aSess = snap.providerSessions[a.id];
  assert.ok(aSess, '정리 담당은 이어 갈 대화가 있다');
  const aDone = snap.messages.find((m) => m.agentId === a.id && m.stageIndex === 0 && m.status === 'done' && !m.review);
  try {
    const S2 = h2.S;
    assert.deepEqual([S2(sid).mission.status, S2(sid).runs.at(-1).status], ['cut', 'stopped']);
    assert.ok(S2(sid).messages.some((x) => x.role === 'system' && x.text.includes('목표 카드에서 이어서 하거나, 버리고 새 요청을 보낼 수 있어.')));
    assert.deepEqual(S2(sid).mission.at, live, '끊김은 끊긴 자리를 그대로 둔다');
    await stays(h2, sid, snap);
    const from = t.fakeLog().length;
    const r = await h2.resume(sid, snap.mission.id);
    assert.deepEqual([r.status, r.json], [200, { ok: true, missionId: snap.mission.id }]);
    // 끊긴 단계 담당의 대화 기록은 버렸다(새 대화). 다른 담당은 그대로
    assert.deepEqual([S2(sid).providerSessions[b.id], S2(sid).sessionProvider?.[b.id], S2(sid).noteHashes?.[b.id]], [undefined, undefined, undefined]);
    assert.equal(S2(sid).providerSessions[a.id], aSess);
    const run = S2(sid).runs.at(-1);
    assert.deepEqual([run.resumed, run.mission, run.missionId, run.stages[0].status], [true, 'work', snap.mission.id, 'done']);
    assert.equal(S2(sid).mission.status, 'active');
    await t.waitFor(() => h2.idle(sid) && S2(sid).mission.status !== 'active', 40000, '이어서 끝');
    const m = S2(sid).mission;
    assert.equal(m.status, 'done', JSON.stringify(m.log.slice(-6)));
    const cs = calls(from);
    assert.equal(cs.length, 3, '분석·빌드·기준 판정만 돈다(정리는 다시 안 돈다)');
    assert.ok(cs.every((x) => !x.texts.some((p) => p.includes('"정리"를 네가 맡았어'))));
    const [cb, cc, cr] = cs;
    assert.ok(cb.texts[0].includes('"분석"를 네가 맡았어') && !cb.args.includes('--resume'), '끊긴 단계 담당은 새 대화');
    assert.ok(cb.texts[0].includes('[이어서] 이 단계는 앱이 꺼져서 중간에 끊겼어. 작업 폴더에 이미 해 둔 것이 있는지 먼저 확인하고, 있으면 거기서 이어서 해.'));
    assert.ok(cb.texts[0].indexOf('[이어서]') < cb.texts[0].indexOf('[확정된 목표와 합격 기준'), '그 단계 프롬프트의 맨 앞');
    assert.ok(cb.texts[0].includes('[이전 단계 결과]') && cb.texts[0].includes(aDone.text), '다시 모은 앞 단계 결과');
    assert.ok(cc.texts[0].includes('"빌드"를 네가 맡았어') && !cc.texts[0].includes('[이어서]'), '뒤 단계에는 안 붙인다');
    const bNew = S2(sid).messages.findLast((x) => x.agentId === b.id && x.stageIndex === 1 && x.status === 'done');
    assert.ok(cc.texts[0].includes(aDone.text) && cc.texts[0].includes(bNew.text));
    assert.ok(cr.texts[0].includes('[기준 판정 — 1번째 검수]') && !cr.texts[0].includes('[이어서]'));
    assert.equal(cr.texts[0].match(/--- 결과 [0-9a-f]{8} 시작 ---/g).length, 3, '검수 자료에 세 단계 답');
    // 호출 수는 이어서 센다. 정리 담당의 대화 번호는 끝까지 그대로(검수는 한 번 실행)
    assert.equal(m.calls.used, snap.mission.calls.used + cs.length);
    assert.equal(S2(sid).providerSessions[a.id], aSess);
    assert.equal(S2(sid).runs.length, snap.runs.length + 1);
    const texts = m.log.map((x) => x.text);
    for (const line of ['이어서: "분석" 단계부터.', `끊긴 단계 담당(${b.name})은 새 대화로 시작해.`, '앞 단계 1개의 결과를 다시 모았어.']) assert.ok(texts.includes(line), line);
    assert.equal(m.log.find((x) => x.text === '이어서: "분석" 단계부터.').kind, 'resume');
    // 끝난 목표는 다시 이어 갈 수 없다
    assert.equal((await h2.resume(sid, m.id)).status, 409);
  } finally { await h2.app.close(); }
});

test('3. 기준 판정 중 끊김 → 판정부터(같은 회차를 다시 센다). 일 단계는 다시 안 돌고, 검수자의 대화 기록은 건드리지 않는다', async () => {
  const t = await app();
  const a = await mk('판정끊정리', '정리');
  const b = await mk('판정끊분석', '분석');
  const tm = await mkTeam('판정끊팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const sid = await goal(tm.id, 'SLOW'); // 목표 문장의 SLOW 는 판정 차례만 느리게 한다
  await t.waitFor(() => S(sid).mission.at?.phase === 'review' && S(sid).messages.some((m) => m.review && m.status === 'streaming'), 30000, '판정 중');
  assert.deepEqual(S(sid).mission.at, { stageIndex: 2, phase: 'review', back: false, working: [a.id], wait: null });
  const { h2, snap } = await crash(first(), sid);
  try {
    await stays(h2, sid, snap);
    const from = t.fakeLog().length;
    assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
    assert.equal(h2.S(sid).providerSessions[a.id], snap.providerSessions[a.id], '검수자(정리 담당)의 대화 기록은 그대로');
    const run = h2.S(sid).runs.at(-1);
    assert.deepEqual(run.stages.map((x) => x.status).slice(0, 2), ['done', 'done']);
    await t.waitFor(() => h2.idle(sid) && h2.S(sid).mission.status !== 'active', 30000, '이어서 끝');
    const m = h2.S(sid).mission;
    assert.deepEqual([m.status, m.round], ['done', 1]);
    const cs = calls(from);
    assert.equal(cs.length, 1, '판정 한 번만');
    assert.ok(cs[0].texts[0].startsWith('[기준 판정 — 1번째 검수]') && !cs[0].texts[0].includes('[이어서]'));
    assert.equal(cs[0].texts[0].match(/--- 결과 [0-9a-f]{8} 시작 ---/g).length, 2, '다시 모은 두 단계 답이 검수 자료로');
    assert.equal(h2.S(sid).providerSessions[a.id], snap.providerSessions[a.id]);
    assert.ok(m.log.some((x) => x.text === '이어서: "기준 판정" 단계부터.'));
    assert.ok(m.log.some((x) => x.text === '앞 단계 2개의 결과를 다시 모았어.'));
    assert.ok(!m.log.some((x) => x.text.startsWith('끊긴 단계 담당')), '검수자는 새 대화로 바꿀 것이 없다');
  } finally { await h2.app.close(); }
});

test('4. 판정 뒤 묻기에서 끊김 → 호출 0번으로 같은 질문. 한 번 더·받아들이기가 듣는다', async () => {
  const t = await app();
  const a = await mk('묻기끊정리', '정리');
  const b = await mk('묻기끊분석', '분석');
  const tm = await mkTeam('묻기끊팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const sid = await goal(tm.id, 'REVIEWFAIL2');
  await t.waitFor(() => S(sid).runs.at(-1).hold?.reason === 'mission', 30000, '판정 대기');
  const hold = structuredClone(S(sid).runs.at(-1).hold);
  assert.deepEqual(S(sid).mission.at, { stageIndex: 2, phase: 'review', back: false, working: [], wait: { reason: 'mission', kind: 'verdict' } });
  const { h2, snap } = await crash(first(), sid);
  try {
    await stays(h2, sid, snap);
    const from = t.fakeLog().length;
    assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
    const run = await t.waitFor(() => h2.S(sid).runs.at(-1).hold?.reason === 'mission' && h2.S(sid).runs.at(-1), 20000, '같은 질문');
    assert.equal(calls(from).length, 0, 'CLI 호출 없이');
    assert.deepEqual([run.hold.kind, run.hold.round, run.hold.stageIndex, run.hold.left], [hold.kind, hold.round, hold.stageIndex, hold.left]);
    assert.deepEqual(run.stages.map((x) => x.status), ['done', 'done', 'done']);
    assert.deepEqual([h2.S(sid).mission.status, h2.S(sid).mission.returns], ['waiting', 1]);
    assert.ok(h2.S(sid).mission.log.some((x) => x.text === '이어서: 끊기기 전에 묻던 질문을 다시 띄워(AI 호출 없음).'));
    // 한 번 더 → 분석 단계가 걸린 기준과 함께 다시 → 3회차 검수 → 다시 묻기
    assert.equal((await h2.ctl(sid, 'more')).json.ok, true);
    await t.waitFor(() => h2.S(sid).runs.at(-1).hold?.reason === 'mission' && h2.S(sid).mission.round === 3, 30000, '다시 묻기');
    const cs = calls(from);
    assert.equal(cs.length, 2);
    assert.ok(cs[0].texts[0].includes('[지난 검수에서 걸린 것 — 참고 자료]') && !cs[0].texts[0].includes('[이어서]'));
    assert.ok(cs[1].texts[0].startsWith('[기준 판정 — 3번째 검수]'));
    assert.equal(h2.S(sid).mission.returns, 2);
    assert.equal((await h2.ctl(sid, 'accept')).json.ok, true);
    await t.waitFor(() => h2.idle(sid), 20000, '끝');
    assert.equal(h2.S(sid).mission.status, 'accepted');
  } finally { await h2.app.close(); }
});

test('5. 호출 상한 대기에서 끊김 → 호출 0번으로 같은 질문, "20번 더"로 이어 간다', async () => {
  const t = await app();
  const a = await mk('상한끊정리', '정리');
  const b = await mk('상한끊분석', '분석');
  const tm = await mkTeam('상한끊팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const sid = await goal(tm.id, '', { before: (x) => { S(x).mission.calls.cap = 2; } });
  await t.waitFor(() => S(sid).runs.at(-1).hold?.reason === 'cap', 30000, '상한 대기');
  assert.deepEqual(S(sid).mission.at, { stageIndex: 1, phase: 'work', back: false, working: [], wait: { reason: 'cap' } });
  const { h2, snap } = await crash(first(), sid);
  try {
    await stays(h2, sid, snap);
    const from = t.fakeLog().length;
    assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
    const run = await t.waitFor(() => h2.S(sid).runs.at(-1).hold?.reason === 'cap' && h2.S(sid).runs.at(-1), 20000, '같은 질문');
    assert.equal(calls(from).length, 0, 'CLI 호출 없이');
    assert.deepEqual([run.hold.stageIndex, run.hold.used, run.hold.cap], [1, 2, 2]);
    assert.ok(!h2.S(sid).mission.log.some((x) => x.text.startsWith('끊긴 단계 담당')), '대기에서 끊겼으면 새 대화로 바꿀 담당이 없다');
    assert.equal((await h2.ctl(sid, 'more')).json.ok, true);
    await t.waitFor(() => h2.idle(sid), 30000, '끝');
    const m = h2.S(sid).mission;
    assert.deepEqual([m.status, m.calls.cap, m.calls.used], ['done', 22, 2 + calls(from).length]);
    assert.equal(calls(from).length, 2, '분석과 기준 판정');
  } finally { await h2.app.close(); }
});

test('6. 되돌림 중 끊김 → 되돌림으로 이어 간다: 걸린 기준 블록과 직전 결과가 있고, 되돌림 수는 다시 세지 않는다', async () => {
  const t = await app();
  const a = await mk('되끊정리', '정리');
  const b = await mk('되끊분석', '분석');
  const tm = await mkTeam('되끊팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const sid = await goal(tm.id, 'REVIEWFAIL', { request: 'SLOW 정리해 줘' });
  await t.waitFor(() => S(sid).mission.at?.back === true && running(first(), sid, b.id, 1, 2), 40000, '되돌림 중');
  assert.deepEqual(S(sid).mission.at, { stageIndex: 1, phase: 'work', back: true, working: [b.id], wait: null });
  assert.ok(S(sid).providerSessions[b.id], '분석 담당은 첫 차례의 대화가 있다');
  const { h2, snap } = await crash(first(), sid);
  const bFirst = snap.messages.find((m) => m.agentId === b.id && m.stageIndex === 1 && m.status === 'done' && !m.review);
  try {
    await stays(h2, sid, snap);
    const from = t.fakeLog().length;
    assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
    await t.waitFor(() => h2.idle(sid), 30000, '끝');
    const m = h2.S(sid).mission;
    assert.deepEqual([m.status, m.returns, m.round], ['done', 1, 2]);
    const cs = calls(from);
    assert.equal(cs.length, 2, '분석(되돌림)과 2회차 검수');
    const p = cs[0].texts[0];
    assert.ok(!cs[0].args.includes('--resume'), '끊긴 되돌림 담당은 새 대화');
    assert.ok(p.includes('[이어서]') && p.includes('"분석"를 네가 맡았어'));
    assert.ok(p.includes('[지난 검수에서 걸린 것 — 참고 자료]') && p.includes('가짜 불합격 사유 1회차'), '걸린 기준 블록');
    assert.ok(p.includes('[이 단계의 직전 결과 — 참고 자료]') && p.includes(bFirst.text), '직전 결과(새 대화라 다시 준다)');
    assert.ok(cs[1].texts[0].startsWith('[기준 판정 — 2번째 검수]'));
    assert.ok(m.log.some((x) => x.text === '이어서: "분석" 단계의 되돌림부터.'));
    assert.equal(m.log.filter((x) => x.kind === 'return' && x.text.startsWith('되돌림')).length, 1, '되돌림 줄은 끊기기 전의 한 줄뿐');
  } finally { await h2.app.close(); }
});

test('7. 이어서 두 번: 다시 끊기면 또 이어 간다. 호출 수가 이어지고, 앞에서 끊긴 단계가 아닌 담당의 대화 번호는 그대로', async () => {
  const t = await app();
  const a = await mk('두번정리', '정리');
  const b = await mk('두번분석', '분석');
  const c = await mk('두번빌드', '빌드');
  const tm = await mkTeam('두번팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }, { label: '빌드', agentIds: [c.id] }]);
  const sid = await goal(tm.id, '', { request: 'SLOW 정리해 줘' });
  await t.waitFor(() => running(first(), sid, b.id, 1), 30000, '분석 중');
  const one = await crash(first(), sid);
  const h2 = one.h2;
  let h3 = null;
  try {
    const from = t.fakeLog().length;
    assert.equal((await h2.resume(sid, one.snap.mission.id)).status, 200);
    // 다시 켠 앱에서 빌드 단계가 도는 중에 또 끊긴다
    await t.waitFor(() => running(h2, sid, c.id, 2), 30000, '빌드 중');
    const two = await crash(h2, sid);
    h3 = two.h2;
    await stays(h3, sid, two.snap);
    const bSess = two.snap.providerSessions[b.id];
    assert.ok(bSess, '첫 이어서에서 분석 담당이 새로 연 대화');
    const mid = t.fakeLog().length;
    assert.equal((await h3.resume(sid, two.snap.mission.id)).status, 200);
    await t.waitFor(() => h3.idle(sid), 30000, '끝');
    const m = h3.S(sid).mission;
    assert.equal(m.status, 'done');
    assert.equal(m.calls.used, one.snap.mission.calls.used + calls(from).length, '호출 수가 두 번의 이어서를 지나 이어진다');
    const cs = calls(mid);
    assert.equal(cs.length, 2, '빌드와 기준 판정');
    assert.ok(cs[0].texts[0].includes('"빌드"를 네가 맡았어') && cs[0].texts[0].includes('[이어서]') && !cs[0].args.includes('--resume'));
    assert.equal(h3.S(sid).providerSessions[b.id], bSess, '두 번째에 끊긴 단계가 아닌 분석 담당의 대화 번호는 그대로');
    assert.equal(h3.S(sid).runs.length, one.snap.runs.length + 2);
    assert.equal(m.log.filter((x) => x.kind === 'resume' && x.text.startsWith('이어서:')).length, 2);
    assert.ok(m.log.some((x) => x.text === '앞 단계 2개의 결과를 다시 모았어.'));
  } finally {
    await h2.app.close();
    if (h3) await h3.app.close();
  }
});

test('8. 거절: 다른 목표·도는 실행·섞인 팀·팀이 바뀜·끊긴 자리 없음·요청 없음·버린 목표·끝난 목표. 목표 모드가 아닌 세션은 그대로', async () => {
  const t = await app();
  const a = await mk('거절정리', '정리');
  const b = await mk('거절분석', '분석');
  const tm = await mkTeam('거절팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  // 분석 단계에서 끊긴 목표를 디스크에 바로 만든다(정리 단계는 끝났고 그 답이 있다)
  const made = async (edit = (x) => x) => {
    const s = (await t.api('POST', '/api/sessions', { teamId: tm.id })).json;
    assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
    const live = S(s.id);
    const run = 'run-cut';
    live.messages.push({ id: 'm-req', role: 'user', text: '감나무 정리해 줘', status: 'done', createdAt: Date.now() });
    live.messages.push({ id: 'm-a0', role: 'agent', agentId: a.id, runId: run, stageIndex: 0, text: '정리 결과: 감나무 세 그루', status: 'done', createdAt: Date.now() });
    live.mission = {
      ...newMission({ request: '감나무 정리해 줘', requestMsgId: 'm-req', leadId: b.id }), status: 'active', phase: 'work', goal: '감나무 목표',
      criteria: [{ id: 'c1', text: '기준', status: 'open', evidence: '' }], confirmedAt: 1, reviewerId: a.id, keep: [],
      at: { stageIndex: 1, phase: 'work', back: false, working: [b.id], wait: null },
    };
    live.runs.push({
      id: run, teamId: tm.id, status: 'running', stageIndex: 1, hold: null, userMessageId: 'm-req', mission: 'work', missionId: live.mission.id, startedAt: Date.now(), endedAt: null,
      stages: [{ label: '정리', agentIds: [a.id], approve: false, instruction: '', meeting: null, status: 'done' }, { label: '분석', agentIds: [b.id], approve: false, instruction: '', meeting: null, status: 'running' },
        { label: '기준 판정', agentIds: [a.id], approve: false, instruction: '', meeting: null, mission: 'review', status: 'pending' }],
    });
    edit(live);
    t.app.store.saveSessionNow(live);
    return s.id;
  };
  const ok = await made();
  const old = await made((x) => { delete x.mission.at; delete x.mission.keep; }); // 끊긴 자리를 적기 전(2a-2)에 끊긴 목표
  const noReq = await made((x) => { x.messages = x.messages.filter((m) => m.id !== 'm-req'); });
  const disc = await made();
  // 목표 모드가 아닌 세션의 실행도 끊긴다(목표 없음)
  const plain = (await t.api('POST', '/api/sessions', { teamId: tm.id })).json.id;
  const pl = S(plain);
  pl.messages.push({ id: 'm-p', role: 'user', text: '그냥 정리해 줘', status: 'done', createdAt: Date.now() });
  pl.runs.push({ id: 'run-p', teamId: tm.id, status: 'running', stageIndex: 0, hold: null, userMessageId: 'm-p', startedAt: Date.now(), endedAt: null, stages: [{ label: '정리', agentIds: [a.id], status: 'running' }] });
  t.app.store.saveSessionNow(pl);
  await sleep(500);
  const h2 = await reopen();
  const S2 = h2.S;
  try {
    for (const id of [ok, old, noReq, disc]) assert.equal(S2(id).mission.status, 'cut', id);
    assert.deepEqual([S2(plain).runs.at(-1).status, S2(plain).mission], ['stopped', undefined]);
    await sleep(300);
    assert.equal(h2.app.orch.ctx.size, 0, '저절로 다시 돌지 않는다');
    const mid = (id) => S2(id).mission.id;
    // 다른 목표 id·목표 없는 세션·없는 세션
    assert.equal((await h2.resume(ok, 'ms-other')).status, 409);
    assert.equal((await h2.resume(plain, 'ms-other')).status, 409);
    assert.equal((await h2.resume('s-none', 'ms-other')).status, 404);
    // 끊긴 자리가 적혀 있지 않은 옛 목표, 요청 메시지가 없는 목표
    const r1 = await h2.resume(old, mid(old));
    assert.deepEqual([r1.status, r1.json.error], [409, '이 목표는 끊긴 자리가 적혀 있지 않아서 이어 갈 수 없어. 버리고 요청을 다시 보내 줘.']);
    assert.equal((await h2.resume(noReq, mid(noReq))).status, 409);
    // 버린 목표
    assert.equal((await h2.api('POST', `/api/sessions/${disc}/mission/discard`, { missionId: mid(disc) })).status, 200);
    assert.equal((await h2.resume(disc, mid(disc))).status, 409);
    // 끊긴 목표가 있는 동안: @이름 없는 말은 400(이어서 하거나 버리라는 안내), @이름으로 보낸 말은 보통 실행 → 그 실행이 도는 동안 이어서는 409
    const said = await h2.api('POST', `/api/sessions/${ok}/messages`, { text: '새 요청' });
    assert.deepEqual([said.status, said.json.error], [400, '끊긴 목표가 있어. 목표 카드에서 이어서 하거나, 버린 뒤에 새 요청을 보내 줘.']);
    assert.equal((await h2.api('POST', `/api/sessions/${ok}/messages`, { text: `@${a.name} SLOW 잠깐 확인해 줘` })).json.started, true);
    const busy = await h2.resume(ok, mid(ok));
    assert.deepEqual([busy.status, busy.json.error], [409, '다른 작업이 도는 중이야. 끝난 뒤에 시작해 줘.']);
    await t.waitFor(() => h2.idle(ok), 20000, '보통 실행 끝');
    // 섞인 팀(내 PC 모델이 들어옴) 400, 팀 단계가 바뀌면 409. 되돌리면 이어 갈 수 있다
    const agentA = structuredClone(h2.app.store.get('agents', a.id));
    await h2.api('PUT', `/api/agents/${a.id}`, { ...agentA, provider: 'local', model: 'custom0::tiny' });
    const mixed = await h2.resume(ok, mid(ok));
    assert.equal(mixed.status, 400);
    assert.match(mixed.json.error, /섞인 팀/);
    await h2.api('PUT', `/api/agents/${a.id}`, agentA);
    const team = structuredClone(h2.app.store.get('teams', tm.id));
    for (const change of [
      (x) => { x.stages[1].label = '분석 고침'; },
      (x) => { x.stages[0].approve = true; },
      (x) => { x.stages.reverse(); },
      (x) => { x.stages[1].agentIds = [a.id, b.id]; },
    ]) {
      const next = structuredClone(team);
      change(next);
      assert.equal((await h2.api('PUT', `/api/teams/${tm.id}`, next)).status, 200);
      const r = await h2.resume(ok, mid(ok));
      assert.deepEqual([r.status, r.json.error], [409, '팀이 바뀌어서 이어 갈 수 없어. 버리고 요청을 다시 보내 줘.'], JSON.stringify(next.stages));
      assert.equal(S2(ok).mission.status, 'cut', '거절해도 끊긴 목표는 그대로');
    }
    assert.equal((await h2.api('PUT', `/api/teams/${tm.id}`, team)).status, 200);
    const from = t.fakeLog().length;
    assert.equal((await h2.resume(ok, mid(ok))).status, 200);
    assert.equal((await h2.resume(ok, mid(ok))).status, 409, '이미 이어서 도는 중');
    await t.waitFor(() => h2.idle(ok), 30000, '끝');
    assert.equal(S2(ok).mission.status, 'done');
    const cs = calls(from);
    assert.equal(cs.length, 2, '분석과 기준 판정');
    assert.ok(cs[0].texts[0].includes('정리 결과: 감나무 세 그루'), '디스크의 앞 단계 답을 다시 모아 넘긴다');
    assert.equal((await h2.resume(ok, mid(ok))).status, 409, '끝난 목표');
    // 목표 모드가 아닌 세션: 보통 실행은 지금처럼(이어서 문장 없음)
    const n = t.fakeLog().length;
    assert.equal((await h2.api('POST', `/api/sessions/${plain}/messages`, { text: '다시 정리해 줘' })).json.started, true);
    await t.waitFor(() => h2.idle(plain), 20000, '보통 실행 끝');
    const ps = calls(n);
    assert.ok(ps.length >= 2 && ps.every((x) => x.texts.every((p) => !p.includes('[이어서]') && !p.includes('[확정된 목표'))));
    assert.equal(S2(plain).mission, undefined);
  } finally { await h2.app.close(); }
});
