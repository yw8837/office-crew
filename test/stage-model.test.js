// 흐름 무대(세션 화면 위쪽 그림)의 모델(public/js/stage-model.js). DOM 없이 장면마다 입력을 만들어 그릴 것을 검사하고,
// 서버가 실제로 만드는 실행 모양(단계표 실행·승인 대기·목표 판정 대기·한도 대기)은 가짜 CLI 로 돌려 얻는다(실제 AI 사용량 0)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageModel, openQuestions, requestOf, personInfo, stationInfo, meetLabel, goalWait, holdKind, MAX_STATIONS, MAX_PEOPLE } from '../public/js/stage-model.js';
import en from '../public/js/i18n/en.js';
import zh from '../public/js/i18n/zh.js';
import ja from '../public/js/i18n/ja.js';
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
  assert.deepEqual([verdict.meta.criteria, verdict.meta.calls], [{ pass: 1, total: 2 }, { used: 12, cap: 40 }]);
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
  assert.deepEqual([pass.end.kind, pass.end.text, pass.goal.kind, pass.done, pass.ask, pass.now.text], ['pass', '통과로 끝', 'done', { pass: 2, total: 2 }, null, '통과로 끝 · 기준 2/2']);
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

test('11. 무대의 새 문구 키가 en·zh·ja 사전에 모두 있다', () => {
  const keys = new Set();
  for (const f of ['public/js/stage-model.js', 'public/js/views/stage.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\\n]|\\.)*)'/g)) keys.add(m[1].replace(/\\(.)/g, '$1'));
  }
  for (const k of ['통과', '불합격', '확인 못 함', '확인 중', '아직']) keys.add(k); // 기준 조각은 표에서 t() 로 부른다
  assert.ok(keys.size > 50, `키 ${keys.size}개`);
  for (const [lang, dict] of Object.entries({ en, zh, ja })) {
    const missing = [...keys].filter((k) => typeof dict[k] !== 'string' || !dict[k].trim());
    assert.deepEqual(missing, [], `${lang} 누락`);
  }
  assert.equal(requestOf([{ id: 'u1', text: '요청 글' }], { userMessageId: 'u1' }), '요청 글');
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
async function goal(signal) {
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
  const r = await t.api('POST', `/api/sessions/${sid}/mission/confirm`, { missionId: S.mission.id, expected: shown, review, work: 'stages', edited: { ...shown, goal: `${signal} 목표` } });
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
