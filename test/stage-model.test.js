// 흐름 무대(세션 화면 위쪽 그림)의 모델(public/js/stage-model.js). DOM 없이 장면마다 입력을 만들어 그릴 것을 검사하고,
// 서버가 실제로 만드는 실행 모양(단계표 실행·승인 대기·목표 판정 대기·한도 대기)은 가짜 CLI 로 돌려 얻는다(실제 AI 사용량 0)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageModel, openQuestions, requestOf, personInfo, stationInfo, meetLabel, goalWait, holdKind, fmtClock, critFold, raiseChoices, gateKeys, ANSWER_BOX, MAX_STATIONS, MAX_PEOPLE, MAX_CRIT } from '../public/js/stage-model.js';
import en from '../public/js/i18n/en.js';
import zh from '../public/js/i18n/zh.js';
import ja from '../public/js/i18n/ja.js';
import { setLang } from '../public/js/i18n/index.js';
import { startTestApp } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AG = [{ id: 'r', name: '조사' }, { id: 'p', name: '기획' }, { id: 'm', name: '만들기' }, { id: 'w', name: '기록' }, { id: 'q', name: '검수' }];
const TEAM = { stages: [{ label: '조사', agentIds: ['r'] }, { label: '기획 회의', agentIds: ['p', 'r', 'm'], meeting: { chairId: 'p', rounds: 3 } }, { label: '만들기', agentIds: ['m', 'w'] }, { label: '검수', agentIds: ['q'] }] };
// 팀 단계표로 만든 실행. statuses: 단계마다 run.stages[i].status, extra: 실행에 덮어쓸 값, patch: 단계마다 덮어쓸 값
const runOf = (statuses, extra = {}, patch = {}) => ({
  id: 'run1', status: 'running', stageIndex: 0, hold: null, userMessageId: 'u1', startedAt: 1, endedAt: null,
  stages: TEAM.stages.map((s, i) => ({ ...s, status: statuses[i], ...(patch[i] || {}) })), ...extra,
});
const M = (over = {}) => ({ id: 'G', status: 'active', goal: '소개 페이지 올릴 준비', request: '소개 페이지 만들어 줘', criteria: [{ id: 'c1', text: '가격이 보인다', status: 'pass' }, { id: 'c2', text: '버튼이 눌린다', status: 'fail' }], calls: { used: 12, cap: 40 }, at: { stageIndex: 2 }, returns: 0, returnCap: 1, ...over });
const model = (o) => stageModel({ agents: AG, team: TEAM, ...o });
const st = (m, i) => m.stations.find((x) => x.i === i);
const who = (s, id) => s.people.find((p) => p.id === id);
const gates = (m) => m.links.filter((l) => l.gate).map((l) => [l.after, l.gate.kind]);

test('1. 쉬는 세션: 역은 팀 단계표, 전부 할 일, 사람은 흐린 동그라미, 내 차례 없음', () => {
  const m = model({});
  assert.deepEqual(m.stations.map((s) => [s.label, s.state]), [['조사', 'todo'], ['기획 회의', 'todo'], ['만들기', 'todo'], ['검수', 'todo']]);
  assert.ok(m.stations.every((s) => s.people.every((p) => p.st === null && !p.held)));
  assert.deepEqual([m.ask, m.goal.kind, m.end.kind, m.now.text, m.progress, gates(m).length], [null, 'none', 'open', '모두 쉬는 중 · 할 일을 보내면 팀이 시작해', '쉬는 중', 0]);
  assert.equal(st(m, 2).parallel, 2, '병렬 단계는 ×2');
  assert.equal(st(m, 1).parallel, 0, '회의 단계는 ×n 이 아니라 회의 표시');
  assert.equal(st(m, 1).isMeeting, true);
});

test('2. 일하는 중: 지금 역은 run, 카드는 일하는 사람이 쥐고, 도구 종류가 아이콘·글로 갈린다', () => {
  const base = { run: runOf(['running', 'pending', 'pending', 'pending']), request: '소개 페이지 만들어 줘' };
  const m = model({ ...base, live: { r: { state: 'searching', tool: 'web_search', detail: '경쟁 제품 가격', at: 5 } } });
  const r = who(st(m, 0), 'r');
  assert.deepEqual([st(m, 0).state, st(m, 0).cur, r.held, r.st, r.tool], ['run', true, true, 'tool', 'search']);
  assert.deepEqual(personInfo(r), { cls: 'tool', icon: 'search', text: '검색 중' });
  assert.equal(m.now.text, '조사 · 경쟁 제품 가격', '지금 한 줄은 마지막 활동');
  assert.deepEqual([m.goal.kind, m.goal.mission, m.goal.text, m.progress], ['run', false, '소개 페이지 만들어 줘', '1/4 조사']);
  assert.ok(st(m, 1).people.every((p) => p.st === null), '지금 역이 아닌 사람은 상태를 그리지 않는다(지난 상태가 남지 않게)');
  const tool = (state, name) => who(st(model({ ...base, live: { r: { state, tool: name } } }), 0), 'r');
  assert.deepEqual([tool('reading', 'Read').tool, tool('running', 'Bash').tool, tool('tool', 'Edit').tool, tool('tool', 'TodoWrite').tool], ['read', 'run', 'edit', 'other']);
  assert.deepEqual([tool('typing').st, tool('thinking').st, tool('paused').st, tool('offline').st], ['write', 'think', 'limit', 'off']);
  assert.equal(personInfo({ st: 'tool', tool: 'other' }).icon, 'tool');
});

test('3. 병렬 단계: ×2, 둘 다 카드를 쥐고, 한 명이 먼저 끝나도 카드는 합쳐질 때까지. 끝나면 합침', () => {
  const live = { m: { state: 'running', tool: 'Bash', at: 3 }, w: { state: 'done', at: 4 } };
  const m = model({ run: runOf(['done', 'done', 'running', 'pending'], { stageIndex: 2 }), live });
  const s = st(m, 2);
  assert.deepEqual([s.parallel, who(s, 'm').held, who(s, 'w').held, who(s, 'w').st, who(s, 'm').st], [2, true, true, 'done', 'tool']);
  assert.equal(m.now.text, '만들기 · 실행 중', '일하는 사람(끝낸 사람이 아니라)');
  const after = model({ run: runOf(['done', 'done', 'done', 'running'], { stageIndex: 3 }) });
  assert.equal(st(after, 2).note, 'merged');
  const skipped = model({ run: runOf(['done', 'done', 'done', 'running'], { stageIndex: 3 }, { 2: { note: '1명 건너뜀' } }) });
  assert.deepEqual([st(skipped, 2).note, st(skipped, 2).memo], [null, '1명 건너뜀'], '누가 건너뛰었으면 합침 대신 단계 메모');
  assert.ok(!who(st(after, 2), 'm').held, '지난 역의 사람은 카드를 놓는다');
});

test('4. 단계가 넘어가면 카드가 날아간다(hand), 되돌림이면 거꾸로(ret)와 되돌림 n/상한', () => {
  const a = model({ run: runOf(['running', 'pending', 'pending', 'pending']) });
  const b = model({ run: runOf(['done', 'running', 'pending', 'pending'], { stageIndex: 1 }), prev: a });
  assert.deepEqual(b.fly, { from: 0, to: 1, kind: 'hand' });
  assert.equal(model({ run: runOf(['done', 'running', 'pending', 'pending'], { stageIndex: 1 }), prev: b }).fly, null, '같은 자리면 다시 날리지 않는다');
  assert.equal(model({ run: { ...runOf(['done', 'running', 'pending', 'pending'], { stageIndex: 1 }), id: 'other' }, prev: a }).fly, null, '다른 실행과 비교하지 않는다');
  const rv = { 3: { mission: 'review' } };
  const review = model({ run: runOf(['done', 'done', 'done', 'running'], { stageIndex: 3, missionId: 'G' }, rv), mission: M() });
  const back = model({ run: runOf(['done', 'done', 'running', 'done'], { stageIndex: 2, missionId: 'G' }, rv), mission: M({ at: { stageIndex: 2, back: true }, returns: 1, returnCap: 1 }), prev: review, live: { m: { state: 'thinking', at: 2 } } });
  assert.deepEqual(back.fly, { from: 3, to: 2, kind: 'ret' });
  assert.deepEqual([st(back, 2).note, st(back, 2).ret, back.now.icon], ['ret', { n: 1, of: 1 }, 'ret']);
  assert.equal(back.now.text, '되돌림 — "만들기" 단계가 걸린 기준을 고치는 중');
  assert.deepEqual(st(review, 3).review.map((c) => c.verdict), ['check', 'check'], '판정 중인 기준은 확인 중');
});

test('5. 회의: 차례·진행자·반대편·말하는 사람, 조사하러 간 사람은 자리를 비우고, 의견은 모두가 동시에', () => {
  const meet = (now, live = {}) => model({ run: runOf(['done', 'running', 'pending', 'pending'], { stageIndex: 1 }, { 1: { meetingNow: now } }), live });
  const turn = meet({ phase: 'turn', round: 2, rounds: 3, speakerId: 'm', opposerId: 'm' }, { m: { state: 'typing', detail: '낮추면 남는 게 없어', at: 9 } });
  const s = st(turn, 1);
  assert.equal(s.meeting.label, '차례 2/3');
  assert.deepEqual([who(s, 'p').chair, who(s, 'p').held, who(s, 'm').opp, who(s, 'm').speaker, who(s, 'r').speaker, who(s, 'r').st], [true, true, true, true, false, 'meet']);
  assert.equal(personInfo(who(s, 'm')).text, '말하는 중');
  assert.equal(turn.now.text, '회의 · 차례 2/3 — 만들기 말하는 중');
  const research = meet({ phase: 'research', round: 2, rounds: 3, speakerId: 'r', opposerId: 'm' }, { r: { state: 'searching', at: 9 } });
  assert.deepEqual([st(research, 1).meeting.away, who(st(research, 1), 'r').away, who(st(research, 1), 'r').st], ['r', true, 'tool']);
  assert.ok(who(st(research, 0), 'r').away, '다른 역에 있는 같은 사람에게도 조사하러 감 표시');
  assert.equal(research.now.text, '회의 · 조사 2/3 — 조사이(가) 자료 확인하러 감');
  const opinion = meet({ phase: 'opinion', round: 1, rounds: 3 });
  assert.ok(st(opinion, 1).people.every((p) => p.speaker), '의견은 참석자 모두가 동시에 쓴다');
  const judge = meet({ phase: 'judge', round: 2, rounds: 3, opposerId: 'm' });
  assert.equal(who(st(judge, 1), 'p').speaker, true, '판정은 진행자가 말한다');
  assert.equal(meetLabel({ phase: 'conclude' }), '결론');
});

