// Claude 사용량 정산: 하위 에이전트 몫까지 세고(modelUsage), 이어 간 대화의 누적은 직전 누적을 빼서 겹쳐 세지 않는다(가짜 값·가짜 CLI, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { treeTotals, settleClaude } from '../server/usage.js';
import { meetingSpend } from '../server/orchestrator.js';
import { startTestApp } from './helpers.js';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

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

// ── 앱에서: 가짜 claude 의 SUBUSE(하위 에이전트 몫을 modelUsage 에 싣는다)·CUMUL(이어 간 대화의 누적을 낸다) ──
const runs = (sid) => t.app.store.getSession(sid).runs;
const replies = (sid) => t.app.store.getSession(sid).messages.filter((m) => m.role === 'agent');
const claude = async (name, role = '분석') => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'sonnet', permission: 'plan', routing: 'manual' })).json;
const solo = async (a) => (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
const say = async (sid, text) => {
  const n = runs(sid).length;
  await t.api('POST', `/api/sessions/${sid}/messages`, { text });
  await t.waitFor(() => runs(sid).length > n && runs(sid).at(-1).endedAt, 15000, '실행 끝');
};
const results = (from) => t.fakeLog().slice(from).filter((l) => l.cli === 'claude' && l.result).map((l) => l.result);
const total = (u) => u.input + u.output + u.cacheRead + u.cacheWrite;
const snapshot = async () => (await t.api('GET', '/api/usage')).json;

test('하위 에이전트를 쓴 실행: 메시지 사용량에 하위 에이전트 몫이 들어가고, 오늘·에이전트별 합계도 같은 값을 더한다', async () => {
  const a = await claude('하위쓰기');
  const s = await solo(a);
  const today0 = (await snapshot()).today.claude || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  await say(s.id, 'SUBUSE 조사해줘');
  const [m] = replies(s.id);
  assert.equal(m.status, 'done', m.error);
  assert.ok(total(m.usage) > total(MAIN), `주 에이전트 몫(${total(MAIN)})보다 커야 함: ${total(m.usage)}`);
  assert.deepEqual(tokens(m.usage), { input: 210, output: 45, cacheRead: 100, cacheWrite: 50 });
  assert.equal(m.usage.sub, 240);
  assert.ok(near(m.usage.cost, 0.012), String(m.usage.cost));
  assert.equal(m.usage.partial, undefined);
  const u = await snapshot();
  assert.deepEqual(tokens(u.byAgent[a.id]), tokens(m.usage), '에이전트별 합계도 정산한 값');
  assert.ok(near(u.byAgent[a.id].cost, m.usage.cost));
  assert.equal(total(u.today.claude) - total(today0), total(m.usage), '오늘 합계도 정산한 값만큼 늘었다');
});

test('같은 대화를 이어 가면(누적을 내는 CLI) 두 메시지의 합이 마지막 누적값과 같다(겹쳐 세지 않는다)', async () => {
  const a = await claude('누적');
  const s = await solo(a);
  const from = t.fakeLog().length;
  await say(s.id, 'CUMUL SUBUSE 첫째');
  await say(s.id, 'CUMUL SUBUSE 둘째');
  const args = t.fakeLog().slice(from).filter((l) => l.cli === 'claude' && l.args).map((l) => l.args);
  assert.equal(args.length, 2);
  assert.ok(args[1].includes('--resume'), '두 번째는 같은 대화를 이어 갔다');
  const ms = replies(s.id);
  const last = results(from).at(-1);
  const cum = treeTotals(last.modelUsage);
  assert.ok(near(ms[0].usage.cost + ms[1].usage.cost, last.total_cost_usd), `${ms[0].usage.cost} + ${ms[1].usage.cost} ≠ ${last.total_cost_usd}`);
  for (const k of Object.keys(MAIN)) assert.equal(ms[0].usage[k] + ms[1].usage[k], cum[k], k);
  assert.ok(ms.every((m) => !m.usage.partial));
  const sess = t.app.store.getSession(s.id);
  assert.equal(sess.usageBase[a.id].id, sess.providerSessions[a.id], 'baseline 은 이어 갈 대화 id 와 같이 둔다');
});

test('한 실행에서 결과가 두 번 와도(질문에 답한 뒤 같은 대화로 이어 감) 두 번 세지 않는다', async () => {
  const a = await claude('묻고누적', '정리');
  const s = await solo(a);
  const from = t.fakeLog().length;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: 'ASKME CUMUL 해줘' });
  const ask = await t.waitFor(() => replies(s.id)[0]?.asks?.find((x) => x.status === 'open'), 15000, '질문');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'answer', askId: ask.id, skip: true });
  await t.waitFor(() => runs(s.id).at(-1)?.endedAt, 15000, '실행 끝');
  const [m] = replies(s.id);
  assert.equal(m.status, 'done', m.error);
  const rs = results(from);
  assert.equal(rs.length, 2, '결과가 두 번 왔다');
  assert.ok(near(m.usage.cost, rs[1].total_cost_usd), `${m.usage.cost} ≠ ${rs[1].total_cost_usd}`);
  assert.deepEqual(tokens(m.usage), tokens(treeTotals(rs[1].modelUsage)));
});

