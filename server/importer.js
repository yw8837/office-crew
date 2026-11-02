// 세션 불러오기: Claude Code·Codex CLI가 남긴 대화 기록(jsonl)을 찾아 목록을 만들고, 대화를 앱 메시지 형태로 읽는다.
// 원래 기록 파일은 읽기만 한다(쓰기·이동·삭제 없음). 런타임 의존성 없음(node 기본 모듈만).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HEAD = 64 * 1024; // 목록용: 파일 앞부분만 읽는다
const TAIL = 64 * 1024; // 목록용: 파일 뒷부분만 읽는다
// 앞·뒤 64KB에서 제목(첫 사용자 글)이나 미리보기를 못 찾은 파일만 여기까지 더 읽는다.
// Codex 기록은 앞부분이 지침(약 260KB)으로 차 있어서 필요. 0 으로 두면 64KB만 읽는다.
const EXTEND = 512 * 1024;
const FIRST_LINE_MAX = 1024 * 1024; // 첫 줄(메타)이 64KB보다 길면 여기까지 더 읽는다
const MAX_LINE = 64 * 1024 * 1024; // 이보다 긴 줄은 건너뜀(메모리 보호)
const BIG_LINE = 256 * 1024; // 이보다 긴 줄은 base64 덩어리(이미지)를 먼저 걷어내고 해석
const PEEK = 320; // 줄 종류 판별용으로 보는 앞부분 길이
const OUT_MAX = 2000; // 도구 출력 최대 글자
const IN_MAX = 2000; // 도구 입력 값 하나당 최대 글자
const TEXT_MAX = 200_000; // 메시지 글 최대 글자(화면 표시용. 실제 맥락은 CLI 이어하기로 유지됨)
const BLOCKS_MAX = 500; // 메시지 하나에 담는 도구 블록 최대 수(넘으면 오래된 것부터 뺌)
const PREVIEW_MAX = 120;
const TITLE_MAX = 100;
const CONCURRENCY = 16;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/; // 경로 문자(. / \ : %)가 없는 세션 id만 받는다
const UUID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const HAS_ZSTD = typeof zlib.createZstdDecompress === 'function'; // .zst 압축 기록은 Node 22.15+ 에서만 읽는다

const CLAUDE_TOP = new Set(['summary', 'custom-title', 'ai-title', 'last-prompt', 'user', 'assistant']);
const CODEX_SKIP_ITEM = new Set(['reasoning', 'agent_message', 'additional_tools', 'compaction', 'ghost_snapshot']);
const CODEX_LEGACY_ITEM = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'local_shell_call_output', 'web_search_call']);

const fail = (status, message) => Object.assign(new Error(message), { status });
const claudeRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const codexRoot = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function safeIsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// 문자열이 JSON 모양이면 풀어서, 아니면 그대로
function parseMaybe(v) {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v;
  try { return JSON.parse(v); } catch { return v; }
}

// 도구 입력이 크면(파일 통째 쓰기 등) 값마다 잘라서 세션 파일이 부풀지 않게
function clipInput(v) {
  if (v == null || typeof v !== 'object') return typeof v === 'string' ? clip(v, IN_MAX) : v;
  const s = JSON.stringify(v) ?? '';
  if (s.length <= IN_MAX) return v;
  if (Array.isArray(v)) return clip(s, IN_MAX);
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string') out[k] = clip(x, IN_MAX);
    else { const j = JSON.stringify(x) ?? ''; out[k] = j.length > IN_MAX ? clip(j, IN_MAX) : x; }
  }
  return out;
}

// 여러 형식의 내용 블록 → 글. 이미지 같은 바이너리는 표시만 남긴다
function blockText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => {
      if (typeof x === 'string') return x;
      if (['text', 'input_text', 'output_text'].includes(x?.type)) return x.text ?? '';
      if (x?.type === 'image' || x?.type === 'input_image') return '[이미지]';
      return `[${x?.type || '첨부'}]`;
    }).join('\n');
  }
  if (c && typeof c === 'object') return typeof c.content === 'string' ? c.content : JSON.stringify(c);
  return c == null ? '' : String(c);
}

