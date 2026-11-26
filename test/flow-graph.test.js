// 읽기 전용 흐름도(결정 0030)의 모델·자리 잡기·키보드 이동(public/js/flow-graph.js). DOM 없이 목표 기록(mission·실행·메시지)에서 마디와 선을 만들고,
// 좁은 창에서도 가로로 넘치지 않게 자리를 잡는지, 색 말고 글자·모양으로도 상태가 갈리는지, 화살표 키로 옆·위아래 마디로 가는지 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowModel, flowLayout, flowNext, stateInfo, fitText, FLOW_STATES } from '../public/js/flow-graph.js';
import { setLang } from '../public/js/i18n/index.js';

setLang('ko');
const NAMES = { r: '조사', b: '빌드', w: '기록', v: '검수', l: '진행' };
const nameOf = (id) => NAMES[id] || id;
const card = (id, ownerId, extra = {}) => ({ id, title: `${id} 카드 제목`, ownerId, kind: 'build', needs: [], files: [], status: 'waiting', starts: 0, cap: 3, ...extra });
// 일 카드 목표: 조사 → 회의 → 계획 → 물결 둘(k1·k2 / k3 이 k1 을 기다림) → 검수 → 보고
const cardGoal = (over = {}) => ({
  id: 'G1', status: 'active', goal: '목표', confirmedAt: 10, createdAt: 1, cardMsgId: 'mGoal', requestMsgId: 'u1', reviewerId: 'v', work: 'cards',
  prep: { research: true, meeting: true }, research: { questions: [{ id: 'q1', status: 'done' }, { id: 'q2', status: 'failed' }], noteMsgId: 'mNote' },
  meetingMsgId: 'mMeet', planMsgId: 'mPlan', returns: 0, round: 0, log: [],
  cards: [card('k1', 'b', { status: 'done', msgId: 'mk1' }), card('k2', 'w', { status: 'running' }), card('k3', 'b', { needs: ['k1'] })],
  criteria: [{ id: 'c1', status: 'open' }], ...over,
});
const runOf = (stages, extra = {}) => ({ id: 'R1', mission: 'work', missionId: 'G1', status: 'running', stages, hold: null, ...extra });
const cardRun = (extra = {}, waves = [['k1', 'k2'], ['k3']]) => runOf([
  { label: '훑어보기', mission: 'scan', status: 'done', agentIds: ['r'] }, { label: '조사 질문', mission: 'questions', status: 'done', agentIds: ['l'] },
  { label: '조사', mission: 'research', status: 'done', agentIds: ['r'] }, { label: '준비 회의', mission: 'meeting', status: 'done', agentIds: ['l', 'r'] },
  { label: '계획', mission: 'plan', status: 'done', agentIds: ['l'] },
  ...waves.map((ids, k) => ({ label: `일 ${k + 1}/${waves.length}`, mission: 'cards', cardIds: ids, status: k === 0 ? 'running' : 'pending', agentIds: [] })),
  { label: '기준 판정', mission: 'review', status: 'pending', agentIds: ['v'] },
], extra);
const ids = (m) => m.nodes.map((n) => n.id);
const node = (m, id) => m.nodes.find((n) => n.id === id);
const edges = (m, kind) => m.edges.filter((e) => e.kind === kind).map((e) => `${e.from}>${e.to}`);

