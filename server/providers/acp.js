// ACP(Agent Client Protocol) 표준 에이전트 어댑터: ACP 를 지원하는 CLI 라면 무엇이든 같은 방식으로 붙인다
// (Gemini CLI --acp, Hermes acp, OpenCode, Goose, Qwen Code 등). 줄 단위 JSON-RPC 2.0 over stdio.
// 에이전트의 '모델' 칸 = 쓸 ACP 에이전트 id(설정 → API 키·로컬 모델 → ACP 에이전트)
import fs from 'node:fs';
import path from 'node:path';
import { spawnCli, onLines, parseJsonLine, killTree, makeHandle, mimeOf, resolveCommand } from './util.js';
import { VERSION } from '../config.js';
import { tr } from '../i18n.js';

// 많이 쓰는 ACP 에이전트(설정에서 버튼 하나로 추가). 명령이 PC 에 있어야 동작한다.
// 각 회사의 공식 CLI 가 직접 ACP 를 지원하는 것만 넣는다(Claude·Codex 는 앱이 공식 CLI 로 직접 연결하므로 제3자 어댑터는 넣지 않음)
export const ACP_PRESETS = [
  { id: 'gemini-acp', name: 'Gemini CLI (ACP)', command: 'gemini', args: ['--acp'] },
  { id: 'hermes-acp', name: 'Hermes Agent (ACP)', command: 'hermes', args: ['acp'] },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'] },
  { id: 'goose', name: 'Goose', command: 'goose', args: ['acp'] },
  { id: 'qwen-code', name: 'Qwen Code', command: 'qwen', args: ['--acp'] },
];

const listOf = (settings) => (settings?.acpAgents || []).filter((e) => e?.id && e?.command);
// 모델 칸에 고른 ACP 에이전트. 못 찾으면(이름이 바뀜 등) 엉뚱한 에이전트로 보내지 않고 null
const entryOf = (settings, id) => (id ? listOf(settings).find((e) => e.id === id) || null : listOf(settings)[0] || null);
const READ_KINDS = new Set(['read', 'search', 'think', 'fetch']);
const EDIT_KINDS = new Set(['read', 'search', 'think', 'fetch', 'edit', 'move']);

// 권한 단계 → 이 도구 요청을 허락할지
function allowed(permission, kind) {
  if (permission === 'full' || permission === 'auto') return true;
  if (permission === 'edit') return EDIT_KINDS.has(kind || 'other');
  return READ_KINDS.has(kind || 'other');
}

// ACP 도구 결과(content 배열) → 글
function toolText(content) {
  if (!Array.isArray(content)) return '';
  return content.map((c) => {
    if (c?.type === 'content') return c.content?.type === 'text' ? c.content.text : '';
    if (c?.type === 'diff') return `${c.path}\n${String(c.newText || '').slice(0, 1500)}`;
    if (c?.type === 'terminal') return `[terminal ${c.terminalId}]`;
    return '';
  }).filter(Boolean).join('\n');
}

// 링크·정션을 따라간 실제 경로. 아직 없는 파일은 가장 가까운 실제 부모 폴더 기준으로 만든다.
// 실제 경로를 못 찾았는데 그 자리에 무언가 있으면(끊긴 링크 등) 어디를 가리키는지 확정할 수 없으니 null
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); } catch { /* 아직 없거나 끊긴 링크 */ }
    try { fs.lstatSync(cur); return null; } catch { /* 정말 없음 → 부모로 */ }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    rest.push(path.basename(cur));
    cur = parent;
  }
}

