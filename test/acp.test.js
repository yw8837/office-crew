// ACP 표준 에이전트: 가짜 ACP 에이전트로 초기화·세션·스트리밍·도구·파일 읽기 범위·권한·취소를 검증(실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';

let t, work;
before(async () => {
  t = await startTestApp();
  work = path.join(t.root, 'acp-work', 'proj');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'note.txt'), '노트 내용 123');
  fs.writeFileSync(path.join(t.root, 'acp-work', 'outside-secret.txt'), '비밀');
});
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const run = async (permission, text) => {
  const a = (await t.api('POST', '/api/agents', { name: `ACP-${permission}`, role: '조사', provider: 'acp', model: 'fake', permission })).json;
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id, cwd: work })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
  return { a, sid: s.id };
};
const waitEnd = (sid) => t.waitFor(() => t.app.store.getSession(sid).runs.at(-1)?.endedAt, 10000, '실행 종료');
const acpLog = () => t.fakeLog().filter((l) => l.cli === 'acp');

test('ACP 에이전트 설정: 검증·정리 후 저장되고 탐지된다', async () => {
  const r = await t.api('PUT', '/api/settings', { acpAgents: [
    { id: 'fake', name: '가짜 ACP', command: 'fake-acp', args: '' },
    { name: 'Bad One', command: 'x\nrm -rf /' },
    { name: '인자 문자열', command: 'gemini', args: '--acp  --debug' },
  ] });
  assert.equal(r.status, 200);
  const list = r.json.acpAgents;
  assert.equal(list.length, 2, '줄바꿈 들어간 명령은 버림');
  assert.deepEqual(list[1].args, ['--acp', '--debug']);
  await t.waitFor(() => t.app.providers.detected.acp?.installed !== undefined, 5000, 'ACP 탐지');
  assert.equal(t.app.providers.detected.acp.installed, true);
  const models = await t.app.providers.models('acp', { force: true });
  assert.ok(models.some((m) => m.id === 'fake' && m.label === '가짜 ACP'));
});

test('읽기 전용: 글·생각·도구 결과가 흐르고, 작업 폴더 밖 읽기와 수정 권한은 거부된다', async () => {
  const { sid } = await run('plan', 'ACP로 조사해줘');
  await waitEnd(sid);
  const m = t.app.store.getSession(sid).messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'done', m.error);
  assert.equal(m.text, 'ACP 답: 완료');
  assert.ok(m.blocks.some((b) => b.kind === 'thinking' && /생각 중/.test(b.text)));
  const tool = m.blocks.find((b) => b.kind === 'tool' && b.name === '파일 읽기');
  assert.equal(tool.status, 'done');
  assert.match(tool.output, /노트 내용 123/, '작업 폴더 안 파일은 읽힘');
  assert.equal(m.usage.input, 12);
  const log = acpLog();
  assert.equal(log.find((l) => l.method === 'outside-read').error, true, '작업 폴더 밖은 거부');
  assert.deepEqual(log.filter((l) => l.method === 'permission').at(-1).outcome, { outcome: 'selected', optionId: 'r1' }, '읽기 전용이면 수정 거부');
  const init = log.find((l) => l.method === 'initialize').params;
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.clientCapabilities.fs.writeTextFile, false);
  assert.equal(log.filter((l) => l.method === 'session/new').at(-1).cwd, work);
  // 지침을 따로 못 받는 에이전트는 프롬프트 앞에 붙인다
  assert.match(log.filter((l) => l.method === 'session/prompt').at(-1).text, /역할 지침/);
});

test('파일 편집 허용이면 수정 권한을 허락한다 + 지침 지원 에이전트에는 systemPrompt 로 보낸다', async () => {
  process.env.FAKE_ACP_SYS = '1';
  try {
    const { sid } = await run('edit', '고쳐줘');
    await waitEnd(sid);
    const log = acpLog();
    assert.deepEqual(log.filter((l) => l.method === 'permission').at(-1).outcome, { outcome: 'selected', optionId: 'a1' });
    assert.equal(log.filter((l) => l.method === 'session/new').at(-1).systemPrompt.mode, 'append');
    assert.doesNotMatch(log.filter((l) => l.method === 'session/prompt').at(-1).text, /역할 지침/);
  } finally { delete process.env.FAKE_ACP_SYS; }
});

test('중지하면 표준 session/cancel 을 보내고 멈춘다', async () => {
  const seen = acpLog().filter((l) => l.method === 'permission').length;
  const { sid } = await run('plan', 'ACPSLOW 오래 걸리는 일');
  await t.waitFor(() => acpLog().filter((l) => l.method === 'permission').length > seen, 8000, '진행 중');
  await new Promise((r) => setTimeout(r, 200));
  await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
  await waitEnd(sid);
  const m = t.app.store.getSession(sid).messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'stopped');
  assert.ok(acpLog().some((l) => l.method === 'session/cancel'));
});

test('설정에 없는 ACP 에이전트면 알아듣게 오류', async () => {
  await t.api('PUT', '/api/settings', { acpAgents: [] });
  const { sid } = await run('plan', '아무거나');
  await t.waitFor(() => t.app.store.getSession(sid).runs.at(-1)?.endedAt || t.app.store.getSession(sid).runs.at(-1)?.hold, 8000, '종료');
  const m = t.app.store.getSession(sid).messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'error');
  assert.match(m.error, /ACP 에이전트/);
});