// ── 대화 조립기: 사용자 글 1개 = 메시지 1개, 다음 사용자 글 전까지의 AI 글·도구 = AI 메시지 1개 ──
class Builder {
  constructor(max, provider) {
    this.max = max;
    this.provider = provider;
    this.list = [];
    this.total = 0;
    this.users = 0;
    this.cur = null;
    this.tools = new Map();
    this.model = '';
    this.firstUser = '';
    this.seq = 0;
  }

  #push(m) {
    this.list.push(m);
    this.total++;
    if (this.list.length > this.max) this.list.shift(); // 마지막 max개만 유지
  }

  user(text, at) {
    this.cur = null;
    this.tools.clear();
    this.users++;
    if (!this.firstUser) this.firstUser = text;
    this.#push({ role: 'user', text: clip(text, TEXT_MAX), createdAt: at, status: 'done', attachments: [], blocks: [] });
  }

  #agent(at) {
    if (!this.cur) {
      this.cur = { role: 'agent', text: '', createdAt: at, status: 'done', attachments: [], blocks: [], provider: this.provider, model: this.model };
      this.#push(this.cur);
    }
    return this.cur;
  }

  text(t, at) {
    const m = this.#agent(at);
    if (m.text.length >= TEXT_MAX) return;
    m.text = clip(m.text ? `${m.text}\n\n${t}` : t, TEXT_MAX);
  }

  tool(id, name, input, at, status = 'done') {
    const m = this.#agent(at);
    const blk = { id: typeof id === 'string' && id ? id : `blk-${++this.seq}`, kind: 'tool', name: String(name || '도구'), input: clipInput(input), output: '', status };
    m.blocks.push(blk);
    if (m.blocks.length > BLOCKS_MAX) { m.blocks.shift(); m.toolsOmitted = (m.toolsOmitted || 0) + 1; }
    if (id) this.tools.set(id, blk);
  }

  result(id, out, isError) {
    const blk = this.tools.get(id);
    if (!blk) return;
    blk.output = clip(String(out ?? ''), OUT_MAX);
    if (isError) blk.status = 'error';
    this.tools.delete(id);
  }
}

// Codex 옛 버전은 같은 대화를 event_msg 로도 적어서, response_item 쪽에 사용자 글이 있으면 그걸 쓴다
const pick = (b, fb) => (b.users > 0 || !fb.total ? b : fb);

function newState() {
  return { cwd: '', cwds: new Set(), lastAt: 0, model: '', meta: null, summary: '', customTitle: '', aiTitle: '', lastPrompt: '' };
}

// ── Claude Code 기록 ──
// 자동 삽입(명령 출력·시스템 알림·작업 알림 등)은 빈 글로 만들어 대화에서 뺀다
function claudeUserText(t) {
  let s = String(t ?? '');
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(s);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim();
    return `${cmd[1].trim()}${args ? ` ${args}` : ''}`;
  }
  const bash = /^\s*<bash-input>([\s\S]*?)<\/bash-input>/.exec(s);
  if (bash) return `! ${bash[1].trim()}`;
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!s) return '';
  if (/^<(local-command-stdout|local-command-stderr|local-command-caveat|task-notification|bash-stdout|bash-stderr|user-prompt-submit-hook|command-message)\b/.test(s)) return '';
  if (/^\[Request interrupted by user/.test(s)) return '';
  return s;
}

function claudeUser(o, b, at) {
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return;
  const c = o.message?.content;
  const parts = [];
  if (typeof c === 'string') parts.push(claudeUserText(c));
  else if (Array.isArray(c)) {
    for (const x of c) {
      if (!x || typeof x !== 'object') continue;
      if (x.type === 'tool_result') b.result(x.tool_use_id, blockText(x.content), !!x.is_error);
      else if (x.type === 'text') parts.push(claudeUserText(x.text));
      else if (x.type === 'image') parts.push('[이미지]');
      else if (x.type === 'document') parts.push('[문서]');
    }
  }
  const text = parts.filter(Boolean).join('\n');
  if (text) b.user(text, at);
}

