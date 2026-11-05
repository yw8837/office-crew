// 라우팅 보드: 모든 에이전트의 AI·모델·노력·권한을 한 표에서 드롭다운으로 정한다(기본은 자동, 필요할 때만 직접)
import { useEffect, useState } from 'preact/hooks';
import { html, Icon, Avatar, ProviderChip, PERM_LABEL, EFFORT_LABEL, providerColor, PROVIDER_SHORT, Toggle } from '../ui.js';
import { state, changed, toast } from '../state.js';
import { get, post, put, del } from '../api.js';
import { PageHead } from './manage.js';
import { t, tmap, locale } from '../i18n/index.js';

export const PROFILE_LABEL = tmap(() => ({ economy: [t('경제'), t('빠르고 저렴한 모델·낮은 노력')], balanced: [t('균형'), t('역할에 맞는 모델·적당한 노력 (추천)')], best: [t('최고'), t('최상 모델·높은 노력 (사용량 많음)')] }));
const TIER_LABEL = tmap(() => ({ top: t('최상'), balanced: t('균형'), fast: t('빠름'), local: t('로컬') }));

// 카탈로그(로그인된 AI 의 모델 목록)를 한 번 받아 여러 화면이 같이 쓴다
export async function loadCatalog(force = false) {
  if (state.catalog && !force) return state.catalog;
  state.catalog = await get(`/api/routing/catalog${force ? '?refresh=1' : ''}`);
  state.catalog.at = Date.now();
  changed();
  return state.catalog;
}

export function modelOptions(providerId, { showLegacy = false } = {}) {
  const list = state.catalog?.models?.[providerId] || [];
  return list.filter((m) => !m.hidden && (showLegacy || !m.legacy));
}

// 노력 단계 옆 표시: CLI 에서 내가 기본으로 쓰는 값, 모델(또는 Claude Code)이 추천하는 값
function modelOf(providerId, modelId) { return (state.catalog?.models?.[providerId] || []).find((x) => x.id === modelId); }
export function effortTag(providerId, modelId, ef) {
  const m = modelOf(providerId, modelId);
  if (!m) return '';
  if (m.defaultEffort === ef && m.mine) return ` (${t('내 기본')})`;
  if (m.recommendedEffort === ef) return ` (${providerId === 'claude' ? t('추천') : t('기본')})`;
  return '';
}
export function effortNote(providerId, modelId, ef) {
  const m = modelOf(providerId, modelId);
  if (m?.defaultEffort === ef && m.mine) return t('CLI 설정에서 쓰는 노력 단계야.');
  if (m?.recommendedEffort === ef) return providerId === 'claude' ? t('Claude Code가 추천하는 단계야.') : t('이 모델의 기본 단계야.');
  return '';
}

export function effortOptions(providerId, modelId) {
  const m = (state.catalog?.models?.[providerId] || []).find((x) => x.id === modelId);
  const p = state.providers.find((x) => x.id === providerId);
  return m?.efforts?.length ? m.efforts : (p?.efforts || []);
}

// 자동 에이전트들의 "지금 실행하면" 미리보기
export function useRoutePreview(items) {
  const [map, setMap] = useState({});
  const key = items.map((i) => `${i.key}:${i.role}:${i.profile}`).join('|');
  useEffect(() => {
    if (!items.length) { setMap({}); return; }
    let alive = true;
    post('/api/routing/preview', { items }).then((r) => { if (alive) setMap(Object.fromEntries(r.map((x) => [x.key, x.route]))); }).catch(() => {});
    return () => { alive = false; };
  }, [key, state.catalog?.at]);
  return map;
}

export function routeText(r) {
  if (!r) return t('쓸 수 있는 AI 없음 — 로그인 확인');
  return `${PROVIDER_SHORT[r.provider] || r.provider} · ${r.modelLabel}${r.effort ? ` · ${EFFORT_LABEL[r.effort] || r.effort}` : ''}`;
}

async function saveAgent(a, patch) {
  try {
    await put(`/api/agents/${a.id}`, { ...a, ...patch });
  } catch (e) { toast(e.message, 'error'); }
}

