// 불러온 세션을 다른 AI가 이어받기: 앞 대화에서 고른 부분, 대화 전체 파일, 인수인계 메모, 불러온 대화의 프로젝트 기억
// (가짜 기록·가짜 CLI·가짜 내 PC 모델 서버, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startTestApp } from './helpers.js';
import { pickEarlier, writeConversation } from '../server/handoff.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-handoff-'));
const proj = path.join(root, 'work', 'proj');
const X2 = '01b00000-0000-7000-8000-000000000002';
const ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
const saved = {};
const PAIRS = 250; // 메시지 500개: 화면에는 최근 400개만 싣는다
const DECISION = '데이터베이스는 감나무DB로 정했어';
const MIDDLE = '결제 모듈은 살구페이 연동으로 가기로 했어'; // 한가운데(40번째 요청)에 있는 결정

const jl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const iso = (sec) => new Date(Date.UTC(2026, 9, 1) + sec * 1000).toISOString();
const cx = (sec, type, payload) => ({ timestamp: iso(sec), type, payload });

let t, claudeA, claudeB, codexB;
before(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  fs.mkdirSync(proj, { recursive: true });
  const rows = [
    cx(100, 'session_meta', { id: X2, timestamp: iso(100), cwd: proj, originator: 'codex_exec', cli_version: '0.166.0', source: 'exec' }),
    cx(101, 'turn_context', { cwd: proj, model: 'gpt-6.1-sol' }),
  ];
  for (let i = 0; i < PAIRS; i++) {
    const u = i === 0 ? `첫 요청: ${DECISION}` : i === 40 ? MIDDLE : `요청 ${i}번`;
    rows.push(cx(200 + i * 2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: u }] }));
    rows.push(cx(201 + i * 2, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `답 ${i}번` }] }));
  }
  const file = path.join(root, 'codex', 'sessions', '2026', '10', '02', `rollout-2026-10-02T10-00-00-${X2}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jl(rows));
  t = await startTestApp();
  const mk = async (name, extra = {}) => (await t.api('POST', '/api/agents', { name, role: '검토', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual', ...extra })).json;
  claudeA = await mk('검토담당');
  claudeB = await mk('설계담당');
  codexB = await mk('코덱스새담당', { provider: 'codex', model: 'gpt-6.1-sol' });
});
after(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ }
  fs.rmSync(root, { recursive: true, force: true });
});

const say = async (sid, text) => {
  const n = t.app.store.getSession(sid).runs.length;
  const r = await t.api('POST', `/api/sessions/${sid}/messages`, { text });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await t.waitFor(() => { const s = t.app.store.getSession(sid); return s.runs.length > n && s.runs.at(-1).endedAt && !t.app.orch.ctx.has(sid); }, 20000, '실행 끝');
};
const claudeTurn = () => t.fakeLog().filter((l) => l.cli === 'claude' && l.text).at(-1).text;
const claudeArgs = () => t.fakeLog().filter((l) => l.cli === 'claude' && l.args).at(-1).args;
const codexLast = () => t.fakeLog().filter((l) => l.cli === 'codex' && l.prompt).at(-1);
const lastAgent = (sid) => t.app.store.getSession(sid).messages.filter((m) => m.role === 'agent').at(-1);
const notices = (m) => m.blocks.filter((b) => b.kind === 'notice').map((b) => b.text);
const handoffDir = (sid) => path.join(t.root, 'home', 'handoff', sid);
const importX2 = async () => (await t.api('POST', '/api/import', { source: 'codex', id: X2 })).json;

let sid;
test('불러오기: 화면에는 최근 400개, 대화 전체 글은 따로 적어 두고 안내 문구가 사실과 맞다', async () => {
  const r = await t.api('POST', '/api/import', { source: 'codex', id: X2 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  sid = r.json.sessionId;
  assert.deepEqual([r.json.total, r.json.shown, r.json.truncated], [PAIRS * 2, 400, true]);
  const rows = fs.readFileSync(path.join(handoffDir(sid), 'import.jsonl'), 'utf8').trim().split('\n');
  assert.equal(rows.length, PAIRS * 2, '화면에 안 싣는 앞부분까지 전부 적어 둔다');
  assert.ok(JSON.parse(rows[0]).x.includes(DECISION));
  const note = t.app.store.getSession(sid).messages.find((m) => m.role === 'system').text;
  assert.match(note, /화면에는 최근 400개만 보여\./);
  assert.match(note, /Codex CLI 에이전트로 이어 가면 앞부분 맥락까지 그대로야\. 다른 AI에게 맡기면 최근 대화와 대화 전체 파일을 건네\./);
});

test('다른 AI(Claude)에게 맡기면: 맨 처음과 요청과 관련된 앞 대화를 골라 직접 넣고, 대화 전체 파일을 건네고, 그 폴더만 연다', async () => {
  await say(sid, `@${claudeA.name} 결제 모듈 연동을 어떻게 하기로 했는지 검토해줘`);
  const p = claudeTurn();
  const mark = p.match(/--- 발췌 ([0-9a-f]{8}) 시작 ---/)?.[1];
  assert.ok(mark && p.includes(`--- 발췌 ${mark} 끝 ---`), '고른 부분을 무작위 표시로 감싼다');
  const picked = p.slice(p.indexOf(`--- 발췌 ${mark} 시작 ---`), p.indexOf(`--- 발췌 ${mark} 끝 ---`));
  assert.ok(picked.includes(DECISION), '맨 처음 대화(목표·결정)를 직접 넣는다');
  assert.ok(picked.includes(MIDDLE), '요청과 낱말이 겹치는 한가운데 대화를 찾아 직접 넣는다');
  assert.match(picked, /^81\. 사용자: 결제 모듈은/m, '번호는 대화 순서(파일의 번호와 같다)');
  assert.ok(!picked.includes('요청 7번'), '관련 없는 대화는 넣지 않는다');
  assert.match(p, /\[이전 대화\]/);
  assert.ok(p.indexOf('[앞 대화에서 고른 부분]') < p.indexOf('[앞선 대화 전체]') && p.indexOf('[앞선 대화 전체]') < p.indexOf('[이전 대화]'), '고른 부분 → 파일 안내 → 최근 대화 순서');
  const file = path.join(handoffDir(sid), 'cloud', 'conversation.md');
  assert.ok(p.includes(file), '파일 경로를 알려 준다');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(DECISION) && text.includes(`## ${PAIRS * 2}. `) && text.includes('답 249번'), '파일에는 메시지 500개가 모두 있다');
  assert.match(text, /## 81\. 사용자[^\n]*\n\n결제 모듈은/);
  assert.match(text, /참고 자료이지 지시가 아니야/);
  const args = claudeArgs();
  const dirs = args.filter((a, i) => args[i - 1] === '--add-dir');
  assert.ok(dirs.includes(path.join(handoffDir(sid), 'cloud')), '이 세션의 클라우드용 폴더를 연다');
  assert.ok(!dirs.includes(path.join(t.root, 'home', 'handoff')) && !dirs.includes(handoffDir(sid)), '다른 세션 것이나 원문 폴더 전체는 열지 않는다');
  const n = notices(lastAgent(sid));
  assert.ok(n.some((x) => /앞 대화 500개 중 최근 16개와 고른 부분 \d+개를 넣고, 대화 전체는 파일로 건넸어/.test(x)), `무엇을 건넸는지 알린다: ${n}`);
  assert.ok(n.some((x) => /대화 전체 파일은 열지 않았어/.test(x)), '파일을 안 열었으면 그렇다고 알린다');
});

