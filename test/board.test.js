// 칸반 보드: 카드를 맡기면 세션 상태에 따라 칸이 옮겨 간다(데모·가짜 CLI, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';

let t;
let agent;
before(async () => {
  t = await startTestApp();
  agent = (await t.api('POST', '/api/agents', { name: '카드담당', role: '조사', provider: 'codex', model: 'gpt-6.1-sol', permission: 'plan', routing: 'manual' })).json;
});
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const card = async (extra = {}) => (await t.api('POST', '/api/tasks', { title: '테스트 카드', agentId: agent.id, ...extra })).json;
const columnOf = async (id) => (await t.api('GET', '/api/tasks')).json.find((x) => x.id === id).column;
const ended = (sid) => t.waitFor(() => t.app.store.getSession(sid).runs.at(-1)?.endedAt, 15000, '실행 끝');

test('값 검사: 제목·대상·폴더', async () => {
  assert.equal((await t.api('POST', '/api/tasks', { title: '  ', agentId: agent.id })).status, 400);
  assert.equal((await t.api('POST', '/api/tasks', { title: '대상 없음' })).status, 400);
  assert.equal((await t.api('POST', '/api/tasks', { title: '없는 팀', teamId: 'nope' })).status, 400);
  assert.equal((await t.api('POST', '/api/tasks', { title: '위험 폴더', agentId: agent.id, cwd: os.homedir() })).status, 400);
  assert.equal((await t.api('POST', '/api/tasks', { title: '없는 폴더', agentId: agent.id, cwd: path.join(os.tmpdir(), 'crew-no-such-dir') })).status, 400);
});

test('칸 흐름: 할 일 → 맡기면 진행 → 끝나면 확인 필요 → 완료 → 되돌리기', async () => {
  const c = await card({ title: '흐름 카드', detail: '자세한 지시 SLOW' });
  assert.equal(await columnOf(c.id), 'todo');
  const before = t.events.length;
  const r = (await t.api('POST', `/api/tasks/${c.id}/start`, {})).json;
  assert.ok(r.sessionId);
  assert.equal(await columnOf(c.id), 'doing');
  assert.equal((await t.api('POST', `/api/tasks/${c.id}/start`, {})).status, 409, '일하는 중엔 또 못 맡긴다');
  assert.equal((await t.api('POST', `/api/tasks/${c.id}/close`, {})).status, 409, '일하는 중엔 완료 못 한다');
  await ended(r.sessionId);
  await t.waitFor(() => t.events.slice(before).some((e) => e.type === 'tasks' && e.data.find((x) => x.id === c.id)?.column === 'check'), 5000, '칸 바뀜 알림');
  assert.equal(await columnOf(c.id), 'check');
  const prompt = t.fakeLog().filter((l) => l.cli === 'codex' && l.prompt).at(-1).prompt;
  assert.match(prompt, /흐름 카드/);
  assert.match(prompt, /자세한 지시/);
  assert.equal((await t.api('POST', `/api/tasks/${c.id}/close`, {})).status, 200);
  assert.equal(await columnOf(c.id), 'done');
  assert.equal((await t.api('POST', `/api/tasks/${c.id}/reopen`, {})).status, 200);
  assert.equal(await columnOf(c.id), 'check');
});

test('승인을 기다리면 확인 필요 칸으로 간다', async () => {
  const team = t.app.store.all('teams').find((x) => x.stages.some((s) => s.approve));
  const c = await card({ title: '승인 카드', teamId: team.id, agentId: null });
  const r = (await t.api('POST', `/api/tasks/${c.id}/start`, {})).json;
  await t.waitFor(() => t.app.store.getSession(r.sessionId).runs.at(-1)?.hold?.reason === 'approve', 20000, '승인 대기');
  assert.equal(await columnOf(c.id), 'check');
  const task = () => t.api('GET', '/api/tasks').then((x) => x.json.find((y) => y.id === c.id));
  assert.equal((await task()).working, true, '승인 대기 중에도 아직 실행 중이라 완료 단추를 안 보인다');
  await t.api('POST', `/api/sessions/${r.sessionId}/control`, { action: 'stop' });
  await ended(r.sessionId);
  assert.equal((await task()).working, false);
});

