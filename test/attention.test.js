// 사이드바 "기다리는 일": 세션 요약의 attention 이 실행 상태(승인·결정 대기, 끝남)를 따라간다(가짜 모델, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { attentionOf } from '../server/store.js';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const metaOf = async (id) => (await t.api('GET', '/api/bootstrap')).json.sessions.find((s) => s.id === id);
const sessionEvent = (id, kind) => t.events.find((e) => e.type === 'session' && e.data.id === id && e.data.attention?.kind === kind);

test('승인 대기에 들어가면 세션 요약이 "승인 필요"가 되고, 승인 뒤 끝나면 "결과 확인"이 된다', async () => {
  const s = (await t.api('POST', '/api/sessions', { teamId: 'team-demo' })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '시장 조사해줘' });
  await t.waitFor(() => sessionEvent(s.id, 'approve'), 15000, '승인 필요 요약');
  const waiting = await metaOf(s.id);
  assert.equal(waiting.attention.kind, 'approve');
  assert.ok(waiting.attention.since > 0 && waiting.attention.runId, '언제부터 기다렸는지와 실행 id');
  assert.equal((await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'approve' })).json.ok, true);
  await t.waitFor(() => sessionEvent(s.id, 'done'), 20000, '결과 확인 요약');
  assert.equal((await metaOf(s.id)).attention.kind, 'done');
});

test('종류 판별: 결정 대기·일시정지·오류·끝남은 표시하고, 사용자가 중지한 실행과 실행 중은 표시하지 않는다', () => {
  const base = { id: 'r1', startedAt: 1 };
  assert.equal(attentionOf({ ...base, status: 'waiting', hold: { reason: 'error', at: 5 } }).kind, 'decide');
  assert.equal(attentionOf({ ...base, status: 'waiting', hold: { reason: 'approve', at: 5 } }).since, 5);
  assert.equal(attentionOf({ ...base, status: 'paused', hold: { reason: 'pause', at: 7 } }).kind, 'paused');
  assert.deepEqual(attentionOf({ ...base, status: 'error', endedAt: 9 }), { kind: 'failed', runId: 'r1', since: 9 });
  assert.equal(attentionOf({ ...base, status: 'done', endedAt: 9 }).kind, 'done');
  for (const status of ['stopped', 'running']) assert.equal(attentionOf({ ...base, status }), null, status);
  assert.equal(attentionOf(undefined), null);
});