test('6. 내 차례 5종(승인·질문·목표 판정·호출 상한·목표 카드 확인)의 종류와 문 자리', () => {
  const approve = model({ run: runOf(['done', 'done', 'review', 'pending'], { stageIndex: 2, status: 'waiting', hold: { reason: 'approve', stageIndex: 2, at: 1 } }), live: { m: { state: 'waiting' } } });
  assert.deepEqual([approve.ask.kind, approve.ask.target, gates(approve), st(approve, 2).state, who(st(approve, 2), 'm').st], ['approve', 'gate', [[2, 'approve']], 'wait', 'wait']);
  assert.equal(approve.ask.short, '"만들기" 결과 확인');
  const qs = openQuestions([{ id: 'a1', role: 'agent', agentId: 'm', runId: 'run1', stageIndex: 2, asks: [{ id: 'k', status: 'open', questions: [{ question: '버튼 색은?' }] }, { id: 'k0', status: 'answered', questions: [] }] }]);
  assert.equal(qs.length, 1, '답한 질문은 빼고');
  const question = model({ run: runOf(['done', 'done', 'running', 'pending'], { stageIndex: 2 }), questions: qs, live: { w: { state: 'typing', at: 3 } } });
  assert.deepEqual([question.ask.kind, question.ask.target, question.ask.station, gates(question), st(question, 2).ask, st(question, 2).note], ['question', 'ask', 2, [], true, 'question']);
  assert.deepEqual([who(st(question, 2), 'm').st, who(st(question, 2), 'w').st], ['wait', 'write'], '묻는 사람만 기다리고 같은 단계의 다른 사람은 계속 일한다');
  assert.equal(question.ask.short, '만들기: 버튼 색은?');
  const rv = { 3: { mission: 'review' } };
  const verdict = model({ run: runOf(['done', 'done', 'done', 'done'], { missionId: 'G', stageIndex: 3, status: 'waiting', hold: { reason: 'mission', kind: 'verdict', stageIndex: 3, left: [{ id: 'c2' }], at: 1 } }, rv), mission: M({ status: 'waiting' }) });
  assert.deepEqual([verdict.ask.kind, gates(verdict), st(verdict, 3).state, verdict.ask.short], ['verdict', [[3, 'verdict']], 'wait', '남은 기준 1개']);
  assert.deepEqual(st(verdict, 3).review.map((c) => [c.id, c.verdict]), [['c1', 'pass'], ['c2', 'fail']]);
  assert.deepEqual([verdict.meta.criteria, verdict.meta.calls], [{ pass: 1, total: 2, judged: true }, { used: 12, cap: 40 }]);
  // 호출 상한은 단계를 시작하기 전에 멈춘다: 문은 그 단계 앞
  const cap = model({ run: runOf(['done', 'done', 'pending', 'pending'], { missionId: 'G', stageIndex: 2, status: 'waiting', hold: { reason: 'cap', stageIndex: 2, used: 40, cap: 40, step: 20, at: 1 } }), mission: M() });
  assert.deepEqual([cap.ask.kind, gates(cap), st(cap, 2).state, cap.ask.short], ['cap', [[1, 'cap']], 'todo', '40/40 다 씀']);
  const cap0 = model({ run: runOf(['pending', 'pending', 'pending', 'pending'], { missionId: 'G', stageIndex: 0, status: 'waiting', hold: { reason: 'cap', stageIndex: 0, used: 40, cap: 40, at: 1 } }), mission: M() });
  assert.deepEqual(gates(cap0), [[-1, 'cap']], '첫 단계 앞이면 맨 앞');
  const draft = model({ run: { id: 'g', missionId: 'G', status: 'done', endedAt: 3, stageIndex: 0, stages: [{ label: '목표 잡기', agentIds: ['p'], status: 'done' }] }, mission: M({ status: 'draft', cardMsgId: 'card1' }) });
  assert.deepEqual([draft.ask.kind, draft.ask.target, draft.ask.msgId, gates(draft), draft.progress], ['confirm', 'card', 'card1', [[-1, 'confirm']], '시작 전']);
  assert.deepEqual(draft.stations.map((s) => s.state), ['todo', 'todo', 'todo', 'todo'], '확인 전에는 아무 단계도 시작하지 않았다');
  assert.deepEqual([holdKind({ status: 'waiting', hold: { reason: 'mission', stageIndex: 3 } }, 3), holdKind({ status: 'running', hold: { reason: 'mission', stageIndex: 3 } }, 3)], ['mission', '']);
  assert.deepEqual([goalWait({ status: 'waiting', hold: { reason: 'quota', stageIndex: 1 } }, 1), goalWait({ status: 'waiting', hold: { reason: 'approve', stageIndex: 1 } }, 1)], ['⏳', '']);
});

test('7. 한도 대기: 자동 이어서가 걸려 있으면 내 차례가 아니라 모래시계, 없으면 내 차례', () => {
  const until = Date.now() + 10 * 60000;
  const hold = (extra) => ({ reason: 'quota', stageIndex: 2, until, who: [{ agentId: 'm', name: '만들기' }], at: 1, ...extra });
  const auto = model({ run: runOf(['done', 'done', 'error', 'pending'], { missionId: 'G', stageIndex: 2, status: 'waiting', hold: hold({ autoAt: until + 45000 }) }), mission: M(), live: { m: { state: 'error' }, w: { state: 'done' } } });
  assert.equal(auto.ask, null, '내 차례 아님');
  assert.deepEqual([st(auto, 2).state, who(st(auto, 2), 'm').st, auto.now.icon, auto.limit.until], ['limit', 'limit', 'hour', until + 45000]);
  assert.ok(who(st(auto, 2), 'm').limitLeft > 10 * 60000, '남은 시간은 자동 이어서 시각까지');
  assert.match(auto.now.text, /^한도 대기 · .+에 자동으로 이어서$/);
  const mine = model({ run: runOf(['done', 'done', 'error', 'pending'], { missionId: 'G', stageIndex: 2, status: 'waiting', hold: hold({ canAuto: true }) }), mission: M() });
  assert.deepEqual([mine.ask.kind, mine.ask.station, st(mine, 2).state, st(mine, 2).ask, mine.ask.short], ['quota', 2, 'wait', true, '만들기']);
  // 실행 시작 때 한도가 곧 풀려 기다리는 사람(상태 paused)도 모래시계
  const paused = model({ run: runOf(['running', 'pending', 'pending', 'pending']), live: { r: { state: 'paused', detail: '한도가 곧 풀려서 기다리는 중(3분 남음)' } } });
  assert.deepEqual([paused.ask, who(st(paused, 0), 'r').st, paused.limit.names], [null, 'limit', ['조사']]);
});

test('8. 오류 대기, 끊긴 목표, 서버 연결 끊김', () => {
  const err = model({ run: runOf(['done', 'done', 'error', 'pending'], { stageIndex: 2, status: 'waiting', hold: { reason: 'error', stageIndex: 2, message: 'x', at: 1 } }), live: { m: { state: 'error' } } });
  assert.deepEqual([err.ask.kind, err.ask.cls, st(err, 2).state, st(err, 2).ask, who(st(err, 2), 'm').st, gates(err)], ['error', 'err', 'error', true, 'error', []]);
  const cut = model({ run: runOf(['done', 'done', 'stopped', 'pending'], { missionId: 'G', stageIndex: 2, status: 'stopped', endedAt: 9 }), mission: M({ status: 'cut' }) });
  assert.deepEqual([cut.ask.kind, cut.ask.target, cut.cut, st(cut, 2).state, cut.end.kind, cut.goal.kind], ['cut', 'cut', true, 'cut', 'cut', 'cut']);
  assert.ok(st(cut, 2).people.every((p) => p.st === 'off'));
  assert.ok(cut.links.every((l) => l.cut), '끊긴 목표는 길 전체가 점선');
  assert.equal(cut.progress, '3/4 만들기 ×2 · 끊김');
  const later = model({ run: { ...runOf(['done', 'done', 'done', 'done'], { status: 'done', endedAt: 9, stageIndex: 3 }), id: 'mention' }, mission: M({ status: 'cut' }) });
  assert.deepEqual([later.ask.kind, later.stations.map((s) => s.state)], ['cut', ['done', 'done', 'done', 'done']], '끊긴 목표 뒤의 다른 실행에는 끊긴 자리를 그리지 않는다(알약은 남는다)');
  const lost = model({ run: runOf(['running', 'pending', 'pending', 'pending']), conn: 'lost', live: { r: { state: 'thinking', at: 1 } } });
  assert.deepEqual([lost.lost, lost.now.icon, lost.now.text], [true, 'wifi', '서버 연결 끊김 — 다시 연결 중…']);
  assert.equal(who(st(lost, 0), 'r').st, 'think', '마지막으로 받은 상태는 그대로 둔다(흐리게 그린다)');
});

