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
beforeEach(() => { t.app.orch.cooldown.map.clear(); t.app.store.usage.limits = {}; t.app.store.settings.failover = true; t.app.store.settings.waitForResetMin = 0; });

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

test('R-a 도구를 쓰다 한도에 걸리면 이어받는 AI가 서버가 기록한 인계서(쓴 도구·손댄 파일·마지막 명령)를 받는다', async () => {
  const { s } = await runOnce({ name: '빌더T', role: '빌드', provider: 'claude', model: 'opus', effort: 'high' }, 'QUOTATOOLS 앱 고쳐줘');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'done', m.error);
  assert.equal(m.provider, 'codex');
  const sent = t.fakeLog().filter((l) => l.cli === 'codex').at(-1).prompt;
  const at = sent.indexOf('[인계서');
  assert.ok(at > sent.indexOf('QUOTATOOLS 앱 고쳐줘'), '원래 요청 뒤에 인계서');
  const card = sent.slice(at);
  assert.match(card, /`Bash` 2번 \(실패 1, 안 끝남 1\)/, '실패한 명령과 끝나기 전에 멈춘 명령');
  assert.match(card, /손댄 파일: `src\/app\.js`/);
  assert.match(card, /`npm test` \(실패\)/);
  assert.match(card, /`npm run build` \(안 끝남\)/);
});

test('R-d 사용량 창 정보가 없으면 오류 문구의 "Try again in 2 hours"로 쉬는 시간을 정한다(기본 30분 대신)', async () => {
  const t0 = Date.now();
  const { s } = await runOnce({ name: '빌더Q', role: '빌드', provider: 'claude', model: 'opus', effort: 'high' }, 'QUOTAIN 만들어줘');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'done', m.error);
  assert.equal(m.provider, 'codex', '다른 AI가 이어받음');
  const until = (await t.api('GET', '/api/cooldown')).json.claude?.until || 0;
  assert.ok(until >= t0 + 2 * 3600e3 - 5000 && until <= Date.now() + 2 * 3600e3 + 5000, `쉬는 시간이 2시간 뒤여야 함: ${new Date(until).toISOString()}`);
});

// ── 한도가 곧 풀리면 기다리기(실행을 시작할 때) ──
// 다 찬 5시간 창이 ms 뒤에 풀리는 한도 기록(초 단위 시각에 소수를 써서 실제로 오래 기다리지 않는다)
const resetIn = (ms) => ({ claude: { windows: { five_hour: { pct: 97, resetsAt: (Date.now() + ms) / 1000 } }, observedAt: Date.now() } });
const analyst = (name) => ({ name, role: '분석', provider: 'claude', model: 'opus', effort: 'high', routing: 'manual' });
const waited = (m) => m.blocks.some((b) => b.kind === 'notice' && b.text.startsWith('⏳'));

test('곧 풀리면 기다리기: 설정 저장은 0~30 정수', async () => {
  assert.equal(t.app.store.settings.waitForResetMin, 0);
  for (const [v, want] of [[99, 30], [-3, 0], ['x', 0], [7.4, 7], [5, 5]]) {
    assert.equal((await t.api('PUT', '/api/settings', { waitForResetMin: v })).json.waitForResetMin, want, String(v));
  }
  await t.api('PUT', '/api/settings', { waitForResetMin: 0 });
});

test('곧 풀리면 기다리기: 설정이 0이면 지금처럼 바로 다른 AI', async () => {
  t.app.store.usage.limits = resetIn(300);
  const { s } = await runOnce(analyst('기다림끔'), '분석해줘');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.provider, 'codex');
  assert.ok(!waited(m));
});

