// 세션 불러오기 → 앱 세션 → 같은 대화 이어하기(가짜 기록·가짜 CLI, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-import-app-'));
const proj = path.join(root, 'work', 'proj'); // 실제로 있는 폴더
const gone = path.join(root, 'work', 'gone'); // 없는 폴더
const C1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const CDEAD = 'deadbeef-2222-4222-8222-222222222222'; // 가짜 claude 가 이어하기를 거부하는 id
const X1 = '01b00000-0000-7000-8000-000000000001';
const ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
const saved = {};

const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const jl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const iso = (sec) => new Date(Date.UTC(2026, 9, 1) + sec * 1000).toISOString();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const cl = (sid, cwd, sec, extra) => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.1.300', uuid: `u${sec}`, timestamp: iso(sec), ...extra });
const usr = (sid, cwd, sec, text) => cl(sid, cwd, sec, { type: 'user', message: { role: 'user', content: text } });
const asst = (sid, cwd, sec, text) => cl(sid, cwd, sec, { type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }] } });
const cx = (sec, type, payload) => ({ timestamp: iso(sec), type, payload });

let t;
before(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  fs.mkdirSync(proj, { recursive: true });
  const cdir = path.join(root, 'claude', 'projects');
  write(path.join(cdir, enc(proj), `${C1}.jsonl`), jl([
    usr(C1, proj, 1, '로그인 화면 만들어줘'), asst(C1, proj, 2, '로그인 화면 초안을 만들었어'),
    usr(C1, proj, 3, '버튼 색 바꿔줘'), asst(C1, proj, 4, '버튼을 파랗게 바꿨어'),
  ]));
  write(path.join(cdir, enc(gone), `${CDEAD}.jsonl`), jl([usr(CDEAD, gone, 10, '옛 프로젝트 질문'), asst(CDEAD, gone, 11, '옛 프로젝트 답변 비밀단어123')]));
  write(path.join(root, 'codex', 'sessions', '2026', '10', '02', `rollout-2026-10-02T10-00-00-${X1}.jsonl`), jl([
    cx(100, 'session_meta', { id: X1, timestamp: iso(100), cwd: proj, originator: 'codex_exec', cli_version: '0.166.0', source: 'exec' }),
    cx(101, 'turn_context', { cwd: proj, model: 'gpt-6.1-sol' }),
    cx(102, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '코덱스로 하던 정리 작업' }] }),
    cx(103, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '표로 정리했어' }] }),
  ]));
  t = await startTestApp();
});
after(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ }
  fs.rmSync(root, { recursive: true, force: true });
});

const send = async (sid, text) => {
  const before = t.app.store.getSession(sid).runs.length;
  const r = await t.api('POST', `/api/sessions/${sid}/messages`, { text });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await t.waitFor(() => { const s = t.app.store.getSession(sid); return s.runs.length > before && s.runs.at(-1).endedAt; }, 10000, '실행 종료');
};

test('불러올 수 있는 목록: Claude·Codex 기록 3개, 검색', async () => {
  const all = (await t.api('GET', '/api/import/list')).json;
  assert.deepEqual(all.map((x) => x.id).sort(), [C1, X1, CDEAD].sort());
  const one = all.find((x) => x.id === C1);
  assert.equal(one.source, 'claude');
  assert.equal(one.cwdExists, true);
  assert.equal(all.find((x) => x.id === CDEAD).cwdExists, false);
  const q = (await t.api('GET', `/api/import/list?q=${encodeURIComponent('코덱스')}`)).json;
  assert.deepEqual(q.map((x) => x.id), [X1]);
});

