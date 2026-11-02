// 세션 불러오기(importer) 테스트: 임시 폴더에 실제 형식을 흉내 낸 가짜 Claude·Codex 기록을 만들어 검증한다
// (실제 사용자 기록 복사·실제 CLI 실행 없음)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { listImportable, readTranscript } from '../server/importer.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-import-'));
const home = path.join(root, 'home');
const claudeCfg = path.join(root, 'claude-cfg');
const codexHome = path.join(root, 'codex-home');
const projA = path.join(root, 'work', 'proj-a'); // 실제로 있는 폴더
const gone = path.join(root, 'work', 'gone'); // 없는 폴더
const ENV = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
const saved = {};

const C1 = '11111111-1111-4111-8111-111111111111'; // Claude 일반 세션
const C2 = '33333333-3333-4333-8333-333333333333'; // Claude 캐시 갱신용
const CBIG = '22222222-2222-4222-8222-222222222222'; // Claude 큰 세션
const CEMPTY = '44444444-4444-4444-8444-444444444444'; // 대화 없는 기록
const X1 = '01a00000-0000-7000-8000-000000000001'; // Codex 새 형식
const X2 = '01a00000-0000-7000-8000-000000000002'; // Codex 옛 형식(종류 표시 없음)
const XSUB = '01a00000-0000-7000-8000-000000000003'; // Codex 서브에이전트
const XARC = '01a00000-0000-7000-8000-000000000004'; // Codex 보관함
const XZST = '01a00000-0000-7000-8000-000000000005'; // Codex 압축본
const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';

const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-'); // Claude 프로젝트 폴더 이름 규칙
const jl = (rows) => `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`;
const iso = (sec) => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + sec * 1000).toISOString();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const claudeFile = (id, base = claudeCfg) => path.join(base, 'projects', enc(projA), `${id}.jsonl`);
const codexFile = (id, day = '02', base = codexHome) => path.join(base, 'sessions', '2026', '10', day, `rollout-2026-10-${day}T10-00-00-${id}.jsonl`);