function claudeAssistant(o, b, st, at) {
  const msg = o.message || {};
  if (msg.model && msg.model !== '<synthetic>') st.model = b.model = msg.model;
  const c = msg.content;
  if (typeof c === 'string') { if (c.trim()) b.text(c, at); return; }
  if (!Array.isArray(c)) return;
  for (const x of c) {
    if (!x || typeof x !== 'object') continue;
    if (x.type === 'text') { if (x.text?.trim() && x.text.trim() !== '(no content)') b.text(x.text, at); }
    else if (x.type === 'tool_use' || x.type === 'server_tool_use') b.tool(x.id, x.name, x.input, at);
    else if (typeof x.type === 'string' && x.type.endsWith('_tool_result')) b.result(x.tool_use_id, blockText(x.content), false);
    // thinking 블록은 서명된 내부 추론이라 화면 기록에서 뺀다
  }
}

function claudeHandler(st, b) {
  return (o) => {
    if (!o || typeof o !== 'object' || o.isSidechain) return; // 서브에이전트 줄 제외
    const at = Date.parse(o.timestamp) || 0;
    if (at) st.lastAt = at;
    if (typeof o.cwd === 'string' && o.cwd) {
      if (!st.cwd) st.cwd = o.cwd;
      if (st.cwds.size < 20) st.cwds.add(o.cwd);
    }
    const when = at || st.lastAt;
    switch (o.type) {
      case 'summary': if (o.summary) st.summary = String(o.summary); break;
      case 'custom-title': if (o.customTitle) st.customTitle = String(o.customTitle); break;
      case 'ai-title': if (o.aiTitle) st.aiTitle = String(o.aiTitle); break;
      case 'last-prompt': if (o.lastPrompt) st.lastPrompt = String(o.lastPrompt); break;
      case 'user': claudeUser(o, b, when); break;
      case 'assistant': claudeAssistant(o, b, st, when); break;
      default: break;
    }
  };
}

// claude --resume 은 같은 폴더에서만 찾으므로, 프로젝트 폴더 이름(경로의 영숫자 외 문자를 '-'로 바꾼 것)과 맞는 cwd 를 고른다
function claudeCwd(st, dirName) {
  for (const c of st.cwds) if (c.replace(/[^a-zA-Z0-9]/g, '-') === dirName) return c;
  return st.cwd || '';
}

// ── Codex CLI 기록 ──
const stripRole = (t) => t.replace(/^\s*<역할 지침>[\s\S]*?<\/역할 지침>\s*/, ''); // 이 앱이 붙인 역할 지침

// 옛 형식(종류 표시 없음)에서 자동 삽입 글 판별: AGENTS.md 지침, 태그 하나로 통째로 감싼 덩어리(<environment_context> 등)
function codexAuto(t) {
  const s = t.trim();
  if (!s) return true;
  if (/^# AGENTS\.md instructions/i.test(s)) return true;
  if (/^<\/?image\b[^>]*>$/.test(s)) return true;
  const m = /^<([A-Za-z_][\w-]*)[^>]*>/.exec(s);
  return !!m && s.endsWith(`</${m[1]}>`);
}

function codexUserText(p) {
  const content = Array.isArray(p.content) ? p.content : [];
  // 새 형식은 항목마다 종류(user.text / agents_md.instructions / environments.environment_context …)가 붙어 있다
  const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const useKinds = Array.isArray(kinds) && kinds.length === content.length;
  const parts = [];
  content.forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    if (useKinds && !String(kinds[i]).startsWith('user.')) return;
    if (c.type === 'input_image' || c.type === 'image') { parts.push('[이미지]'); return; }
    if (typeof c.text !== 'string') return;
    const t = stripRole(c.text);
    if (useKinds ? (!t.trim() || /^\s*<\/?image\b[^>]*>\s*$/.test(t)) : codexAuto(t)) return;
    parts.push(t.trim());
  });
  return parts.join('\n');
}