test('맡긴 세션을 지우면 카드는 할 일로 돌아오고, 카드를 지워도 세션은 남는다', async () => {
  const c = await card({ title: '세션 삭제 카드' });
  const r = (await t.api('POST', `/api/tasks/${c.id}/start`, {})).json;
  await ended(r.sessionId);
  await t.api('DELETE', `/api/sessions/${r.sessionId}`);
  const after1 = (await t.api('GET', '/api/tasks')).json.find((x) => x.id === c.id);
  assert.deepEqual([after1.column, after1.sessionId], ['todo', null]);
  const r2 = (await t.api('POST', `/api/tasks/${c.id}/start`, {})).json;
  await ended(r2.sessionId);
  assert.equal((await t.api('DELETE', `/api/tasks/${c.id}`)).status, 200);
  assert.ok(t.app.store.getSession(r2.sessionId), '세션은 그대로');
  assert.equal((await t.api('POST', `/api/tasks/${c.id}/start`, {})).status, 404);
});

test('수정해도 실행 기록은 클라이언트 값으로 안 바뀐다', async () => {
  const c = await card({ title: '수정 카드' });
  const fake = (await t.api('PUT', `/api/tasks/${c.id}`, { title: '바꾼 제목', agentId: agent.id, sessionId: 's-fake', closedAt: 123, createdAt: 1 })).json;
  assert.deepEqual([fake.title, fake.sessionId, fake.closedAt, fake.createdAt], ['바꾼 제목', null, null, c.createdAt]);
});

test('카드는 파일로 저장된다', async () => {
  const c = await card({ title: '저장 카드' });
  await new Promise((r) => setTimeout(r, 600));
  const file = path.join(t.root, 'home', 'tasks.json');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).some((x) => x.id === c.id));
});

test('칸을 정할 때 세션 파일을 읽지 않는다(카드가 쌓여도 느려지지 않게)', async () => {
  const c = await card({ title: '읽기 안 함 카드' });
  const r = (await t.api('POST', `/api/tasks/${c.id}/start`, {})).json;
  await ended(r.sessionId);
  const store = t.app.store;
  const real = store.getSession;
  let reads = 0;
  store.getSession = function counted(...a) { reads++; return real.apply(this, a); };
  try {
    t.app.board.list();
    assert.equal(reads, 0);
  } finally { store.getSession = real; }
});

test('일하는 중에는 대상과 폴더를 못 바꾸고, 제목은 바꿀 수 있다', async () => {
  const other = (await t.api('POST', '/api/agents', { name: '다른담당', role: '조사', provider: 'codex', model: 'gpt-6.1-sol', permission: 'plan', routing: 'manual' })).json;
  const c = await card({ title: '수정 제한 카드', detail: 'SLOW' });
  const r = (await t.api('POST', `/api/tasks/${c.id}/start`, {})).json;
  assert.equal((await t.api('PUT', `/api/tasks/${c.id}`, { title: '수정 제한 카드', detail: 'SLOW', agentId: other.id })).status, 409);
  assert.equal((await t.api('PUT', `/api/tasks/${c.id}`, { title: '새 제목', detail: 'SLOW', agentId: agent.id })).status, 200);
  await ended(r.sessionId);
  assert.equal((await t.api('PUT', `/api/tasks/${c.id}`, { title: '새 제목', agentId: other.id })).status, 200, '끝나면 바꿀 수 있다');
});

test('맡기기가 실패하면 빈 세션을 남기지 않고 카드는 할 일에 남는다', async () => {
  const c = await card({ title: '시작 실패 카드' });
  const orch = t.app.orch;
  const real = orch.send;
  const before = t.app.store.listSessions().length;
  orch.send = () => { throw new Error('시작 실패 시험'); };
  try {
    assert.notEqual((await t.api('POST', `/api/tasks/${c.id}/start`, {})).status, 200);
  } finally { orch.send = real; }
  assert.equal(t.app.store.listSessions().length, before);
  assert.equal(await columnOf(c.id), 'todo');
});