test('9. 끝남(통과·받아들임·중지·오류)과 건너뛴 단계. 끝난 실행에는 내 차례·지난 상태가 남지 않는다', () => {
  const allDone = runOf(['done', 'done', 'done', 'done'], { missionId: 'G', status: 'done', endedAt: 9, stageIndex: 3 });
  const pass = model({ run: allDone, mission: M({ status: 'done', criteria: [{ id: 'c1', status: 'pass' }, { id: 'c2', status: 'pass' }] }) });
  assert.deepEqual([pass.end.kind, pass.end.text, pass.goal.kind, pass.done, pass.ask, pass.now.text], ['pass', '통과로 끝', 'done', { pass: 2, total: 2, judged: true }, null, '통과로 끝 · 기준 2/2']);
  const acc = model({ run: allDone, mission: M({ status: 'accepted' }) });
  assert.deepEqual([acc.end.text, acc.goal.kind, acc.now.text], ['받아들여 끝', 'accepted', '받아들여서 끝냈어']);
  const stopped = model({ run: runOf(['done', 'stopped', 'pending', 'pending'], { status: 'stopped', endedAt: 9, stageIndex: 1 }), live: { p: { state: 'waiting' }, m: { state: 'thinking' } } });
  assert.deepEqual([stopped.end.kind, stopped.now.text, stopped.ask, st(stopped, 1).state, stopped.goal.kind], ['stopped', '중지됨', null, 'stopped', 'stopped']);
  assert.ok(stopped.stations.every((s) => s.people.every((p) => p.st === null && !p.held)), '끝난 실행은 사람 상태를 그리지 않는다');
  const plain = model({ run: runOf(['done', 'skipped', 'done', 'done'], { status: 'done', endedAt: 9, stageIndex: 3 }) });
  assert.deepEqual([st(plain, 1).state, stationInfo('skipped').icon, plain.end.kind, plain.progress], ['skipped', 'skip', 'pass', '4/4 끝']);
  const failed = model({ run: runOf(['done', 'error', 'pending', 'pending'], { status: 'error', endedAt: 9, stageIndex: 1 }) });
  assert.deepEqual([failed.end.kind, failed.goal.kind, failed.ask], ['error', 'error', null], '오류로 끝난 실행은 답할 창이 없어 내 차례가 아니다');
});

test('10. 단계 7개면 지난 역을 접는다, 에이전트 하나뿐인 세션, 일 카드로 도는 목표', () => {
  const stages = Array.from({ length: 7 }, (_, i) => ({ label: `단계${i + 1}`, agentIds: ['r', 'p', 'm', 'w', 'q'], status: i < 4 ? 'done' : i === 4 ? 'running' : 'pending' }));
  const m = stageModel({ agents: AG, run: { id: 'r7', status: 'running', stageIndex: 4, endedAt: null, stages } });
  assert.ok(m.stations.length <= MAX_STATIONS && m.folded > 0, `${m.stations.length}개 보임, ${m.folded}개 접음`);
  assert.equal(m.stations.length + m.folded, 7);
  assert.ok(m.stations.some((s) => s.i === 4), '지금 역은 보인다');
  assert.ok(m.stations[0].i <= 3, '지금 역 하나 앞까지는 남긴다');
  assert.equal(m.segs.length, 7, '접은 띠는 단계 전부');
  assert.deepEqual([st(m, 4).people.length, st(m, 4).more], [MAX_PEOPLE, 1]);
  const ended = stageModel({ agents: AG, run: { id: 'r7', status: 'done', stageIndex: 6, endedAt: 9, stages: stages.map((s) => ({ ...s, status: 'done' })) } });
  assert.deepEqual([ended.stations.length, ended.folded, ended.stations.at(-1).i], [6, 1, 6]);
  const solo = stageModel({ agents: AG, solo: { id: 'r', name: '조사', role: '조사 담당' } });
  assert.deepEqual(solo.stations.map((s) => [s.label, s.people.map((p) => p.id)]), [['조사 담당', ['r']]]);
  // 일 카드(결정 0018): 계획 → 카드 걸음 → 기준 판정이 역이 되고, 카드 걸음에 카드 제목이 붙는다
  const cards = stageModel({
    agents: AG, mission: M({ cards: [{ id: 'k1', title: '첫 화면' }, { id: 'k2', title: '문구' }] }),
    run: { id: 'rc', missionId: 'G', status: 'running', stageIndex: 1, endedAt: null, stages: [
      { label: '계획', agentIds: ['p'], status: 'done', mission: 'plan' }, { label: '일 1/1', agentIds: ['m', 'w'], status: 'running', mission: 'cards', cardIds: ['k1', 'k2'] }, { label: '기준 판정', agentIds: ['q'], status: 'pending', mission: 'review' }] },
  });
  assert.deepEqual(cards.stations.map((s) => s.label), ['계획', '일 1/1', '기준 판정']);
  assert.deepEqual(st(cards, 1).cards, [{ id: 'k1', title: '첫 화면' }, { id: 'k2', title: '문구' }]);
  assert.deepEqual(st(cards, 2).review.map((c) => c.verdict), ['pass', 'fail'], '아직 안 돈 판정 역은 지난 판정 그대로');
});