// 도구 출력: 문자열(옛 형식은 {"output","metadata":{"exit_code"}} JSON), 배열(input_text/input_image), 객체
function codexOutput(out) {
  if (typeof out === 'string') {
    const j = parseMaybe(out);
    if (j && typeof j === 'object' && !Array.isArray(j) && typeof j.output === 'string') {
      const code = j.metadata?.exit_code;
      return { text: j.output, error: typeof code === 'number' && code !== 0 };
    }
    return { text: out, error: false };
  }
  if (out && typeof out === 'object' && !Array.isArray(out)) return { text: blockText(out.content ?? out), error: out.success === false };
  return { text: blockText(out), error: false };
}

function codexItem(p, b, at) {
  const t = p.type;
  if (t === 'message') {
    if (p.role === 'user') {
      const text = codexUserText(p);
      if (text) b.user(text, at);
    } else if (p.role === 'assistant') {
      for (const c of p.content || []) if (typeof c?.text === 'string' && c.text.trim()) b.text(c.text, at);
    }
    return; // developer/system 지침은 대화가 아님
  }
  if (typeof t !== 'string' || CODEX_SKIP_ITEM.has(t)) return;
  if (t.endsWith('_call_output')) {
    const r = codexOutput(p.output);
    b.result(p.call_id || p.id, r.text, r.error);
    return;
  }
  if (t.endsWith('_call')) {
    let name = p.name;
    let input = p.arguments ?? p.input ?? p.action;
    if (t === 'web_search_call') { name = '웹 검색'; input = p.action || {}; }
    else if (t === 'local_shell_call') { name = '명령 실행'; input = p.action?.command ? { command: [].concat(p.action.command).join(' ') } : p.action; }
    else if (p.namespace) name = `${p.namespace}.${p.name}`;
    b.tool(p.call_id || p.id, name || t, parseMaybe(input), at, p.status === 'failed' ? 'error' : 'done');
  }
}

function codexHandler(st, b, fb) {
  return (o) => {
    if (!o || typeof o !== 'object') return;
    let kind = o.type;
    let p = o.payload;
    if (!p && !kind && o.id && o.timestamp) { kind = 'session_meta'; p = o; } // 아주 옛 형식 첫 줄
    else if (!p && CODEX_LEGACY_ITEM.has(kind)) { kind = 'response_item'; p = o; } // 감싸지 않은 옛 형식 항목
    if (!p || typeof p !== 'object') return;
    const at = Date.parse(o.timestamp) || 0;
    if (at) st.lastAt = at;
    const when = at || st.lastAt;
    switch (kind) {
      case 'session_meta':
        if (!st.meta) { st.meta = p; if (p.cwd) st.cwd = String(p.cwd); }
        break;
      case 'turn_context':
        if (p.model) st.model = b.model = fb.model = String(p.model);
        if (!st.cwd && p.cwd) st.cwd = String(p.cwd);
        break;
      case 'response_item': codexItem(p, b, when); break;
      case 'event_msg':
        if (p.type === 'user_message') {
          const t = stripRole(String(p.message ?? ''));
          const imgs = (p.images?.length || 0) + (p.local_images?.length || 0);
          const text = [codexAuto(t) ? '' : t.trim(), ...Array(imgs).fill('[이미지]')].filter(Boolean).join('\n');
          if (text) fb.user(text, when);
        } else if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim()) fb.text(p.message, when);
        break;
      default: break;
    }
  };
}

// 서브에이전트(검토자 포함) 스레드는 사용자가 직접 한 대화가 아니라서 목록에서 뺀다
function isCodexSub(meta) {
  if (!meta) return false;
  const src = meta.source;
  if (src && typeof src === 'object' && 'subagent' in src) return true;
  return meta.thread_source === 'subagent' || meta.thread_source === 'guardian_review';
}