test('곧 풀리면 기다리기: 설정 안에 풀리면 기다렸다가 같은 AI로 하고 알림을 남긴다', async () => {
  t.app.store.settings.waitForResetMin = 5;
  t.app.store.usage.limits = resetIn(300);
  const from = t.events.length;
  const t0 = Date.now();
  const { a, s } = await runOnce(analyst('기다림켬'), '분석해줘');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'done', m.error);
  assert.equal(m.provider, 'claude', '원래 AI');
  assert.ok(m.createdAt - t0 >= 300, '풀린 뒤에 시작했다');
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && b.text === '⏳ Claude의 한도가 1분 뒤에 풀려서 기다렸다가 같은 AI로 이어 갔어.'), JSON.stringify(m.blocks.filter((b) => b.kind === 'notice')));
  assert.ok(t.events.slice(from).some((e) => e.type === 'agentState' && e.data.agentId === a.id && e.data.state === 'waiting' && e.data.detail === '한도가 곧 풀려서 기다리는 중(1분 남음)'), '기다리는 동안 상태');
});

test('곧 풀리면 기다리기: 설정보다 멀면 바로 다른 AI', async () => {
  t.app.store.settings.waitForResetMin = 5;
  t.app.store.usage.limits = resetIn(10 * 60e3);
  const { s } = await runOnce(analyst('기다림멂'), '분석해줘');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.provider, 'codex');
  assert.ok(!waited(m));
});

test('곧 풀리면 기다리기: 풀리는 시각을 모르면(30분 어림) 바로 다른 AI', async () => {
  t.app.store.settings.waitForResetMin = 30;
  // 거절 상태인데 어느 창의 초기화 시각도 없다 → 관측 뒤 30분 어림
  t.app.store.usage.limits = { claude: { status: 'rejected', windows: { five_hour: { pct: null } }, observedAt: Date.now() - 29 * 60e3 } };
  const { s } = await runOnce(analyst('기다림모름'), '분석해줘');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.provider, 'codex');
  assert.ok(!waited(m));
  // 한도 기록 없이 쉬는 중 표시만 있다(기본 30분)
  t.app.store.usage.limits = {};
  t.app.orch.cooldown.mark('claude', { reason: 'limit', until: Date.now() + 60e3 });
  const { s: s2 } = await runOnce(analyst('기다림쉼'), '분석해줘');
  assert.equal(s2.messages.filter((x) => x.role === 'agent').at(-1).provider, 'codex');
});

test('곧 풀리면 기다리기: 기다리는 중에 중지하면 실행하지 않는다', async () => {
  t.app.store.settings.waitForResetMin = 5;
  t.app.store.usage.limits = resetIn(5000);
  const a = (await t.api('POST', '/api/agents', analyst('기다림중지'))).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  const calls = t.fakeLog().filter((l) => l.args).length;
  const from = t.events.length;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '분석해줘' });
  await t.waitFor(() => t.events.slice(from).some((e) => e.type === 'agentState' && e.data.agentId === a.id && e.data.state === 'waiting'), 5000, '기다리는 중');
  const t0 = Date.now();
  assert.equal((await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' })).status, 200);
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 5000, '실행 끝');
  assert.ok(Date.now() - t0 < 2000, '중지하면 바로 끝난다');
  const sess = t.app.store.getSession(s.id);
  assert.equal(sess.runs.at(-1).status, 'stopped');
  assert.equal(sess.messages.filter((x) => x.role === 'agent').length, 0, '에이전트 답이 없다');
  assert.equal(t.fakeLog().filter((l) => l.args).length, calls, 'CLI를 하나도 실행하지 않았다');
});

test('곧 풀리면 기다리기: 예약 실행은 기다리지 않는다', async () => {
  t.app.store.settings.waitForResetMin = 5;
  t.app.store.usage.limits = resetIn(300);
  const a = (await t.api('POST', '/api/agents', analyst('기다림예약'))).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  t.app.store.getSession(s.id).scheduleId = 'sched-test'; // 예약 실행이 만든 세션처럼
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '분석해줘' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 10000, '실행 끝');
  const m = t.app.store.getSession(s.id).messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.provider, 'codex');
  assert.ok(!waited(m));
});