test('11. 무대 모델을 en·zh·ja 로 돌리면 내는 글(알약·지금 줄·끝 깃발·진행 줄·역·사람·회의 표식)에 한글이 남지 않는다', () => {
  // test/i18n.test.js 는 소스의 t('…') 글자 키가 사전에 있는지만 본다. 여기서는 모델을 각 언어로 실제로 돌려서
  // 표·변수로 고른 문구까지 번역되어 나오는지 본다(사전에 없으면 t() 가 한국어 원문을 그대로 낸다).
  // 이름·단계 이름·목표 글·질문처럼 바깥 글은 영어로 넣는다. 화면(views/stage.js)이 따로 만드는 글은 DOM 없이 돌릴 수 없어 보지 않는다(아래 기준 낱말만 사전에서 본다)
  const ag = [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Ben' }, { id: 'c', name: 'Cy' }];
  const team = { stages: [{ label: 'Plan', agentIds: ['a'] }, { label: 'Talk', agentIds: ['a', 'b', 'c'], meeting: { chairId: 'a', rounds: 3 } }, { label: 'Build', agentIds: ['b', 'c'] }, { label: 'Check', agentIds: ['c'], mission: 'review' }] };
  const r = (statuses, extra = {}, patch = {}) => ({ id: 'r', missionId: 'G', status: 'running', stageIndex: 0, endedAt: null, userMessageId: 'u', stages: team.stages.map((s, i) => ({ ...s, status: statuses[i], ...(patch[i] || {}) })), ...extra });
  const g = (over = {}) => ({ id: 'G', status: 'active', goal: 'Ship it', criteria: [{ id: 'c1', text: 'x', status: 'pass' }, { id: 'c2', text: 'y', status: 'open' }], calls: { used: 3, cap: 40 }, at: { stageIndex: 2 }, returns: 0, returnCap: 1, cardMsgId: 'k', ...over });
  const wait = (hold, statuses = ['done', 'done', 'done', 'pending'], over = {}) => ({ run: r(statuses, { stageIndex: hold.stageIndex, status: 'waiting', hold: { at: 1, ...hold } }), mission: g(over) });
  const until = Date.now() + 600000;
  const scenes = {
    idle: {}, solo: { team: null, solo: { id: 'a', name: 'Ann' } },
    tool: { run: r(['running', 'pending', 'pending', 'pending']), live: { a: { state: 'running', tool: 'Bash', at: 2 } }, request: 'Do it', mission: null },
    meet: { run: r(['done', 'running', 'pending', 'pending'], { stageIndex: 1 }, { 1: { meetingNow: { phase: 'turn', round: 2, rounds: 3, speakerId: 'b', opposerId: 'b' } } }), mission: g() },
    research: { run: r(['done', 'running', 'pending', 'pending'], { stageIndex: 1 }, { 1: { meetingNow: { phase: 'research', round: 2, rounds: 3, speakerId: 'c', opposerId: 'b' } } }), mission: g() },
    opinion: { run: r(['done', 'running', 'pending', 'pending'], { stageIndex: 1 }, { 1: { meetingNow: { phase: 'opinion', round: 1, rounds: 3 } } }), mission: g() },
    approve: wait({ reason: 'approve', stageIndex: 2 }, ['done', 'done', 'review', 'pending']), error: wait({ reason: 'error', stageIndex: 2, message: 'x' }, ['done', 'done', 'error', 'pending']),
    verdict: wait({ reason: 'mission', kind: 'verdict', stageIndex: 3, left: [{ id: 'c2' }] }, ['done', 'done', 'done', 'done']), notes: wait({ reason: 'mission', kind: 'notes', stageIndex: 3, notes: 1 }, ['done', 'done', 'done', 'done']),
    blocked: wait({ reason: 'mission', kind: 'blocked', stageIndex: 2, blocked: [{ name: 'Ben' }] }), limit: wait({ reason: 'mission', kind: 'limit', stageIndex: 2, cards: [{ id: 'k1' }] }),
    // 윗등급에게 넘기기 보기가 붙은 질문(결정 0027): 문 문구에 후보
    raiseLimit: wait({ reason: 'mission', kind: 'limit', stageIndex: 2, cards: [{ id: 'k1' }], raise: [{ card: 'k1', to: 'c', name: 'Cy' }] }),
    raiseBlocked: wait({ reason: 'mission', kind: 'blocked', stageIndex: 2, blocked: [{ name: 'Ben', card: 'k1' }], raise: [{ card: 'k1', to: 'c' }] }),
    cap: wait({ reason: 'cap', stageIndex: 2, used: 40, cap: 40 }, ['done', 'done', 'pending', 'pending']), rate: wait({ reason: 'cap', kind: 'rate', stageIndex: 2, used: 20, cap: 20 }, ['done', 'done', 'pending', 'pending']),
    quota: wait({ reason: 'quota', stageIndex: 2, until, who: [{ agentId: 'b', name: 'Ben' }] }, ['done', 'done', 'error', 'pending']),
    quotaAuto: wait({ reason: 'quota', stageIndex: 2, until, autoAt: until, who: [{ agentId: 'b', name: 'Ben' }] }, ['done', 'done', 'error', 'pending']),
    paused: { run: r(['done', 'pending', 'pending', 'pending'], { stageIndex: 1, status: 'paused' }), mission: g() },
    question: { run: r(['done', 'done', 'running', 'pending'], { stageIndex: 2 }), mission: g(), questions: [{ id: 'q', agentId: 'b', runId: 'r', stageIndex: 2, text: 'Color?' }] },
    back: { run: r(['done', 'done', 'running', 'done'], { stageIndex: 2 }), mission: g({ at: { stageIndex: 2, back: true }, returns: 1 }) },
    draft: { run: r(['done'], { status: 'done', endedAt: 2 }), mission: g({ status: 'draft' }) },
    cut: { run: r(['done', 'done', 'stopped', 'pending'], { status: 'stopped', endedAt: 2, stageIndex: 2 }), mission: g({ status: 'cut' }) },
    lost: { run: r(['running', 'pending', 'pending', 'pending']), conn: 'lost', mission: g() },
    ...Object.fromEntries(['done', 'accepted', 'stopped', 'cancelled'].map((s) => [s, { run: r(['done', 'done', 'done', 'done'], { status: 'done', endedAt: 2, stageIndex: 3 }), mission: g({ status: s }) }])),
    noCard: { run: r(['error'], { status: 'error', endedAt: 2 }), mission: g({ status: 'cancelled', cardMsgId: null }) },
    runEnds: { run: r(['done', 'skipped', 'error', 'stopped'], { status: 'error', endedAt: 2, stageIndex: 2 }), mission: null },
    gone: { run: { id: 'x', status: 'running', stageIndex: 0, endedAt: null, stages: [{ label: 'Tidy', agentIds: ['ghost'], status: 'running' }] }, mission: null },
  };
  const texts = (m) => [m.goal.text, m.now.text, m.end.text, m.progress, m.ask?.title, m.ask?.short, ...m.stations.flatMap((s) => [s.label, stationInfo(s.state).text, s.meeting?.label, s.meeting?.awayName, ...s.names, ...s.people.map((p) => (p.st ? personInfo(p).text : ''))])];
  const states = ['todo', 'run', 'done', 'wait', 'limit', 'error', 'skipped', 'stopped', 'cut'];
  const people = [...['think', 'write', 'meet', 'wait', 'limit', 'error', 'done', 'off', 'idle'].map((st) => ({ st })), ...['search', 'read', 'run', 'edit', 'other'].map((tool) => ({ st: 'tool', tool })), { st: 'meet', speaker: true }];
  try {
    for (const lang of ['en', 'zh', 'ja']) {
      setLang(lang);
      for (const [name, input] of Object.entries(scenes)) {
        const bad = texts(stageModel({ agents: ag, team, ...input })).filter((x) => /[가-힣]/.test(x || ''));
        assert.deepEqual(bad, [], `${lang} · ${name}`);
      }
      const tables = [...states.map((s) => stationInfo(s).text), ...people.map((p) => personInfo(p).text), ...['opinion', 'turn', 'research', 'judge', 'conclude', 'review'].map((phase) => meetLabel({ phase, round: 1, rounds: 2 }))];
      assert.deepEqual(tables.filter((x) => /[가-힣]/.test(x)), [], `${lang} · 역·사람·회의 표`);
    }
  } finally { setLang('ko'); }
  assert.equal(meetLabel({ phase: 'conclude' }), '결론', '한국어로 돌아왔다(뒤 테스트는 한국어 문구로 본다)');
  // 기준 조각 낱말은 views/stage.js 의 표(CR)에서 t() 로 부른다: i18n.test.js 의 글자 키 모으기에 안 잡혀서 사전에 있는지 여기서 본다
  for (const [lang, dict] of Object.entries({ en, zh, ja })) {
    assert.deepEqual(['통과', '불합격', '확인 못 함', '확인 중', '아직'].filter((k) => typeof dict[k] !== 'string' || !dict[k].trim()), [], `${lang} 기준 낱말`);
  }
  assert.equal(requestOf([{ id: 'u1', text: '요청 글' }], { userMessageId: 'u1' }), '요청 글');
});

// ── 검토와 화면 확인에서 나온 장면 ──
test('16. 기준은 판정이 하나도 없으면 "기준 n개"(judged 없음), 시각은 24시간 HH:MM', () => {
  const m = model({ run: runOf(['running', 'pending', 'pending', 'pending'], { missionId: 'G' }), mission: M({ criteria: [{ id: 'c1', status: 'open' }, { id: 'c2', status: 'open' }] }) });
  assert.deepEqual(m.meta.criteria, { pass: 0, total: 2, judged: false });
  const day = new Date();
  day.setHours(16, 27, 0, 0);
  const now = new Date(day);
  now.setHours(9, 0, 0, 0);
  const clock = fmtClock(day.getTime(), now.getTime());
  assert.match(clock, /16:27/);
  assert.doesNotMatch(clock, /오후|PM/i, '오전·오후 표기 없이');
  const tomorrow = fmtClock(day.getTime() + 86400000, now.getTime());
  assert.match(tomorrow, /16:27/);
  assert.notEqual(tomorrow, clock, '오늘이 아니면 날짜가 붙는다');
});

test('17. 목표 카드 확인 대기면 끝 깃발은 열림, 카드를 닫았거나 목표를 멈췄으면 목표 상태를 실행 상태보다 먼저 본다', () => {
  const goalTurn = { id: 'g', missionId: 'G', status: 'done', endedAt: 3, stageIndex: 0, stages: [{ label: '목표 잡기', agentIds: ['p'], status: 'done' }] };
  const draft = model({ run: goalTurn, mission: M({ status: 'draft', cardMsgId: 'card1' }) });
  assert.deepEqual([draft.end.kind, draft.progress, draft.ask.kind], ['open', '시작 전', 'confirm']);
  const cancelled = model({ run: goalTurn, mission: M({ status: 'cancelled', cardMsgId: 'card1' }) }); // 사용자가 닫는 카드는 늘 있다(서버가 카드와 같이 cardMsgId 를 적는다)
  assert.deepEqual([cancelled.end, cancelled.now.text, cancelled.progress, cancelled.goal.kind, cancelled.ask], [{ kind: 'stopped', text: '닫힘' }, '목표 카드를 닫았어.', '닫힘', 'stopped', null]);
  const stopped = model({ run: runOf(['done', 'stopped', 'pending', 'pending'], { missionId: 'G', status: 'stopped', endedAt: 9, stageIndex: 1 }), mission: M({ status: 'stopped' }) });
  assert.deepEqual([stopped.end.kind, stopped.end.text, stopped.now.text], ['stopped', '중지됨', '중지됨']);
});

test('18. 회의 참석자가 5명이어도 말하는 사람·반대편·진행자·조사하러 간 사람은 +n 뒤로 숨지 않는다', () => {
  const big = { 1: { agentIds: ['p', 'r', 'm', 'w', 'q'] } };
  const turn = model({ run: runOf(['done', 'running', 'pending', 'pending'], { stageIndex: 1 }, { 1: { ...big[1], meetingNow: { phase: 'turn', round: 2, rounds: 3, speakerId: 'q', opposerId: 'w' } } }), live: { q: { state: 'typing', detail: '근거는 이거야', at: 3 } } });
  const s = st(turn, 1);
  assert.equal(s.more, 1);
  assert.deepEqual(s.people.slice(0, 3).map((p) => p.id), ['q', 'w', 'p'], '말하는 사람 → 반대편 → 진행자');
  assert.deepEqual(s.meeting.speaker, { name: '검수', detail: '근거는 이거야', opp: false, chair: false }, '말 줄은 보이는 사람과 상관없이 모델이 준다');
  const research = model({ run: runOf(['done', 'running', 'pending', 'pending'], { stageIndex: 1 }, { 1: { ...big[1], meetingNow: { phase: 'research', round: 2, rounds: 3, speakerId: 'q', opposerId: 'w' } } }) });
  assert.ok(st(research, 1).people.some((p) => p.id === 'q' && p.away), '조사하러 간 사람의 빈자리도 보인다');
  assert.deepEqual([st(research, 1).meeting.away, st(research, 1).meeting.awayName], ['q', '검수']);
});

test('19. 이번 실행에 없는 에이전트의 지난 실시간 상태는 "지금" 줄·한도 표시에 섞이지 않는다', () => {
  const live = { r: { state: 'thinking', detail: '생각 중…', at: 1 }, w: { state: 'typing', detail: '옛 실행의 글', at: 99 }, q: { state: 'paused', detail: '한도가 곧 풀려서 기다리는 중' } };
  const m = model({ run: runOf(['running', 'pending', 'pending', 'pending']), live });
  assert.equal(m.now.text, '조사 · 생각 중…');
  assert.equal(m.limit, null);
});

test('20. 카드 되풀이 상한은 단계 앞 문(역은 기다림으로 칠하지 않는다), 막힘은 막힌 단계 뒤, 추가 지시·판정은 판정 역 뒤, 일시정지는 알약만', () => {
  const holdAt = (hold, statuses = ['done', 'done', 'done', 'pending']) => model({ run: runOf(statuses, { missionId: 'G', stageIndex: hold.stageIndex, status: 'waiting', hold: { at: 1, ...hold } }, { 3: { mission: 'review' } }), mission: M() });
  const limit = holdAt({ reason: 'mission', kind: 'limit', stageIndex: 2, cards: [{ id: 'k1' }] });
  assert.deepEqual([limit.ask.kind, gates(limit), st(limit, 2).state, st(limit, 2).ask, limit.ask.short], ['limit', [[1, 'limit']], 'done', false, 'k1']);
  const blocked = holdAt({ reason: 'mission', kind: 'blocked', stageIndex: 2, blocked: [{ name: '만들기' }] }, ['done', 'done', 'done', 'pending']);
  assert.deepEqual([blocked.ask.kind, gates(blocked), st(blocked, 2).state], ['blocked', [[2, 'blocked']], 'wait']);
  const notes = holdAt({ reason: 'mission', kind: 'notes', stageIndex: 3, notes: 2 }, ['done', 'done', 'done', 'done']);
  assert.deepEqual([notes.ask.kind, gates(notes), notes.ask.short], ['notes', [[3, 'notes']], '반영 안 한 추가 지시 2개']);
  const paused = model({ run: runOf(['done', 'pending', 'pending', 'pending'], { stageIndex: 1, status: 'paused' }) });
  assert.deepEqual([paused.ask.kind, paused.ask.target, gates(paused)], ['paused', 'gate', []]);
});

test('21. 단계 9개에 지금 0번이면 앞으로 올 역은 접지 않는다(역 줄을 가로로 민다), 밀어 보일 곳은 지금 역', () => {
  const stages = Array.from({ length: 9 }, (_, i) => ({ label: `단계${i + 1}`, agentIds: ['r'], status: i === 0 ? 'running' : 'pending' }));
  const m = stageModel({ agents: AG, run: { id: 'r9', status: 'running', stageIndex: 0, endedAt: null, stages } });
  assert.deepEqual([m.folded, m.stations.length, m.scrollTo], [0, 9, 0]);
  const waitGate = model({ run: { id: 'g', missionId: 'G', status: 'done', endedAt: 3, stageIndex: 0, stages: [{ label: '목표 잡기', agentIds: ['p'], status: 'done' }] }, mission: M({ status: 'draft' }) });
  assert.equal(waitGate.scrollTo, 0, '지금 역이 없으면 내 차례 문 자리');
});

test('22. 역의 툴팁·이름과 +n 은 자르기 전 전체 이름을 쓴다, 기준 조각은 한 줄에 넘치면 +n', () => {
  const six = { 2: { agentIds: ['m', 'w', 'r', 'p', 'q', 'x1'] } };
  const m = stageModel({ agents: [...AG, { id: 'x1', name: '여섯째' }], run: runOf(['done', 'done', 'running', 'pending'], { stageIndex: 2 }, six) });
  assert.deepEqual([st(m, 2).names.length, st(m, 2).hiddenNames, st(m, 2).more], [6, ['검수', '여섯째'], 2]);
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `c${i + 1}`, verdict: 'pass' }));
  assert.deepEqual([critFold(five).shown.length, critFold(five).hidden.length], [MAX_CRIT - 1, 5 - MAX_CRIT + 1]);
  assert.deepEqual(critFold(five.slice(0, MAX_CRIT)).hidden, [], '다 들어가면 접지 않는다');
});

