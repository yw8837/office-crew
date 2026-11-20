// 목표 모드 2a-3(결정 0016): 끊긴 목표 이어서. 끊긴 자리(mission.at)를 적어 두고, 사용자가 "이어서"를 누르면 그 자리부터 새 실행 하나로 이어 간다.
// 앞 단계는 다시 돌지 않고 결과를 앞 실행들의 메시지에서 다시 모은다. CLI 를 띄운 채 끊긴 사람만 새 대화로(회의는 1바퀴부터 전원), 대기에서 끊겼으면 호출 없이 같은 질문을.
// 앱이 꺼지는 것은 이렇게 흉내 낸다(가짜 CLI, 실제 AI 사용량 0): 목표를 돌리는 앱을 따로 켜 두고, 끊을 순간에 그 앱의 저장소를 닫아 디스크를 그대로 얼린 뒤
// (그 뒤로는 세션·목록·사용량을 하나도 쓰지 않는다) 앱을 닫아 CLI 를 끄고, 같은 데이터 폴더로 앱을 새로 만든다.
// 진짜 꺼짐과 다른 점(남는 한계): 닫는 동안 메모리에서는 중지 흐름이 돈다(디스크에는 안 남는다). CLI 는 앱이 끈다(진짜로는 고아로 남을 수 있다).
// 세션 목록(index.json)이 "실행 중"으로 저장될 때까지 기다린 뒤 얼린다(진짜 꺼짐에서는 목록이 늦게 쓰여 끊김 알림 한 줄이 빠질 수 있다. 목표는 그래도 cut).
// 테스트 공용 첫 앱(t)은 에이전트·팀을 만들고, 미리 만들어 둔 끊긴 세션(14번)을 디스크에 쓰는 데만 쓴다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { bindLang } from '../server/i18n.js';
import { stageDiff, sameStages, teamRoles, resumePoint, pastOutputs, cutMission, newMission } from '../server/mission.js';
import { startTestApp, freePort } from './helpers.js';

bindLang(() => 'ko'); // 순수 함수의 문구(한국어 원문)를 검사한다
let t = null;
const app = async () => (t ||= await startTestApp());
const opened = []; // 이 파일이 켠 앱(테스트가 끝나면 닫는다)
after(async () => {
  for (const a of opened) { try { await a.close(); } catch { /* 이미 닫힘·윈도우 파일 잠금 무시 */ } }
  if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = async (name, role, extra = {}) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual', ...extra })).json;
const mkTeam = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides });

// 같은 데이터 폴더로 앱을 새로 만든다(켜기·다시 켜기). 앱 하나를 다루는 손잡이를 돌려준다
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
  return {
    app: a, api,
    S: (id) => a.store.getSession(id),
    idle: (id) => !a.orch.ctx.has(id),
    ctl: (sid, action, extra = {}) => api('POST', `/api/sessions/${sid}/control`, { action, ...extra }),
    resume: (sid, missionId) => api('POST', `/api/sessions/${sid}/mission/resume`, { missionId }),
  };
}
// 요청 → 카드 → (목표 문장을 신호어가 든 것으로 고쳐서) 확인. 카드가 보여 주던 검수 줄을 그대로 보낸다(뺄 수 있는 검수 단계는 전부 뺀다)
async function goal(h, teamId, signal = '', { request = '정리해 줘', before = null } = {}) {
  const s = (await h.api('POST', '/api/sessions', { teamId })).json;
  assert.equal((await h.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await h.api('POST', `/api/sessions/${s.id}/messages`, { text: request });
  await t.waitFor(() => h.S(s.id).mission?.status === 'draft' && h.idle(s.id), 20000, '목표 카드');
  const c = h.S(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  if (before) await before(s.id);
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const r = await h.api('POST', `/api/sessions/${s.id}/mission/confirm`, { missionId: h.S(s.id).mission.id, expected: shown(c), review, ...(signal ? { edited: { ...shown(c), goal: `${signal} 목표` } } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return s.id;
}
// 가짜 CLI 기록을 프로세스 단위로: [{ cli, args, texts }]. claude 는 시작 줄(인자) 뒤에 차례 글이 오고, codex 는 한 줄에 둘 다 있다.
// claude 가 둘 이상 동시에 돌면 차례 글이 어느 프로세스 것인지 가리지 못한다(차례로 도는 claude 와, claude 하나 + codex 는 맞다)
const calls = (from) => {
  const out = [];
  for (const l of t.fakeLog().slice(from)) {
    if (l.cli === 'codex') out.push({ cli: 'codex', args: l.args, texts: [l.prompt] });
    else if (l.cli === 'claude' && l.args) out.push({ cli: 'claude', args: l.args, texts: [] });
    else if (l.cli === 'claude' && l.text !== undefined) out.findLast((x) => x.cli === 'claude')?.texts.push(l.text);
  }
  return out;
};
const texts = (from) => calls(from).flatMap((x) => x.texts);
// 그 사람의 nth 번째 답이 지금 실행에서 도는 중인가(그 단계, 검수 답은 빼고)
const running = (h, sid, agentId, stageIndex, nth = 1) => {
  const s = h.S(sid);
  const mine = s.messages.filter((m) => m.role === 'agent' && m.agentId === agentId && m.stageIndex === stageIndex && m.runId === s.runs.at(-1)?.id && !m.review);
  return mine.length === nth && mine.at(-1).status === 'streaming';
};
// 앱이 꺼진 모양(머리 주석): 세션 목록에 "실행 중"이 저장되기를 기다린 뒤 이 앱의 디스크를 얼리고(그 순간의 세션 파일을 떠 둔다. edit 로 고칠 수 있다), 앱을 닫고 다시 켠다
async function crash(h, sid, edit = null) {
  const index = path.join(h.app.store.dirs.sessions, 'index.json');
  await t.waitFor(() => { try { return JSON.parse(fs.readFileSync(index, 'utf8'))[sid]?.running === true; } catch { return false; } }, 5000, '목록에 실행 중');
  h.app.store.closed = true; // 이 뒤로는 아무것도 쓰지 않는다
  const file = path.join(h.app.store.dirs.sessions, `${sid}.json`);
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (edit) { edit(snap); fs.writeFileSync(file, JSON.stringify(snap)); }
  h.app.store.close = () => {}; // 닫을 때 남은 저장·목록 쓰기도 하지 않는다
  await h.app.close(); // CLI 를 끄고 서버를 닫는다
  return { h2: await reopen(), snap };
}
// 다시 켠 뒤 저절로 돌지 않는다: 실행이 없고, 새 실행이 없고, CLI 를 띄우지 않는다. 끊긴 실행의 도는 단계는 멈춘 단계로 보인다
async function stays(h, sid, snap) {
  const n = t.fakeLog().length;
  await sleep(400);
  assert.equal(h.app.orch.ctx.size, 0, '다시 켠 뒤 실행이 없다');
  assert.equal(h.S(sid).runs.length, snap.runs.length, '새 실행을 만들지 않았다');
  assert.equal(t.fakeLog().length, n, 'CLI 를 띄우지 않았다');
  assert.equal(h.S(sid).mission.status, 'cut');
  assert.ok(h.S(sid).runs.at(-1).stages.every((x) => x.status !== 'running' && x.status !== 'review'), JSON.stringify(h.S(sid).runs.at(-1).stages.map((x) => x.status)));
}
const done = (h, sid) => t.waitFor(() => h.idle(sid) && !['active', 'waiting'].includes(h.S(sid).mission.status), 60000, '목표 끝');
const holdOf = (h, sid, reason) => t.waitFor(() => h.S(sid).runs.at(-1)?.hold?.reason === reason && h.S(sid).runs.at(-1), 30000, `${reason} 대기`);

test('1. 순수 함수: 단계표 대조(무엇이 다른지), 역할 종류, 끊긴 자리 읽기, 앞 단계 결과 다시 모으기, 끊김은 끊긴 자리를 그대로 둔다', () => {
  const st = (label, agentIds, extra = {}) => ({ label, agentIds, approve: false, instruction: '', meeting: null, ...extra });
  const meet = { rounds: 2, chairId: 'b', tokenCap: 1000000, opposeId: null };
  const a = [st('정리', ['a'], { instruction: '표로' }), st('분석', ['b', 'c'], { meeting: meet }), st('기준 판정', ['r'], { mission: 'review' })];
  // 같은 단계표(끊긴 실행의 단계에는 상태가 붙어 있다). 기준 판정 단계의 이름은 언어가 바뀌어도 같은 것으로 본다
  assert.equal(sameStages(a, a.map((x) => ({ ...x, status: 'done', note: 'x' }))), true);
  assert.equal(stageDiff(a, a.map((x, k) => (k === 2 ? { ...x, label: 'Criteria check' } : x))), null);
  const diff = (k, change) => stageDiff(a.map((x, j) => (j === k ? { ...x, ...change } : x)), a);
  assert.deepEqual(diff(0, { label: '정리2' }), { what: 'label', index: 0, label: '정리', to: '정리2' });
  assert.equal(diff(1, { agentIds: ['c', 'b'] }).what, 'agents');
  assert.equal(diff(0, { approve: true }).what, 'approve');
  assert.equal(diff(1, { meeting: null }).what, 'meeting');
  for (const m of [{ rounds: 3 }, { chairId: 'c' }, { opposeId: 'c' }, { tokenCap: 5 }]) assert.equal(diff(1, { meeting: { ...meet, ...m } }).what, 'meetingSet', JSON.stringify(m));
  assert.deepEqual(diff(0, { instruction: '글로' }), { what: 'instruction', index: 0, label: '정리', to: '정리' });
  assert.equal(diff(2, { mission: undefined }).what, 'review');
  assert.equal(stageDiff(a.slice(0, 2), a).what, 'count');
  assert.equal(sameStages(null, a), false);
  assert.deepEqual(teamRoles({ stages: [{ agentIds: ['a', 'x'] }, { agentIds: ['b', 'a'] }] }, [{ id: 'a', role: '정리' }, { id: 'b', role: '분석' }]), { a: 'organize', b: 'analysis' });
  // 끊긴 자리: 일 단계는 기준 판정 앞, 기준 판정 자리는 그 단계(검수자가 없으면 마지막 일 단계). 일하던 사람은 팀 단계의 에이전트만(회의의 조사 담당은 다른 단계 사람일 수 있다)
  assert.deepEqual(resumePoint({ stageIndex: 1, phase: 'work', back: false, working: ['b', 'z', 'b', 'r'], finished: ['m1', 3, 'm1'], wait: null }, a),
    { stageIndex: 1, phase: 'work', back: false, working: ['b', 'r'], finished: ['m1'], wait: null });
  assert.deepEqual(resumePoint({ stageIndex: 1, phase: 'work', back: true, working: ['b'], wait: { reason: 'cap' } }, a), { stageIndex: 1, phase: 'work', back: true, working: [], finished: [], wait: { reason: 'cap' } });
  assert.deepEqual(resumePoint({ stageIndex: 0, phase: 'work', finished: ['m1'], wait: { reason: 'approve' } }, a).wait, { reason: 'approve' });
  assert.deepEqual(resumePoint({ stageIndex: 0, phase: 'work', wait: { reason: 'error', failed: [{ agentId: 'a', error: 'x'.repeat(700) }, null] } }, a).wait, { reason: 'error', failed: [{ agentId: 'a', error: 'x'.repeat(600) }] });
  assert.deepEqual(resumePoint({ stageIndex: 2, phase: 'review', back: true, working: ['r'], finished: ['m1'], wait: null }, a), { stageIndex: 2, phase: 'review', back: false, working: ['r'], finished: [], wait: null });
  assert.deepEqual(resumePoint({ stageIndex: 2, phase: 'review', working: ['r'], wait: { reason: 'mission', kind: 'verdict' } }, a).wait, { reason: 'mission', kind: 'verdict' });
  const solo = a.slice(0, 2);
  assert.deepEqual(resumePoint({ stageIndex: 1, phase: 'review', wait: { reason: 'mission', kind: 'notes' } }, solo).wait, { reason: 'mission', kind: 'notes' });
  for (const bad of [null, {}, { stageIndex: 3, phase: 'work' }, { stageIndex: -1, phase: 'work' }, { stageIndex: 1.5, phase: 'work' }, { stageIndex: 2, phase: 'work' }, { stageIndex: 1, phase: 'review' },
    { stageIndex: 0, phase: 'goal' }, { stageIndex: 1, phase: 'work', wait: { reason: 'mission', kind: 'verdict' } }, { stageIndex: 2, phase: 'review', wait: { reason: 'mission', kind: 'x' } },
    { stageIndex: 1, phase: 'work', wait: { reason: 'pause' } }, { stageIndex: 2, phase: 'review', wait: { reason: 'approve' } }, { stageIndex: 0, phase: 'work', wait: { reason: 'error' } }]) {
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
  const two = [st('조사', ['x', 'y'])];
  assert.deepEqual(pastOutputs([msg('n1', 'r1', 'y', 0, 'y 답'), msg('n2', 'r1', 'x', 0, 'x 답'), msg('n3', 'r1', 'x', 0, 'x 차례', { meeting: { phase: 'turn' } })], ['r1'], two, 1),
    [[{ agentId: 'x', text: 'x 답', msgId: 'n2' }, { agentId: 'y', text: 'y 답', msgId: 'n1' }]]);
  // 끊김은 끊긴 자리를 건드리지 않는다
  const at = { stageIndex: 1, phase: 'work', back: false, working: ['b'], finished: [], wait: null };
  const s = { mission: { ...newMission({ request: 'x' }), status: 'active', at: structuredClone(at) } };
  assert.equal(cutMission(s), true);
  assert.deepEqual([s.mission.status, s.mission.at], ['cut', at]);
});

test('2. 일 단계 중 끊김 → 이어서: 끊긴 사람만 새 대화로(--resume 없이) "[이어서]"와 함께, 앞 단계는 다시 안 돌고 결과는 다시 모아 뒤 단계에 넘긴다. 끝까지 가서 done', async () => {
  const t = await app();
  const a = await mk('잇기정리', '정리');
  const b = await mk('잇기분석', '분석');
  const c = await mk('잇기빌드', '빌드');
  const tm = await mkTeam('잇기팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }, { label: '빌드', agentIds: [c.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, '', { request: 'SLOW 정리해 줘' });
  assert.deepEqual([h1.S(sid).mission.keep, h1.S(sid).mission.roles], [[], { [a.id]: 'organize', [b.id]: 'analysis', [c.id]: 'build' }]);
  assert.equal(h1.S(sid).mission.cwd, h1.app.orch.cwdOf(h1.S(sid)), '확정 때의 작업 폴더');
  await t.waitFor(() => running(h1, sid, b.id, 1) && h1.S(sid).mission.at.working.length === 1, 30000, '분석 중');
  const live = structuredClone(h1.S(sid).mission.at);
  assert.deepEqual(live, { stageIndex: 1, phase: 'work', back: false, working: [b.id], finished: [], wait: null });
  const { h2, snap } = await crash(h1, sid, (x) => {
    // 분석 담당이 이어 가던 대화가 있었다고 해 둔다(이어서 할 때 버려야 한다)
    x.providerSessions[b.id] = 'claude-sess-cutmark';
    (x.sessionProvider ||= {})[b.id] = 'claude';
    (x.noteHashes ||= {})[b.id] = 'hash-cutmark';
  });
  assert.deepEqual(snap.mission.at, live, '끊긴 자리는 CLI 를 띄울 때 바로 저장됐다');
  const aSess = snap.providerSessions[a.id];
  assert.ok(aSess, '정리 담당은 이어 갈 대화가 있다');
  const aDone = snap.messages.find((m) => m.agentId === a.id && m.stageIndex === 0 && m.status === 'done' && !m.review);
  const S2 = h2.S;
  assert.deepEqual([S2(sid).mission.status, S2(sid).runs.at(-1).status, S2(sid).runs.at(-1).stages[1].status], ['cut', 'stopped', 'stopped']);
  assert.ok(S2(sid).messages.some((x) => x.role === 'system' && x.text.includes('목표 카드에서 이어서 하거나, 버리고 새 요청을 보낼 수 있어.')));
  assert.deepEqual(S2(sid).mission.at, live, '끊김은 끊긴 자리를 그대로 둔다');
  await stays(h2, sid, snap);
  const from = t.fakeLog().length;
  const r = await h2.resume(sid, snap.mission.id);
  assert.deepEqual([r.status, r.json], [200, { ok: true, missionId: snap.mission.id }]);
  // 끊긴 사람의 대화 기록은 버렸다(새 대화). 다른 담당은 그대로
  assert.deepEqual([S2(sid).providerSessions[b.id], S2(sid).sessionProvider?.[b.id], S2(sid).noteHashes?.[b.id]], [undefined, undefined, undefined]);
  assert.equal(S2(sid).providerSessions[a.id], aSess);
  const run = S2(sid).runs.at(-1);
  assert.deepEqual([run.resumed, run.mission, run.missionId, run.stages[0].status], [true, 'work', snap.mission.id, 'done']);
  await done(h2, sid);
  const m = S2(sid).mission;
  assert.equal(m.status, 'done', JSON.stringify(m.log.slice(-6)));
  const cs = calls(from);
  assert.equal(cs.length, 3, '분석·빌드·기준 판정만 돈다(정리는 다시 안 돈다)');
  assert.ok(cs.every((x) => !x.texts.some((p) => p.includes('"정리"를 네가 맡았어'))));
  const [cb, cc, cr] = cs;
  assert.ok(cb.texts[0].includes('"분석"를 네가 맡았어') && !cb.args.includes('--resume'), '끊긴 사람은 새 대화');
  assert.ok(cb.texts[0].includes('[이어서] 이 단계는 앱이 꺼져서 중간에 끊겼어. 작업 폴더에 이미 해 둔 것이 있는지 먼저 확인하고, 있으면 거기서 이어서 해.'));
  assert.ok(cb.texts[0].indexOf('[이어서]') < cb.texts[0].indexOf('[확정된 목표와 합격 기준'), '그 단계 프롬프트의 맨 앞');
  assert.ok(cb.texts[0].includes('[이전 단계 결과]') && cb.texts[0].includes(aDone.text), '다시 모은 앞 단계 결과');
  assert.ok(cc.texts[0].includes('"빌드"를 네가 맡았어') && !cc.texts[0].includes('[이어서]'), '뒤 단계에는 안 붙인다');
  const bNew = S2(sid).messages.findLast((x) => x.agentId === b.id && x.stageIndex === 1 && x.status === 'done');
  assert.ok(cc.texts[0].includes(aDone.text) && cc.texts[0].includes(bNew.text));
  assert.ok(cr.texts[0].includes('[기준 판정 — 1번째 검수]') && !cr.texts[0].includes('[이어서]'));
  assert.equal(cr.texts[0].match(/--- 결과 [0-9a-f]{8} 시작 ---/g).length, 3, '검수 자료에 세 단계 답');
  // 호출 수는 이어서 센다(얼린 디스크의 값부터). 정리 담당의 대화 번호는 끝까지 그대로(검수는 한 번 실행)
  assert.equal(m.calls.used, snap.mission.calls.used + cs.length);
  assert.equal(S2(sid).providerSessions[a.id], aSess);
  assert.equal(S2(sid).runs.length, snap.runs.length + 1);
  const lines = m.log.map((x) => x.text);
  for (const line of ['이어서: "분석" 단계부터.', `끊긴 단계 담당(${b.name})은 새 대화로 시작해.`, '앞 단계 1개의 결과를 다시 모았어.']) assert.ok(lines.includes(line), line);
  assert.equal(m.log.find((x) => x.text === '이어서: "분석" 단계부터.').kind, 'resume');
  assert.equal((await h2.resume(sid, m.id)).status, 409, '끝난 목표는 다시 이어 갈 수 없다');
  await h2.app.close();
});

test('3. 기준 판정 중 끊김 → 판정부터(같은 회차를 다시 센다). 일 단계는 다시 안 돌고, 검수자의 대화 기록은 건드리지 않는다', async () => {
  const t = await app();
  const a = await mk('판정끊정리', '정리');
  const b = await mk('판정끊분석', '분석');
  const tm = await mkTeam('판정끊팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, 'SLOW'); // 목표 문장의 SLOW 는 판정 차례만 느리게 한다
  await t.waitFor(() => h1.S(sid).mission.at?.phase === 'review' && h1.S(sid).messages.some((m) => m.review && m.status === 'streaming'), 30000, '판정 중');
  assert.deepEqual(h1.S(sid).mission.at, { stageIndex: 2, phase: 'review', back: false, working: [a.id], finished: [], wait: null });
  const { h2, snap } = await crash(h1, sid);
  await stays(h2, sid, snap);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
  assert.equal(h2.S(sid).providerSessions[a.id], snap.providerSessions[a.id], '검수자(정리 담당)의 대화 기록은 그대로');
  assert.deepEqual(h2.S(sid).runs.at(-1).stages.map((x) => x.status).slice(0, 2), ['done', 'done']);
  await done(h2, sid);
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
  await h2.app.close();
});

test('4. 판정 뒤 묻기에서 끊김 → 호출 0번으로 같은 질문. 한 번 더·받아들이기가 듣는다', async () => {
  const t = await app();
  const a = await mk('묻기끊정리', '정리');
  const b = await mk('묻기끊분석', '분석');
  const tm = await mkTeam('묻기끊팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, 'REVIEWFAIL2');
  const hold = structuredClone((await holdOf(h1, sid, 'mission')).hold);
  assert.deepEqual(h1.S(sid).mission.at, { stageIndex: 2, phase: 'review', back: false, working: [], finished: [], wait: { reason: 'mission', kind: 'verdict' } });
  const { h2, snap } = await crash(h1, sid);
  await stays(h2, sid, snap);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
  const run = await holdOf(h2, sid, 'mission');
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
  await done(h2, sid);
  assert.equal(h2.S(sid).mission.status, 'accepted');
  await h2.app.close();
});

test('5. "반영 안 한 추가 지시" 질문에서 끊김 → 호출 0번으로 같은 질문, 그대로 끝내기가 듣는다', async () => {
  const t = await app();
  const a = await mk('지시끊정리', '정리');
  const b = await mk('지시끊분석', '분석');
  const tm = await mkTeam('지시끊팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, '', { request: 'SLOW 정리해 줘' });
  // 마지막 일 단계(분석)가 도는 중에 보낸 지시는 쓰일 단계가 없어 판정 뒤에 묻는다
  await t.waitFor(() => running(h1, sid, b.id, 1), 30000, '분석 중');
  assert.equal((await h1.api('POST', `/api/sessions/${sid}/messages`, { text: '표로도 정리해 줘' })).json.noted, true);
  const hold = structuredClone((await holdOf(h1, sid, 'mission')).hold);
  assert.deepEqual([hold.kind, hold.notes], ['notes', 1]);
  assert.deepEqual(h1.S(sid).mission.at.wait, { reason: 'mission', kind: 'notes' });
  const { h2, snap } = await crash(h1, sid);
  await stays(h2, sid, snap);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
  const run = await holdOf(h2, sid, 'mission');
  assert.equal(calls(from).length, 0, 'CLI 호출 없이');
  assert.deepEqual([run.hold.kind, run.hold.notes, run.hold.round], [hold.kind, hold.notes, hold.round]);
  assert.equal((await h2.ctl(sid, 'accept')).json.ok, true);
  await done(h2, sid);
  assert.equal(h2.S(sid).mission.status, 'done', '판정은 전부 통과였다');
  assert.equal(calls(from).length, 0);
  await h2.app.close();
});

test('6. 호출 상한 대기에서 끊김 → 호출 0번으로 같은 질문, "20번 더"로 이어 간다', async () => {
  const t = await app();
  const a = await mk('상한끊정리', '정리');
  const b = await mk('상한끊분석', '분석');
  const tm = await mkTeam('상한끊팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, '', { before: (x) => { h1.S(x).mission.calls.cap = 2; } });
  await holdOf(h1, sid, 'cap');
  assert.deepEqual(h1.S(sid).mission.at, { stageIndex: 1, phase: 'work', back: false, working: [], finished: [], wait: { reason: 'cap' } });
  const { h2, snap } = await crash(h1, sid);
  await stays(h2, sid, snap);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
  const run = await holdOf(h2, sid, 'cap');
  assert.equal(calls(from).length, 0, 'CLI 호출 없이');
  assert.deepEqual([run.hold.stageIndex, run.hold.used, run.hold.cap], [1, 2, 2]);
  assert.ok(!h2.S(sid).mission.log.some((x) => x.text.startsWith('끊긴 단계 담당')), '대기에서 끊겼으면 새 대화로 바꿀 담당이 없다');
  assert.equal((await h2.ctl(sid, 'more')).json.ok, true);
  await done(h2, sid);
  const m = h2.S(sid).mission;
  assert.equal(calls(from).length, 2, '분석과 기준 판정');
  assert.deepEqual([m.status, m.calls.cap, m.calls.used], ['done', 22, 2 + 2]);
  await h2.app.close();
});

test('7. 되돌림 중 끊김 → 되돌림으로 이어 간다: 걸린 기준 블록과 직전 결과가 있고, 되돌림 수는 다시 세지 않는다', async () => {
  const t = await app();
  const a = await mk('되끊정리', '정리');
  const b = await mk('되끊분석', '분석');
  const tm = await mkTeam('되끊팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, 'REVIEWFAIL', { request: 'SLOW 정리해 줘' });
  await t.waitFor(() => h1.S(sid).mission.at?.back === true && running(h1, sid, b.id, 1, 2) && h1.S(sid).mission.at.working.length === 1, 40000, '되돌림 중');
  assert.deepEqual(h1.S(sid).mission.at, { stageIndex: 1, phase: 'work', back: true, working: [b.id], finished: [], wait: null });
  assert.ok(h1.S(sid).providerSessions[b.id], '분석 담당은 첫 차례의 대화가 있다');
  const { h2, snap } = await crash(h1, sid);
  const bFirst = snap.messages.find((m) => m.agentId === b.id && m.stageIndex === 1 && m.status === 'done' && !m.review);
  await stays(h2, sid, snap);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
  await done(h2, sid);
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
  await h2.app.close();
});

test('8. 이어서 두 번: 다시 끊기면 또 이어 간다. 호출 수가 이어지고, 두 번째에 끊긴 단계가 아닌 담당의 대화 번호는 그대로', async () => {
  const t = await app();
  const a = await mk('두번정리', '정리');
  const b = await mk('두번분석', '분석');
  const c = await mk('두번빌드', '빌드');
  const tm = await mkTeam('두번팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }, { label: '빌드', agentIds: [c.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, '', { request: 'SLOW 정리해 줘' });
  await t.waitFor(() => running(h1, sid, b.id, 1) && h1.S(sid).mission.at.working.length === 1, 30000, '분석 중');
  const one = await crash(h1, sid);
  const h2 = one.h2;
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, one.snap.mission.id)).status, 200);
  // 다시 켠 앱에서 빌드 단계가 도는 중에 또 끊긴다
  await t.waitFor(() => running(h2, sid, c.id, 2) && h2.S(sid).mission.at.working.length === 1, 30000, '빌드 중');
  const two = await crash(h2, sid);
  const h3 = two.h2;
  await stays(h3, sid, two.snap);
  const bSess = two.snap.providerSessions[b.id];
  assert.ok(bSess, '첫 이어서에서 분석 담당이 새로 연 대화');
  const mid = t.fakeLog().length;
  assert.equal((await h3.resume(sid, two.snap.mission.id)).status, 200);
  await done(h3, sid);
  const m = h3.S(sid).mission;
  assert.equal(m.status, 'done');
  assert.equal(two.snap.mission.calls.used, one.snap.mission.calls.used + calls(from).length - calls(mid).length, '두 번째 끊김까지 센 호출 수가 디스크에 있다');
  assert.equal(m.calls.used, two.snap.mission.calls.used + calls(mid).length, '호출 수가 두 번의 이어서를 지나 이어진다');
  const cs = calls(mid);
  assert.equal(cs.length, 2, '빌드와 기준 판정');
  assert.ok(cs[0].texts[0].includes('"빌드"를 네가 맡았어') && cs[0].texts[0].includes('[이어서]') && !cs[0].args.includes('--resume'));
  assert.equal(h3.S(sid).providerSessions[b.id], bSess, '두 번째에 끊긴 단계가 아닌 분석 담당의 대화 번호는 그대로');
  assert.equal(h3.S(sid).runs.length, one.snap.runs.length + 2);
  assert.equal(m.log.filter((x) => x.kind === 'resume' && x.text.startsWith('이어서:')).length, 2);
  assert.ok(m.log.some((x) => x.text === '앞 단계 2개의 결과를 다시 모았어.'));
  await h3.app.close();
});

test('9. 병렬 단계에서 한 명만 끊김: 이미 끝낸 사람은 다시 안 돌고 그 답을 그대로 쓴다. 끊긴 사람만 새 대화와 "[이어서]"', async () => {
  const t = await app();
  const a = await mk('병렬빠름', '정리'); // 가짜 Claude: 일 차례는 [사용자 요청]에 SLOW 가 없으면 빠르다
  const b = await mk('병렬느림', '조사', { provider: 'codex', model: 'gpt-6.1-sol' }); // 가짜 Codex: 프롬프트 어디든 SLOW 가 있으면 1.5초
  const c = await mk('병렬다음', '분석');
  const tm = await mkTeam('병렬팀', [{ label: '모으기', agentIds: [a.id, b.id] }, { label: '정리', agentIds: [c.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, 'SLOW'); // 확정 목표 줄의 SLOW → Codex 만 느리다
  await t.waitFor(() => {
    const s = h1.S(sid);
    const ms = s.messages.filter((m) => m.stageIndex === 0 && m.role === 'agent' && m.runId === s.runs.at(-1).id);
    return ms.some((m) => m.agentId === a.id && m.status === 'done') && running(h1, sid, b.id, 0) && s.mission.at.finished.length === 1 && s.mission.at.working.length === 1;
  }, 30000, '빠른 쪽 끝, 느린 쪽 도는 중');
  const aMsg = h1.S(sid).messages.find((m) => m.agentId === a.id && m.stageIndex === 0 && m.status === 'done');
  assert.deepEqual(h1.S(sid).mission.at, { stageIndex: 0, phase: 'work', back: false, working: [b.id], finished: [aMsg.id], wait: null });
  const { h2, snap } = await crash(h1, sid, (x) => { x.providerSessions[b.id] = 'codex-thread-cutmark'; (x.sessionProvider ||= {})[b.id] = 'codex'; });
  const aSess = snap.providerSessions[a.id];
  assert.ok(aSess);
  await stays(h2, sid, snap);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
  assert.deepEqual([h2.S(sid).providerSessions[b.id], h2.S(sid).providerSessions[a.id]], [undefined, aSess], '끊긴 사람만 대화를 버린다');
  await done(h2, sid);
  assert.equal(h2.S(sid).mission.status, 'done');
  const cs = calls(from);
  assert.ok(!cs.some((x) => x.cli === 'claude' && x.texts.some((p) => p.includes('"모으기"를 네가 맡았어'))), '끝낸 사람(Claude)은 다시 안 돈다');
  const redo = cs.filter((x) => x.cli === 'codex');
  assert.equal(redo.length, 1);
  assert.ok(!redo[0].args.includes('resume') && redo[0].texts[0].includes('[이어서]') && redo[0].texts[0].includes('"모으기"를 네가 맡았어'));
  const next = cs.find((x) => x.cli === 'claude' && x.texts[0]?.includes('"정리"를 네가 맡았어'));
  assert.ok(next.texts[0].includes(aMsg.text) && next.texts[0].includes('정리 결과: 파란색') && !next.texts[0].includes('[이어서]'), '다음 단계에 두 사람의 답이 다 간다');
  assert.equal(h2.S(sid).runs.at(-1).stages[0].status, 'done');
  const lines = h2.S(sid).mission.log.map((x) => x.text);
  assert.ok(lines.includes(`끊긴 단계 담당(${b.name})은 새 대화로 시작해.`));
  assert.ok(lines.includes(`"모으기" 단계에서 이미 끝낸 ${a.name}의 답은 다시 돌지 않고 그대로 써.`));
  assert.equal(h2.S(sid).providerSessions[a.id], aSess);
  await h2.app.close();
});

test('10. 회의 중 끊김: 회의는 1바퀴부터 참석자 전원과 조사 담당이 새 대화로, "[이어서]"는 각자의 첫 차례에만. 회의 설정이 바뀌면 이유와 함께 409', async () => {
  const t = await app();
  const a = await mk('회의진행', '분석');
  const b = await mk('회의참석', '정리');
  const r = await mk('회의조사', '조사'); // 회의 단계 밖의 조사 담당
  const c = await mk('회의빌드', '빌드');
  const tm = await mkTeam('회의팀', [{ label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 2, chairId: a.id } }, { label: '조사', agentIds: [r.id] }, { label: '빌드', agentIds: [c.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, '', { request: 'SLOW CHECKME 정리해 줘' });
  // 2바퀴 차례 글의 질문을 조사 담당이 찾는 중에 끊긴다
  await t.waitFor(() => h1.S(sid).messages.some((m) => m.meeting?.phase === 'research' && m.status === 'streaming') && h1.S(sid).mission.at.working.includes(r.id), 40000, '회의 조사 중');
  assert.equal(h1.S(sid).mission.at.stageIndex, 0);
  // 목표 실행의 회의는 새 대화로 돈다(결정 0017): 회의 차례는 참석자의 CLI 대화 번호를 만들지 않는다.
  // 끊긴 회의를 이어서 할 때 참석자·조사 담당의 저장된 대화를 버리는지 보려고, 얼린 세션에 대화 번호를 심어 둔다
  assert.ok(!h1.S(sid).providerSessions[a.id] && !h1.S(sid).providerSessions[b.id], '회의 차례는 참석자의 대화 번호를 만들지 않는다');
  const { h2, snap } = await crash(h1, sid, (x) => { for (const [id, sess] of [[r.id, 'claude-sess-research'], [a.id, 'claude-sess-chair'], [b.id, 'claude-sess-member']]) { x.providerSessions[id] = sess; (x.sessionProvider ||= {})[id] = 'claude'; } });
  assert.ok(snap.providerSessions[a.id] && snap.providerSessions[b.id], '참석자에게 이어 갈 대화 번호가 있었다');
  await stays(h2, sid, snap);
  // 회의 설정(바퀴 수)을 바꾸면 무엇이 달라졌는지 알려 주며 거절하고, 되돌리면 이어 간다
  const team = structuredClone(h2.app.store.get('teams', tm.id));
  const more = structuredClone(team);
  more.stages[0].meeting = { ...more.stages[0].meeting, rounds: 3 };
  assert.equal((await h2.api('PUT', `/api/teams/${tm.id}`, more)).status, 200);
  const no = await h2.resume(sid, snap.mission.id);
  assert.deepEqual([no.status, no.json.error], [409, '팀이 바뀌어서 이어 갈 수 없어: "회의" 단계의 회의 설정(바퀴 수·진행자·반대편·사용량 상한)이 달라졌어. 버리고 요청을 다시 보내 줘.']);
  assert.equal((await h2.api('PUT', `/api/teams/${tm.id}`, team)).status, 200);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
  assert.deepEqual([a.id, b.id, r.id].map((id) => h2.S(sid).providerSessions[id]), [undefined, undefined, undefined], '참석자 전원과 조사 담당은 새 대화로');
  await done(h2, sid);
  assert.equal(h2.S(sid).mission.status, 'done');
  const run = h2.S(sid).runs.at(-1);
  const phases = h2.S(sid).messages.filter((m) => m.runId === run.id && m.stageIndex === 0).map((m) => m.meeting?.phase);
  assert.deepEqual(phases, ['opinion', 'opinion', 'turn', 'research', 'conclude'], '회의를 1바퀴부터 다시 했다');
  const meetPrompts = texts(from).filter((p) => p.includes('"회의"를 네가 맡았어'));
  assert.equal(meetPrompts.filter((p) => p.includes('[이어서]')).length, 3, '두 참석자의 첫 의견과 조사 담당의 첫 조사에만');
  const research = calls(from).find((x) => x.texts[0]?.includes('회의에서 나온 질문 하나를 도구로 찾아서 답해'));
  assert.ok(research.texts[0].includes('[이어서]') && !research.args.includes('--resume'), '조사 담당도 새 대화');
  assert.ok(meetPrompts.filter((p) => !p.includes('[이어서]')).length >= 2, '2바퀴 차례와 결론에는 안 붙는다');
  assert.ok(!texts(from).some((p) => p.includes('"빌드"를 네가 맡았어') && p.includes('[이어서]')));
  assert.ok(h2.S(sid).mission.log.some((x) => x.text === `회의 단계 "회의"는 1바퀴부터 다시 하고, 참석자(${a.name}, ${b.name}, ${r.name})는 새 대화로 시작해.`));
  await h2.app.close();
});

test('11. 승인 대기에서 끊김 → 호출 0번으로 같은 승인을 다시 묻는다(대화 기록은 그대로). 승인하면 그 답으로 이어 간다', async () => {
  const t = await app();
  const a = await mk('승인끊정리', '정리');
  const b = await mk('승인끊분석', '분석');
  const tm = await mkTeam('승인끊팀', [{ label: '정리', agentIds: [a.id], approve: true }, { label: '분석', agentIds: [b.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id);
  await holdOf(h1, sid, 'approve');
  const aMsg = h1.S(sid).messages.findLast((m) => m.agentId === a.id && m.stageIndex === 0 && m.status === 'done');
  assert.deepEqual(h1.S(sid).mission.at, { stageIndex: 0, phase: 'work', back: false, working: [], finished: [aMsg.id], wait: { reason: 'approve' } });
  const { h2, snap } = await crash(h1, sid);
  await stays(h2, sid, snap);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
  const run = await holdOf(h2, sid, 'approve');
  assert.deepEqual([run.hold.stageIndex, run.stages[0].status, calls(from).length], [0, 'review', 0], '호출 없이 같은 승인');
  assert.equal(h2.S(sid).providerSessions[a.id], snap.providerSessions[a.id], '대화 기록은 그대로');
  assert.equal(h2.S(sid).mission.calls.used, snap.mission.calls.used);
  assert.equal((await h2.ctl(sid, 'approve')).json.ok, true);
  await done(h2, sid);
  assert.equal(h2.S(sid).mission.status, 'done');
  const cs = calls(from);
  assert.equal(cs.length, 2, '분석과 기준 판정');
  assert.ok(cs[0].texts[0].includes('"분석"를 네가 맡았어') && cs[0].texts[0].includes(aMsg.text) && !cs[0].texts[0].includes('[이어서]'), '승인한 답이 다음 단계로');
  await h2.app.close();
});

test('12. 오류 대기에서 끊김 → 호출 0번으로 같은 질문(다시·건너뛰기·중지). 성공한 사람의 답은 살아 있어 건너뛰어도 검수 자료로 간다', async () => {
  const t = await app();
  const d = await mk('오류준비', '분석');
  const b = await mk('오류실패', '조사');
  const x = await mk('오류성공', '조사', { provider: 'codex', model: 'gpt-6.1-sol' });
  const rv = await mk('오류검수', '검수');
  const tm = await mkTeam('오류팀', [{ label: '준비', agentIds: [d.id] }, { label: '모으기', agentIds: [b.id, x.id] }, { label: '검수', agentIds: [rv.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, '', { request: 'SLOW 정리해 줘' });
  // 준비 단계 중에 보낸 추가 지시(FAILME)는 모으기 단계의 [사용자 추가 지시]로 들어가 가짜 Claude 만 실패한다
  await t.waitFor(() => running(h1, sid, d.id, 0), 30000, '준비 중');
  assert.equal((await h1.api('POST', `/api/sessions/${sid}/messages`, { text: 'FAILME 확인' })).json.noted, true);
  const hold = structuredClone((await holdOf(h1, sid, 'error')).hold);
  const xMsg = h1.S(sid).messages.findLast((m) => m.agentId === x.id && m.stageIndex === 1 && m.status === 'done');
  assert.ok(xMsg, '성공한 사람의 답');
  assert.deepEqual(h1.S(sid).mission.at, { stageIndex: 1, phase: 'work', back: false, working: [], finished: [xMsg.id], wait: { reason: 'error', failed: [{ agentId: b.id, error: '가짜 실패' }] } });
  const { h2, snap } = await crash(h1, sid);
  await stays(h2, sid, snap);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, snap.mission.id)).status, 200);
  const run = await holdOf(h2, sid, 'error');
  assert.deepEqual([run.hold.stageIndex, run.hold.message, run.stages[1].status, calls(from).length], [1, hold.message, 'error', 0], '호출 없이 같은 질문');
  assert.equal((await h2.ctl(sid, 'skip')).json.ok, true);
  await done(h2, sid);
  assert.equal(h2.S(sid).mission.status, 'done');
  const cs = calls(from);
  assert.equal(cs.length, 1, '기준 판정만');
  assert.ok(cs[0].texts[0].startsWith('[기준 판정 — 1번째 검수]') && cs[0].texts[0].includes('정리 결과: 파란색'), '성공한 사람의 답이 검수 자료에');
  await h2.app.close();
});

test('13. 정상으로 끄기(app.close) → 다시 켜기 → 이어서: 끄는 동안 목표 상태를 바꾸지 않아 cut 이 되고, 끊긴 사람은 새 대화로 이어 간다', async () => {
  const t = await app();
  const a = await mk('정상정리', '정리');
  const b = await mk('정상분석', '분석');
  const tm = await mkTeam('정상팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const h1 = await reopen();
  const sid = await goal(h1, tm.id, '', { request: 'SLOW 정리해 줘' });
  await t.waitFor(() => running(h1, sid, b.id, 1) && h1.S(sid).mission.at.working.length === 1, 30000, '분석 중');
  // 가장 나쁜 순서: 끄기(stopAll) 뒤 저장소가 닫히기 전에 실행 정리(#missionEnd)가 다 돌고 저장까지 해도 목표는 그대로다
  h1.app.orch.stopAll();
  await t.waitFor(() => h1.idle(sid), 20000, '실행 정리');
  await sleep(300); // 정리 뒤의 저장까지
  assert.equal(h1.S(sid).mission.status, 'active', '끄는 중에는 목표를 멈춤으로 바꾸지 않는다');
  await h1.app.close(); // 정상 종료(Ctrl+C·창 닫기와 같은 길)
  const disk = JSON.parse(fs.readFileSync(path.join(h1.app.store.dirs.sessions, `${sid}.json`), 'utf8'));
  assert.deepEqual([disk.mission.status, disk.mission.at.working], ['active', [b.id]], '디스크에도 도는 목표와 끊긴 사람이 남았다');
  const h2 = await reopen();
  assert.deepEqual([h2.S(sid).mission.status, h2.S(sid).runs.at(-1).status], ['cut', 'stopped']);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(sid, disk.mission.id)).status, 200);
  await done(h2, sid);
  assert.equal(h2.S(sid).mission.status, 'done');
  const cs = calls(from);
  assert.equal(cs.length, 2);
  assert.ok(cs[0].texts[0].includes('[이어서]') && cs[0].texts[0].includes('"분석"를 네가 맡았어'));
  await h2.app.close();
});

test('14. 거절과 그 이유(다른 목표·도는 실행·섞인 팀·지시·담당·이름·승인·역할 종류·작업 폴더·끊긴 자리 없음·요청 없음·버린 목표·끝난 목표), 실행 기록 30개 자르기, 못 찾은 단계 이름, 목표 모드가 아닌 세션', async () => {
  const t = await app();
  const a = await mk('거절정리', '정리');
  const b = await mk('거절분석', '분석');
  const c = await mk('거절빌드', '빌드');
  const tm = await mkTeam('거절팀', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }]);
  const tm3 = await mkTeam('거절세단계', [{ label: '정리', agentIds: [a.id] }, { label: '분석', agentIds: [b.id] }, { label: '빌드', agentIds: [c.id] }]);
  const stage = (label, id, status, extra = {}) => ({ label, agentIds: [id], approve: false, instruction: '', meeting: null, status, ...extra });
  // 끊긴 목표를 디스크에 바로 만든다(처음 앱이 쓴다)
  const made = async (teamId, stages, cutAt, edit = (x) => x) => {
    const s = (await t.api('POST', '/api/sessions', { teamId })).json;
    assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
    const live = t.app.store.getSession(s.id);
    const run = 'run-cut';
    live.messages.push({ id: 'm-req', role: 'user', text: '감나무 정리해 줘', status: 'done', createdAt: Date.now() });
    live.messages.push({ id: 'm-a0', role: 'agent', agentId: a.id, runId: run, stageIndex: 0, text: '정리 결과: 감나무 세 그루', status: 'done', createdAt: Date.now() });
    const team = t.app.store.get('teams', teamId);
    live.mission = {
      ...newMission({ request: '감나무 정리해 줘', requestMsgId: 'm-req', leadId: b.id }), status: 'active', phase: 'work', goal: '감나무 목표',
      criteria: [{ id: 'c1', text: '기준', status: 'open', evidence: '' }], confirmedAt: 1, reviewerId: a.id, keep: [],
      cwd: t.app.orch.cwdOf(live), roles: teamRoles(team, t.app.store.all('agents')),
      at: { stageIndex: cutAt, phase: 'work', back: false, working: [stages[cutAt].agentIds[0]], finished: [], wait: null },
    };
    live.runs.push({ id: run, teamId, status: 'running', stageIndex: cutAt, hold: null, userMessageId: 'm-req', mission: 'work', missionId: live.mission.id, startedAt: Date.now(), endedAt: null, stages });
    edit(live);
    t.app.store.saveSessionNow(live);
    return s.id;
  };
  const two = () => [stage('정리', a.id, 'done'), stage('분석', b.id, 'running'), stage('기준 판정', a.id, 'pending', { mission: 'review' })];
  const ok = await made(tm.id, two(), 1);
  const old = await made(tm.id, two(), 1, (x) => { delete x.mission.at; delete x.mission.keep; }); // 끊긴 자리를 적기 전(2a-2)에 끊긴 목표
  const noReq = await made(tm.id, two(), 1, (x) => { x.messages = x.messages.filter((m) => m.id !== 'm-req'); });
  const disc = await made(tm.id, two(), 1);
  // 세 단계 팀: 정리 단계의 답은 없고(못 찾음), 분석 단계는 건너뛰었다(못 찾은 것으로 세지 않는다)
  const miss = await made(tm3.id, [stage('정리', a.id, 'done'), stage('분석', b.id, 'skipped'), stage('빌드', c.id, 'running'), stage('기준 판정', a.id, 'pending', { mission: 'review' })], 2,
    (x) => { x.messages = x.messages.filter((m) => m.id !== 'm-a0'); });
  // 목표 모드가 아닌 세션의 실행도 끊긴다(목표 없음)
  const plain = (await t.api('POST', '/api/sessions', { teamId: tm.id })).json.id;
  const pl = t.app.store.getSession(plain);
  pl.messages.push({ id: 'm-p', role: 'user', text: '그냥 정리해 줘', status: 'done', createdAt: Date.now() });
  pl.runs.push({ id: 'run-p', teamId: tm.id, status: 'running', stageIndex: 0, hold: null, userMessageId: 'm-p', startedAt: Date.now(), endedAt: null, stages: [{ label: '정리', agentIds: [a.id], status: 'running' }] });
  t.app.store.saveSessionNow(pl);
  await sleep(500);
  const h2 = await reopen();
  const S2 = h2.S;
  for (const id of [ok, old, noReq, disc, miss]) assert.equal(S2(id).mission.status, 'cut', id);
  assert.deepEqual([S2(plain).runs.at(-1).status, S2(plain).runs.at(-1).stages[0].status, S2(plain).mission], ['stopped', 'stopped', undefined], '목표가 아닌 실행의 도는 단계도 멈춘 단계로');
  await sleep(300);
  assert.equal(h2.app.orch.ctx.size, 0, '저절로 다시 돌지 않는다');
  const mid = (id) => S2(id).mission.id;
  const why = async (id) => { const r = await h2.resume(id, mid(id)); return [r.status, r.json.error]; };
  const changed = (what) => [409, `팀이 바뀌어서 이어 갈 수 없어: ${what}. 버리고 요청을 다시 보내 줘.`];
  // 다른 목표 id·목표 없는 세션·없는 세션
  assert.equal((await h2.resume(ok, 'ms-other')).status, 409);
  assert.equal((await h2.resume(plain, 'ms-other')).status, 409);
  assert.equal((await h2.resume('s-none', 'ms-other')).status, 404);
  // 끊긴 자리가 적혀 있지 않은 옛 목표, 요청 메시지가 없는 목표, 버린 목표
  assert.deepEqual(await why(old), [409, '이 목표는 끊긴 자리가 적혀 있지 않아서 이어 갈 수 없어. 버리고 요청을 다시 보내 줘.']);
  assert.deepEqual(await why(noReq), [409, '요청 메시지를 찾지 못했어. 요청을 다시 보내 줘.']);
  assert.equal((await h2.api('POST', `/api/sessions/${disc}/mission/discard`, { missionId: mid(disc) })).status, 200);
  assert.equal((await h2.resume(disc, mid(disc))).status, 409);
  // 끊긴 목표가 있는 동안: @이름 없는 말은 400(이어서 하거나 버리라는 안내). 실행 기록이 30개를 넘어 잘려도 이 목표의 일 실행은 남는다.
  // @이름으로 보낸 말은 보통 실행 → 그 실행이 도는 동안 이어서는 409
  const said = await h2.api('POST', `/api/sessions/${ok}/messages`, { text: '새 요청' });
  assert.deepEqual([said.status, said.json.error], [400, '끊긴 목표가 있어. 목표 카드에서 이어서 하거나, 버린 뒤에 새 요청을 보내 줘.']);
  for (let k = 0; k < 30; k++) S2(ok).runs.push({ id: `run-old-${k}`, teamId: tm.id, status: 'done', stageIndex: 0, hold: null, userMessageId: 'm-req', startedAt: 1, endedAt: 2, stages: [] });
  assert.equal((await h2.api('POST', `/api/sessions/${ok}/messages`, { text: `@${a.name} SLOW 잠깐 확인해 줘` })).json.started, true);
  assert.deepEqual([S2(ok).runs.length, S2(ok).runs.some((r) => r.id === 'run-cut'), S2(ok).runs.some((r) => r.id === 'run-old-0')], [30, true, false], '살아 있는 목표의 일 실행은 남기고 오래된 것부터 자른다');
  assert.deepEqual(await why(ok), [409, '다른 작업이 도는 중이야. 끝난 뒤에 시작해 줘.']);
  await t.waitFor(() => h2.idle(ok), 20000, '보통 실행 끝');
  // 섞인 팀(내 PC 모델이 들어옴) 400. 되돌린다
  const agentA = structuredClone(h2.app.store.get('agents', a.id));
  await h2.api('PUT', `/api/agents/${a.id}`, { ...agentA, provider: 'local', model: 'custom0::tiny' });
  const mixed = await h2.resume(ok, mid(ok));
  assert.equal(mixed.status, 400);
  assert.match(mixed.json.error, /섞인 팀/);
  await h2.api('PUT', `/api/agents/${a.id}`, agentA);
  // 역할 종류·작업 폴더가 바뀌면 그 이유로 409. 되돌린다
  const agentB = structuredClone(h2.app.store.get('agents', b.id));
  await h2.api('PUT', `/api/agents/${b.id}`, { ...agentB, role: '조사' });
  assert.deepEqual(await why(ok), changed(`${b.name}의 역할 종류가 달라졌어`));
  await h2.api('PUT', `/api/agents/${b.id}`, agentB);
  const other = path.join(t.root, 'other-cwd');
  fs.mkdirSync(other, { recursive: true });
  assert.equal((await h2.api('PATCH', `/api/sessions/${ok}`, { cwd: other })).status, 200);
  assert.deepEqual(await why(ok), changed('작업 폴더가 달라졌어'));
  assert.equal((await h2.api('PATCH', `/api/sessions/${ok}`, { cwd: '' })).status, 200);
  // 팀 단계가 바뀌면 무엇이 달라졌는지와 함께 409. 되돌리면 이어 갈 수 있다
  const team = structuredClone(h2.app.store.get('teams', tm.id));
  for (const [change, what] of [
    [(x) => { x.stages[1].label = '분석 고침'; }, '2번째 단계 이름이 달라졌어("분석" → "분석 고침")'],
    [(x) => { x.stages[0].approve = true; }, '"정리" 단계의 승인 관문이 달라졌어'],
    [(x) => { x.stages[1].instruction = '새 지시'; }, '"분석" 단계의 지시가 달라졌어'],
    [(x) => { x.stages[1].agentIds = [c.id]; }, '"분석" 단계의 담당이 달라졌어'],
    [(x) => { x.stages.reverse(); }, '단계 수가 달라졌어'],
  ]) {
    const next = structuredClone(team);
    change(next);
    assert.equal((await h2.api('PUT', `/api/teams/${tm.id}`, next)).status, 200);
    assert.deepEqual(await why(ok), changed(what), JSON.stringify(next.stages));
    assert.equal(S2(ok).mission.status, 'cut', '거절해도 끊긴 목표는 그대로');
  }
  assert.equal((await h2.api('PUT', `/api/teams/${tm.id}`, team)).status, 200);
  const from = t.fakeLog().length;
  assert.equal((await h2.resume(ok, mid(ok))).status, 200);
  assert.equal((await h2.resume(ok, mid(ok))).status, 409, '이미 이어서 도는 중');
  await done(h2, ok);
  assert.equal(S2(ok).mission.status, 'done');
  const cs = calls(from);
  assert.equal(cs.length, 2, '분석과 기준 판정');
  assert.ok(cs[0].texts[0].includes('정리 결과: 감나무 세 그루'), '디스크의 앞 단계 답을 다시 모아 넘긴다');
  assert.equal((await h2.resume(ok, mid(ok))).status, 409, '끝난 목표');
  // 못 찾은 단계는 이름을 적고, 정상으로 건너뛴 단계는 세지 않는다
  assert.equal((await h2.resume(miss, mid(miss))).status, 200);
  assert.ok(S2(miss).mission.log.some((x) => x.text === '앞 단계 0개의 결과를 다시 모았어. 못 찾은 단계: 정리.'), JSON.stringify(S2(miss).mission.log.slice(-4).map((x) => x.text)));
  assert.deepEqual(S2(miss).runs.at(-1).stages.map((x) => x.status).slice(0, 2), ['done', 'skipped']);
  await done(h2, miss);
  // 목표 모드가 아닌 세션: 보통 실행은 지금처럼(이어서 문장 없음)
  const n = t.fakeLog().length;
  assert.equal((await h2.api('POST', `/api/sessions/${plain}/messages`, { text: '다시 정리해 줘' })).json.started, true);
  await t.waitFor(() => h2.idle(plain), 20000, '보통 실행 끝');
  const ps = calls(n);
  assert.ok(ps.length >= 2 && ps.every((x) => x.texts.every((p) => !p.includes('[이어서]') && !p.includes('[확정된 목표'))));
  assert.equal(S2(plain).mission, undefined);
  await h2.app.close();
});