test('곧 풀리면 기다리기: 한 명이 기다리는 동안 같은 단계의 다른 에이전트는 그대로 일한다', async () => {
  t.app.store.settings.waitForResetMin = 5;
  t.app.store.usage.limits = resetIn(1500);
  const a = (await t.api('POST', '/api/agents', analyst('기다림병렬'))).json;
  const b = (await t.api('POST', '/api/agents', { name: '병렬코덱스', role: '정리', provider: 'codex', model: 'gpt-6.1-sol', routing: 'manual' })).json;
  const team = (await t.api('POST', '/api/teams', { name: '기다림 팀', stages: [{ label: '같이', agentIds: [a.id, b.id] }] })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: team.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '나눠서 해줘' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 15000, '실행 끝');
  const ms = t.app.store.getSession(s.id).messages.filter((x) => x.role === 'agent');
  const ma = ms.find((x) => x.agentId === a.id), mb = ms.find((x) => x.agentId === b.id);
  assert.equal(ma.provider, 'claude');
  assert.ok(waited(ma));
  assert.equal(mb.status, 'done');
  assert.ok(mb.createdAt + mb.usage.durationMs < ma.createdAt, '기다리는 사이에 다른 에이전트가 끝났다');
});

test('곧 풀리면 기다리기: 한도에 걸린 직후(거절 상태)여도 그 창이 풀리면 30분 어림에 막히지 않고 같은 AI로 한다', async () => {
  t.app.store.settings.waitForResetMin = 5;
  const resetsAt = (Date.now() + 300) / 1000;
  t.app.store.usage.limits = { claude: { status: 'rejected', windows: { five_hour: { pct: 100, resetsAt } }, observedAt: Date.now() } };
  t.app.orch.cooldown.mark('claude', { reason: 'limit', until: resetsAt * 1000 }); // 한도 오류로 쉬는 중(초기화 시각까지)
  const { s } = await runOnce(analyst('기다림거절'), '분석해줘');
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.provider, 'claude');
  assert.ok(waited(m));
});

test('곧 풀리면 기다리기: 회의에서 기다리는 중에 회의 끝내기를 누르면 그 차례는 건너뛰고 결론으로 간다', async () => {
  t.app.store.settings.waitForResetMin = 5;
  t.app.store.usage.limits = resetIn(5000);
  const chair = (await t.api('POST', '/api/agents', { name: '회의진행X', role: '정리', provider: 'codex', model: 'gpt-6.1-sol', routing: 'manual' })).json;
  const a = (await t.api('POST', '/api/agents', analyst('회의기다림'))).json;
  const team = (await t.api('POST', '/api/teams', { name: '기다림 회의', stages: [{ label: '회의', agentIds: [chair.id, a.id], meeting: { rounds: 2, chairId: chair.id } }] })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: team.id })).json;
  const calls = t.fakeLog().filter((l) => l.cli === 'claude' && l.args).length;
  const from = t.events.length;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '정하자' });
  await t.waitFor(() => t.events.slice(from).some((e) => e.type === 'agentState' && e.data.agentId === a.id && e.data.state === 'waiting'), 5000, '기다리는 중');
  // 진행자의 의견이 끝난 뒤에 누른다(의견이 하나도 없으면 결론을 낼 수 없다)
  await t.waitFor(() => t.app.store.getSession(s.id).messages.some((x) => x.agentId === chair.id && x.status === 'done'), 5000, '진행자 의견');
  assert.equal((await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'conclude' })).json.ok, true);
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 10000, '실행 끝');
  const mm = t.app.store.getSession(s.id).messages.filter((x) => x.meeting);
  assert.deepEqual(mm.map((x) => `${x.meeting.phase}:${x.agentId === a.id ? 'claude' : 'chair'}`), ['opinion:chair', 'conclude:chair'], '기다리던 참석자는 답하지 않았다');
  assert.equal(t.fakeLog().filter((l) => l.cli === 'claude' && l.args).length, calls, 'Claude 를 실행하지 않았다');
});
