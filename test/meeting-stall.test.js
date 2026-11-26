// 회의가 헛도는 걸 코드가 알아채기(결정 0028): 입장 줄 읽기(positionOf), 반대편을 뺀 참석자의 입장이 앞 바퀴와 그대로면 판정 없이 결론(정체),
// 진행자 판정의 ask(사용자에게 묻기)와 그 답을 확정 지시로 넣기(보통 회의·목표 회의·긴 세션 회의·끊긴 뒤 이어서). 가짜 CLI, 실제 AI 사용량 0
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { stageModel, openQuestions } from '../public/js/stage-model.js';
import { boardCards } from '../public/js/office/meeting.js';
import { positionOf, stalled, parseVerdict, MEET_ASK_MAX } from '../server/meeting.js';
import { normMeeting, meetingSpend } from '../server/orchestrator.js';
import { PROVIDERS } from '../server/providers/index.js';
import { bindLang } from '../server/i18n.js';
import { startTestApp, freePort } from './helpers.js';

bindLang(() => 'ko'); // 순수 함수의 문구(한국어 원문)를 검사한다
let t = null;
// 프로바이더에 넘긴 프롬프트를 통째로 적는다(가짜 CLI 기록은 앞 5,000자만이라 긴 프롬프트는 여기서 본다)
const sent = [];
const keepRun = {};
const app = async () => {
  if (t) return t;
  t = await startTestApp();
  for (const id of ['claude']) {
    const p = PROVIDERS[id];
    keepRun[id] = p.run;
    p.run = (opts, emit) => { sent.push({ agent: opts.agent?.name, id: opts.agent?.id, resumed: !!opts.resumeId, prompt: String(opts.prompt || '') }); return keepRun[id].call(p, opts, emit); };
  }
  return t;
};
const opened = []; // 끊김 흉내로 켠 앱(테스트가 끝나면 닫는다)
after(async () => {
  for (const [id, run] of Object.entries(keepRun)) PROVIDERS[id].run = run;
  for (const a of opened) { try { await a.close(); } catch { /* 이미 닫힘·윈도우 파일 잠금 무시 */ } }
  if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } }
});

const S = (id) => t.app.store.getSession(id);
const idle = (sid) => !t.app.orch.ctx.has(sid);
const mk = async (name, role = '분석', extra = {}) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual', skills: [], ...extra })).json;
const mkTeam = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const runs = (sid) => S(sid).runs;
const start = async (sid, text) => { const n = runs(sid).length; await t.api('POST', `/api/sessions/${sid}/messages`, { text }); await t.waitFor(() => runs(sid).length > n, 5000, '실행 시작'); };
const ended = (sid) => t.waitFor(() => runs(sid).at(-1).endedAt && idle(sid), 30000, '실행 끝');
const say = async (sid, text) => { await start(sid, text); await ended(sid); return runs(sid).at(-1); };
const meetMsgs = (sid, run = runs(sid).at(-1)) => S(sid).messages.filter((m) => m.meeting && m.runId === run.id);
const shape = (sid, run) => meetMsgs(sid, run).map((m) => `${m.meeting.phase}${m.meeting.round || ''}`);
const mark = () => sent.length;
const sentFrom = (from, pred = () => true) => sent.slice(from).filter(pred);
const STALL_LINE = '입장이 두 바퀴째 그대로야. 지금 나온 것으로 정하고, 남은 이견을 그대로 적어.';
// 진행자(a)·반대편(o)·참석자 둘(x, y)인 3바퀴 회의와 그 뒤 단계 하나. 진행자가 판정 블록을 내려면 가짜 Claude 여야 한다
async function four(tag, meeting = {}) {
  const a = await mk(`${tag}진행`), o = await mk(`${tag}반대`), x = await mk(`${tag}엑스`), y = await mk(`${tag}와이`), d = await mk(`${tag}다음`, '정리');
  const tm = await mkTeam(`${tag}팀`, [{ label: '회의', agentIds: [a.id, o.id, x.id, y.id], meeting: { rounds: 3, chairId: a.id, opposeId: o.id, ...meeting } }, { label: '다음', agentIds: [d.id] }]);
  return { a, o, x, y, d, tm };
}
const session = async (teamId) => (await t.api('POST', '/api/sessions', { teamId })).json;

test('1. positionOf: 네 언어의 "입장:" 머리로 시작하는 마지막 줄, NFKC·공백·소문자 정리, 없으면 null', () => {
  const rows = [
    ['입장: A안', 'a안'],
    ['- 입장: A안', 'a안'],
    ['* **입장**: A안', 'a안'],
    ['**입장:** A안', 'a안'],
    ['1. 입장: A안', 'a안'],
    ['Position: Plan  A', 'plan a'],
    ['POSITION: plan a', 'plan a'],
    ['- **Position**: Plan A', 'plan a'],
    ['立场：方案A', '方案a'],
    ['立場：案Ａ', '案a'],
    ['Ｐｏｓｉｔｉｏｎ：　Ｐｌａｎ　Ａ', 'plan a'], // 전각 글자·전각 쌍점·전각 공백
    ['입장 : A안', 'a안'],
    ['주장: A안', null],
    ['내 입장: A안', null], // 줄 가운데의 "입장:"은 머리가 아니다
    ['입장:', null], // 값이 없으면 없는 것
    ['입장:   ', null],
    ['', null],
    [null, null],
  ];
  for (const [text, want] of rows) assert.equal(positionOf(text), want, JSON.stringify(text));
  assert.equal(positionOf('입장: A안\n근거: 길어\n입장: B안\n끝 인사'), 'b안', '마지막 입장 줄');
  assert.equal(positionOf('Position: A\n立场：B'), 'b', '언어가 섞여도 마지막 줄');
  assert.equal(positionOf('- 입장: A안 (B의 지적을 보고 바꿈)'), 'a안 (b의 지적을 보고 바꿈)', '바꾼 이유까지 한 값(지어내 자르지 않는다)');
  // 코드 펜스 안의 줄과 두 칸 이상 들여 쓴 줄(하위 목록·코드)은 입장 줄이 아니다
  const fenced = [
    ['```css\n.box {\nposition: absolute;\n}\n```', null],
    ['```yaml\nposition: 3\n```', null],
    ['~~~\nPosition: B\n~~~', null],
    ['입장: A안\n```css\nposition: absolute;\n```', 'a안'],
    ['입장: A안\n```\n입장: B안', 'a안'], // 닫히지 않은 펜스 뒤도 펜스 안
    ['```\n입장: B안\n```\n입장: A안', 'a안'],
    ['- 근거\n  - 입장: B안', null],
    ['입장: A안\n  - Position: B', 'a안'],
    ['입장: A안\n\tposition: 3', 'a안'],
    ['    position: absolute;', null],
    [' 입장: A안', 'a안'], // 한 칸 들여쓰기는 그대로 읽는다
  ];
  for (const [text, want] of fenced) assert.equal(positionOf(text), want, JSON.stringify(text));
});

test('2. 판정 블록의 ask: 질문 한 줄과 보기 2~4개(글 또는 {label, description}). 보기가 1개·5개 이상이거나 질문이 없으면 형식 깨짐', () => {
  const b = (o) => `이건 사용자가 정할 일이야.\n\n\`\`\`oc-verdict\n${JSON.stringify(o)}\n\`\`\``;
  const ok = parseVerdict(b({ verdict: 'ask', reason: '취향 문제', question: '  어느 쪽으로   갈까? ', options: ['A안', { label: 'B안', description: '느리지만 싸다' }, ' '] }));
  assert.equal(ok.verdict, 'ask');
  assert.equal(ok.reason, '취향 문제');
  assert.deepEqual(ok.ask, { questions: [{ header: '', question: '어느 쪽으로 갈까?', options: [{ label: 'A안', description: '' }, { label: 'B안', description: '느리지만 싸다' }], multi: false }] });
  assert.ok(Number.isInteger(ok.from) && ok.to > ok.from);
  assert.equal(parseVerdict(b({ verdict: 'ASK', question: 'q', options: ['1', '2', '3', '4'] })).ask.questions[0].options.length, 4, '대소문자 무시, 4개까지');
  for (const bad of [{ verdict: 'ask', question: 'q', options: ['하나'] }, { verdict: 'ask', question: 'q', options: ['1', '2', '3', '4', '5'] }, { verdict: 'ask', options: ['1', '2'] }, { verdict: 'ask', question: ' ', options: ['1', '2'] }, { verdict: 'ask', question: 'q' }]) {
    assert.deepEqual(parseVerdict(b(bad)), { error: 'shape' }, JSON.stringify(bad));
  }
  assert.equal(parseVerdict(b({ verdict: 'agree', reason: 'r', question: 'q', options: ['1', '2'] })).ask, undefined, 'agree 에 붙은 질문 칸은 읽지 않는다');
  assert.equal(MEET_ASK_MAX, 2);
});

