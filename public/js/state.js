// 전역 상태 + 서버 이벤트 반영. 변경은 requestAnimationFrame 으로 묶어서 한 번만 다시 그린다
import { useEffect, useReducer } from 'preact/hooks';
import { get, connectEvents } from './api.js';
import { t, setLang, getLang } from './i18n/index.js';
import { setAccountNames } from './ui.js';

export const state = {
  ready: false, error: null, connected: false,
  version: '', home: '',
  agents: [], teams: [], sessions: [], settings: {}, providers: [], usage: {}, skills: [], connectors: [], plugins: [], skins: [], schedules: [], watch: [], tasks: [],
  active: new Set(),
  sessionData: {}, // id → 전체 세션
  live: {}, // sessionId → agentId → 상태
  route: { view: 'session', id: null },
  ui: { right: localStorage.getItem('ui.right') !== '0', inspector: null, toasts: [], modal: null, search: '' },
};

const subs = new Set();
const evSubs = new Set();
let scheduled = false;
let version = 0;
// requestAnimationFrame 은 창이 가려지면 멈추므로 타이머로 묶는다(약 60fps, 백그라운드에서도 갱신)
export function changed() {
  version++;
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => { scheduled = false; for (const fn of subs) fn(); }, 16);
}
export function useStore() {
  const [, force] = useReducer((x) => x + 1, 0);
  const seen = version;
  useEffect(() => {
    subs.add(force);
    // 구독 전에 바뀐 게 있으면(부팅 경쟁) 바로 다시 그린다
    if (version !== seen) force();
    return () => subs.delete(force);
  }, []);
  return state;
}
// 사무실 등 비-Preact 구독자: 서버 이벤트 원본을 그대로 받는다
export function onServerEvent(fn) { evSubs.add(fn); return () => evSubs.delete(fn); }

export function toast(text, kind = 'info', ms = 3200) {
  const id = Math.random().toString(36).slice(2);
  state.ui.toasts = [...state.ui.toasts, { id, text, kind }];
  changed();
  setTimeout(() => { state.ui.toasts = state.ui.toasts.filter((t) => t.id !== id); changed(); }, ms);
}

export function go(view, id = null) {
  state.route = { view, id };
  if (view === 'session' && id) {
    state.currentId = id;
    localStorage.setItem('ui.session', id);
    loadSession(id);
  }
  changed();
}

// 불러오는 동안 그 세션 이벤트가 오면(응답이 이미 옛날 값일 수 있음) 한 번 더 불러온다
const loading = new Map();
// 화면 언어: 설정값 → 브라우저 언어 → 영어
export function uiLang() {
  const l = (state.settings.lang || navigator.language || 'en').toLowerCase();
  return l.startsWith('ko') ? 'ko' : l.startsWith('zh') ? 'zh' : l.startsWith('ja') ? 'ja' : 'en';
}

// 브라우저 메모리 절약: 본 세션 본문은 최근 8개만 들고 있는다(지금 보는 것·실행 중인 것은 유지)
const CLIENT_CACHE = 8;
function trimCache() {
  const ids = Object.keys(state.sessionData);
  for (const id of ids) {
    if (Object.keys(state.sessionData).length <= CLIENT_CACHE) break;
    if (id === state.route.id || state.active.has(id)) continue;
    delete state.sessionData[id];
  }
}

export async function loadSession(id, force = false) {
  if (!id || (state.sessionData[id] && !force)) return state.sessionData[id];
  const mark = { dirty: false };
  loading.set(id, mark);
  try {
    let s = null;
    for (let i = 0; i < 3; i++) {
      mark.dirty = false;
      s = await get(`/api/sessions/${id}`);
      if (!mark.dirty) break;
    }
    for (const m of s.messages) m._v = 1;
    delete state.sessionData[id];
    state.sessionData[id] = s;
    trimCache();
    state.live[id] = { ...(state.live[id] || {}), ...(s.live || {}) };
    changed();
    return s;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  } finally {
    loading.delete(id);
  }
}

