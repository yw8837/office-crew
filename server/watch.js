// 터미널 세션 구경: 내가 터미널에서 돌리는 Claude Code·Codex 세션의 기록 파일 끝만 따라 읽어 지금 뭘 하는지 보여 준다.
// CLI 를 실행하지 않고 AI 도 부르지 않는다(사용량 0). 파일은 읽기만 한다. 화면을 보는 동안만 돈다.
// 기록은 각 CLI 의 내부 형식이라 버전마다 바뀔 수 있다. 모르는 줄은 건너뛴다
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toolCategory } from './providers/util.js';
import { defaultCodexHome } from './providers/codex.js';

const TICK_MS = 1000;
const SCAN_EVERY = 5; // 새 파일 찾기는 5번에 한 번
const RECENT_MS = 10 * 60 * 1000; // 이보다 오래 안 바뀐 파일은 안 따라간다
export const ACTIVE_MS = 90 * 1000; // 이 안에 기록이 있으면 일하는 중
const VIEW_TTL = 60 * 1000; // 화면에서 이만큼 소식이 없으면 멈춘다
const FIRST_TAIL = 64 * 1024; // 처음 볼 때 끝에서 읽는 양
const READ_MAX = 512 * 1024; // 한 번에 읽는 최대량
const HEAD_MAX = 1024 * 1024; // Codex 첫 줄(작업 폴더)을 찾을 때 읽는 양
const SHOW_MAX = 12; // 한 번에 보여 주는 세션 수

const claudeRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

// 도구 입력에서 보여 줄 짧은 이름: 파일은 이름만, 명령은 프로그램 이름만(토큰이 든 인자가 화면에 나오지 않게)
function toolDetail(rawName, input) {
  const name = String(rawName).replace(/^mcp__.*__/, ''); // MCP 도구는 끝 이름만
  const i = input && typeof input === 'object' ? input : {};
  const file = i.file_path || i.path || i.notebook_path || i.filename;
  if (typeof file === 'string' && file) return `${name} · ${baseName(file)}`;
  const cmd = Array.isArray(i.command) ? i.command.join(' ') : i.command || i.cmd;
  if (typeof cmd === 'string' && cmd.trim()) return `${name} · ${baseName(cmd.trim().split(/\s+/)[0])}`;
  return String(name);
}

const parseArgs = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return {}; } };
const lastLine = (s) => String(s).trim().split('\n').pop().slice(-70);

// 기록 한 줄 → 새 상태(바뀌지 않으면 null). 순수 함수(테스트하기 쉽게)
export function claudeEvent(o) {
  if (!o || typeof o !== 'object' || o.isSidechain) return null; // 서브에이전트 줄은 본 세션 상태로 치지 않는다
  const extra = { cwd: typeof o.cwd === 'string' ? o.cwd : undefined };
  if (o.type === 'assistant') {
    const c = o.message?.content;
    const model = o.message?.model && o.message.model !== '<synthetic>' ? o.message.model : undefined;
    if (!Array.isArray(c)) return typeof c === 'string' && c.trim() ? { ...extra, model, state: 'typing', detail: lastLine(c) } : null;
    let out = null;
    for (const x of c) {
      if (x?.type === 'tool_use' || x?.type === 'server_tool_use') out = { state: toolCategory(x.name), tool: x.name, detail: toolDetail(x.name, x.input) };
      else if (x?.type === 'text' && x.text?.trim()) out = { state: 'typing', tool: null, detail: lastLine(x.text) };
      else if (x?.type === 'thinking') out ||= { state: 'thinking', tool: null, detail: '' };
    }
    if (out && o.message?.stop_reason === 'end_turn') out.state = 'done';
    return out ? { ...extra, model, ...out } : null;
  }
  if (o.type === 'user') {
    const c = o.message?.content;
    const results = Array.isArray(c) ? c.filter((x) => x?.type === 'tool_result') : [];
    if (results.some((x) => x.is_error)) return { ...extra, state: 'error', tool: null, detail: '' };
    return { ...extra, state: 'thinking', tool: null, detail: '' };
  }
  return null;
}

export function codexEvent(o) {
  if (!o || typeof o !== 'object') return null;
  const p = o.payload;
  if (!p || typeof p !== 'object') return null;
  if (o.type === 'session_meta') return p.cwd ? { cwd: String(p.cwd), meta: true } : null;
  if (o.type === 'turn_context') return { cwd: p.cwd ? String(p.cwd) : undefined, model: p.model ? String(p.model) : undefined, meta: true };
  if (o.type === 'event_msg') {
    if (p.type === 'task_complete' || p.type === 'turn_complete') return { state: 'done', tool: null, detail: '' };
    if (p.type === 'user_message') return { state: 'thinking', tool: null, detail: '' };
    return null;
  }
  if (o.type !== 'response_item') return null;
  const t = String(p.type || '');
  if (t === 'reasoning') return { state: 'thinking', tool: null, detail: '' };
  if (t === 'message' && p.role === 'assistant') {
    const text = (p.content || []).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('');
    return text.trim() ? { state: 'typing', tool: null, detail: lastLine(text) } : null;
  }
  if (t.endsWith('_call_output')) return { state: 'thinking', tool: null, detail: '' };
  if (t.endsWith('_call')) {
    const name = t === 'web_search_call' ? 'web_search' : t === 'local_shell_call' ? 'shell' : (p.name || t);
    return { state: toolCategory(name), tool: name, detail: toolDetail(name, parseArgs(p.arguments ?? p.input ?? p.action)) };
  }
  return null;
}