// said 한 줄: { agent: { id }, text, round, phase }
const op = (id, text) => ({ agent: { id }, text, round: 1, phase: 'opinion' });
const tn = (id, text, round = 2) => ({ agent: { id }, text, round, phase: 'turn' });
test('3. stalled: 반대편을 뺀 차례 발언자가 둘 이상이고, 모두 입장 줄이 있고, 모두 앞 바퀴와 같을 때만 정체', () => {
  const base = [op('a', '입장: A안'), op('x', '주장\n입장: A안'), op('y', '입장: B안'), op('o', '입장: C안')];
  const r2 = [tn('o', '입장: A안'), tn('x', '- 입장: A안'), tn('y', '**입장**: B안')];
  assert.equal(stalled({ said: [...base, ...r2], round: 2, ids: ['x', 'y'] }), true, '각자 앞 바퀴와 같으면(서로 달라도) 정체');
  assert.equal(stalled({ said: [...base, ...r2], round: 2, ids: ['x'] }), false, '한 명뿐이면 정체로 안 본다');
  assert.equal(stalled({ said: [...base, tn('o', '입장: A안'), tn('x', '입장: A안'), tn('y', '입장: A안')], round: 2, ids: ['x', 'y'] }), false, '한 명이라도 바뀌면 아니다');
  assert.equal(stalled({ said: [...base, tn('o', '입장: A안'), tn('x', '입장: A안'), tn('y', '그냥 말')], round: 2, ids: ['x', 'y'] }), false, '입장 줄이 없는 사람이 있으면 아니다');
  assert.equal(stalled({ said: [op('a', '입장: A안'), op('x', '입장 없음'), op('y', '입장: B안'), ...r2], round: 2, ids: ['x', 'y'] }), false, '앞 바퀴에 입장 줄이 없어도 아니다');
  assert.equal(stalled({ said: [...base, tn('x', '입장: A안'), tn('y', '입장: B안')].filter((x) => x.agent.id !== 'y' || x.round === 1), round: 2, ids: ['x', 'y'] }), false, '이번 바퀴에 말하지 못한 사람이 있으면 아니다');
  // 3바퀴는 2바퀴 차례와 비교한다(1바퀴 의견이 아니라)
  const r3 = [tn('x', '입장: A안', 3), tn('y', '입장: B안', 3)];
  assert.equal(stalled({ said: [...base, ...r2, ...r3], round: 3, ids: ['x', 'y'] }), true);
  assert.equal(stalled({ said: [...base, tn('x', '입장: Z안'), tn('y', '입장: B안'), ...r3], round: 3, ids: ['x', 'y'] }), false);
  assert.equal(stalled({ said: [...base, ...r2], round: 1, ids: ['x', 'y'] }), false, '1바퀴에는 앞 바퀴가 없다');
  // 그 바퀴에 답이 온 조사가 있으면 정체가 아니다(진행자가 판정에서 새 사실을 본다, 결정 0011). 답을 못 받은 조사·앞 바퀴의 조사는 보지 않는다
  const rs = (round, answered) => ({ agent: { id: 'r' }, text: '조사 결과', round, phase: 'research', question: 'q', ...(answered ? { answered: true } : {}) });
  assert.equal(stalled({ said: [...base, ...r2, rs(2, true)], round: 2, ids: ['x', 'y'] }), false, '이번 바퀴에 조사 답이 왔다');
  assert.equal(stalled({ said: [...base, ...r2, rs(2, false)], round: 2, ids: ['x', 'y'] }), true, '답을 못 받은 조사(확인 못 함)는 새 사실이 아니다');
  assert.equal(stalled({ said: [...base, ...r2, rs(2, true), ...r3], round: 3, ids: ['x', 'y'] }), true, '앞 바퀴의 조사는 그 바퀴의 판정이 봤다');
});

test('4. 보통 회의의 정체: 반대편을 뺀 참석자 둘의 입장이 1바퀴와 그대로면 판정 호출 없이 결론. 결론에 코드의 한 줄, 메시지·단계·대화에 정체 표시', async () => {
  await app();
  const { a, x, y, tm } = await four('정체');
  const s = await session(tm.id);
  const from = mark();
  const run = await say(s.id, 'POSSAME 방향을 정하자');
  assert.equal(run.status, 'done');
  assert.deepEqual(shape(s.id, run), ['opinion1', 'opinion1', 'opinion1', 'opinion1', 'turn2', 'turn2', 'turn2', 'conclude'], '판정 없이 결론(3바퀴도 돌지 않는다)');
  const ps = sentFrom(from);
  assert.equal(ps.filter((p) => p.prompt.includes('[회의 — 판정')).length, 0, '진행자 판정 호출 0');
  assert.ok(ps.filter((p) => p.prompt.includes('[회의 — 의견 내기')).every((p) => p.prompt.includes('- 입장: 지금 미는 안 한 줄(맨 끝 줄로)')), '보통 회의의 의견에도 입장 줄 형식');
  const cc = ps.filter((p) => p.prompt.includes('[회의 — 결론 내기]'));
  assert.equal(cc.length, 1);
  assert.equal(cc[0].id, a.id);
  assert.ok(cc[0].prompt.includes(STALL_LINE), '결론 프롬프트에 코드의 한 줄');
  const concl = meetMsgs(s.id, run).at(-1);
  assert.deepEqual(concl.stall, { round: 2 }, '결론 메시지에 정체 표시');
  assert.deepEqual(run.stages[0].stall, { round: 2 }, '실행 단계에도(흐름 무대의 회의 역)');
  assert.ok(S(s.id).messages.some((m) => m.role === 'system' && m.runId === undefined && m.text.includes('2바퀴') && m.text.includes('정체')), '대화에 한 줄');
  assert.ok(!ps.slice(-1)[0].prompt.includes(STALL_LINE), '다음 단계에는 코드의 줄을 넣지 않는다(결론만)');
  // 2바퀴의 입장이 실제로 앞 바퀴와 같았다(가짜 Claude 의 입장 줄)
  const turns = meetMsgs(s.id, run).filter((m) => m.meeting.phase === 'turn');
  assert.deepEqual(turns.filter((m) => [x.id, y.id].includes(m.agentId)).map((m) => positionOf(m.text)), ['a안', 'a안']);
});

test('5. 정체가 아닌 경우: 입장이 바뀜, 반대편을 빼면 한 명뿐(참석자 2·3명), 입장 줄이 하나라도 없음, 팀 설정으로 끔 → 판정을 한다', async () => {
  await app();
  const judged = (sid, run) => shape(sid, run).includes('judge2');
  const { y, tm } = await four('바뀜');
  let s = await session(tm.id);
  let run = await say(s.id, 'POSMOVE 방향을 정하자');
  assert.ok(judged(s.id, run), '입장이 바뀌면 판정');
  assert.ok(!meetMsgs(s.id, run).some((m) => m.stall) && !run.stages[0].stall);
  s = await session(tm.id);
  run = await say(s.id, `POSSAME POSNONE:${y.name} 방향을 정하자`);
  assert.ok(judged(s.id, run), '입장 줄이 없는 사람이 있으면 정체가 아니다(지어내지 않는다)');
  const a = await mk('둘진행'), o = await mk('둘반대'), x = await mk('셋엑스');
  for (const ids of [[a.id, o.id], [a.id, o.id, x.id]]) {
    const tm2 = await mkTeam(`작은회의${ids.length}`, [{ label: '회의', agentIds: ids, meeting: { rounds: 3, chairId: a.id, opposeId: o.id } }]);
    s = await session(tm2.id);
    run = await say(s.id, 'POSSAME 방향을 정하자');
    assert.ok(judged(s.id, run), `참석자 ${ids.length}명(반대편을 뺀 차례 발언자가 둘 미만)은 정체로 안 본다`);
  }
  const off = await four('끔', { stall: false });
  assert.equal(off.tm.stages[0].meeting.stall, false, '팀 설정에 끈 값이 남는다');
  assert.equal(tm.stages[0].meeting.stall, undefined, '켠 기본값은 적지 않는다(앞 팀과 같은 모양)');
  s = await session(off.tm.id);
  run = await say(s.id, 'POSSAME 방향을 정하자');
  assert.ok(judged(s.id, run), '끄면 정체를 보지 않는다');
  assert.deepEqual(normMeeting({ rounds: 3, stall: false }, ['a', 'b']), { rounds: 3, chairId: 'a', tokenCap: 1000000, opposeId: null, stall: false });
  assert.deepEqual(normMeeting({ rounds: 3, stall: 'no' }, ['a', 'b']), { rounds: 3, chairId: 'a', tokenCap: 1000000, opposeId: null }, 'false 가 아니면 켠 것(적지 않는다)');
});

