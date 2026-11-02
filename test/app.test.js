// 통합 테스트: 실제 HTTP API + 실제 어댑터 코드 + 가짜 CLI(실측 출력 형식) — 실제 AI 사용량 0
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp } from './helpers.js';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const sessionOf = async (id) => (await t.api('GET', `/api/sessions/${id}`)).json;
const runDone = (sid) => t.waitFor(() => t.events.find((e) => e.type === 'run' && e.data.sessionId === sid && ['done', 'stopped', 'error'].includes(e.data.run.status) && e.data.run.endedAt), 20000, '실행 종료');

test('보안: 토큰 없거나 Host가 다르면 거부', async () => {
  const r1 = await fetch(`${t.base}/api/bootstrap`);
  assert.equal(r1.status, 401);
  // fetch 는 Host 헤더를 못 바꿔서 http.request 로 DNS 리바인딩 상황을 흉내 낸다
  const status2 = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: t.port, path: '/api/bootstrap', headers: { Host: 'evil.example.com', 'X-Office-Token': t.app.token } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(status2, 403);
  const r3 = await t.api('POST', '/api/agents', { name: 'x', provider: 'mock' }, { Origin: 'https://evil.example.com' });
  assert.equal(r3.status, 403);
  const html = await (await fetch(`${t.base}/`)).text();
  assert.match(html, /office-token/);
  const trav = await fetch(`${t.base}/..%2f..%2fpackage.json`);
  assert.notEqual(trav.status, 200);
});

test('부트스트랩: 기본 에이전트·팀이 들어 있다', async () => {
  const r = await t.api('GET', '/api/bootstrap');
  assert.equal(r.status, 200);
  const ids = r.json.agents.map((a) => a.id);
  for (const id of ['researcher', 'organizer', 'analyst', 'builder', 'demo-researcher']) assert.ok(ids.includes(id), id);
  const team = r.json.teams.find((x) => x.id === 'team-default');
  assert.deepEqual(team.stages.map((s) => s.label), ['조사', '정리', '분석', '빌드']);
  assert.equal(r.json.agents.find((a) => a.id === 'builder').effort, 'xhigh');
});

test('데모 팀: 단계 순서·병렬·승인 게이트·핸드오프·사용량', async () => {
  const s = (await t.api('POST', '/api/sessions', { teamId: 'team-demo' })).json;
  const r = await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '시장 조사해줘' });
  assert.equal(r.json.started, true);
  await t.waitFor(() => t.events.find((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.status === 'waiting' && e.data.run.hold?.reason === 'approve'), 15000, '승인 대기');
  assert.ok(t.events.some((e) => e.type === 'handoff' && e.data.sessionId === s.id && e.data.from === 'demo-researcher'));
  const states = t.events.filter((e) => e.type === 'agentState' && e.data.sessionId === s.id).map((e) => e.data.state);
  for (const st of ['thinking', 'searching', 'typing', 'done', 'waiting']) assert.ok(states.includes(st), `상태 ${st}`);
  const ok = await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'approve' });
  assert.equal(ok.json.ok, true);
  await runDone(s.id);
  const full = await sessionOf(s.id);
  const agents = full.messages.filter((m) => m.role === 'agent');
  assert.deepEqual(agents.map((m) => m.agentId).sort(), ['demo-analyst', 'demo-builder', 'demo-organizer', 'demo-researcher'].sort());
  assert.ok(agents.every((m) => m.status === 'done' && m.text.length > 10));
  assert.equal(full.runs.at(-1).status, 'done');
  // 빌드 단계 프롬프트에는 이전 단계 결과가 들어가야 한다(데모 응답에 주제가 반영됨)
  assert.match(agents.find((m) => m.agentId === 'demo-builder').text, /시장 조사해줘/);
  const usage = (await t.api('GET', '/api/usage')).json;
  assert.ok(usage.byProvider.mock.output > 0);
});

test('Claude 어댑터: 스트리밍·도구·비용·한도·이어하기(resume)', async () => {
  const a = (await t.api('POST', '/api/agents', { name: '클로드테스트', role: '분석', provider: 'claude', model: 'opus', effort: 'high', permission: 'plan' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '하늘 색은?' });
  await runDone(s.id);
  let full = await sessionOf(s.id);
  const m = full.messages.find((x) => x.role === 'agent');
  assert.equal(m.status, 'done');
  assert.match(m.text, /안녕하세요 turn1/);
  assert.ok(m.blocks.some((b) => b.kind === 'tool' && b.name === 'WebSearch' && b.status === 'done'));
  assert.equal(m.usage.cost, 0.01);
  assert.equal(m.usage.cacheRead, 100);
  const lim = (await t.api('GET', '/api/usage')).json.limits.claude;
  assert.equal(lim.windows.five_hour.pct, 25);
  assert.equal(lim.windows.seven_day.pct, 50);
  assert.ok(full.providerSessions[a.id]);
  const firstArgs = t.fakeLog().filter((l) => l.cli === 'claude' && l.args).at(-1).args;
  for (const f of ['--model', 'opus', '--effort', 'high', '--permission-mode', 'plan', '--append-system-prompt-file']) assert.ok(firstArgs.includes(f), f);
  // 두 번째 메시지는 같은 CLI 세션을 이어간다
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '다시' });
  await t.waitFor(() => t.events.filter((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.status === 'done' && e.data.run.endedAt).length >= 2, 15000, '두 번째 완료');
  const resumeArgs = t.fakeLog().filter((l) => l.cli === 'claude' && l.args).at(-1).args;
  assert.equal(resumeArgs[resumeArgs.indexOf('--resume') + 1], full.providerSessions[a.id]);
  full = await sessionOf(s.id);
  assert.equal(full.messages.filter((x) => x.role === 'agent').length, 2);
});

