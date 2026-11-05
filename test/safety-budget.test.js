// 읽기 전용 실행의 훅 차단·로그인 파일 거부·이전 결과 구획·남은 CLI 정리·하루 예산(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startTestApp } from './helpers.js';
import { noteWeekly, dayBudget, lowerEffort, nextMidnight } from '../server/budget.js';
import { unsafeWorkdir } from '../server/config.js';
import { reapLeftovers, procInfo, otherAppRunning } from '../server/providers/procs.js';
import { spawnCli, killTree } from '../server/providers/util.js';

let t;
before(async () => {
  t = await startTestApp();
  const reg = t.app.providers;
  reg.detected = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true } };
  reg.modelCache = {
    claude: { at: Date.now(), version: '', list: [{ id: 'opus', label: 'Opus', tier: 'top', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, { id: 'sonnet', label: 'Sonnet', tier: 'balanced', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
    codex: { at: Date.now(), version: '', list: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'balanced', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
  };
});
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });
beforeEach(() => {
  t.app.orch.cooldown.map.clear();
  Object.assign(t.app.store.usage, { limits: {}, dayBase: {} });
  Object.assign(t.app.store.settings, { failover: true, dailyBudget: false, dailyBudgetPercent: 13 });
});

const runOnce = async (agent, text = '해줘') => {
  const a = (await t.api('POST', '/api/agents', agent)).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 10000, '실행 종료');
  return t.app.store.getSession(s.id).messages.filter((x) => x.role === 'agent').at(-1);
};
const lastArgs = (cli) => t.fakeLog().filter((l) => l.cli === cli && l.args).at(-1).args;
const week = (pct) => ({ pct, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 });
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore', windowsHide: true });
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('읽기 전용 Claude 는 작업 폴더 설정을 안 읽고, 수정 권한이면 그대로 읽는다', async () => {
  await runOnce({ name: '읽기만', role: '분석', provider: 'claude', model: 'opus', permission: 'plan', routing: 'manual' });
  const ro = lastArgs('claude');
  assert.equal(ro[ro.indexOf('--setting-sources') + 1], 'user');
  for (const permission of ['default', 'edit']) {
    await runOnce({ name: `설정읽기${permission}`, role: '빌드', provider: 'claude', model: 'opus', permission, routing: 'manual' });
    assert.ok(!lastArgs('claude').includes('--setting-sources'), permission);
  }
});

test('Claude 실행에는 항상 로그인 파일 읽기 거부 설정이 붙고, 끝나면 임시 파일을 지운다', async () => {
  for (const permission of ['plan', 'full']) {
    await runOnce({ name: `거부${permission}`, role: '빌드', provider: 'claude', model: 'opus', permission, routing: 'manual' });
    const { deny } = t.fakeLog().filter((l) => l.settings).at(-1).settings.permissions;
    for (const p of ['.credentials.json', '.codex/auth.json']) assert.ok(deny.some((d) => d.startsWith('Read(') && d.includes(p)), p);
    // 앱 비밀과 추가 계정은 데이터 폴더 절대 경로로만 막아 정상 프로젝트 파일(locales/accounts/ko/auth.json 등)은 막지 않는다
    const home = path.resolve(t.root, 'home').replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).replace(/^\/+/, '');
    for (const f of ['settings.json', '.token', 'accounts/*/auth.json']) assert.ok(deny.includes(`Read(//${home}/${f})`), f);
    assert.ok(!deny.some((d) => d.includes('**/accounts/')));
    assert.ok(!fs.existsSync(lastArgs('claude')[lastArgs('claude').indexOf('--settings') + 1]));
  }
});

test('읽기 전용 Codex 만 훅을 끄고, 이어 쓸 때(exec resume)도 끈다', async () => {
  const hooksOff = (args) => args.some((x, i) => x === '-c' && args[i + 1] === 'features.hooks=false');
  const a = (await t.api('POST', '/api/agents', { name: 'Codex읽기', role: '분석', provider: 'codex', model: 'gpt-6.1-sol', permission: 'plan', routing: 'manual' })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  for (let turn = 1; turn <= 2; turn++) {
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text: `${turn}번째` });
    await t.waitFor(() => t.app.store.getSession(s.id).runs.length === turn && t.app.store.getSession(s.id).runs.at(-1).endedAt, 10000, '실행 종료');
    assert.ok(hooksOff(lastArgs('codex')), `${turn}번째`);
  }
  assert.ok(lastArgs('codex').includes('resume'), '두 번째는 이어 쓰기');
  await runOnce({ name: 'Codex고치기', role: '빌드', provider: 'codex', model: 'gpt-6.1-sol', permission: 'edit', routing: 'manual' });
  assert.ok(!hooksOff(lastArgs('codex')));
});