test('1. 일 카드 목표: 목표 잡기 → 조사 → 회의 → 계획 → 물결별 카드 → 검수 → 보고, 마디마다 누르면 갈 메시지', () => {
  const m = flowModel({ mission: cardGoal(), runs: [cardRun()], messages: [], nameOf });
  assert.deepEqual(ids(m), ['goal', 'research', 'meeting', 'plan', 'card:k1', 'card:k2', 'card:k3', 'review', 'report']);
  // 줄(rank): 물결이 같은 카드는 같은 줄
  assert.deepEqual(m.nodes.map((n) => n.rank), [0, 1, 2, 3, 4, 4, 5, 6, 7]);
  assert.equal(node(m, 'goal').msgId, 'mGoal');
  assert.equal(node(m, 'research').msgId, 'mNote');
  assert.equal(node(m, 'meeting').msgId, 'mMeet');
  assert.equal(node(m, 'plan').msgId, 'mPlan');
  assert.equal(node(m, 'card:k1').msgId, 'mk1');
  // 상태: 끝·도는 중·대기, 조사는 질문 하나가 확인 못 함이어도 대목은 끝
  assert.deepEqual(['goal', 'research', 'card:k1', 'card:k2', 'card:k3', 'review', 'report'].map((id) => node(m, id).state), ['done', 'done', 'done', 'run', 'wait', 'wait', 'wait']);
  assert.match(node(m, 'research').sub, /2개 중 1개 확인 못 함/);
  // 선: 큰 흐름은 앞 대목 → 다음 대목, 카드의 needs, 기다리는 카드가 없는 카드는 계획에서, 뒤 카드가 기다리지 않는 카드는 검수로
  assert.deepEqual(edges(m, 'flow'), ['goal>research', 'research>meeting', 'meeting>plan', 'plan>card:k1', 'plan>card:k2', 'card:k2>review', 'card:k3>review', 'review>report']);
  assert.deepEqual(edges(m, 'needs'), ['card:k1>card:k3']);
  // 카드 마디의 이름: 카드 id·제목, 담당 이름
  assert.equal(node(m, 'card:k1').label, 'k1 · k1 카드 제목');
  assert.equal(node(m, 'card:k1').who, '빌드');
});

test('2. 막힘·구멍·오류·건너뜀·멈춤과 되돌림·윗등급 넘김·회의 질문·한도 대기 선', () => {
  const g = cardGoal({
    returns: 2, round: 3, status: 'waiting',
    cards: [card('k1', 'b', { status: 'blocked', reason: '못 해' }), card('k2', 'w', { status: 'hole', by: 'quota' }), card('k3', 'v', { needs: ['k1'], status: 'running', raised: [{ from: 'b', to: 'v', at: 5, why: 'limit' }] })],
    decided: [{ prep: true, question: '어느 안?', answer: 'A', at: 4 }],
    at: { stageIndex: 6, phase: 'work', wait: { reason: 'quota', until: 0 } },
  });
  const run = cardRun({ status: 'waiting', hold: { reason: 'quota', stageIndex: 6 } });
  run.stages[6].status = 'error';
  const m = flowModel({ mission: g, runs: [run], messages: [], nameOf });
  assert.equal(node(m, 'card:k1').state, 'blocked');
  assert.equal(node(m, 'card:k2').state, 'hole');
  assert.equal(node(m, 'card:k3').state, 'error', '오류 대기 중인 단계의 안 끝난 카드는 오류');
  // 윗등급에게 넘긴 선: 카드 스스로에게 돌아오는 선, 이름에 처음 담당 → 지금 담당
  assert.deepEqual(edges(m, 'raise'), ['card:k3>card:k3']);
  assert.match(m.edges.find((e) => e.kind === 'raise').label, /빌드 → 검수/);
  // 검수에서 되돌린 선(회차 표시): 검수 → 마지막 물결
  const back = m.edges.filter((e) => e.kind === 'return');
  assert.deepEqual(back.map((e) => `${e.from}>${e.to}`), ['review>card:k3']);
  assert.match(back[0].label, /되돌림 2번/);
  assert.match(back[0].label, /3회차/);
  // 회의에서 사용자에게 물은 자리: 회의 마디 옆에 "물음" 마디와 선
  assert.ok(ids(m).includes('ask:meeting'));
  assert.deepEqual(edges(m, 'ask'), ['meeting>ask:meeting']);
  assert.match(node(m, 'ask:meeting').label, /1/);
  // 한도 대기: 기다리는 단계의 카드(첫 카드) 옆에 한도 대기 마디
  assert.deepEqual(edges(m, 'quota'), ['card:k3>quota']);
  assert.equal(node(m, 'quota').state, 'wait');
  // 상태마다 글자와 모양이 다르다(색만으로 구분하지 않는다)
  const infos = FLOW_STATES.map((s) => stateInfo(s));
  assert.equal(new Set(infos.map((x) => x.word)).size, FLOW_STATES.length);
  assert.equal(new Set(infos.map((x) => x.shape)).size, FLOW_STATES.length);
  assert.ok(infos.every((x) => x.icon && x.word));
});

