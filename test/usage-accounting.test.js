// Claude 사용량 정산: 하위 에이전트 몫까지 세고(modelUsage), 이어 간 대화의 누적은 직전 누적을 빼서 겹쳐 세지 않는다(가짜 값, 실제 AI 사용량 0)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treeTotals, settleClaude } from '../server/usage.js';

const MAIN = { input: 10, output: 5, cacheRead: 100, cacheWrite: 50 };
const model = (input, output, cacheRead, cacheWrite, costUSD) => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite, costUSD });
const tokens = (r) => ({ input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('모델별 사용량 합: 모든 모델을 더하고, 없거나 이상하면 null', () => {
  assert.deepEqual(treeTotals({ 'claude-opus-x': model(10, 5, 100, 50, 0.01), 'claude-haiku-x': model(200, 40, 0, 0, 0.002) }),
    { input: 210, output: 45, cacheRead: 100, cacheWrite: 50, cost: 0.012 });
  assert.deepEqual(treeTotals({ 'claude-opus-x': { inputTokens: 3, outputTokens: 1 } }), { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, '빠진 칸은 0');
  assert.equal(treeTotals(null), null);
  assert.equal(treeTotals(undefined), null);
  assert.equal(treeTotals({}), null, '모델이 하나도 없으면 모른다');
  assert.equal(treeTotals([model(1, 1, 1, 1, 0)]), null, '배열은 모양이 다르다');
  assert.equal(treeTotals({ a: model(-1, 0, 0, 0, 0) }), null, '음수');
  assert.equal(treeTotals({ a: model('5', 0, 0, 0, 0) }), null, '숫자가 아님');
  assert.equal(treeTotals({ a: null }), null);
});

test('하위 에이전트가 없으면 이번 몫 = 주 에이전트 몫', () => {
  const r = settleClaude({ usage: MAIN, modelUsage: { main: model(10, 5, 100, 50, 0.01) }, totalCost: 0.01, baseline: null });
  assert.deepEqual(tokens(r), MAIN);
  assert.ok(near(r.cost, 0.01));
  assert.equal(r.partial, false);
  assert.equal(r.sub, 0);
  assert.deepEqual(r.cumulative, { ...MAIN, cost: 0.01 }, '다음 정산의 baseline');
});

test('하위 에이전트가 쓴 양까지 센다(주 에이전트 몫보다 크고 sub 가 남는다)', () => {
  const r = settleClaude({ usage: MAIN, modelUsage: { main: model(10, 5, 100, 50, 0.01), sub: model(200, 40, 0, 0, 0.002) }, totalCost: 0.012, baseline: null });
  assert.deepEqual(tokens(r), { input: 210, output: 45, cacheRead: 100, cacheWrite: 50 });
  assert.equal(r.sub, 240);
  assert.ok(near(r.cost, 0.012));
  assert.equal(r.partial, false);
});

test('이어 간 대화의 누적은 직전 누적을 뺀다(100 → 160 이면 60)', () => {
  const baseline = { input: 100, output: 20, cacheRead: 1000, cacheWrite: 300, cost: 0.2 };
  const r = settleClaude({ usage: { input: 40, output: 10, cacheRead: 400, cacheWrite: 100 }, modelUsage: { main: model(160, 35, 1500, 420, 0.62) }, totalCost: 0.62, baseline, resumed: true });
  assert.deepEqual(tokens(r), { input: 60, output: 15, cacheRead: 500, cacheWrite: 120 });
  assert.equal(r.sub, 60 + 15 + 500 + 120 - (40 + 10 + 400 + 100));
  assert.equal(r.partial, false);
  assert.deepEqual(r.cumulative, { input: 160, output: 35, cacheRead: 1500, cacheWrite: 420, cost: 0.62 });
});

test('비용 누적 0.20 → 0.62 면 이번 비용은 0.42', () => {
  const r = settleClaude({ usage: MAIN, modelUsage: { main: model(20, 10, 200, 100, 0.62) }, totalCost: 0.62, baseline: { ...MAIN, cost: 0.2 }, resumed: true });
  assert.ok(near(r.cost, 0.42), String(r.cost));
});

test('같은 결과를 두 번 넣어도 두 번째가 0이 되지 않는다(누적이 아니라 호출 몫을 내는 CLI 보호)', () => {
  const input = { usage: MAIN, modelUsage: { main: model(10, 5, 100, 50, 0.01), sub: model(200, 40, 0, 0, 0.002) }, totalCost: 0.012 };
  const first = settleClaude({ ...input, baseline: null });
  const second = settleClaude({ ...input, baseline: first.cumulative, resumed: true });
  assert.deepEqual(tokens(second), tokens(first), '이번 값 자체가 이번 몫');
  for (const k of Object.keys(MAIN)) assert.ok(second[k] >= MAIN[k], k);
  assert.ok(near(second.cost, 0.012), '비용도 같은 식으로 이번 값 그대로');
  assert.equal(second.partial, false);
});

test('누적이 줄었으면(초기화) 이번 값을 이번 몫으로 쓰고, 그것도 주 에이전트 몫보다 작으면 주 에이전트 몫', () => {
  const baseline = { input: 500, output: 100, cacheRead: 5000, cacheWrite: 900, cost: 0.5 };
  const r = settleClaude({ usage: MAIN, modelUsage: { main: model(160, 35, 1500, 420, 0.3) }, totalCost: 0.3, baseline, resumed: true });
  assert.deepEqual(tokens(r), { input: 160, output: 35, cacheRead: 1500, cacheWrite: 420 });
  assert.ok(near(r.cost, 0.3), '비용이 음수가 되면 이번 누적 그대로');
  const small = settleClaude({ usage: MAIN, modelUsage: { main: model(1, 1, 1, 1, 0.3) }, totalCost: 0.3, baseline, resumed: true });
  assert.deepEqual(tokens(small), MAIN);
});

test('항목마다 주 에이전트 몫보다 작아지지 않는다', () => {
  // 합은 충분히 늘었지만 캐시 읽기는 줄어든 누적
  const r = settleClaude({ usage: MAIN, modelUsage: { main: model(1000, 500, 50, 400, 0.4) }, totalCost: 0.4, baseline: { input: 0, output: 0, cacheRead: 200, cacheWrite: 0, cost: 0.1 }, resumed: true });
  assert.equal(r.cacheRead, MAIN.cacheRead);
  assert.equal(r.input, 1000);
});

test('modelUsage 가 없으면 받은 값 그대로에 partial(비용은 직전 누적을 뺀다)', () => {
  const r = settleClaude({ usage: MAIN, modelUsage: undefined, totalCost: 0.01, baseline: null });
  assert.deepEqual(tokens(r), MAIN);
  assert.ok(near(r.cost, 0.01));
  assert.equal(r.partial, true);
  assert.equal(r.sub, 0);
  assert.equal(r.cumulative, null, '누적을 모르니 다음 baseline 도 없다');
  const withBase = settleClaude({ usage: MAIN, totalCost: 0.62, baseline: { ...MAIN, cost: 0.2 }, resumed: true });
  assert.ok(near(withBase.cost, 0.42));
  assert.equal(withBase.partial, true);
  const dropped = settleClaude({ usage: MAIN, totalCost: 0.1, baseline: { ...MAIN, cost: 0.2 }, resumed: true });
  assert.ok(near(dropped.cost, 0.1), '음수면 이번 값');
});

test('이어 간 대화인데 직전 누적이 없으면 주 에이전트 몫만 세고 partial(앞 사용량이 섞였을 수 있다)', () => {
  const r = settleClaude({ usage: MAIN, modelUsage: { main: model(9000, 3000, 90000, 20000, 4.2) }, totalCost: 4.2, baseline: null, resumed: true });
  assert.deepEqual(tokens(r), MAIN);
  assert.equal(r.partial, true);
  assert.equal(r.cost, 0, '이번 비용을 알 수 없어 더하지 않는다');
  assert.equal(r.sub, 0);
  assert.deepEqual(r.cumulative, { input: 9000, output: 3000, cacheRead: 90000, cacheWrite: 20000, cost: 4.2 }, '다음 정산부터는 이 누적을 뺀다');
});