test('읽기 전용 에이전트 지침에 프로젝트 규칙 파일을 읽으라고 적는다', async () => {
  await runOnce({ name: '규칙읽기', role: '분석', provider: 'claude', model: 'opus', permission: 'plan', routing: 'manual' });
  assert.match(t.fakeLog().filter((l) => l.system).at(-1).system, /CLAUDE\.md·AGENTS\.md/);
});

test('이전 단계 결과는 매번 다른 표시로 구획하고, 따르지 말라는 안내를 붙인다', async () => {
  const mk = async (name) => (await t.api('POST', '/api/agents', { name, role: '빌드', provider: 'codex', model: 'gpt-6.1-sol', permission: 'plan', routing: 'manual' })).json;
  const [a, b] = [await mk('앞단계'), await mk('뒷단계')];
  const team = (await t.api('POST', '/api/teams', { name: '구획팀', stages: [{ label: '하나', agentIds: [a.id] }, { label: '둘', agentIds: [b.id] }] })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: team.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '해줘' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 15000, '실행 종료');
  const prompt = t.fakeLog().filter((l) => l.cli === 'codex' && l.prompt).at(-1).prompt;
  const mark = prompt.match(/--- 결과 ([0-9a-f]{8}) 시작 ---/)?.[1];
  assert.ok(mark, prompt);
  assert.ok(prompt.includes(`"결과 ${mark}" 표시 사이의 글`));
  assert.ok(prompt.includes(`--- 결과 ${mark} 끝 ---`));
  assert.ok(prompt.indexOf('[사용자 요청]') < prompt.indexOf(`--- 결과 ${mark} 시작`));
});

// ── 하루 예산 ──
test('오늘 기준점: 첫 기록부터 세고, 주간 초기화와 다음 날을 구분한다', () => {
  const now = new Date(2026, 10, 5, 12).getTime();
  const r0 = Math.floor(now / 1000) + 86400;
  const b = noteWeekly(null, { pct: 40, resetsAt: r0 }, now);
  assert.equal(b.pct, 40);
  assert.equal(noteWeekly(b, { pct: 45, resetsAt: r0 }, now).pct, 40, '오늘 안에는 기준점 유지');
  assert.equal(noteWeekly(b, { pct: 2, resetsAt: r0 + 7 * 86400 }, now).pct, 0, '주간 초기화면 0부터');
  assert.equal(noteWeekly(b, { pct: 45, resetsAt: r0 + 7 * 86400 }, now).pct, 0, '초기화 뒤 값이 기준점보다 높아도 0부터');
  assert.equal(noteWeekly(b, { pct: 38, resetsAt: r0 }, now).pct, 38, '초기화 없이 내려가면 그 값부터');
  assert.equal(noteWeekly(b, { pct: 50, resetsAt: r0 }, now + 86400e3).pct, 50, '다음 날은 새 기준점');
  assert.equal(noteWeekly(b, { pct: null }, now), b, '사용률을 모르면 그대로');
});