test('3. 단계표 목표: 팀의 일 단계가 차례로, 회의 단계에서 물은 질문은 그 단계 옆에, 검수자가 없으면 검수 마디 없음', () => {
  const g = { id: 'G2', status: 'done', goal: '목표', confirmedAt: 10, cardMsgId: 'mg', reviewerId: null, work: 'stages', prep: { research: false, meeting: false }, log: [], returns: 0,
    decided: [{ stageIndex: 1, question: 'q', answer: 'a', at: 3 }], reportMsgId: 'mRep' };
  const run = { id: 'R2', mission: 'work', missionId: 'G2', status: 'done', stages: [
    { label: '만들기', status: 'done', agentIds: ['b'] }, { label: '논의', status: 'done', agentIds: ['b', 'w'], meeting: { rounds: 2 } }, { label: '정리', status: 'skipped', agentIds: ['w'] },
  ] };
  const messages = [{ id: 'a1', role: 'agent', runId: 'R2', stageIndex: 0, agentId: 'b', status: 'done' }, { id: 'a2', role: 'agent', runId: 'R2', stageIndex: 0, agentId: 'b', status: 'done' },
    { id: 'a3', role: 'agent', runId: 'R2', stageIndex: 1, agentId: 'b', status: 'done', meeting: { phase: 'conclude' } }];
  const m = flowModel({ mission: g, runs: [run], messages, nameOf });
  assert.deepEqual(ids(m), ['goal', 'stage:0', 'stage:1', 'ask:stage:1', 'stage:2', 'report']);
  assert.deepEqual(m.nodes.filter((n) => n.kind !== 'ask').map((n) => n.rank), [0, 1, 2, 3, 4]);
  assert.equal(node(m, 'stage:0').msgId, 'a2', '단계의 마지막 답');
  assert.equal(node(m, 'stage:1').msgId, 'a3');
  assert.equal(node(m, 'stage:2').state, 'skipped');
  assert.equal(node(m, 'report').state, 'done');
  assert.equal(node(m, 'report').msgId, 'mRep');
  assert.deepEqual(edges(m, 'flow'), ['goal>stage:0', 'stage:0>stage:1', 'stage:1>stage:2', 'stage:2>report']);
  // 목표가 없으면 빈 그림
  assert.deepEqual(flowModel({ mission: null }).nodes, []);
  // 카드를 아직 못 쓴 확인 전 목표: 목표 잡기만(기다림)
  const draft = flowModel({ mission: { id: 'G3', status: 'draft', goal: '', log: [], cardMsgId: 'mc' }, runs: [], messages: [] });
  assert.deepEqual(ids(draft), ['goal', 'report']);
  assert.equal(node(draft, 'goal').state, 'wait');
  // 멈춘 목표: 남은 대목은 멈춤
  const stopped = flowModel({ mission: { ...g, status: 'stopped', reportMsgId: null }, runs: [{ ...run, status: 'stopped', stages: run.stages.map((s, k) => ({ ...s, status: k === 2 ? 'stopped' : s.status })) }], messages, nameOf });
  assert.equal(node(stopped, 'stage:2').state, 'stopped');
});