test('6. 바퀴 상한·사용량 상한·회의 끝내기가 정체보다 먼저: 마지막 바퀴·상한·끝내기로 결론이면 정체 표시 없이', async () => {
  await app();
  const none = (sid, run) => !meetMsgs(sid, run).some((m) => m.stall) && !run.stages[0].stall;
  // 2바퀴 회의: 2바퀴가 마지막이라 판정도 정체 판단도 없다
  let k = await four('두바퀴', { rounds: 2 });
  let s = await session(k.tm.id);
  let from = mark();
  let run = await say(s.id, 'POSSAME 방향을 정하자');
  assert.deepEqual(shape(s.id, run).at(-1), 'conclude');
  assert.ok(none(s.id, run) && !sentFrom(from).some((p) => p.prompt.includes(STALL_LINE)), '바퀴 상한이 먼저');
  // 사용량 상한: 2바퀴 차례 셋이 끝난 순간 닿게(메시지 하나의 양을 먼저 잰다)
  const probe = await mkTeam('재는회의', [{ label: '회의', agentIds: [k.a.id, k.o.id], meeting: { rounds: 1, tokenCap: 0 } }]);
  s = await session(probe.id);
  run = await say(s.id, '한 건을 재자');
  const one = meetingSpend(meetMsgs(s.id, run)[0].usage);
  assert.ok(one > 0);
  k = await four('상한', { tokenCap: Math.floor(one * 6.5) });
  s = await session(k.tm.id);
  from = mark();
  run = await say(s.id, 'POSSAME 방향을 정하자');
  assert.deepEqual(shape(s.id, run), ['opinion1', 'opinion1', 'opinion1', 'opinion1', 'turn2', 'turn2', 'turn2', 'conclude']);
  assert.ok(S(s.id).messages.some((m) => m.role === 'system' && /회의에서 쓴 양\(약 [\d,]+ 토큰\)이 상한/.test(m.text)), '상한 알림');
  assert.ok(none(s.id, run) && !sentFrom(from).some((p) => p.prompt.includes(STALL_LINE)), '사용량 상한이 먼저');
  // 회의 끝내기: 2바퀴 차례 중에 누르면 정체 판단 없이 결론
  k = await four('끝내기');
  s = await session(k.tm.id);
  from = mark();
  await start(s.id, 'POSSAME SLOW 방향을 정하자');
  await t.waitFor(() => runs(s.id).at(-1).stages[0].meetingNow?.phase === 'turn', 20000, '2바퀴 차례');
  assert.equal((await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'conclude' })).json.ok, true);
  await ended(s.id);
  run = runs(s.id).at(-1);
  assert.equal(shape(s.id, run).at(-1), 'conclude');
  assert.ok(none(s.id, run) && !sentFrom(from).some((p) => p.prompt.includes(STALL_LINE)), '끝내기가 먼저');
});

// ── 회의에서 사용자에게 묻기(결정 0028) ──
const ctl = (sid, action, extra = {}) => t.api('POST', `/api/sessions/${sid}/control`, { action, ...extra });
// 지금 열린 회의 질문(판정 메시지에 달린 질문 창 항목) → { m: 판정 메시지, a: 질문 항목 }
const openAsk = (get, sid) => { for (const m of get(sid).messages) for (const a of m.asks || []) if (a.status === 'open') return { m, a }; return null; };
const waitAsk = (sid, get = S) => t.waitFor(() => openAsk(get, sid), 30000, '회의 질문 창');
const Q = 'JUDGEQ 어느 안으로 갈까?';
const DECIDED_HEAD = '[사용자가 정한 것 — 회의에서 물어 사용자가 답함. 이 답대로 해]';
const SKIP_HEAD = '[사용자가 답하지 않은 질문]';
const SKIP_LINE = '사용자가 답하지 않았어. 팀이 정하고 가정을 적어.';
const B_ABOUT = { about: '느리지만 싸다' }; // 가짜 진행자의 보기 B안 설명(에이전트가 쓴 글)
// 사용자의 답이 무작위 표식 밖(지시)에, 질문과 고른 보기의 설명은 표식 안(자료)에 있는가. about: 표식 안에 있어야 할 보기 설명(없으면 그 줄이 없어야 한다)
function decidedIn(p, answer, { q = Q, about = undefined } = {}) {
  const at = p.indexOf(DECIDED_HEAD);
  if (at < 0) return false;
  const body = p.slice(at);
  const m = body.match(/--- 질문 ([0-9a-f]{8}) 시작 ---\n([^\n]*)\n(?:고른 보기의 설명: ([^\n]*)\n)?--- 질문 \1 끝 ---\n사용자의 답: ([^\n]*)/);
  return !!m && m[2] === q && m[3] === about && m[4] === answer;
}
async function three(tag, meeting = {}) {
  const a = await mk(`${tag}진행`), o = await mk(`${tag}반대`), x = await mk(`${tag}참석`), d = await mk(`${tag}다음`, '정리');
  const tm = await mkTeam(`${tag}팀`, [{ label: '회의', agentIds: [a.id, o.id, x.id], meeting: { rounds: 3, chairId: a.id, opposeId: o.id, ...meeting } }, { label: '다음', agentIds: [d.id] }]);
  return { a, o, x, d, tm };
}

test('7. 보통 회의: 진행자가 ask 판정 → 질문 창(번호 보기·직접 쓰기·건너뛰기) → 회의는 멈춤 → 답은 그 실행의 회의 상태에 확정으로, 뒤 차례·결론·다음 단계에 지시로', async () => {
  await app();
  const { a, d, tm } = await three('물음');
  const s = await session(tm.id);
  const from = mark();
  await start(s.id, 'JUDGEQ 방향을 정하자');
  const { m: jm, a: ask } = await waitAsk(s.id);
  const run = runs(s.id).at(-1);
  assert.equal(jm.agentId, a.id, '진행자의 판정 메시지에 단다');
  assert.equal(jm.meeting.phase, 'judge');
  assert.deepEqual(jm.verdict, { verdict: 'ask', reason: '가짜: 팀이 아니라 사용자가 정할 일', question: Q });
  assert.doesNotMatch(jm.text, /oc-verdict/, '읽은 판정 블록은 글에서 지운다');
  assert.equal(ask.meeting, true);
  assert.deepEqual(ask.questions, [{ header: '회의 질문', question: Q, options: [{ label: 'A안 (추천)', description: '' }, { label: 'B안', description: '느리지만 싸다' }], multi: false }]);
  assert.equal(run.status, 'running');
  assert.deepEqual(run.asks.map((x) => x.id), [ask.id]);
  assert.equal(run.stages[0].meetingNow?.phase, 'judge', '회의 역 안에서 기다린다');
  assert.ok(!sentFrom(from).some((p) => p.prompt.includes('[회의 — 차례 발언 (3/3바퀴)]')), '답하기 전에는 3바퀴를 시작하지 않는다');
  const jp = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 판정'));
  assert.equal(jp.length, 1);
  assert.ok(jp[0].prompt.includes('verdict 를 "ask"로 쓰고') && jp[0].prompt.includes('남은 질문: 2번'), '판정 프롬프트에 ask 설명과 남은 질문 수');
  assert.equal((await ctl(s.id, 'answer', { askId: ask.id, answers: [{ picked: [1] }] })).json.ok, true);
  await ended(s.id);
  const done = runs(s.id).at(-1);
  assert.equal(done.status, 'done');
  assert.deepEqual(shape(s.id, done), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'turn2', 'judge2', 'turn3', 'turn3', 'conclude'], '답을 받으면 회의를 이어 간다(계속)');
  assert.equal(done.stages[0].decided.length, 1);
  assert.deepEqual({ ...done.stages[0].decided[0], at: 0 }, { question: Q, answer: 'B안', about: '느리지만 싸다', at: 0 }, '고른 보기의 설명도 남긴다');
  assert.ok(done.stages[0].decided[0].at > 0);
  const after = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 차례 발언 (3/3바퀴)]') || p.prompt.includes('[회의 — 결론 내기]'));
  assert.equal(after.length, 3);
  assert.ok(after.every((p) => decidedIn(p.prompt, 'B안', B_ABOUT)), '뒤 차례와 결론: 사용자의 답은 표식 밖(지시), 질문은 표식 안');
  const next = sentFrom(from).find((p) => p.id === d.id);
  assert.ok(next && decidedIn(next.prompt, 'B안', B_ABOUT), '다음 단계에도 사용자가 정한 것');
  const before = sentFrom(from).filter((p) => p.prompt.includes('(2/3바퀴)'));
  assert.ok(before.length && before.every((p) => !p.prompt.includes(DECIDED_HEAD)), '묻기 전 차례에는 없다');
  const j2 = S(s.id).messages.find((x) => x.id === jm.id);
  assert.match(j2.text, /> ❓ \[회의 질문\] JUDGEQ 어느 안으로 갈까\?\n> 🙋 \*\*B안\*\*/, '질문과 답을 판정 메시지에 남긴다(내보내기·기억)');
  assert.equal(j2.asks[0].status, 'answered');
  // 2바퀴 판정 뒤 3바퀴 판정은 없다(마지막 바퀴). 같은 회의에서 다시 묻지 않는다
  assert.equal(j2.asks.length, 1);
});