// 글자 검사다: 이름이 그 파일의 class 글에 있는지만 본다. 그 창이 실제로 선택자의 부모(.chat-inner 등) 안에 그려지는지,
// 찾은 창에 초점이 가는지는 DOM 없이 볼 수 없어서 보장하지 않는다(결정 0020 대로 브라우저에서 손으로 확인)
test('23. (글자 검사) 답 창 자리(ANSWER_BOX)의 클래스 이름이 session.js·mission.js 의 class 글에 있고, 무대(stage.js)는 그 이름을 쓰지 않는다', () => {
  const src = ['public/js/views/session.js', 'public/js/views/mission.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  const sels = [ANSWER_BOX.gate, ANSWER_BOX.ask, ANSWER_BOX.askMini, ANSWER_BOX.cut, ANSWER_BOX.card('m1')].join(' ');
  const classes = [...new Set([...sels.matchAll(/\.([a-z][\w-]*)/g)].map((x) => x[1]))];
  assert.deepEqual(classes.sort(), ['ask-mini', 'ask-panel', 'chat', 'chat-inner', 'composer-wrap', 'gate', 'goal-card', 'mission-gate', 'session', 'warnbox'].sort());
  // 클래스 글 안에 그 이름이 낱말로 있다(class="… gate …" 나 class=${'warnbox row'} 같은 꼴)
  for (const c of classes) assert.match(src, new RegExp(`class=(?:"|\\$\\{[^}]*['\`"])[^"'\`]*(?<![\\w-])${c}(?![\\w-])`), `${c} 클래스가 화면 파일에 없다`);
  assert.match(src, /data-mid=\$\{m\.id\}/, '메시지 자리의 data-mid');
  // 끊긴 목표 알림·질문 창이 입력창 묶음 안에 그려진다(그래서 .composer-wrap 아래에서 찾는다)
  const composer = src.slice(src.indexOf('<div class="composer-wrap">'), src.indexOf('<div class="composer-wrap">') + 400);
  assert.match(composer, /<\$\{AskPanel\}/);
  assert.match(composer, /<\$\{CutBox\}/);
  // 무대 안의 요소가 답 창으로 잘못 찾히지 않게: stage.js 의 class 글에 답 창 클래스 이름이 없다(예전 문 연결선의 "gate")
  const { words } = stageClasses();
  const answer = classes.filter((c) => !['chat', 'chat-inner', 'composer-wrap', 'session'].includes(c));
  assert.deepEqual(answer.filter((c) => words.has(c)), [], '무대가 쓰는 답 창 클래스');
});

// 무대 화면(stage.js)의 class 글(class="…", class=${`…`}, const cls = `…`, className = `…`)에서 클래스 낱말을 모은다.
// 글자 그대로인 낱말과 ${…} 안의 따옴표 글(' done')을 모으고, 낱말에 바로 붙은 ${값}(stg-${…}·s-${…})은 접두가 붙은 무대 것이라 뺀다.
// 접두 없이 통째로 들어가는 ${값}은 bare 에 식 그대로 모은다
function stageClasses() {
  const src = fs.readFileSync(path.join(root, 'public/js/views/stage.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/class=\$\{(?!`|cls\})/g)].map((m) => src.slice(m.index, m.index + 30)), [], '모으지 못하는 class 글 꼴');
  const words = new Set();
  const bare = new Set();
  for (const m of src.matchAll(/class=(?:"([^"]*)"|\$\{`([^`]*)`\})|(?:const cls|className) = `([^`]*)`/g)) {
    const parts = (m[1] ?? m[2] ?? m[3]).split(/(\$\{[^}]*\})/);
    parts.forEach((p, k) => {
      if (p.startsWith('${')) {
        const lits = [...p.matchAll(/'([^']*)'/g)].map((q) => q[1]);
        lits.forEach((l) => l.split(/\s+/).filter(Boolean).forEach((w) => words.add(w)));
        if (!lits.length && !/\S$/.test(parts[k - 1] || '')) bare.add(p.slice(2, -1));
        return;
      }
      const ws = p.split(/\s+/).filter(Boolean);
      const next = parts[k + 1];
      if (next && !next.includes("'") && /\S$/.test(p)) ws.pop(); // 바로 뒤 ${값}의 접두(stg-·s-)
      ws.forEach((w) => words.add(w));
    });
  }
  return { words, bare };
}

test('33. 무대(stage.js)의 클래스가 app.css·office.css 의 범위 없는 전역 규칙(.limit·.small·.mono·.gate 같은)과 겹치지 않는다', () => {
  // 범위 없는 전역 규칙: 선택자가 클래스 한 덩어리뿐인 것(.limit, .gate.err). 조상이 붙은 규칙(.sess .more)은 무대 밖 조상이 있어야 먹어서 뺀다
  const css = ['public/css/app.css', 'public/css/office.css'].map((f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
  const globals = [];
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    for (const sel of m[1].split(',')) {
      const s = sel.trim().replace(/::?[\w-]+(?:\([^)]*\))?/g, ''); // :hover·::after 같은 것은 떼고 본다
      if (/^(?:\.[\w-]+)+$/.test(s)) globals.push(s.slice(1).split('.'));
    }
  }
  assert.ok(globals.some((g) => g.join('.') === 'limit') && globals.some((g) => g.join('.') === 'small'), '전역 규칙을 읽었다');
  // 무대의 클래스 낱말(stageClasses). 접두 없이 통째로 들어가는 ${값}은 아래 값 목록으로 본다(새로 생기면 접두를 붙이거나 목록에 넣는다)
  const { words, bare } = stageClasses();
  const VALUES = { 'k.cls': ['me', 'err', 'cut'], 'c.verdict': ['pass', 'fail', 'unknown', 'check', 'open'], 'end.kind': ['pass', 'stopped', 'error', 'cut', 'open'], 'fly.kind': ['hand', 'ret'] };
  assert.deepEqual([...bare].sort(), Object.keys(VALUES).sort(), '접두 없는 동적 클래스');
  for (const v of Object.values(VALUES)) v.forEach((w) => words.add(w));
  words.delete('resizer'); // 앱 공용 높이 손잡이(app.css .resizer)는 일부러 같이 쓴다
  assert.ok(words.has('stg-st') && words.has('stg-link-gate') && words.has('stg-small') && words.has('stg-calls'), '무대 class 글을 읽었다');
  const hit = globals.filter((g) => g.every((c) => words.has(c))).map((g) => `.${g.join('.')}`);
  assert.deepEqual(hit, [], '무대 요소에 먹는 전역 규칙');
});

test('24. 회의 단계를 되돌리면 카드는 서버가 고치게 하는 사람(진행자 leadId 가 그 단계에 있으면 그 사람, 없으면 첫 에이전트)에게', () => {
  const back = (leadId) => model({ run: runOf(['done', 'running', 'done', 'done'], { missionId: 'G', stageIndex: 1 }), mission: M({ leadId, at: { stageIndex: 1, back: true }, returns: 1 }) });
  const inStage = st(back('m'), 1);
  assert.deepEqual(inStage.people.filter((p) => p.held).map((p) => p.id), ['m'], '진행자(회의의 chair 가 아니라 목표의 leadId)');
  assert.deepEqual(st(back('q'), 1).people.filter((p) => p.held).map((p) => p.id), ['p'], '그 단계에 없으면 첫 에이전트');
});

test('25. 한도 대기 뒤 "지금 다시" 앞의 호출 상한: 이미 돈 단계 안에서 기다린다("오류" 꼬리 없음)', () => {
  const m = model({ run: runOf(['done', 'done', 'error', 'pending'], { missionId: 'G', stageIndex: 2, status: 'waiting', hold: { reason: 'cap', stageIndex: 2, used: 40, cap: 40, at: 1 } }), mission: M() });
  assert.deepEqual([m.ask.kind, m.ask.station, gates(m), st(m, 2).state, st(m, 2).ask], ['cap', 2, [], 'wait', true]);
  assert.equal(m.progress, '3/4 만들기 ×2 · 기다림');
});

test('26. 지워진 에이전트는 id 대신 "삭제된 에이전트"로, 누를 수 없게(gone)', () => {
  const m = stageModel({ agents: AG, run: { id: 'x', status: 'running', stageIndex: 0, endedAt: null, stages: [{ label: '정리', agentIds: ['ghost'], status: 'running' }] } });
  assert.deepEqual([m.stations[0].people[0].name, m.stations[0].people[0].gone, who(st(model({}), 0), 'r').gone], ['삭제된 에이전트', true, false]);
});

test('27. 끊긴 목표 뒤의 다른 실행이 나를 기다리면(승인·오류·질문·일시정지) 그 차례가 보이고, 끊김 알약은 기다리는 게 없을 때만', () => {
  const cutM = M({ status: 'cut' });
  const other = (statuses, extra = {}) => runOf(statuses, { id: 'mention', stageIndex: 2, ...extra });
  const approve = model({ run: other(['done', 'done', 'review', 'pending'], { status: 'waiting', hold: { reason: 'approve', stageIndex: 2, at: 1 } }), mission: cutM });
  assert.deepEqual([approve.ask.kind, gates(approve), approve.now.text], ['approve', [[2, 'approve']], '"만들기" 결과 확인']);
  const err = model({ run: other(['done', 'done', 'error', 'pending'], { status: 'waiting', hold: { reason: 'error', stageIndex: 2, message: 'x', at: 1 } }), mission: cutM });
  assert.deepEqual([err.ask.kind, st(err, 2).ask], ['error', true]);
  const q = model({ run: other(['done', 'done', 'running', 'pending']), mission: cutM, questions: [{ id: 'k', agentId: 'm', runId: 'mention', stageIndex: 2, text: '버튼 색은?' }] });
  assert.equal(q.ask.kind, 'question');
  const paused = model({ run: other(['done', 'done', 'pending', 'pending'], { status: 'paused' }), mission: cutM });
  assert.equal(paused.ask.kind, 'paused');
  const busy = model({ run: other(['done', 'done', 'running', 'pending']), mission: cutM });
  assert.deepEqual([busy.ask.kind, busy.ask.target], ['cut', 'cut'], '기다리는 게 없으면 끊김 알약');
});

// 일 카드 단계 하나짜리 목표 실행(계획 → 일 → 기준 판정). 호출 상한으로 일 단계에서 기다린다
const cardRun = (status, hold) => ({ id: 'rc', missionId: 'G', status: 'waiting', stageIndex: 1, endedAt: null, hold: { at: 1, stageIndex: 1, ...hold }, stages: [
  { label: '계획', agentIds: ['p'], status: 'done', mission: 'plan' }, { label: '일 1/1', agentIds: ['m', 'w'], status, mission: 'cards', cardIds: ['k1', 'k2'] }, { label: '기준 판정', agentIds: ['q'], status: 'pending', mission: 'review' }] });
const cardsM = (k1, at = { stageIndex: 1 }) => M({ at, cards: [{ id: 'k1', ownerId: 'm', status: k1 }, { id: 'k2', ownerId: 'w', status: 'done' }] });

test('28. 일 카드 끝 두 칸 다시 요청 앞의 호출 상한은 이미 돈 단계라 역 안, 되돌림으로 다시 하기 전이면 단계 앞', () => {
  const cap = { reason: 'cap', used: 40, cap: 40 };
  // 첫 바퀴: 서버는 단계를 done 으로 끝낸 뒤(#cardsAfter) 끝 두 칸이 없는 카드(아직 running)를 다시 부르기 전에 묻고, 이미 돈 단계라고 알린다(ran)
  const tail = stageModel({ agents: AG, run: cardRun('done', { ...cap, ran: true }), mission: cardsM('running') });
  assert.deepEqual([tail.ask.kind, tail.ask.station, gates(tail), st(tail, 1).state, st(tail, 1).ask], ['cap', 1, [], 'wait', true]);
  assert.equal(tail.progress, '2/3 일 1/1 ×2 · 기다림');
  // 되돌림 바퀴의 끝 두 칸 다시 요청도 역 안
  const backTail = stageModel({ agents: AG, run: cardRun('done', { ...cap, ran: true }), mission: cardsM('running', { stageIndex: 1, back: true }) });
  assert.deepEqual([backTail.ask.station, gates(backTail)], [1, []]);
  // 되돌림으로 다시 하기 전: 지난 바퀴의 done 이 남아 있어도 아직 시작 전이라 단계 앞 문
  const redo = stageModel({ agents: AG, run: cardRun('done', cap), mission: cardsM('done', { stageIndex: 1, back: true }) });
  assert.deepEqual([redo.ask.kind, gates(redo), st(redo, 1).state, st(redo, 1).ask], ['cap', [[0, 'cap']], 'done', false]);
  // 처음 시작 전(pending)은 그대로 단계 앞
  const first = stageModel({ agents: AG, run: cardRun('pending', cap), mission: cardsM('open') });
  assert.deepEqual([gates(first), st(first, 1).state], [[[0, 'cap']], 'todo']);
});

test('29. 오류 다시 하기 앞의 카드 되풀이 상한은 오류 난 역 안에서 기다린다(진행 줄 꼬리도 기다림)', () => {
  const lim = model({ run: runOf(['done', 'done', 'error', 'pending'], { missionId: 'G', stageIndex: 2, status: 'waiting', hold: { reason: 'mission', kind: 'limit', stageIndex: 2, cards: [{ id: 'k1' }], at: 1 } }), mission: M() });
  assert.deepEqual([lim.ask.kind, lim.ask.station, gates(lim), st(lim, 2).state, st(lim, 2).ask], ['limit', 2, [], 'wait', true]);
  assert.equal(lim.progress, '3/4 만들기 ×2 · 기다림');
  // 오류 다시 하기 앞의 시간당 카드 시작 수 상한도 역 안
  const rate = model({ run: runOf(['done', 'done', 'error', 'pending'], { missionId: 'G', stageIndex: 2, status: 'waiting', hold: { reason: 'cap', kind: 'rate', stageIndex: 2, used: 20, cap: 20, at: 1 } }), mission: M() });
  assert.deepEqual([rate.ask.station, gates(rate), st(rate, 2).state], [2, [], 'wait']);
});

test('30. 끝 깃발: 안 끝난 실행·쉬는 세션·카드 확인 대기는 "도착", 끝난 실행만 "끝"(번역도 서로 다르다)', () => {
  assert.deepEqual(model({}).end, { kind: 'open', text: '도착' });
  assert.deepEqual(model({ run: runOf(['running', 'pending', 'pending', 'pending']) }).end, { kind: 'open', text: '도착' });
  const draft = model({ run: { id: 'g', missionId: 'G', status: 'done', endedAt: 3, stageIndex: 0, stages: [{ label: '목표 잡기', agentIds: ['p'], status: 'done' }] }, mission: M({ status: 'draft', cardMsgId: 'card1' }) });
  assert.deepEqual(draft.end, { kind: 'open', text: '도착' });
  assert.deepEqual(model({ run: runOf(['done', 'done', 'done', 'done'], { status: 'done', endedAt: 9, stageIndex: 3 }) }).end, { kind: 'pass', text: '끝' });
  for (const [lang, dict] of Object.entries({ en, zh, ja })) assert.notEqual(dict['도착'], dict['끝'], `${lang}: 안 끝났는데 완료로 읽히지 않게`);
});

test('31. 목표 잡기가 오류·중지로 끝나 카드 없이 닫힌 목표는 "카드를 닫았어"가 아니라 그 끝 상태로', () => {
  const goalTurn = (status) => ({ id: 'g', missionId: 'G', mission: 'goal', status, endedAt: 3, stageIndex: 0, stages: [{ label: '목표 잡기', agentIds: ['p'], status }] });
  const noCard = (status) => model({ run: goalTurn(status), mission: M({ status: 'cancelled', goal: '', criteria: [], cardMsgId: null }) });
  const err = noCard('error');
  assert.deepEqual([err.end, err.now.text, err.now.cls, err.progress], [{ kind: 'error', text: '오류로 끝' }, '목표 카드가 나오기 전에 끝나서 이 목표는 닫았어.', 'error', '오류로 끝']);
  // 서버는 진행자를 건너뛰어도(orchestrator #goalTurn: 건너뛴 답은 stopped), 초안을 쓰는 중에 앱이 꺼져도(#fixStale) 목표 잡기 실행을 stopped 로 끝낸다
  const stopped = noCard('stopped');
  assert.deepEqual([stopped.end, stopped.now.text, stopped.now.cls], [{ kind: 'stopped', text: '중지됨' }, '목표 카드가 나오기 전에 끝나서 이 목표는 닫았어.', 'off']);
  // 초안 블록을 못 읽으면 서버는 요청 글로 카드를 만든다. 카드가 나온 뒤(목표 잡기 실행 done) 사용자가 닫은 목표는 "닫힘"과 "목표 카드를 닫았어."
  const dropped = model({ run: goalTurn('done'), mission: M({ status: 'cancelled', cardMsgId: 'card1' }) });
  assert.deepEqual([dropped.end, dropped.now.text], [{ kind: 'stopped', text: '닫힘' }, '목표 카드를 닫았어.']);
});

test('32. 되돌림을 끝내고 판정 앞에서 일시정지하면(서버가 바뀐 자리를 아직 안 알림) 되돌린 역에 "되돌림 n/상한"이 남지 않는다', () => {
  const rv = { 3: { mission: 'review' } };
  const stale = model({ run: runOf(['done', 'done', 'done', 'pending'], { missionId: 'G', stageIndex: 3, status: 'paused', hold: { reason: 'pause', stageIndex: 3, at: 1 } }, rv), mission: M({ at: { stageIndex: 2, back: true }, returns: 1, returnCap: 1 }) });
  assert.deepEqual([st(stale, 2).ret, st(stale, 2).note, stale.ask.kind], [null, 'merged', 'paused']);
  // 되돌림 단계를 시작하기 전 일시정지(지금 단계가 되돌릴 단계)는 되돌림 표시 그대로
  const before = model({ run: runOf(['done', 'done', 'done', 'pending'], { missionId: 'G', stageIndex: 2, status: 'paused', hold: { reason: 'pause', stageIndex: 2, at: 1 } }, rv), mission: M({ at: { stageIndex: 2, back: true }, returns: 1, returnCap: 1 }) });
  assert.deepEqual(st(before, 2).ret, { n: 1, of: 1 });
});

test('34. 이미 돈 단계에서 묻는 상한(서버가 hold.ran 으로 알린다)은 카드 되풀이 상한·호출 상한 모두 그 역 안, 시작하기 전이면 단계 앞', () => {
  const rv = { 3: { mission: 'review' } };
  const at = (statuses, hold, mission = M()) => model({ run: runOf(statuses, { missionId: 'G', stageIndex: hold.stageIndex, status: 'waiting', hold: { at: 1, ...hold } }, rv), mission });
  const inside = (m, kind) => assert.deepEqual([m.ask.kind, m.ask.station, gates(m), st(m, 2).state, st(m, 2).ask], [kind, 2, [], 'wait', true]);
  const before = (m, kind, state) => assert.deepEqual([m.ask.kind, m.ask.station, gates(m), st(m, 2).state, st(m, 2).ask], [kind, undefined, [[1, kind]], state, false]);
  const limit = { reason: 'mission', kind: 'limit', stageIndex: 2, cards: [{ id: 'k1' }] };
  const cap = { reason: 'cap', stageIndex: 2, used: 40, cap: 40 };
  // 막힘 "한 번 더" 뒤 두 번째 바퀴: 단계는 이번 바퀴에서 done 으로 끝났다
  inside(at(['done', 'done', 'done', 'pending'], { ...limit, ran: true }), 'limit');
  inside(at(['done', 'done', 'done', 'pending'], { ...cap, ran: true }), 'cap');
  // 되돌림 바퀴: 시작하기 전(지난 바퀴의 done 이 남아 있다)은 단계 앞, 그 바퀴에서 막힘 "한 번 더" 앞은 역 안
  const backM = M({ at: { stageIndex: 2, back: true }, returns: 1, returnCap: 1 });
  before(at(['done', 'done', 'done', 'pending'], cap, backM), 'cap', 'done');
  before(at(['done', 'done', 'done', 'pending'], limit, backM), 'limit', 'done');
  inside(at(['done', 'done', 'done', 'pending'], { ...cap, ran: true }, backM), 'cap');
  inside(at(['done', 'done', 'done', 'pending'], { ...limit, ran: true }, backM), 'limit');
  // 끊겼다 이어서 한 뒤 한도 다시 하기 앞의 상한: 이어서 한 실행은 그 단계를 pending 으로 다시 만들지만 이미 돈 단계다
  inside(at(['done', 'done', 'pending', 'pending'], { ...cap, ran: true }), 'cap');
  // 처음 시작하기 전(pending, 표시 없음)은 그대로 단계 앞, 오류 다시 하기 앞(error)은 표시가 없어도 역 안
  before(at(['done', 'done', 'pending', 'pending'], cap), 'cap', 'todo');
  before(at(['done', 'done', 'pending', 'pending'], limit), 'limit', 'todo');
  inside(at(['done', 'done', 'error', 'pending'], limit), 'limit');
  inside(at(['done', 'done', 'error', 'pending'], cap), 'cap');
});

test('35. 끊긴 목표가 되돌림 중이었어도 그 뒤의 다른 실행 역에는 "되돌림 n/상한"·되돌림 줄이 붙지 않는다', () => {
  const cutM = M({ status: 'cut', at: { stageIndex: 2, back: true }, returns: 1, returnCap: 1 });
  const other = model({ run: runOf(['done', 'done', 'running', 'pending'], { id: 'mention', stageIndex: 2 }), mission: cutM, live: { m: { state: 'thinking', at: 2 } } });
  assert.deepEqual([st(other, 2).ret, st(other, 2).note], [null, null]);
  assert.notEqual(other.now.icon, 'ret');
  // 그 목표의 실행이면 되돌림 표시
  const own = model({ run: runOf(['done', 'done', 'running', 'pending'], { missionId: 'G', stageIndex: 2 }), mission: M({ at: { stageIndex: 2, back: true }, returns: 1, returnCap: 1 }) });
  assert.deepEqual(st(own, 2).ret, { n: 1, of: 1 });
});

// ── 서버가 실제로 만드는 실행 모양(가짜 CLI) ──
let t = null;
const app = async () => (t ||= await startTestApp());
after(async () => { if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } } });
const mk = async (name, role) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
const mkTeam = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const ctl = (sid, action) => t.api('POST', `/api/sessions/${sid}/control`, { action });
const idle = (sid) => !t.app.orch.ctx.has(sid);
// 화면이 받는 것과 같은 세션(GET /api/sessions/:id 는 live 를 같이 준다)으로 모델을 만든다
async function modelOf(sid, prev = null) {
  const s = (await t.api('GET', `/api/sessions/${sid}`)).json;
  const team = (await t.api('GET', '/api/bootstrap')).json.teams.find((x) => x.id === s.teamId) || null;
  const run = s.runs.at(-1) || null;
  const agents = (await t.api('GET', '/api/bootstrap')).json.agents;
  return { s, m: stageModel({ run, live: s.live || {}, mission: s.mission || null, questions: openQuestions(s.messages), agents, team, prev, request: requestOf(s.messages, run) }) };
}
const runAt = (sid, pred) => t.waitFor(() => { const r = t.app.store.getSession(sid).runs.at(-1); return r && pred(r) && r; }, 30000, '실행 상태');