// 서버와 다시 연결되면 목록·실행 중 표시·보던 세션을 전부 새로 받는다(서버 재시작·이벤트 유실 대비)
async function resync() {
  try {
    const b = await get('/api/bootstrap');
    Object.assign(state, {
      agents: b.agents, teams: b.teams, sessions: b.sessions, settings: b.settings, providers: b.providers,
      usage: b.usage, skills: b.skills, connectors: b.connectors, plugins: b.plugins, skins: b.skins, schedules: b.schedules || [], tasks: b.tasks || [], active: new Set(b.active || []), cooldown: b.cooldown || {},
    });
    setAccountNames(state.providers);
    applyLang();
    const keep = state.route.id;
    for (const k of Object.keys(state.sessionData)) if (k !== keep) delete state.sessionData[k];
    if (keep && state.sessions.some((x) => x.id === keep)) await loadSession(keep, true);
    changed();
  } catch { /* 다음 재연결 때 다시 */ }
}

export const agentById = (id) => state.agents.find((a) => a.id === id);
export const teamById = (id) => state.teams.find((t) => t.id === id);
export const providerById = (id) => state.providers.find((p) => p.id === id);
export const currentSession = () => state.sessionData[state.route.id] || null;
export const latestRun = (s) => (s?.runs?.length ? s.runs[s.runs.length - 1] : null);

function findMsg(sid, mid) {
  return state.sessionData[sid]?.messages.find((m) => m.id === mid);
}

function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = { ...list[i], ...item };
  else list.unshift(item);
}

function handle(type, d) {
  if (d?.sessionId && loading.has(d.sessionId)) loading.get(d.sessionId).dirty = true;
  switch (type) {
    case 'session':
      upsert(state.sessions, d);
      state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      if (state.sessionData[d.id]) Object.assign(state.sessionData[d.id], { title: d.title, teamId: d.teamId, agentId: d.agentId, cwd: d.cwd, pinned: d.pinned });
      break;
    case 'sessionDeleted':
      state.sessions = state.sessions.filter((s) => s.id !== d.id);
      delete state.sessionData[d.id];
      if (state.route.id === d.id) state.route = { view: 'session', id: state.sessions[0]?.id || null };
      break;
    case 'message': {
      const s = state.sessionData[d.sessionId];
      if (!s) break;
      const i = s.messages.findIndex((m) => m.id === d.message.id);
      const m = { ...d.message, _v: (s.messages[i]?._v || 0) + 1 };
      if (i >= 0) s.messages[i] = m; else s.messages.push(m);
      break;
    }
    case 'delta': {
      const m = findMsg(d.sessionId, d.messageId);
      if (m) { m.text += d.text; m._v++; }
      break;
    }
    case 'block': {
      const m = findMsg(d.sessionId, d.messageId);
      if (!m) break;
      const i = m.blocks.findIndex((b) => b.id === d.block.id);
      if (i >= 0) m.blocks[i] = d.block; else m.blocks.push(d.block);
      m._v++;
      break;
    }
    case 'messageDone': {
      const m = findMsg(d.sessionId, d.messageId);
      if (m) { m.status = d.status; m.error = d.error; m.usage = d.usage; if (typeof d.text === 'string') m.text = d.text; m._v++; }
      break;
    }
    case 'messageUsage': { const m = findMsg(d.sessionId, d.messageId); if (m) { m.usage = d.usage; m._v++; } break; }
    case 'messageMeta': { const m = findMsg(d.sessionId, d.messageId); if (m) { m.model = d.model; if (d.provider) Object.assign(m, { provider: d.provider, effort: d.effort, failover: true }); m._v++; } break; }
    case 'cooldown': state.cooldown = d; break;
    case 'agentState':
      (state.live[d.sessionId] ||= {})[d.agentId] = d;
      break;
    case 'run': {
      const s = state.sessionData[d.sessionId];
      if (s) {
        const i = s.runs.findIndex((r) => r.id === d.run.id);
        if (i >= 0) s.runs[i] = d.run; else s.runs.push(d.run);
      }
      if (['running', 'paused', 'waiting'].includes(d.run.status) && !d.run.endedAt) state.active.add(d.sessionId);
      else state.active.delete(d.sessionId);
      if (d.run.status === 'waiting' && d.sessionId !== state.route.id) toast(d.run.hold?.reason === 'approve' ? t('다른 세션에서 승인이 필요해') : t('다른 세션에서 결정이 필요해'), 'warn');
      notifyRun(d.sessionId, d.run);
      break;
    }
    case 'usage': state.usage = d; break;
    case 'providers': state.providers = d; setAccountNames(d); break;
    case 'agents': state.agents = d; break;
    case 'teams': state.teams = d; break;
    case 'skills': state.skills = d; break;
    case 'connectors': state.connectors = d; break;
    case 'plugins': state.plugins = d; break;
    case 'skins': state.skins = d; break;
    case 'schedules': state.schedules = d; break;
    case 'watch': state.watch = d; break;
    case 'tasks': state.tasks = d; break;
    case 'skillKo': toast(d.saved ? t('스킬 설명 {n}개를 한글로 저장했어. 남은 것 {left}개.', { n: d.saved, left: d.missing }) : d.failed ? t('스킬 설명 번역이 끝나지 못했어. 세션을 확인해줘.') : t('번역 결과를 읽지 못했어. 세션의 답을 확인해줘.'), d.saved ? 'ok' : 'error'); break;
    case 'settings': state.settings = d; applyTheme(); applyLang(); break;
    case 'sessionsReset': resync(); break;
    default: break;
  }
}