test('8. 건너뛰기: "사용자가 답하지 않았어" 한 줄로 회의를 잇고(회의 안에서만), 확정된 것은 남기지 않는다', async () => {
  await app();
  const { d, tm } = await three('넘김');
  const s = await session(tm.id);
  const from = mark();
  await start(s.id, 'JUDGEQ 방향을 정하자');
  const { a: ask } = await waitAsk(s.id);
  assert.equal((await ctl(s.id, 'answer', { askId: ask.id, skip: true })).json.ok, true);
  await ended(s.id);
  const run = runs(s.id).at(-1);
  assert.deepEqual(shape(s.id, run).slice(-3), ['turn3', 'turn3', 'conclude']);
  assert.ok(!run.stages[0].decided?.length, '건너뛴 질문은 확정된 것이 아니다');
  const after = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 차례 발언 (3/3바퀴)]') || p.prompt.includes('[회의 — 결론 내기]'));
  assert.ok(after.length === 3 && after.every((p) => p.prompt.includes(SKIP_HEAD) && p.prompt.includes(SKIP_LINE) && !p.prompt.includes(DECIDED_HEAD)));
  const next = sentFrom(from).find((p) => p.id === d.id);
  assert.ok(!next.prompt.includes(SKIP_HEAD), '다음 단계에는 넣지 않는다(회의의 결론으로 넘어간다)');
});