// ── 줄 판별·해석 ──
// 앞부분만 보고 필요 없는 줄(토큰 집계·추론·스냅샷 등)은 JSON 해석 없이 건너뛴다
function wanted(source, head) {
  if (source === 'claude') {
    const m = /^\{"type":"([\w-]+)"/.exec(head);
    return m ? CLAUDE_TOP.has(m[1]) : true;
  }
  const t = /"type":"([\w-]+)"/.exec(head)?.[1];
  if (!t) return true;
  if (t === 'session_meta' || t === 'turn_context') return true;
  if (t === 'response_item') {
    const pt = /"payload":\{"type":"([\w-]+)"/.exec(head)?.[1];
    if (!pt) return true;
    if (CODEX_SKIP_ITEM.has(pt)) return false;
    return !(pt === 'message' && /"role":"(developer|system)"/.test(head));
  }
  if (t === 'event_msg') return /"payload":\{"type":"(user_message|agent_message)"/.test(head);
  return CODEX_LEGACY_ITEM.has(t);
}

function parseText(s) {
  if (s.length > BIG_LINE) {
    s = s.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, 'data:,').replace(/"data":"[A-Za-z0-9+/=]{256,}"/g, '"data":""');
  }
  try { return JSON.parse(s); } catch { return null; } // 깨진 줄은 무시
}

function handlerFor(source, st, b, fb) {
  return source === 'claude' ? claudeHandler(st, b) : codexHandler(st, b, fb);
}

function feedLines(source, st, lines) {
  const b = new Builder(Infinity, source);
  const fb = new Builder(Infinity, source);
  const h = handlerFor(source, st, b, fb);
  for (const l of lines) {
    if (!l || l.length < 2 || !wanted(source, l.slice(0, PEEK))) continue;
    const o = parseText(l);
    if (o) h(o);
  }
  return pick(b, fb);
}

function splitLines(buf, dropFirst, dropLast) {
  const lines = buf.toString('utf8').split('\n');
  if (dropFirst) lines.shift(); // 중간부터 읽어서 잘린 첫 줄
  if (dropLast) lines.pop(); // 64KB 경계에서 잘린 마지막 줄
  return lines;
}

// ── 파일 읽기 ──
// 목록용: 앞 64KB + 뒤 64KB 만 읽는다(작은 파일은 통째로)
async function readSlices(file, size, headLen, tailLen) {
  const fh = await fsp.open(file, 'r');
  try {
    const read = async (len, pos) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead);
    };
    if (size <= headLen + tailLen) return { head: await read(size, 0), tail: null, whole: true };
    let head = await read(headLen, 0);
    if (head.indexOf(10) < 0) head = await read(Math.min(size, FIRST_LINE_MAX), 0); // 첫 줄이 아주 긴 경우
    if (head.length >= size) return { head, tail: null, whole: true };
    const from = Math.max(size - tailLen, head.length);
    return { head, tail: from < size ? await read(size - from, from) : null, whole: false };
  } finally {
    await fh.close();
  }
}

// 압축본은 앞부분만(뒷부분은 전체를 풀어야 해서 목록에선 안 읽음), 일반 파일은 앞+뒤
async function readForList(file, size, headLen, tailLen) {
  if (!file.endsWith('.zst')) return readSlices(file, size, headLen, tailLen);
  const r = await readZstHead(file, headLen);
  return { head: r.buf, tail: null, whole: r.complete };
}

// .zst 압축 기록: 앞부분만 풀고 멈춘다(뒷부분은 전체를 풀어야 해서 목록에선 안 읽음)
function readZstHead(file, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const src = fs.createReadStream(file);
    const z = zlib.createZstdDecompress();
    const finish = (complete) => {
      if (done) return;
      done = true;
      src.destroy();
      z.destroy();
      resolve({ buf: Buffer.concat(chunks), complete });
    };
    z.on('data', (c) => {
      if (done) return;
      chunks.push(c);
      n += c.length;
      if (n >= limit) finish(false);
    });
    z.on('end', () => finish(true));
    z.on('error', () => finish(false));
    src.on('error', () => finish(false));
    src.pipe(z);
  });
}

