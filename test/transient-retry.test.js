// 일시 장애 1번 자동 다시(결정 0030): 목표의 일 단계·카드 단계가 일시 장애로 보이는 오류(네트워크 끊김·시간 초과·5xx·과부하)로 끝나면,
// 사용자에게 묻기 전에 한 번만 저절로 다시 돌린다. 그 실행이 파일을 바꾸지 않았다고 git 으로 확인될 때만, 호출 상한·구독 한도 상한·카드 시작 상한 안에서만.
// 한도 오류는 여기에 넣지 않는다(결정 0019 의 한도 대기). 설정으로 끌 수 있다. 가짜 CLI 만 쓴다(실제 AI 사용량 0)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bindLang } from '../server/i18n.js';
import { isTransientError, isQuotaError } from '../server/failover.js';
import { buildReport } from '../server/report.js';
import { unsafeTools, transientSent } from '../server/mission.js';
import { tr } from '../server/i18n.js';
import { createApp } from '../server/index.js';
import { startTestApp, freePort } from './helpers.js';

bindLang(() => 'ko');
let t = null;
const app = async () => (t ||= await startTestApp());
const opened = [];
after(async () => {
  for (const a of opened) { try { await a.close(); } catch { /* 이미 닫힘 */ } }
  if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } }
});
// 가짜 CLI 의 NETHOLD: 실패하기 직전에 멈춰 "held-<이름>-<n>"을 남기고 "go-<이름>-<n>"을 기다린다(시험이 그 사이에 값을 바꾼다. 시간에 기대지 않게)
const held = (name, n = 1) => t.waitFor(() => fs.existsSync(`${process.env.FAKE_LOG}.held-${name}-${n}`), 30000, `${name} 의 ${n}번째 시도가 멈춤`);
const go = (name, n = 1) => fs.writeFileSync(`${process.env.FAKE_LOG}.go-${name}-${n}`, '1');
const S = (id) => t.app.store.getSession(id);
const idle = (sid) => !t.app.orch.ctx.has(sid);
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides, ...(c.checks ? { checks: c.checks } : {}), ...(c.keep ? { keep: c.keep } : {}) });
let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
function repo(name) {
  const dir = path.join(t.root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!hasGit) return dir;
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  return dir;
}

test('1. 일시 장애 판정: 네트워크·시간 초과·5xx·과부하는 맞고, 사용량 한도·크기 한도·보통 오류는 아니다', () => {
  for (const s of ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'request to https://api.example.com failed, reason: socket hang up',
    'Error: read ECONNRESET', 'connect ETIMEDOUT 10.0.0.1:443', 'stream disconnected before completion', 'HTTP 503 Service Unavailable', 'API Error: 500 Internal server error',
    'Request timed out.', 'fetch failed', 'getaddrinfo EAI_AGAIN api.example.com', '502 Bad Gateway']) {
    assert.equal(isTransientError(s), true, s);
  }
  for (const s of ['Claude AI usage limit reached', 'rate limit exceeded (429)', 'Usage limit reached. Try again in 2 hours.', '가짜 실패', 'prompt is too long: context length exceeded',
    'TypeError: x is not a function', 'exit code 1', 'line 503: unexpected token', '', '실행 실패: spawn claude ENOENT']) {
    assert.equal(isTransientError(s), false, s);
  }
  // 한도 문구와 일시 장애 문구가 같이 있으면 한도(결정 0019 의 길)
  assert.equal(isQuotaError('503 overloaded: rate limit'), true);
  assert.equal(isTransientError('503 overloaded: rate limit'), false);
});

