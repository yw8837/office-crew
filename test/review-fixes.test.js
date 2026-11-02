// 독립 코드 검토에서 재현된 문제들의 재발 방지 테스트(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { resolveCommand } from '../server/providers/util.js';

let t;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  t = await startTestApp();
  const reg = t.app.providers;
  reg.detected = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true } };
  reg.modelCache = {
    claude: { at: Date.now(), version: '', list: [{ id: 'opus', label: 'Opus', tier: 'top' }, { id: 'sonnet', label: 'Sonnet', tier: 'balanced' }] },
    codex: { at: Date.now(), version: '', list: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'top' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'balanced' }] },
  };
});
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });
beforeEach(() => { t.app.orch.cooldown.map.clear(); t.app.store.usage.limits = {}; t.app.store.settings.failover = true; });

const later = () => Math.floor(Date.now() / 1000) + 3600;
const newChat = async (agent) => {
  const a = (await t.api('POST', '/api/agents', agent)).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  return { a, sid: s.id };
};
const say = async (sid, text) => {
  const n = t.app.store.getSession(sid).runs.length;
  await t.api('POST', `/api/sessions/${sid}/messages`, { text });
  await t.waitFor(() => { const s = t.app.store.getSession(sid); return s.runs.length > n && (s.runs.at(-1).endedAt || s.runs.at(-1).hold); }, 10000, '실행 종료');
  return t.app.store.getSession(sid).messages.filter((m) => m.role === 'agent').at(-1);
};

test('#1 거절 기록은 초기화 시각이 지나거나 "지금 다시 쓰기"를 누르면 더 이상 피하지 않는다', async () => {
  t.app.store.usage.limits = { claude: { status: 'rejected', windows: { five_hour: { pct: 100, resetsAt: later() } }, observedAt: Date.now() } };
  const { sid } = await newChat({ name: '거절1', role: '분석', provider: 'claude', model: 'opus' });
  assert.equal((await say(sid, '분석해줘')).provider, 'codex', '거절 상태면 피함');
  assert.ok(t.app.orch.restingList().claude?.near, '화면에 "피하는 중"으로 보임');
  assert.equal((await t.api('DELETE', '/api/cooldown/claude')).status, 200);
  assert.equal(t.app.orch.restingList().claude, undefined);
  assert.equal((await say(sid, '다시')).provider, 'claude', '풀면 원래 AI');
  // 초기화 시각이 지난 거절 기록도 무시
  t.app.store.usage.limits = { claude: { status: 'rejected', windows: { five_hour: { pct: 100, resetsAt: Math.floor(Date.now() / 1000) - 10 } }, observedAt: Date.now() - 7200e3 } };
  assert.equal((await say(sid, '또')).provider, 'claude');
});

test('#2 이어하기 중 "Session limit" 같은 한도 오류는 이어하기 실패로 보지 않는다(원래 대화 id 유지)', async () => {
  t.app.store.settings.failover = false;
  const { a, sid } = await newChat({ name: '세션한도', role: '분석', provider: 'claude', model: 'opus' });
  await say(sid, '첫 질문');
  const id1 = t.app.store.getSession(sid).providerSessions[a.id];
  assert.ok(id1);
  const before = t.fakeLog().filter((l) => l.cli === 'claude' && l.args).length;
  const m = await say(sid, 'SESSIONLIMIT 두 번째');
  assert.equal(m.status, 'error');
  assert.ok(!m.blocks.some((b) => /새 대화로 다시 시작/.test(b.text || '')), '새 대화로 재시도하지 않음');
  assert.equal(t.fakeLog().filter((l) => l.cli === 'claude' && l.args).length, before + 1, 'Claude 실행 1번뿐');
  assert.equal(t.app.store.getSession(sid).providerSessions[a.id], id1, '원래 대화 id 유지');
});

