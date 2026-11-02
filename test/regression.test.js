// 독립 코드 리뷰에서 찾은 버그들의 재발 방지 테스트(실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startTestApp } from './helpers.js';
import { Store } from '../server/store.js';
import { dataDirs, ensureDirs } from '../server/config.js';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const runs = (sid) => [...new Set(t.events.filter((e) => e.type === 'run' && e.data.sessionId === sid).map((e) => e.data.run.id))];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#1 삭제한 세션의 대기열 메시지는 다시 실행되지 않는다', async () => {
  t.app.store.settings.mockSpeed = 1;
  const s = (await t.api('POST', '/api/sessions', { teamId: 'team-demo' })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '첫 번째' });
  const q = await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '대기열' });
  assert.equal(q.json.queued, true);
  await t.waitFor(() => t.events.find((e) => e.type === 'agentState' && e.data.sessionId === s.id && e.data.state !== 'idle'), 8000, '시작');
  await t.api('DELETE', `/api/sessions/${s.id}`);
  await sleep(1500);
  t.app.store.settings.mockSpeed = 0.05;
  assert.equal(runs(s.id).length, 1, '실행은 처음 1개뿐');
  assert.equal(t.app.orch.ctx.has(s.id), false);
  assert.equal((await t.api('GET', `/api/sessions/${s.id}`)).status, 404);
});

test('#2 CLI가 stdin을 읽기 전에 죽어도(큰 이미지 전송 중) 서버는 살아 있다', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const up = await t.api('POST', '/api/uploads', big, { 'Content-Type': 'image/png', 'X-File-Name': 'big.png' });
  const a = (await t.api('POST', '/api/agents', { name: '즉사', role: '분석', provider: 'claude', model: 'opus' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  process.env.FAKE_EXIT_NOW = '1';
  try {
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '그림', attachments: [up.json.id] });
    await t.waitFor(() => t.events.find((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.hold?.reason === 'error'), 10000, '오류 대기');
  } finally { delete process.env.FAKE_EXIT_NOW; }
  const r = await t.api('GET', '/api/bootstrap');
  assert.equal(r.status, 200, '서버 응답');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
});

test('#3 업로드 원본이 사라져도 404 로 답하고 서버는 살아 있다', async () => {
  const up = await t.api('POST', '/api/uploads', Buffer.from('hello'), { 'Content-Type': 'text/plain', 'X-File-Name': 'a.txt' });
  fs.rmSync(up.json.path);
  const r = await fetch(`${t.base}/api/uploads/${up.json.id}?token=${t.app.token}`);
  assert.equal(r.status, 404);
  assert.equal((await t.api('GET', '/api/bootstrap')).status, 200);
});

test('#5 승인 대기 중 에이전트 지정 건너뛰기는 승인으로 처리되지 않는다', async () => {
  const s = (await t.api('POST', '/api/sessions', { teamId: 'team-demo' })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '승인 테스트' });
  await t.waitFor(() => t.events.find((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.hold?.reason === 'approve'), 15000, '승인 대기');
  const r = await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'skip', agentId: 'demo-organizer' });
  assert.equal(r.json.ok, false);
  const r2 = await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'resume' });
  assert.equal(r2.json.ok, true); // resume 자체는 받되 승인 대기를 풀지 않음
  await sleep(500);
  assert.equal(t.app.orch.ctx.get(s.id).run.status, 'waiting', '여전히 승인 대기');
  assert.ok(!t.app.store.getSession(s.id).messages.some((m) => m.agentId === 'demo-builder'), '빌드 단계가 시작되면 안 됨');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
});

test('#6 준비 단계(작업 폴더 생성) 예외에도 메시지가 작성 중으로 굳지 않는다', async () => {
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: 'demo-researcher' })).json;
  // 검증을 우회해 "폴더 자리에 파일"이 있는 상황을 만든다
  const file = path.join(t.root, 'not-a-dir.txt');
  fs.writeFileSync(file, 'x');
  t.app.store.getSession(s.id).cwd = path.join(file, 'sub');
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '폴더 오류' });
  await t.waitFor(() => t.events.find((e) => e.type === 'run' && e.data.sessionId === s.id && e.data.run.hold?.reason === 'error'), 10000, '오류 대기');
  const m = t.app.store.getSession(s.id).messages.find((x) => x.role === 'agent');
  assert.equal(m.status, 'error');
  assert.match(m.error, /실행 실패/);
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
});

test('#7 출력이 계속 들어와도 늦어도 지정 시간 안에 디스크에 저장된다', async () => {
  const s = t.app.store.createSession({ title: '저장 테스트' });
  const file = path.join(t.app.dirs.sessions, `${s.id}.json`);
  s.messages.push({ id: 'm1', role: 'agent', text: '', blocks: [], status: 'streaming' });
  const t0 = Date.now();
  let seen = false;
  while (Date.now() - t0 < 2000) {
    s.messages[0].text += '가';
    t.app.store.saveSession(s, 800);
    await sleep(100);
    if (JSON.parse(fs.readFileSync(file, 'utf8')).messages[0]?.text.length > 0) { seen = true; break; }
  }
  assert.ok(seen, '스트리밍 도중에도 저장됨');
});

