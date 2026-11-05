// 터미널 세션 구경: 기록 파일 끝을 따라 읽어 상태를 만든다(파일만 읽음, CLI 실행 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { claudeEvent, codexEvent, SessionWatch, ACTIVE_MS } from '../server/watch.js';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { t.app.watch.stop(); try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const append = (f, ...objs) => fs.appendFileSync(f, objs.map((o) => `${JSON.stringify(o)}\n`).join(''));
const claudeFile = (dir, id) => {
  const d = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', dir);
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, `${id}.jsonl`);
};
const toolUse = (name, input, cwd = 'C:\\work\\shop') => ({ type: 'assistant', cwd, timestamp: iso(), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'x', name, input }] } });

test('Claude 기록 줄 → 상태: 도구 종류, 파일은 이름만, 명령은 프로그램 이름만', () => {
  const read = claudeEvent(toolUse('Read', { file_path: 'C:\\secret\\dir\\app.js' }));
  assert.deepEqual([read.state, read.tool, read.detail, read.cwd], ['reading', 'Read', 'Read · app.js', 'C:\\work\\shop']);
  const cmd = claudeEvent(toolUse('Bash', { command: 'curl -H "Authorization: Bearer sk-abc" https://x' }));
  assert.equal(cmd.state, 'running');
  assert.equal(cmd.detail, 'Bash · curl', '인자(토큰이 있을 수 있음)는 안 보여 준다');
  assert.equal(claudeEvent(toolUse('WebSearch', { query: 'q' })).state, 'searching');
  assert.equal(claudeEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } }).state, 'thinking');
  assert.equal(claudeEvent({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '끝났어' }] } }).state, 'done');
  assert.equal(claudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true }] } }).state, 'error');
  assert.equal(claudeEvent({ type: 'user', message: { content: 'hi' } }).state, 'thinking');
  assert.equal(claudeEvent({ ...toolUse('Read', {}), isSidechain: true }), null, '서브에이전트 줄은 본 세션으로 안 친다');
  assert.equal(claudeEvent({ type: 'summary' }), null, '모르는 줄은 건너뛴다');
});

test('Codex 기록 줄 → 상태', () => {
  assert.equal(codexEvent({ type: 'session_meta', payload: { cwd: 'D:\\proj\\api' } }).cwd, 'D:\\proj\\api');
  const call = codexEvent({ type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'npm test --token=abc' }) } });
  assert.deepEqual([call.state, call.detail], ['running', 'shell_command · npm']);
  assert.equal(codexEvent({ type: 'response_item', payload: { type: 'web_search_call', action: {} } }).state, 'searching');
  assert.equal(codexEvent({ type: 'response_item', payload: { type: 'reasoning' } }).state, 'thinking');
  assert.equal(codexEvent({ type: 'response_item', payload: { type: 'function_call_output' } }).state, 'thinking');
  assert.equal(codexEvent({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: '답이야' }] } }).state, 'typing');
  assert.equal(codexEvent({ type: 'event_msg', payload: { type: 'task_complete' } }).state, 'done');
  assert.equal(codexEvent({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [] } }), null);
  assert.equal(codexEvent('이상한 줄'), null);
});

test('파일을 따라 읽고, 깨진 줄·덜 써진 줄을 견디고, 바뀔 때만 알린다', async () => {
  const seen = [];
  const w = new SessionWatch({ emit: (type, d) => seen.push([type, d]) });
  const f = claudeFile('C--work-shop', 'aaaaaaaa-0000-4000-8000-000000000001');
  append(f, toolUse('Read', { file_path: 'a.js' }));
  await w.tick();
  let [s] = w.snapshot();
  assert.deepEqual([s.id, s.source, s.project, s.state, s.detail, s.model, s.active], ['claude-aaaaaaaa-0000-4000-8000-000000000001', 'claude', 'shop', 'reading', 'Read · a.js', 'claude-opus-5-5', true]);
  assert.equal(seen.length, 1);
  await w.tick();
  assert.equal(seen.length, 1, '안 바뀌면 안 알린다');
  fs.appendFileSync(f, '깨진 줄이야\n');
  fs.appendFileSync(f, JSON.stringify(toolUse('Bash', { command: 'npm test' })).slice(0, 20)); // 덜 써진 줄
  w.ticks = 1;
  await w.tick();
  assert.equal(w.snapshot()[0].state, 'reading', '덜 써진 줄은 아직 안 읽는다');
  fs.rmSync(f);
  fs.writeFileSync(f, '');
  w.stop();
});

