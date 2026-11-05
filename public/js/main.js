// 앱 뼈대: 사이드바(세션·메뉴) + 메인 화면 라우팅 + 오른쪽 패널 + 토스트 + 단축키
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { html, Icon, ago } from './ui.js';
import { state, useStore, boot, go, changed, toast, currentSession } from './state.js';
import { post, patch, put, del } from './api.js';
import { SessionView, RightPanel } from './views/session.js';
import { AgentsPage, TeamsPage, ConnectorsPage, SkillsPage, PluginsPage } from './views/manage.js';
import { SettingsPage, UsagePage, PolicyNotice } from './views/settings.js';
import { RoutingPage } from './views/routing.js';
import { SchedulesPage } from './views/schedules.js';
import { WatchPage } from './views/watch.js';
import { BoardPage } from './views/board.js';
import { ImportModal } from './views/import.js';
import { t, setLang } from './i18n/index.js';

const NAV = () => [
  ['agents', 'bot', t('에이전트')], ['board', 'board', t('칸반 보드')], ['routing', 'spark', t('라우팅')], ['teams', 'users', t('팀 배치')], ['schedules', 'clock', t('예약 작업')], ['watch', 'eye', t('세션 구경')], ['connectors', 'plug', t('커넥터')], ['skills', 'file', t('스킬')],
  ['plugins', 'puzzle', t('플러그인')], ['usage', 'chart', t('사용량')], ['settings', 'gear', t('설정')],
];

export async function newSession(extra = {}) {
  try {
    const s = await post('/api/sessions', extra);
    state.sessions = [{ ...s, messageCount: 0, preview: '' }, ...state.sessions.filter((x) => x.id !== s.id)];
    go('session', s.id);
    if (innerWidth < 860) state.ui.side = false;
  } catch (e) { toast(e.message, 'error'); }
}

const openImport = () => { state.ui.importOpen = true; changed(); };
const closeImport = () => { state.ui.importOpen = false; changed(); };

// ── 기다리는 일: 승인·결정 대기, 오류로 멈춤, 일시정지, 끝난 지 하루 안 된 결과(열어 보면 확인한 걸로 친다) ──
const ATTN = () => ({ approve: ['✋', t('승인 필요')], decide: ['⚠️', t('결정 필요')], failed: ['🛑', t('오류로 멈춤')], paused: ['⏸️', t('일시정지됨')], done: ['✅', t('결과 확인')] });
const ATTN_ORDER = ['approve', 'decide', 'failed', 'paused', 'done'];
const DAY = 86400000;
const seenRuns = (() => { try { return new Set(JSON.parse(localStorage.getItem('ui.seen') || '[]')); } catch { return new Set(); } })();
function markSeen(a) {
  if (!a || !['done', 'failed'].includes(a.kind) || seenRuns.has(a.runId)) return;
  seenRuns.add(a.runId);
  try { localStorage.setItem('ui.seen', JSON.stringify([...seenRuns].slice(-300))); } catch { /* 저장소가 막혀도 이번 화면에선 숨긴다 */ }
}
function attentionList(sessions) {
  const now = Date.now();
  return sessions
    .filter((s) => s.attention && s.id !== state.route.id && !seenRuns.has(s.attention.runId) && (s.attention.kind !== 'done' || now - s.attention.since < DAY))
    .sort((a, b) => ATTN_ORDER.indexOf(a.attention.kind) - ATTN_ORDER.indexOf(b.attention.kind) || a.attention.since - b.attention.since);
}

function AttentionItem({ s }) {
  const [icon, label] = ATTN()[s.attention.kind] || ['•', ''];
  return html`<div class="sess attn" onClick=${() => { markSeen(s.attention); go('session', s.id); if (innerWidth < 860) { state.ui.side = false; changed(); } }} title=${s.preview}>
    <span class="attn-ic" aria-hidden="true">${icon}</span>
    <span class="t">${s.title}<small>${label}</small></span>
    <span class="small muted">${ago(s.attention.since)}</span>
  </div>`;
}