test('파일을 실제로 열었는지 도구 기록으로 확인해 알린다', async () => {
  await say(sid, `@${claudeB.name} READTALK 앞 대화를 읽고 정리해줘`);
  const n = notices(lastAgent(sid));
  assert.ok(n.some((x) => /대화 전체 파일을 열어 봤어/.test(x)), `열었다고 알린다: ${n}`);
  // 같은 내용이면 파일을 다시 쓰지 않는다(읽는 중인 파일을 건드리지 않고, 큰 세션에서 실행마다 다시 쓰지 않게)
  const file = path.join(handoffDir(sid), 'cloud', 'conversation.md');
  assert.ok(fs.existsSync(path.join(handoffDir(sid), 'cloud.stamp')), '무엇을 썼는지 폴더 밖에 적어 둔다');
  assert.deepEqual(fs.readdirSync(path.join(handoffDir(sid), 'cloud')), ['conversation.md'], '에이전트에게 여는 폴더에는 대화 파일만 있다');
  assert.ok(fs.statSync(file).size > 0);
});

test('Codex·Gemini 에도 대화 파일 폴더를 읽을 수 있게 연다(올린 파일 폴더는 따로 열지 않는다)', async () => {
  await say(sid, `@${codexB.name} 결제 모듈 이어서 봐줘`);
  const c = codexLast();
  const cdirs = c.args.filter((a, i) => c.args[i - 1] === '--add-dir');
  assert.deepEqual(cdirs, [path.join(handoffDir(sid), 'cloud')]);
  assert.ok(c.prompt.includes(MIDDLE), 'Codex 도 고른 부분을 직접 받는다');
  // 이어 가는 대화(resume)에는 다시 열지 않는다
  await say(sid, `@${codexB.name} 계속`);
  assert.ok(!codexLast().args.includes('--add-dir'));

  // Gemini(이어 가지 못하는 CLI): 맡을 때마다 폴더를 연다
  const gem = (await t.api('POST', '/api/agents', { name: '제미나이담당', role: '검토', provider: 'gemini', model: 'gemini-x', permission: 'plan', routing: 'manual' })).json;
  await say(sid, `@${gem.name} 결제 모듈 검토해줘`);
  const g = () => t.fakeLog().filter((l) => l.cli === 'gemini').at(-1);
  const gdirs = () => g().args.filter((a, i) => g().args[i - 1] === '--include-directories');
  assert.deepEqual(gdirs(), [path.join(handoffDir(sid), 'cloud')]);
  assert.ok(g().prompt.includes(MIDDLE) && g().prompt.includes('conversation.md'));

  // 이어 가지 못하는 AI는 [이전 대화]에 내 말과 자기 답만 받는다. 거기 없는 다른 AI의 답은 '고른 부분'의 후보가 돼야 하고(끝에서 개수만큼 빼면 최근 답이 통째로 사라진다), 알림의 개수도 실제와 맞아야 한다
  const o = (await t.api('POST', '/api/sessions', { teamId: null, agentId: gem.id })).json;
  const os0 = t.app.store.getSession(o.id);
  for (let i = 0; i < 30; i++) {
    os0.messages.push({ id: `ou${i}`, role: 'user', text: `물음 ${i}번`, status: 'done', createdAt: 1000 + i * 2 });
    os0.messages.push({ id: `oa${i}`, role: 'agent', agentId: 'other', provider: 'codex', runId: 'old', text: i === 29 ? '마지막 결론은 대추페이 결제로 간다' : `남의 답 ${i}번`, status: 'done', createdAt: 1001 + i * 2 });
  }
  await say(o.id, '대추페이 결제 결론이 뭐였지?');
  assert.ok(g().prompt.includes('마지막 결론은 대추페이 결제로 간다'), '다른 AI의 맨 마지막 답을 받는다');
  const on = notices(lastAgent(o.id)).find((x) => /앞 대화 60개 중/.test(x));
  assert.match(on, /앞 대화 60개 중 최근 16개와 고른 부분 \d+개를 넣고/, '[이전 대화]에 실제로 넣은 개수를 말한다');

  // 승인 거절로 같은 실행에서 다시 돌 때도 파일 경로와 폴더가 같이 간다(글만 남고 폴더가 빠지면 못 읽는다)
  const team = (await t.api('POST', '/api/teams', { name: '승인 팀', stages: [{ label: '검토', agentIds: [gem.id], approve: true }] })).json;
  const a = await importX2();
  await t.api('PATCH', `/api/sessions/${a.sessionId}`, { teamId: team.id, agentId: null });
  const before = t.fakeLog().filter((l) => l.cli === 'gemini').length;
  await t.api('POST', `/api/sessions/${a.sessionId}/messages`, { text: '결제 모듈 검토해줘' });
  await t.waitFor(() => t.app.store.getSession(a.sessionId).runs.at(-1)?.hold, 15000, '승인 대기');
  await t.api('POST', `/api/sessions/${a.sessionId}/control`, { action: 'reject', text: '다시 해' });
  await t.waitFor(() => t.fakeLog().filter((l) => l.cli === 'gemini').length === before + 2 && t.app.store.getSession(a.sessionId).runs.at(-1)?.hold, 15000, '다시 돈 뒤 승인 대기');
  assert.deepEqual(gdirs(), [path.join(handoffDir(a.sessionId), 'cloud')], '두 번째 시도에도 폴더를 연다');
  assert.ok(g().prompt.includes('conversation.md') && g().prompt.includes('다시 해'));
  await t.api('POST', `/api/sessions/${a.sessionId}/control`, { action: 'stop' });
  await t.waitFor(() => !t.app.orch.ctx.has(a.sessionId), 10000, '중지');
});