// 데스크톱 알림: 창이 뒤에 있을 때만, 같은 실행의 같은 상태는 한 번만 띄운다
export async function askNotifyPermission() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

const notified = new Set();
function notifyRun(sessionId, run) {
  const title = {
    waiting: run.hold?.reason === 'approve' ? t('승인이 필요해') : t('결정이 필요해'),
    done: t('작업이 끝났어'),
    error: t('작업이 실패했어'),
  }[run.status];
  if (!title || !state.settings.desktopNotify || document.hasFocus()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const key = `${run.id}:${run.status}:${run.hold?.at ?? ''}`; // 같은 단계를 고친 뒤 다시 기다릴 때도 새로 알린다
  if (notified.has(key)) return;
  notified.add(key);
  const n = new Notification(title, { body: state.sessions.find((s) => s.id === sessionId)?.title || t('오피스 크루'), tag: `crew-${sessionId}` });
  n.onclick = () => { window.focus(); go('session', sessionId); n.close(); };
}

// 화면 언어 적용: 설정값(비면 브라우저 언어). 바뀌면 모델 목록(서버가 라벨을 번역)도 다시 받는다
export function applyLang() {
  const prev = getLang();
  setLang(state.settings.lang || navigator.language);
  document.title = t('오피스 크루');
  if (prev !== getLang() && state.catalog) {
    get('/api/routing/catalog').then((c) => { state.catalog = { ...c, at: Date.now() }; changed(); }).catch(() => {});
  }
}

export function applyTheme() {
  const t = state.settings.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#17171a' : '#f6f5f2');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

export async function boot() {
  try {
    const b = await get('/api/bootstrap');
    Object.assign(state, {
      version: b.version, home: b.home, agents: b.agents, teams: b.teams, sessions: b.sessions, settings: b.settings,
      providers: b.providers, usage: b.usage, skills: b.skills, connectors: b.connectors, plugins: b.plugins, skins: b.skins, schedules: b.schedules || [], tasks: b.tasks || [],
      active: new Set(b.active || []), cooldown: b.cooldown || {},
    });
    setAccountNames(state.providers);
    applyTheme();
    applyLang();
    connectEvents((type, d) => {
      handle(type, d);
      for (const fn of evSubs) { try { fn(type, d); } catch (e) { console.error(e); } }
      changed();
    }, (ok) => {
      const was = state.connected;
      state.connected = ok;
      // 재연결되면 전체를 다시 받아 빠진 이벤트를 메운다
      if (ok && !was && state.ready) resync();
      changed();
    });
    const last = localStorage.getItem('ui.session');
    const first = state.sessions.find((s) => s.id === last) || state.sessions[0];
    state.ready = true;
    if (first) go('session', first.id); else changed();
  } catch (e) {
    state.error = e.message;
    changed();
  }
}