export class SessionWatch {
  constructor(bus, { now = () => Date.now() } = {}) {
    this.bus = bus;
    this.now = now;
    this.files = new Map(); // 파일 경로 → 따라가는 상태
    this.timer = null;
    this.viewedAt = 0;
    this.ticks = 0;
    this.lastKey = '';
    this.busy = false;
  }

  // 화면이 보고 있다고 알릴 때마다 호출. 돌고 있지 않으면 시작한다
  view() {
    this.viewedAt = this.now();
    if (!this.timer) {
      this.timer = setInterval(() => { this.tick().catch(() => {}); }, TICK_MS);
      this.timer.unref?.();
      this.ticks = 0;
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.files.clear();
    this.lastKey = '';
  }

  async #scan() {
    const cut = this.now() - RECENT_MS;
    const found = [];
    const addDir = async (dir, source, test) => {
      let names;
      try { names = await fsp.readdir(dir); } catch { return; }
      await Promise.all(names.filter(test).map(async (n) => {
        const file = path.join(dir, n);
        try { if ((await fsp.stat(file)).mtimeMs >= cut) found.push({ file, source }); } catch { /* 사라진 파일 */ }
      }));
    };
    let projects = [];
    try { projects = await fsp.readdir(claudeRoot()); } catch { /* 없으면 Claude 안 씀 */ }
    await Promise.all(projects.map((d) => addDir(path.join(claudeRoot(), d), 'claude', (n) => n.endsWith('.jsonl') && !n.startsWith('agent-'))));
    // Codex 는 날짜 폴더라 오늘과 어제만 본다(자정을 넘겨 도는 세션 포함)
    for (const back of [0, 1]) {
      const d = new Date(this.now() - back * 86400e3);
      const dir = path.join(defaultCodexHome(), 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
      await addDir(dir, 'codex', (n) => /^rollout-.*\.jsonl$/.test(n));
    }
    const seen = new Set(found.map((f) => f.file));
    for (const f of found) if (!this.files.has(f.file)) this.files.set(f.file, this.#fresh(f));
    for (const k of this.files.keys()) if (!seen.has(k)) this.files.delete(k);
  }

  #fresh({ file, source }) {
    const id = source === 'codex'
      ? (path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1] || path.basename(file, '.jsonl'))
      : path.basename(file, '.jsonl');
    return { file, source, id, offset: -1, state: 'idle', detail: '', tool: null, at: 0, cwd: '', model: '' };
  }

  async #read(f) {
    let fh;
    try {
      fh = await fsp.open(f.file, 'r');
      const { size, mtimeMs } = await fh.stat();
      let dropFirst = false;
      if (f.offset < 0) {
        f.at = mtimeMs; // 처음 볼 때는 파일 시각을 마지막 활동으로 친다
        if (f.source === 'codex') await this.#readHead(fh, f, size);
        f.offset = Math.max(0, size - FIRST_TAIL);
        dropFirst = f.offset > 0;
      }
      if (size < f.offset) f.offset = 0; // 파일이 새로 써졌다
      if (size === f.offset) return;
      const len = Math.min(READ_MAX, size - f.offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, f.offset);
      const end = buf.lastIndexOf(10); // 다 안 써진 마지막 줄은 다음에 읽는다
      if (end < 0) { if (len === READ_MAX) f.offset += len; return; }
      f.offset += end + 1;
      const lines = buf.toString('utf8', 0, end).split('\n');
      if (dropFirst) lines.shift();
      const parse = f.source === 'codex' ? codexEvent : claudeEvent;
      for (const line of lines) {
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const ev = parse(o);
        if (!ev) continue;
        if (ev.cwd) f.cwd = ev.cwd;
        if (ev.model) f.model = ev.model;
        if (ev.meta) continue;
        Object.assign(f, { state: ev.state, detail: ev.detail ?? '', tool: ev.tool ?? null, at: Date.parse(o.timestamp) || this.now() });
      }
    } catch { /* 읽는 중 사라진 파일은 다음 번에 정리된다 */ } finally { await fh?.close().catch(() => {}); }
  }

  async #readHead(fh, f, size) {
    const buf = Buffer.alloc(Math.min(HEAD_MAX, size));
    if (!buf.length) return;
    await fh.read(buf, 0, buf.length, 0);
    const nl = buf.indexOf(10);
    try {
      const ev = codexEvent(JSON.parse(buf.toString('utf8', 0, nl < 0 ? buf.length : nl)));
      if (ev?.cwd) f.cwd = ev.cwd;
    } catch { /* 첫 줄이 너무 길거나 다른 형식 */ }
  }

  // 한 번 돌기(테스트는 직접 부른다)
  async tick() {
    if (this.busy) return;
    if (this.timer && this.now() - this.viewedAt > VIEW_TTL) { this.stop(); return; }
    this.busy = true;
    try {
      if (this.ticks++ % SCAN_EVERY === 0) await this.#scan();
      await Promise.all([...this.files.values()].map((f) => this.#read(f)));
      const key = JSON.stringify(this.snapshot().map((s) => [s.id, s.state, s.detail, s.active]));
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.bus?.emit('watch', this.snapshot());
      }
    } finally { this.busy = false; }
  }

  snapshot() {
    const now = this.now();
    return [...this.files.values()].sort((a, b) => b.at - a.at).slice(0, SHOW_MAX).map((f) => {
      const active = now - f.at < ACTIVE_MS;
      const working = active && !['done', 'idle'].includes(f.state);
      return {
        id: `${f.source}-${f.id}`, source: f.source, project: baseName(f.cwd) || f.source, model: f.model,
        state: working ? f.state : active ? 'done' : 'idle', detail: working ? f.detail : '', tool: working ? f.tool : null, at: f.at, active,
      };
    });
  }
}