test('오래 조용하면 쉬는 중, 끝난 세션은 끝남으로 보인다', async () => {
  let now = Date.now();
  const w = new SessionWatch(null, { now: () => now });
  const f = claudeFile('C--work-old', 'bbbbbbbb-0000-4000-8000-000000000002');
  append(f, toolUse('Read', { file_path: 'b.js' }, 'C:\\work\\old'));
  await w.tick();
  assert.equal(w.snapshot().find((x) => x.project === 'old').state, 'reading');
  now += ACTIVE_MS + 1000;
  const idle = w.snapshot().find((x) => x.project === 'old');
  assert.deepEqual([idle.state, idle.active, idle.detail], ['idle', false, '']);
  fs.rmSync(f);
});

test('Codex 세션은 오늘 폴더에서 찾고 첫 줄에서 프로젝트 이름을 읽는다', async () => {
  const d = new Date();
  const dir = path.join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'rollout-2026-11-06T01-00-00-cccccccc-0000-4000-8000-000000000003.jsonl');
  append(f, { type: 'session_meta', timestamp: iso(), payload: { cwd: '/home/me/api' } }, { type: 'response_item', timestamp: iso(), payload: { type: 'function_call', name: 'apply_patch', arguments: '{}' } });
  const w = new SessionWatch(null);
  await w.tick();
  const s = w.snapshot().find((x) => x.source === 'codex');
  assert.deepEqual([s.id, s.project, s.state], ['codex-cccccccc-0000-4000-8000-000000000003', 'api', 'tool']);
  fs.rmSync(f);
});

test('API: 화면이 보면 돌기 시작하고, 앱을 끄면 멈춘다. 아무것도 실행하지 않는다', async () => {
  const before = t.fakeLog().length;
  const f = claudeFile('C--work-api', 'dddddddd-0000-4000-8000-000000000004');
  append(f, toolUse('Edit', { file_path: 'c.js' }, 'C:\\work\\api'));
  const r = await t.api('GET', '/api/watch');
  assert.equal(r.status, 200);
  assert.ok(r.json.some((x) => x.project === 'api' && x.state === 'tool'), JSON.stringify(r.json));
  assert.ok(t.app.watch.timer, '보는 동안 돈다');
  assert.equal(t.fakeLog().length, before, 'CLI 실행 0');
  assert.ok(!JSON.stringify(r.json).includes('C:\\\\work'), '전체 경로는 안 보낸다');
  t.app.watch.stop();
  assert.equal(t.app.watch.timer, null);
  fs.rmSync(f);
});

test('화면이 안 보면 스스로 멈춘다', async () => {
  let now = Date.now();
  const w = new SessionWatch(null, { now: () => now });
  w.view();
  assert.ok(w.timer);
  now += 61 * 1000;
  await w.tick();
  assert.equal(w.timer, null);
});

test('MCP 도구는 끝 이름만 보여 준다', () => {
  assert.equal(claudeEvent(toolUse('mcp__Browser__read_page', {})).detail, 'read_page');
});

test('환경변수 앞붙임·URL 쿼리·글 속 토큰이 화면으로 안 나간다', () => {
  assert.equal(claudeEvent(toolUse('Bash', { command: 'GITHUB_TOKEN=ghp_FAKE12345 gh pr list' })).detail, 'Bash · gh');
  assert.equal(claudeEvent(toolUse('Bash', { command: 'A=1 B=2 sudo env npm test' })).detail, 'Bash · npm');
  assert.equal(claudeEvent(toolUse('Read', { path: 'https://x.test/a.js?token=SECRET' })).detail, 'Read · a.js');
  const text = (t) => claudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }).detail;
  assert.doesNotMatch(text('토큰은 sk-SECRETVALUE123 이야'), /SECRETVALUE/);
  assert.doesNotMatch(text('주소는 https://x.test/y?token=SECRET&a=1 이야'), /SECRET/);
  assert.equal(claudeEvent({ type: 'user', isMeta: true, message: { content: 'x' } }), null, '내부 안내 줄');
});