test('#3 이어받을 AI를 고르는 사이에 중지하면 대체 AI를 실행하지 않는다', async () => {
  const reg = t.app.providers;
  const orig = reg.catalog.bind(reg);
  let calls = 0;
  reg.catalog = async (...x) => { calls++; if (calls > 0) await sleep(900); return orig(...x); };
  try {
    const { sid } = await newChat({ name: '중지경쟁', role: '빌드', provider: 'claude', model: 'opus' });
    const codexBefore = t.fakeLog().filter((l) => l.cli === 'codex').length;
    await t.api('POST', `/api/sessions/${sid}/messages`, { text: 'QUOTAFAIL 빌드' });
    await t.waitFor(() => t.app.orch.cooldown.active('claude'), 8000, '한도 감지');
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => t.app.store.getSession(sid).runs.at(-1)?.endedAt, 8000, '종료');
    await sleep(300);
    assert.equal(t.fakeLog().filter((l) => l.cli === 'codex').length, codexBefore, '중지 뒤 Codex 실행 없음');
    const m = t.app.store.getSession(sid).messages.filter((x) => x.role === 'agent').at(-1);
    assert.equal(m.status, 'stopped');
  } finally { reg.catalog = orig; }
});

test('#4 이어받은 AI도 앞 대화를 받는다 + #14 남은 AI가 한도 임박이어도 마지막으로 시도', async () => {
  const { sid } = await newChat({ name: '맥락', role: '빌드', provider: 'claude', model: 'opus' });
  await say(sid, 'FIRSTMSG 로그인 화면 만들기');
  t.app.store.usage.limits = { codex: { windows: { seven_day: { pct: 97, resetsAt: later() } }, observedAt: Date.now() } };
  const m = await say(sid, 'QUOTAFAIL 이어서 버튼도');
  assert.equal(m.status, 'done', m.error);
  assert.equal(m.provider, 'codex', '한도 임박이지만 남은 유일한 AI라 시도');
  const sent = t.fakeLog().filter((l) => l.cli === 'codex').at(-1).prompt;
  assert.match(sent, /\[이전 대화\]/);
  assert.match(sent, /FIRSTMSG/);
});