test('modelUsage 가 없는 결과는 예전과 같은 숫자에 partial 만 붙는다(같은 대화를 이어 가도)', async () => {
  const a = await claude('예전형식');
  const s = await solo(a);
  await say(s.id, '첫째');
  await say(s.id, '둘째');
  const ms = replies(s.id);
  assert.equal(ms.length, 2);
  for (const m of ms) {
    assert.deepEqual(tokens(m.usage), MAIN);
    assert.equal(m.usage.cost, 0.01);
    assert.equal(m.usage.partial, true);
    assert.equal(m.usage.sub, undefined);
  }
  assert.equal(t.app.store.getSession(s.id).usageBase?.[a.id], undefined, '누적을 모르면 baseline 을 남기지 않는다');
});

test('회의 사용량 상한은 하위 에이전트가 쓴 양까지 센다', async () => {
  const a = await claude('상한갑'), b = await claude('상한을');
  const mainOnly = meetingSpend(MAIN); // 75
  const withSub = meetingSpend({ input: 210, output: 45, cacheRead: 100, cacheWrite: 50 }); // 315
  const cap = 400; // 1바퀴(의견 2건): 주 에이전트 몫만 세면 150 이라 안 닿고, 하위 에이전트까지 세면 630 이라 닿는다
  assert.ok(mainOnly * 2 < cap && withSub * 2 >= cap);
  const tm = (await t.api('POST', '/api/teams', { name: '상한 회의', stages: [{ label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 3, tokenCap: cap } }] })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: tm.id })).json;
  await say(s.id, 'SUBUSE 정하자');
  const all = t.app.store.getSession(s.id).messages;
  assert.deepEqual(all.filter((m) => m.meeting).map((m) => m.meeting.phase), ['opinion', 'opinion', 'conclude'], '1바퀴 뒤 상한에 닿아 결론으로');
  assert.ok(all.some((m) => m.role === 'system' && m.text.includes(`회의에서 쓴 양(약 ${withSub * 2} 토큰)`)), '하위 에이전트 몫까지 센 양을 알린다');
});

test('대화를 비우면 직전 누적을 버리고, 불러온 대화를 처음 이어 갈 때는 앞 사용량을 세지 않고 partial 로 둔다', async () => {
  const a = await claude('비우기');
  const s = await solo(a);
  const from = t.fakeLog().length;
  await say(s.id, 'CUMUL 첫째');
  assert.ok(t.app.store.getSession(s.id).usageBase[a.id]);
  assert.equal((await t.api('POST', `/api/sessions/${s.id}/clear`)).status, 200);
  assert.equal(t.app.store.getSession(s.id).usageBase, undefined, '비우면 버린다');
  await say(s.id, 'CUMUL 둘째');
  const args = t.fakeLog().slice(from).filter((l) => l.cli === 'claude' && l.args).map((l) => l.args);
  assert.ok(!args[1].includes('--resume'), '비운 뒤에는 새 대화');
  const [m] = replies(s.id);
  assert.ok(near(m.usage.cost, 0.01) && !m.usage.partial, '새 대화의 첫 결과는 그 누적 그대로');

  // 불러온 Claude 대화처럼: 이어 갈 대화 id 만 있고 직전 누적은 없다(처음 이어 갈 때 갈래로 시작한다)
  const b = await claude('불러옴');
  const s2 = await solo(b);
  Object.assign(t.app.store.getSession(s2.id), { providerSessions: { [b.id]: 'imported-x' }, sessionProvider: { [b.id]: 'claude' }, importedFrom: { source: 'claude', id: 'imported-x', agentId: b.id } });
  await say(s2.id, 'CUMUL SUBUSE 이어서');
  const forkArgs = t.fakeLog().filter((l) => l.cli === 'claude' && l.args).at(-1).args;
  assert.ok(forkArgs.includes('--fork-session'));
  const [m2] = replies(s2.id);
  assert.deepEqual(tokens(m2.usage), MAIN, '주 에이전트 몫만');
  assert.equal(m2.usage.cost, 0);
  assert.equal(m2.usage.partial, true);
  const base = t.app.store.getSession(s2.id).usageBase[b.id];
  assert.equal(base.id, t.app.store.getSession(s2.id).providerSessions[b.id], '다음 호출부터는 갈래 대화의 누적을 뺀다');
});