test('파일 읽기 경계: 처음 읽을 때 잘린 첫 줄을 버리고, 큰 파일도 이어 읽고, 덜 써진 줄은 완성되면 읽고, 줄어들면 처음부터', async () => {
  const w = new SessionWatch(null);
  const f = claudeFile('C--work-edge', 'eeeeeeee-0000-4000-8000-000000000005');
  // 처음 읽는 범위(끝 64KB)의 앞이 잘려도 그 조각을 줄로 읽지 않는다
  append(f, toolUse('Write', { file_path: 'first.js' }, '/home/me/edge'));
  fs.appendFileSync(f, `{"type":"assistant","cwd":"X","timestamp":"${iso()}","message":{"content":[{"type":"tool_use","name":"Bash","input":{"note":"${'x'.repeat(70 * 1024)}"}}]}}\n`);
  await w.tick();
  const edge = () => w.snapshot().find((x) => x.project === 'edge');
  assert.ok(edge(), '거대한 줄이 끝에 있어도 머리에서 프로젝트 이름을 읽는다');
  // 512KB 한 번에 못 읽는 양을 지나 뒤 줄까지 읽는다
  fs.appendFileSync(f, `${JSON.stringify(toolUse('Read', { file_path: 'pad.js' }, '/home/me/edge'))}\n`.repeat(4000));
  append(f, toolUse('Grep', { path: 'after-big.js' }, '/home/me/edge'));
  for (let i = 0; i < 6; i++) { w.ticks = 1; await w.tick(); }
  assert.equal(edge().detail, 'Grep · after-big.js');
  // 512KB 보다 긴 한 줄 뒤의 줄도 읽는다(그 자리에 멈추지 않는다)
  fs.appendFileSync(f, `${'y'.repeat(600 * 1024)}
`);
  append(f, toolUse('Grep', { path: 'after-huge.js' }, '/home/me/edge'));
  for (let i = 0; i < 4; i++) { w.ticks = 1; await w.tick(); }
  assert.equal(edge().detail, 'Grep · after-huge.js');
  // 덜 써진 줄은 완성된 뒤 읽는다
  const line = JSON.stringify(toolUse('Edit', { file_path: 'half.js' }, '/home/me/edge'));
  fs.appendFileSync(f, line.slice(0, 30));
  w.ticks = 1; await w.tick();
  assert.equal(edge().detail, 'Grep · after-big.js');
  fs.appendFileSync(f, `${line.slice(30)}\n`);
  w.ticks = 1; await w.tick();
  assert.equal(edge().detail, 'Edit · half.js');
  // 파일이 새로 써지면 처음부터
  fs.writeFileSync(f, `${JSON.stringify(toolUse('Bash', { command: 'npm test' }, '/home/me/edge'))}\n`);
  w.ticks = 1; await w.tick();
  assert.equal(edge().detail, 'Bash · npm');
  fs.rmSync(f);
  w.stop();
});

test('상태·일하는 중 여부가 바뀌면 알린다(시간이 지나 쉬는 중으로 바뀔 때도)', async () => {
  let now = Date.now();
  const seen = [];
  const w = new SessionWatch({ emit: (type, d) => seen.push(d) }, { now: () => now });
  const f = claudeFile('C--work-tell', 'ffffffff-0000-4000-8000-000000000006');
  append(f, toolUse('Read', { file_path: 'a.js' }, 'C:\\work\\tell'));
  await w.tick();
  const n = seen.length;
  append(f, toolUse('Bash', { command: 'ls' }, 'C:\\work\\tell'));
  w.ticks = 1; await w.tick();
  assert.equal(seen.length, n + 1, '상태 변화');
  now += ACTIVE_MS + 5000;
  w.ticks = 1; await w.tick();
  assert.equal(seen.length, n + 2, '쉬는 중으로 바뀜');
  assert.equal(seen.at(-1).find((x) => x.project === 'tell').state, 'idle');
  fs.rmSync(f);
});