test('1-2. 도구 표: 읽기만 하는 도구로 아는 것만 자동 다시를 허락하고, 명령·편집·mcp 커넥터·브라우저 조작·웹 가져오기·모르는 도구는 막는다', () => {
  const tool = (name, input = {}) => ({ kind: 'tool', name, input, status: 'done' });
  const SAFE = [
    ['Read'], ['Glob'], ['Grep'], ['LS'], ['WebSearch'], ['TodoWrite'], ['NotebookRead'], ['↳ Read'], ['↳ Grep'], // Claude Code(하위 에이전트 포함)
    ['read_file'], ['read_many_files'], ['list_directory'], ['glob'], ['search_file_content'], ['google_web_search'], // Gemini CLI
    [tr('웹 검색')], [tr('계획(todo)')], ['웹 검색'], // Codex(번역한 이름)
    ['mcp__crew-browser__browser_snapshot'], ['mcp__crew-browser__browser_take_screenshot'], ['mcp__crew-browser__browser_console_messages'], ['mcp__crew-browser__browser_network_requests'],
    ['mcp:crew-browser.browser_snapshot'], ['↳ mcp__crew-browser__browser_snapshot'],
  ];
  const UNSAFE = [
    ['Bash'], ['Edit'], ['Write'], ['MultiEdit'], ['NotebookEdit'], ['WebFetch'], ['Task'], ['Agent'], ['↳ Bash'], ['↳ WebFetch'],
    ['web_fetch'], ['write_file'], ['replace'], ['run_shell_command'], ['save_memory'],
    [tr('명령 실행')], [tr('파일 편집')],
    ['mcp__slack__send_message'], ['mcp__github__create_pull_request'], ['mcp:github.create_issue'], ['mcp__crew-browser__browser_click'], ['mcp__crew-browser__browser_type'],
    ['mcp__crew-browser__browser_navigate'], ['mcp__crew-browser__browser_fill_form'], ['mcp:crew-browser.browser_press_key'], ['mcp__other-browser__browser_snapshot'],
    ['mcp__crew-browser__browser_snapshot', { filename: 'page.md' }], ['mcp__crew-browser__browser_take_screenshot', { filename: 'shot.png' }],
    ['Read README.md'], ['Frobnicate'], [''],
  ];
  for (const [n, input] of SAFE) assert.deepEqual(unsafeTools([tool(n, input)]), [], `읽기만: ${n}`);
  for (const [n, input] of UNSAFE) assert.equal(unsafeTools([tool(n, input)]).length, 1, `막음: ${n} ${JSON.stringify(input || {})}`);
  // 여럿 섞이면 막는 것만, 겹치지 않게. 도구를 안 썼으면 빈 목록. 도구가 아닌 블록은 보지 않는다
  assert.deepEqual(unsafeTools([tool('Read'), tool('Bash'), tool('Bash'), tool('WebFetch')]), ['Bash', 'WebFetch']);
  assert.deepEqual(unsafeTools([]), []);
  assert.deepEqual(unsafeTools([{ kind: 'notice', name: 'Bash' }]), []);
  // 다시 도는 사람에게 붙이는 한 줄: 이미 밖으로 보낸 것은 되풀이하지 말라고
  assert.match(transientSent(), /^\[다시\]/);
  assert.ok(transientSent().includes('이미 밖으로 보낸 것은 되풀이하지 마'));
});