test('Claude 실행 중 지시 추가(steer)가 같은 프로세스에 들어간다', async () => {
  const a = (await t.api('POST', '/api/agents', { name: '스티어', role: '빌드', provider: 'claude', model: 'sonnet' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: 'SLOW 작업' });
  await t.waitFor(() => t.events.find((e) => e.type === 'agentState' && e.data.sessionId === s.id && e.data.state === 'typing'), 10000, '타이핑');
  const r = await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'steer', text: '결론부터 말해' });
  assert.equal(r.json.mode[a.id], 'live');
  await runDone(s.id);
  const m = (await sessionOf(s.id)).messages.find((x) => x.role === 'agent');
  assert.match(m.text, /turn2/, '두 번째 턴(추가 지시) 출력');
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && /추가 지시 전달됨/.test(b.text)));
  assert.ok(t.fakeLog().some((l) => l.cli === 'claude' && l.text === '결론부터 말해'));
});

test('Codex 어댑터 + 실제 기본 팀(조사→정리→분석→빌드) 흐름', async () => {
  const s = (await t.api('POST', '/api/sessions', { teamId: 'team-default' })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '신제품 아이디어' });
  // 분석 단계 뒤 승인 게이트
  await t.waitFor(() => t.events.find((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.hold?.reason === 'approve'), 20000, '분석 후 승인');
  // 거절 + 피드백 → 분석 재실행
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'reject', text: '위험 요소를 더 써줘' });
  await t.waitFor(() => t.events.filter((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.hold?.reason === 'approve').length >= 2, 20000, '재승인 대기');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'approve' });
  await runDone(s.id);
  const full = await sessionOf(s.id);
  const by = (id) => full.messages.filter((m) => m.agentId === id);
  assert.match(by('researcher')[0].text, /안녕하세요/);
  assert.ok(by('researcher')[0].blocks.some((b) => b.name === 'WebSearch' && b.status === 'done'));
  assert.equal(by('organizer')[0].text, '정리 결과: 파란색');
  assert.ok(by('organizer')[0].blocks.some((b) => b.name === '명령 실행' && b.status === 'done'));
  assert.ok(by('organizer')[0].blocks.some((b) => b.kind === 'notice' && b.quiet));
  assert.equal(by('organizer')[0].usage.cacheRead, 400);
  assert.equal(by('analyst').length, 2, '분석 2회(거절 후 재실행)');
  assert.equal(by('builder').length, 1);
  const log = t.fakeLog();
  const codexRun = log.find((l) => l.cli === 'codex' && l.args?.[0] === 'exec');
  const codexArgs = codexRun.args;
  assert.ok(codexArgs.includes('-m') && codexArgs.includes('gpt-6.1-sol'));
  assert.ok(codexArgs.includes('sandbox_mode="read-only"'));
  assert.match(codexRun.prompt, /\[이전 단계 결과\]/);
  assert.match(codexRun.prompt, /읽기 전용이야/, '권한 안내가 지침에 들어감');
  const analystRetry = log.filter((l) => l.cli === 'claude' && l.text).find((l) => /위험 요소를 더 써줘/.test(l.text));
  assert.ok(analystRetry, '거절 피드백이 프롬프트에 들어감');
});

test('중지·건너뛰기·대기열', async () => {
  const s = (await t.api('POST', '/api/sessions', { teamId: 'team-demo' })).json;
  t.app.store.settings.mockSpeed = 1;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '첫 번째' });
  const q = await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '두 번째(대기열)' });
  assert.equal(q.json.queued, true);
  await t.waitFor(() => t.events.find((e) => e.type === 'agentState' && e.data.sessionId === s.id && e.data.agentId === 'demo-researcher' && ['searching', 'reading', 'typing'].includes(e.data.state)), 10000, '조사 시작');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'skip', agentId: 'demo-researcher' });
  await t.waitFor(() => t.events.find((e) => e.type === 'agentState' && e.data.sessionId === s.id && e.data.agentId === 'demo-organizer'), 10000, '다음 단계로 진행');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
  await t.waitFor(() => t.events.find((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.status === 'stopped'), 10000, '중지');
  t.app.store.settings.mockSpeed = 0.05;
  // 대기열 메시지가 이어서 실행된다
  await t.waitFor(() => t.events.filter((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.status === 'waiting').length >= 1, 15000, '대기열 실행');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
  const full = await sessionOf(s.id);
  assert.equal(full.runs[0].status, 'stopped');
  assert.equal(full.messages.find((m) => m.agentId === 'demo-researcher').status, 'stopped');
});