test('속도: 예산보다 빠르면 노력을 낮추고 다 쓰면 over, 모르면 null', () => {
  const noon = new Date(2026, 10, 5, 12).getTime(); // 남은 시간 50%
  const base = noteWeekly(null, { pct: 10 }, noon);
  const at = (pct) => dayBudget(base, { pct }, 10, noon);
  assert.deepEqual([at(12).steps, at(12).over], [0, false], '남은 예산 80% ≥ 남은 시간 50%');
  assert.equal(at(16).steps, 1, '남은 예산 40% < 50%');
  assert.equal(at(18).steps, 2, '남은 예산 20% < 25%');
  assert.deepEqual([at(20).over, at(20).spent], [true, 10]);
  assert.equal(lowerEffort('ultra', at(20).steps), 'low', '다 쓰면 맨 아래까지');
  const midnight = new Date(2026, 10, 5, 0, 5).getTime();
  const fresh = noteWeekly(null, { pct: 10 }, midnight);
  assert.equal(dayBudget(fresh, { pct: 11 }, 10, midnight).steps, 0, '자정 직후 조금 쓴 걸로는 안 낮춘다');
  assert.equal(dayBudget(fresh, { pct: 13 }, 10, midnight).steps, 1, '하루 몫의 1/4을 넘으면 속도를 본다');
  assert.equal(dayBudget(null, { pct: 5 }, 10, noon), null);
  assert.equal(dayBudget(base, { pct: null }, 10, noon), null);
  assert.equal(dayBudget(base, { pct: 90, resetsAt: Math.floor(noon / 1000) - 60 }, 10, noon).spent, 0, '지난 주간 창은 옛 기록');
  assert.equal(dayBudget(base, { pct: 90 }, 10, noon + 86400e3).spent, 0, '어제 기준점은 안 쓴다');
  assert.equal(dayBudget({ ...base, releasedDay: base.day }, { pct: 90 }, 10, noon).over, false, '오늘 풀어 줬으면 안 막는다');
});

test('노력 낮추기: 올리지 않고 low 아래로 안 내린다', () => {
  assert.equal(lowerEffort('high', 1), 'medium');
  assert.equal(lowerEffort('ultra', 2), 'xhigh');
  assert.equal(lowerEffort('low', 2), 'low');
  assert.equal(lowerEffort('medium', 0), 'medium');
  assert.equal(lowerEffort('', 1), 'low', '비어 있으면 medium 으로 본다');
  assert.equal(lowerEffort('', 0), '');
  assert.equal(lowerEffort('none', 2), 'none');
  assert.ok(nextMidnight(Date.now()) > Date.now());
});

test('위험한 작업 폴더는 거부하고, 프로젝트 폴더와 앱이 만든 작업 폴더는 받는다', async () => {
  const appHome = path.join(t.root, 'home');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-project-'));
  try {
    for (const [dir, why] of [[path.parse(process.cwd()).root, '드라이브 맨 위'], [os.homedir(), '홈'], [path.dirname(os.homedir()), '홈 위'], [appHome, '앱 데이터'], [path.join(appHome, 'accounts'), '앱 데이터 안'], [path.dirname(appHome), '앱 데이터를 품는 폴더']]) {
      assert.equal(unsafeWorkdir(dir, appHome), true, why);
    }
    assert.equal(unsafeWorkdir(project, appHome), false);
    assert.equal(unsafeWorkdir(path.join(appHome, 'workspaces', 's-1'), appHome), false, '앱이 만든 작업 폴더');

    assert.equal((await t.api('POST', '/api/sessions', { teamId: null, cwd: os.homedir() })).status, 400);
    assert.equal((await t.api('PUT', '/api/settings', { defaultCwd: os.homedir() })).status, 400);
    const s = (await t.api('POST', '/api/sessions', { teamId: null, cwd: project })).json;
    assert.equal(s.cwd, project);
    assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { cwd: os.homedir() })).status, 400);
    // 불러온 세션처럼 이미 그 폴더를 쓰던 세션은 다른 값을 고칠 때 막히지 않는다
    t.app.store.getSession(s.id).cwd = os.homedir();
    assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { cwd: os.homedir(), title: '이어서' })).status, 200);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('예약: 맡을 AI가 오늘 몫을 다 쓰면 건너뛰고, 지금 실행과 맡을 AI가 있는 경우는 그대로다', async () => {
  const a = (await t.api('POST', '/api/agents', { name: '예약담당', role: '빌드', provider: 'claude', model: 'opus', permission: 'plan', routing: 'manual' })).json;
  const s = (await t.api('POST', '/api/schedules', { name: '예산 예약', prompt: '해줘', days: [0, 1, 2, 3, 4, 5, 6], time: '03:00', agentId: a.id, teamId: null })).json;
  t.app.store.settings.dailyBudget = true;
  seedBudget('claude', 10, 30);
  const fire = (opts = {}) => t.app.scheduler.fire(t.app.store.get('schedules', s.id), opts);
  try {
    assert.equal(fire().status, 'started', '이어받을 Codex 가 예산 안에 있으면 실행');
    await t.waitFor(() => !t.app.orch.ctx.size, 15000, '실행 종료');
    seedBudget('codex', 10, 30);
    const skipped = fire();
    assert.equal(skipped.status, 'skipped');
    assert.match(skipped.note, /오늘 예산을 다 써서/);
    assert.equal(fire({ manual: true }).status, 'started', '사람이 누른 지금 실행은 그대로');
    await t.waitFor(() => !t.app.orch.ctx.size, 15000, '실행 종료');
    delete t.app.store.usage.dayBase.codex;
    seedBudget('claude', 10, 30); // 가짜 CLI 실행이 한도 기록을 바꿨을 수 있어 다시 맞춘다
    t.app.store.settings.failover = false;
    assert.equal(fire().status, 'skipped', '이어받기를 끄면 넘길 수 없으니 건너뛴다');
    t.app.store.settings.dailyBudget = false;
    assert.equal(fire().status, 'started', '예산을 끄면 그대로');
    await t.waitFor(() => !t.app.orch.ctx.size, 15000, '실행 종료');
  } finally { await t.api('DELETE', `/api/schedules/${s.id}`); }
});