const within = (base, target) => { const r = path.relative(base, target); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// 에이전트가 준 경로가 허용 폴더 안이면 실제 경로를, 아니면 null 을 돌려준다(읽기·쓰기는 돌려준 실제 경로로 한다)
// 1) 절대 경로만, '..' 조각이 든 경로는 거부: 리눅스·맥은 링크를 먼저 따라간 뒤 '..'를 처리해서 글자로 본 위치와 실제 위치가 다를 수 있다
// 2) 글자 기준으로 먼저 걸러, 폴더 밖(네트워크 경로 등)은 파일 시스템을 건드리기 전에 거부한다
// 3) 통과한 것만 링크·정션을 따라간 실제 경로로 다시 확인한다
function allowedPath(p, dirs) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) return null;
  const lex = path.resolve(p);
  // 허용 폴더는 글자 경로와 실제 경로를 둘 다 기준으로 삼는다(작업 폴더가 정션·링크여도 실제 경로로 보낸 요청을 받게)
  const bases = dirs.map((d) => path.resolve(d));
  const realBases = bases.map(realish).filter(Boolean);
  if (![...bases, ...realBases].some((b) => within(b, lex))) return null;
  const real = realish(lex);
  return real && realBases.some((b) => within(b, real)) ? real : null;
}

// 링크를 따라가지 않고 연다(리눅스·맥: 검사 뒤 그 자리가 링크로 바뀌어도 밖으로 나가지 않게. 윈도우는 해당 없음)
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
function readNoFollow(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
}
function writeNoFollow(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NOFOLLOW, 0o666);
  try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
}