// Claude 줄: 실제 기록처럼 공통 필드(parentUuid·cwd·sessionId·timestamp…)를 붙인다
const cl = (sid, sec, extra) => ({ parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: projA, sessionId: sid, version: '2.1.300', gitBranch: 'main', uuid: `u${sec}`, timestamp: iso(sec), ...extra });
const asst = (sid, sec, model, content) => cl(sid, sec, { type: 'assistant', message: { model, id: `msg${sec}`, type: 'message', role: 'assistant', content, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
const usr = (sid, sec, content, extra = {}) => cl(sid, sec, { type: 'user', message: { role: 'user', content }, ...extra });
// Codex 줄
const cx = (sec, type, payload) => ({ timestamp: iso(sec), ordinal: sec, type, payload });

function makeClaude() {
  const s = C1;
  write(claudeFile(s), jl([
    { type: 'file-history-snapshot', messageId: 'x', snapshot: { trackedFileBackups: {} }, isSnapshotUpdate: false },
    usr(s, 1, '첫 질문이야', { promptId: 'p1', permissionMode: 'default' }),
    usr(s, 2, [{ type: 'text', text: '자동 삽입된 메타 글' }], { isMeta: true }),
    asst(s, 3, 'claude-opus-5-5', [{ type: 'thinking', thinking: '속생각', signature: 'sig' }]),
    asst(s, 4, 'claude-opus-5-5', [{ type: 'text', text: '답변 하나' }]),
    asst(s, 5, 'claude-opus-5-5', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls', description: '목록 보기' } }]),
    usr(s, 6, [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'x'.repeat(5000), is_error: false }], { toolUseResult: { stdout: '' } }),
    asst(s, 7, 'claude-opus-5-5', [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'a.txt' } }]),
    usr(s, 8, [{ tool_use_id: 'toolu_2', type: 'tool_result', content: [{ type: 'text', text: '없는 파일' }], is_error: true }]),
    asst(s, 9, 'claude-opus-5-5', [{ type: 'text', text: '답변 둘' }]),
    '{"type":"user","message":{깨진 줄',
    'garbage',
    usr(s, 10, '<local-command-caveat>Caveat: 로컬 명령</local-command-caveat>', { isMeta: true }),
    usr(s, 11, '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
    usr(s, 12, '<local-command-stdout>Set model</local-command-stdout>'),
    usr(s, 13, [{ type: 'text', text: '<system-reminder>숨은 알림</system-reminder>' }]),
    usr(s, 14, '<task-notification>백그라운드 작업 끝</task-notification>'),
    usr(s, 15, '서브에이전트 지시', { isSidechain: true }),
    usr(s, 16, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }, { type: 'text', text: '이 그림 봐줘' }]),
    asst(s, 17, 'claude-sonnet-5-5', [{ type: 'text', text: '그림 봤어' }]),
    usr(s, 18, [{ type: 'text', text: '[Request interrupted by user]' }]),
    { type: 'custom-title', customTitle: '내가 붙인 제목', sessionId: s },
    { type: 'last-prompt', lastPrompt: '이 그림 봐줘', leafUuid: 'u17', sessionId: s },
  ]));
  // 서브에이전트 기록(목록에서 빠져야 함)
  write(path.join(claudeCfg, 'projects', enc(projA), s, 'subagents', 'agent-a1b2.jsonl'), jl([usr(s, 20, '서브 작업'), asst(s, 21, 'claude-haiku-5-5', [{ type: 'text', text: '서브 답' }])]));
  write(path.join(claudeCfg, 'projects', enc(projA), 'agent-oldstyle.jsonl'), jl([usr(s, 22, '옛 서브 작업')]));
  // 대화가 하나도 없는 기록(목록에서 빠져야 함)
  write(claudeFile(CEMPTY), jl([{ type: 'file-history-snapshot', messageId: 'y', snapshot: {}, isSnapshotUpdate: false }]));
  // 캐시 갱신 확인용
  write(claudeFile(C2), jl([usr(C2, 30, '캐시 시험 질문'), asst(C2, 31, 'claude-opus-5-5', [{ type: 'text', text: '캐시 시험 답' }])]));

  // 큰 세션: 3000턴 + 중간에 2MB 이미지 줄(청크 경계를 넘는 긴 줄)
  const rows = [];
  const pad = '가'.repeat(120);
  for (let i = 0; i < 3000; i++) {
    if (i === 1500) rows.push(usr(CBIG, 1000 + i * 2, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2 * 1024 * 1024) } }, { type: 'text', text: `질문 ${i}` }]));
    else rows.push(usr(CBIG, 1000 + i * 2, `질문 ${i}`));
    rows.push(asst(CBIG, 1001 + i * 2, 'claude-opus-5-5', [{ type: 'text', text: `답변 ${i} ${pad}` }]));
  }
  write(claudeFile(CBIG), jl(rows));
}

