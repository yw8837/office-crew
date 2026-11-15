// 헛도는 에이전트: 출력은 계속 나오는데 같은 알림·같은 도구 호출만 되풀이하면 끄고, 다시 시도하면 새 대화로 시작한다(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

let t, agent;
before(async () => {
  t = await startTestApp();
  agent = (await t.api('POST', '/api/agents', { name: '헛도는담당', role: '조사', provider: 'codex', model: 'gpt-6-luna', permission: 'plan', routing: 'manual', skills: [] })).json;
});
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const open = async (text) => {
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: agent.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
  return s.id;
};
const sess = (id) => t.app.store.getSession(id);
const run = (id) => sess(id).runs.at(-1);
const replies = (id) => sess(id).messages.filter((m) => m.role === 'agent');
const held = (id) => t.waitFor(() => run(id)?.status === 'waiting' && run(id).hold?.reason === 'error', 20000, '오류 대기');
const ctl = (id, body) => t.api('POST', `/api/sessions/${id}/control`, body);
const codexRuns = () => t.fakeLog().filter((l) => l.cli === 'codex');

test('같은 알림을 되풀이하면 헛도는 걸로 보고 끈다. 알림은 한 줄로 묶인다', async () => {
  const id = await open('LOOPNOW 조사해 줘');
  await held(id);
  const m = replies(id).at(-1);
  assert.equal(m.status, 'error');
  assert.match(m.error, /10번 되풀이해서 헛도는 걸로 보고 껐어/);
  const warns = m.blocks.filter((b) => b.kind === 'notice' && b.text.startsWith('Heads up'));
  assert.equal(warns.length, 1, '같은 경고는 한 줄');
  assert.equal(warns[0].count, 10);
  assert.ok(m.text.length < 400, '400번 돌기 전에 껐다');
  assert.match(JSON.stringify(t.app.store.sessionMeta(sess(id))), /"kind":"decide"/, '기다리는 일에 뜬다');
  // 다시 시도하면 헛돌던 CLI 대화를 이어 가지 않고 새 대화로 시작한다
  assert.equal(sess(id).providerSessions[agent.id], undefined);
  const before = codexRuns().length;
  await ctl(id, { action: 'retry' });
  await t.waitFor(() => codexRuns().length > before, 15000, '다시 시도');
  assert.ok(!codexRuns().at(-1).args.includes('resume'), '새 대화');
  await held(id);
  await ctl(id, { action: 'stop' });
  await t.waitFor(() => run(id).endedAt);
});

test('같은 도구를 같은 입력으로 되풀이해도 끈다', async () => {
  const id = await open('LOOPTOOL 계획만 세우기');
  await held(id);
  const m = replies(id).at(-1);
  assert.match(m.error, /20번 되풀이해서 헛도는 걸로 보고 껐어/);
  await ctl(id, { action: 'stop' });
  await t.waitFor(() => run(id).endedAt);
});

test('멈춤 감지를 꺼도 되풀이 감지는 한다', async () => {
  await t.api('PUT', '/api/settings', { stallMinutes: 0 });
  try {
    const id = await open('LOOPNOW 멈춤 감지 끔');
    await held(id);
    assert.match(replies(id).at(-1).error, /헛도는 걸로 보고 껐어/);
    await ctl(id, { action: 'stop' });
    await t.waitFor(() => run(id).endedAt);
  } finally {
    await t.api('PUT', '/api/settings', { stallMinutes: 30 });
  }
});

test('몇 번 되풀이하다 끝나는 실행은 끄지 않고, 이어 갈 대화도 그대로 둔다', async () => {
  const id = await open('LOOPFEW 조금만 경고');
  await t.waitFor(() => run(id)?.endedAt, 15000, '실행 끝');
  const m = replies(id).at(-1);
  assert.equal(run(id).status, 'done');
  assert.equal(m.status, 'done');
  assert.equal(m.blocks.find((b) => b.kind === 'notice' && b.text.startsWith('Heads up')).count, 9);
  assert.ok(sess(id).providerSessions[agent.id], '정상으로 끝난 대화는 이어 갈 수 있다');
});

test('영어 설정에서도 끈 뒤에 저절로 다시 돌지 않는다(오류 문구의 낱말을 이어하기 실패로 보지 않는다)', async () => {
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: agent.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '먼저 보통 요청' });
  await t.waitFor(() => run(s.id)?.endedAt, 15000, '첫 실행 끝');
  assert.ok(sess(s.id).providerSessions[agent.id], '이어 갈 대화가 있다');
  t.app.store.settings.lang = 'en';
  try {
    const before = codexRuns().length;
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text: 'LOOPNOW again' });
    await held(s.id);
    assert.match(replies(s.id).at(-1).error, /stuck in a loop/);
    assert.equal(codexRuns().length - before, 1, 'CLI는 한 번만 시작됐다');
    assert.ok(codexRuns().at(-1).args.includes('resume'));
    await ctl(s.id, { action: 'stop' });
    await t.waitFor(() => run(s.id).endedAt);
  } finally {
    t.app.store.settings.lang = 'ko';
  }
});
