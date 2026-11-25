// 데모 팀·데모 에이전트를 없애고 가상 AI(mock)를 화면 목록에서 숨긴 것(결정 0021):
// 새 설치 시드에 데모가 없다 / 옛 데이터의 이전 처리(규칙마다, 두 번 돌아도 같다) / 화면에 주는 목록에 mock 이 없다(저장·실행은 된다).
// 가짜 CLI 와 가상 AI 만 쓴다(실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, freePort } from './helpers.js';
import { createApp } from '../server/index.js';
import { Store, DEMO_TEAM_ID, DEMO_AGENT_IDS } from '../server/store.js';
import { seedData, defaultSettings } from '../server/seed.js';
import { dataDirs, ensureDirs } from '../server/config.js';
import { NoteStore } from '../server/notes.js';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// 예전 첫 실행 데이터에 있던 데모 에이전트·데모 팀(옛 시드와 같은 모양)
const oldDemoAgent = (id, role, extra = {}) => ({
  id, name: `데모 ${role}봇`, role, emoji: '🤖', provider: 'mock', model: 'mock-fast', effort: 'medium', permission: 'plan',
  systemPrompt: '데모용 가상 에이전트(사용량 0).', skills: [], connectors: [], routing: 'manual', ...extra,
});
const oldDemoTeam = (extra = {}) => ({
  id: DEMO_TEAM_ID, name: '데모 팀 (사용량 0)', description: '가상 에이전트로 화면·애니메이션·개입 기능을 체험',
  stages: [
    { id: 'st-d1', label: '조사', agentIds: ['demo-researcher'], instruction: '', approve: false },
    { id: 'st-d2', label: '정리·분석', agentIds: ['demo-organizer', 'demo-analyst'], instruction: '', approve: true },
    { id: 'st-d3', label: '빌드', agentIds: ['demo-builder'], instruction: '', approve: false },
  ],
  ...extra,
});

// 옛 데이터 폴더를 만든다: 기본 데이터 + 데모 에이전트 넷 + 데모 팀 + 사용자 팀들 + 설정 + (있으면) 세션
function writeOldHome(home, { agents, teams, settings, sessions = [] }) {
  const dirs = dataDirs(home);
  ensureDirs(dirs);
  fs.writeFileSync(path.join(home, 'agents.json'), JSON.stringify(agents, null, 2));
  fs.writeFileSync(path.join(home, 'teams.json'), JSON.stringify(teams, null, 2));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ ...defaultSettings(), ...settings }, null, 2));
  for (const s of sessions) fs.writeFileSync(path.join(dirs.sessions, `${s.id}.json`), JSON.stringify(s, null, 2));
  return dirs;
}

test('1. 새 설치: 시드에 데모 팀·데모 에이전트·가상 AI 에이전트가 없고, 기본 팀·기본 에이전트는 기본 팀과 그 첫 에이전트다', async () => {
  const seed = seedData();
  assert.ok(!seed.teams.some((x) => x.id === DEMO_TEAM_ID), '시드에 데모 팀 없음');
  assert.deepEqual(seed.agents.filter((a) => DEMO_AGENT_IDS.includes(a.id) || a.provider === 'mock').map((a) => a.id), [], '시드에 데모·가상 에이전트 없음');
  const d = defaultSettings();
  assert.deepEqual([d.defaultTeamId, d.defaultAgentId], ['team-default', 'researcher']);
  assert.equal(seed.teams.find((x) => x.id === d.defaultTeamId).stages[0].agentIds[0], d.defaultAgentId, '기본 에이전트는 기본 팀의 첫 에이전트');
  // 새로 깐 앱(테스트 앱이 바로 새 설치다): 화면이 받는 데이터와 디스크의 파일 모두
  const boot = (await t.api('GET', '/api/bootstrap')).json;
  assert.ok(!boot.teams.some((x) => x.id === DEMO_TEAM_ID));
  assert.ok(!boot.agents.some((a) => DEMO_AGENT_IDS.includes(a.id) || a.provider === 'mock'));
  assert.deepEqual([boot.settings.defaultTeamId, boot.settings.defaultAgentId], ['team-default', 'researcher']);
  const home = t.app.dirs.home;
  assert.ok(!readJson(path.join(home, 'teams.json')).some((x) => x.id === DEMO_TEAM_ID));
  assert.ok(!readJson(path.join(home, 'agents.json')).some((a) => a.provider === 'mock'));
  assert.equal(readJson(path.join(home, 'settings.json')).defaultTeamId, 'team-default');
  // 팀도 에이전트도 고르지 않은 새 세션은 기본 팀으로
  const s = (await t.api('POST', '/api/sessions', {})).json;
  assert.equal(s.teamId, 'team-default');
  await t.api('DELETE', `/api/sessions/${s.id}`);
});

