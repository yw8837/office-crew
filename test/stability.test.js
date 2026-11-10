// 안정화: 멈춘 실행 감시, 이어 말할 때 놓친 대화 전달(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { PROVIDERS } from '../server/providers/index.js';

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

test('시간을 0으로 두면 감시하지 않는다', async () => {
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

// 가짜 프로바이더: 멋대로 끝나지 않는 실행(필요하면 stop 해도 안 끝남)
const withMock = async (run, caps, fn) => {
  const m = PROVIDERS.mock;
  const saved = [m.run, m.caps];
  m.run = run;
  if (caps) m.caps = { ...m.caps, ...caps };
  try { await fn(); } finally { [m.run, m.caps] = saved; }
};
const mockAgent = async (name) => (await t.api('POST', '/api/agents', { name, role: '조사', provider: 'mock', permission: 'plan', routing: 'manual' })).json;
const hang = (emit, stoppable = true) => {
  let end;
  const done = new Promise((r) => { end = r; });
  return { done, stop: () => { if (stoppable) end({ text: '', stopped: true }); } };
};
const start = async (a, text = '해줘') => {
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
  return s.id;
};
const hold = (sid) => t.waitFor(() => { const r = t.app.store.getSession(sid).runs.at(-1); return r?.hold || r?.endedAt; }, 12000, '멈춤 처리');
const stopRun = async (sid) => { await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' }); await t.waitFor(() => t.app.store.getSession(sid).runs.at(-1).endedAt, 8000, '중지'); };

test('사람이 멈추면 오류로 안 본다(감시를 켠 상태)', async () => {
  t.app.store.settings.stallMinutes = 5;
  const a = await agent('사람중지');
  const sid = await start(a, 'HANGNOW 멈출게');
  await new Promise((r) => setTimeout(r, 500));
  await stopRun(sid);
  assert.notEqual(t.app.store.getSession(sid).messages.filter((x) => x.role === 'agent').at(-1).status, 'error');
});

test('CLI 가 끄라는 말에 안 끝나도 강제로 끝낸다(손자 프로세스가 출력을 잡은 경우)', async () => {
  t.app.store.settings.stallMinutes = 0.005;
  await withMock((o, emit) => hang(emit, false), null, async () => {
    const sid = await start(await mockAgent('안꺼짐'));
    const t0 = Date.now();
    await hold(sid);
    assert.ok(Date.now() - t0 < 9000, `강제 종료 ${Date.now() - t0}ms`);
    assert.match(t.app.store.getSession(sid).messages.filter((x) => x.role === 'agent').at(-1).error, /아무 출력이 없어서/);
    await stopRun(sid);
  });
});

test('도구가 도는 중엔 4배까지 기다리고, 상태 없는 진행 알림으로 풀리지 않는다', async () => {
  t.app.store.settings.stallMinutes = 0.02; // 1.2초, 도구 중엔 4.8초
  await withMock((o, emit) => {
    emit({ type: 'tool', id: 'x', name: 'Bash', status: 'running' });
    emit({ type: 'tool', id: 'x', name: 'Bash' });
    return hang(emit);
  }, null, async () => {
    const sid = await start(await mockAgent('도구중'));
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!t.app.store.getSession(sid).runs.at(-1).hold, '1배는 넘겼지만 아직 안 끈다');
    await hold(sid);
    assert.match(t.app.store.getSession(sid).messages.filter((x) => x.role === 'agent').at(-1).error, /아무 출력이 없어서/);
    await stopRun(sid);
  });
});

test('끝날 때 한 번에 주는 CLI(Hermes)는 감시하지 않는다', async () => {
  assert.equal(PROVIDERS.hermes.caps.quiet, true);
  t.app.store.settings.stallMinutes = 0.005;
  await withMock((o, emit) => hang(emit), { quiet: true }, async () => {
    const sid = await start(await mockAgent('조용한CLI'));
    await new Promise((r) => setTimeout(r, 1500));
    const run = t.app.store.getSession(sid).runs.at(-1);
    assert.ok(!run.hold && !run.endedAt, '조용해도 안 끈다');
    await stopRun(sid);
  });
});

test('멈춘 예약 실행은 끝내서 다음 회차를 막지 않는다', async () => {
  t.app.store.settings.stallMinutes = 0.005;
  await withMock((o, emit) => hang(emit), null, async () => {
    const a = await mockAgent('예약멈춤');
    const sch = (await t.api('POST', '/api/schedules', { name: '멈춤 예약', prompt: '해줘', days: [0, 1, 2, 3, 4, 5, 6], time: '03:00', agentId: a.id, teamId: null })).json;
    const first = t.app.scheduler.fire(t.app.store.get('schedules', sch.id));
    assert.equal(first.status, 'started');
    await t.waitFor(() => t.app.store.getSession(first.sessionId).runs.at(-1)?.endedAt, 12000, '예약 실행 끝');
    assert.ok(!t.app.orch.ctx.has(first.sessionId));
    const second = t.app.scheduler.fire(t.app.store.get('schedules', sch.id));
    assert.equal(second.status, 'started', '다음 회차는 돈다');
    await stopRun(second.sessionId);
    await t.api('DELETE', `/api/schedules/${sch.id}`);
  });
});

test('내 PC 모델과 나눈 대화는 클라우드 AI 에게 안 넘기고, 재실행에도 놓친 대화를 한 번만 넣는다', async () => {
  const a = await agent('클라우드담당');
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await say(s.id, '@클라우드담당 시작');
  const sess = t.app.store.getSession(s.id);
  const m = (text, extra) => ({ id: `m-${text}`, role: 'agent', agentId: 'other', text, status: 'done', runId: 'old', createdAt: Date.now(), ...extra });
  sess.messages.push(m('로컬비밀내용', { provider: 'local' }), m('클라우드내용', { provider: 'codex' }));
  await say(s.id, '@클라우드담당 이어서');
  const p = lastPrompt();
  assert.match(p, /클라우드내용/);
  assert.doesNotMatch(p, /로컬비밀내용/);

  const reviewer = (await t.api('POST', '/api/agents', { name: '재실행담당', role: '조사', provider: 'codex', model: 'gpt-6.1-sol', permission: 'plan', routing: 'manual' })).json;
  const other = await agent('옆담당');
  const team = (await t.api('POST', '/api/teams', { name: '승인팀', stages: [{ label: '하나', agentIds: [reviewer.id], approve: true }] })).json;
  const s2 = (await t.api('POST', '/api/sessions', { teamId: team.id })).json;
  await say(s2.id, '첫 요청');
  await t.api('POST', `/api/sessions/${s2.id}/control`, { action: 'approve' });
  await t.waitFor(() => t.app.store.getSession(s2.id).runs.at(-1).endedAt, 8000, '첫 실행 끝');
  await say(s2.id, `@${other.name} 옆 이야기`);
  await say(s2.id, '둘째 요청');
  assert.match(lastPrompt(), /옆 이야기/, '첫 시도엔 넣는다');
  await t.api('POST', `/api/sessions/${s2.id}/control`, { action: 'reject', text: '다시 해' });
  await t.waitFor(() => t.app.store.getSession(s2.id).runs.at(-1).hold && lastPrompt().includes('다시 해'), 8000, '재실행');
  assert.doesNotMatch(lastPrompt(), /옆 이야기/, '같은 실행의 재시도엔 안 넣는다');
  await t.api('POST', `/api/sessions/${s2.id}/control`, { action: 'stop' });
});

test('새로 맡은 대화에 앞 대화를 넣을 때도 내 PC 모델과 나눈 대화는 클라우드 AI 에게 안 넘긴다', async () => {
  const a = await agent('새담당');
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  const sess = t.app.store.getSession(s.id);
  sess.messages.push({ id: 'm-l1', role: 'agent', agentId: 'other', text: '로컬앞대화', status: 'done', runId: 'old', provider: 'local', createdAt: Date.now() });
  sess.messages.push({ id: 'm-c1', role: 'agent', agentId: 'other', text: '클라우드앞대화', status: 'done', runId: 'old', provider: 'codex', createdAt: Date.now() });
  await say(s.id, '@새담당 처음 맡아');
  const p = lastPrompt();
  assert.match(p, /클라우드앞대화/);
  assert.doesNotMatch(p, /로컬앞대화/);
});