test('12. (서버 모양) 단계표 실행: 도는 동안 지금 역과 카드, 넘어가면 카드가 날고, 끝나면 내 차례 없이 끝', async () => {
  await app();
  const a = await mk('무대정리', '정리');
  const b = await mk('무대빌드', '빌드');
  const tm = await mkTeam('무대팀', [{ label: '정리', agentIds: [a.id] }, { label: '빌드', agentIds: [b.id] }]);
  const sid = (await t.api('POST', '/api/sessions', { teamId: tm.id })).json.id;
  const idleModel = (await modelOf(sid)).m;
  assert.deepEqual([idleModel.stations.map((s) => [s.label, s.state]), idleModel.goal.kind], [[['정리', 'todo'], ['빌드', 'todo']], 'none']);
  await t.api('POST', `/api/sessions/${sid}/messages`, { text: 'SLOW 정리하고 빌드해 줘' });
  await runAt(sid, (r) => r.status === 'running' && r.stageIndex === 0 && r.stages[0].status === 'running');
  const first = (await modelOf(sid)).m;
  assert.deepEqual([first.cur, st(first, 0).state, who(st(first, 0), a.id).held, first.goal.text], [0, 'run', true, 'SLOW 정리하고 빌드해 줘']);
  await runAt(sid, (r) => r.status === 'running' && r.stageIndex === 1 && r.stages[1].status === 'running');
  const second = (await modelOf(sid, first)).m;
  assert.deepEqual([second.fly, st(second, 0).state, st(second, 1).state, who(st(second, 1), b.id).held, second.links[0].done], [{ from: 0, to: 1, kind: 'hand' }, 'done', 'run', true, true]);
  await t.waitFor(() => idle(sid) && t.app.store.getSession(sid).runs.at(-1).endedAt, 30000, '실행 끝');
  const end = (await modelOf(sid, second)).m;
  assert.deepEqual([end.ask, end.end.kind, end.goal.kind, end.now.text, end.stations.map((s) => s.state), end.fly], [null, 'pass', 'done', '끝났어', ['done', 'done'], null]);
});