// 전체 읽기용: 줄 단위 스트림(큰 파일·압축 파일 OK). 너무 긴 줄은 버린다
async function eachLine(file, onLine) {
  const src = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  let stream = src;
  if (file.endsWith('.zst')) {
    const z = zlib.createZstdDecompress();
    src.on('error', (e) => z.destroy(e));
    stream = src.pipe(z);
  }
  let parts = [];
  let partLen = 0;
  let skipping = false;
  try {
    for await (const chunk of stream) {
      let start = 0;
      let nl;
      while ((nl = chunk.indexOf(10, start)) >= 0) {
        if (!skipping) onLine(partLen ? Buffer.concat([...parts, chunk.subarray(start, nl)]) : chunk.subarray(start, nl));
        parts = [];
        partLen = 0;
        skipping = false;
        start = nl + 1;
      }
      if (start < chunk.length && !skipping) {
        partLen += chunk.length - start;
        if (partLen > MAX_LINE) { parts = []; partLen = 0; skipping = true; } else parts.push(chunk.subarray(start));
      }
    }
  } finally {
    src.destroy();
  }
  if (partLen && !skipping) onLine(Buffer.concat(parts));
}

// ── 파일 찾기 ──
async function listClaudeFiles() {
  const root = claudeRoot();
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
    let names;
    try { names = await fsp.readdir(path.join(root, d.name), { withFileTypes: true }); } catch { return; }
    // 프로젝트 폴더 바로 아래 <세션id>.jsonl 만. 서브에이전트 기록(<세션id>/subagents/agent-*.jsonl, agent-*.jsonl)은 제외
    for (const f of names) {
      if (!f.isFile() || !f.name.endsWith('.jsonl') || f.name.startsWith('agent-')) continue;
      if (!SAFE_ID.test(f.name.slice(0, -6))) continue;
      out.push({ source: 'claude', file: path.join(root, d.name, f.name), dirName: d.name, archived: false });
    }
  }));
  return out;
}

async function walkCodex(dir, depth, archived, out) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  await Promise.all(ents.map(async (e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) await walkCodex(p, depth - 1, archived, out); return; }
    if (!e.isFile() || !/^rollout-.*\.jsonl(\.zst)?$/.test(e.name)) return;
    if (e.name.endsWith('.zst') && !HAS_ZSTD) return;
    out.push({ source: 'codex', file: p, archived });
  }));
}

async function listCodexFiles() {
  const root = codexRoot();
  const out = [];
  await Promise.all([
    walkCodex(path.join(root, 'sessions'), 4, false, out), // sessions/YYYY/MM/DD/rollout-*.jsonl
    walkCodex(path.join(root, 'archived_sessions'), 4, true, out),
  ]);
  return out;
}

// Codex 스레드 이름(앱에서 붙인 제목): session_index.jsonl 의 {id, thread_name, updated_at}
let indexCache = null;
async function codexIndex() {
  const file = path.join(codexRoot(), 'session_index.jsonl');
  let s;
  try { s = await fsp.stat(file); } catch { return new Map(); }
  if (indexCache && indexCache.file === file && indexCache.mtimeMs === s.mtimeMs && indexCache.size === s.size) return indexCache.map;
  const map = new Map();
  try {
    for (const l of (await fsp.readFile(file, 'utf8')).split('\n')) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (!o?.id) continue;
        const prev = map.get(String(o.id));
        map.set(String(o.id), { name: oneLine(o.thread_name) || prev?.name || '', updatedAt: Date.parse(o.updated_at) || prev?.updatedAt || 0 });
      } catch { /* 깨진 줄 무시 */ }
    }
  } catch { /* 못 읽으면 이름 없이 */ }
  indexCache = { file, mtimeMs: s.mtimeMs, size: s.size, map };
  return map;
}