function makeCodex() {
  const meta = (id, sec, extra = {}) => cx(sec, 'session_meta', {
    session_id: id, id, timestamp: iso(sec), cwd: gone, originator: 'codex_exec', cli_version: '0.166.0', source: 'exec', thread_source: 'user',
    model_provider: 'openai', base_instructions: { text: `기본 지침 ${'z'.repeat(40000)}` }, ...extra,
  });
  const kinds = (...k) => ({ turn_id: 't1', create_time: 1, content_item_kinds: k });
  write(codexFile(X1), jl([
    meta(X1, 100),
    cx(101, 'turn_context', { turn_id: 't1', cwd: gone, model: 'gpt-6.1-sol', effort: 'high' }),
    cx(102, 'response_item', { type: 'message', id: 'm1', role: 'developer', content: [{ type: 'input_text', text: '<permissions>권한 지침</permissions>' }], internal_chat_message_metadata_passthrough: kinds('permissions.instructions') }),
    cx(103, 'response_item', { type: 'message', id: 'm2', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for X\n\n지침' }, { type: 'input_text', text: '<environment_context>\n<cwd>x</cwd>\n</environment_context>' }], internal_chat_message_metadata_passthrough: kinds('agents_md.instructions', 'environments.environment_context') }),
    cx(104, 'response_item', { type: 'message', id: 'm3', role: 'user', content: [{ type: 'input_text', text: '코덱스 첫 질문' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }], internal_chat_message_metadata_passthrough: kinds('user.text', 'user.image') }),
    cx(105, 'event_msg', { type: 'user_message', message: '코덱스 첫 질문', images: [], local_images: [] }),
    cx(106, 'response_item', { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'enc' }),
    cx(107, 'response_item', { type: 'message', id: 'm4', role: 'assistant', content: [{ type: 'output_text', text: '살펴볼게', annotations: [] }], phase: 'commentary' }),
    cx(108, 'response_item', { type: 'function_call', id: 'f1', name: 'exec', namespace: 'mcp__node_repl', arguments: '{"code":"1+1"}', call_id: 'call_1', status: 'completed' }),
    cx(109, 'response_item', { type: 'function_call_output', id: 'o1', call_id: 'call_1', output: JSON.stringify({ output: 'boom', metadata: { exit_code: 1 } }) }),
    cx(110, 'response_item', { type: 'custom_tool_call', id: 'c1', name: 'apply_patch', input: '*** Begin Patch', call_id: 'call_2', status: 'completed' }),
    cx(111, 'response_item', { type: 'custom_tool_call_output', id: 'o2', call_id: 'call_2', output: [{ type: 'input_text', text: '패치 완료' }] }),
    cx(112, 'event_msg', { type: 'token_count', info: {}, rate_limits: null }),
    cx(113, 'response_item', { type: 'message', id: 'm5', role: 'assistant', content: [{ type: 'output_text', text: '끝났어' }], phase: 'final_answer' }),
    cx(114, 'event_msg', { type: 'agent_message', message: '끝났어', phase: 'final_answer' }),
    cx(115, 'response_item', { type: 'agent_message', id: 'am', author: 'a', recipient: 'b', content: [{ type: 'input_text', text: '에이전트끼리 대화' }] }),
    cx(116, 'response_item', { type: 'message', id: 'm6', role: 'user', content: [{ type: 'input_text', text: '두 번째 질문' }], internal_chat_message_metadata_passthrough: kinds('user.text') }),
    cx(117, 'response_item', { type: 'message', id: 'm7', role: 'assistant', content: [{ type: 'output_text', text: '두 번째 답' }] }),
  ]));

  // 옛 형식: 종류 표시 없음, 앞쪽 큰 지침(첫 사용자 글이 64KB 뒤), 끝쪽 긴 집계 줄(마지막 글이 뒤 64KB 밖)
  const old = (sec, type, payload) => ({ timestamp: iso(sec), type, payload });
  const pads = Array.from({ length: 80 }, (_, i) => old(240 + i, 'event_msg', { type: 'token_count', info: { note: 'p'.repeat(1000) } }));
  write(codexFile(X2, '01'), jl([
    old(200, 'session_meta', { id: X2, timestamp: iso(200), cwd: projA, originator: 'codex_cli_rs', cli_version: '0.148.0', source: 'mcp' }),
    old(201, 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'd'.repeat(100000) }] }),
    old(202, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for X\n\n<INSTRUCTIONS>\n지침\n</INSTRUCTIONS>' }] }),
    old(203, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>x</cwd>\n</environment_context>' }] }),
    old(204, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<역할 지침>\n너는 조사원\n</역할 지침>\n\n옛날 형식 질문' }] }),
    old(205, 'event_msg', { type: 'user_message', message: '옛날 형식 질문', images: [] }),
    old(206, 'response_item', { type: 'local_shell_call', call_id: 'ls1', status: 'completed', action: { type: 'exec', command: ['bash', '-lc', 'ls'] } }),
    old(207, 'response_item', { type: 'function_call_output', call_id: 'ls1', output: JSON.stringify({ output: 'a.txt', metadata: { exit_code: 0 } }) }),
    old(208, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '옛날 형식 답' }] }),
    ...pads,
  ]));

  // 서브에이전트 스레드(목록에서 빠져야 함)
  write(codexFile(XSUB), jl([
    meta(XSUB, 300, { session_id: X1, source: { subagent: { other: 'worker' } }, thread_source: 'subagent', parent_thread_id: X1 }),
    cx(301, 'response_item', { type: 'message', id: 's1', role: 'user', content: [{ type: 'input_text', text: '서브 지시' }] }),
    cx(302, 'response_item', { type: 'message', id: 's2', role: 'assistant', content: [{ type: 'output_text', text: '서브 결과' }] }),
  ]));

  // 보관함
  write(path.join(codexHome, 'archived_sessions', `rollout-2026-09-01T10-00-00-${XARC}.jsonl`), jl([
    meta(XARC, 50),
    cx(51, 'response_item', { type: 'message', id: 'a1', role: 'user', content: [{ type: 'input_text', text: '보관된 질문' }] }),
    cx(52, 'response_item', { type: 'message', id: 'a2', role: 'assistant', content: [{ type: 'output_text', text: '보관된 답' }] }),
  ]));

  // 압축본(.jsonl.zst) — 이 Node가 zstd 를 지원할 때만
  if (HAS_ZSTD) {
    const text = jl([
      meta(XZST, 400),
      cx(401, 'response_item', { type: 'message', id: 'z1', role: 'user', content: [{ type: 'input_text', text: '압축된 질문' }] }),
      cx(402, 'response_item', { type: 'message', id: 'z2', role: 'assistant', content: [{ type: 'output_text', text: '압축된 답' }] }),
    ]);
    write(`${codexFile(XZST, '03')}.zst`, zlib.zstdCompressSync(Buffer.from(text)));
  }

  // 스레드 이름 인덱스(같은 id 가 여러 번이면 마지막 것), 깨진 줄 포함
  write(path.join(codexHome, 'session_index.jsonl'), jl([
    { id: X1, thread_name: '옛 이름', updated_at: iso(110) },
    'broken line',
    { id: X1, thread_name: '코덱스 스레드 이름', updated_at: iso(117) },
  ]));
}