test('13. (서버 모양) 승인 대기: 문은 그 단계 뒤, 역은 기다림, 승인하면 내 차례가 사라진다', async () => {
  await app();
  const a = await mk('승인정리', '정리');
  const b = await mk('승인빌드', '빌드');
  const tm = await mkTeam('무대승인팀', [{ label: '정리', agentIds: [a.id] }, { label: '빌드', agentIds: [b.id], approve: true }]);
  const sid = (await t.api('POST', '/api/sessions', { teamId: tm.id })).json.id;
  await t.api('POST', `/api/sessions/${sid}/messages`, { text: '정리하고 빌드해 줘' });
  await runAt(sid, (r) => r.hold?.reason === 'approve');
  const w = (await modelOf(sid)).m;
  assert.deepEqual([w.ask.kind, w.ask.target, gates(w), st(w, 1).state, who(st(w, 1), b.id).st, w.ask.short], ['approve', 'gate', [[1, 'approve']], 'wait', 'wait', '"빌드" 결과 확인']);
  assert.equal((await ctl(sid, 'approve')).json.ok, true);
  await t.waitFor(() => idle(sid) && t.app.store.getSession(sid).runs.at(-1).endedAt, 30000, '실행 끝');
  const done = (await modelOf(sid)).m;
  assert.deepEqual([done.ask, gates(done), done.end.kind], [null, [], 'pass']);
});