async function team2(tag) {
  const mk = async (name, role) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  const a = await mk(`${tag}가`, '빌드');
  const b = await mk(`${tag}나`, '기록');
  const v = await mk(`${tag}다`, '검수');
  const tm = (await t.api('POST', '/api/teams', { name: `${tag}팀`, stages: [{ label: '만들기', agentIds: [a.id, b.id] }, { label: '검수', agentIds: [v.id] }] })).json;
  return { a, b, v, tm };
}
async function goal(tm, cwd, signal, work = 'stages') {
  const s = (await t.api('POST', '/api/sessions', { teamId: tm.id, cwd })).json;
  assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '정리해 줘' });
  await t.waitFor(() => S(s.id).mission?.status === 'draft' && idle(s.id), 20000, '목표 카드');
  const c = S(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  const r = await t.api('POST', `/api/sessions/${s.id}/mission/confirm`, { missionId: S(s.id).mission.id, expected: shown(c), edited: { ...shown(c), goal: `${signal} 목표` },
    review: { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) }, work,
    prep: { research: false, meeting: false, lead: c.prep.lead.id, researchers: c.prep.research.who.map((w) => w.id), attendees: c.prep.meeting.who.map((w) => w.id) } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return s.id;
}
const ended = (sid) => t.waitFor(() => idle(sid) && ['done', 'accepted', 'stopped'].includes(S(sid).mission.status), 60000, '목표 끝');
const lines = (sid, kind) => (S(sid).mission.log || []).filter((x) => x.kind === kind);
const errorAnswers = (sid, agentId) => S(sid).messages.filter((m) => m.role === 'agent' && m.agentId === agentId && m.status === 'error');

test('2. 단계표: 한 사람만 일시 장애로 끝나면 그 사람만 한 번 저절로 다시(끝낸 사람은 다시 안 돎), 진행 기록과 완주 보고의 실패 집계에 남는다', { timeout: 120000 }, async (tt) => {
  if (!hasGit) { tt.skip('git 이 없어 바뀐 파일을 확인할 수 없음(자동 다시 없음)'); return; }
  await app();
  const { a, b, tm } = await team2('일시1');
  const cwd = repo('net1');
  const sid = await goal(tm, cwd, `NETFAIL1:${b.name}`);
  await ended(sid);
  const m = S(sid).mission;
  assert.equal(m.status, 'done', JSON.stringify(m.log.slice(-6).map((x) => x.text)));
  const tl = lines(sid, 'transient');
  assert.equal(tl.length, 1);
  assert.match(tl[0].text, /일시 장애/);
  assert.equal(tl[0].fail, 'transient');
  assert.equal(errorAnswers(sid, b.id).length, 1, 'b 의 첫 답은 오류');
  const run = S(sid).runs.findLast((r) => r.mission === 'work');
  const okA = S(sid).messages.filter((x) => x.role === 'agent' && x.runId === run.id && x.agentId === a.id && x.stageIndex === 0);
  assert.equal(okA.length, 1, '끝낸 a 는 다시 안 돎');
  // 오류 대기를 묻지 않았다(질문 없이 이어 감)
  assert.equal(lines(sid, 'error').length, 0);
  // 다시 도는 b 의 프롬프트 맨 앞에만 "[다시] … 이미 밖으로 보낸 것은 되풀이하지 마" 한 줄(끝낸 a·검수자에게는 없음)
  const sent = t.fakeLog().filter((l) => typeof l.text === 'string' && l.text.includes(transientSent()));
  assert.equal(sent.length, 1, '다시 도는 차례 하나에만');
  assert.ok(sent[0].text.includes('[팀 작업]'));
  const rep = S(sid).messages.find((x) => x.kind === 'report');
  assert.equal(rep.fails.transient, 1);
  // 보고를 다시 묶어도 같다(진행 기록에서 센다)
  assert.equal(buildReport({ m, messages: S(sid).messages, runs: S(sid).runs }).fails.transient, 1);
});

test('3. 두 번째도 실패하면 지금처럼 묻고, 파일을 바꿨거나 git 이 아니면 자동으로 다시 하지 않는다. 설정으로 끄면 바로 묻는다', { timeout: 180000 }, async (tt) => {
  await app();
  const { b, tm } = await team2('일시2');
  // (가) 두 번 다 실패: 자동 다시 한 번 뒤 오류 대기
  if (hasGit) {
    const sid = await goal(tm, repo('net2'), `NETFAIL2:${b.name}`);
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.equal(lines(sid, 'transient').length, 1);
    assert.equal(errorAnswers(sid, b.id).length, 2);
    // 오류 줄의 종류도 일시 장애(코드가 오류 문구로 가른 것)
    assert.equal(lines(sid, 'error').at(-1).fail, 'transient');
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'skip' });
    await ended(sid);
  } else tt.diagnostic('git 이 없어 (가) 는 건너뜀');
  // (나) 실패하기 전에 작업 폴더의 파일을 바꿈: 자동 다시 없이 묻는다(이유 한 줄)
  if (hasGit) {
    const sid = await goal(tm, repo('net3'), `NETFAILWRITE:${b.name}`);
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.equal(errorAnswers(sid, b.id).length, 1, '다시 돌지 않음');
    assert.equal(lines(sid, 'transient').filter((x) => x.fail).length, 0);
    assert.match(lines(sid, 'transient').at(-1)?.text || '', /바뀌어서|바꿨/);
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => idle(sid), 20000, '멈춤');
  }
  // (다) git 저장소가 아닌 폴더: 확인을 못 하니 자동으로 다시 하지 않는다
  {
    const plain = path.join(t.root, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    const sid = await goal(tm, plain, `NETFAIL1:${b.name}`);
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.equal(errorAnswers(sid, b.id).length, 1);
    assert.match(lines(sid, 'transient').at(-1)?.text || '', /확인하지 못해서/);
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => idle(sid), 20000, '멈춤');
  }
  // (라) 설정으로 끔: 바로 오류 대기(자동 다시 줄 없음)
  if (hasGit) {
    assert.equal((await t.api('PUT', '/api/settings', { transientRetry: false })).json.transientRetry, false);
    try {
      const sid = await goal(tm, repo('net4'), `NETFAIL1:${b.name}`);
      await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
      assert.equal(lines(sid, 'transient').length, 0);
      await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
      await t.waitFor(() => idle(sid), 20000, '멈춤');
    } finally { await t.api('PUT', '/api/settings', { transientRetry: true }); }
  }
  // (마) 단계를 시작할 때는 꺼져 있다가 도중에 켬: 시작 전 상태가 없으니 "git 저장소가 아님"이 아니라 맞는 까닭으로 하지 않는다
  if (hasGit) {
    await t.api('PUT', '/api/settings', { transientRetry: false });
    const sid = await goal(tm, repo('net4b'), `NETFAIL1:${b.name} NETHOLD`);
    await held(b.name, 1);
    await t.api('PUT', '/api/settings', { transientRetry: true });
    go(b.name, 1);
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    const why = lines(sid, 'transient').at(-1)?.text || '';
    assert.match(why, /꺼져 있어서/);
    assert.doesNotMatch(why, /git 저장소가 아니/);
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => idle(sid), 20000, '멈춤');
  }
});

