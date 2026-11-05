// 안정화: 멈춘 실행 감시, 이어 말할 때 놓친 대화 전달(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });
beforeEach(() => { t.app.store.settings.stallMinutes = 30; t.app.store.settings.historyTurns = 8; });

const agent = async (name) => (await t.api('POST', '/api/agents', { name, role: '조사', provider: 'codex', model: 'gpt-6.1-sol', permission: 'plan', routing: 'manual' })).json;
const say = async (sid, text) => {
  const n = t.app.store.getSession(sid).runs.length;
  await t.api('POST', `/api/sessions/${sid}/messages`, { text });
  await t.waitFor(() => { const r = t.app.store.getSession(sid).runs; return r.length > n && (r.at(-1).endedAt || r.at(-1).hold); }, 15000, '실행 끝');
};
const lastPrompt = () => t.fakeLog().filter((l) => l.cli === 'codex' && l.prompt).at(-1).prompt;

test('출력 없이 멈춘 실행은 끄고 오류로 돌린다', async () => {
  t.app.store.settings.stallMinutes = 0.01; // 0.6초
  const a = await agent('멈춤담당');
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  const t0 = Date.now();
  await say(s.id, 'HANGNOW 해줘');
  assert.ok(Date.now() - t0 < 12000, '바로 끝난다');
  const sess = t.app.store.getSession(s.id);
  const m = sess.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'error');
  assert.match(m.error, /아무 출력이 없어서/);
  assert.equal(sess.runs.at(-1).hold?.reason, 'error', '기존 오류 결정 단계로 간다');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1).endedAt, 5000, '중지');
});

test('사람이 멈춘 건 오류로 안 보고, 시간을 0으로 두면 감시하지 않는다', async () => {
  t.app.store.settings.stallMinutes = 0;
  const a = await agent('감시끔');
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: 'HANGNOW 감시 끔' });
  await new Promise((r) => setTimeout(r, 1500));
  const running = t.app.store.getSession(s.id).runs.at(-1);
  assert.ok(!running.endedAt && !running.hold, '0이면 안 끈다');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1).endedAt, 8000, '중지');
  const m = t.app.store.getSession(s.id).messages.filter((x) => x.role === 'agent').at(-1);
  assert.notEqual(m.status, 'error');
});

test('설정 값은 0~1440 분으로 저장한다', async () => {
  assert.equal((await t.api('PUT', '/api/settings', { stallMinutes: 99999 })).json.stallMinutes, 1440);
  assert.equal((await t.api('PUT', '/api/settings', { stallMinutes: -3 })).json.stallMinutes, 0);
  await t.api('PUT', '/api/settings', { stallMinutes: 30 });
});

test('A→B→A: 다시 맡은 A 는 B 와 오간 대화를 받고, 자기 말과 지금 요청은 중복으로 받지 않는다', async () => {
  const a = await agent('에이담당');
  const b = await agent('비담당');
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await say(s.id, '@에이담당 첫 질문이야');
  assert.doesNotMatch(lastPrompt(), /지난번 답한 뒤/, '처음엔 없다');
  await say(s.id, '@비담당 비밀번호 말고 색깔을 정해줘');
  await say(s.id, '@에이담당 아까 뭐로 정했어?');
  const p = lastPrompt();
  assert.match(p, /\[네가 지난번 답한 뒤 오간 대화\]/);
  assert.match(p, /사용자: (@비담당 )?비밀번호 말고 색깔을 정해줘/);
  assert.match(p, /비담당: /, 'B 의 답');
  assert.doesNotMatch(p, /첫 질문이야/, 'A 가 이미 아는 말은 빼');
  const mark = p.match(/--- 대화 ([0-9a-f]{8}) 시작 ---/)?.[1];
  assert.ok(mark && p.includes(`--- 대화 ${mark} 끝 ---`), '구획');
  assert.ok(p.indexOf(`대화 ${mark} 끝`) < p.indexOf('아까 뭐로 정했어'), '구획 안에 지금 요청이 없다');
  // 바로 이어서 A 에게 또 말하면 놓친 대화가 없다
  await say(s.id, '@에이담당 고마워');
  assert.doesNotMatch(lastPrompt(), /지난번 답한 뒤/);
});

test('최근 대화 수를 0으로 두면 놓친 대화를 안 넣는다', async () => {
  t.app.store.settings.historyTurns = 0;
  const a = await agent('에이둘');
  const b = await agent('비둘');
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await say(s.id, '@에이둘 하나');
  await say(s.id, '@비둘 둘');
  await say(s.id, '@에이둘 셋');
  assert.doesNotMatch(lastPrompt(), /지난번 답한 뒤/);
  assert.ok(b.id);
});