test('#5 ACP: 작업 폴더 안의 링크(정션)로 밖의 파일을 읽거나 쓸 수 없다', async () => {
  const work = path.join(t.root, 'acp-link', 'proj');
  const outside = path.join(t.root, 'acp-link', 'outside');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(work, 'note.txt'), '노트');
  fs.writeFileSync(path.join(outside, 'outside-secret.txt'), 'TOP-SECRET');
  fs.symlinkSync(outside, path.join(work, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  // 끊긴 링크: 밖의 아직 없는 파일을 가리킴(윈도우에서 파일 링크 권한이 없으면 없는 폴더를 가리키는 정션)
  try { fs.symlinkSync(path.join(outside, 'new.txt'), path.join(work, 'evil'), 'file'); } catch { fs.symlinkSync(path.join(outside, 'newdir'), path.join(work, 'evil'), 'junction'); }
  await t.api('PUT', '/api/settings', { acpAgents: [{ id: 'fake', name: '가짜 ACP', command: 'fake-acp', args: [] }] });
  const a = (await t.api('POST', '/api/agents', { name: 'ACP링크', role: '조사', provider: 'acp', model: 'fake', permission: 'edit' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id, cwd: work })).json;
  const m = await say(s.id, 'ACPLINK 읽어봐');
  assert.equal(m.status, 'done', m.error);
  const log = t.fakeLog().filter((l) => l.cli === 'acp' && l.method === 'link').at(-1);
  assert.deepEqual([log.readError, log.writeError, log.dotdotError], [true, true, true], "링크·'..' 경로 모두 거부");
  assert.ok(!fs.existsSync(path.join(outside, 'pwned.txt')), '밖에 파일이 안 생김');
  const dl = t.fakeLog().filter((l) => l.cli === 'acp' && l.method === 'dangling').at(-1);
  assert.deepEqual([dl.write1Error, dl.write2Error], [true, true], '끊긴 링크로 쓰기 거부');
  // 우연한 파일 시스템 오류(-32603 ENOENT)가 아니라 작업 폴더 경계 검사(-32602)로 막혀야 한다
  assert.deepEqual([dl.write1Code, dl.write2Code], [-32602, -32602], '경계 검사로 거부');
  assert.ok(!fs.existsSync(path.join(outside, 'new.txt')) && !fs.existsSync(path.join(outside, 'newdir')), '끊긴 링크를 따라 밖에 안 생김');
});

test('#7 ACP 직접 추가 항목은 다시 저장해도 id 가 그대로, 없는 id 는 다른 에이전트로 보내지 않는다', async () => {
  const one = (await t.api('PUT', '/api/settings', { acpAgents: [{ id: '', name: '내 에이전트', command: 'fake-acp', args: ['--x'] }] })).json.acpAgents[0];
  const two = (await t.api('PUT', '/api/settings', { acpAgents: [{ id: '', name: '내 에이전트', command: 'fake-acp', args: ['--x'] }] })).json.acpAgents[0];
  assert.equal(one.id, two.id);
  await t.api('PUT', '/api/settings', { acpAgents: [{ id: 'other', name: '다른 것', command: 'fake-acp', args: [] }] });
  const a = (await t.api('POST', '/api/agents', { name: 'ACP없는id', role: '조사', provider: 'acp', model: 'gone-id', permission: 'plan' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  const m = await say(s.id, '해줘');
  assert.equal(m.status, 'error');
  assert.match(m.error, /gone-id/);
});

test('#9 커넥터·ACP 의 비밀값은 화면에 가려서 보내고, 가린 값을 다시 저장하면 원래 값을 유지한다', async () => {
  const c = (await t.api('POST', '/api/connectors', { name: 'Git', type: 'stdio', command: 'npx', args: 'x', env: { GITHUB_TOKEN: 'ghp_secret1234', ROOT_DIR: 'C:/work' } })).json;
  assert.equal(c.env.GITHUB_TOKEN, '••••••••1234');
  assert.equal(c.env.ROOT_DIR, 'C:/work', '비밀값이 아닌 건 그대로');
  const boot = (await t.api('GET', '/api/bootstrap')).json;
  assert.equal(boot.connectors.find((x) => x.id === c.id).env.GITHUB_TOKEN, '••••••••1234');
  await t.api('PUT', `/api/connectors/${c.id}`, { ...c, name: 'Git2' });
  assert.equal(t.app.store.get('connectors', c.id).env.GITHUB_TOKEN, 'ghp_secret1234', '가린 값 그대로 저장해도 원래 값 유지');
  const set = (await t.api('PUT', '/api/settings', { acpAgents: [{ id: 'k', name: 'K', command: 'fake-acp', args: [], env: { API_KEY: 'abcd-efgh-9999', MODE: 'fast' } }] })).json;
  assert.deepEqual(set.acpAgents[0].env, { API_KEY: '••••••••9999', MODE: 'fast' });
  await t.api('PUT', '/api/settings', { acpAgents: set.acpAgents });
  assert.equal(t.app.store.settings.acpAgents[0].env.API_KEY, 'abcd-efgh-9999');
});

test('#10 구독 모드는 Claude 게이트웨이 토큰(ANTHROPIC_AUTH_TOKEN)도 빼고 실행한다', async () => {
  const saved = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'gw-token-7777';
  try {
    const { sid } = await newChat({ name: '게이트웨이', role: '정리', provider: 'claude', model: 'sonnet' });
    await say(sid, '정리');
    assert.equal(t.fakeLog().filter((l) => l.cli === 'claude' && l.args).at(-1).tok, '');
  } finally { if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saved; }
});

test('#13 경로로 준 명령도 찾는다 + #18 불러온 세션의 원래 폴더가 사라지면 빈 폴더를 다시 만들지 않는다', async () => {
  assert.equal(resolveCommand(process.execPath)?.file, process.execPath);
  const gone = path.join(t.root, 'gone-proj');
  const s = t.app.store.createSession({ title: '사라진 폴더', cwd: gone });
  s.importedFrom = { source: 'claude', id: 'x' };
  const dir = t.app.orch.cwdOf(s);
  assert.notEqual(dir, gone);
  assert.ok(!fs.existsSync(gone), '원래 경로를 다시 만들지 않음');
});

test('라우팅 미리보기도 실제 실행처럼 한도 임박 AI를 빼고 보여준다 + ACP 프리셋엔 제3자 어댑터가 없다', async () => {
  const pv = async () => (await t.api('POST', '/api/routing/preview', { items: [{ key: 'o', role: '정리', profile: 'balanced' }] })).json[0].route.provider;
  assert.equal(await pv(), 'codex');
  t.app.store.usage.limits = { codex: { windows: { seven_day: { pct: 99, resetsAt: later() } }, observedAt: Date.now() } };
  assert.equal(await pv(), 'claude');
  const presets = (await t.api('GET', '/api/acp/presets')).json;
  assert.ok(presets.length >= 5);
  assert.ok(presets.every((p) => p.command !== 'npx'), '공식 CLI 가 직접 ACP 를 지원하는 것만');
});

test('재검증 N2 이어받을 AI를 고르는 사이에 건너뛰기를 누르면 대체 AI를 실행하지 않는다', async () => {
  const reg = t.app.providers;
  const orig = reg.catalog.bind(reg);
  reg.catalog = async (...x) => { await sleep(900); return orig(...x); };
  try {
    const { a, sid } = await newChat({ name: '건너뛰기경쟁', role: '빌드', provider: 'claude', model: 'opus' });
    const codexBefore = t.fakeLog().filter((l) => l.cli === 'codex').length;
    await t.api('POST', `/api/sessions/${sid}/messages`, { text: 'QUOTAFAIL 빌드' });
    await t.waitFor(() => t.app.orch.cooldown.active('claude'), 8000, '한도 감지');
    const r = await t.api('POST', `/api/sessions/${sid}/control`, { action: 'skip', agentId: a.id });
    assert.equal(r.json.ok, true);
    await t.waitFor(() => t.app.store.getSession(sid).runs.at(-1)?.endedAt, 8000, '종료');
    await sleep(300);
    assert.equal(t.fakeLog().filter((l) => l.cli === 'codex').length, codexBefore, '건너뛴 뒤 Codex 실행 없음');
    assert.equal(t.app.store.getSession(sid).messages.filter((x) => x.role === 'agent').at(-1).status, 'stopped');
  } finally { reg.catalog = orig; }
});

test('재검증 N5 자동 라우팅 중에 중지하면 사무실 상태가 "중지됨"으로 풀린다', async () => {
  const reg = t.app.providers;
  const orig = reg.catalog.bind(reg);
  reg.catalog = async (...x) => { await sleep(700); return orig(...x); };
  try {
    const { a, sid } = await newChat({ name: '라우팅중지', role: '분석', provider: 'claude', routing: 'auto', routingProfile: 'balanced' });
    await t.api('POST', `/api/sessions/${sid}/messages`, { text: '분석' });
    await sleep(200);
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => t.app.store.getSession(sid).runs.at(-1)?.endedAt, 8000, '종료');
    await sleep(800);
    const last = t.events.filter((e) => e.type === 'agentState' && e.data.sessionId === sid && e.data.agentId === a.id).at(-1).data;
    assert.deepEqual([last.state, last.detail], ['idle', '중지됨']);
  } finally { reg.catalog = orig; }
});

test('재검증 N7·N8 비밀값 이름은 단어로 판별하고, 짧은 값은 끝자리도 숨기고, 가림 표시를 고쳐 쓰면 알린다', async () => {
  const c = (await t.api('POST', '/api/connectors', { name: 'Mix', type: 'stdio', command: 'npx', args: 'x', env: { AUTHOR: 'me', SESSION_DIR: '/tmp/s', KEYBOARD_LAYOUT: 'us', GH_PAT: 'ghp_abcdefgh1234', apiKey: 'sk-zzzzzzzz5678', SHORT_TOKEN: 'ab' } })).json;
  assert.deepEqual([c.env.AUTHOR, c.env.SESSION_DIR, c.env.KEYBOARD_LAYOUT], ['me', '/tmp/s', 'us'], '일반 값은 그대로');
  assert.equal(c.env.GH_PAT, '••••••••1234');
  assert.equal(c.env.apiKey, '••••••••5678');
  assert.equal(c.env.SHORT_TOKEN, '••••••••', '짧은 값은 끝자리도 숨김');
  const bad = await t.api('PUT', `/api/connectors/${c.id}`, { ...c, env: { ...c.env, GH_PAT: '••••••••1234x' } });
  assert.equal(bad.status, 400, '가림 표시를 고쳐 쓰면 저장 안 하고 알림');
  const renamed = { ...c.env, GITHUB_PAT: c.env.GH_PAT };
  delete renamed.GH_PAT;
  assert.equal((await t.api('PUT', `/api/connectors/${c.id}`, { ...c, env: renamed })).status, 200);
  assert.equal(t.app.store.get('connectors', c.id).env.GITHUB_PAT, 'ghp_abcdefgh1234', '이름만 바꿔도 원래 값 유지');
});

test('재검증 N9 API 키 모드에서 앱에 키가 없으면 PC 의 게이트웨이 토큰을 그대로 쓴다', async () => {
  const saved = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'gw-token-4321';
  try {
    await t.api('PUT', '/api/settings', { authMode: { claude: 'apikey' }, apiKeys: { anthropic: '' } });
    const { sid } = await newChat({ name: '게이트웨이키', role: '정리', provider: 'claude', model: 'sonnet' });
    await say(sid, '정리');
    assert.equal(t.fakeLog().filter((l) => l.cli === 'claude' && l.args).at(-1).tok, '4321');
    await t.app.providers.refresh('claude');
    assert.equal(t.app.providers.detected.claude.loggedIn, true, '게이트웨이 토큰도 키로 인정');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saved;
    await t.api('PUT', '/api/settings', { authMode: { claude: 'login' } });
    t.app.providers.detected.claude = { installed: true, loggedIn: true };
  }
});

test('재검증 N13 경로에 공백이 있는 .cmd 도 셸로 실행된다(윈도우)', async () => {
  if (process.platform !== 'win32') return; // .cmd 는 윈도우 전용
  const { runQuick } = await import('../server/providers/util.js');
  const dir = path.join(t.root, 'with space');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'hello.cmd');
  fs.writeFileSync(f, '@echo hello-from-cmd\r\n');
  const r = await runQuick(f, []);
  assert.match(r.out, /hello-from-cmd/);
});

test('최종검증 1·5·6 붙여 쓴 비밀값 이름도 가리고, 같은 값을 둔 이름 하나를 바꿔도 저장되며, 가린 값을 일반 이름으로 옮기면 막는다', async () => {
  const env = { PGPASSWORD: 'pg-real-password-99', ACCESSTOKEN: 'acc-token-123456', API_KEYS: 'k1,k2-abcdefgh', CLIENT_SECRETS: 'cs-abcdefgh-777', MAX_TOKENS: '4096', GH_TOKEN: 'same-token-abcd1234', GITHUB_TOKEN: 'same-token-abcd1234' };
  const c = (await t.api('POST', '/api/connectors', { name: 'Many', type: 'stdio', command: 'npx', args: 'x', env })).json;
  for (const k of ['PGPASSWORD', 'ACCESSTOKEN', 'API_KEYS', 'CLIENT_SECRETS', 'GH_TOKEN', 'GITHUB_TOKEN']) assert.ok(c.env[k].startsWith('••••••••'), k);
  assert.equal(c.env.MAX_TOKENS, '4096', '설정 이름은 그대로');
  const renamed = { ...c.env, GH_TOKEN_OLD: c.env.GH_TOKEN };
  delete renamed.GH_TOKEN;
  assert.equal((await t.api('PUT', `/api/connectors/${c.id}`, { ...c, env: renamed })).status, 200, '같은 값을 둔 이름 중 하나만 바꿔도 저장');
  assert.equal(t.app.store.get('connectors', c.id).env.GH_TOKEN_OLD, 'same-token-abcd1234');
  const toPlain = { ...c.env, GITHUB: c.env.PGPASSWORD };
  assert.equal((await t.api('PUT', `/api/connectors/${c.id}`, { ...c, env: toPlain })).status, 400, '가린 값을 일반 이름으로 옮기면 거부');
});

test('최종검증 4 작업 폴더가 정션·링크여도 실제 경로로 보낸 읽기 요청은 허용한다', async () => {
  const real = path.join(t.root, 'acp-real', 'realwork');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'note.txt'), '실제 경로 노트');
  const junction = path.join(t.root, 'acp-real', 'workj');
  fs.symlinkSync(real, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await t.api('PUT', '/api/settings', { acpAgents: [{ id: 'fake', name: '가짜 ACP', command: 'fake-acp', args: [] }] });
  const a = (await t.api('POST', '/api/agents', { name: 'ACP실경로', role: '조사', provider: 'acp', model: 'fake', permission: 'plan' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id, cwd: junction })).json;
  const m = await say(s.id, 'ACPREAL 읽어');
  assert.equal(m.status, 'done', m.error);
  const r = t.fakeLog().filter((l) => l.cli === 'acp' && l.method === 'realpath-read').at(-1);
  assert.deepEqual([r.error, r.content], [false, '실제 경로 노트']);
});

test('최종검증 7 셸로 실행하는 .cmd 경로에 & ·괄호·^ 가 있어도 실행되고, % 가 든 경로는 거부한다(윈도우)', async () => {
  if (process.platform !== 'win32') return; // .cmd 는 윈도우 전용
  const { runQuick } = await import('../server/providers/util.js');
  const dir = path.join(t.root, 'R&D (x)^1');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'hello.cmd');
  fs.writeFileSync(f, '@echo hello-special\r\n');
  assert.match((await runQuick(f, [])).out, /hello-special/);
  const bad = path.join(t.root, '100%dir');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'x.cmd'), '@echo nope\r\n');
  const r = await runQuick(path.join(bad, 'x.cmd'), []);
  assert.equal(r.code, -1, '% 가 든 경로는 실행 전에 거부');
});

