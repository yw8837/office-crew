// 테스트용 가짜 ACP 에이전트: 줄 단위 JSON-RPC 로 initialize → session/new → session/prompt 를 흉내 낸다(실제 AI 호출 없음)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const log = (o) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: 'acp', ...o })}\n`); };
const out = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waiting = new Map(); // 우리가 클라이언트에 보낸 요청 id → resolve
let nextId = 1000, cwd = '', cancelled = false;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); out({ id, method, params }); });
const update = (sessionId, u) => out({ method: 'session/update', params: { sessionId, update: u } });

async function prompt(id, p) {
  const text = p.prompt.find((b) => b.type === 'text')?.text || '';
  log({ method: 'session/prompt', text: text.slice(0, 3000), images: p.prompt.filter((b) => b.type === 'image').length });
  const sid = p.sessionId;
  update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '생각 중' } });
  update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: '파일 읽기', kind: 'read', status: 'pending', rawInput: { path: 'note.txt' } });
  const r1 = await ask('fs/read_text_file', { sessionId: sid, path: path.join(cwd, 'note.txt') });
  update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: r1.error ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: r1.error ? r1.error.message : r1.result.content } }] });
  const r2 = await ask('fs/read_text_file', { sessionId: sid, path: path.resolve(cwd, '..', 'outside-secret.txt') });
  log({ method: 'outside-read', error: !!r2.error });
  if (text.includes('ACPLINK')) {
    // 작업 폴더 안의 링크(정션)를 따라 밖의 파일 읽기·쓰기 시도
    const r4 = await ask('fs/read_text_file', { sessionId: sid, path: path.join(cwd, 'link', 'outside-secret.txt') });
    const r5 = await ask('fs/write_text_file', { sessionId: sid, path: path.join(cwd, 'link', 'pwned.txt'), content: 'x' });
    // 리눅스·맥에선 커널이 링크를 먼저 따라간 뒤 '..'를 처리하므로, '..'가 든 경로는 글자로는 안이어도 밖일 수 있다
    const r6 = await ask('fs/read_text_file', { sessionId: sid, path: cwd + path.sep + 'link' + path.sep + '..' + path.sep + 'note.txt' });
    log({ method: 'link', readError: !!r4.error, writeError: !!r5.error, dotdotError: !!r6.error });
    // 끊긴 링크(밖의 아직 없는 파일·폴더를 가리킴)에 쓰기 시도
    const r7 = await ask('fs/write_text_file', { sessionId: sid, path: path.join(cwd, 'evil'), content: 'x' });
    const r8 = await ask('fs/write_text_file', { sessionId: sid, path: path.join(cwd, 'evil', 'x.txt'), content: 'x' });
    log({ method: 'dangling', write1Error: !!r7.error, write2Error: !!r8.error, write1Code: r7.error?.code ?? null, write2Code: r8.error?.code ?? null });
  }
  if (text.includes('ACPREAL')) {
    // 작업 폴더가 정션·링크일 때, 실제 경로로 읽기
    const r9 = await ask('fs/read_text_file', { sessionId: sid, path: path.join(fs.realpathSync(cwd), 'note.txt') });
    log({ method: 'realpath-read', error: !!r9.error, content: r9.result?.content || '' });
  }
  const r3 = await ask('session/request_permission', {
    sessionId: sid, toolCall: { toolCallId: 't2', title: '파일 고치기', kind: 'edit' },
    options: [{ optionId: 'a1', name: '허용', kind: 'allow_once' }, { optionId: 'r1', name: '거부', kind: 'reject_once' }],
  });
  log({ method: 'permission', outcome: r3.result?.outcome });
  if (text.includes('ACPSLOW')) {
    for (let i = 0; i < 40 && !cancelled; i++) await sleep(100);
    if (cancelled) { out({ id, result: { stopReason: 'cancelled' } }); return; }
  }
  for (const ch of ['ACP 답: ', '완료']) { update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ch } }); await sleep(10); }
  out({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 3 } } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); w(m); return; }
  switch (m.method) {
    case 'initialize':
      log({ method: 'initialize', params: m.params });
      out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: true }, sessionCapabilities: process.env.FAKE_ACP_SYS ? { systemPrompt: {} } : {} }, authMethods: [] } });
      break;
    case 'session/new':
      cwd = m.params.cwd;
      log({ method: 'session/new', cwd, mcpServers: m.params.mcpServers, systemPrompt: m.params.systemPrompt || null });
      out({ id: m.id, result: { sessionId: 'acp-sess-1' } });
      break;
    case 'session/prompt': prompt(m.id, m.params); break;
    case 'session/cancel': cancelled = true; log({ method: 'session/cancel' }); break;
    default: if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
rl.on('close', () => process.exit(0));