before(() => {
  for (const k of ENV) saved[k] = process.env[k];
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = claudeCfg;
  process.env.CODEX_HOME = codexHome;
  makeClaude();
  makeCodex();
});

after(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 윈도우 파일 잠금 무시 */ }
});

const byId = (list, id) => list.find((x) => x.id === id);

test('목록: 본 세션만(서브에이전트·빈 기록 제외), 최신순, 제목·폴더·보관 표시', async () => {
  const list = await listImportable();
  const ids = list.map((x) => x.id).sort();
  const want = [C1, C2, CBIG, X1, X2, XARC, ...(HAS_ZSTD ? [XZST] : [])].sort();
  assert.deepEqual(ids, want);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].updatedAt >= list[i].updatedAt, '최신순');

  const c1 = byId(list, C1);
  assert.equal(c1.source, 'claude');
  assert.equal(c1.title, '내가 붙인 제목');
  assert.equal(c1.cwd, projA);
  assert.equal(c1.cwdExists, true);
  assert.equal(c1.messageCount, 5);
  assert.equal(c1.messageCountApprox, false);
  assert.equal(c1.preview, '그림 봤어');
  assert.equal(c1.updatedAt, Date.parse(iso(18)));
  assert.ok(c1.sizeBytes > 0);

  const x1 = byId(list, X1);
  assert.equal(x1.source, 'codex');
  assert.equal(x1.title, '코덱스 스레드 이름'); // 인덱스의 마지막 이름
  assert.equal(x1.cwd, gone);
  assert.equal(x1.cwdExists, false);
  assert.equal(x1.preview, '두 번째 답');

  // 옛 형식: 첫 사용자 글이 앞 64KB 밖, 마지막 글이 뒤 64KB 밖이어도 찾는다(역할 지침은 뺌)
  const x2 = byId(list, X2);
  assert.equal(x2.title, '옛날 형식 질문');
  assert.equal(x2.preview, '옛날 형식 답');
  assert.equal(x2.cwdExists, true);

  assert.equal(byId(list, XARC).archived, true);
  assert.equal(byId(list, C1).archived, false);
  if (HAS_ZSTD) assert.equal(byId(list, XZST).title, '압축된 질문');

  const big = byId(list, CBIG);
  assert.equal(big.messageCountApprox, true); // 앞·뒤만 읽어서 '최소 개수'
  assert.ok(big.messageCount > 0 && big.messageCount < 6000);
  assert.equal(big.preview.startsWith('답변 2999'), true);
});

test('목록: 검색어(제목·폴더·내용)와 개수 제한', async () => {
  assert.deepEqual((await listImportable({ query: '스레드 이름' })).map((x) => x.id), [X1]);
  assert.deepEqual((await listImportable({ query: '그림   봤어' })).map((x) => x.id), [C1]); // 여러 단어
  const inA = (await listImportable({ query: 'proj-a' })).map((x) => x.id).sort();
  assert.deepEqual(inA, [C1, C2, CBIG, X2].sort());
  assert.equal((await listImportable({ query: '절대없는검색어' })).length, 0);
  assert.equal((await listImportable({ limit: 2 })).length, 2);
});