test('최종 재검증 1·2 토큰 개수 설정·SECRETARY·PIN_MEMORY 는 그대로 보이고, TOKENIZER_API_KEY·MAX_TOKENS_SECRET·PIN 은 가린다', async () => {
  const plain = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', MAX_THINKING_TOKENS: '8000', MAX_MCP_OUTPUT_TOKENS: '25000', OPENAI_MAX_COMPLETION_TOKENS: '4096', CONTEXT_TOKENS: '200000', TOKEN_LIMIT: '1000', SECRETARY_NAME: 'kim', PIN_MEMORY: 'true', TOKENIZERS_PARALLELISM: 'false' };
  const secret = { TOKENIZER_API_KEY: 'tk-abcdefgh-1111', MAX_TOKENS_SECRET: 'mts-abcdefgh-2222', PIN: '123456', REFRESH_TOKEN: 'rt-abcdefgh-3333', API_KEY2: 'k2-abcdefgh-4444' };
  const c = (await t.api('POST', '/api/connectors', { name: 'Counts', type: 'stdio', command: 'npx', args: 'x', env: { ...plain, ...secret }, headers: { 'X-Max-Tokens': '1024', 'X-Api-Key': 'xk-abcdefgh-5555' } })).json;
  for (const [k, v] of Object.entries(plain)) assert.equal(c.env[k], v, `${k} 는 일반 값`);
  for (const k of Object.keys(secret)) assert.ok(c.env[k].startsWith('••••••••'), `${k} 는 가림`);
  assert.equal(c.headers['X-Max-Tokens'], '1024', '헤더의 토큰 개수 설정도 일반 값');
  assert.ok(c.headers['X-Api-Key'].startsWith('••••••••'));
});

