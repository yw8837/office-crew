// 내 PC 모델하고만 나눈 말은 앱이 실행 중에 꺼졌다 켜져도 클라우드 AI로 넘어가지 않는다(가짜 CLI·가짜 내 PC 모델 서버, 실제 AI 사용량 0)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { startTestApp, freePort } from './helpers.js';
import { createApp } from '../server/index.js';

// 가짜 내 PC 모델 서버(OpenAI 호환). hold 를 켜면 답을 붙잡아 둔다(실행 중 상태를 만들려고)
function fakeLocal() {
  const state = { hold: false, got: [], waiting: [] };
  const answer = (res) => res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '내 PC 모델의 답이야.' } }] })}\n\ndata: [DONE]\n\n`);
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'tiny' }] })); }
      state.got.push(body);
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
      if (state.hold) state.waiting.push(res); else answer(res);
    });
  });
  return {
    state,
    listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}/v1`))),
    close: () => new Promise((r) => { for (const res of state.waiting) res.destroy(); srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

test('실행 중·대기열에 있던 내 PC 모델용 말: 앱이 꺼졌다 켜져도 표시가 남고, 기억에 한 번만 들어가고, 클라우드 AI로 안 넘어간다', async () => {
  const t = await startTestApp();
  const local = fakeLocal();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cut-'));
  let app2 = null;
  try {
    const baseUrl = await local.listen();
    await t.api('PUT', '/api/settings', { memory: true });
    t.app.store.settings.localServers = [{ name: '가짜 로컬', baseUrl }];
    t.app.store.saveSettings();
    const mk = async (name, extra = {}) => (await t.api('POST', '/api/agents', { name, role: '조사', provider: 'codex', model: 'gpt-6.1-sol', permission: 'plan', routing: 'manual', ...extra })).json;
    const pc = await mk('로컬담당', { provider: 'local', model: 'custom0::tiny' });
    const cloud = await mk('구름담당');
    const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: pc.id, cwd: vault })).json;

    local.state.hold = true;
    const RUNNING = '금고 비밀번호 힌트는 은행나무 길 열일곱 번째 집 초인종 색깔이다.';
    const QUEUED = '두 번째 힌트는 살구나무 아래 화분 밑 열쇠다.';
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text: RUNNING });
    await t.waitFor(() => local.state.got.length === 1, 8000, '내 PC 모델이 요청을 받음');
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text: QUEUED });
    const live = t.app.store.getSession(s.id);
    assert.deepEqual(live.messages.filter((m) => m.role === 'user').map((m) => [m.status, m.local]), [['done', true], ['queued', true]], '보낼 때 미리 표시한다');
    assert.equal(live.titleLocal, true, '그 말로 만든 제목도 표시한다');

    // 오류로 아무도 못 받은 클라우드 AI 메시지가 기록에 남아 있어도(자동 라우팅 실패 등) 다시 켤 때 표시를 지우면 안 된다
    live.messages.push({ id: 'm-err', role: 'agent', agentId: cloud.id, runId: live.runs.at(-1).id, provider: 'codex', text: '', status: 'error', error: '라우팅 실패', createdAt: Date.now() });
    // 앱이 갑자기 꺼진 상황: 저장된 파일만 남기고 같은 데이터 폴더로 새로 켠다(첫 앱은 정리 없이 둔다)
    t.app.store.flush();
    await new Promise((r) => setTimeout(r, 400)); // 목록(index.json) 저장 대기
    app2 = createApp({ home: path.join(t.root, 'home'), port: 0, detect: false });
    app2.store.settings.lang = 'ko';
    assert.ok(app2.store.getSession(s.id).runs.some((r) => r.cut), '포트를 잡기 전에는 정리하지 않는다(이미 켜진 앱의 세션을 건드리지 않게)');
    const port = await app2.listen(await freePort());
    const s2 = app2.store.getSession(s.id);
    const users = s2.messages.filter((m) => m.role === 'user');
    assert.deepEqual(users.map((m) => [m.status, m.local, m.remembered]), [['done', true, true], ['stopped', true, true]], '다시 켠 뒤에도 표시가 남고 기억에 넣었다고 적는다');
    assert.ok(s2.runs.every((r) => !r.cut) && s2.messages.every((m) => !m.cut), '정리 표시는 지운다');
    const mem = await app2.memory.of(vault);
    const hits = async (q) => (await mem.search(q, { budget: 8000 })).hits;
    await t.waitFor(async () => (await hits('은행나무 초인종')).length && (await hits('살구나무 화분')).length, 5000, '두 말이 기억에 들어감');
    for (const q of ['은행나무 초인종', '살구나무 화분']) {
      const h = (await hits(q)).filter((c) => c.role === 'user');
      assert.equal(h.length, 1, `한 번만 들어간다: ${q}`);
      assert.equal(h[0].provider, 'local');
      assert.equal(h[0].title, '', '출처의 세션 제목도 비운다');
    }

    // 다시 켠 앱에서 클라우드 AI를 부른다: 이전 대화로도, 다른 세션의 기억으로도 안 넘어간다
    const api2 = (p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': app2.token }, body: JSON.stringify(body) }).then((r) => r.json());
    const say2 = async (sid, text) => {
      const n = app2.store.getSession(sid).runs.length;
      await api2(`/api/sessions/${sid}/messages`, { text });
      await t.waitFor(() => { const r = app2.store.getSession(sid).runs; return r.length > n && r.at(-1).endedAt; }, 15000, '실행 끝');
    };
    const lastPrompt = () => t.fakeLog().filter((l) => l.cli === 'codex' && l.prompt).at(-1).prompt;
    await say2(s.id, `@${cloud.name} 배포 일정표 정리 부탁해`);
    assert.ok(!/은행나무|살구나무/.test(lastPrompt()), '같은 세션의 이전 대화로 넘어가지 않는다');
    const other = await api2('/api/sessions', { teamId: null, agentId: cloud.id, cwd: vault });
    await t.waitFor(async () => (await hits('배포 일정표 정리')).length > 0, 5000, '클라우드 대화가 기억에 들어감');
    await say2(other.id, '배포 일정표 정리 어떻게 됐지? 금고 비밀번호 힌트도 알려줘');
    const p = lastPrompt();
    assert.match(p, /\[프로젝트 기억\]/);
    assert.ok(!/은행나무|살구나무/.test(p), '기억 조각으로도, 출처 줄의 세션 제목으로도 넘어가지 않는다');
  } finally {
    local.state.hold = false;
    try { if (app2) await app2.close(); } catch { /* 무시 */ }
    await local.close();
    try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ }
    try { fs.rmSync(vault, { recursive: true, force: true }); } catch { /* 무시 */ }
  }
});

