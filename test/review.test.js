// 검수 강화: 검수 역할은 결론이 아니라 직접 확인한 증거로 판정하라는 지침을 받고,
// 검수 대상(빌드)을 만든 AI가 그대로 검수하면 "같은 AI 검수"로 알린다(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

let t;
before(async () => {
  t = await startTestApp();
  // 이어받기 시나리오용: Claude·Codex 를 로그인된 것으로 두고 모델 목록을 고정한다
  const reg = t.app.providers;
  reg.detected = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true } };
  reg.modelCache = {
    claude: { at: Date.now(), version: '', list: [{ id: 'opus', label: 'Opus', tier: 'top' }, { id: 'sonnet', label: 'Sonnet', tier: 'balanced' }] },
    codex: { at: Date.now(), version: '', list: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'top', efforts: ['low', 'medium', 'high', 'xhigh'] }, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'balanced', efforts: ['low', 'medium', 'high'] }] },
  };
});
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });
beforeEach(() => { t.app.orch.cooldown.map.clear(); t.app.store.usage.limits = {}; t.app.store.settings.failover = true; });

const agent = async (a) => (await t.api('POST', '/api/agents', { routing: 'manual', ...a })).json;
const runTeam = async (stages, text) => {
  const team = (await t.api('POST', '/api/teams', { name: `검수 팀 ${stages.length}-${Date.now()}`, stages })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: team.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 20000, '실행 종료');
  return t.app.store.getSession(s.id);
};
const reviewMsg = (s) => s.messages.find((m) => m.role === 'agent' && m.stageLabel === '검수');
const sameAiNotice = (m) => m.blocks.find((b) => b.kind === 'notice' && /같은 AI\(.+\)가 만든 결과를 같은 AI가 검수/.test(b.text));

test('R-b 빌드한 AI가 그대로 검수하면(모델이 달라도) "같은 AI 검수" 알림이 붙고, 검수 역할 지침에만 증거로 판정하라는 규칙이 들어간다', async () => {
  const b = await agent({ name: '빌더R1', role: '빌드', provider: 'claude', model: 'opus' });
  const r = await agent({ name: '검수R1', role: '검수', provider: 'claude', model: 'sonnet' });
  const s = await runTeam([{ label: '구현', agentIds: [b.id] }, { label: '검수', agentIds: [r.id] }], '계산기 만들어줘');
  const m = reviewMsg(s);
  assert.equal(m.status, 'done', m.error);
  assert.match(sameAiNotice(m)?.text || '', /같은 AI\(Claude\)/);
  const sys = t.fakeLog().filter((l) => l.cli === 'claude' && l.system);
  assert.match(sys.find((l) => l.system.includes('검수R1')).system, /직접 확인한 증거/);
  assert.ok(!sys.find((l) => l.system.includes('빌더R1')).system.includes('직접 확인한 증거'), '빌드 역할엔 검수 규칙이 없다');
});

test('R-b 다른 AI가 검수하면 알림이 없고, Codex 는 프롬프트 앞 역할 지침으로 검수 규칙을 받는다', async () => {
  const b = await agent({ name: '빌더R2', role: '빌드', provider: 'claude', model: 'opus' });
  const r = await agent({ name: '검수R2', role: '검수', provider: 'codex', model: 'gpt-6.1-sol' });
  const s = await runTeam([{ label: '구현', agentIds: [b.id] }, { label: '검수', agentIds: [r.id] }], '계산기 만들어줘 2');
  const m = reviewMsg(s);
  assert.equal(m.status, 'done', m.error);
  assert.equal(m.provider, 'codex');
  assert.equal(sameAiNotice(m), undefined);
  assert.match(t.fakeLog().filter((l) => l.cli === 'codex').at(-1).prompt, /검수R2[\s\S]*직접 확인한 증거/);
});

test('R-b 빌드와 검수 사이에 다른 AI 단계가 있어도, 검수하는 AI가 빌드한 AI와 같으면 알린다', async () => {
  const b = await agent({ name: '빌더R3', role: '빌드', provider: 'claude', model: 'opus' });
  const o = await agent({ name: '정리R3', role: '정리', provider: 'codex', model: 'gpt-6.1-sol' });
  const r = await agent({ name: '검수R3', role: '검수', provider: 'claude', model: 'opus' });
  const s = await runTeam([{ label: '구현', agentIds: [b.id] }, { label: '정리', agentIds: [o.id] }, { label: '검수', agentIds: [r.id] }], '계산기 만들어줘 3');
  const m = reviewMsg(s);
  assert.equal(m.status, 'done', m.error);
  assert.match(sameAiNotice(m)?.text || '', /같은 AI\(Claude\)/);
});

test('R-b 검수 중 한도로 이어받은 AI가 빌드한 AI와 같아지면 그때 알린다', async () => {
  const b = await agent({ name: '빌더R4', role: '빌드', provider: 'codex', model: 'gpt-6.1-sol' });
  const r = await agent({ name: '검수R4', role: '검수', provider: 'claude', model: 'opus' });
  const s = await runTeam([{ label: '구현', agentIds: [b.id] }, { label: '검수', agentIds: [r.id] }], 'QUOTAFAIL 검수까지 해줘');
  const m = reviewMsg(s);
  assert.equal(m.status, 'done', m.error);
  assert.equal(m.provider, 'codex', '한도로 Codex 가 이어받음');
  assert.match(sameAiNotice(m)?.text || '', /같은 AI\(ChatGPT · Codex\)/);
});