test('읽기(Claude): 순서·자동 삽입 제외·도구 블록·이미지 표시·깨진 줄 무시', async () => {
  const r = await readTranscript('claude', C1);
  assert.equal(r.source, 'claude');
  assert.equal(r.id, C1);
  assert.equal(r.cwd, projA);
  assert.equal(r.cwdExists, true);
  assert.equal(r.title, '내가 붙인 제목');
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(r.total, 5);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.messages.map((m) => [m.role, m.text]), [
    ['user', '첫 질문이야'],
    ['agent', '답변 하나\n\n답변 둘'],
    ['user', '/model opus'],
    ['user', '[이미지]\n이 그림 봐줘'],
    ['agent', '그림 봤어'],
  ]);
  const [, a1] = r.messages;
  assert.equal(a1.blocks.length, 2);
  const [bash, read] = a1.blocks;
  assert.deepEqual([bash.kind, bash.name, bash.status], ['tool', 'Bash', 'done']);
  assert.deepEqual(bash.input, { command: 'ls', description: '목록 보기' });
  assert.equal(bash.output.length, 2001); // 2000자 + '…'
  assert.ok(bash.output.endsWith('…'));
  assert.deepEqual([read.name, read.status, read.output], ['Read', 'error', '없는 파일']);
  assert.equal(a1.model, 'claude-opus-5-5');
  assert.equal(a1.provider, 'claude');
  assert.equal(a1.createdAt, Date.parse(iso(4)));
  for (const m of r.messages) {
    assert.equal(m.status, 'done');
    assert.ok(Array.isArray(m.blocks) && Array.isArray(m.attachments));
    assert.equal(m.id, undefined); // id 는 서버가 붙인다
  }
  const all = JSON.stringify(r.messages);
  for (const hidden of ['자동 삽입된 메타 글', '숨은 알림', '백그라운드 작업 끝', '서브에이전트 지시', 'Set model', '속생각', 'Request interrupted']) assert.ok(!all.includes(hidden), hidden);
});

test('읽기(Codex 새 형식): 지침·환경 정보·중복 이벤트·에이전트 간 대화 제외, 도구 오류 표시', async () => {
  const r = await readTranscript('codex', X1);
  assert.equal(r.title, '코덱스 스레드 이름');
  assert.equal(r.cwd, gone);
  assert.equal(r.cwdExists, false);
  assert.equal(r.model, 'gpt-6.1-sol');
  assert.deepEqual(r.messages.map((m) => [m.role, m.text]), [
    ['user', '코덱스 첫 질문\n[이미지]'],
    ['agent', '살펴볼게\n\n끝났어'],
    ['user', '두 번째 질문'],
    ['agent', '두 번째 답'],
  ]);
  const [fn, patch] = r.messages[1].blocks;
  assert.deepEqual([fn.name, fn.status, fn.output], ['mcp__node_repl.exec', 'error', 'boom']);
  assert.deepEqual(fn.input, { code: '1+1' });
  assert.deepEqual([patch.name, patch.status, patch.output, patch.input], ['apply_patch', 'done', '패치 완료', '*** Begin Patch']);
  const all = JSON.stringify(r.messages);
  for (const hidden of ['AGENTS.md', 'environment_context', '권한 지침', '에이전트끼리 대화', 'enc']) assert.ok(!all.includes(hidden), hidden);
});

test('읽기(Codex 옛 형식·보관함·압축본)', async () => {
  const r = await readTranscript('codex', X2);
  assert.deepEqual(r.messages.map((m) => [m.role, m.text]), [['user', '옛날 형식 질문'], ['agent', '옛날 형식 답']]);
  const [sh] = r.messages[1].blocks;
  assert.deepEqual([sh.name, sh.input, sh.output, sh.status], ['명령 실행', { command: 'bash -lc ls' }, 'a.txt', 'done']);
  assert.equal(r.title, '옛날 형식 질문');

  const a = await readTranscript('codex', XARC);
  assert.deepEqual(a.messages.map((m) => m.text), ['보관된 질문', '보관된 답']);
  if (HAS_ZSTD) {
    const z = await readTranscript('codex', XZST);
    assert.deepEqual(z.messages.map((m) => m.text), ['압축된 질문', '압축된 답']);
  }
});

