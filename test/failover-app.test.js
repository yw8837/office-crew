// 자동 이어받기: 한도에 걸린 AI 대신 다른 AI가 이어서 끝내기(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

let t;
before(async () => {
  t = await startTestApp();
  // 테스트에선 실제 탐지를 안 하므로 Claude·Codex 를 로그인된 것으로 두고 모델 목록을 고정한다
  const reg = t.app.providers;
  reg.detected = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true } };
  reg.modelCache = {
    claude: { at: Date.now(), version: '', list: [{ id: 'opus', label: 'Opus', tier: 'top' }, { id: 'sonnet', label: 'Sonnet', tier: 'balanced' }] },
    codex: { at: Date.now(), version: '', list: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'top', efforts: ['low', 'medium', 'high', 'xhigh'] }, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'balanced', efforts: ['low', 'medium', 'high'] }] },
  };
});
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });
beforeEach(() => { t.app.orch.cooldown.map.clear(); t.app.store.usage.limits = {}; t.app.store.settings.failover = true; });

const runOnce = async (agent, text) => {
  const a = (await t.api('POST', '/api/agents', agent)).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt || t.app.store.getSession(s.id).runs.at(-1)?.hold, 10000, '실행 종료');
  return { a, s: t.app.store.getSession(s.id) };
};

test('Claude 가 한도에 걸리면 Codex 가 지금까지 쓴 내용을 받아 이어서 끝낸다', async () => {
  const { a, s } = await runOnce({ name: '빌더X', role: '빌드', provider: 'claude', model: 'opus', effort: 'high' }, 'QUOTAFAIL 보고서 써줘');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'done', m.error);
  assert.equal(m.provider, 'codex');
  assert.equal(m.model, 'gpt-6-astra', '같은 역할(빌드)·최상 등급으로');
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && /Claude 사용량 한도에 걸려서 .*이어받아/.test(b.text)));
  assert.match(m.text, /안녕하세요 turn1/, '앞 AI가 쓴 부분 유지');
  assert.match(m.text, /정리 결과: 파란색/, '이어받은 AI의 결과');
  const sent = t.fakeLog().filter((l) => l.cli === 'codex').at(-1).prompt;
  assert.match(sent, /\[이어받기\] Claude이\(가\) 사용량 한도/);
  assert.match(sent, /QUOTAFAIL 보고서 써줘/, '원래 요청 포함');
  assert.match(sent, /안녕하세요 turn1/, '앞 담당이 쓴 내용 포함');
  assert.ok(t.app.orch.cooldown.active('claude'), 'Claude 는 쉬는 중');
  const cd = (await t.api('GET', '/api/cooldown')).json;
  assert.ok(cd.claude?.until > Date.now());
  // 이어갈 대화 id 는 Codex 것으로 기억(다음에 Claude 에 넘기지 않음)
  assert.equal(s.sessionProvider[a.id], 'codex');
});

test('쉬는 중인 AI 를 직접 지정한 에이전트는 실행 전에 다른 AI 로 돌린다 → 해제하면 원래대로', async () => {
  t.app.orch.cooldown.mark('claude', { reason: 'limit' });
  const { s } = await runOnce({ name: '분석X', role: '분석', provider: 'claude', model: 'opus', effort: 'high' }, '분석해줘');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'done');
  assert.equal(m.provider, 'codex');
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && /이번엔 .*가 맡아/.test(b.text)));
  assert.equal((await t.api('DELETE', '/api/cooldown/claude')).status, 200);
  const { s: s2 } = await runOnce({ name: '분석Y', role: '분석', provider: 'claude', model: 'opus', effort: 'high' }, '다시 분석해줘');
  assert.equal(s2.messages.filter((x) => x.role === 'agent').at(-1).provider, 'claude');
});

test('한도 임박(95% 이상)이면 미리 피하고, 자동 라우팅도 쉬는 AI 를 뺀다', async () => {
  t.app.store.usage.limits = { claude: { windows: { five_hour: { pct: 97, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } };
  const { s } = await runOnce({ name: '자동분석', role: '분석', provider: 'claude', routing: 'auto', routingProfile: 'balanced' }, '자동으로 분석');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.provider, 'codex');
  assert.equal(m.status, 'done');
});

test('Codex 도 한도면 다시 Claude 로, 둘 다 막히면 멈추고 알린다 / 꺼져 있으면 넘기지 않는다', async () => {
  // Codex 가 먼저 막힘 → Claude 가 이어받음
  const { s } = await runOnce({ name: '정리X', role: '정리', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }, 'CODEXQUOTA 정리해줘');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'done', m.error);
  assert.equal(m.provider, 'claude');
  // 둘 다 쉬는 중이면 이어받을 AI 가 없다는 알림 + 오류
  t.app.orch.cooldown.mark('codex', { reason: 'limit' });
  const { s: s2 } = await runOnce({ name: '빌더Z', role: '빌드', provider: 'claude', model: 'opus' }, 'QUOTAFAIL 계속');
  const m2 = s2.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m2.status, 'error');
  assert.ok(m2.blocks.some((b) => b.kind === 'notice' && /이어받을 수 있는 다른 AI가 없어/.test(b.text)));
  // 설정에서 끄면 넘기지 않는다
  t.app.orch.cooldown.map.clear();
  await t.api('PUT', '/api/settings', { failover: false });
  const { s: s3 } = await runOnce({ name: '빌더W', role: '빌드', provider: 'claude', model: 'opus' }, 'QUOTAFAIL 꺼짐');
  const m3 = s3.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m3.status, 'error');
  assert.equal(m3.provider, 'claude');
  assert.ok(m3.blocks.some((b) => b.kind === 'notice' && /자동 이어받기가 꺼져 있어서/.test(b.text)));
});