test('9. 형식이 깨진 ask(보기 하나·다섯 개)는 질문 창을 띄우지 않고 "계속"으로 본다', async () => {
  await app();
  const { tm } = await three('깨짐');
  for (const sig of ['JUDGEQBAD', 'JUDGEQ5']) {
    const s = await session(tm.id);
    const run = await say(s.id, `${sig} 방향을 정하자`);
    assert.equal(run.status, 'done');
    assert.deepEqual(shape(s.id, run).slice(-4), ['judge2', 'turn3', 'turn3', 'conclude'], sig);
    const j = meetMsgs(s.id, run).find((m) => m.meeting.phase === 'judge');
    assert.ok(!j.asks?.length && !j.verdict, '질문 창도 판정도 없다');
    assert.ok(j.blocks.some((b) => b.kind === 'notice' && b.text === '판정 형식이 맞지 않아서 "계속"으로 봤어.'));
    assert.match(j.text, /```oc-verdict/, '못 읽은 블록은 글로 남긴다');
  }
});

test('10. 질문 상한: 한 회의(다시 하기 포함)에서 2번까지. 넘으면 ask 를 "계속"으로 보고 알림 한 줄, 판정 프롬프트에서도 ask 설명을 뺀다', async () => {
  await app();
  const { tm } = await three('상한', {});
  // 승인 관문이 있는 회의 단계: 거절하면 회의를 다시 돈다(같은 회의의 다시 하기)
  const team = (await t.api('PUT', `/api/teams/${tm.id}`, { ...tm, stages: [{ ...tm.stages[0], approve: true }, tm.stages[1]] })).json;
  assert.equal(team.stages[0].approve, true);
  const s = await session(tm.id);
  const from = mark();
  await start(s.id, 'JUDGEQMORE 방향을 정하자');
  for (const pick of [0, 1]) {
    const { a: ask } = await waitAsk(s.id);
    await ctl(s.id, 'answer', { askId: ask.id, answers: [{ picked: [pick] }] });
    await t.waitFor(() => runs(s.id).at(-1).hold?.reason === 'approve', 30000, '승인 대기');
    await ctl(s.id, 'reject', { text: '다시 해 줘' });
    await t.waitFor(() => !runs(s.id).at(-1).hold, 10000, '다시 시작');
  }
  await t.waitFor(() => runs(s.id).at(-1).hold?.reason === 'approve', 30000, '세 번째 승인 대기');
  const run = runs(s.id).at(-1);
  const judges = S(s.id).messages.filter((m) => m.runId === run.id && m.meeting?.phase === 'judge');
  assert.equal(judges.length, 3);
  assert.deepEqual(judges.map((j) => (j.asks || []).length), [1, 1, 0], '세 번째는 질문 창을 띄우지 않는다');
  assert.ok(judges[2].blocks.some((b) => b.kind === 'notice' && b.text === `회의 질문 상한(2번)을 넘어서 진행자의 질문을 "계속"으로 봤어. 질문: ${Q}`), '물으려 했다는 것과 질문 글은 알림에');
  // 묻지 않은 판정은 판정 값도 "계속"(화면의 "사용자에게 물음" 칩은 실제로 물은 판정에만)
  assert.deepEqual(judges.map((j) => j.verdict?.verdict), ['ask', 'ask', 'continue']);
  assert.equal(judges[2].verdict.question, undefined);
  assert.deepEqual(run.stages[0].decided.map((x) => x.answer), ['A안 (추천)', 'B안'], '다시 하기에도 앞에서 정한 것은 남는다');
  const jp = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 판정'));
  assert.deepEqual(jp.map((p) => (p.prompt.match(/남은 질문: (\d)번/) || [])[1] || null), ['2', '1', null], '남은 질문 수, 다 쓰면 설명을 뺀다');
  assert.ok(decidedIn(jp[2].prompt, 'A안 (추천)'), '세 번째 시도의 판정에도 앞에서 정한 것');
  await ctl(s.id, 'approve');
  await ended(s.id);
});

// ── 목표 회의(결정 0017의 준비 회의·목표 안 팀 회의 단계) ──
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides });
// 요청 → 목표 카드 → 확인. prep: 'meeting'(준비 회의만) | null(조사·회의 없이). work: 'stages' | 'cards'. h: 따로 켠 앱(끊김 흉내)
async function goal(teamId, request, { prep = null, work = 'stages', h = null } = {}) {
  const api = h ? h.api : t.api;
  const get = h ? h.S : S;
  const s = (await api('POST', '/api/sessions', { teamId })).json;
  assert.equal((await api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await api('POST', `/api/sessions/${s.id}/messages`, { text: request });
  await t.waitFor(() => get(s.id).mission?.status === 'draft' && !(h ? h.app : t.app).orch.ctx.has(s.id), 20000, '목표 카드');
  const c = get(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const pb = prep === 'meeting' ? { research: false, meeting: true, lead: c.prep.lead.id, researchers: c.prep.research.who.map((w) => w.id), attendees: c.prep.meeting.who.map((w) => w.id) } : { research: false, meeting: false };
  const r = await api('POST', `/api/sessions/${s.id}/mission/confirm`, { missionId: get(s.id).mission.id, expected: shown(c), review, prep: pb, work });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return s.id;
}
const goalDone = (sid, get = S, isIdle = idle) => t.waitFor(() => isIdle(sid) && !['active', 'waiting'].includes(get(sid).mission.status), 60000, '목표 끝').catch((e) => {
  const s = get(sid);
  throw new Error(`${e.message}: ${JSON.stringify({ status: s.mission?.status, hold: s.runs.at(-1)?.hold || null, log: (s.mission?.log || []).slice(-4).map((x) => x.text) })}`);
});
// 목표 안 팀 회의 단계: 진행자(분석, 목표의 진행자) a, 반대편 o, 참석자 x·y(정리) → 빌드 b. 검수자는 진행자도 마지막 일 단계 담당도 아닌 첫 팀원
async function goalTeam(tag) {
  const a = await mk(`${tag}진행`, '분석'), o = await mk(`${tag}반대`, '정리'), x = await mk(`${tag}엑스`, '정리'), y = await mk(`${tag}와이`, '정리'), b = await mk(`${tag}빌드`, '빌드');
  const tm = await mkTeam(`${tag}팀`, [{ label: '회의', agentIds: [a.id, o.id, x.id, y.id], meeting: { rounds: 3, chairId: a.id, opposeId: o.id } }, { label: '빌드', agentIds: [b.id] }]);
  return { a, o, x, y, b, tm };
}

test('11. 목표 회의의 정체: 1바퀴 뒤 판정(반대편 포함)이 갈려 차례를 돌고, 2바퀴에 반대편을 뺀 입장이 그대로면 판정 없이 결론. 진행 기록에 stall 줄', async () => {
  await app();
  const { o, tm } = await goalTeam('목정');
  const from = mark();
  const sid = await goal(tm.id, `POSSAME STANCEB:${o.name} 정해 줘`);
  await goalDone(sid);
  const m = S(sid).mission;
  assert.equal(m.status, 'done');
  const run = S(sid).runs.findLast((r) => r.mission === 'work');
  assert.deepEqual(shape(sid, run), ['opinion1', 'opinion1', 'opinion1', 'opinion1', 'judge1', 'turn2', 'turn2', 'turn2', 'conclude'], '1바퀴 뒤 판정 하나, 차례 뒤 판정은 없다');
  const line = m.log.find((x) => x.kind === 'stall');
  assert.ok(line && line.text.includes('"회의" 단계: 2바퀴') && line.text.includes('정체'));
  assert.deepEqual(line.stall, { round: 2 });
  assert.deepEqual(meetMsgs(sid, run).at(-1).stall, { round: 2 });
  assert.ok(sentFrom(from).some((p) => p.prompt.includes('[회의 — 결론 내기]') && p.prompt.includes(STALL_LINE)));
});

test('12. 목표 회의에서 묻기: 1바퀴 뒤 판정이 ask → 답은 mission.decided(확정)와 사용자 선택 줄로, 뒤 차례·결론·일 단계·검수 프롬프트에 지시로. 완주 보고의 "사용자가 고른 것"', async () => {
  await app();
  const { tm, b } = await goalTeam('목물');
  const from = mark();
  const sid = await goal(tm.id, 'JUDGEQ 정해 줘');
  const { m: jm, a: ask } = await waitAsk(sid);
  assert.equal(jm.meeting.phase, 'judge');
  assert.equal(jm.meeting.round, 1, '1바퀴 뒤 판정에서 물었다');
  assert.equal(S(sid).mission.status, 'active', '목표는 도는 중(질문 창은 실행의 질문)');
  assert.deepEqual(S(sid).mission.meetAsk && { stageIndex: S(sid).mission.meetAsk.stageIndex, msgId: S(sid).mission.meetAsk.msgId }, { stageIndex: 0, msgId: jm.id }, '끊겨도 다시 물을 수 있게 적어 둔다');
  await ctl(sid, 'answer', { askId: ask.id, answers: [{ picked: [0] }] });
  await goalDone(sid);
  const m = S(sid).mission;
  assert.equal(m.status, 'done');
  assert.equal(m.meetAsk, undefined, '답하면 지운다');
  assert.deepEqual(m.decided.map((x) => ({ ...x, at: 0 })), [{ question: Q, answer: 'A안 (추천)', at: 0, stageIndex: 0 }]);
  const userLines = m.log.filter((x) => x.by === 'user' && x.kind === 'answer');
  assert.ok(userLines.some((x) => x.text === `회의 질문에 답했어: ${Q} → A안 (추천)` && x.msgId === jm.id), '사용자 선택 표시(완주 보고가 이 줄로 고른 것을 센다)');
  assert.ok(m.log.some((x) => x.kind === 'ask' && x.text.includes('진행자가 사용자에게 물었어')));
  assert.ok(m.log.some((x) => x.kind === 'note' && x.text.includes('1바퀴 뒤 판정에서 사용자에게 물었어')));
  const run = S(sid).runs.findLast((r) => r.mission === 'work');
  assert.deepEqual(shape(sid, run).slice(0, 6), ['opinion1', 'opinion1', 'opinion1', 'opinion1', 'judge1', 'turn2'], '답을 받으면 차례 바퀴를 한다');
  const ps = sentFrom(from);
  const later = ps.filter((p) => /\[회의 — (차례 발언|판정 \(2|결론 내기)/.test(p.prompt));
  assert.ok(later.length >= 4 && later.every((p) => decidedIn(p.prompt, 'A안 (추천)')), '뒤 차례·판정·결론');
  const work = ps.find((p) => p.id === b.id && p.prompt.includes('"빌드"를 네가 맡았어'));
  assert.ok(work && decidedIn(work.prompt, 'A안 (추천)'), '일 단계');
  const rv = ps.find((p) => p.prompt.includes('[기준 판정 — 1번째 검수]'));
  assert.ok(rv && decidedIn(rv.prompt, 'A안 (추천)'), '검수');
  const report = S(sid).messages.find((x) => x.id === m.reportMsgId);
  assert.ok(report.user.some((x) => x.text === `회의 질문에 답했어: ${Q} → A안 (추천)`), '완주 보고의 사용자가 고른 것');
});

test('13. 일 카드 목표의 준비 회의에서 물은 답은 계획·일 카드 프롬프트에도 지시로 들어간다', async () => {
  await app();
  const a = await mk('카묻진행', '분석'), p = await mk('카묻정리', '정리'), q = await mk('카묻기록', '정리'), b = await mk('카묻빌드', '빌드');
  const tm = await mkTeam('카묻팀', [{ label: '분석', agentIds: [a.id] }, { label: '정리', agentIds: [p.id, q.id] }, { label: '빌드', agentIds: [b.id] }]);
  const from = mark();
  const sid = await goal(tm.id, 'JUDGEQ 정해 줘', { prep: 'meeting', work: 'cards' });
  const { a: ask } = await waitAsk(sid);
  await ctl(sid, 'answer', { askId: ask.id, answers: [{ picked: [], other: '직접 정한 길' }] });
  await goalDone(sid);
  const m = S(sid).mission;
  assert.deepEqual(m.decided.map((x) => [x.answer, x.prep]), [['직접 입력: 직접 정한 길', true]], '준비 회의의 답(직접 쓴 답)');
  const ps = sentFrom(from);
  const plan = ps.find((x) => /^\[일 계획\]$/m.test(x.prompt));
  assert.ok(plan && decidedIn(plan.prompt, '직접 입력: 직접 정한 길'), '계획');
  const cards = ps.filter((x) => /^\[일 카드 k\d+\]$/m.test(x.prompt));
  assert.ok(cards.length && cards.every((x) => decidedIn(x.prompt, '직접 입력: 직접 정한 길')), '일 카드');
});

// 같은 데이터 폴더로 앱을 새로 만든다(켜기·다시 켜기. mission-prep 과 같은 방식)
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
// 앱이 꺼진 모양: 세션 파일에 회의 질문(meetAsk)이 저장되기를 기다린 뒤 디스크를 얼리고 앱을 닫고 다시 켠다
async function crash(h, sid) {
  const file = path.join(h.app.store.dirs.sessions, `${sid}.json`);
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  await t.waitFor(() => read()?.mission?.meetAsk && read().messages.some((m) => (m.asks || []).some((a) => a.status === 'open')), 5000, '디스크에 회의 질문');
  h.app.store.closed = true;
  h.app.store.close = () => {};
  await h.app.close();
  return reopen();
}

test('14. 질문 중에 끊기면(앱 꺼짐) 이어서 할 때 호출 없이 같은 질문을 다시 묻고, 답한 것은 decided 에 남아 1바퀴부터 다시 도는 회의의 프롬프트에 들어간다', async () => {
  await app();
  const { tm } = await goalTeam('목끊');
  const h1 = await reopen();
  const sid = await goal(tm.id, 'JUDGEQ 정해 줘', { h: h1 });
  await t.waitFor(() => openAsk(h1.S, sid), 30000, '첫 질문');
  const h2 = await crash(h1, sid);
  const m0 = h2.S(sid).mission;
  assert.equal(m0.status, 'cut');
  assert.ok(m0.meetAsk?.questions?.[0]?.question === Q, '끊긴 자리와 함께 질문을 남겨 둔다');
  assert.equal(openAsk(h2.S, sid), null, '다시 켜면 열린 질문은 닫힌다(결정 0009)');
  const from = mark();
  const r = await h2.api('POST', `/api/sessions/${sid}/mission/resume`, { missionId: m0.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const { m: jm, a: ask } = await t.waitFor(() => openAsk(h2.S, sid), 20000, '다시 띄운 질문');
  const run = h2.S(sid).runs.at(-1);
  assert.equal(sent.length, from, '다시 묻는 데 AI 를 부르지 않았다');
  assert.notEqual(jm.runId, run.id, '끊기기 전 판정 메시지에 단다');
  assert.deepEqual([ask.runId, ask.stageIndex, ask.meeting], [run.id, 0, true], '지금 실행·단계를 항목에 적는다');
  // 흐름 무대: 이 질문은 지금 실행의 회의 역 안의 문
  const sm = stageModel({ run, mission: h2.S(sid).mission, questions: openQuestions(h2.S(sid).messages), agents: t.app.store.all('agents') });
  assert.deepEqual([sm.ask?.kind, sm.ask?.station, sm.stations.find((x) => x.i === 0)?.ask], ['question', 0, true]);
  assert.ok(h2.S(sid).mission.log.some((x) => x.text === '이어서: 끊기기 전에 회의에서 묻던 질문을 다시 띄워(AI 호출 없음).'));
  await h2.api('POST', `/api/sessions/${sid}/control`, { action: 'answer', askId: ask.id, answers: [{ picked: [1] }] });
  await goalDone(sid, h2.S, h2.idle);
  const m = h2.S(sid).mission;
  assert.equal(m.status, 'done');
  assert.deepEqual(m.decided.map((x) => x.answer), ['B안']);
  const op = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 의견 내기 (1/3바퀴)]'));
  assert.equal(op.length, 4, '회의는 1바퀴부터 다시');
  assert.ok(op.every((p) => decidedIn(p.prompt, 'B안', B_ABOUT)), '1바퀴 의견부터 사용자가 정한 것이 들어간다');
  assert.equal(h2.S(sid).messages.filter((x) => (x.asks || []).some((a) => a.meeting)).length, 1, '1바퀴 뒤 판정은 이미 답이 있어 다시 묻지 않는다(가짜 진행자)');
});

// 긴 세션: 앞 대화 n개를 세션에 바로 넣는다(사용자·에이전트 번갈아. prompt-assembly 와 같은 방식)
function makeLong(sid, agentId, n = 24) {
  const ss = S(sid);
  const t0 = Date.now() - n * 1000;
  for (let k = 0; k < n; k++) {
    const user = k % 2 === 0;
    ss.messages.push({ id: `old${sid}${k}`, role: user ? 'user' : 'agent', ...(user ? {} : { agentId, provider: 'claude' }), text: user ? `LONGQ${k} 이야기` : `LONGA${k} 답`, status: 'done', attachments: [], blocks: [], createdAt: t0 + k * 1000, runId: `oldrun${Math.floor(k / 2)}` });
  }
  t.app.store.saveSession(ss);
}

test('15. 긴 세션의 새 대화 회의(결정 0023)에서도 정체와 묻기가 돈다', async () => {
  await app();
  const k4 = await four('긴정체');
  let s = await session(k4.tm.id);
  makeLong(s.id, k4.a.id);
  let run = await say(s.id, 'POSSAME 방향을 정하자');
  let mm = meetMsgs(s.id, run);
  assert.ok(mm.every((m) => m.once && m.freshMeet), '새 대화 한 번으로 돈 차례');
  assert.deepEqual(shape(s.id, run), ['opinion1', 'opinion1', 'opinion1', 'opinion1', 'turn2', 'turn2', 'turn2', 'conclude']);
  assert.deepEqual(mm.at(-1).stall, { round: 2 });
  const k3 = await three('긴물음');
  s = await session(k3.tm.id);
  makeLong(s.id, k3.a.id);
  const from = mark();
  await start(s.id, 'JUDGEQ 방향을 정하자');
  const { a: ask } = await waitAsk(s.id);
  await ctl(s.id, 'answer', { askId: ask.id, answers: [{ picked: [1] }] });
  await ended(s.id);
  run = runs(s.id).at(-1);
  mm = meetMsgs(s.id, run);
  assert.ok(mm.every((m) => m.once && m.freshMeet));
  assert.deepEqual(run.stages[0].decided.map((x) => x.answer), ['B안']);
  const later = sentFrom(from).filter((p) => p.prompt.includes('(3/3바퀴)]') || p.prompt.includes('[회의 — 결론 내기]'));
  assert.ok(later.length === 3 && later.every((p) => !p.resumed && decidedIn(p.prompt, 'B안', B_ABOUT)));
});

test('16. 정체와 조사가 겹치면: 그 바퀴에 조사 답이 왔으면 정체로 끊지 않고 진행자가 판정에서 조사 결과를 본다(결정 0011). 조사가 답을 못 받았으면 정체', async () => {
  await app();
  // 팀에 조사 역할이 있어야 회의 중 조사가 돈다(뒤 단계 담당을 조사 역할로)
  const a = await mk('정조진행'), o = await mk('정조반대'), x = await mk('정조엑스'), y = await mk('정조와이'), r = await mk('정조조사', '조사');
  const tm = await mkTeam('정조팀', [{ label: '회의', agentIds: [a.id, o.id, x.id, y.id], meeting: { rounds: 3, chairId: a.id, opposeId: o.id } }, { label: '조사', agentIds: [r.id] }]);
  let s = await session(tm.id);
  let from = mark();
  let run = await say(s.id, 'POSSAME CHECKME 방향을 정하자');
  // 2바퀴 차례 셋이 모두 질문 블록을 붙여 조사가 세 번 답해 온다(회의 한 번에 3번까지) → 판정. 3바퀴는 조사 횟수를 다 써서 조사 없이
  assert.deepEqual(shape(s.id, run), ['opinion1', 'opinion1', 'opinion1', 'opinion1', 'turn2', 'research2', 'turn2', 'research2', 'turn2', 'research2', 'judge2', 'turn3', 'turn3', 'turn3', 'conclude']);
  let mm = meetMsgs(s.id, run);
  assert.ok(mm.filter((m) => m.meeting.phase === 'turn' && m.meeting.round === 2).every((m) => m.check?.status === 'answered'), '질문 블록이 답 끝이라 읽혔다');
  // 입장은 앞 바퀴와 그대로였다(조사가 없었으면 정체)
  assert.deepEqual(mm.filter((m) => m.meeting.phase === 'turn' && m.meeting.round === 2 && [x.id, y.id].includes(m.agentId)).map((m) => positionOf(m.text)), ['a안', 'a안']);
  assert.ok(!mm.some((m) => m.stall) && !run.stages[0].stall, '정체 표시 없음');
  const jp = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 판정 (2/3바퀴)]'));
  assert.ok(jp.length === 1 && jp[0].prompt.includes('가짜 조사: 비용은 한 달 10만 원이야'), '진행자가 판정에서 조사 결과를 본다');
  // 조사가 실패하면(답이 오지 않음) 새 사실이 없으니 정체
  s = await session(tm.id);
  from = mark();
  run = await say(s.id, 'POSSAME CHECKME RESEARCHFAIL 방향을 정하자');
  mm = meetMsgs(s.id, run);
  assert.ok(!shape(s.id, run).includes('judge2'), '판정 없이 결론');
  assert.ok(mm.filter((m) => m.meeting.phase === 'turn').every((m) => m.check?.status === 'failed'));
  assert.deepEqual(mm.at(-1).stall, { round: 2 });
});

test('17. 질문 중 조작: 회의 끝내기(넘긴 것으로 닫고 결론), 중지(질문 취소, 결론 없음), 진행자 건너뛰기(넘긴 것으로 보고 회의를 잇는다), 일시정지(답한 뒤 다음 차례 전에 멈춤)', async () => {
  await app();
  const { a, tm } = await three('조작');
  const judgeOf = (sid, run) => meetMsgs(sid, run).find((m) => m.meeting.phase === 'judge');
  // 회의 끝내기: 질문은 넘긴 것으로 닫히고(확정 없음) 3바퀴 없이 결론, 결론에는 답하지 않은 질문
  let s = await session(tm.id);
  let from = mark();
  await start(s.id, 'JUDGEQ 방향을 정하자');
  await waitAsk(s.id);
  assert.equal((await ctl(s.id, 'conclude')).json.ok, true);
  await ended(s.id);
  let run = runs(s.id).at(-1);
  assert.equal(run.status, 'done');
  assert.deepEqual(shape(s.id, run).slice(-2), ['judge2', 'conclude'], '3바퀴 없이 결론');
  assert.equal(judgeOf(s.id, run).asks[0].status, 'cancelled');
  assert.ok(!run.stages[0].decided?.length);
  let cc = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 결론 내기]'));
  assert.ok(cc.length === 1 && cc[0].prompt.includes(SKIP_HEAD) && cc[0].prompt.includes(Q) && !cc[0].prompt.includes(DECIDED_HEAD));
  // 중지: 질문을 취소하고 결론 없이 끝
  s = await session(tm.id);
  await start(s.id, 'JUDGEQ 방향을 정하자');
  await waitAsk(s.id);
  await ctl(s.id, 'stop');
  await ended(s.id);
  run = runs(s.id).at(-1);
  assert.equal(run.status, 'stopped');
  assert.equal(judgeOf(s.id, run).asks[0].status, 'cancelled');
  assert.ok(!meetMsgs(s.id, run).some((m) => m.meeting.phase === 'conclude' || m.meeting.round === 3), '중지 뒤에는 차례도 결론도 없다');
  // 진행자 건너뛰기: 질문만 넘긴 것으로 닫고, 진행자의 결론 차례는 그대로
  s = await session(tm.id);
  from = mark();
  await start(s.id, 'JUDGEQ 방향을 정하자');
  await waitAsk(s.id);
  assert.equal((await ctl(s.id, 'skip', { agentId: a.id })).json.ok, true);
  await ended(s.id);
  run = runs(s.id).at(-1);
  assert.equal(run.status, 'done');
  assert.deepEqual(shape(s.id, run).slice(-4), ['judge2', 'turn3', 'turn3', 'conclude']);
  const concl = meetMsgs(s.id, run).at(-1);
  assert.ok(concl.agentId === a.id && concl.status === 'done', '진행자가 결론을 냈다');
  assert.equal(judgeOf(s.id, run).asks[0].status, 'cancelled');
  assert.ok(sentFrom(from).filter((p) => p.prompt.includes('(3/3바퀴)]')).every((p) => p.prompt.includes(SKIP_HEAD)));
  // 일시정지: 질문 중에 눌러 두면 답한 뒤 3바퀴 전에 멈추고, 이어 가면 끝까지
  s = await session(tm.id);
  from = mark();
  await start(s.id, 'JUDGEQ 방향을 정하자');
  const { a: ask } = await waitAsk(s.id);
  assert.equal((await ctl(s.id, 'pause')).json.ok, true);
  await ctl(s.id, 'answer', { askId: ask.id, answers: [{ picked: [0] }] });
  await t.waitFor(() => runs(s.id).at(-1).status === 'paused', 10000, '일시정지');
  assert.ok(!sentFrom(from).some((p) => p.prompt.includes('(3/3바퀴)]')), '멈춘 동안 3바퀴를 시작하지 않는다');
  await ctl(s.id, 'resume');
  await ended(s.id);
  run = runs(s.id).at(-1);
  assert.equal(run.status, 'done');
  assert.deepEqual(shape(s.id, run).slice(-4), ['judge2', 'turn3', 'turn3', 'conclude']);
  assert.deepEqual(run.stages[0].decided.map((x) => x.answer), ['A안 (추천)']);
});

test('18. 물을 수 없는 실행(묻기 설정 끔·예약 실행): 판정·결론 프롬프트에 묻기 안내가 없고, 진행자의 ask 는 "계속"(판정 값도 continue, 알림에 질문 글), 결론 끝의 ask 블록은 읽지 않는다', async () => {
  await app();
  const { tm } = await three('못물음');
  for (const how of ['setting', 'schedule']) {
    const s = await session(tm.id);
    const was = t.app.store.settings.agentAsks;
    if (how === 'setting') t.app.store.settings.agentAsks = false;
    else S(s.id).scheduleId = 'sched-test'; // 예약 실행이 만든 세션처럼
    try {
      const from = mark();
      const run = await say(s.id, 'JUDGEQ CONCLUDEQ 방향을 정하자');
      assert.equal(run.status, 'done', how);
      assert.deepEqual(shape(s.id, run), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'turn2', 'judge2', 'turn3', 'turn3', 'conclude'], how);
      const mm = meetMsgs(s.id, run);
      const j = mm.find((m) => m.meeting.phase === 'judge');
      assert.deepEqual(j.verdict, { verdict: 'continue', reason: '가짜: 팀이 아니라 사용자가 정할 일' }, `${how}: 묻지 않았으니 판정 값은 계속`);
      assert.ok(!j.asks?.length);
      assert.ok(j.blocks.some((b) => b.kind === 'notice' && b.text === `이 실행은 사용자에게 물을 수 없어서 진행자의 질문을 "계속"으로 봤어. 질문: ${Q}`), how);
      const ps = sentFrom(from);
      assert.ok(ps.filter((p) => p.prompt.includes('[회의 — 판정')).every((p) => !p.prompt.includes('verdict 를 "ask"로 쓰고')), `${how}: 판정 프롬프트에 묻기 안내 없음`);
      const cc = ps.filter((p) => p.prompt.includes('[회의 — 결론 내기]'));
      assert.ok(cc.length === 1 && !cc[0].prompt.includes('결론 대신 이유 한두 문장'), `${how}: 결론 프롬프트에 묻기 안내 없음`);
      const c = mm.at(-1);
      assert.ok(c.meeting.phase === 'conclude' && !c.asks?.length && !c.verdict && c.text.includes('```oc-verdict'), `${how}: 안내하지 않은 결론의 블록은 읽지 않고 글로 둔다`);
      assert.ok(!run.stages[0].decided?.length);
    } finally { t.app.store.settings.agentAsks = was; }
  }
});