test('2. 화면에 주는 목록에 가상 AI(mock)가 없다: 첫 데이터·프로바이더 목록·라우팅 카탈로그·프로바이더별 경로. 저장과 실행은 그대로 된다', async () => {
  const boot = (await t.api('GET', '/api/bootstrap')).json;
  assert.ok(boot.providers.length > 0);
  assert.ok(!boot.providers.some((p) => p.id === 'mock' || p.kind === 'mock'), '첫 데이터의 프로바이더 목록');
  const list = (await t.api('GET', '/api/providers')).json;
  assert.deepEqual(list.map((p) => p.id), boot.providers.map((p) => p.id));
  assert.ok(!list.some((p) => p.id === 'mock'), '/api/providers');
  assert.ok(!t.app.providers.list().some((p) => p.id === 'mock'), '서버가 SSE 로 보내는 목록(list)도 같다');
  const cat = (await t.api('GET', '/api/routing/catalog')).json;
  assert.ok(!cat.providers.some((p) => p.id === 'mock') && !('mock' in cat.models), '라우팅 카탈로그(모델 목록 포함)');
  assert.equal((await t.api('GET', '/api/providers/mock/models')).status, 404);
  assert.equal((await t.api('POST', '/api/providers/mock/refresh')).status, 404);
  assert.equal((await t.api('GET', '/api/providers/claude/models')).status, 200, '다른 프로바이더는 그대로');
  // 자동 라우팅도 가상 AI 로 가지 않는다
  const pv = (await t.api('POST', '/api/routing/preview', { items: [{ key: 'x', role: '조사', profile: 'economy' }] })).json[0].route;
  assert.notEqual(pv?.provider, 'mock');
  // 저장·실행: API 로 만든 가상 AI 에이전트는 받고, 돌린다(테스트가 이렇게 쓴다)
  const a = await t.api('POST', '/api/agents', { name: '가상 하나', role: '조사', provider: 'mock', model: 'mock-fast', skills: [] });
  assert.equal(a.status, 200);
  assert.equal(a.json.provider, 'mock');
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.json.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '가상으로 돌려 봐' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 15000, '가상 AI 실행 끝');
  const m = t.app.store.getSession(s.id).messages.find((x) => x.role === 'agent');
  assert.deepEqual([m.status, m.provider], ['done', 'mock']);
  // 만든 가상 에이전트가 있어도 프로바이더 목록에는 여전히 없다
  assert.ok(!(await t.api('GET', '/api/providers')).json.some((p) => p.id === 'mock'));
  await t.api('DELETE', `/api/sessions/${s.id}`);
  await t.api('DELETE', `/api/agents/${a.json.id}`);
});