function SessionItem({ s }) {
  const [menu, setMenu] = useState(false);
  const on = state.route.view === 'session' && state.route.id === s.id;
  const running = state.active.has(s.id);
  const rename = async () => {
    const v = prompt(t('세션 이름'), s.title);
    if (v && v.trim()) await patch(`/api/sessions/${s.id}`, { title: v.trim() }).catch((e) => toast(e.message, 'error'));
  };
  const remove = async () => {
    if (!confirm(t("'{title}' 세션을 삭제할까? 대화 기록이 지워져.", { title: s.title }))) return;
    await del(`/api/sessions/${s.id}`).catch((e) => toast(e.message, 'error'));
  };
  return html`<div class=${`sess${on ? ' on' : ''}`} onClick=${() => { go('session', s.id); if (innerWidth < 860) { state.ui.side = false; changed(); } }} title=${s.preview}>
    ${running ? html`<span class="dot" title=${t('작업 중')}></span>` : s.pinned ? '📌' : ''}
    <span class="t">${s.title}</span>
    <span class="small muted">${ago(s.updatedAt)}</span>
    <button class="icon-btn more" style="width:24px;height:24px" title=${t('더보기')} onClick=${(e) => { e.stopPropagation(); setMenu(!menu); }}><${Icon} name="more" /></button>
    ${menu && html`<div class="popup" style="top:100%;bottom:auto;left:auto;right:0;width:150px" onMouseLeave=${() => setMenu(false)} onClick=${(e) => e.stopPropagation()}>
      <div class="it" onClick=${() => { setMenu(false); rename(); }}><${Icon} name="edit" /> ${t('이름 바꾸기')}</div>
      <div class="it" onClick=${() => { setMenu(false); patch(`/api/sessions/${s.id}`, { pinned: !s.pinned }); }}><${Icon} name="pin" /> ${s.pinned ? t('고정 해제') : t('고정')}</div>
      <div class="it" style="color:var(--err)" onClick=${() => { setMenu(false); remove(); }}><${Icon} name="trash" /> ${t('삭제')}</div>
    </div>`}
  </div>`;
}

function Sidebar() {
  const q = state.ui.search.toLowerCase();
  const list = state.sessions.filter((s) => !q || s.title.toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q));
  const pinned = list.filter((s) => s.pinned);
  const rest = list.filter((s) => !s.pinned);
  const okCount = state.providers.filter((p) => p.loggedIn && p.kind === 'cli').length;
  const waiting = q ? [] : attentionList(state.sessions);
  // 지금 보고 있는 세션의 결과·오류는 본 걸로 친다
  useEffect(() => { markSeen(state.sessions.find((s) => s.id === state.route.id)?.attention); });
  return html`<aside class="side">
    <div class="side-head"><div class="logo"><img src="/icon.svg" alt="" />${t('오피스 크루')}</div></div>
    <div class="side-actions">
      <button class="btn primary side-new" onClick=${() => newSession()}><${Icon} name="plus" /> ${t('새 세션')} <span class="kbd" style="color:#fff;opacity:.75;margin-left:auto">Ctrl+Shift+O</span></button>
      <button class="btn" title=${t('Claude Code·Codex에서 하던 세션 불러오기')} aria-label=${t('Claude Code·Codex에서 하던 세션 불러오기')} onClick=${openImport}><${Icon} name="download" /></button>
    </div>
    <div class="side-search"><input placeholder=${t('세션 검색')} value=${state.ui.search} onInput=${(e) => { state.ui.search = e.target.value; changed(); }} aria-label=${t('세션 검색')} /></div>
    <div class="side-list">
      ${waiting.length > 0 && html`<div class="side-label attn-label">${t('기다리는 일')} <span class="attn-n">${waiting.length}</span></div>${waiting.map((s) => html`<${AttentionItem} key=${`attn-${s.id}`} s=${s} />`)}`}
      ${pinned.length > 0 && html`<div class="side-label">${t('고정됨')}</div>${pinned.map((s) => html`<${SessionItem} key=${s.id} s=${s} />`)}`}
      <div class="side-label">${t('최근')}</div>
      ${rest.map((s) => html`<${SessionItem} key=${s.id} s=${s} />`)}
      ${!list.length && html`<div class="small muted" style="padding:8px">${q ? t('검색 결과 없음') : t('세션이 없어. 새 세션을 만들어봐.')}</div>`}
    </div>
    <div class="side-nav">
      ${NAV().map(([v, icon, label]) => html`<button class=${`nav${state.route.view === v ? ' on' : ''}`} onClick=${() => { go(v); if (innerWidth < 860) { state.ui.side = false; changed(); } }}><${Icon} name=${icon} />${label}</button>`)}
    </div>
    <div class="side-foot">
      ${state.providers.filter((p) => p.kind !== 'mock').map((p) => html`<span class=${`pdot${p.loggedIn ? ' ok' : p.installed ? ' warn' : ''}`} title=${`${p.label}: ${p.checking ? t('확인 중') : p.loggedIn ? t('사용 가능') : p.installed ? t('로그인 필요') : t('미설치')}${p.account ? ` · ${p.account}` : ''}`} onClick=${() => { state.ui.settingsTab = 'accounts'; go('settings'); }}><i></i>${{ claude: 'Claude', codex: 'GPT', gemini: 'Gemini', hermes: 'Hermes', openai: 'API', acp: 'ACP' }[p.id] || (p.base === 'codex' ? `GPT·${p.accountName}` : p.id)}</span>`)}
      <span class="small" style="width:100%">${t('{n}개 CLI 사용 가능', { n: okCount })}</span>
    </div>
  </aside>`;
}