test('인수인계 메모: 원래 맡던 AI가 쓰고, 다른 AI는 이어받을 때 그 메모를 먼저 받는다', async () => {
  const empty = (await t.api('POST', '/api/sessions', { teamId: null, agentId: claudeA.id })).json;
  assert.equal((await t.api('POST', `/api/sessions/${empty.id}/handoff`, {})).status, 400, '대화가 없으면 못 만든다');
  const never = (await t.api('POST', '/api/agents', { name: '안나온담당', role: '검토', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  assert.equal((await t.api('POST', `/api/sessions/${sid}/handoff`, { agentId: never.id })).status, 400, '이 세션에서 답한 적 없는 에이전트는 못 쓴다');

  const n = t.app.store.getSession(sid).runs.length;
  const r = await t.api('POST', `/api/sessions/${sid}/handoff`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await t.waitFor(() => { const s = t.app.store.getSession(sid); return s.runs.length > n && s.runs.at(-1).endedAt; }, 15000, '메모 작성 끝');
  const s = t.app.store.getSession(sid);
  const imported = Object.keys(s.sessionProvider)[0];
  assert.equal(r.json.agentId, imported, '원래 대화를 이어 가는 에이전트(불러온 Codex)가 쓴다');
  const ask = s.messages.filter((m) => m.role === 'user').at(-1);
  const memo = lastAgent(sid);
  assert.equal(ask.handoffAsk, true);
  assert.deepEqual([memo.handoff, memo.agentId, memo.status], [true, imported, 'done']);
  assert.match(codexLast().prompt, /인수인계 메모로 정리해 줘/);
  assert.doesNotMatch(codexLast().prompt, /\[프로젝트 기억\]/);
  assert.notEqual(s.title, ask.text.slice(0, 40), '메모 요청으로 제목을 짓지 않는다');
  assert.ok(codexLast().args.includes(X2), '원래 Codex 대화를 이어서 쓴다(앞부분까지 아는 쪽)');

  // 처음 맡는 다른 AI: 메모를 표시로 감싸 먼저 받는다. 정해진 요청 문구는 대화에 안 실린다
  const fresh = (await t.api('POST', '/api/agents', { name: '새검토담당', role: '검토', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  await say(sid, `@${fresh.name} 다음 계획 세워줘`);
  const p = claudeTurn();
  const mark = p.match(/--- 메모 ([0-9a-f]{8}) 시작 ---/)?.[1];
  assert.ok(mark && p.includes(`--- 메모 ${mark} 끝 ---`), '무작위 표시로 감싼다');
  assert.ok(p.indexOf('[인수인계 메모]') < p.indexOf('[앞 대화에서 고른 부분]'), '맨 앞에 둔다');
  assert.ok(p.includes(memo.text.slice(0, 20)), '메모 원문이 들어간다');
  assert.ok(!p.includes('새 작업은 하지 말고 메모만 써'), '메모를 써 달라는 요청 문구는 넣지 않는다');
  assert.ok(!fs.readFileSync(path.join(handoffDir(sid), 'cloud', 'conversation.md'), 'utf8').includes('새 작업은 하지 말고 메모만 써'), '대화 파일에도 넣지 않는다');

  // 이미 이어 가던 다른 AI: 지난 답 뒤에 쓰인 메모를 놓친 대화와 함께 받는다
  await say(sid, `@${claudeA.name} 이어서 해줘`);
  assert.match(claudeTurn(), /\[인수인계 메모\]/);
  // 쓴 본인에게는 다시 주지 않는다(본인 답 뒤에 다른 대화가 오가서 '놓친 대화'가 생긴 경우에도)
  await say(sid, `@${t.app.store.get('agents', imported).name} 계속해줘`);
  const own = codexLast().prompt;
  assert.match(own, /네가 지난번 답한 뒤 오간 대화/);
  assert.doesNotMatch(own, /\[인수인계 메모\]/);
  assert.ok(!own.includes('새 작업은 하지 말고 메모만 써'));

  // 이어 가는 대화가 있는 에이전트가 둘이면 이 세션에서 더 많이 답한 쪽이 쓴다. 쓰는 중에 또 누르면 받지 않는다
  const r2 = await t.api('POST', `/api/sessions/${sid}/handoff`, {});
  assert.equal(r2.json.agentId, imported, '불러온 대화 250번을 답한 쪽');
  assert.equal((await t.api('POST', `/api/sessions/${sid}/handoff`, {})).status, 409, '쓰는 중엔 또 받지 않는다');
  await t.waitFor(() => !t.app.orch.ctx.has(sid), 15000, '메모 작성 끝');
});

test('메모 자동 작성(설정, 기본 꺼짐): 다른 AI가 처음 맡기 전에 원래 AI가 메모를 먼저 쓰고, 요청은 그 뒤에 이어서 돈다', async () => {
  assert.notEqual(t.app.store.settings.autoHandoff, true, '기본은 꺼져 있다');
  const a = await importX2();
  const before1 = t.fakeLog().filter((l) => l.cli === 'codex').length;
  const off = (await t.api('POST', '/api/agents', { name: '꺼짐때담당', role: '검토', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  await say(a.sessionId, `@${off.name} 검토해줘`);
  assert.equal(t.fakeLog().filter((l) => l.cli === 'codex').length, before1, '꺼져 있으면 원래 AI를 부르지 않는다');

  assert.equal((await t.api('PUT', '/api/settings', { autoHandoff: true })).status, 200);
  const b = await importX2();
  const on = (await t.api('POST', '/api/agents', { name: '켜짐때담당', role: '검토', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  const r = await t.api('POST', `/api/sessions/${b.sessionId}/messages`, { text: `@${on.name} 이어서 검토해줘` });
  assert.equal(r.json.queued, true, '내 요청은 메모 뒤에 줄을 선다');
  await t.waitFor(() => { const s = t.app.store.getSession(b.sessionId); return s.runs.length === 2 && s.runs[1].endedAt && !t.app.orch.ctx.has(b.sessionId); }, 20000, '메모 → 요청 순서로 끝');
  const s = t.app.store.getSession(b.sessionId);
  const memo = s.messages.find((m) => m.handoff);
  assert.ok(memo && memo.provider === 'codex' && memo.status === 'done', '원래 AI(Codex)가 메모를 썼다');
  assert.ok(s.messages.some((m) => m.role === 'system' && /인수인계 메모를 먼저 쓰게 했어/.test(m.text)), '왜 한 번 더 불렀는지 알린다');
  assert.match(claudeTurn(), /\[인수인계 메모\]/);
  assert.ok(claudeTurn().includes('이어서 검토해줘'));
  // 같은 AI가 또 맡을 때, 원래 AI가 이어 갈 때는 다시 쓰지 않는다
  const before2 = s.messages.filter((m) => m.handoff).length;
  await say(b.sessionId, `@${on.name} 한 번 더`);
  await say(b.sessionId, '원래 담당이 계속해줘');
  assert.equal(t.app.store.getSession(b.sessionId).messages.filter((m) => m.handoff).length, before2);

  // 원래 AI가 일하는 중에 새 AI에게 보낸 요청(대기열)에도 메모가 먼저 줄을 선다
  const c = await importX2();
  const impName = t.app.store.get('agents', t.app.store.getSession(c.sessionId).importedFrom.agentId).name;
  const q1 = (await t.api('POST', '/api/agents', { name: '줄선담당', role: '검토', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  await t.api('POST', `/api/sessions/${c.sessionId}/messages`, { text: `@${impName} SLOW 하던 일 계속해줘` });
  const rq = await t.api('POST', `/api/sessions/${c.sessionId}/messages`, { text: `@${q1.name} 이어서 검토해줘` });
  assert.equal(rq.json.queued, true);
  await t.waitFor(() => { const x = t.app.store.getSession(c.sessionId); return x.runs.length === 3 && x.runs[2].endedAt && !t.app.orch.ctx.has(c.sessionId); }, 30000, '하던 일 → 메모 → 요청');
  const cs = t.app.store.getSession(c.sessionId);
  const order = cs.messages.filter((m) => m.role === 'agent' && !m.imported).map((m) => (m.handoff ? '메모' : m.provider));
  assert.deepEqual(order, ['codex', '메모', 'claude'], '메모가 새 AI의 답보다 먼저');
  assert.match(claudeTurn(), /\[인수인계 메모\]/);

  // 메모 쓰기가 실패하면: 결정을 기다리지 않고 내 요청은 메모 없이 이어서 돌고, 다음에 같은 실패를 되풀이하지 않는다
  const d = await importX2();
  const imp = t.app.store.get('agents', t.app.store.getSession(d.sessionId).importedFrom.agentId);
  const q2 = (await t.api('POST', '/api/agents', { name: '실패뒤담당', role: '검토', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  const q3 = (await t.api('POST', '/api/agents', { name: '또다른담당', role: '검토', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  const realProvider = imp.provider;
  imp.provider = 'no-such-provider';
  try {
    await t.api('POST', `/api/sessions/${d.sessionId}/messages`, { text: `@${q2.name} 이어서 검토해줘` });
    await t.waitFor(() => { const x = t.app.store.getSession(d.sessionId); return x.runs.length === 2 && x.runs[1].endedAt && !t.app.orch.ctx.has(d.sessionId); }, 20000, '실패한 메모 뒤에 내 요청이 끝남');
    const ds = t.app.store.getSession(d.sessionId);
    assert.equal(ds.runs[0].hold, null, '사람의 결정을 기다리지 않는다');
    assert.ok(ds.messages.some((m) => m.role === 'system' && /인수인계 메모를 쓰지 못했어/.test(m.text)));
    assert.equal(lastAgent(d.sessionId).agentId, q2.id);
    assert.ok(claudeTurn().includes('이어서 검토해줘') && !claudeTurn().includes('[인수인계 메모]'));
    const asks = ds.messages.filter((m) => m.handoffAsk).length;
    await say(d.sessionId, `@${q3.name} 너도 봐줘`);
    assert.equal(t.app.store.getSession(d.sessionId).messages.filter((m) => m.handoffAsk).length, asks, '같은 실패를 되풀이하지 않는다');
  } finally { imp.provider = realProvider; }
  await t.api('PUT', '/api/settings', { autoHandoff: false });
});

test('불러온 대화는 프로젝트 기억에 들어간다(나중에 켜도 다음 실행 때), 다른 세션에서 앞부분 결정을 찾는다', async () => {
  assert.notEqual(t.app.store.getSession(sid).importedFrom.remembered, true, '기억이 꺼져 있을 땐 넣지 않는다');
  await t.api('PUT', '/api/settings', { memory: true });
  await say(sid, `@${claudeA.name} 한 번 더 확인해줘`);
  await t.waitFor(() => t.app.store.getSession(sid).importedFrom.remembered === true, 20000, '다 넣은 뒤에 표시');
  const mem = await t.app.memory.of(proj);
  const hits = async () => (await mem.search('데이터베이스 감나무DB', { budget: 8000 })).hits;
  await t.waitFor(async () => (await hits()).some((c) => c.messageId === 'imp-0' && c.sessionId === sid), 10000, '불러온 맨 앞 대화가 기억에 들어감');
  await t.app.orch.settled();
  assert.equal((await hits()).filter((c) => c.sessionId === sid && c.text.includes(DECISION)).length, 1, '세션마다 한 번만 들어간다');

  const other = (await t.api('POST', '/api/sessions', { teamId: null, agentId: claudeB.id, cwd: proj })).json;
  await say(other.id, '데이터베이스는 뭐로 정했지? 감나무DB였나?');
  assert.ok(claudeTurn().includes(DECISION), '같은 폴더의 다른 세션에서 기억 조각으로 받는다');

  // 기억이 켜진 상태에서 불러오면 바로 들어간다
  const again = await importX2();
  await t.waitFor(() => t.app.store.getSession(again.sessionId).importedFrom.remembered === true, 20000, '바로 넣음');
  await t.app.orch.settled();
  assert.equal((await hits()).filter((c) => c.text.includes(DECISION)).length, 1, '같은 기록을 다시 불러와도 기억에 두 번 넣지 않는다');

  // 이 세션을 이어 가던 다른 AI(Claude)는 앞부분을 모르니 불러온 조각을 기억으로 받는다. 원래 Codex 에이전트는 이미 아니까 안 받는다
  await say(sid, `@${claudeA.name} 데이터베이스는 뭐로 정했지? 감나무DB였나?`);
  assert.ok(claudeTurn().includes(DECISION), '이어 가는 다른 AI는 받는다');
  const imp = t.app.store.getSession(sid).importedFrom.agentId;
  await say(sid, `@${t.app.store.get('agents', imp).name} 데이터베이스는 뭐로 정했지? 감나무DB였나?`);
  assert.ok(!codexLast().prompt.includes(DECISION), '원래 그 대화를 이어 가는 AI에게는 다시 넣지 않는다');

  // 기억이 켜져 있어도 인수인계 메모 요청에는 프로젝트 기억을 섞지 않는다
  const prov = await importX2();
  const hn = t.app.store.getSession(prov.sessionId).runs.length;
  assert.equal((await t.api('POST', `/api/sessions/${prov.sessionId}/handoff`, {})).status, 200);
  await t.waitFor(() => { const x = t.app.store.getSession(prov.sessionId); return x.runs.length > hn && x.runs.at(-1).endedAt && !t.app.orch.ctx.has(prov.sessionId); }, 15000, '메모 작성 끝');
  assert.match(codexLast().prompt, /인수인계 메모로 정리해 줘/);
  assert.doesNotMatch(codexLast().prompt, /\[프로젝트 기억\]/, '메모 요청에는 기억을 넣지 않는다');
  await t.api('PUT', '/api/settings', { memory: false });
});

test('이 기능 전에 불러온 세션: 원래 기록이 남아 있으면 대화 전체를 다시 읽어 건넨다', async () => {
  const a = await importX2();
  fs.rmSync(path.join(handoffDir(a.sessionId), 'import.jsonl'));
  const late = (await t.api('POST', '/api/agents', { name: '늦은담당', role: '검토', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  await say(a.sessionId, `@${late.name} 검토해줘`);
  assert.equal(fs.readFileSync(path.join(handoffDir(a.sessionId), 'import.jsonl'), 'utf8').trim().split('\n').length, PAIRS * 2);
  assert.ok(fs.readFileSync(path.join(handoffDir(a.sessionId), 'cloud', 'conversation.md'), 'utf8').includes(DECISION), '화면에 없는 맨 앞 대화까지 파일에 있다');
  assert.ok(claudeTurn().includes(DECISION));
  assert.equal(t.app.store.getSession(a.sessionId).importedFrom.checked, true, '한 번만 다시 읽는다');
});

test('파일을 못 읽는 AI(내 PC 모델): 앞 대화에서 고른 부분을 더 많이 직접 넣는다', async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'tiny' }] })); }
      got.push(body);
      res.setHeader('content-type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '내 PC 모델의 답이야.' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    t.app.store.settings.localServers = [{ name: '가짜 로컬', baseUrl: `http://127.0.0.1:${srv.address().port}/v1` }];
    const pc = (await t.api('POST', '/api/agents', { name: '로컬담당', role: '검토', provider: 'local', model: 'custom0::tiny', permission: 'plan', routing: 'manual' })).json;
    const a = await importX2();
    await say(a.sessionId, `@${pc.name} 결제 모듈 연동을 어떻게 하기로 했지?`);
    const body = got.at(-1);
    assert.ok(body.includes('감나무DB') && body.includes('살구페이'), '맨 처음과 관련 대화를 직접 받는다');
    assert.ok(!body.includes('conversation.md'), '읽지 못하는 파일 경로는 주지 않는다');
    assert.ok(notices(lastAgent(a.sessionId)).some((x) => /대화 전체 파일은 건네지 못했어/.test(x)));
    assert.equal(fs.existsSync(path.join(handoffDir(a.sessionId), 'local')), false, '쓰지 않을 파일은 만들지 않는다');

    // API 에이전트(최근 대화를 따로 배열로 받는다)도 인수인계 메모와 고른 부분을 받는다
    t.app.store.settings.apiProfiles = [{ id: 'fake-api', name: '가짜 API', baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: 'test-key', model: 'tiny' }];
    const api = (await t.api('POST', '/api/agents', { name: 'API담당', role: '검토', provider: 'openai', apiProfile: 'fake-api', model: 'tiny', permission: 'plan', routing: 'manual' })).json;
    const b = await importX2();
    const hn = t.app.store.getSession(b.sessionId).runs.length;
    await t.api('POST', `/api/sessions/${b.sessionId}/handoff`, {});
    await t.waitFor(() => { const x = t.app.store.getSession(b.sessionId); return x.runs.length > hn && x.runs.at(-1).endedAt && !t.app.orch.ctx.has(b.sessionId); }, 15000, '메모 작성 끝');
    const memo = t.app.store.getSession(b.sessionId).messages.find((m) => m.handoff);
    await say(b.sessionId, `@${api.name} 결제 모듈 연동을 어떻게 하기로 했지?`);
    const sent = JSON.parse(got.at(-1));
    const all = sent.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.match(all, /\[인수인계 메모\]/, 'API 에이전트도 메모를 받는다');
    assert.ok(all.includes(memo.text.slice(0, 20)) && all.includes('살구페이'), '메모 원문과 고른 부분');
    assert.ok(!all.includes('conversation.md'));
  } finally {
    t.app.store.settings.localServers = [];
    t.app.store.settings.apiProfiles = [];
    await new Promise((r) => srv.close(r));
  }
});

test('내 PC 모델하고만 나눈 말은 클라우드 AI용 대화 파일·고른 부분에 넣지 않는다', async () => {
  const s0 = (await t.api('POST', '/api/sessions', { teamId: null, agentId: claudeA.id })).json;
  const s = t.app.store.getSession(s0.id);
  const at = Date.now();
  s.messages.push({ id: 'lu', role: 'user', text: '로컬에게만 한 비밀 은행나무 정리', status: 'done', local: true, createdAt: at });
  s.messages.push({ id: 'la', role: 'agent', agentId: 'other', provider: 'local', runId: 'old', text: '로컬 모델의 답 살구나무 정리', status: 'done', createdAt: at + 1 });
  for (let i = 0; i < 30; i++) {
    s.messages.push({ id: `u${i}`, role: 'user', text: `일반 요청 ${i}번`, status: 'done', createdAt: at + 10 + i });
    s.messages.push({ id: `a${i}`, role: 'agent', agentId: 'other', provider: 'codex', runId: 'old', text: `일반 답 ${i}번`, status: 'done', createdAt: at + 10 + i, blocks: [{ kind: 'tool', name: 'Bash', input: { command: 'npm test --token=abc' } }] });
  }
  await say(s0.id, '은행나무 살구나무 정리해줘');
  const text = fs.readFileSync(path.join(handoffDir(s0.id), 'cloud', 'conversation.md'), 'utf8');
  assert.ok(text.includes('일반 요청 0번'));
  assert.ok(!/로컬에게만|로컬 모델의 답/.test(text), '내 PC 모델하고만 나눈 말은 파일에서 빠진다');
  assert.ok(!/로컬에게만|로컬 모델의 답/.test(claudeTurn()), '고른 부분에서도 빠진다');
  assert.match(text, /\(쓴 도구: Bash\)/, '쓴 도구는 이름만 적는다');
  assert.ok(!text.includes('token=abc'), '도구 입력은 싣지 않는다');

  // 내 PC 모델이 쓴 인수인계 메모는 클라우드 AI에게 주지 않는다. 내 PC 모델에게만 한 말로 지은 제목은 파일에 싣지 않는다
  s.messages.push({ id: 'ln', role: 'agent', agentId: 'other', provider: 'local', runId: 'old2', handoff: true, text: '로컬 메모 대추나무', status: 'done', createdAt: at + 200 });
  s.title = '비밀 제목 느티나무'; s.titleLocal = true;
  await say(s0.id, `@${claudeB.name} 이어서 정리해줘`);
  assert.ok(!/대추나무|느티나무/.test(claudeTurn()), '메모도 제목도 넘어가지 않는다');
  assert.ok(!/대추나무|느티나무/.test(fs.readFileSync(path.join(handoffDir(s0.id), 'cloud', 'conversation.md'), 'utf8')));

  // 세션을 지우면 건네려고 만든 파일도 지운다
  await t.api('DELETE', `/api/sessions/${s0.id}`);
  assert.equal(fs.existsSync(handoffDir(s0.id)), false);
});

test('대화를 비우면 불러온 대화도 더는 건네지 않는다', async () => {
  const a = await importX2();
  assert.ok(fs.existsSync(path.join(handoffDir(a.sessionId), 'import.jsonl')));
  assert.equal((await t.api('POST', `/api/sessions/${a.sessionId}/clear`, {})).status, 200);
  assert.equal(fs.existsSync(handoffDir(a.sessionId)), false, '적어 둔 원문과 대화 파일을 지운다');
  assert.equal(t.app.store.getSession(a.sessionId).importedFrom.cleared, true);
  const late = (await t.api('POST', '/api/agents', { name: '비운뒤담당', role: '검토', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  await say(a.sessionId, `@${late.name} 결제 모듈 연동을 어떻게 하기로 했지?`);
  const p = claudeTurn();
  assert.ok(!p.includes('감나무DB') && !p.includes('살구페이'), '비운 대화는 프롬프트에 없다');
  assert.doesNotMatch(p, /\[앞선 대화 전체\]|\[앞 대화에서 고른 부분\]/);
  assert.equal(fs.existsSync(path.join(handoffDir(a.sessionId), 'import.jsonl')), false, '원래 기록에서 다시 읽어 오지도 않는다');
});

test('짧은 세션은 아무것도 더 건네지 않는다(넣은 최근 대화로 충분할 때)', async () => {
  const s0 = (await t.api('POST', '/api/sessions', { teamId: null, agentId: claudeA.id })).json;
  await say(s0.id, '첫 요청');
  await say(s0.id, `@${claudeB.name} 이어서`);
  assert.doesNotMatch(claudeTurn(), /\[앞선 대화 전체\]|\[앞 대화에서 고른 부분\]/);
  assert.equal(fs.existsSync(handoffDir(s0.id)), false);
});

test('고르기와 파일 나누기(모듈)', () => {
  const pool = Array.from({ length: 50 }, (_, i) => ({ who: '사용자', text: i === 30 ? '로그인 화면 색상은 남색으로 정했다' : `잡담 ${i}` }));
  const picks = pickEarlier(pool, '로그인 화면 색상이 뭐였지?');
  assert.deepEqual(picks.map((p) => p.n), [1, 2, 31], '맨 처음 둘 + 관련된 것, 원래 순서로');
  assert.deepEqual(pickEarlier(pool, '').map((p) => p.n), [1, 2], '요청에 낱말이 없으면 맨 처음만');
  assert.deepEqual(pickEarlier([], '아무거나'), []);
  const long = pickEarlier([{ who: 'AI', text: 'x'.repeat(5000) }], 'x', { budget: 100, each: 50 });
  assert.equal(long[0].text.length, 51, '하나가 길면 잘라서 넣는다');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-split-'));
  try {
    const big = Array.from({ length: 5 }, (_, i) => ({ who: '사용자', text: `${i}번 ${'가'.repeat(700_000)}`, at: 0 })); // 하나에 약 2MB
    const w = writeConversation(dir, 's-big', big);
    assert.equal(w.count, 5);
    assert.ok(w.files.length >= 2, '크면 여러 파일로 나눈다');
    assert.deepEqual(w.files.map((f) => path.basename(f)).slice(0, 2), ['conversation.md', 'conversation-2.md']);
    const all = w.files.map((f) => fs.readFileSync(f, 'utf8')).join('');
    for (let i = 0; i < 5; i++) assert.ok(all.includes(`## ${i + 1}. 사용자`), `${i + 1}번 메시지가 빠지지 않는다`);
    assert.equal(writeConversation(dir, '../밖', big), null, '세션 id 모양이 아니면 쓰지 않는다');
    // 다시 쓰면 지난번에 나눠 쓴 파일이 남지 않는다
    const w2 = writeConversation(dir, 's-big', big.slice(0, 1));
    assert.deepEqual(fs.readdirSync(w2.dir), ['conversation.md']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
