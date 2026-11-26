// 사용량 표시(오른쪽 아래 고정): 어느 화면에서든 계정 한도와 오늘 쓴 토큰을 본다. 누르면 펼쳐진다.
// 오늘 토큰은 실행 중 계속 오르고, 한도 %는 CLI가 실행될 때 받은 마지막 값이다
import { useState } from 'preact/hooks';
import { html, Icon, ProviderChip, fmtTok, fmtCost } from '../ui.js';
import { state, go } from '../state.js';
import { Limits, usageTip } from './session.js';
import { weighted, livePeak } from '../usage-numbers.js';
import { t } from '../i18n/index.js';

const SHORT = { claude: 'Claude', codex: 'GPT', gemini: 'Gemini', hermes: 'Hermes', openai: 'API', local: 'local', acp: 'ACP' };
const shortName = (id) => SHORT[id] || (String(id).startsWith('codex-') ? 'GPT+' : id);
const level = (pct) => (pct >= 90 ? ' high' : pct >= 60 ? ' mid' : '');

export function UsageDock() {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('ui.dock') === '1'; } catch { return false; } });
  const toggle = (v) => { setOpen(v); try { localStorage.setItem('ui.dock', v ? '1' : '0'); } catch { /* 저장소가 막혀도 이번 화면에선 동작 */ } };
  const lim = state.usage?.limits || {};
  const today = Object.fromEntries(Object.entries(state.usage?.today || {}).filter(([p]) => p !== 'mock')); // 가상 AI(mock)는 화면에 보이지 않는다(결정 0021)
  // 오늘 토큰은 환산(결정 0026: 새 입력 + 캐시 쓰기 + 출력 + 캐시 읽기÷10). 나눈 값은 도움말에
  const sum = Object.values(today).reduce((a, v) => { for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) a[k] += v[k] || 0; return a; }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const total = weighted(sum);
  // AI마다 가장 많이 찬 한도 창 하나만 알약에 보인다. 이미 지난 창은 빼고, 그 AI 의 창이 전부 지났으면 "—"(빨강·노랑 없이)
  const now = Date.now();
  const peaks = Object.entries(lim)
    .map(([p, v]) => [p, livePeak(v, now), Object.values(v.windows || {}).some((w) => typeof w?.pct === 'number')])
    .filter(([, pct, any]) => pct !== null || any);

  if (!open) {
    return html`<button class="usage-dock pill" onClick=${() => toggle(true)} title=${t('사용량 펼치기')} aria-label=${t('사용량 펼치기')}>
      <${Icon} name="chart" />
      ${peaks.map(([p, pct]) => html`<span class=${`ud-p${pct === null ? ' passed' : level(pct)}`}><i></i>${shortName(p)} <b>${pct === null ? '—' : `${pct}%`}</b></span>`)}
      <span class="ud-today" title=${usageTip(sum)}>${t('오늘 환산 {n}', { n: fmtTok(total) })}</span>
    </button>`;
  }
  return html`<div class="usage-dock open" role="region" aria-label=${t('사용량')}>
    <div class="ud-head">
      <b><${Icon} name="chart" /> ${t('사용량')}</b>
      <span class="grow"></span>
      <button class="btn sm ghost" onClick=${() => go('usage')}>${t('자세히 보기')}</button>
      <button class="icon-btn" title=${t('사용량 접기')} aria-label=${t('사용량 접기')} onClick=${() => toggle(false)}><${Icon} name="x" /></button>
    </div>
    <div class="ud-body">
      <div class="ud-sec">${t('계정 한도')} <span class="small muted">${t('(실행할 때마다 갱신)')}</span></div>
      <${Limits} lim=${lim} />
      <div class="ud-sec">${t('오늘 (모든 세션)')}</div>
      ${Object.entries(today).map(([p, v]) => html`<div class="stat" title=${usageTip(v)}><span><${ProviderChip} id=${p} /></span><span>${t('환산 {n} 토큰', { n: fmtTok(weighted(v)) })} ${fmtCost(v.cost)} · ${t('{n}회', { n: v.calls })}</span></div>`)}
      ${!Object.keys(today).length && html`<div class="muted small">${t('오늘 기록 없음')}</div>`}
    </div>
  </div>`;
}