test('설정 저장: 값 범위를 지키고 기본은 꺼짐', async () => {
  assert.equal(t.app.store.settings.dailyBudget, false);
  const s = (await t.api('PUT', '/api/settings', { dailyBudget: 'yes', dailyBudgetPercent: 999, desktopNotify: true })).json;
  assert.equal(s.dailyBudget, false);
  assert.equal(s.dailyBudgetPercent, 50);
  assert.equal(s.desktopNotify, true);
  await t.api('PUT', '/api/settings', { desktopNotify: false, dailyBudgetPercent: 13 });
});

const seedBudget = (provider, startPct, nowPct) => {
  t.app.usage.setLimits({ provider, windows: { seven_day: week(startPct) } }, false);
  t.app.usage.setLimits({ provider, windows: { seven_day: week(nowPct) } }, false);
};

test('꺼져 있으면 예산을 넘어도 아무것도 안 바꾼다', async () => {
  seedBudget('claude', 10, 60);
  const m = await runOnce({ name: '예산끔', role: '빌드', provider: 'claude', model: 'opus', effort: 'high', routing: 'manual' });
  assert.deepEqual([m.provider, m.effort], ['claude', 'high']);
});

test('켜져 있으면 하루 몫을 다 쓴 AI는 다른 AI에게 맡기고, 풀면 다시 쓴다', async () => {
  t.app.store.settings.dailyBudget = true;
  seedBudget('claude', 10, 30);
  const m = await runOnce({ name: '예산넘음', role: '빌드', provider: 'claude', model: 'opus', effort: 'high', routing: 'manual' });
  assert.equal(m.provider, 'codex');
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && /오늘 예산을 다 써서/.test(b.text)));
  const rest = (await t.api('GET', '/api/cooldown')).json;
  assert.equal(rest.claude.budget, true);
  assert.equal(rest.claude.until, nextMidnight());
  await t.api('DELETE', '/api/cooldown/claude');
  assert.equal((await t.api('GET', '/api/cooldown')).json.claude, undefined);
  const again = await runOnce({ name: '예산풀림', role: '빌드', provider: 'claude', model: 'opus', effort: 'high', routing: 'manual' });
  assert.deepEqual([again.provider, again.effort], ['claude', 'high']);
});

test('자동 라우팅도 하루 몫을 다 쓴 AI를 빼고, 이어받기를 끄면 피한다고 표시하지 않는다', async () => {
  t.app.store.settings.dailyBudget = true;
  seedBudget('claude', 10, 30);
  const m = await runOnce({ name: '자동예산', role: '빌드', routing: 'auto', provider: 'claude' });
  assert.equal(m.provider, 'codex');
  t.app.store.settings.failover = false;
  assert.equal((await t.api('GET', '/api/cooldown')).json.claude, undefined);
});

