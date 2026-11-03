// 공용 UI 부품: 아이콘, 모달, 토글, 아바타, 숫자 포맷, 라벨
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import htm from 'htm';
import { changed } from './state.js';
import { t, tmap, locale } from './i18n/index.js';

export const html = htm.bind(h);

// 사무실 모듈(아바타 그리기 포함)은 늦게 불러와도 앱이 뜨게 한다
export const officeMod = { m: null };
import('./office/index.js').then((m) => { officeMod.m = m; changed(); }).catch((e) => console.warn('사무실 모듈 로드 실패', e));

const P = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  send: 'M5 12h13M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  clip: 'M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3',
  at: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm0 0v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1',
  slash: 'M15 4 9 20',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  bot: 'M12 8V4M8 4h8M5 8h14v11H5zM9 13h.01M15 13h.01M9 17h6',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  puzzle: 'M9 3h6v3a2 2 0 1 0 4 0V6h2v6h-3a2 2 0 1 0 0 4h3v5h-6v-3a2 2 0 1 0-4 0v3H3v-6h3a2 2 0 1 0 0-4H3V6h6z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  building: 'M4 21V5l8-3 8 3v16M9 21v-4h6v4M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M2 21h20',
  panel: 'M4 4h16v16H4zM15 4v16',
  sidebar: 'M4 4h16v16H4zM9 4v16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  play: 'M7 5l12 7-12 7z',
  pause: 'M8 5v14M16 5v14',
  skip: 'M5 5l10 7-10 7zM19 5v14',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6 6 18',
  down: 'M6 9l6 6 6-6',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5',
  split: 'M4 4h16v16H4zM4 11h16',
  msg: 'M4 5h16v11H8l-4 4z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  login: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  hand: 'M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0',
  pin: 'M12 17v5M9 3h6l-1 7 4 3H6l4-3z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 7v5l3 2',
};