export default {
  id: 'acp', get label() { return tr('ACP 에이전트'); }, get sub() { return tr('Agent Client Protocol 표준 · Gemini CLI·Hermes·OpenCode·Goose 등'); }, kind: 'cli', color: '#14b8a6',
  efforts: [],
  caps: { images: true, steer: false, resume: false, tools: true, connectors: true, permissions: true },

  async detect(settings) {
    const list = listOf(settings);
    if (!list.length) return { installed: false, note: tr('설정 → API 키·로컬 모델 → ACP 에이전트에서 추가해줘') };
    const ok = list.filter((e) => resolveCommand(e.command));
    return {
      installed: ok.length > 0, loggedIn: ok.length > 0,
      account: ok.map((e) => e.name).join(' · '),
      note: ok.length ? '' : tr('추가한 ACP 에이전트 명령을 찾을 수 없어. 설치했는지 확인해줘.'),
    };
  },

  async models(settings) {
    return listOf(settings).map((e) => {
      const ok = !!resolveCommand(e.command);
      return { id: e.id, label: ok ? e.name : `${e.name} (${tr('미설치')})`, tier: 'balanced', description: [e.command, ...(e.args || [])].join(' '), hidden: !ok };
    });
  },

  run(opts, emit) {
    const { agent, prompt, system, images = [], cwd, connectors = [], settings, addDirs = [] } = opts;
    const h = makeHandle();
    const entry = entryOf(settings, agent.model);
    if (!entry) {
      const error = agent.model && listOf(settings).length
        ? tr('ACP 에이전트 "{id}"를 찾을 수 없어. 에이전트 편집의 모델 칸에서 다시 골라줘.', { id: agent.model })
        : tr('쓸 ACP 에이전트가 없어. 설정 → API 키·로컬 모델 → ACP 에이전트에서 추가해줘.');
      h.resolve({ text: '', providerSessionId: null, error, stopped: false });
      return { done: h.done, stop() {} };
    }
    const child = spawnCli(entry.command, entry.args || [], { cwd, env: entry.env || {} });
    const pending = new Map(); // 우리가 보낸 요청 id → {resolve, reject}
    let nextId = 1, text = '', sessionId = null, stopped = false, finished = false, stderr = '';
    const send = (o) => { try { if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`); } catch { /* 이미 닫힘 */ } };
    const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ id, method, params }); });
    const reply = (id, result) => send({ id, result });
    const replyError = (id, code, message) => send({ id, error: { code, message } });

    const finish = (error) => {
      if (finished) return;
      finished = true;
      try { child.stdin.end(); } catch { /* 이미 닫힘 */ }
      // 1.5초 안에 스스로 안 끝나면 정리(이미 끝났으면 건드리지 않음: 그사이 다른 프로세스가 같은 번호를 쓸 수 있다)
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) killTree(child); }, 1500).unref?.();
      h.resolve({ text, providerSessionId: sessionId, error: stopped ? null : error, stopped });
    };

    // 에이전트가 보낸 알림·요청 처리
    const onUpdate = (u) => {
      switch (u?.sessionUpdate) {
        case 'agent_message_chunk':
          if (u.content?.type === 'text' && u.content.text) { text += u.content.text; emit({ type: 'text', text: u.content.text }); }
          break;
        case 'agent_thought_chunk':
          if (u.content?.type === 'text' && u.content.text) emit({ type: 'thinking', text: u.content.text });
          break;
        case 'tool_call':
          emit({ type: 'tool', id: u.toolCallId, name: u.title || u.name || u.kind || tr('도구'), input: u.rawInput, status: u.status === 'completed' ? 'done' : u.status === 'failed' ? 'error' : 'running', output: toolText(u.content) });
          break;
        case 'tool_call_update': {
          const status = u.status === 'completed' ? 'done' : u.status === 'failed' ? 'error' : u.status ? 'running' : undefined;
          emit({ type: 'tool', id: u.toolCallId, ...(u.title ? { name: u.title } : {}), ...(u.rawInput !== undefined ? { input: u.rawInput } : {}), ...(status ? { status } : {}), output: toolText(u.content) || (typeof u.rawOutput === 'string' ? u.rawOutput : u.rawOutput ? JSON.stringify(u.rawOutput) : '') });
          break;
        }
        case 'plan':
          if (Array.isArray(u.entries)) emit({ type: 'notice', text: `📋 ${u.entries.map((e) => `${e.status === 'completed' ? '✓' : '·'} ${e.content}`).join('  ')}`, quiet: true });
          break;
        default: break; // 명령 목록·모드 변경 등은 무시
      }
    };
    const dirs = [cwd, ...addDirs];
    const onRequest = (msg) => {
      const p = msg.params || {};
      switch (msg.method) {
        case 'session/request_permission': {
          const kind = p.toolCall?.kind;
          const ok = allowed(agent.permission, kind);
          const opt = (p.options || []).find((o) => (ok ? /^allow/.test(o.kind) : /^reject/.test(o.kind)) && /_once$/.test(o.kind))
            || (p.options || []).find((o) => (ok ? /^allow/ : /^reject/).test(o.kind));
          if (!ok) emit({ type: 'notice', text: tr('권한 설정에 따라 거부: {name}', { name: p.toolCall?.title || kind || tr('도구') }), quiet: true });
          if (opt) reply(msg.id, { outcome: { outcome: 'selected', optionId: opt.optionId } });
          else reply(msg.id, { outcome: { outcome: 'cancelled' } });
          return;
        }
        case 'fs/read_text_file': {
          const real = allowedPath(p.path, dirs);
          if (!real) return replyError(msg.id, -32602, tr('작업 폴더 밖의 파일은 읽을 수 없어.'));
          try {
            let content = readNoFollow(real);
            if (p.line || p.limit) { const lines = content.split('\n'); const from = Math.max(0, (p.line || 1) - 1); content = lines.slice(from, p.limit ? from + p.limit : undefined).join('\n'); }
            return reply(msg.id, { content });
          } catch (e) { return replyError(msg.id, -32603, e.message); }
        }
        case 'fs/write_text_file': {
          if (!['edit', 'auto', 'full'].includes(agent.permission)) return replyError(msg.id, -32602, tr('읽기 전용 권한이라 파일을 쓸 수 없어.'));
          const real = allowedPath(p.path, [cwd]);
          if (!real) return replyError(msg.id, -32602, tr('작업 폴더 밖에는 쓸 수 없어.'));
          try { writeNoFollow(real, String(p.content ?? '')); return reply(msg.id, null); } catch (e) { return replyError(msg.id, -32603, e.message); }
        }
        default:
          return replyError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    };

    onLines(child.stdout, (line) => {
      const msg = parseJsonLine(line);
      if (!msg || typeof msg !== 'object') return;
      if (msg.method && msg.id !== undefined) return onRequest(msg); // 권한 요청 등은 바로 답한다
      if (msg.method === 'session/update') return onUpdate(msg.params?.update);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const w = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) w.reject(new Error([msg.error.message, msg.error.data?.details || msg.error.data?.message].filter(Boolean).join(' — ') || JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdin.on('error', () => { /* 에이전트가 먼저 종료 */ });
    child.on('error', (e) => finish(e.message));
    child.on('close', (code) => {
      for (const w of pending.values()) w.reject(new Error(stderr.trim().split('\n').slice(-2).join(' ') || tr('종료 코드 {code}', { code })));
      pending.clear();
      finish(text || stopped ? null : (stderr.trim().split('\n').slice(-2).join(' ') || tr('ACP 에이전트가 응답 없이 끝났어 (종료 코드 {code})', { code })));
    });

    (async () => {
      const init = await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: ['edit', 'auto', 'full'].includes(agent.permission) }, terminal: false },
        clientInfo: { name: 'office-crew', version: VERSION },
      });
      const caps = init?.agentCapabilities || {};
      const mcpServers = connectors.filter((c) => c.type !== 'http' || caps.mcpCapabilities?.http).map((c) => (c.type === 'http'
        ? { type: 'http', name: c.key, url: c.url, headers: Object.entries(c.headers || {}).map(([name, value]) => ({ name, value })) }
        : { name: c.key, command: c.command, args: c.args || [], env: Object.entries(c.env || {}).map(([name, value]) => ({ name, value })) }));
      const sysCap = caps.sessionCapabilities?.systemPrompt;
      const created = await request('session/new', { cwd, mcpServers, ...(system && sysCap ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: system }] } } : {}) });
      sessionId = created?.sessionId || null;
      if (sessionId) emit({ type: 'session', id: sessionId });
      if (stopped) return;
      // 지침을 따로 받지 못하는 에이전트는 프롬프트 앞에 붙인다
      const full = system && !sysCap ? `<${tr('역할 지침')}>\n${system}\n</${tr('역할 지침')}>\n\n${prompt}` : prompt;
      const blocks = [{ type: 'text', text: full }];
      if (caps.promptCapabilities?.image) {
        for (const p of images) { try { blocks.push({ type: 'image', mimeType: mimeOf(p), data: fs.readFileSync(p).toString('base64') }); } catch { /* 없는 파일 */ } }
      } else if (images.length) blocks[0].text += `\n\n${tr('[첨부 이미지]')}\n${images.map((p) => `- ${p}`).join('\n')}`;
      const res = await request('session/prompt', { sessionId, prompt: blocks });
      const u = res?.usage || res?._meta?.usage;
      if (u) emit({ type: 'usage', input: u.inputTokens || u.input_tokens || 0, output: u.outputTokens || u.output_tokens || 0, cacheRead: u.cachedReadTokens || u.cacheReadTokens || 0, cacheWrite: u.cachedWriteTokens || 0, cost: 0 });
      const reason = res?.stopReason;
      finish(reason === 'refusal' ? tr('에이전트가 요청을 거절했어.') : null);
    })().catch((e) => finish(/auth/i.test(e.message) ? tr('ACP 에이전트 로그인이 필요해: {msg}', { msg: e.message }) : e.message));

    return {
      done: h.done,
      stop() {
        stopped = true;
        // 표준 취소: session/cancel 알림(권한 요청은 받는 즉시 답하므로 대기 중인 건 없다)
        if (sessionId) send({ method: 'session/cancel', params: { sessionId } });
        setTimeout(() => { if (!finished) { killTree(child); finish(null); } }, 2500).unref?.();
      },
    };
  },
};
