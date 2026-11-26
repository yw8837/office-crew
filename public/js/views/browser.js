// 웹 브라우저 쓰기 화면(결정 0029): 에이전트 편집의 스위치, 설정의 전역 켜기·허용 도메인, 세션 오른쪽 패널의 "브라우저" 탭, 도구 블록의 작은 그림.
// 실시간 영상이 아니라 에이전트가 찍은 화면(스크린샷)을 보여 준다
import { useEffect, useState } from 'preact/hooks';
import { html, Modal, Toggle } from '../ui.js';
import { state, toast, agentById, providerById } from '../state.js';
import { browserUrl } from '../api.js';
import { t, locale } from '../i18n/index.js';

const RECENT = 20; // 넘겨 볼 수 있는 최근 화면 수

// 세션에서 찍힌 화면(오래된 것부터): 에이전트 답의 도구 블록에 붙은 shot 을 모은다
export function browserShots(s) {
  const out = [];
  for (const m of s?.messages || []) {
    if (m.role !== 'agent') continue;
    for (const b of m.blocks || []) if (b.shot?.file) out.push({ ...b.shot, msgId: m.id, blockId: b.id });
  }
  return out.sort((x, y) => (x.at || 0) - (y.at || 0));
}
// 이 세션에서 브라우저를 받은 실행이 있었나(탭을 보일지)
export const browserUsed = (s) => (s?.messages || []).some((m) => m.browser || (m.blocks || []).some((b) => b.shot));
const keyOf = (x) => `${x.agentId}/${x.file}`;
const srcOf = (sid, x) => browserUrl(sid, x.agentId, x.file);

// 본 화면의 시각(세션마다, 이 브라우저에만). 탭의 점 표시에 쓴다
const seenKey = (sid) => `browserSeen:${sid}`;
function seenAt(sid) { try { return Number(localStorage.getItem(seenKey(sid))) || 0; } catch { return 0; } }
function markSeen(sid, at) { try { if (at > seenAt(sid)) localStorage.setItem(seenKey(sid), String(at)); } catch { /* 저장 못 해도 화면은 그대로 */ } }

function when(at) {
  return at ? new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
}

// 그림(지워진 파일이면 안내 글)
function ShotImg({ sid, shot, cls = '' }) {
  const [gone, setGone] = useState(false);
  useEffect(() => setGone(false), [keyOf(shot)]);
  if (gone) return html`<div class=${`bshot-gone ${cls}`}>${t('이 화면 파일은 지워졌어(폴더 상한).')}</div>`;
  return html`<img class=${cls} src=${srcOf(sid, shot)} alt=${shot.title || t('브라우저 화면')} loading="lazy" onError=${() => setGone(true)} />`;
}

// 크게 보기
function BigShot({ sid, shot, onClose }) {
  return html`<${Modal} title=${shot.title || shot.url || t('브라우저 화면')} onClose=${onClose} size="wide">
    <div class="bshot-big"><${ShotImg} sid=${sid} shot=${shot} /></div>
    ${shot.url && html`<div class="bshot-url mono">${shot.url}</div>`}
  </${Modal}>`;
}

// 오른쪽 패널의 탭 단추(새 화면이 있으면 점)
export function BrowserTabButton({ s, on, onClick }) {
  const latest = browserShots(s).at(-1)?.at || 0;
  const dot = !on && latest > seenAt(s.id);
  return html`<button class=${on ? 'on' : ''} onClick=${onClick}>${t('브라우저')}${dot ? html`<span class="bshot-dot" role="img" aria-label=${t('새 화면')}></span>` : ''}</button>`;
}

// 오른쪽 패널의 "브라우저" 탭: 가장 새 화면, 주소·제목·시각·에이전트, 이전 화면 넘겨 보기(최근 20장), 누르면 크게
export function BrowserTab({ s }) {
  const shots = browserShots(s).slice(-RECENT);
  const [pick, setPick] = useState(null); // 고른 화면(null 이면 늘 가장 새 것)
  const [big, setBig] = useState(false);
  const latest = shots.at(-1);
  useEffect(() => { markSeen(s.id, latest?.at || 0); }, [s.id, latest?.at]);
  useEffect(() => { setPick(null); setBig(false); }, [s.id]);
  const note = html`<div class="small muted bshot-note">${t('에이전트가 찍은 화면이야(실시간 영상 아님). 새로 찍을 때마다 바뀌어.')}</div>`;
  if (!shots.length) return html`<div class="bshot">${note}<div class="muted small">${t('아직 찍은 화면이 없어. 브라우저를 쓰는 에이전트가 화면을 찍으면 여기에 보여.')}</div></div>`;
  let i = pick ? shots.findIndex((x) => keyOf(x) === pick) : -1;
  if (i < 0) i = shots.length - 1;
  const cur = shots[i];
  const go = (j) => setPick(j >= shots.length - 1 ? null : keyOf(shots[j]));
  return html`<div class="bshot">
    ${note}
    <button type="button" class="bshot-frame" title=${t('크게 보기')} onClick=${() => setBig(true)}><${ShotImg} sid=${s.id} shot=${cur} /></button>
    <div class="bshot-meta">
      <div class="bshot-title">${cur.title || t('(제목 없음)')}</div>
      <div class="bshot-url mono">${cur.url || t('(주소 없음)')}</div>
      <div class="small muted">${when(cur.at)} · ${agentById(cur.agentId)?.name || t('지운 에이전트')}</div>
    </div>
    <div class="bshot-nav">
      <button type="button" class="btn sm" disabled=${i === 0} onClick=${() => go(i - 1)}>◀ ${t('이전')}</button>
      <span class="small muted">${i + 1} / ${shots.length}</span>
      <button type="button" class="btn sm" disabled=${i === shots.length - 1} onClick=${() => go(i + 1)}>${t('다음')} ▶</button>
    </div>
    ${pick && html`<button type="button" class="btn sm ghost" onClick=${() => setPick(null)}>${t('가장 새 화면으로')}</button>`}
    ${big && html`<${BigShot} sid=${s.id} shot=${cur} onClose=${() => setBig(false)} />`}
  </div>`;
}