export function Icon({ name, size }) {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style=${size ? `width:${size}px;height:${size}px` : ''} aria-hidden="true"><path d=${P[name] || P.info} /></svg>`;
}

export function Modal({ title, onClose, children, foot, size = '' }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose?.(); };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return html`<div class="backdrop" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div class=${`modal ${size}`} role="dialog" aria-modal="true" aria-label=${title}>
      <div class="modal-head"><h3>${title}</h3><button class="icon-btn" title=${t('닫기')} aria-label=${t('닫기')} onClick=${onClose}><${Icon} name="x" /></button></div>
      <div class="modal-body">${children}</div>
      ${foot && html`<div class="modal-foot">${foot}</div>`}
    </div>
  </div>`;
}

export function Toggle({ checked, onChange, title }) {
  return html`<label class="switch" title=${title}><input type="checkbox" aria-label=${title} checked=${!!checked} onChange=${(e) => onChange(e.target.checked)} /><span></span></label>`;
}

// 그림 아바타는 data URL 을 한 번만 blob URL 로 바꿔 둔다 → 메시지마다 큰 문자열을 다시 만들거나 DOM 에 복사하지 않음
const blobUrls = new Map();
function imageUrl(dataUrl) {
  let u = blobUrls.get(dataUrl);
  if (u) return u;
  try {
    const [head, b64] = dataUrl.split(',');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    u = URL.createObjectURL(new Blob([bytes], { type: head.slice(5, head.indexOf(';')) }));
  } catch { u = dataUrl; }
  if (blobUrls.size > 64) { for (const [k, v] of blobUrls) { if (v.startsWith('blob:')) URL.revokeObjectURL(v); blobUrls.delete(k); break; } }
  blobUrls.set(dataUrl, u);
  return u;
}

export function Avatar({ agent, size = 34 }) {
  const fn = officeMod.m?.renderAvatarSVG;
  if (agent && officeMod.m?.avatarKind?.(agent.avatar) === 'image') {
    const px = agent.avatar.pixel ? ';image-rendering:pixelated' : '';
    return html`<div class="avatar" style=${`width:${size}px;height:${size}px`}><img src=${imageUrl(agent.avatar.image)} alt="" style=${`width:100%;height:100%;object-fit:contain${px}`} /></div>`;
  }
  if (agent && fn) {
    let svg = '';
    try { svg = fn(agent.avatar || {}, { size, color: providerColor(agent.provider), id: agent.id }); } catch { svg = ''; }
    if (svg) return html`<div class="avatar" style=${`width:${size}px;height:${size}px`} dangerouslySetInnerHTML=${{ __html: svg }}></div>`;
  }
  return html`<div class="avatar" style=${`width:${size}px;height:${size}px;background:${agent?.avatar?.outfit || 'var(--panel-3)'}22`}><span class="em">${agent?.emoji || '🤖'}</span></div>`;
}

export const PROVIDER_COLORS = { claude: '#d97757', codex: '#10a37f', gemini: '#8e75ff', hermes: '#7c3aed', openai: '#0ea5e9', local: '#65a30d', acp: '#14b8a6', mock: '#64748b' };
export const providerColor = (id) => PROVIDER_COLORS[id] || '#888';
export const PROVIDER_SHORT = tmap(() => ({ claude: 'Claude', codex: 'GPT·Codex', gemini: 'Gemini', hermes: 'Hermes', openai: 'API', local: t('로컬'), acp: 'ACP', mock: t('데모') }));

export function ProviderChip({ id }) {
  return html`<span class="chip" style=${`background:${providerColor(id)}1f;color:${providerColor(id)}`}><span class="pdot-inline" style=${`background:${providerColor(id)}`}></span>${PROVIDER_SHORT[id] || id}</span>`;
}

export const STATE_LABEL = tmap(() => ({
  idle: t('대기'), thinking: t('생각 중'), typing: t('작성 중'), tool: t('도구 사용'), searching: t('검색 중'), reading: t('자료 읽는 중'),
  running: t('실행 중'), waiting: t('승인 대기'), error: t('오류'), done: t('완료'), paused: t('멈춤'), offline: t('자리 비움'),
}));
export const PERM_LABEL = tmap(() => ({
  plan: [t('읽기 전용'), t('계획·분석만, 파일 수정·명령 실행 안 함')],
  default: [t('기본'), t('위험한 작업은 자동 거부')],
  edit: [t('파일 편집 허용'), t('작업 폴더 안 편집 허용')],
  auto: [t('자동 판단'), t('CLI가 알아서 허용 여부 판단')],
  full: [t('전부 허용 ⚠'), t('모든 명령·편집 무승인 실행 (신뢰하는 작업만)')],
}));
export const EFFORT_LABEL = tmap(() => ({ none: t('없음'), minimal: t('미니멀'), low: t('로우'), medium: t('미디엄'), high: t('하이'), xhigh: t('X하이'), max: t('맥스'), ultra: t('울트라') }));

export function fmtTok(n = 0) {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
export const fmtCost = (c = 0) => (c >= 0.01 ? `$${c.toFixed(2)}` : c > 0 ? `$${c.toFixed(4)}` : '');
export function fmtDur(ms = 0) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? t('{s}초', { s }) : t('{m}분 {s}초', { m: Math.floor(s / 60), s: s % 60 });
}
export function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return t('방금');
  if (d < 3600) return t('{n}분 전', { n: Math.floor(d / 60) });
  if (d < 86400) return t('{n}시간 전', { n: Math.floor(d / 3600) });
  return new Date(ts).toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}
export function until(epochSec) {
  if (!epochSec) return '';
  const d = epochSec * 1000 - Date.now();
  if (d <= 0) return t('초기화됨');
  const hrs = Math.floor(d / 3600000);
  if (hrs >= 24) return t('{d}일 {h}시간 뒤 초기화', { d: Math.floor(hrs / 24), h: hrs % 24 });
  if (hrs >= 1) return t('{h}시간 {m}분 뒤 초기화', { h: hrs, m: Math.floor((d % 3600000) / 60000) });
  return t('{m}분 뒤 초기화', { m: Math.max(1, Math.floor(d / 60000)) });
}
// 에이전트의 모델 표시: 직접 설정이면 "모델 · 노력", 자동이면 "✨ 자동·프로필"(세션에서 실제로 고른 모델이 있으면 그걸)
const PROFILE_SHORT = tmap(() => ({ economy: t('경제'), balanced: t('균형'), best: t('최고') }));
export function agentModelText(a, s = null) {
  if (!a) return '';
  if (a.routing === 'auto') {
    const last = s?.messages ? [...s.messages].reverse().find((m) => m.agentId === a.id && m.model) : null;
    return last ? `✨ ${last.model}${last.effort ? ` · ${EFFORT_LABEL[last.effort] || last.effort}` : ''}` : `✨ ${t('자동')}·${PROFILE_SHORT[a.routingProfile] || t('균형')}`;
  }
  return [a.model || t('기본 모델'), EFFORT_LABEL[a.effort] || a.effort].filter(Boolean).join(' · ');
}

export const usageTotal = (u = {}) => (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);

export function confirmBox(text) { return window.confirm(text); }

/**
 * 사용자가 고른 그림 파일 → 작은 PNG data URL(긴 변 max px). 투명 배경 유지.
 * 긴 변이 128px 이하면 도트 그림으로 보고 pixel=true(화면에서 흐리지 않게 확대)
 */
export async function imageFileToDataURL(file, max = 256) {
  if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error(t('PNG·JPG·WEBP·GIF 그림만 올릴 수 있어.'));
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error(t('그림을 읽지 못했어.')));
      i.src = url;
    });
    const w = img.naturalWidth, hgt = img.naturalHeight;
    if (!w || !hgt) throw new Error(t('그림을 읽지 못했어.'));
    const k = Math.min(1, max / Math.max(w, hgt));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(hgt * k));
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = k < 1;
    g.drawImage(img, 0, 0, c.width, c.height);
    return { image: c.toDataURL('image/png'), pixel: Math.max(w, hgt) <= 128 };
  } finally {
    URL.revokeObjectURL(url);
  }
}