test('3. 이전 처리(저장소만): 기본 팀·기본 에이전트가 지운 것을 가리킬 때 고르는 순서, 남긴 데모 에이전트를 가리키면 그대로', () => {
  const real = seedData().agents.filter((a) => !a.routing || a.routing === 'manual').map((a) => ({ ...a, routing: a.routing || 'manual' }));
  const cases = [
    {
      what: '기본 팀을 지운 사용자: 남은 첫 팀과 그 팀의 첫 에이전트',
      teams: [{ id: 'team-mine', name: '내 팀', description: '', stages: [{ id: 'x1', label: '1', agentIds: ['demo-researcher', 'builder'] }] }, oldDemoTeam()],
      settings: { defaultTeamId: DEMO_TEAM_ID, defaultAgentId: 'demo-researcher' },
      want: ['team-mine', 'builder'],
    },
    {
      what: '팀이 데모 팀뿐: 팀 없음(null)과 남은 첫 에이전트',
      teams: [oldDemoTeam()],
      settings: { defaultTeamId: DEMO_TEAM_ID, defaultAgentId: 'demo-builder' },
      want: [null, real[0].id],
    },
    {
      what: '사용자가 고른 기본 팀은 그대로, 지운 기본 에이전트만 그 팀의 첫 에이전트로',
      teams: [seedData().teams[0], { id: 'team-mine', name: '내 팀', description: '', stages: [{ id: 'x1', label: '1', agentIds: ['analyst'] }] }, oldDemoTeam()],
      settings: { defaultTeamId: 'team-mine', defaultAgentId: 'demo-researcher' },
      want: ['team-mine', 'analyst'],
    },
    {
      what: '진짜 AI 로 바꿔 쓰는 데모 에이전트를 가리키면 그대로',
      agents: [oldDemoAgent('demo-analyst', '분석', { provider: 'claude', model: 'sonnet' })],
      teams: [seedData().teams[0], oldDemoTeam()],
      settings: { defaultTeamId: DEMO_TEAM_ID, defaultAgentId: 'demo-analyst' },
      want: ['team-default', 'demo-analyst'],
    },
  ];
  for (const c of cases) {
    const home = fs.mkdtempSync(path.join(t.root, 'oc-demo-st-'));
    const demo = c.agents || DEMO_AGENT_IDS.map((id) => oldDemoAgent(id, '조사'));
    const dirs = writeOldHome(home, { agents: [...real, ...demo], teams: c.teams, settings: c.settings });
    const st = new Store(dirs).init();
    try {
      assert.deepEqual([st.settings.defaultTeamId, st.settings.defaultAgentId], c.want, c.what);
      const saved = readJson(path.join(home, 'settings.json'));
      assert.deepEqual([saved.defaultTeamId, saved.defaultAgentId], c.want, `${c.what}: 파일에도 저장`);
    } finally { st.close(); }
  }
});