test('4. 호출 상한이 모자라면 자동으로 다시 하지 않고, 일 카드는 시작 수에 센다(상한에 닿은 카드는 자동 다시 없이 묻는다)', { timeout: 180000 }, async (tt) => {
  if (!hasGit) { tt.skip('git 이 없어 바뀐 파일을 확인할 수 없음'); return; }
  await app();
  const { b, tm } = await team2('일시3');
  // (가) 호출 상한: b 가 실패하기 직전에 멈춘 사이(NETHOLD) 남은 호출을 0으로 만든다(테스트용으로 목표의 calls 를 직접 고친다)
  {
    const sid = await goal(tm, repo('net5'), `NETFAIL1:${b.name} NETHOLD`);
    await held(b.name, 1);
    const m = S(sid).mission;
    m.calls.cap = m.calls.used; // 자동 다시에 쓸 호출이 없다
    go(b.name, 1);
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.equal(errorAnswers(sid, b.id).length, 1, '상한이 모자라서 다시 안 돎');
    assert.match(lines(sid, 'transient').at(-1)?.text || '', /호출/);
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => idle(sid), 20000, '멈춤');
  }
  // (나) 일 카드: k2(담당 b)가 일시 장애 한 번 → 자동 다시, 그 카드의 시작 수는 2
  {
    const sid = await goal(tm, repo('net6'), `NETFAIL1:${b.name} PLANBUILD1`, 'cards');
    await ended(sid);
    const m = S(sid).mission;
    const k = m.cards.find((c) => c.ownerId === b.id);
    assert.equal(k.status, 'done');
    assert.equal(k.starts, 2, '자동 다시도 카드 시작 수에 센다');
    assert.equal(lines(sid, 'transient').filter((x) => x.fail === 'transient').length, 1);
  }
  // (다) 사다리 팀(실패 1번이면 묻기, 결정 0027): 카드 시작 상한이 1이라 첫 시작에서 이미 상한 → 자동 다시 없이 묻는다
  {
    const { b: b2, tm: tm2 } = await team2('일시4');
    const put = await t.api('PUT', `/api/teams/${tm2.id}`, { ...tm2, ladder: true, escalateAfter: 1 });
    assert.equal(put.json.escalateAfter, 1);
    const sid = await goal(tm2, repo('net7'), `NETFAIL1:${b2.name} PLANBUILD1`, 'cards');
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.match(lines(sid, 'transient').at(-1)?.text || '', /시작한 횟수가 상한/);
    assert.equal(S(sid).mission.cards.find((c) => c.ownerId === b2.id).starts, 1);
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => idle(sid), 20000, '멈춤');
  }
});

