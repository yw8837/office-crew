// 자동 라우팅 엔진: 역할·프로필·로그인 상태에 따른 선택, 노력 단계 보정, 교차 검수
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, roleKind, clampEffort, pickModel } from '../server/routing.js';
import { guessTier } from '../server/providers/util.js';

const providers = [
  { id: 'claude', loggedIn: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'codex', loggedIn: true, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gemini', loggedIn: true, efforts: ['low', 'medium', 'high'] },
  { id: 'openai', loggedIn: false, efforts: [] },
];
const models = {
  claude: [{ id: 'opus', tier: 'top' }, { id: 'sonnet', tier: 'balanced' }, { id: 'haiku', tier: 'fast' }, { id: 'claude-opus-5-5', tier: 'top', legacy: true }],
  codex: [{ id: 'gpt-6.1-sol', tier: 'balanced', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }, { id: 'gpt-6-astra', tier: 'top', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }, { id: 'gpt-6-luna', tier: 'fast', efforts: ['low', 'medium', 'high'] }],
  gemini: [{ id: 'gemini-4-argon', tier: 'top', efforts: ['low', 'medium', 'high'] }, { id: 'gemini-3.8-flash', tier: 'fast', efforts: ['low', 'medium', 'high'] }, { id: 'gpt-oss-120b', tier: 'balanced', efforts: ['medium'] }],
};
const ctx = { providers, models };

test('역할 이름 인식(한·영·중·일)', () => {
  assert.equal(roleKind('조사'), 'research');
  assert.equal(roleKind('Research'), 'research');
  assert.equal(roleKind('构建'), 'build');
  assert.equal(roleKind('レビュー'), 'review');
  assert.equal(roleKind('기획'), 'analysis');
  assert.equal(roleKind('아무거나'), 'general');
});

test('균형 프로필: 분석은 Claude 최상 모델·하이, 빌드는 X하이', () => {
  const a = resolveRoute({ role: '분석', routingProfile: 'balanced' }, ctx);
  assert.deepEqual([a.provider, a.model, a.effort], ['claude', 'opus', 'high']);
  const b = resolveRoute({ role: '빌드', routingProfile: 'balanced' }, ctx);
  assert.deepEqual([b.provider, b.model, b.effort], ['claude', 'opus', 'xhigh']);
});

test('경제 프로필은 한 단계 낮은 모델·로우, 최고 프로필은 최상 모델', () => {
  const e = resolveRoute({ role: '조사', routingProfile: 'economy' }, ctx);
  assert.deepEqual([e.provider, e.model, e.effort], ['claude', 'haiku', 'low']);
  const t = resolveRoute({ role: '정리', routingProfile: 'best' }, ctx);
  assert.deepEqual([t.provider, t.model], ['codex', 'gpt-6-astra']);
});

test('로그인 안 된 AI 는 건너뛰고, 아무것도 없으면 null', () => {
  const only = { providers: providers.map((p) => ({ ...p, loggedIn: p.id === 'codex' })), models };
  assert.equal(resolveRoute({ role: '분석' }, only).provider, 'codex');
  assert.equal(resolveRoute({ role: '분석' }, { providers: [], models: {} }), null);
});

test('검수는 빌드와 다른 AI 로 교차 검증', () => {
  const r = resolveRoute({ role: '검수', routingProfile: 'balanced' }, { ...ctx, avoid: 'codex' });
  assert.notEqual(r.provider, 'codex');
});

test('노력 단계 보정과 모델 고르기', () => {
  assert.equal(clampEffort('xhigh', ['low', 'medium', 'high']), 'high');
  assert.equal(clampEffort('low', ['medium']), 'medium');
  assert.equal(clampEffort('high', []), '');
  assert.equal(pickModel(models.claude, 'top').id, 'opus', '구형(legacy) 고정 모델은 자동 선택에서 제외');
  assert.equal(guessTier('Fast and affordable model'), 'fast');
  assert.equal(guessTier('Frontier intelligence'), 'top');
});

test('여러 회사 모델을 파는 경로에서도 자기 계열(Gemini)을 먼저 고른다', () => {
  const m = { ...models, gemini: [{ id: 'claude-sonnet-5-5', tier: 'balanced', efforts: ['low', 'medium', 'high'] }, ...models.gemini] };
  const only = providers.map((p) => ({ ...p, loggedIn: p.id === 'gemini' }));
  const r = resolveRoute({ role: '조사', routingProfile: 'balanced' }, { providers: only, models: m });
  assert.equal(r.provider, 'gemini');
  assert.match(r.model, /gemini/);
});