test('최종 재검증 4 사용률 없는 거절 기록으로 한도에 걸리면, 화면의 쉬는 시간도 실제로 피하는 시각까지로 보여준다', async () => {
  const { sid } = await newChat({ name: '사용률없음', role: '분석', provider: 'claude', model: 'opus' });
  assert.equal((await say(sid, 'QUOTANOPCT 분석해줘')).provider, 'codex', '다른 AI가 이어받음');
  const rest = (await t.api('GET', '/api/cooldown')).json.claude;
  const mins = Math.round((rest.until - Date.now()) / 60000);
  assert.ok(mins > 200, `초기화 시각(약 240분 뒤)까지 쉬어야 함: ${mins}분`);
});

test('최종 재검증 A·B MAX_BOT_TOKEN 같은 비밀값은 가리고, AUTH0_DOMAIN·MAX_NEW_TOKENS 같은 일반 값은 그대로 둔다', async () => {
  const plain = { AUTH0_DOMAIN: 'dev-x.us.auth0.com', AUTH0_CLIENT_ID: 'abc', MAX_NEW_TOKENS: '512', CONTEXT_WINDOW_TOKENS: '200000', TOKENS_PER_MINUTE: '8000', MAX_TOKEN: '100', MAX_OUTPUT_TOKEN: '4096' };
  const secret = { MAX_BOT_TOKEN: 'mb-abcdefgh-1111', MAX_ACCESS_TOKEN: 'ma-abcdefgh-2222', HBO_MAX_TOKEN: 'hb-abcdefgh-3333', MAX_BOT_TOKENS: 'mbs-abcdefgh-4444', PASS1: 'p1-abcdefgh', KEY1: 'k1-abcdefgh' };
  const c = (await t.api('POST', '/api/connectors', { name: 'AB', type: 'stdio', command: 'npx', args: 'x', env: { ...plain, ...secret } })).json;
  for (const [k, v] of Object.entries(plain)) assert.equal(c.env[k], v, `${k} 는 일반 값`);
  for (const k of Object.keys(secret)) assert.ok(c.env[k].startsWith('••••••••'), `${k} 는 가림`);
});