test('읽기(큰 파일): 스트림으로 끝까지 읽고 마지막 maxMessages개만, 긴 이미지 줄 처리, 목록 수 갱신', async () => {
  const r = await readTranscript('claude', CBIG, { maxMessages: 50 });
  assert.equal(r.total, 6000);
  assert.equal(r.truncated, true);
  assert.equal(r.messages.length, 50);
  assert.equal(r.messages[0].text, '질문 2975');
  assert.equal(r.messages[49].role, 'agent');
  assert.ok(r.messages[49].text.startsWith('답변 2999'));
  r.messages.forEach((m, i) => assert.equal(m.role, i % 2 ? 'agent' : 'user'));

  const full = await readTranscript('claude', CBIG, { maxMessages: 10000 });
  assert.equal(full.messages.length, 6000);
  assert.equal(full.truncated, false);
  assert.equal(full.messages[3000].text, '[이미지]\n질문 1500'); // 2MB base64 줄도 해석됨(데이터는 버림)
  assert.ok(!JSON.stringify(full.messages[3000]).includes('AAAA'));

  const big = byId(await listImportable(), CBIG);
  assert.equal(big.messageCount, 6000); // 전체를 읽은 뒤엔 정확한 수
  assert.equal(big.messageCountApprox, false);
});

test('보안: 경로 조작·이상한 id·모르는 출처는 거부, 목록에 없는 기록은 못 찾음', async () => {
  const bad = ['../x', '..', '.', 'a/b', 'a\\b', '', ' ', '%2e%2e', 'C:\\Windows', `${enc(projA)}/${C1}`, `../${C1}`, `${C1}.jsonl`, 'x'.repeat(200), null, 123, {}];
  for (const id of bad) await assert.rejects(readTranscript('claude', id), (e) => e.status === 400, String(id));
  await assert.rejects(readTranscript('gemini', C1), (e) => e.status === 400);
  await assert.rejects(readTranscript('../claude', C1), (e) => e.status === 400);
  await assert.rejects(readTranscript('claude', 'ffffffff-ffff-4fff-8fff-ffffffffffff'), (e) => e.status === 404);
  await assert.rejects(readTranscript('codex', XSUB), (e) => e.status === 404); // 서브에이전트는 목록에 없음
  await assert.rejects(readTranscript('claude', 'agent-oldstyle'), (e) => e.status === 404);
  await assert.rejects(readTranscript('codex', C1), (e) => e.status === 404); // 출처가 다르면 없음
});

test('캐시: 파일이 바뀌면(수정 시각·크기) 다시 읽는다', async () => {
  assert.equal(byId(await listImportable(), C2).title, '캐시 시험 질문');
  fs.appendFileSync(claudeFile(C2), jl([{ type: 'custom-title', customTitle: '바뀐 제목', sessionId: C2 }]));
  assert.equal(byId(await listImportable(), C2).title, '바뀐 제목');
});

test('기본 위치: CLAUDE_CONFIG_DIR·CODEX_HOME 이 없으면 홈 폴더의 .claude·.codex', async () => {
  const home2 = path.join(root, 'home2');
  const C3 = '55555555-5555-4555-8555-555555555555';
  const X3 = '01a00000-0000-7000-8000-000000000006';
  write(claudeFile(C3, path.join(home2, '.claude')), jl([usr(C3, 500, '홈 폴더 질문')]));
  write(codexFile(X3, '04', path.join(home2, '.codex')), jl([
    cx(600, 'session_meta', { id: X3, timestamp: iso(600), cwd: projA, source: 'exec', thread_source: 'user' }),
    cx(601, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '홈 코덱스 질문' }] }),
  ]));
  const keep = { ...process.env };
  try {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    process.env.HOME = home2;
    process.env.USERPROFILE = home2;
    const list = await listImportable();
    assert.deepEqual(list.map((x) => x.id).sort(), [C3, X3].sort());
    assert.equal((await readTranscript('claude', C3)).messages[0].text, '홈 폴더 질문');
  } finally {
    for (const k of ENV) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
  }
});