test('19. 끊긴 뒤 이어서: 다시 띄운 질문 중의 "회의 끝내기"는 거절(질문은 그대로, 화면은 버튼을 감춘다). 질문 상한은 끊기기 전 질문부터 이어서 센다', async () => {
  await app();
  const { tm } = await goalTeam('목상한');
  const h1 = await reopen();
  const sid = await goal(tm.id, 'JUDGEQMORE 정해 줘', { h: h1 });
  await t.waitFor(() => openAsk(h1.S, sid), 30000, '첫 질문');
  const h2 = await crash(h1, sid);
  const m0 = h2.S(sid).mission;
  const from = mark();
  assert.equal((await h2.api('POST', `/api/sessions/${sid}/mission/resume`, { missionId: m0.id })).status, 200);
  const { m: jm, a: ask } = await t.waitFor(() => openAsk(h2.S, sid), 20000, '다시 띄운 질문');
  const run = h2.S(sid).runs.at(-1);
  assert.equal(run.stages[0].meetingNow?.again, true, '아직 의견이 없는 회의(화면은 회의 끝내기 버튼을 감춘다)');
  const r = await h2.api('POST', `/api/sessions/${sid}/control`, { action: 'conclude' });
  assert.deepEqual(r.json, { ok: false, reason: '이 회의는 아직 나온 의견이 없어서 끝낼 수 없어. 질문에 답하거나 넘기면 1바퀴부터 시작해.' });
  assert.equal(openAsk(h2.S, sid)?.a.id, ask.id, '질문은 그대로 열려 있다');
  await h2.api('POST', `/api/sessions/${sid}/control`, { action: 'answer', askId: ask.id, answers: [{ picked: [0] }] });
  // 1바퀴부터 다시 도는 회의의 1바퀴 뒤 판정: 끊기기 전 질문(그 판정 메시지) 하나를 세어 남은 질문 1번 → 묻는다
  const second = await t.waitFor(() => { const o = openAsk(h2.S, sid); return o && o.m.id !== jm.id ? o : null; }, 30000, '두 번째 질문');
  assert.equal(second.m.runId, run.id);
  await h2.api('POST', `/api/sessions/${sid}/control`, { action: 'answer', askId: second.a.id, answers: [{ picked: [1] }] });
  await goalDone(sid, h2.S, h2.idle);
  const m = h2.S(sid).mission;
  assert.equal(m.status, 'done');
  assert.deepEqual(m.decided.map((x) => x.answer), ['A안 (추천)', 'B안']);
  const jp = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 판정'));
  assert.deepEqual(jp.map((p) => (p.prompt.match(/남은 질문: (\d)번/) || [])[1] || null), ['1', null], '끊기기 전 질문까지 세어 남은 수가 준다');
  const judges = h2.S(sid).messages.filter((x) => x.runId === run.id && x.meeting?.phase === 'judge');
  assert.deepEqual(judges.map((j) => j.verdict?.verdict), ['ask', 'continue'], '이어서 한 뒤 두 번째 판정은 상한이라 계속');
  assert.ok(judges[1].blocks.some((b) => b.kind === 'notice' && b.text === `회의 질문 상한(2번)을 넘어서 진행자의 질문을 "계속"으로 봤어. 질문: ${Q}`));
  const cc = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 결론 내기]'));
  assert.ok(cc.length === 1 && !cc[0].prompt.includes('결론 대신 이유 한두 문장'), '결론에도 묻기 안내가 없다(상한)');
});