test('최종 재검증 3차 실제 설정(Aider·Dify·tiktoken, 중간에 AUTH·COOKIE 가 낀 이름)은 그대로, BASIC_AUTH·TS_AUTHKEY·SESSION_TOKENS 는 가린다', async () => {
  const plain = { AIDER_MAX_CHAT_HISTORY_TOKENS: '4096', INDEXING_MAX_SEGMENTATION_TOKENS_LENGTH: '1000', AIDER_MAP_TOKENS: '1024', TIKTOKEN_CACHE_DIR: '/tmp/tk', SSH_AUTH_SOCK: '/tmp/agent.sock', AUTH_TRUST_HOST: 'true', COOKIE_DOMAIN: '.example.com', SESSION_COOKIE_NAME: 'sid',
    AUTH_GITHUB_ID: 'Iv1.abc', GF_AUTH_DISABLE_LOGIN_FORM: 'true', REMEMBER_COOKIE_DURATION: '3600',
    // 1.1: 설정을 뜻하는 끝 단어(관문 검증 N2) — Grafana·Laravel·Spring 의 실제 설정 이름
    GF_AUTH_GENERIC_OAUTH_AUTO_LOGIN: 'false', GF_AUTH_GENERIC_OAUTH_USE_PKCE: 'true', AUTH_GUARD: 'web', AUTH_MODEL: 'App\\User', CSRF_COOKIE_MASKED: 'true', SERVER_SERVLET_SESSION_COOKIE_HTTP_ONLY: 'true' };
  // 이름 가운데 AUTH 가 있어도 끝 단어가 설정이 아니면 비밀값(GitLab CI·yarn·워드프레스 도커가 실제로 쓰는 이름)
  const secret = { BASIC_AUTH: 'user:pass-abcdefgh', NPM_CONFIG__AUTH: 'dXNlcjpwYXNz-abcd', TS_AUTHKEY: 'tskey-abcdefgh-1111', SESSION_TOKENS: 'st-abcdefgh-2222', BEARER2: 'b2-abcdefgh-3333', AUTH_HEADER: 'Bearer abcdefgh-4444',
    DOCKER_AUTH_CONFIG: '{"auths":{"r":{"auth":"abcdefgh"}}}', YARN_NPM_AUTH_IDENT: 'user:pass-abcdefgh', WORDPRESS_AUTH_SALT: 'salt-abcdefgh-5555' };
  const c = (await t.api('POST', '/api/connectors', { name: 'Real3', type: 'stdio', command: 'npx', args: 'x', env: { ...plain, ...secret }, headers: { Cookie: 'sid=abcdefgh-5555', 'Set-Cookie': 'a=abcdefgh-6666', 'X-Auth-User': 'me' } })).json;
  for (const [k, v] of Object.entries(plain)) assert.equal(c.env[k], v, `${k} 는 일반 값`);
  for (const k of Object.keys(secret)) assert.ok(c.env[k].startsWith('••••••••'), `${k} 는 가림`);
  assert.ok(c.headers.Cookie.startsWith('••••••••') && c.headers['Set-Cookie'].startsWith('••••••••'), '쿠키 헤더는 가림');
  assert.equal(c.headers['X-Auth-User'], 'me', '사용자 이름 헤더는 그대로');
});