// ── 목록 ──
function analyze(source, r) {
  const st = newState();
  const hb = feedLines(source, st, splitLines(r.head, false, !r.whole));
  const tb = r.tail ? feedLines(source, st, splitLines(r.tail, true, false)) : null;
  const msgs = tb ? [...hb.list, ...tb.list] : hb.list;
  let preview = '';
  for (let i = msgs.length - 1; i >= 0 && !preview; i--) preview = oneLine(msgs[i].text);
  if (!preview) preview = oneLine(st.lastPrompt);
  return {
    st, preview, firstUser: hb.firstUser || tb?.firstUser || '', headUser: !!hb.firstUser,
    count: hb.total + (tb ? tb.total : 0), whole: r.whole,
    lastAt: r.tail || r.whole ? st.lastAt : 0, // 끝부분을 못 읽었으면(압축본) 마지막 시각을 모름
  };
}

async function summarize(job, stat) {
  const { file, source } = job;
  let a = analyze(source, await readForList(file, stat.size, HEAD, TAIL));
  if (source === 'codex' && isCodexSub(a.st.meta)) return null;
  // 1차(앞·뒤 64KB)에서 첫 사용자 글이나 미리보기를 못 찾았으면 그 부분만 더 넓게 한 번 더 읽는다
  if (!a.whole && EXTEND > HEAD && (!a.headUser || !a.preview)) {
    a = analyze(source, await readForList(file, stat.size, a.headUser ? HEAD : EXTEND, a.preview ? TAIL : EXTEND));
    if (source === 'codex' && isCodexSub(a.st.meta)) return null;
  }
  const { st, preview, firstUser, count, whole, lastAt } = a;
  const id = source === 'claude' ? path.basename(file, '.jsonl') : String(st.meta?.id || UUID_IN_NAME.exec(path.basename(file))?.[1] || '');
  if (!SAFE_ID.test(id)) return null;
  if (whole && count === 0) return null; // 대화가 하나도 없는 빈 기록
  const title = source === 'claude' ? (st.customTitle || st.aiTitle || st.summary || firstUser || st.lastPrompt) : firstUser;
  return {
    source, id, file, dirName: job.dirName || '', archived: !!job.archived,
    title: oneLine(title).slice(0, TITLE_MAX),
    cwd: source === 'claude' ? claudeCwd(st, job.dirName) : st.cwd,
    lastAt, mtimeMs: stat.mtimeMs, sizeBytes: stat.size,
    messageCount: count, messageCountApprox: !whole, // 앞뒤만 읽었으면 '최소 이만큼'
    preview: preview.slice(0, PREVIEW_MAX),
  };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const cache = new Map(); // 파일 경로 → { mtimeMs, size, entry|null } (수정 시각·크기가 같으면 다시 안 읽음)

async function scanAll() {
  const [claudeJobs, codexJobs, idx] = await Promise.all([listClaudeFiles(), listCodexFiles(), codexIndex()]);
  const jobs = [...claudeJobs, ...codexJobs];
  const seen = new Set(jobs.map((j) => j.file));
  const found = [];
  await pool(jobs, CONCURRENCY, async (job) => {
    let s;
    try { s = await fsp.stat(job.file); } catch { return; }
    const c = cache.get(job.file);
    let entry = c && c.mtimeMs === s.mtimeMs && c.size === s.size ? c.entry : undefined;
    if (entry === undefined) {
      try { entry = await summarize(job, s); } catch { entry = null; }
      cache.set(job.file, { mtimeMs: s.mtimeMs, size: s.size, entry });
    }
    if (entry) found.push(entry);
  });
  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k); // 사라진 파일 정리
  // 같은 세션이 두 군데 있으면(보관함·압축본) 보관 안 된 것 → 최신 것 순으로 하나만
  const best = new Map();
  for (const e of found) {
    const ix = e.source === 'codex' ? idx.get(e.id) : null;
    e.displayTitle = ix?.name || e.title || '(제목 없음)';
    e.updatedAt = e.lastAt || ix?.updatedAt || Math.round(e.mtimeMs);
    const k = `${e.source}:${e.id}`;
    const prev = best.get(k);
    if (!prev || (prev.archived && !e.archived) || (prev.archived === e.archived && e.updatedAt > prev.updatedAt)) best.set(k, e);
  }
  return [...best.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 불러올 수 있는 세션 목록(최신순).
 * @returns {Promise<Array<{source:'claude'|'codex', id, title, cwd, cwdExists, updatedAt, messageCount, messageCountApprox, preview, sizeBytes, archived}>>}
 */
export async function listImportable({ query = '', limit = 300 } = {}) {
  const all = await scanAll();
  const words = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length
    ? all.filter((e) => { const hay = `${e.displayTitle}\n${e.cwd}\n${e.preview}\n${e.id}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
    : all;
  const n = Math.max(1, Math.min(Math.floor(Number(limit)) || 300, 5000));
  const dirOk = new Map();
  const exists = (p) => { if (!p) return false; if (!dirOk.has(p)) dirOk.set(p, safeIsDir(p)); return dirOk.get(p); };
  return hits.slice(0, n).map((e) => ({
    source: e.source, id: e.id, title: e.displayTitle, cwd: e.cwd, cwdExists: exists(e.cwd),
    updatedAt: e.updatedAt, messageCount: e.messageCount, messageCountApprox: e.messageCountApprox,
    preview: e.preview, sizeBytes: e.sizeBytes, archived: e.archived,
  }));
}

/**
 * 세션 대화 전체를 스트림으로 읽어 마지막 maxMessages개 메시지를 돌려준다.
 * id 는 세션 id만 받는다(경로 아님). 목록에 있는 기록만 찾는다.
 */
export async function readTranscript(source, id, { maxMessages = 400 } = {}) {
  if (source !== 'claude' && source !== 'codex') throw fail(400, '알 수 없는 기록 종류야. (claude 또는 codex)');
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw fail(400, '세션 id 형식이 올바르지 않아.');
  const entry = (await scanAll()).find((e) => e.source === source && e.id === id);
  if (!entry) throw fail(404, '그 세션 기록을 찾을 수 없어.');
  const max = Math.max(1, Math.floor(Number(maxMessages)) || 400);
  const st = newState();
  const b = new Builder(max, source);
  const fb = new Builder(max, source);
  const h = handlerFor(source, st, b, fb);
  try {
    await eachLine(entry.file, (buf) => {
      if (!wanted(source, buf.toString('latin1', 0, Math.min(buf.length, PEEK)))) return;
      const o = parseText(buf.toString('utf8'));
      if (o) h(o);
    });
  } catch (e) {
    throw fail(500, `기록 파일을 읽지 못했어: ${e.message}`);
  }
  const out = pick(b, fb);
  // 전체를 읽었으니 목록 캐시도 정확한 값으로 고친다
  entry.messageCount = out.total;
  entry.messageCountApprox = false;
  const cwd = source === 'claude' ? claudeCwd(st, entry.dirName) : (st.cwd || entry.cwd);
  // 앞뒤만 읽은 목록보다 전체를 읽은 지금 제목이 더 정확하다(Codex는 스레드 이름이 있으면 그게 우선)
  const named = source === 'codex' ? (await codexIndex()).get(id)?.name : '';
  const raw = source === 'claude' ? (st.customTitle || st.aiTitle || st.summary || out.firstUser || st.lastPrompt) : out.firstUser;
  const t = oneLine(raw).slice(0, TITLE_MAX);
  if (t) entry.title = t;
  const title = named || t || entry.displayTitle;
  entry.displayTitle = title;
  return {
    source, id, cwd, cwdExists: !!cwd && safeIsDir(cwd), title: title || '(제목 없음)',
    model: st.model || out.model || '', messages: out.list,
    truncated: out.total > out.list.length, total: out.total,
  };
}