test('검수는 예산보다 교차 검증이 먼저이고, 노력만 낮춘다', async () => {
  t.app.store.settings.dailyBudget = true;
  seedBudget('claude', 10, 30);
  const mk = async (body) => (await t.api('POST', '/api/agents', { permission: 'plan', ...body })).json;
  const builder = await mk({ name: '교차빌더', role: '빌드', provider: 'codex', model: 'gpt-6.1-sol', routing: 'manual' });
  const reviewer = await mk({ name: '교차검수', role: '검수', routing: 'auto', provider: 'claude' });
  const team = (await t.api('POST', '/api/teams', { name: '교차팀', stages: [{ label: '빌드', agentIds: [builder.id] }, { label: '검수', agentIds: [reviewer.id] }] })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: team.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '해줘' });
  await t.waitFor(() => t.app.store.getSession(s.id).runs.at(-1)?.endedAt, 15000, '실행 종료');
  const m = t.app.store.getSession(s.id).messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.provider, 'claude', '빌드한 Codex 를 다시 고르지 않는다');
  assert.equal(m.effort, 'low');
});

test('주간 창이 빠진 이벤트가 와도 예산이 안 풀리고, 5시간 한도를 풀어도 예산은 그대로다', async () => {
  t.app.store.settings.dailyBudget = true;
  seedBudget('claude', 10, 30);
  t.app.usage.setLimits({ provider: 'claude', windows: { five_hour: { pct: 3, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } }, false);
  assert.ok(t.app.usage.budget('claude').over);
  // 아직 예산 안에 있을 때 다른 한도를 풀면 오늘 풀림으로 기록하지 않는다
  seedBudget('codex', 10, 12);
  await t.api('DELETE', '/api/cooldown/codex');
  assert.equal(t.app.store.usage.dayBase.codex.releasedDay, undefined);
  await t.api('DELETE', '/api/cooldown/claude');
  assert.ok(t.app.store.usage.dayBase.claude.releasedDay, '넘긴 상태에서 풀면 오늘은 안 막는다');
});

test('한도로 이어받는 AI도 예산 속도를 따르고, 맡을 AI가 없으면 다 쓴 AI라도 쓴다', async () => {
  t.app.store.settings.dailyBudget = true;
  seedBudget('codex', 10, 30);
  const m = await runOnce({ name: '이어받기예산', role: '빌드', provider: 'claude', model: 'opus', effort: 'high', routing: 'manual' }, 'QUOTAFAIL 보고서');
  assert.equal(m.provider, 'codex');
  assert.equal(m.effort, 'low');
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && /노력을 .*low/.test(b.text)));
});

test('맡을 AI가 없으면 그대로 실행하되 노력을 낮추고, 저장된 에이전트는 안 바꾼다', async () => {
  t.app.store.settings.dailyBudget = true;
  seedBudget('claude', 10, 30);
  seedBudget('codex', 10, 30);
  const m = await runOnce({ name: '갈데없음', role: '빌드', provider: 'claude', model: 'opus', effort: 'high', routing: 'manual' });
  assert.deepEqual([m.provider, m.effort], ['claude', 'low']);
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && /노력을 high에서 low/.test(b.text)));
  const args = lastArgs('claude');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(t.app.store.all('agents').find((a) => a.name === '갈데없음').effort, 'high');
});

test('하루 예산이 켜져 있으면 Codex 는 실행 전 한도를 먼저 읽어 이번 사용량도 센다(추가 계정 포함)', async () => {
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '05');
  fs.mkdirSync(dir, { recursive: true });
  const line = { timestamp: new Date().toISOString(), payload: { rate_limits: { secondary: { used_percent: 40, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 } } } };
  const f = path.join(dir, 'rollout-before.jsonl');
  fs.writeFileSync(f, `${JSON.stringify(line)}\n`);
  try {
    await runOnce({ name: '예산꺼짐시작', role: '빌드', provider: 'codex', model: 'gpt-6.1-sol', routing: 'manual' });
    t.app.store.usage.dayBase = {};
    t.app.store.settings.dailyBudget = true;
    await runOnce({ name: '예산켜짐시작', role: '빌드', provider: 'codex', model: 'gpt-6.1-sol', routing: 'manual' });
    assert.equal(t.app.store.usage.dayBase.codex?.pct, 40, '시작 전 값이 오늘 기준점');
  } finally { fs.rmSync(f, { force: true }); }
});