// ── 결론에서 묻기(결정 0028): 결론 차례의 진행자가 결론 대신 ask 판정 블록 → 질문 창 → 결론을 한 번 다시 ──
const CQ = 'CONCLUDEQ 어느 쪽으로 정할까?';
const ASK_LINE = '결론 대신 이유 한두 문장을 쓰고 답 맨 끝에 아래 블록 하나만 써(보기 2~4개).';
test('20. 기본 2바퀴 보통 회의도 결론에서 묻는다: 그 답은 판정(ask) 메시지가 되고(결론·게시판으로 안 읽힘), 답·넘기기 뒤 결론을 한 번 다시(묻기 안내 없이). 정체로 간 결론도 같은 길', async () => {
  await app();
  const { a, d, tm } = await three('결물', { rounds: 2 });
  let s = await session(tm.id);
  let from = mark();
  await start(s.id, 'CONCLUDEQ 방향을 정하자');
  const { m: qm, a: ask } = await waitAsk(s.id);
  assert.equal(qm.agentId, a.id);
  assert.deepEqual([qm.meeting.phase, qm.meeting.round], ['judge', 2], '결론 대신 물은 답은 판정 메시지로');
  assert.deepEqual(qm.verdict, { verdict: 'ask', reason: '가짜: 결론을 바꿀 사용자 결정', question: CQ });
  assert.doesNotMatch(qm.text, /oc-verdict/);
  assert.equal(ask.meeting, true);
  assert.equal(runs(s.id).at(-1).stages[0].meetingNow?.phase, 'judge', '묻는 동안은 판정에서 물을 때와 같다');
  assert.deepEqual(boardCards(S(s.id).messages).map((c) => c.id).filter((id) => id === qm.id), [], '마을 게시판의 결론 카드가 아니다');
  await ctl(s.id, 'answer', { askId: ask.id, answers: [{ picked: [1] }] });
  await ended(s.id);
  let run = runs(s.id).at(-1);
  assert.equal(run.status, 'done');
  assert.deepEqual(shape(s.id, run), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'turn2', 'judge2', 'conclude']);
  let cc = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 결론 내기]'));
  assert.equal(cc.length, 2, '결론 차례를 한 번 다시');
  assert.ok(cc[0].prompt.includes(ASK_LINE) && cc[0].prompt.includes('남은 질문: 2번') && cc[0].prompt.includes('"verdict":"ask"'), '첫 결론에 묻기 안내와 블록 꼴');
  assert.ok(!cc[1].prompt.includes(ASK_LINE) && decidedIn(cc[1].prompt, 'B안', { q: CQ, about: '느리지만 싸다' }), '다시 쓰는 결론: 묻기 안내 없이 사용자가 정한 것');
  assert.deepEqual(run.stages[0].decided.map((x) => [x.question, x.answer, x.about]), [[CQ, 'B안', '느리지만 싸다']]);
  const concl = meetMsgs(s.id, run).at(-1);
  assert.ok(concl.status === 'done' && !concl.text.includes('이건 사용자가 정할 일이야'));
  assert.deepEqual(boardCards(S(s.id).messages).map((c) => c.id).filter((id) => [qm.id, concl.id].includes(id)), [concl.id], '게시판에는 다시 쓴 결론만');
  const next = sentFrom(from).find((p) => p.id === d.id);
  assert.ok(next && !next.prompt.includes('이건 사용자가 정할 일이야') && decidedIn(next.prompt, 'B안', { q: CQ, about: '느리지만 싸다' }), '다음 단계는 다시 쓴 결론과 정한 것을 받는다');
  // 넘기기: 다시 쓰는 결론에 답하지 않은 질문
  s = await session(tm.id);
  from = mark();
  await start(s.id, 'CONCLUDEQ 방향을 정하자');
  const { a: ask2 } = await waitAsk(s.id);
  await ctl(s.id, 'answer', { askId: ask2.id, skip: true });
  await ended(s.id);
  run = runs(s.id).at(-1);
  assert.equal(run.status, 'done');
  cc = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 결론 내기]'));
  assert.ok(cc.length === 2 && cc[1].prompt.includes(SKIP_HEAD) && cc[1].prompt.includes(CQ) && !cc[1].prompt.includes(DECIDED_HEAD));
  assert.ok(!run.stages[0].decided?.length);
  // 정체로 간 결론에서 묻기: 다시 쓴 결론에 정체 표시와 코드의 줄이 남고, 판정으로 바꾼 답에는 없다
  const k = await four('결정체');
  s = await session(k.tm.id);
  from = mark();
  await start(s.id, 'POSSAME CONCLUDEQ 방향을 정하자');
  const { m: sm, a: sask } = await waitAsk(s.id);
  await ctl(s.id, 'answer', { askId: sask.id, answers: [{ picked: [0] }] });
  await ended(s.id);
  run = runs(s.id).at(-1);
  assert.deepEqual(shape(s.id, run), ['opinion1', 'opinion1', 'opinion1', 'opinion1', 'turn2', 'turn2', 'turn2', 'judge2', 'conclude']);
  assert.equal(S(s.id).messages.find((x) => x.id === sm.id).stall, undefined);
  assert.deepEqual(meetMsgs(s.id, run).at(-1).stall, { round: 2 });
  cc = sentFrom(from).filter((p) => p.prompt.includes('[회의 — 결론 내기]'));
  assert.ok(cc.length === 2 && cc.every((p) => p.prompt.includes(STALL_LINE)) && cc[0].prompt.includes(ASK_LINE) && !cc[1].prompt.includes(ASK_LINE));
});