test('검증#1 플러그인을 가져와도 에이전트의 앱 스킬 연결이 유지된다', async () => {
  const sk = (await t.api('POST', '/api/skills', { name: '검증스킬', description: 'd', content: '항상 표로' })).json;
  const a = (await t.api('POST', '/api/agents', { name: '스킬보유', role: '정리', provider: 'mock', model: 'mock-fast', skills: ['ext:claude:x', sk.id] })).json;
  // 스킬을 따로 고르지 않아도 에이전트가 쓰는 앱 스킬은 자동 포함
  const bundle = (await t.api('POST', '/api/plugins/export', { name: '스킬 묶음', agentIds: [a.id] })).json;
  assert.equal(bundle.skills.length, 1);
  const p = (await t.api('POST', '/api/plugins/import', bundle)).json;
  const boot = (await t.api('GET', '/api/bootstrap')).json;
  const imported = boot.agents.find((x) => x.pluginId === p.id);
  const newSkill = boot.skills.find((x) => x.pluginId === p.id);
  assert.ok(newSkill, '스킬도 설치됨');
  assert.deepEqual(imported.skills.sort(), ['ext:claude:x', newSkill.id].sort());
  await t.api('DELETE', `/api/plugins/${p.id}`);
});

test('검증#5·#6 중지된 에이전트는 대기+사유, 전원 건너뛴 단계는 skipped', async () => {
  t.app.store.settings.mockSpeed = 1;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: 'demo-researcher' })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '건너뛰기 표시' });
  await t.waitFor(() => t.events.find((e) => e.type === 'agentState' && e.data.sessionId === s.id && ['searching', 'reading', 'typing'].includes(e.data.state)), 8000, '작업 시작');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'skip', agentId: 'demo-researcher' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 8000, '실행 종료');
  t.app.store.settings.mockSpeed = 0.05;
  const last = t.events.filter((e) => e.type === 'agentState' && e.data.sessionId === s.id).at(-1).data;
  assert.equal(last.state, 'idle');
  assert.equal(last.detail, '건너뜀');
  assert.equal(t.app.store.getSession(s.id).runs.at(-1).stages[0].status, 'skipped');
});

test('실측#1 빈 답으로 끝나면 최종 답변을 한 번 더 요청해 채운다 + 권한 안내가 지침에 들어간다', async () => {
  const a = (await t.api('POST', '/api/agents', { name: '빈답', role: '조사', provider: 'claude', model: 'sonnet', permission: 'plan' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: 'EMPTYANSWER 조사해줘' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 10000, '실행 종료');
  const m = t.app.store.getSession(s.id).messages.find((x) => x.role === 'agent');
  assert.equal(m.status, 'done');
  assert.match(m.text, /조사 결과/);
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && /한 번 더 요청/.test(b.text)));
  const log = t.fakeLog().filter((l) => l.cli === 'claude');
  assert.ok(log.some((l) => /읽기 전용이야/.test(l.system || '')), '권한 안내가 지침에 포함');
  assert.ok(log.some((l) => /도구를 더 쓰지 말고/.test(l.text || '')), '재요청 전송');
});

test('#13·#14 경로 조작: 정적 파일 옆 폴더, 스킬 id', async () => {
  const r = await fetch(`${t.base}/..%2fpublic2/x.txt`);
  assert.notEqual(r.status, 200);
  const sk = await t.api('POST', '/api/skills', { id: '..\\..\\evil', name: '나쁜', content: 'x' });
  assert.equal(sk.status, 200);
  assert.match(sk.json.id, /^skill-[a-z0-9]+$/, '서버가 만든 id 만 쓴다');
  const bad = await t.api('PUT', `/api/skills/${encodeURIComponent('..')}`, { name: 'x' });
  assert.notEqual(bad.status, 200);
});

test('저사양: 세션 본문은 최근 12개만 메모리에, 나머지는 필요할 때 디스크에서 읽고 끊긴 실행 흔적은 정리', async () => {
  const st = t.app.store;
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const s = st.createSession({ title: `메모리 ${i}` });
    s.messages.push({ id: `m${i}`, role: 'agent', text: '본문'.repeat(50), blocks: [], status: 'streaming' });
    s.runs.push({ id: `r${i}`, status: 'running', stages: [] });
    st.saveSessionNow(s);
    ids.push(s.id);
  }
  assert.ok(st.sessions.size <= 12, `캐시 ${st.sessions.size}개`);
  assert.ok(st.listSessions().filter((m) => ids.includes(m.id)).length === 20, '목록에는 20개 모두');
  st.sessions.delete(ids[0]); // 캐시에서 내려간 상황
  const again = st.getSession(ids[0]);
  assert.equal(again.messages[0].text.length, 100, '디스크에서 다시 읽음');
  assert.equal(again.messages[0].status, 'stopped', '끊긴 작성 중 → 중지');
  assert.equal(again.runs[0].status, 'stopped', '끊긴 실행 → 중지');
  st.getSession(ids[1]);
  st.pin(ids[1]);
  for (let i = 0; i < 15; i++) st.getSession(ids[(i % 18) + 2]);
  assert.ok(st.sessions.has(ids[1]), '실행 중(고정) 세션은 내려가지 않음');
  st.unpin(ids[1]);
});