test('Codex 계정을 빼면 그 계정의 한도·쉬는 기록도 지운다', async () => {
  const r = (await t.api('POST', '/api/accounts/codex', { name: '뺄계정' })).json;
  t.app.usage.setLimits({ provider: r.providerId, windows: { seven_day: week(99) } }, false);
  t.app.orch.cooldown.mark(r.providerId, { reason: 'limit' });
  assert.ok((await t.api('GET', '/api/cooldown')).json[r.providerId]);
  await t.api('DELETE', `/api/accounts/codex/${r.id}`);
  assert.equal(t.app.store.usage.limits[r.providerId], undefined);
  assert.equal(t.app.store.usage.dayBase[r.providerId], undefined);
  assert.equal((await t.api('GET', '/api/cooldown')).json[r.providerId], undefined);
});

test('화면에 주는 오늘 쓴 양에는 날짜가 붙는다', () => {
  assert.equal(t.app.usage.snapshot().spentDay, new Date().toLocaleDateString('sv-SE'));
});

// ── 남은 CLI 정리 ──
test('같은 폴더를 쓰는 다른 앱이 CLI 를 돌리는 중인지 안다', async (c) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-other-'));
  const other = sleeper();
  c.after(() => { try { other.kill(); } catch { /* 이미 끝남 */ } fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(otherAppRunning(dir), false);
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), '[]');
  assert.equal(otherAppRunning(dir), false, '내 기록은 안 센다');
  fs.writeFileSync(path.join(dir, `${deadPid()}.json`), '[]');
  assert.equal(otherAppRunning(dir), false, '죽은 앱은 안 센다');
  fs.writeFileSync(path.join(dir, `${other.pid}.json`), '[]');
  assert.equal(otherAppRunning(dir), true);
});

test('죽은 앱이 남긴 CLI는 끄고, 시작 시각이 다르면(PID 재사용) 안 끄고, 살아 있는 앱 기록은 안 건드린다', async (c) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-procs-'));
  const [left, other, mine] = [sleeper(), sleeper(), sleeper()];
  c.after(() => { for (const p of [left, other, mine]) { try { p.kill(); } catch { /* 이미 끝남 */ } } fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((r) => setTimeout(r, 300));
  const owner = deadPid();
  fs.writeFileSync(path.join(dir, `${owner}.json`), JSON.stringify([
    { pid: left.pid, name: 'node', at: Date.now() },
    { pid: other.pid, name: 'node', at: Date.now() - 3600e3 }, // 시작 시각이 안 맞음
    { pid: mine.pid, name: 'claude', at: Date.now() }, // 이름이 안 맞음
    { pid: deadPid(), name: 'node', at: Date.now() }, // 이미 끝남
  ]));
  const aliveFile = path.join(dir, `${process.pid}.json`);
  fs.writeFileSync(aliveFile, JSON.stringify([{ pid: mine.pid, name: 'node', at: Date.now() }]));
  assert.ok(procInfo(left.pid)?.cmd.toLowerCase().includes('node'), '프로세스 정보를 읽는다');
  assert.equal(reapLeftovers(dir), 1);
  await t.waitFor(() => !running(left.pid), 10000, '남은 CLI 종료');
  assert.ok(running(other.pid), '시작 시각이 다른 프로그램은 그대로');
  assert.ok(running(mine.pid), '이름이 다른 프로그램은 그대로');
  assert.ok(!fs.existsSync(path.join(dir, `${owner}.json`)), '처리한 기록은 지운다');
  assert.ok(fs.existsSync(aliveFile), '살아 있는 앱의 기록은 그대로');
});

test('실행 중인 CLI를 기록하고 끝나면 지운다', async (c) => {
  const file = path.join(t.root, 'home', 'running-cli', `${process.pid}.json`);
  const child = spawnCli('codex', []);
  c.after(() => killTree(child));
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(rec.some((p) => p.pid === child.pid && p.name === 'codex' && p.at <= Date.now()), JSON.stringify(rec));
  killTree(child);
  await t.waitFor(() => !fs.existsSync(file), 10000, '기록 삭제');
});