test('오류 시 결정 대기 → 재시도/중지, 이어하기 실패 시 새 대화로 복구', async () => {
  const a = (await t.api('POST', '/api/agents', { name: '실패', role: '분석', provider: 'claude', model: 'opus' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: 'FAILME' });
  await t.waitFor(() => t.events.find((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.hold?.reason === 'error'), 10000, '오류 대기');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
  await runDone(s.id);
  // 죽은 resume id → 자동으로 새 대화
  const sess = t.app.store.getSession(s.id);
  sess.providerSessions[a.id] = 'dead-session';
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '정상 질문' });
  await t.waitFor(() => t.events.filter((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.endedAt).length >= 2, 15000, '복구 실행');
  const full = await sessionOf(s.id);
  const last = full.messages.filter((m) => m.role === 'agent').at(-1);
  assert.equal(last.status, 'done');
  assert.ok(last.blocks.some((b) => b.kind === 'notice' && /새 대화/.test(b.text)));
});

test('업로드 이미지가 Claude에 base64 이미지로 전달된다 + @멘션', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const up = await t.api('POST', '/api/uploads', png, { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('캡처.png') });
  assert.equal(up.status, 200);
  const a = (await t.api('POST', '/api/agents', { name: '눈', role: '분석', provider: 'claude', model: 'opus' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: 'team-demo' })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '@눈 이 그림 봐줘', attachments: [up.json.id] });
  await runDone(s.id);
  const full = await sessionOf(s.id);
  const agentMsgs = full.messages.filter((m) => m.role === 'agent');
  assert.equal(agentMsgs.length, 1);
  assert.equal(agentMsgs[0].agentId, a.id);
  assert.ok(t.fakeLog().some((l) => l.cli === 'claude' && l.imgs === 1 && /이 그림 봐줘/.test(l.text)));
  const img = await fetch(`${t.base}/api/uploads/${up.json.id}?token=${t.app.token}`);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('스킬·커넥터·플러그인 내보내기/가져오기', async () => {
  const sk = (await t.api('POST', '/api/skills', { name: '요약왕', description: '3줄 요약', content: '항상 3줄로 요약해.' })).json;
  const con = (await t.api('POST', '/api/connectors', { name: 'My Files', type: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem C:/tmp' })).json;
  assert.equal(con.key, 'my-files');
  assert.deepEqual(con.args, ['-y', '@modelcontextprotocol/server-filesystem', 'C:/tmp']);
  const a = (await t.api('POST', '/api/agents', { name: '스킬러', role: '정리', provider: 'claude', model: 'opus', skills: [sk.id], connectors: [con.id] })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '/요약왕 이 글' });
  await runDone(s.id);
  const args = t.fakeLog().filter((l) => l.cli === 'claude' && l.args).at(-1).args;
  assert.ok(args.includes('--mcp-config'));
  assert.ok(t.fakeLog().some((l) => l.cli === 'claude' && /스킬 "요약왕"/.test(l.text || '')));
  const team = (await t.api('POST', '/api/teams', { name: '내보낼 팀', stages: [{ label: '정리', agentIds: [a.id] }] })).json;
  const bundle = (await t.api('POST', '/api/plugins/export', { name: '테스트 묶음', teamIds: [team.id], skillIds: [sk.id], connectorIds: [con.id] })).json;
  assert.equal(bundle.format, 'office-crew-plugin');
  assert.equal(bundle.agents.length, 1);
  const before = (await t.api('GET', '/api/bootstrap')).json;
  const p = (await t.api('POST', '/api/plugins/import', bundle)).json;
  const afterB = (await t.api('GET', '/api/bootstrap')).json;
  assert.equal(afterB.agents.length, before.agents.length + 1);
  assert.equal(afterB.teams.length, before.teams.length + 1);
  const newTeam = afterB.teams.find((x) => x.pluginId === p.id);
  assert.ok(afterB.agents.some((x) => x.id === newTeam.stages[0].agentIds[0]), '팀이 새 에이전트 id를 가리킴');
  await t.api('DELETE', `/api/plugins/${p.id}`);
  const after2 = (await t.api('GET', '/api/bootstrap')).json;
  assert.equal(after2.agents.length, before.agents.length);
  const bad = await t.api('POST', '/api/plugins/import', { hello: 1 });
  assert.equal(bad.status, 400);
});

test('설정: API 키는 가려서 내보내고, 가린 값으로 저장하면 원래 키 유지', async () => {
  const r = await t.api('PUT', '/api/settings', { apiKeys: { gemini: 'AIzaSECRET1234' } });
  assert.equal(r.json.apiKeys.gemini, '••••••••1234');
  const r2 = await t.api('PUT', '/api/settings', { apiKeys: { gemini: r.json.apiKeys.gemini }, theme: 'dark' });
  assert.equal(t.app.store.settings.apiKeys.gemini, 'AIzaSECRET1234');
  assert.equal(r2.json.theme, 'dark');
  const boot = (await t.api('GET', '/api/bootstrap')).json;
  assert.ok(!JSON.stringify(boot).includes('AIzaSECRET1234'));
});