test('4. 이전 처리(앱): 데모 팀은 지우고, 가상 AI 그대로인 데모 에이전트만 지워 다른 팀 단계에서도 빼고, 역할 노트는 에이전트 삭제처럼, 옛 세션은 기록으로 남기고, 두 번 돌아도 같다', async () => {
  const home = path.join(t.root, 'old-home');
  const T = Date.now() - 86400_000;
  const real = seedData().agents.map((a) => ({ ...a, routing: a.routing || 'manual' }));
  const agents = [
    ...real,
    oldDemoAgent('demo-researcher', '조사'), // 그대로 → 지운다
    oldDemoAgent('demo-organizer', '정리', { routing: 'auto' }), // 자동 라우팅으로 돌린 것(실행 때 진짜 AI 를 고른다) → 남긴다
    oldDemoAgent('demo-analyst', '분석', { provider: 'claude', model: 'sonnet', name: '내 분석가' }), // 진짜 AI 로 바꾼 것 → 남긴다
    oldDemoAgent('demo-builder', '빌드', { permission: 'edit' }), // 그대로 → 지운다
  ];
  const teams = [
    ...seedData().teams,
    oldDemoTeam({ name: '내가 고친 데모 팀', stages: [...oldDemoTeam().stages, { id: 'st-d4', label: '검수', agentIds: ['reviewer-x'] }] }), // 손댄 흔적이 있어도 지운다
    {
      id: 'team-mixed', name: '섞인 팀', description: '',
      stages: [
        { id: 'm1', label: '데모만', agentIds: ['demo-researcher'], instruction: '', approve: false }, // 비게 되어 빠진다
        { id: 'm2', label: '둘', agentIds: ['researcher', 'demo-builder'], instruction: '', approve: true }, // 진짜 에이전트만 남는다
        { id: 'm3', label: '남긴 데모', agentIds: ['demo-analyst'], instruction: '', approve: false }, // 남긴 에이전트라 그대로
      ],
    },
    { id: 'team-only-demo', name: '데모로만 짠 팀', description: '', stages: [{ id: 'o1', label: '빌드', agentIds: ['demo-builder'], instruction: '', approve: false }] },
  ];
  const oldSession = {
    id: 's-olddemo1', title: '데모 팀으로 해 본 일', teamId: DEMO_TEAM_ID, agentId: null, cwd: '', pinned: false, createdAt: T, updatedAt: T,
    providerSessions: { 'demo-researcher': 'mock-old' },
    messages: [
      { id: 'm-u1', role: 'user', text: '시장 조사해줘', createdAt: T, status: 'done' },
      { id: 'm-a1', role: 'agent', agentId: 'demo-researcher', provider: 'mock', model: 'mock-fast', runId: 'run-old1', stageLabel: '조사', text: '## 조사 결과 — 시장 조사해줘', blocks: [], status: 'done', createdAt: T },
      { id: 'm-a2', role: 'agent', agentId: 'demo-builder', provider: 'mock', model: 'mock-fast', runId: 'run-old1', stageLabel: '빌드', text: '## 빌드 결과 — 시장 조사해줘', blocks: [], status: 'done', createdAt: T },
    ],
    runs: [{ id: 'run-old1', teamId: DEMO_TEAM_ID, status: 'done', stageIndex: 2, hold: null, userMessageId: 'm-u1', startedAt: T, endedAt: T,
      stages: [{ label: '조사', agentIds: ['demo-researcher'], status: 'done' }, { label: '빌드', agentIds: ['demo-builder'], status: 'done' }] }],
  };
  writeOldHome(home, { agents, teams, settings: { defaultTeamId: DEMO_TEAM_ID, defaultAgentId: 'demo-researcher' }, sessions: [oldSession] });
  // 역할 노트: 지울 에이전트 하나, 남길 에이전트 하나
  const ns = new NoteStore(path.join(home, 'notes'));
  ns.addItem('demo-researcher', { kind: 'method', text: '출처를 꼭 붙여', source: { type: 'user' } });
  ns.addItem('demo-analyst', { kind: 'method', text: '위험부터 본다', source: { type: 'user' } });
  const notesDir = path.join(home, 'notes');

  const start = async () => {
    const app = createApp({ home, port: 0, detect: false });
    app.store.settings.lang = 'ko';
    app.store.settings.mockSpeed = 0.05;
    const port = await app.listen(await freePort());
    const api = async (method, p, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Office-Token': app.token }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 비JSON */ }
      return { status: r.status, json };
    };
    return { app, api };
  };

  let { app, api } = await start();
  let snapshot;
  try {
    const ids = app.store.all('agents').map((a) => a.id);
    // 에이전트: 가상 AI 그대로인 데모 에이전트만 지운다
    assert.ok(!ids.includes('demo-researcher') && !ids.includes('demo-builder'), '가상 AI 그대로인 데모 에이전트는 지운다');
    assert.ok(ids.includes('demo-organizer'), '자동 라우팅으로 돌린 데모 에이전트는 남긴다');
    assert.equal(app.store.get('agents', 'demo-analyst').name, '내 분석가', '진짜 AI 로 바꾼 데모 에이전트는 그대로 남긴다');
    for (const a of real) assert.ok(ids.includes(a.id), `기본 에이전트 ${a.id} 는 그대로`);
    // 팀: 데모 팀은 지우고, 다른 팀 단계에서 지운 에이전트를 뺀다(에이전트 삭제와 같은 규칙: 빈 단계는 빠지고 팀은 남는다)
    assert.equal(app.store.get('teams', DEMO_TEAM_ID), null, '손댄 데모 팀도 지운다');
    const mixed = app.store.get('teams', 'team-mixed');
    assert.deepEqual(mixed.stages.map((s) => [s.id, s.agentIds]), [['m2', ['researcher']], ['m3', ['demo-analyst']]]);
    assert.equal(mixed.stages[0].approve, true, '남은 단계의 다른 값은 그대로');
    assert.deepEqual(app.store.get('teams', 'team-only-demo').stages, [], '단계가 다 빈 팀은 지우지 않고 단계 없이 남는다(에이전트를 직접 지웠을 때와 같다)');
    assert.deepEqual(app.store.get('teams', 'team-default').stages, seedData().teams[0].stages, '다른 팀은 그대로');
    // 팀 저장 규칙(cleanTeam): 남은 단계로 그대로 저장되고, 단계 없는 팀은 사람이 에이전트를 넣어야 저장된다
    assert.equal((await api('PUT', '/api/teams/team-mixed', mixed)).status, 200);
    const empty = app.store.get('teams', 'team-only-demo');
    assert.equal((await api('PUT', '/api/teams/team-only-demo', empty)).status, 400, '빈 팀은 지금처럼 저장 규칙이 막는다');
    assert.equal((await api('PUT', '/api/teams/team-only-demo', { ...empty, stages: [{ label: '빌드', agentIds: ['builder'] }] })).status, 200);
    // 설정: 기본 팀 → 기본 팀(team-default), 기본 에이전트 → 그 팀의 첫 에이전트
    assert.deepEqual([app.store.settings.defaultTeamId, app.store.settings.defaultAgentId], ['team-default', 'researcher']);
    // 역할 노트: 지운 에이전트 것은 에이전트 삭제처럼 이름만 바꿔 남기고, 남긴 에이전트 것은 그대로
    const files = fs.readdirSync(notesDir).sort();
    assert.ok(!files.includes('demo-researcher.json') && files.includes('demo-researcher.removed.json'), files.join(','));
    assert.ok(files.includes('demo-analyst.json'), '남긴 에이전트의 노트는 그대로');
    assert.equal((await api('GET', '/api/agents/demo-analyst/notes')).json.items.length, 1);
    const boot = (await api('GET', '/api/bootstrap')).json;
    assert.ok(!boot.teams.some((x) => x.id === DEMO_TEAM_ID));
    assert.ok(!boot.providers.some((p) => p.id === 'mock'));

    // 데모 팀으로 하던 옛 세션: 지우지 않고 기록으로 남는다(팀 id 와 데모 에이전트의 답도 그대로)
    assert.ok(boot.sessions.some((x) => x.id === oldSession.id), '세션 목록에 남는다');
    const opened = await api('GET', `/api/sessions/${oldSession.id}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.json.teamId, DEMO_TEAM_ID);
    assert.deepEqual(opened.json.messages.map((m) => m.agentId || m.role), ['user', 'demo-researcher', 'demo-builder']);
    // 팀이 지워진 세션의 지금 동작(DELETE /api/teams/:id 뒤)과 같다: 비교용으로 팀을 만들고 세션을 연 뒤 그 팀을 지운다
    const gone = (await api('POST', '/api/teams', { name: '지울 팀', stages: [{ label: '1', agentIds: ['analyst'] }] })).json;
    const cmp = (await api('POST', '/api/sessions', { teamId: gone.id })).json;
    assert.equal((await api('DELETE', `/api/teams/${gone.id}`)).status, 200);
    for (const sid of [oldSession.id, cmp.id]) {
      // 목표 모드는 팀이 있는 세션에서만: 둘 다 같은 이유로 막는다
      const g = await api('PATCH', `/api/sessions/${sid}`, { goalMode: true });
      assert.equal(g.status, 400, sid);
      assert.match(g.json.error, /팀이 있는 세션에서만/);
      // 새 메시지는 팀 대신 기본 에이전트 한 명이 받는다
      const before = app.store.getSession(sid).runs.length;
      assert.equal((await api('POST', `/api/sessions/${sid}/messages`, { text: '이어서 해 줘' })).json.started, true, sid);
      await t.waitFor(() => app.store.getSession(sid).runs.length > before && app.store.getSession(sid).runs.at(-1).endedAt && !app.orch.ctx.has(sid), 20000, `${sid} 실행 끝`);
      const run = app.store.getSession(sid).runs.at(-1);
      assert.deepEqual([run.teamId, run.status, run.stages.map((s) => s.agentIds)], [null, 'done', [['researcher']]], sid);
      const ans = app.store.getSession(sid).messages.filter((m) => m.role === 'agent' && m.runId === run.id);
      assert.deepEqual(ans.map((m) => [m.agentId, m.status]), [['researcher', 'done']], sid);
    }
    assert.deepEqual(app.store.getSession(oldSession.id).messages.slice(0, 3).map((m) => m.text), oldSession.messages.map((m) => m.text), '옛 기록은 그대로');
    snapshot = {
      agents: fs.readFileSync(path.join(home, 'agents.json'), 'utf8'),
      teams: fs.readFileSync(path.join(home, 'teams.json'), 'utf8'),
      notes: fs.readdirSync(notesDir).sort(),
    };
  } finally { await app.close(); }

  // 두 번째로 켜도 같다(멱등): 에이전트·팀 파일은 한 글자도 안 바뀌고, 노트 이름을 또 바꾸지 않고, 설정도 그대로
  ({ app, api } = await start());
  try {
    assert.equal(fs.readFileSync(path.join(home, 'agents.json'), 'utf8'), snapshot.agents);
    assert.equal(fs.readFileSync(path.join(home, 'teams.json'), 'utf8'), snapshot.teams);
    assert.deepEqual(fs.readdirSync(notesDir).sort(), snapshot.notes);
    assert.deepEqual([app.store.settings.defaultTeamId, app.store.settings.defaultAgentId], ['team-default', 'researcher']);
    assert.ok(app.store.get('agents', 'demo-analyst') && app.store.get('agents', 'demo-organizer'), '남긴 데모 에이전트는 두 번째에도 남는다');
    assert.equal((await api('GET', `/api/sessions/${oldSession.id}`)).status, 200);
  } finally { await app.close(); }
});