test('5. 도구 검사·시간당 카드 상한·구독 한도 상한: 밖으로 나갔을 수 있는 도구를 쓴 답, 시간당 카드 상한, 상한을 넘은 AI 는 자동으로 다시 하지 않는다', { timeout: 240000 }, async (tt) => {
  if (!hasGit) { tt.skip('git 이 없어 바뀐 파일을 확인할 수 없음'); return; }
  await app();
  const stopAt = async (sid) => { await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' }); await t.waitFor(() => idle(sid), 20000, '멈춤'); };
  // (가) 웹 가져오기·브라우저 누르기를 쓴 뒤의 일시 장애: 같은 행동이 두 번 나가지 않게 자동 다시 없이 묻는다. 읽기만 하는 도구(Read)는 다시 한다
  const { b, tm } = await team2('일시5');
  for (const [k, toolName] of [[1, 'WebFetch'], [2, 'mcp__crew-browser__browser_click'], [3, 'mcp__github__create_pull_request']]) {
    const sid = await goal(tm, repo(`net8-${k}`), `NETFAIL1:${b.name} NETTOOL:${toolName}`);
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, `${toolName} 오류 대기`);
    assert.equal(errorAnswers(sid, b.id).length, 1, `${toolName}: 다시 안 돎`);
    const why = lines(sid, 'transient').at(-1)?.text || '';
    assert.ok(why.includes(toolName) && /모르는 도구/.test(why), why);
    await stopAt(sid);
  }
  {
    const sid = await goal(tm, repo('net8-read'), `NETFAIL1:${b.name} NETTOOL:Read`);
    await ended(sid);
    assert.equal(lines(sid, 'transient').filter((x) => x.fail === 'transient').length, 1, 'Read 만 썼으면 다시 한다');
  }
  // (나) 시간당 카드 시작 상한: k2(담당 b)가 실패하기 직전에 상한을 지금 시작 수로 낮추면 자동 다시 없이 묻는다(시작 수도 그대로)
  {
    const { b: b6, tm: tm6 } = await team2('일시6');
    const sid = await goal(tm6, repo('net9'), `NETFAIL1:${b6.name} NETHOLD PLANBUILD1`, 'cards');
    await held(b6.name, 1);
    const m = S(sid).mission;
    m.rate.cap = m.rate.starts.length;
    go(b6.name, 1);
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.match(lines(sid, 'transient').at(-1)?.text || '', /한 시간 안에 시작한 카드/);
    assert.equal(m.cards.find((c) => c.ownerId === b6.id).starts, 1);
    await stopAt(sid);
  }
  // (다) 구독 한도 상한(결정 0026): 다시 돌 AI 의 한도 기록이 상한(90%) 이상이면 자동 다시 없이 묻는다("계속"을 고른 AI 라도)
  {
    const { a: a7, b: b7, tm: tm7 } = await team2('일시7');
    const sid = await goal(tm7, repo('net10'), `NETFAIL1:${b7.name} NETHOLD`);
    await held(b7.name, 1);
    // 함께 도는 a 가 끝나며 보낸 한도 기록(25%) 뒤에 덮어쓴다. 그 뒤 늦게 들어오는 다른 한도 기록(멈춰 있던 실행이 끝나며 내는 것 등)이 다시 덮어쓰면
    // 상한 아래로 보여 자동으로 다시 돌고 오류 대기가 오지 않는다(맥 검사에서 한 번 그랬다). 그래서 이 구간 동안은 92% 기록을 고정해 둔다(쓰기는 버린다)
    await t.waitFor(() => S(sid).messages.some((x) => x.role === 'agent' && x.agentId === a7.id && x.status === 'done' && x.stageIndex === 0), 20000, 'a 끝');
    const was = t.app.store.usage.limits.claude;
    const pinned = { windows: { five_hour: { pct: 92, resetsAt: Math.floor(Date.now() / 1000) + 3600 } }, observedAt: Date.now() };
    Object.defineProperty(t.app.store.usage.limits, 'claude', { get: () => pinned, set: () => {}, configurable: true, enumerable: true });
    (S(sid).mission.capOk ||= []).push('claude');
    try {
      go(b7.name, 1);
      await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
      assert.match(lines(sid, 'transient').at(-1)?.text || '', /구독 한도가 상한/);
      assert.equal(errorAnswers(sid, b7.id).length, 1);
    } finally { delete t.app.store.usage.limits.claude; if (was) t.app.store.usage.limits.claude = was; }
    await stopAt(sid);
  }
});

