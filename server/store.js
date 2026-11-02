// JSON 파일 저장소: 컬렉션은 파일 1개, 세션은 세션마다 파일 1개
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { seedData, defaultSettings } from './seed.js';
import { tr } from './i18n.js';

export function newId(prefix = 'id') {
  return `${prefix}-${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 8).toLowerCase()}`;
}

const COLLECTIONS = ['agents', 'teams', 'connectors', 'skills', 'skins', 'plugins'];
const MAX_CACHE = Number(process.env.OFFICE_CREW_SESSION_CACHE || 12); // 메모리에 올려둘 세션 본문 수

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      // 윈도우에서 백신·인덱서가 파일을 잡고 있으면 잠깐 실패할 수 있다
      if (i >= 5) { fs.copyFileSync(tmp, file); fs.rmSync(tmp, { force: true }); return; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export class Store {
  constructor(dirs) {
    this.dirs = dirs;
    this.cols = {};
    this.settings = {};
    this.usage = {};
    this.sessions = new Map(); // 본문 캐시(최근 사용 순, 최대 MAX_CACHE개 + 실행 중인 것)
    this.meta = new Map(); // 전체 세션 목록 정보(가벼움)
    this.pinned = new Set(); // 실행 중이라 캐시에서 내리면 안 되는 세션
    this.timers = new Map();
    this.indexTimer = null;
  }

  init() {
    const first = !fs.existsSync(path.join(this.dirs.home, 'agents.json'));
    const seed = seedData();
    for (const c of COLLECTIONS) this.cols[c] = readJson(this.#file(c), first ? (seed[c] || []) : []);
    this.settings = { ...defaultSettings(), ...readJson(this.#file('settings'), {}) };
    this.usage = readJson(this.#file('usage'), { byProvider: {}, byDay: {}, limits: {} });
    // 세션 본문은 필요할 때만 읽는다(메모리 절약). 목록은 index.json + 새 파일만 한 번 읽어 맞춘다
    this.meta = new Map(Object.entries(readJson(this.#indexFile(), {})));
    const files = new Set(fs.readdirSync(this.dirs.sessions).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.slice(0, -5)));
    for (const id of [...this.meta.keys()]) if (!files.has(id)) this.meta.delete(id);
    for (const id of files) {
      if (this.meta.has(id)) continue;
      const s = readJson(path.join(this.dirs.sessions, `${id}.json`), null);
      if (s?.id) this.meta.set(s.id, this.#metaOf(s));
    }
    for (const m of this.meta.values()) m.running = false; // 재시작 직후엔 실행 중인 게 없다
    this.#saveIndexSoon();
    if (first) {
      for (const c of COLLECTIONS) this.#saveCol(c);
      this.saveSettings();
    }
    this.#migrate();
    return this;
  }

  // 예전 형식 데이터를 새 형식으로(안전하게 여러 번 실행돼도 같은 결과)
  #migrate() {
    let dirty = false;
    for (const a of this.cols.agents) {
      // 지원을 끝낸 프로바이더(안티그래비티)를 쓰던 에이전트는 자동 라우팅으로 바꾼다
      if (a.provider === 'antigravity') { a.provider = 'claude'; a.model = ''; a.routing = 'auto'; a.routingProfile ||= 'balanced'; dirty = true; }
      if (!a.routing) { a.routing = 'manual'; dirty = true; }
    }
    if (dirty) this.#saveCol('agents');
    const team = this.get('teams', 'team-default');
    if (team && /안티그래비티/.test(team.description || '')) {
      team.description = seedData().teams.find((x) => x.id === 'team-default').description;
      this.#saveCol('teams');
    }
  }

  #file(name) { return path.join(this.dirs.home, `${name}.json`); }
  #saveCol(c) { writeAtomic(this.#file(c), JSON.stringify(this.cols[c], null, 2)); }

  all(c) { return this.cols[c]; }
  get(c, id) { return this.cols[c].find((x) => x.id === id) || null; }

  upsert(c, obj, prefix = c.slice(0, -1)) {
    const list = this.cols[c];
    const now = Date.now();
    if (!obj.id) obj.id = newId(prefix);
    const i = list.findIndex((x) => x.id === obj.id);
    if (i >= 0) list[i] = { ...list[i], ...obj, updatedAt: now };
    else list.push({ createdAt: now, ...obj, updatedAt: now });
    this.#saveCol(c);
    return list[i >= 0 ? i : list.length - 1];
  }

  remove(c, id) {
    const before = this.cols[c].length;
    this.cols[c] = this.cols[c].filter((x) => x.id !== id);
    if (this.cols[c].length !== before) this.#saveCol(c);
    return before !== this.cols[c].length;
  }

  saveSettings() { if (!this.closed) writeAtomic(this.#file('settings'), JSON.stringify(this.settings, null, 2)); }
  saveUsage() {
    if (this.closed) return;
    try { writeAtomic(this.#file('usage'), JSON.stringify(this.usage, null, 2)); } catch (e) { console.error('[사용량 저장 실패]', e.message); }
  }

  // ── 세션 ──
  #indexFile() { return path.join(this.dirs.sessions, 'index.json'); }
  #saveIndexSoon() {
    clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => {
      if (this.closed) return;
      try { writeAtomic(this.#indexFile(), JSON.stringify(Object.fromEntries(this.meta))); } catch (e) { console.error('[목록 저장 실패]', e.message); }
    }, 300);
    this.indexTimer.unref?.();
  }

  // 디스크에서 읽은 세션의 "실행 중" 흔적은 이전 실행이 끊긴 것이므로 정리
  #fixStale(s) {
    for (const r of s.runs || []) if (['running', 'paused', 'waiting'].includes(r.status)) { r.status = 'stopped'; r.endedAt ||= Date.now(); r.hold = null; }
    for (const m of s.messages || []) if (m.status === 'streaming' || m.status === 'queued') m.status = 'stopped';
    return s;
  }

  #evict() {
    for (const [id] of this.sessions) {
      if (this.sessions.size <= MAX_CACHE) break;
      if (this.pinned.has(id) || this.timers.has(id)) continue;
      this.sessions.delete(id);
    }
  }

  pin(id) { this.pinned.add(id); }
  unpin(id) { this.pinned.delete(id); this.#evict(); }
  hasSession(id) { return this.meta.has(id); }

  #metaOf(s) {
    const last = s.messages[s.messages.length - 1];
    return {
      id: s.id, title: s.title, teamId: s.teamId, agentId: s.agentId, cwd: s.cwd,
      pinned: !!s.pinned, createdAt: s.createdAt, updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      preview: last ? String(last.text || '').slice(0, 80) : '',
      running: s.runs.some((r) => ['running', 'paused', 'waiting'].includes(r.status)),
    };
  }

  sessionMeta(s) {
    const m = this.#metaOf(s);
    if (this.meta.has(s.id) || this.sessions.has(s.id)) { this.meta.set(s.id, m); this.#saveIndexSoon(); }
    return m;
  }

  listSessions() {
    return [...this.meta.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSession(id) {
    const hit = this.sessions.get(id);
    if (hit) { this.sessions.delete(id); this.sessions.set(id, hit); return hit; } // 최근 사용으로 갱신
    if (!this.meta.has(id) || !/^[\w-]+$/.test(id)) return null;
    const s = readJson(path.join(this.dirs.sessions, `${id}.json`), null);
    if (!s?.id) return null;
    this.sessions.set(id, this.#fixStale(s));
    this.#evict();
    return s;
  }

  createSession(data = {}) {
    const now = Date.now();
    const s = {
      id: newId('s'), title: data.title || tr('새 세션'), teamId: data.teamId ?? null, agentId: data.agentId ?? null,
      cwd: data.cwd || '', pinned: false, createdAt: now, updatedAt: now,
      providerSessions: {}, messages: [], runs: [],
    };
    this.sessions.set(s.id, s);
    this.meta.set(s.id, this.#metaOf(s));
    this.saveSessionNow(s);
    this.#evict();
    return s;
  }

  // 출력이 계속 들어와도 늦어도 delay 안에는 저장되게: 이미 더 이른 저장이 예약돼 있으면 그대로 둔다
  saveSession(s, delay = 400) {
    s.updatedAt = Date.now();
    if (this.closed) return;
    const due = Date.now() + delay;
    const cur = this.timers.get(s.id);
    if (cur && cur.due <= due) return;
    if (cur) clearTimeout(cur.t);
    this.timers.set(s.id, { due, t: setTimeout(() => this.saveSessionNow(s), delay) });
  }

  saveSessionNow(s) {
    const cur = this.timers.get(s.id);
    if (cur) clearTimeout(cur.t);
    this.timers.delete(s.id);
    if (this.closed || !this.meta.has(s.id)) return;
    try {
      writeAtomic(path.join(this.dirs.sessions, `${s.id}.json`), JSON.stringify(s));
      this.meta.set(s.id, this.#metaOf(s));
      this.#saveIndexSoon();
    } catch (e) {
      // 백신 등이 파일을 잡고 있어도 서버는 계속 돌고, 잠시 뒤 다시 저장한다
      console.error('[저장 실패, 2초 뒤 재시도]', e.message);
      this.timers.set(s.id, { due: Date.now() + 2000, t: setTimeout(() => this.saveSessionNow(s), 2000) });
    }
  }

  deleteSession(id) {
    clearTimeout(this.timers.get(id)?.t);
    this.timers.delete(id);
    this.sessions.delete(id);
    this.meta.delete(id);
    this.pinned.delete(id);
    fs.rmSync(path.join(this.dirs.sessions, `${id}.json`), { force: true });
    this.#saveIndexSoon();
  }

  flush() {
    for (const id of [...this.timers.keys()]) {
      const s = this.sessions.get(id);
      if (s) this.saveSessionNow(s);
    }
  }

  // 종료: 남은 저장을 끝내고 이후 쓰기는 막는다
  close() {
    this.flush();
    this.saveUsage();
    clearTimeout(this.indexTimer);
    try { writeAtomic(this.#indexFile(), JSON.stringify(Object.fromEntries(this.meta))); } catch { /* 종료 중 */ }
    this.closed = true;
  }
}