test('빠진 프로바이더(안티그래비티)를 쓰던 옛 데이터는 자동 라우팅으로 바뀐다', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mig-'));
  try {
    const dirs = dataDirs(home);
    ensureDirs(dirs);
    fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify([{ id: 'researcher', name: '리서처', role: '조사', provider: 'antigravity', model: 'gemini-4-argon', effort: 'medium' }]));
    fs.writeFileSync(path.join(home, 'teams.json'), JSON.stringify([{ id: 'team-default', name: '기본 팀', description: '조사(안티그래비티) → 정리(솔)', stages: [] }]));
    const store = new Store(dirs).init();
    const a = store.get('agents', 'researcher');
    assert.deepEqual([a.provider, a.model, a.routing, a.routingProfile], ['claude', '', 'auto', 'balanced']);
    assert.doesNotMatch(store.get('teams', 'team-default').description, /안티그래비티/);
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'agents.json'), 'utf8'));
    assert.equal(saved[0].provider, 'claude', '파일에도 저장');
    store.close?.();
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('결제 방식: API 키 모드는 저장한 키를 넘기고, 구독 모드는 PC 환경변수 키를 빼서 뜻밖의 과금을 막는다', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'env-key-9999'; // PC 에 깔린 키 흉내
  try {
    const a = (await t.api('POST', '/api/agents', { name: '키테스트', role: '정리', provider: 'claude', model: 'sonnet' })).json;
    const run = async (text) => {
      const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
      await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
      await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 10000, '실행 종료');
      return t.fakeLog().filter((l) => l.cli === 'claude' && l.args).at(-1);
    };
    // 기본(구독 로그인): 환경변수 키를 넘기지 않는다
    assert.equal((await run('구독 모드')).key, '');
    // API 키 모드 + 앱에 저장한 키
    const put = await t.api('PUT', '/api/settings', { authMode: { claude: 'apikey', codex: 'login' }, apiKeys: { anthropic: 'sk-ant-test-1234' } });
    assert.equal(put.status, 200);
    assert.notEqual(put.json.apiKeys.anthropic, 'sk-ant-test-1234', '화면에는 가려서 보냄');
    assert.equal((await run('키 모드')).key, '1234');
    // 키를 비우면 PC 환경변수 키를 쓴다
    await t.api('PUT', '/api/settings', { apiKeys: { anthropic: '' } });
    assert.equal((await run('환경변수 키')).key, '9999');
    // 탐지도 결제 방식을 따른다
    await t.app.providers.refresh('claude');
    const d = t.app.providers.detected.claude;
    assert.deepEqual([d.authMode, d.loggedIn], ['apikey', true]);
    // 잘못된 값은 구독으로, 일부만 보내도 다른 값은 그대로
    await t.api('PUT', '/api/settings', { apiKeys: { gemini: 'AIza-keep-0000' } });
    const bad = await t.api('PUT', '/api/settings', { authMode: { claude: 'hack' }, apiKeys: { openai: 'sk-o-5555' } });
    assert.deepEqual(bad.json.authMode, { claude: 'login', codex: 'login' });
    assert.equal(t.app.store.settings.apiKeys.gemini, 'AIza-keep-0000', '다른 키는 안 지워짐');
    assert.equal(t.app.store.settings.apiKeys.openai, 'sk-o-5555');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    await t.api('PUT', '/api/settings', { authMode: { claude: 'login', codex: 'login' }, apiKeys: { anthropic: '' } });
  }
});

test('오류 대기 중에 중지하면 사무실 캐릭터의 "결정 필요" 표시가 풀린다', async () => {
  const a = (await t.api('POST', '/api/agents', { name: '대기중지', role: '분석', provider: 'claude', model: 'opus' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: 'FAILME 해줘' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.hold?.reason === 'error', 10000, '오류 대기');
  const states = () => t.events.filter((e) => e.type === 'agentState' && e.data.sessionId === s.id && e.data.agentId === a.id);
  assert.equal(states().at(-1).data.state, 'error');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 5000, '중지');
  const last = states().at(-1).data;
  assert.deepEqual([last.state, last.detail], ['idle', '중지됨']);
});