test('최종 재검증 C 초기화 시각 없는 거절 이벤트가 연달아 와도 쉬는 목록 알림은 매번 나가지 않는다', async () => {
  const { sid } = await newChat({ name: '거절연속', role: '정리', provider: 'claude', model: 'sonnet' });
  const n = t.events.filter((e) => e.type === 'cooldown').length;
  assert.equal((await say(sid, 'LIMITSPAM 정리해줘')).status, 'done');
  const sent = t.events.filter((e) => e.type === 'cooldown').length - n;
  assert.ok(sent >= 1 && sent <= 2, `거절 이벤트 5번에 알림 ${sent}번(분이 바뀔 때만 한 번 더)`);
});

test('최종 재검증 5 공백 없이 & ·괄호·^ 가 든 경로의 .cmd 도 실행된다(윈도우)', async () => {
  if (process.platform !== 'win32') return; // .cmd 는 윈도우 전용
  const { runQuick } = await import('../server/providers/util.js');
  const names = ['R&D', 'paren(x)', 'a^b'];
  for (const [i, name] of names.entries()) {
    const dir = path.join(t.root, 'nospace', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hi.cmd'), `@echo hi-nospace-${i}\r\n`);
    assert.match((await runQuick(path.join(dir, 'hi.cmd'), [])).out, new RegExp(`hi-nospace-${i}`), name);
  }
});