test('앱을 정상으로 끌 때: 실행 중이던 내 말은 그때 기억에 들어가고, 다시 켜도 두 번 들어가지 않는다', async () => {
  const t = await startTestApp();
  const local = fakeLocal();
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-quit-'));
  const home = path.join(t.root, 'home');
  let app2 = null;
  try {
    const baseUrl = await local.listen();
    await t.api('PUT', '/api/settings', { memory: true });
    t.app.store.settings.localServers = [{ name: '가짜 로컬', baseUrl }];
    t.app.store.saveSettings();
    const pc = (await t.api('POST', '/api/agents', { name: '로컬담당', role: '조사', provider: 'local', model: 'custom0::tiny', permission: 'plan', routing: 'manual' })).json;
    const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: pc.id, cwd: vault })).json;
    local.state.hold = true;
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '세 번째 힌트는 대추나무 옆 우체통이다.' });
    await t.waitFor(() => local.state.got.length === 1, 8000, '내 PC 모델이 요청을 받음');
    await t.app.close();

    app2 = createApp({ home, port: 0, detect: false });
    await app2.listen(await freePort());
    const u = app2.store.getSession(s.id).messages.find((m) => m.role === 'user');
    assert.deepEqual([u.local, u.remembered], [true, true]);
    const mem = await app2.memory.of(vault); // 기다리지 않고 바로 본다: 끌 때 다 쓰고 닫았어야 한다
    const h = (await mem.search('대추나무 우체통', { budget: 8000 })).hits.filter((c) => c.role === 'user');
    assert.equal(h.length, 1, '한 번만 들어간다');
    assert.equal(h[0].provider, 'local');
  } finally {
    local.state.hold = false;
    try { if (app2) await app2.close(); } catch { /* 무시 */ }
    await local.close();
    try { fs.rmSync(t.root, { recursive: true, force: true }); } catch { /* 윈도우 파일 잠금 무시 */ }
    try { fs.rmSync(vault, { recursive: true, force: true }); } catch { /* 무시 */ }
  }
});