test('6. 끊김·이어서: 자동으로 한 번 다시 하던 중에 앱이 꺼졌다 이어서 해도, 그 단계에서는 다시 자동으로 하지 않는다', { timeout: 180000 }, async (tt) => {
  if (!hasGit) { tt.skip('git 이 없어 바뀐 파일을 확인할 수 없음'); return; }
  await app();
  const { b, tm } = await team2('일시8');
  const sid = await goal(tm, repo('net11'), `NETFAIL2:${b.name} NETHOLD`);
  await held(b.name, 1);
  go(b.name, 1); // 첫 시도 실패 → 자동 다시
  await held(b.name, 2); // 다시 하는 시도가 실패 직전에 멈춘 사이에 앱이 꺼진다
  const file = path.join(t.app.store.dirs.sessions, `${sid}.json`);
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  await t.waitFor(() => read()?.mission?.at?.retried === true, 10000, '디스크에 "한 번 다시 했음"');
  t.app.store.closed = true;
  t.app.store.close = () => {};
  await t.app.close();
  const a2 = createApp({ home: path.join(t.root, 'home'), port: 0, detect: false });
  a2.store.settings.lang = 'ko';
  opened.push(a2);
  const port = await a2.listen(await freePort());
  const api2 = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Office-Token': a2.token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const S2 = (id) => a2.store.getSession(id);
  assert.equal(S2(sid).mission.status, 'cut');
  const r = await api2('POST', `/api/sessions/${sid}/mission/resume`, { missionId: S2(sid).mission.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await t.waitFor(() => fs.existsSync(`${process.env.FAKE_LOG}.held-${b.name}-3`), 30000, '이어서 다시 도는 시도');
  go(b.name, 3);
  await t.waitFor(() => S2(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기(자동 다시 없이)');
  assert.equal((S2(sid).mission.log || []).filter((x) => x.kind === 'transient' && x.fail === 'transient').length, 1, '자동 다시는 끊기기 전의 한 번뿐');
  await api2('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
  await t.waitFor(() => !a2.orch.ctx.has(sid), 20000, '멈춤');
});