test('Claude 세션 불러오기 → 원래 폴더에서 갈래(fork)로 이어가고, 다음부턴 새 갈래를 이어간다', async () => {
  const r = await t.api('POST', '/api/import', { source: 'claude', id: C1 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const sid = r.json.sessionId;
  let s = t.app.store.getSession(sid);
  assert.equal(s.cwd, proj);
  assert.equal(s.agentId, 'import-claude');
  assert.equal(s.providerSessions['import-claude'], C1);
  assert.deepEqual(s.messages.filter((m) => m.role !== 'system').map((m) => [m.role, m.text]), [
    ['user', '로그인 화면 만들어줘'], ['agent', '로그인 화면 초안을 만들었어'], ['user', '버튼 색 바꿔줘'], ['agent', '버튼을 파랗게 바꿨어'],
  ]);
  assert.ok(s.messages.every((m) => m.id), '메시지마다 id');
  assert.match(s.messages.at(-1).text, /Claude Code에서 하던 대화를 불러왔어 \(메시지 4개\)/);
  const agent = t.app.store.get('agents', 'import-claude');
  assert.deepEqual([agent.provider, agent.model, agent.routing], ['claude', '', 'manual']);
  // 원래 기록 파일은 그대로(읽기만)
  const file = path.join(root, 'claude', 'projects', enc(proj), `${C1}.jsonl`);
  const before = fs.readFileSync(file, 'utf8');

  await send(sid, '이어서 입력칸도 만들어줘');
  const runs = t.fakeLog().filter((l) => l.cli === 'claude' && l.args);
  const first = runs.at(-1).args;
  assert.deepEqual(first.slice(first.indexOf('--resume'), first.indexOf('--resume') + 3), ['--resume', C1, '--fork-session']);
  s = t.app.store.getSession(sid);
  const forked = s.providerSessions['import-claude'];
  assert.notEqual(forked, C1, '갈래 id 로 바뀜');
  assert.equal(fs.readFileSync(file, 'utf8'), before, '원래 기록 파일은 안 바뀜');

  await send(sid, '하나 더');
  const second = t.fakeLog().filter((l) => l.cli === 'claude' && l.args).at(-1).args;
  assert.equal(second[second.indexOf('--resume') + 1], forked);
  assert.ok(!second.includes('--fork-session'), '두 번째부터는 갈래를 또 만들지 않음');
});

test('Codex 세션 불러오기 → 같은 스레드로 이어간다', async () => {
  const r = await t.api('POST', '/api/import', { source: 'codex', id: X1 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const sid = r.json.sessionId;
  assert.equal(t.app.store.getSession(sid).agentId, 'import-codex');
  await send(sid, '정리 이어서');
  const args = t.fakeLog().filter((l) => l.cli === 'codex' && l.args).at(-1).args;
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', X1]);
  const m = t.app.store.getSession(sid).messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'done');
});

test('원래 폴더가 없고 이어하기도 안 되면 최근 대화를 넣어 새 대화로 맥락을 잇는다', async () => {
  const r = await t.api('POST', '/api/import', { source: 'claude', id: CDEAD });
  const sid = r.json.sessionId;
  assert.equal(r.json.cwdExists, false);
  let s = t.app.store.getSession(sid);
  assert.equal(s.cwd, '', '새 작업 폴더 사용');
  assert.match(s.messages.at(-1).text, /원래 프로젝트 폴더가 없어서/);
  await send(sid, '이어서 해줘');
  s = t.app.store.getSession(sid);
  const m = s.messages.filter((x) => x.role === 'agent').at(-1);
  assert.equal(m.status, 'done');
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && /새 대화로 다시 시작/.test(b.text)));
  const sent = t.fakeLog().filter((l) => l.cli === 'claude' && l.text).at(-1).text;
  assert.match(sent, /\[이전 대화\]/);
  assert.match(sent, /비밀단어123/, '불러온 대화 내용이 들어감');
  assert.match(sent, /이어서 해줘/);
  assert.equal((sent.match(/이어서 해줘/g) || []).length, 1, '지금 요청은 한 번만');
});

test('잘못된 요청: 종류·id 형식·없는 기록', async () => {
  assert.equal((await t.api('POST', '/api/import', { source: 'gemini', id: C1 })).status, 400);
  assert.equal((await t.api('POST', '/api/import', { source: 'claude', id: '../../etc/passwd' })).status, 400);
  assert.equal((await t.api('POST', '/api/import', { source: 'claude', id: 'ffffffff-0000-4000-8000-000000000000' })).status, 404);
});