// 도구 블록 아래의 작은 그림(그 호출 뒤에 찍힌 화면). 누르면 크게
export function ShotThumb({ b }) {
  const [big, setBig] = useState(false);
  const sid = state.currentId;
  if (!sid || !b.shot?.file) return '';
  return html`<button type="button" class="bshot-thumb" title=${b.shot.url || t('크게 보기')} onClick=${() => setBig(true)}><${ShotImg} sid=${sid} shot=${b.shot} /></button>
    ${big && html`<${BigShot} sid=${sid} shot=${b.shot} onClose=${() => setBig(false)} />`}`;
}

// 에이전트 편집의 스위치. 그 AI 가 못 받으면 흐리게 + 이유. 켤 때 한 번 안내
export function BrowserSwitch({ a, set }) {
  const [told, setTold] = useState(false);
  const prov = providerById(a.provider);
  const auto = a.routing === 'auto';
  const can = auto || !!prov?.caps?.browser;
  const why = can ? '' : prov?.caps?.connectors ? t('이 AI에서는 위험한 브라우저 도구(임의 코드 실행 등)를 앱이 막을 수 없어서 붙이지 않아.') : t('이 AI는 커넥터(MCP 서버)를 받지 못해.');
  return html`<div class="field"><div class=${`row bswitch${can ? '' : ' off'}`}>
    <${Toggle} checked=${!!a.browser && can} disabled=${!can} title=${t('웹 브라우저 쓰기')} onChange=${(v) => { set('browser', v); if (v) setTold(true); }} />
    <div><b>${t('웹 브라우저 쓰기')}</b>
      <div class="hint">${can ? t('에이전트가 페이지를 열고, 누르고, 입력하고, 화면을 찍어. 찍은 화면은 세션 오른쪽 패널의 "브라우저" 탭에 보여. 따로 쓰는 빈 프로필이라 내 브라우저의 로그인은 쓰지 않아.') : why}</div>
      ${can && auto && html`<div class="hint">${t('자동 라우팅이면 실행 때 고른 AI가 Claude나 Codex일 때만 붙어.')}</div>`}
      ${can && a.browser && a.permission === 'plan' && html`<div class="hint">${t('권한이 읽기 전용이면 붙지 않아(페이지를 누르는 건 쓰기라서).')}</div>`}
      ${can && a.browser && state.settings.browserTool === false && html`<div class="hint">${t('설정 → 기본값에서 웹 브라우저 쓰기가 꺼져 있어서 지금은 붙지 않아.')}</div>`}
      ${told && html`<div class="infobox" style="margin-top:6px">${t('처음 쓸 때 Node.js 의 npx 가 Playwright MCP 패키지와 브라우저를 내려받아. 띄우는 건 이 AI의 CLI야. 내려받는 크기와 위치는 아직 확인하지 못했어.')}</div>`}
    </div>
  </div></div>`;
}

// 설정 → 기본값의 카드: 전역 켜기·끄기, 허용 도메인
export function BrowserSettings({ save }) {
  const s = state.settings;
  const [txt, setTxt] = useState((s.browserOrigins || []).join('\n'));
  const keep = () => save({ browserOrigins: txt }).then((ok) => { if (ok) { setTxt((state.settings.browserOrigins || []).join('\n')); toast(t('저장했어'), 'ok'); } });
  return html`<div class="card"><h4>${t('웹 브라우저 쓰기')}</h4>
    <div class="row"><${Toggle} checked=${s.browserTool !== false} onChange=${(v) => save({ browserTool: v })} title=${t('웹 브라우저 쓰기')} /><span>${t('에이전트 편집에서 스위치를 켠 에이전트가 웹 브라우저를 쓰게 해')}</span></div>
    <div class="field" style="margin-top:10px"><label>${t('허용 도메인 (줄마다 하나, 비우면 제한 없음)')}</label>
      <textarea class="textarea mono" rows="3" value=${txt} placeholder="https://example.com" onInput=${(e) => setTxt(e.target.value)}></textarea>
      <div class="row" style="margin-top:6px"><button class="btn sm" onClick=${keep}>${t('저장')}</button></div>
      <div class="hint">${t('Playwright MCP 문서에 따르면 이 목록은 보안 경계가 아니야. 다른 주소로 넘겨주는 것(리디렉트)은 막지 못해. 에이전트가 갈 곳을 줄이는 정도로만 써.')}</div>
    </div>
  </div>`;
}