function Home() {
  return html`<div class="page"><div class="page-inner"><div class="empty">
    <div style="font-size:52px">🏢</div>
    <h2>${t('오피스 크루에 온 걸 환영해')}</h2>
    <p>${t('Claude·ChatGPT(Codex)·Gemini·Hermes·로컬 모델을 한 사무실에 모아 팀으로 일 시켜봐.')}</p>
    <div class="row" style="justify-content:center;margin-top:16px;flex-wrap:wrap">
      <button class="btn primary" onClick=${() => newSession({ teamId: 'team-demo' })}>🎬 ${t('데모 팀으로 시작 (사용량 0)')}</button>
      <button class="btn" onClick=${() => newSession({ teamId: 'team-default' })}>👥 ${t('기본 팀으로 시작')}</button>
      <button class="btn" onClick=${openImport}>⬇️ ${t('하던 세션 불러오기')}</button>
      <button class="btn" onClick=${() => go('settings')}>🔑 ${t('AI 계정 확인')}</button>
    </div>
    ${!state.settings.policySeen && html`<div style="max-width:640px;margin:24px auto 0;text-align:left"><${PolicyNotice} onOk=${() => put('/api/settings', { policySeen: true }).catch((e) => toast(e.message, 'error'))} /></div>`}
  </div></div></div>`;
}

function App() {
  useStore();
  useEffect(() => {
    const k = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) { e.preventDefault(); newSession(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === '.') { e.preventDefault(); state.ui.right = !state.ui.right; changed(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); state.ui.side = !state.ui.side; changed(); }
      else if (e.key === 'Escape' && state.ui.inspector && !document.querySelector('.backdrop')) { state.ui.inspector = null; changed(); }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);

  if (state.error) return html`<div class="boot"><div style="text-align:center"><h2>${t('서버에 연결할 수 없어')}</h2><p class="muted">${state.error}</p><button class="btn" onClick=${() => location.reload()}>${t('다시 시도')}</button></div></div>`;
  if (!state.ready) return html`<div class="boot">${t('오피스 크루 준비 중…')}</div>`;

  const s = currentSession();
  const v = state.route.view;
  const sideOpen = state.ui.side !== false;
  let main;
  if (v === 'session') main = s ? html`<${SessionView} s=${s} />` : (state.route.id ? html`<div class="boot">${t('불러오는 중…')}</div>` : html`<${Home} />`);
  else if (v === 'agents') main = html`<${AgentsPage} />`;
  else if (v === 'routing') main = html`<${RoutingPage} />`;
  else if (v === 'teams') main = html`<${TeamsPage} />`;
  else if (v === 'schedules') main = html`<${SchedulesPage} />`;
  else if (v === 'watch') main = html`<${WatchPage} />`;
  else if (v === 'board') main = html`<${BoardPage} />`;
  else if (v === 'connectors') main = html`<${ConnectorsPage} />`;
  else if (v === 'skills') main = html`<${SkillsPage} />`;
  else if (v === 'plugins') main = html`<${PluginsPage} />`;
  else if (v === 'usage') main = html`<${UsagePage} />`;
  else if (v === 'settings') main = html`<${SettingsPage} />`;

  return html`<div class=${`app${sideOpen ? ' side-open' : ' no-side'}`}>
    <${Sidebar} />
    <div class="side-scrim" onClick=${() => { state.ui.side = false; changed(); }}></div>
    <main class="main">
      ${v !== 'session' && html`<div class="top" style="min-height:48px"><button class="icon-btn" title=${t('사이드바')} onClick=${() => { state.ui.side = !sideOpen; changed(); }}><${Icon} name="sidebar" /></button>${s && html`<button class="btn sm ghost" onClick=${() => go('session', s.id)}>← ${s.title}</button>`}</div>`}
      ${main}
    </main>
    ${v === 'session' && s && state.ui.right && html`<${RightPanel} s=${s} />`}
    ${state.ui.importOpen && html`<${ImportModal} onClose=${closeImport} onImported=${(id) => { closeImport(); go('session', id); toast(t('불러왔어. 이어서 말하면 같은 대화로 계속돼.'), 'ok'); }} />`}
    ${!state.connected && html`<div class="conn-lost">${t('서버 연결 끊김 — 다시 연결 중…')}</div>`}
    <div class="toasts">${state.ui.toasts.map((x) => html`<div class=${`toast ${x.kind}`}>${x.text}</div>`)}</div>
  </div>`;
}

if (innerWidth < 860) state.ui.side = false;
setLang(navigator.language); // 설정을 받기 전(부팅·연결 오류 화면)엔 브라우저 언어
render(html`<${App} />`, document.getElementById('app'));
boot();