test('4. 자리 잡기: 420px 창의 패널 너비(306px)와 넓은 너비 모두 가로로 넘치지 않고, 물결은 같은 줄(넘치면 줄바꿈), 선은 마디 사이', () => {
  const g = cardGoal({ cards: [1, 2, 3, 4, 5, 6].map((k) => card(`k${k}`, 'b', { status: 'done' })) });
  const run = cardRun({}, [['k1', 'k2', 'k3', 'k4', 'k5', 'k6']]);
  const model = flowModel({ mission: g, runs: [run], messages: [], nameOf });
  for (const width of [306, 330, 520]) {
    const L = flowLayout(model, { width });
    assert.equal(L.width, width);
    for (const n of L.nodes) {
      assert.ok(n.x >= 0 && n.x + n.w <= width, `${width}px: ${n.id} 가 넘침(${n.x}+${n.w})`);
      assert.ok(n.y >= 0 && n.y + n.h <= L.height, `${width}px: ${n.id} 높이`);
    }
    // 같은 물결 카드끼리는 줄이 같거나(들어가면) 아래로 이어진다. 다른 대목과는 줄이 겹치지 않는다
    const cards = L.nodes.filter((n) => n.kind === 'card');
    const plan = L.nodes.find((n) => n.id === 'plan');
    const review = L.nodes.find((n) => n.id === 'review');
    assert.ok(cards.every((c) => c.y > plan.y + plan.h && c.y + c.h < review.y), `${width}px: 카드는 계획과 검수 사이`);
    // 겹치는 마디 없음
    for (const a of L.nodes) for (const b of L.nodes) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${width}px: ${a.id}·${b.id} 겹침`);
    // 선마다 그릴 길(SVG path)
    assert.ok(L.edges.every((e) => /^M[\d.]+ [\d.]+ /.test(e.d)), `${width}px: 선 경로`);
    // 글이 마디 너비에 맞게 잘린다(넘치는 글이 그림 밖으로 나가지 않게)
    assert.ok(L.nodes.every((n) => fitText(n.text, n.w - 30, 12) === n.text));
  }
  const narrow = flowLayout(model, { width: 306 });
  const wide = flowLayout(model, { width: 900 });
  const rows = (L) => new Set(L.nodes.filter((n) => n.kind === 'card').map((n) => n.y)).size;
  assert.ok(rows(narrow) > 1, '좁으면 카드 여섯 장이 여러 줄');
  assert.equal(rows(wide), 1, '넓으면 한 줄');
  // 너무 좁아도(최소 너비) 마디 하나 너비로 넘치지 않는다
  const tiny = flowLayout(model, { width: 120 });
  assert.ok(tiny.nodes.every((n) => n.x + n.w <= 120));
});

test('5. 글 맞추기와 키보드 이동: 옆 마디(좌우), 위아래 줄의 가장 가까운 마디, Home·End', () => {
  assert.equal(fitText('짧은 글', 200, 12), '짧은 글');
  const cut = fitText('아주 긴 카드 제목이 마디 너비를 넘어가는 경우를 본다', 80, 12);
  assert.ok(cut.endsWith('…') && cut.length < 20, cut);
  const g = cardGoal();
  const L = flowLayout(flowModel({ mission: g, runs: [cardRun()], messages: [], nameOf }), { width: 330 });
  assert.equal(flowNext(L, 'card:k1', 'ArrowRight'), 'card:k2');
  assert.equal(flowNext(L, 'card:k2', 'ArrowLeft'), 'card:k1');
  assert.equal(flowNext(L, 'card:k2', 'ArrowRight'), 'card:k2', '줄 끝이면 그대로');
  assert.equal(flowNext(L, 'plan', 'ArrowDown').startsWith('card:'), true);
  assert.equal(flowNext(L, 'card:k3', 'ArrowDown'), 'review');
  assert.equal(flowNext(L, 'review', 'ArrowUp'), 'card:k3');
  assert.equal(flowNext(L, 'goal', 'ArrowUp'), 'goal');
  assert.equal(flowNext(L, 'card:k2', 'Home'), 'goal');
  assert.equal(flowNext(L, 'goal', 'End'), 'report');
  assert.equal(flowNext(L, 'goal', 'x'), null, '다른 키는 이동 없음');
});