export function RoutingPage() {
  const [loading, setLoading] = useState(!state.catalog);
  const [legacy, setLegacy] = useState(false);
  useEffect(() => { loadCatalog().catch((e) => toast(e.message, 'error')).finally(() => setLoading(false)); }, []);
  const agents = state.agents.filter((a) => a.provider !== 'mock' || a.routing === 'auto');
  const autos = agents.filter((a) => a.routing === 'auto');
  const preview = useRoutePreview(autos.map((a) => ({ key: a.id, role: a.role, profile: a.routingProfile || 'balanced' })));
  const ready = (state.catalog?.providers || state.providers).filter((p) => p.id !== 'mock');

  const refresh = async () => {
    setLoading(true);
    try {
      state.providers = await get('/api/providers?refresh=1');
      await loadCatalog(true);
      toast(t('AI 상태와 모델 목록을 새로 읽었어'), 'ok');
    } catch (e) { toast(e.message, 'error'); }
    setLoading(false);
  };
  const applyAll = async (mode, profile) => {
    try {
      const r = await post('/api/routing/apply', { mode, profile });
      toast(mode === 'auto' ? t('{n}명을 자동 라우팅({profile})으로 바꿨어', { n: r.changed.length, profile: PROFILE_LABEL[profile][0] }) : t('{n}명에게 지금 자동값을 고정했어 — 이제 직접 고칠 수 있어', { n: r.changed.length }), 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };

  return html`<div class="page"><div class="page-inner" style="max-width:1240px">
    <${PageHead} title=${t('라우팅')} desc=${t('에이전트마다 어떤 AI·모델·노력으로 일할지 한 화면에서 정해. 기본은 자동이고, 필요할 때만 직접 바꿔.')}>
      <button class="btn" disabled=${loading} onClick=${refresh}>${loading ? html`<span class="spin"></span>` : html`<${Icon} name="refresh" />`} ${t('모델 목록 새로고침')}</button>
    </${PageHead}>

    <div class="row wrap" style="gap:6px;margin-bottom:14px">
      ${ready.map((p) => html`<span class=${`chip ${p.loggedIn ? 'ok' : ''}`} title=${p.note || p.account || ''} style="cursor:default">
        <span class="pdot-inline" style=${`background:${p.loggedIn ? providerColor(p.id) : 'var(--faint)'}`}></span>${p.label}
        ${p.loggedIn ? ` · ${t('모델 {n}', { n: (state.catalog?.models?.[p.id] || []).filter((m) => !m.hidden && !m.legacy).length })}` : ` · ${t('꺼짐')}`}
        ${p.updatedFrom ? html`<b style="color:var(--accent-2)"> · ${t('업데이트됨')} ${p.updatedFrom}→${p.version}</b>` : ''}
        ${resting()[p.id] && html`<b style="color:var(--warn)"> · ⏸ ${restLabel(resting()[p.id])}</b>`}
      </span>`)}
      ${state.catalog?.at && html`<span class="small muted">· ${t('마지막 확인 {time} (30분마다 자동)', { time: new Date(state.catalog.at).toLocaleTimeString(locale()) })}</span>`}
    </div>

    <div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <b>${t('한 번에:')}</b>
      ${Object.entries(PROFILE_LABEL).map(([k, [l, d]]) => html`<button class="btn sm" title=${d} onClick=${() => applyAll('auto', k)}><${Icon} name="spark" /> ${t('모두 자동')} · ${l}</button>`)}
      <span class="grow" style="flex:1"></span>
      <button class="btn sm" title=${t('지금 자동으로 골라지는 값을 직접 설정으로 고정(그 다음 원하는 칸만 고치기)')} onClick=${() => applyAll('fill', 'balanced')}><${Icon} name="pin" /> ${t('자동값을 직접 설정으로 고정')}</button>
      <label class="row small" style="gap:6px"><input type="checkbox" checked=${legacy} onChange=${(e) => setLegacy(e.target.checked)} /> ${t('구형·고정 모델도 보기')}</label>
    </div>

    <${FailoverCard} />
    <${BudgetCard} />

    <div class="list rtable">
      <div class="rrow rhead"><span>${t('에이전트')}</span><span>${t('방식')}</span><span>AI</span><span>${t('모델')}</span><span>${t('노력')}</span><span>${t('권한')}</span></div>
      ${agents.map((a) => html`<${RoutingRow} key=${a.id} a=${a} legacy=${legacy} preview=${preview[a.id]} />`)}
    </div>
    <div class="hint" style="margin-top:10px">${t('자동: 실행할 때마다 로그인된 AI 중에서 역할(조사·정리·분석·빌드·검수·글쓰기)에 맞는 모델·노력을 골라. 검수는 빌드와 다른 AI로 교차 확인해. 각 AI가 업데이트되면 새 모델이 목록에 자동으로 나타나.')}</div>
  </div></div>`;
}

function RoutingRow({ a, legacy, preview }) {
  const auto = a.routing === 'auto';
  const models = modelOptions(a.provider, { showLegacy: legacy });
  const known = models.some((m) => m.id === a.model);
  const efforts = effortOptions(a.provider, a.model);
  const ready = (state.catalog?.providers || state.providers).filter((p) => p.loggedIn && p.id !== 'mock');
  const setProvider = (pid) => {
    const first = modelOptions(pid)[0];
    const ef = effortOptions(pid, first?.id);
    saveAgent(a, { provider: pid, model: first?.id || '', effort: ef.includes(a.effort) ? a.effort : (ef.includes('medium') ? 'medium' : ef[0] || '') });
  };
  const setModel = (mid) => {
    const ef = effortOptions(a.provider, mid);
    saveAgent(a, { model: mid, effort: ef.includes(a.effort) ? a.effort : (ef.includes('medium') ? 'medium' : ef[0] || '') });
  };
  return html`<div class="rrow">
    <span class="row" style="gap:8px;min-width:0"><${Avatar} agent=${a} size=${28} /><span style="min-width:0"><b class="ellipsis">${a.name}</b><div class="small muted">${a.role || t('역할 없음')}</div></span></span>
    <span><select class="select sm" value=${auto ? 'auto' : 'manual'} onChange=${(e) => saveAgent(a, e.target.value === 'auto' ? { routing: 'auto' } : { routing: 'manual', ...(preview ? { provider: preview.provider, model: preview.model, effort: preview.effort } : {}) })}>
      <option value="auto">${t('자동')}</option><option value="manual">${t('직접')}</option></select></span>
    ${auto ? html`
      <span><select class="select sm" value=${a.routingProfile || 'balanced'} onChange=${(e) => saveAgent(a, { routingProfile: e.target.value })}>
        ${Object.entries(PROFILE_LABEL).map(([k, [l]]) => html`<option value=${k}>${l}</option>`)}</select></span>
      <span class="span2 small" style=${preview ? '' : 'color:var(--warn)'}>→ ${routeText(preview)}</span>`
    : html`
      <span><select class="select sm" value=${a.provider} onChange=${(e) => setProvider(e.target.value)}>
        ${!ready.some((p) => p.id === a.provider) && html`<option value=${a.provider}>${PROVIDER_SHORT[a.provider] || a.provider} (${t('꺼짐')})</option>`}
        ${ready.map((p) => html`<option value=${p.id}>${p.label}</option>`)}</select></span>
      <span><select class="select sm" value=${a.model} onChange=${(e) => setModel(e.target.value)}>
        ${!known && html`<option value=${a.model}>${a.model || t('(CLI 기본)')}</option>`}
        ${models.map((m) => html`<option value=${m.id} title=${[m.description, m.tier && TIER_LABEL[m.tier]].filter(Boolean).join(' · ')}>${m.label}${m.older ? ` (${t('이전 세대')})` : ''}</option>`)}</select></span>
      <span>${efforts.length ? html`<select class="select sm" value=${a.effort} onChange=${(e) => saveAgent(a, { effort: e.target.value })}>
        ${!efforts.includes(a.effort) && html`<option value=${a.effort}>${a.effort ? (EFFORT_LABEL[a.effort] || a.effort) : '-'}</option>`}
        ${efforts.map((ef) => html`<option value=${ef}>${EFFORT_LABEL[ef] || ef}</option>`)}</select>` : html`<span class="small muted">${t('없음')}</span>`}</span>`}
    <span><select class="select sm" value=${a.permission} onChange=${(e) => saveAgent(a, { permission: e.target.value })}>
      ${Object.entries(PERM_LABEL).map(([k, [l]]) => html`<option value=${k}>${l}</option>`)}</select></span>
  </div>`;
}

// 에이전트 편집기 안에 들어가는 라우팅 묶음(자동/직접 + 드롭다운)
export function RoutingFields({ a, set, setMany }) {
  const [legacy, setLegacy] = useState(false);
  const [custom, setCustom] = useState(false);
  useEffect(() => { loadCatalog().catch(() => {}); }, []);
  const auto = a.routing === 'auto';
  const preview = useRoutePreview(auto ? [{ key: 'x', role: a.role, profile: a.routingProfile || 'balanced' }] : [])?.x;
  const ready = (state.catalog?.providers || state.providers).filter((p) => p.id !== 'mock');
  const models = modelOptions(a.provider, { showLegacy: legacy });
  const efforts = effortOptions(a.provider, a.model);
  const pickProvider = (pid) => {
    const first = modelOptions(pid)[0];
    const ef = effortOptions(pid, first?.id);
    setMany({ provider: pid, model: first?.id || '', effort: ef.includes(a.effort) ? a.effort : (ef.includes('medium') ? 'medium' : ef[0] || '') });
    setCustom(false);
  };
  return html`
    <div class="field"><label>${t('라우팅')}</label>
      <div class="seg">
        <button class=${auto ? 'on' : ''} onClick=${() => set('routing', 'auto')}>✨ ${t('자동 (추천)')}</button>
        <button class=${!auto ? 'on' : ''} onClick=${() => setMany({ routing: 'manual', ...(preview ? { provider: preview.provider, model: preview.model, effort: preview.effort } : {}) })}>${t('직접 설정')}</button>
      </div>
    </div>
    ${auto ? html`
      <div class="field"><label>${t('자동 프로필')}</label>
        <div class="seg">${Object.entries(PROFILE_LABEL).map(([k, [l, d]]) => html`<button class=${(a.routingProfile || 'balanced') === k ? 'on' : ''} title=${d} onClick=${() => set('routingProfile', k)}>${l}</button>`)}</div>
        <div class="hint">${PROFILE_LABEL[a.routingProfile || 'balanced'][1]} · ${t('역할 "{role}" 기준', { role: a.role || t('일반') })}</div>
        <div class="infobox" style="margin-top:6px">${t('지금 실행하면 →')} <b>${routeText(preview)}</b><br /><span class="small muted">${t('실행할 때마다 그 순간 로그인된 AI로 다시 골라. 바꾸고 싶으면 "직접 설정"을 눌러(지금 값이 채워져).')}</span></div>
      </div>`
    : html`
      <div class="field"><label>AI</label>
        <div class="pick">${ready.map((p) => html`<span class=${`chip${a.provider === p.id ? ' on' : ''}`} title=${p.sub} onClick=${() => pickProvider(p.id)}>
          <span class="pdot-inline" style=${`background:${p.loggedIn ? providerColor(p.id) : 'var(--faint)'}`}></span>${p.label}${!p.installed ? ` (${t('미설치')})` : !p.loggedIn ? ` (${t('로그인 필요')})` : ''}</span>`)}</div>
      </div>
      <div class="grid2">
        <div class="field"><label>${t('모델')}</label>
          ${custom ? html`<input class="input mono" value=${a.model} onInput=${(e) => set('model', e.target.value)} placeholder=${t('모델 이름(고급)')} />`
            : html`<select class="select" value=${a.model} onChange=${(e) => { const ef = effortOptions(a.provider, e.target.value); setMany({ model: e.target.value, effort: ef.includes(a.effort) ? a.effort : (ef.includes('medium') ? 'medium' : ef[0] || '') }); }}>
                ${state.providers.find((p) => p.id === a.provider)?.kind === 'cli' && html`<option value="">${t('기본 (CLI 설정을 따름)')}</option>`}
                ${a.model && !models.some((m) => m.id === a.model) && html`<option value=${a.model}>${a.model}</option>`}
                ${models.map((m) => html`<option value=${m.id} title=${[m.description, m.tier && TIER_LABEL[m.tier]].filter(Boolean).join(' · ')}>${m.label}${m.older ? ` (${t('이전 세대')})` : ''}</option>`)}
              </select>`}
          <div class="row small" style="gap:10px;margin-top:4px">
            <label class="row" style="gap:4px"><input type="checkbox" checked=${legacy} onChange=${(e) => setLegacy(e.target.checked)} /> ${t('구형·고정 모델')}</label>
            <a href="#" class="muted" onClick=${(e) => { e.preventDefault(); setCustom(!custom); }}>${custom ? t('목록에서 고르기') : t('고급: 직접 입력')}</a>
          </div>
        </div>
        <div class="field"><label>${t('노력(effort)')}</label>
          ${efforts.length ? html`<div class="seg" style="flex-wrap:wrap" role="group" aria-label=${t('노력(effort)')}>${efforts.map((ef) => html`<button class=${a.effort === ef ? 'on' : ''} aria-pressed=${a.effort === ef} title=${effortNote(a.provider, a.model, ef)} onClick=${() => set('effort', ef)}>${EFFORT_LABEL[ef] || ef}${effortTag(a.provider, a.model, ef)}</button>`)}</div>
              ${a.provider === 'claude' && a.effort === 'max' && html`<div class="hint" style="color:var(--warn)">⚠ ${t('최대는 사용량을 크게 써(Claude Code 기준 3.5배 이상). 정말 어려운 일에만 써.')}</div>`}`
            : html`<div class="hint">${t('이 모델은 노력 단계를 따로 고르지 않아.')}</div>`}
        </div>
      </div>`}`;
}

// 쉬는 AI 중 아직 시간이 남은 것만(시간이 지나면 새로고침 없이도 사라지게)
const resting = () => Object.fromEntries(Object.entries(state.cooldown || {}).filter(([, c]) => c.until > Date.now()));
const restLabel = (c) => {
  const time = new Date(c.until).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  if (c.budget) return t('오늘 예산을 다 써서 {time}까지 피하는 중', { time });
  return c.near ? t('사용률이 기준을 넘어 {time}까지 피하는 중', { time }) : t('{time}까지 쉬는 중', { time });
};

// 하루 예산: 주간 한도를 하루 이틀에 다 쓰지 않게 하루 몫을 정한다(기본은 꺼짐)
function BudgetCard() {
  const st = state.settings;
  const on = st.dailyBudget === true;
  const pct = Number(st.dailyBudgetPercent) || 13;
  const save = (b) => put('/api/settings', b).catch((e) => toast(e.message, 'error'));
  // 자정이 지나 새 사용량이 아직 안 왔으면 어제 숫자를 오늘로 보여주지 않는다
  const spent = state.usage?.spentDay === new Date().toLocaleDateString('sv-SE') ? Object.entries(state.usage?.daySpent || {}) : [];
  return html`<div class="card" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <${Toggle} checked=${on} onChange=${(v) => save({ dailyBudget: v })} title=${t('하루 예산')} />
    <div style="flex:1;min-width:240px"><b>💰 ${t('하루 예산')}</b>
      <div class="hint">${t('주간 한도를 하루 이틀에 다 쓰지 않게 해. 오늘 쓰는 속도가 빠르면 노력을 낮추고, 하루 몫을 다 쓴 AI는 자정까지 다른 AI에게 맡겨. 맡을 AI가 없으면 낮은 노력으로 계속해. 주간 사용률을 아는 AI에만 적용돼.')}</div></div>
    <label class="row small" style="gap:6px">${t('하루 몫')}
      <select class="select sm" value=${String(pct)} disabled=${!on} onChange=${(e) => save({ dailyBudgetPercent: Number(e.target.value) })}>
        ${[...new Set([10, 13, 15, 20, 25, pct])].sort((a, b) => a - b).map((n) => html`<option value=${String(n)}>${t('주간의 {n}%', { n })}</option>`)}</select></label>
    ${on && spent.length > 0 && html`<div class="row wrap" style="gap:6px;width:100%">
      ${spent.map(([id, n]) => html`<span class=${`chip${n >= pct ? ' warn' : ''}`}>${PROVIDER_SHORT[id] || id} · ${t('오늘 {n}% / {pct}%', { n, pct })}</span>`)}
    </div>`}
  </div>`;
}

// 자동 이어받기: 한도에 걸리면 같은 역할의 다른 AI가 지금까지 쓴 내용을 이어받는다
function FailoverCard() {
  const st = state.settings;
  const on = st.failover !== false;
  const rest = Object.entries(resting());
  const th = Number(st.failoverThreshold) || 95;
  const save = (b) => put('/api/settings', b).catch((e) => toast(e.message, 'error'));
  const release = (id) => del(`/api/cooldown/${id}`).then((d) => { state.cooldown = d; changed(); }).catch((e) => toast(e.message, 'error'));
  return html`<div class="card" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <${Toggle} checked=${on} onChange=${(v) => save({ failover: v })} title=${t('자동 이어받기')} />
    <div style="flex:1;min-width:240px"><b>⚡ ${t('자동 이어받기')}</b>
      <div class="hint">${t('어떤 AI가 사용량 한도에 걸리면 작업을 멈추지 않고, 여유 있는 다른 AI가 같은 역할로 지금까지 쓴 내용을 이어받아 끝내.')}</div></div>
    <label class="row small" style="gap:6px">${t('미리 피하는 기준')}
      <select class="select sm" value=${String(st.failoverThreshold || 95)} disabled=${!on} onChange=${(e) => save({ failoverThreshold: Number(e.target.value) })}>
        ${[...new Set([80, 90, 95, 99, 100, th])].sort((a, b) => a - b).map((n) => html`<option value=${String(n)}>${n === 100 ? t('다 찼을 때만') : t('사용률 {n}% 이상', { n })}</option>`)}</select></label>
    ${rest.length > 0 && html`<div class="row wrap" style="gap:6px;width:100%">
      ${rest.map(([id, c]) => html`<span class="chip warn" title=${c.near ? '' : c.reason || ''}>⏸ ${PROVIDER_SHORT[id] || id} · ${restLabel(c)}
        <span class="x" role="button" title=${t('지금 다시 쓰기(한도가 풀렸거나 요금제를 올렸을 때)')} onClick=${() => release(id)}>✕</span></span>`)}
    </div>`}
  </div>`;
}
