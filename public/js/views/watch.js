// 터미널 세션 구경: 터미널에서 돌리는 Claude Code·Codex 세션이 사무실에서 움직인다(사용량 0, 기록 파일만 읽음)
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, ago, officeMod, STATE_LABEL } from '../ui.js';
import { state, changed, uiLang } from '../state.js';
import { get } from '../api.js';
import { PageHead } from './manage.js';
import { t } from '../i18n/index.js';

const COLOR = { claude: '#d97757', codex: '#10a37f' };
const HAIR = ['short', 'bob', 'ponytail', 'long', 'spiky'];
const SKIN = ['#f2c9a6', '#e3b38f', '#f6d5bd', '#c98f68'];
const HAIRC = ['#3a2a1e', '#1d1d24', '#6b4226', '#b04a2f', '#222'];

const hash = (s) => [...String(s)].reduce((h, c) => ((h * 31) + c.charCodeAt(0)) >>> 0, 7);
// 세션마다 늘 같은 모습. 옷 색으로 어느 CLI 인지 보인다
const look = (w) => {
  const h = hash(w.id);
  return { skin: SKIN[h % SKIN.length], hair: HAIRC[(h >> 3) % HAIRC.length], hairStyle: HAIR[(h >> 6) % HAIR.length], outfit: COLOR[w.source] || '#888', accessory: 'none' };
};
const name = (w) => `${w.project} · ${w.source === 'codex' ? 'Codex' : 'Claude'}`;
const skinValue = () => {
  const custom = state.skins.find((k) => k.id === state.settings.skin);
  return custom || state.settings.skin || 'village';
};

export function WatchPage() {
  const [hidden, setHidden] = useState(0);
  const host = useRef(null);
  const office = useRef(null);
  const list = state.watch || [];
  // 최근 순으로 오는 목록을 그대로 쓰면 세션이 번갈아 일할 때마다 사무실이 다시 그려져서, 자리는 id 순으로 고정한다
  const seats = [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
  const key = seats.map((w) => `${w.id}:${w.project}`).join('|');
  const mod = officeMod.m;

  // 보고 있는 동안만 서버가 파일을 읽는다(20초마다 "보는 중"이라고 알린다)
  useEffect(() => {
    let alive = true;
    const ping = () => get('/api/watch').then((d) => { if (alive) { state.watch = d; changed(); } return get('/api/watch/hidden'); }).then((h) => { if (alive && h) setHidden(h.hidden); }).catch(() => {});
    ping();
    const timer = setInterval(ping, 20000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!mod || !host.current) return undefined;
    office.current = mod.createOffice(host.current, { skin: skinValue(), reducedMotion: !!state.settings.reducedMotion, lang: uiLang(), quality: state.settings.officeQuality || 'full', onSelect: () => {} });
    return () => { office.current?.destroy(); office.current = null; };
  }, [mod]);

  useEffect(() => {
    office.current?.setAgents(seats.map((w) => ({ id: w.id, name: name(w), role: w.source, model: w.model, color: COLOR[w.source] || '#888', avatar: look(w) })));
  }, [key, mod]);

  useEffect(() => { office.current?.setSkin(skinValue()); }, [state.settings.skin, state.skins.length]);

  useEffect(() => {
    for (const w of list) office.current?.setState(w.id, { state: w.state, text: w.detail, tool: w.tool, tokens: 0, badge: '' });
  }, [list, mod]);

  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('세션 구경')} desc=${t('터미널에서 돌리는 Claude Code·Codex 세션을 마을에서 봐. 기록 파일만 읽어서 사용량은 0이고, 이 화면을 보는 동안만 읽어.')} />
    <div class="office-wrap" style="height:min(56vh,520px);margin-bottom:14px">
      ${!mod && html`<div class="empty">${t('사무실 그래픽을 불러오는 중…')}</div>`}
      <div class="office-host" ref=${host}></div>
    </div>
    ${hidden > 0 && html`<div class="hint" style="margin-bottom:8px">${t('최근에 움직인 {max}개만 보여 줘. {n}개는 숨겨져 있어.', { max: list.length, n: hidden })}</div>`}
    ${list.length === 0 && html`<div class="card"><b>${t('최근 10분 안에 움직인 세션이 없어.')}</b><div class="hint">${t('터미널에서 Claude Code나 Codex를 돌리면 여기에 나타나. 기록 형식은 CLI 버전에 따라 바뀔 수 있어서, 모르는 내용은 건너뛰어.')}</div></div>`}
    ${list.map((w) => html`<div class="card" key=${w.id} style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class=${`chip${w.state === 'error' ? ' warn' : ''}`} style=${`border-color:${COLOR[w.source] || '#888'}`}>${w.source === 'codex' ? 'Codex' : 'Claude'}</span>
      <b>${w.project}</b>
      <span class="small muted">${STATE_LABEL[w.state] || w.state}${w.detail ? ` · ${w.detail}` : ''}</span>
      <span class="small muted" style="margin-left:auto">${w.at ? ago(w.at) : ''}</span>
    </div>`)}
  </div></div>`;
}