test('21. 목표 회의의 결론에서 묻기: 목표의 회의 기록(결정 0025)에는 다시 쓴 결론만, 답은 mission.decided 와 진행 기록, 일 단계에 지시로', async () => {
  await app();
  const { tm, b } = await goalTeam('결목');
  const from = mark();
  const sid = await goal(tm.id, 'CONCLUDEQ 정해 줘');
  const { m: qm, a: ask } = await waitAsk(sid);
  assert.equal(qm.meeting.phase, 'judge');
  assert.ok(!(S(sid).mission.meetings || []).some((x) => x.msgId === qm.id), '물은 답은 회의 기록에 넣지 않는다');
  assert.ok(!(S(sid).mission.at?.finished || []).includes(qm.id), '끊긴 자리의 끝낸 답도 아니다');
  await ctl(sid, 'answer', { askId: ask.id, answers: [{ picked: [0] }] });
  await goalDone(sid);
  const m = S(sid).mission;
  assert.equal(m.status, 'done');
  const run = S(sid).runs.findLast((r) => r.mission === 'work');
  const concl = meetMsgs(sid, run).at(-1);
  assert.equal(concl.meeting.phase, 'conclude');
  assert.deepEqual(m.meetings.filter((x) => x.stageIndex === 0).map((x) => x.msgId), [concl.id], '회의 기록은 다시 쓴 결론 하나');
  assert.deepEqual(m.decided.map((x) => ({ ...x, at: 0 })), [{ question: CQ, answer: 'A안 (추천)', about: '빠르다', at: 0, stageIndex: 0 }]);
  assert.ok(m.log.some((x) => x.kind === 'note' && x.text === '"회의" 단계: 결론 차례에서 진행자가 사용자에게 물었어. 답을 넣고 결론을 다시 써.' && x.msgId === qm.id));
  assert.ok(m.log.some((x) => x.by === 'user' && x.text === `회의 질문에 답했어: ${CQ} → A안 (추천)`));
  const work = sentFrom(from).find((p) => p.id === b.id && p.prompt.includes('"빌드"를 네가 맡았어'));
  assert.ok(work && decidedIn(work.prompt, 'A안 (추천)', { q: CQ, about: '빠르다' }) && !work.prompt.includes('이건 사용자가 정할 일이야'), '일 단계: 정한 것과 다시 쓴 결론');
});