// 목표 팀: 정리 → 빌드, 검수자 따로(기준 판정 단계가 맨 끝에 붙는다)
let gt = null;
async function goalTeam() {
  if (gt) return gt;
  await app();
  const a = await mk('무대목표정리', '정리');
  const b = await mk('무대목표빌드', '빌드');
  const r = await mk('무대목표검수', '검수');
  gt = { a, b, r, tm: await mkTeam('무대목표팀', [{ label: '정리', agentIds: [a.id] }, { label: '빌드', agentIds: [b.id] }, { label: '검수', agentIds: [r.id] }]) };
  return gt;
}
// 요청 → 목표 카드(확인 전 모델을 같이 돌려준다) → 목표 문장에 신호어를 넣어 확인
async function goal(signal, work = 'stages') {
  const { tm } = await goalTeam();
  const sid = (await t.api('POST', '/api/sessions', { teamId: tm.id })).json.id;
  assert.equal((await t.api('PATCH', `/api/sessions/${sid}`, { goalMode: true })).status, 200);
  await t.api('POST', `/api/sessions/${sid}/messages`, { text: '정리해 줘' });
  await t.waitFor(() => t.app.store.getSession(sid).mission?.status === 'draft' && idle(sid), 20000, '목표 카드');
  const draft = (await modelOf(sid)).m;
  const S = t.app.store.getSession(sid);
  const c = S.messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  const shown = { goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides };
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const r = await t.api('POST', `/api/sessions/${sid}/mission/confirm`, { missionId: S.mission.id, expected: shown, review, work, edited: { ...shown, goal: `${signal} 목표` } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { sid, draft, cardId: c.id };
}

test('14. (서버 모양) 목표 카드 확인 대기와 목표 판정 대기: 확인은 맨 앞 문, 판정은 판정 역 뒤 문과 기준 조각', async () => {
  const { sid, draft, cardId } = await goal('REVIEWFAIL2');
  assert.deepEqual([draft.ask.kind, draft.ask.msgId, gates(draft), draft.stations.map((s) => s.state)], ['confirm', cardId, [[-1, 'confirm']], ['todo', 'todo', 'todo']]);
  const run = await runAt(sid, (r) => r.hold?.reason === 'mission');
  const v = (await modelOf(sid)).m;
  const i = run.hold.stageIndex;
  assert.equal(run.stages[i].mission, 'review');
  assert.deepEqual([v.ask.kind, gates(v), st(v, i).state, v.goal.mission, v.goal.text], ['verdict', [[i, 'verdict']], 'wait', true, 'REVIEWFAIL2 목표']);
  assert.ok(st(v, i).review.some((c) => c.verdict === 'fail'), '걸린 기준은 불합격 조각');
  assert.equal(v.meta.criteria.total, t.app.store.getSession(sid).mission.criteria.length);
  assert.ok(v.meta.calls.used > 0 && v.meta.calls.cap === 40);
  assert.equal((await ctl(sid, 'accept')).json.ok, true);
  await t.waitFor(() => idle(sid) && t.app.store.getSession(sid).runs.at(-1).endedAt, 30000, '목표 끝');
  const acc = (await modelOf(sid)).m;
  assert.deepEqual([acc.ask, acc.goal.kind, acc.end.text], [null, 'accepted', '받아들여 끝']);
});

test('15. (서버 모양) 한도 대기: 자동 이어서를 고르기 전에는 내 차례, 고른 뒤에는 모래시계', async () => {
  const { a } = await goalTeam();
  const { sid } = await goal('WORKQUOTA');
  try {
    const run = await runAt(sid, (r) => r.hold?.reason === 'quota');
    const q = (await modelOf(sid)).m;
    const i = run.hold.stageIndex;
    assert.deepEqual([q.ask.kind, q.ask.station, st(q, i).state, st(q, i).ask, who(st(q, i), a.id).st, gates(q)], ['quota', i, 'wait', true, 'limit', []]);
    assert.ok(who(st(q, i), a.id).limitLeft > 0, '초기화 시각까지 남은 시간');
    assert.equal((await ctl(sid, 'later')).json.ok, true);
    await runAt(sid, (r) => r.hold?.reason === 'quota' && r.hold.autoAt > 0);
    const auto = (await modelOf(sid)).m;
    assert.deepEqual([auto.ask, st(auto, i).state, auto.limit.until > Date.now(), auto.now.icon], [null, 'limit', true, 'hour']);
  } finally {
    await ctl(sid, 'stop');
    await t.waitFor(() => idle(sid), 30000, '그만');
    // 가짜 한도 오류가 남긴 쉬는 표시·한도 기록을 지운다
    t.app.orch.cooldown.map.clear();
    t.app.store.usage.limits = {};
  }
  const stopped = (await modelOf(sid)).m;
  assert.deepEqual([stopped.ask, stopped.limit, stopped.goal.kind], [null, null, 'stopped']);
});

test('36. (서버 모양) 막힘 "한 번 더"를 거듭해 이미 돈 카드 단계에서 되풀이 상한을 물으면 문은 그 역 안(서버가 hold.ran 으로 알린다)', async () => {
  const { sid } = await goal('CARDBLOCK', 'cards'); // k1 이 늘 막힘으로 끝난다
  try {
    for (let n = 0; n < 3; n++) {
      await runAt(sid, (r) => r.hold?.reason === 'mission' && r.hold.kind === 'blocked');
      assert.equal((await ctl(sid, 'more')).json.ok, true);
      await runAt(sid, (r) => r.hold?.kind !== 'blocked' || r.status !== 'waiting');
    }
    const run = await runAt(sid, (r) => r.hold?.reason === 'mission' && r.hold.kind === 'limit');
    const i = run.hold.stageIndex;
    assert.deepEqual([run.hold.ran, run.stages[i].status], [true, 'done'], '이번 바퀴에서 이미 돌아 done 인 단계');
    const m = (await modelOf(sid)).m;
    assert.deepEqual([m.ask.kind, m.ask.station, gates(m), st(m, i).state, st(m, i).ask], ['limit', i, [], 'wait', true]);
  } finally {
    await ctl(sid, 'stop');
    await t.waitFor(() => idle(sid), 30000, '그만');
  }
});

test('윗등급에게 넘기기 보기(결정 0027): 대기 종류는 limit·blocked 그대로이고 문 문구에만 후보 이름(이름이 없으면 에이전트 이름으로). 보기가 없으면 지금 문구 그대로', () => {
  const hold = (h) => ({ run: runOf(['done', 'done', 'done', 'pending'], { status: 'waiting', stageIndex: 2, missionId: 'G', hold: { at: 1, stageIndex: 2, ...h } }), mission: M() });
  const limit = model(hold({ reason: 'mission', kind: 'limit', cards: [{ id: 'k1' }], raise: [{ card: 'k1', to: 'w', name: '기록' }] }));
  assert.deepEqual([limit.ask.kind, limit.ask.title, limit.ask.short], ['limit', '카드 되풀이 상한', 'k1 · 윗등급 기록에게 넘길 수 있어']);
  const blocked = model(hold({ reason: 'mission', kind: 'blocked', blocked: [{ name: '만들기', card: 'k1' }], raise: [{ card: 'k1', to: 'w' }] }));
  assert.deepEqual([blocked.ask.kind, blocked.ask.short], ['blocked', '만들기 · 윗등급 기록에게 넘길 수 있어']);
  assert.equal(model(hold({ reason: 'mission', kind: 'limit', cards: [{ id: 'k1' }] })).ask.short, 'k1');
  // 판정 질문에는 붙지 않는다(넘기기는 카드 질문만)
  assert.equal(model(hold({ reason: 'mission', kind: 'verdict', left: [{ id: 'c2' }], raise: [{ card: 'k1', to: 'w' }] })).ask.short, '남은 기준 1개');
  // 보기 둘(같은 프로바이더 후보가 opt 0): 문 문구에는 두 이름
  const two = model(hold({ reason: 'mission', kind: 'limit', cards: [{ id: 'k1' }], raise: [{ opt: 0, card: 'k1', to: 'w', name: '기록' }, { opt: 1, card: 'k1', to: 'x', name: '코덱스' }] }));
  assert.equal(two.ask.short, 'k1 · 윗등급 기록, 코덱스에게 넘길 수 있어');
});

test('넘기기 보기·번호 키(결정 0027): 서버 항목을 보기마다 묶고(opt 없으면 첫 보기), 번호 키는 1 받아들이기 · 2 한 번 더 · 3·4 넘기기 보기(보낼 { 카드: 후보 }). 다른 질문에는 번호 키가 없다', () => {
  const limit = { reason: 'mission', kind: 'limit', cards: [{ id: 'k1' }, { id: 'k2' }],
    raise: [{ opt: 0, card: 'k1', to: 'm1' }, { opt: 0, card: 'k2', to: 'h' }, { opt: 1, card: 'k1', to: 'm2' }, { opt: 1, card: 'k2', to: 'h' }] };
  assert.deepEqual(raiseChoices(limit).map((o) => o.to), [{ k1: 'm1', k2: 'h' }, { k1: 'm2', k2: 'h' }]);
  assert.deepEqual(gateKeys(limit), [['accept', {}], ['more', {}], ['raise', { to: { k1: 'm1', k2: 'h' } }], ['raise', { to: { k1: 'm2', k2: 'h' } }]]);
  // 예전 모양(opt 없음)은 첫 보기 하나
  assert.deepEqual(gateKeys({ reason: 'mission', kind: 'blocked', raise: [{ card: 'k1', to: 'w' }] }), [['accept', {}], ['more', {}], ['raise', { to: { k1: 'w' } }]]);
  // 보기 없는 막힘 질문: 1·2 만
  assert.deepEqual(gateKeys({ reason: 'mission', kind: 'blocked', blocked: [] }), [['accept', {}], ['more', {}]]);
  // 판정 질문·호출 상한 질문에는 이 번호 키가 없다
  assert.equal(gateKeys({ reason: 'mission', kind: 'verdict', raise: [{ card: 'k1', to: 'w' }] }), null);
  assert.equal(gateKeys({ reason: 'cap' }), null);
  assert.deepEqual(raiseChoices({ reason: 'cap', raise: [{ card: 'k1', to: 'w' }] }), []);
});
