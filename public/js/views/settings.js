// 설정(AI 계정 로그인·API 키·화면/사무실 스킨·기본값) + 사용량 화면
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Icon, Modal, Toggle, ProviderChip, providerColor, fmtTok, fmtCost, usageTotal, officeMod, EFFORT_LABEL, imageFileToDataURL } from '../ui.js';
import { state, changed, toast, applyTheme, applyLang, agentById, askNotifyPermission } from '../state.js';
import { get, post, put, patch, del } from '../api.js';
import { PageHead } from './manage.js';
import { Limits } from './session.js';
import { t, LANGS, getLang } from '../i18n/index.js';

async function saveSettings(patch) {
  try { state.settings = await put('/api/settings', patch); applyTheme(); applyLang(); changed(); return true; } catch (e) { toast(e.message, 'error'); return false; }
}

export function SettingsPage() {
  const tab = state.ui.settingsTab || 'accounts';
  const setTab = (k) => { state.ui.settingsTab = k; changed(); };
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('설정')} desc=${t('데이터 폴더: {home} · 버전 {version}', { home: state.home, version: state.version })} />
    <div class="tabs">
      ${[['accounts', t('AI 계정·로그인')], ['keys', t('API 키·로컬 모델')], ['look', t('화면·언어')], ['storage', t('저장공간·성능')], ['defaults', t('기본값')], ['about', t('정보')]].map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}
    </div>
    ${tab === 'accounts' && html`<${Accounts} />`}
    ${tab === 'keys' && html`<${Keys} />`}
    ${tab === 'look' && html`<${Look} />`}
    ${tab === 'storage' && html`<${Storage} />`}
    ${tab === 'defaults' && html`<${Defaults} />`}
    ${tab === 'about' && html`<${About} />`}
  </div></div>`;
}

function Accounts() {
  const [busy, setBusy] = useState({});
  const refresh = async (id) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try { await post(`/api/providers/${id}/refresh`); } catch (e) { toast(e.message, 'error'); }
    setBusy((b) => ({ ...b, [id]: false }));
  };
  const refreshAll = async () => { setBusy({ all: true }); try { state.providers = await get('/api/providers?refresh=1'); changed(); } catch (e) { toast(e.message, 'error'); } setBusy({}); };
  const addAccount = async () => {
    const name = prompt(t('추가할 ChatGPT 계정 이름(예: 회사 계정)'), t('계정 {n}', { n: (state.settings.codexAccounts || []).length + 2 }));
    if (name === null) return;
    try {
      const r = await post('/api/accounts/codex', { name });
      toast(t("'{name}' 계정을 만들었어. 그 줄의 로그인을 눌러 다른 ChatGPT 계정으로 로그인해.", { name: r.name }), 'ok', 7000);
    } catch (e) { toast(e.message, 'error'); }
  };
  const renameAccount = async (p) => {
    const name = prompt(t('계정 이름'), p.accountName);
    if (!name) return;
    try { await patch(`/api/accounts/codex/${p.id.slice(6)}`, { name }); } catch (e) { toast(e.message, 'error'); }
  };
  const removeAccount = async (p) => {
    if (!confirm(t("'{name}' 계정을 목록에서 뺄까? 이 계정을 쓰던 에이전트는 다른 AI로 바꿔야 해. 로그인 정보 폴더는 지우지 않아.", { name: p.accountName }))) return;
    try { await del(`/api/accounts/codex/${p.id.slice(6)}`); } catch (e) { toast(e.message, 'error'); }
  };
  const login = async (p) => {
    try {
      const r = await post(`/api/providers/${p.id}/login`);
      toast(r.ok ? t("터미널을 열었어 — {hint} 끝나면 '다시 확인'을 눌러.", { hint: r.hint }) : t('직접 터미널에서 실행해줘: {command}', { command: r.command }), 'info', 7000);
    } catch (e) { toast(e.message, 'error'); }
  };
  return html`
    <div class="infobox" style="margin-bottom:14px">${t('각 AI는 공식 CLI에 내 계정으로 로그인한 상태를 그대로 써 (비밀번호는 앱이 보지 않아). 로그인 버튼을 누르면 터미널이 열려. 구독 사용량·약관은 각 서비스 규정을 따라.')} <a href="#" onClick=${(e) => { e.preventDefault(); state.ui.settingsTab = 'about'; changed(); }}>${t('계정 사용 원칙 보기')}</a></div>
    <div class="row" style="margin-bottom:10px"><span class="grow" style="flex:1"></span><button class="btn" disabled=${busy.all} onClick=${refreshAll}><${Icon} name="refresh" /> ${t('전부 다시 확인')}</button></div>
    <div class="list">
      ${state.providers.map((p) => html`<div class="li-row pcard">
        <div class="plogo" style=${`background:${providerColor(p.id)}`}>${p.base === 'codex' && p.id !== 'codex' ? '+' : p.label.slice(0, 1)}</div>
        <div style="min-width:0">
          <div class="t">${p.label} ${p.version ? html`<span class="chip mono">${p.version}</span>` : ''}
            ${p.checking ? html`<span class="chip">${t('확인 중…')}</span>` : !p.installed ? html`<span class="chip err">${t('미설치')}</span>` : p.loggedIn ? html`<span class="chip ok">${t('사용 가능')}</span>` : html`<span class="chip warn">${t('로그인 필요')}</span>`}</div>
          <div class="d">${p.authMode === 'apikey' ? `${p.sub.split(' · ')[0]} · ${t('API 키')}` : p.sub}</div>
          ${p.account && html`<div class="d">👤 ${p.account}</div>`}
          ${p.note && html`<div class="d" style="color:var(--warn)">${p.note}</div>`}
          ${AUTH_PROVIDERS.includes(p.id) && html`<${AuthMode} p=${p} />`}
          ${p.id === 'codex' && html`<div class="d">${t('ChatGPT 계정이 여러 개면 "계정 추가"로 붙여. 한 계정이 한도에 걸리면 자동 이어받기가 다음 계정으로 넘겨.')}</div>`}
          <div class="d">${t('노력 단계: {list}', { list: (p.efforts || []).map((e) => EFFORT_LABEL[e] || e).join(' · ') || t('없음') })} · ${p.caps?.steer ? t('작업 중 지시 추가 ✓') : t('지시는 턴 끝나고 반영')} · ${p.caps?.images ? t('이미지 ✓') : t('이미지는 파일 경로로')}</div>
        </div>
        <div class="row">
          ${p.login && html`<button class="btn sm" onClick=${() => login(p)}><${Icon} name="login" /> ${t('로그인')}</button>`}
          ${p.id === 'codex' && html`<button class="btn sm" onClick=${addAccount}><${Icon} name="plus" /> ${t('계정 추가')}</button>`}
          ${p.base === 'codex' && p.id !== 'codex' && html`<button class="btn sm ghost" title=${t('이름 바꾸기')} aria-label=${t('이름 바꾸기')} onClick=${() => renameAccount(p)}><${Icon} name="edit" /></button>
            <button class="btn sm ghost" title=${t('계정 빼기')} aria-label=${t('계정 빼기')} onClick=${() => removeAccount(p)}><${Icon} name="trash" /></button>`}
          ${p.id === 'openai' || p.id === 'gemini' ? html`<button class="btn sm" onClick=${() => { state.ui.settingsTab = 'keys'; changed(); }}>${t('API 키')}</button>` : ''}
          <button class="btn sm ghost" disabled=${busy[p.id]} onClick=${() => refresh(p.id)}>${busy[p.id] ? html`<span class="spin"></span>` : t('다시 확인')}</button>
        </div>
      </div>`)}
    </div>`;
}

// Claude·Codex 결제 방식: 구독 로그인(기본) 또는 공식 API 키(사용한 만큼 과금)
const AUTH_PROVIDERS = ['claude', 'codex'];
function AuthMode({ p }) {
  const mode = state.settings.authMode?.[p.id] === 'apikey' ? 'apikey' : 'login';
  const set = async (m) => {
    if (m === mode) return;
    if (await saveSettings({ authMode: { ...(state.settings.authMode || {}), [p.id]: m } })) post(`/api/providers/${p.id}/refresh`).catch(() => {});
  };
  const keyName = p.id === 'claude' ? 'ANTHROPIC_API_KEY·ANTHROPIC_AUTH_TOKEN' : 'CODEX_API_KEY';
  return html`<div class="row small" style="gap:8px;margin-top:6px;flex-wrap:wrap">
    <span class="muted">${t('결제 방식')}</span>
    <div class="seg" role="tablist">
      <button class=${mode === 'login' ? 'on' : ''} onClick=${() => set('login')}>${t('구독 로그인')}</button>
      <button class=${mode === 'apikey' ? 'on' : ''} onClick=${() => set('apikey')}>${t('API 키')}</button>
    </div>
    <span class="muted">${mode === 'login'
      ? t('내 구독으로 실행해. PC에 {name} 환경변수가 있어도 무시해서 뜻밖의 API 과금을 막아.', { name: keyName })
      : html`${t('공식 API 키로 실행해(사용한 만큼 과금). 키는 API 키 탭에 넣어.')} <a href="#" onClick=${(e) => { e.preventDefault(); state.ui.settingsTab = 'keys'; changed(); }}>${t('키 넣으러 가기')}</a>`}</span>
  </div>`;
}

function Keys() {
  const [gem, setGem] = useState(state.settings.apiKeys?.gemini || '');
  const [ant, setAnt] = useState(state.settings.apiKeys?.anthropic || '');
  const [oai, setOai] = useState(state.settings.apiKeys?.openai || '');
  const [profiles, setProfiles] = useState(() => structuredClone(state.settings.apiProfiles || []));
  const [locals, setLocals] = useState(() => structuredClone(state.settings.localServers || []));
  const [acps, setAcps] = useState(() => structuredClone(state.settings.acpAgents || []));
  const [presets, setPresets] = useState([]);
  useEffect(() => { get('/api/acp/presets').then(setPresets).catch(() => {}); }, []);
  const setAcp = (i, k, v) => setAcps((as) => as.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const setLocal = (i, k, v) => setLocals((ls) => ls.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const upd = (i, k, v) => setProfiles((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const save = async () => {
    const localServers = locals.filter((l) => /^https?:\/\/.+:\d+/.test(l.baseUrl || ''));
    if (await saveSettings({ apiKeys: { ...(state.settings.apiKeys || {}), gemini: gem, anthropic: ant, openai: oai }, apiProfiles: profiles, localServers, acpAgents: acps.map((a) => ({ ...a, args: Array.isArray(a.args) ? a.args : String(a.args || '').split(/\s+/).filter(Boolean) })) })) {
      toast(t('저장했어'), 'ok');
      // 서버가 정한 id(새 항목)·가린 값으로 화면 상태를 맞춘다(다시 저장해도 id 가 바뀌지 않게)
      setAcps(structuredClone(state.settings.acpAgents || []));
      for (const p of ['openai', 'gemini', 'local', 'claude', 'codex', 'acp']) post(`/api/providers/${p}/refresh`).catch(() => {});
    }
  };
  return html`
    <div class="warnbox" style="margin-bottom:14px">${t('키는 이 PC의 데이터 폴더(settings.json)에만 저장되고 화면에는 끝 4자리만 보여. 플러그인 내보내기에도 안 들어가.')}</div>
    <div class="card"><h4>${t('Claude Code · Codex 공식 API 키')}</h4>
      <div class="hint" style="margin-bottom:8px">${t('AI 계정 탭에서 결제 방식을 API 키로 고른 AI만 이 키를 써. 비우면 PC 환경변수의 키를 써.')}</div>
      <div class="grid2">
        <div class="field"><label>${t('Anthropic API 키 (Claude Code)')}</label><input class="input mono" type="password" autocomplete="off" value=${ant} onInput=${(e) => setAnt(e.target.value)} placeholder="sk-ant-…" />
          <div class="hint">${t('발급: platform.claude.com → API Keys')}</div></div>
        <div class="field"><label>${t('OpenAI API 키 (Codex)')}</label><input class="input mono" type="password" autocomplete="off" value=${oai} onInput=${(e) => setOai(e.target.value)} placeholder="sk-…" />
          <div class="hint">${t('발급: platform.openai.com → API keys')}</div></div>
      </div></div>
    <div class="card"><h4>${t('Gemini CLI 키')}</h4>
      <div class="field"><input class="input mono" type="password" value=${gem} onInput=${(e) => setGem(e.target.value)} placeholder="AIza…" autocomplete="off" />
      <div class="hint">${t('개인 Google 로그인은 Gemini CLI에서 지원이 끝나서, Gemini CLI는 API 키로만 써.')}</div></div></div>
    <div class="card"><h4>${t('API 키 모델 (OpenAI 호환)')}</h4>
      ${profiles.map((p, i) => html`<div class="grid3" style="grid-template-columns:1.1fr 1.6fr 1.2fr 1fr auto;align-items:end;gap:8px;margin-bottom:8px">
        <div class="field" style="margin:0"><label>${t('이름')}</label><input class="input" value=${p.name} onInput=${(e) => upd(i, 'name', e.target.value)} /></div>
        <div class="field" style="margin:0"><label>${t('주소(Base URL)')}</label><input class="input mono" value=${p.baseUrl} onInput=${(e) => upd(i, 'baseUrl', e.target.value)} /></div>
        <div class="field" style="margin:0"><label>${t('API 키')}</label><input class="input mono" type="password" autocomplete="off" value=${p.apiKey} onInput=${(e) => upd(i, 'apiKey', e.target.value)} placeholder=${/127\.0\.0\.1|localhost/.test(p.baseUrl) ? t('(로컬은 비워도 됨)') : 'sk-…'} /></div>
        <div class="field" style="margin:0"><label>${t('기본 모델')}</label><input class="input mono" value=${p.model} onInput=${(e) => upd(i, 'model', e.target.value)} /></div>
        <button class="icon-btn" title=${t('삭제')} onClick=${() => setProfiles(profiles.filter((_, j) => j !== i))}><${Icon} name="trash" /></button>
      </div>`)}
      <button class="btn sm" onClick=${() => setProfiles([...profiles, { id: '', name: t('새 프로필'), baseUrl: 'https://', apiKey: '', model: '' }])}><${Icon} name="plus" /> ${t('프로필 추가')}</button>
    </div>
    <div class="card"><h4>${t('ACP 에이전트 (Agent Client Protocol)')}</h4>
      <div class="hint" style="margin-bottom:8px">${t('ACP 표준을 지원하는 코딩 에이전트를 그대로 붙여. 에이전트 편집에서 AI를 ACP 에이전트로 고르고, 모델 칸에서 여기 추가한 에이전트를 골라. 로그인·요금은 각 에이전트 규정을 따라.')}</div>
      ${acps.map((a, i) => html`<div class="row" style="margin-bottom:6px;flex-wrap:wrap">
        <input class="input" style="max-width:200px" value=${a.name} placeholder=${t('이름')} onInput=${(e) => setAcp(i, 'name', e.target.value)} />
        <input class="input mono" style="max-width:160px" value=${a.command} placeholder="gemini" onInput=${(e) => setAcp(i, 'command', e.target.value)} title=${t('명령')} />
        <input class="input mono" style="flex:1;min-width:160px" value=${Array.isArray(a.args) ? a.args.join(' ') : a.args} placeholder="--acp" onInput=${(e) => setAcp(i, 'args', e.target.value)} title=${t('인자(띄어쓰기로 구분)')} />
        <button class="icon-btn" title=${t('삭제')} onClick=${() => setAcps(acps.filter((_, j) => j !== i))}><${Icon} name="trash" /></button>
      </div>`)}
      <div class="row wrap" style="gap:6px;margin-top:6px">
        ${presets.filter((p) => !acps.some((a) => a.id === p.id)).map((p) => html`<button class="btn sm" title=${[p.command, ...p.args].join(' ')} onClick=${() => setAcps([...acps, { id: p.id, name: p.name, command: p.command, args: p.args }])}>
          <${Icon} name="plus" /> ${p.name} ${p.installed ? html`<span class="chip ok" style="padding:0 6px">${t('설치됨')}</span>` : p.npx ? html`<span class="chip" style="padding:0 6px" title=${t('처음 실행할 때 npx가 내려받아')}>npx</span>` : ''}</button>`)}
        <button class="btn sm ghost" onClick=${() => setAcps([...acps, { id: '', name: t('새 ACP 에이전트'), command: '', args: [] }])}><${Icon} name="plus" /> ${t('직접 추가')}</button>
      </div>
    </div>
    <div class="card"><h4>${t('로컬 모델 서버')}</h4>
      <div class="hint" style="margin-bottom:8px">${t('Ollama(11434)·LM Studio(1234)·llama.cpp(8080)·vLLM(8000)·Jan(1337)은 켜져 있으면 자동으로 잡혀. 다른 주소면 여기 추가해.')}</div>
      ${locals.map((l, i) => html`<div class="row" style="margin-bottom:6px">
        <input class="input" style="max-width:200px" value=${l.name} placeholder=${t('이름')} onInput=${(e) => setLocal(i, 'name', e.target.value)} />
        <input class="input mono" value=${l.baseUrl} placeholder="http://127.0.0.1:8081/v1" onInput=${(e) => setLocal(i, 'baseUrl', e.target.value)} />
        <button class="icon-btn" title=${t('삭제')} onClick=${() => setLocals(locals.filter((_, j) => j !== i))}><${Icon} name="trash" /></button>
      </div>`)}
      <button class="btn sm" onClick=${() => setLocals([...locals, { name: '', baseUrl: 'http://127.0.0.1:' }])}><${Icon} name="plus" /> ${t('서버 추가')}</button>
    </div>
    <div class="row"><span style="flex:1"></span><button class="btn primary" onClick=${save}>${t('저장')}</button></div>`;
}

function Look() {
  const s = state.settings;
  const [editor, setEditor] = useState(null);
  const skins = [...(officeMod.m?.SKINS || []), ...state.skins.map((k) => ({ ...k, custom: true }))];
  return html`
    <div class="card"><h4>언어 · Language · 语言 · 言語</h4>
      <div class="seg">${[['', t('자동')], ...LANGS].map(([k, l]) => html`<button class=${(s.lang || '') === k ? 'on' : ''} onClick=${() => saveSettings({ lang: k })}>${l}</button>`)}</div>
      <div class="hint">${t('자동은 브라우저 언어를 따라가. 에이전트에게 주는 지침도 이 언어로 바뀌어.')}</div>
    </div>
    <div class="card"><h4>${t('테마')}</h4>
      <div class="seg">${[['system', t('시스템')], ['light', t('밝게')], ['dark', t('어둡게')]].map(([k, l]) => html`<button class=${(s.theme || 'system') === k ? 'on' : ''} onClick=${() => saveSettings({ theme: k })}>${l}</button>`)}</div></div>
    <div class="card"><h4>${t('사무실 스킨')}</h4>
      <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">
        ${skins.map((k) => html`<div class="gcard" style=${s.skin === k.id ? 'border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)' : ''} onClick=${() => saveSettings({ skin: k.id })}>
          <div class="nm">${k.custom ? (k.type === 'village' ? '🏡 ' : '🖼 ') : ''}${!k.custom && officeMod.m?.skinName ? officeMod.m.skinName(k, getLang()) : k.name}</div>
          ${k.custom && (k.image || k.homeImage) ? html`<div style=${`height:90px;border-radius:8px;background:${previewBg(k)};display:grid;place-items:center`}><img src=${k.image || k.homeImage} style=${`max-width:100%;height:${k.image ? '90px;width:100%;object-fit:cover;border-radius:8px' : '70px'};${k.homePixel ? 'image-rendering:pixelated' : ''}`} alt="" /></div>` : html`<div style=${`height:90px;border-radius:8px;background:${previewBg(k)}`}></div>`}
          ${k.custom && html`<div class="row"><button class="btn sm" onClick=${(e) => { e.stopPropagation(); setEditor(k); }}>${t('편집')}</button><button class="btn sm danger" onClick=${async (e) => { e.stopPropagation(); if (confirm(t('이 스킨을 삭제할까?'))) { await del(`/api/skins/${k.id}`).catch((er) => toast(er.message, 'error')); } }}>${t('삭제')}</button></div>`}
        </div>`)}
        <div class="gcard add" onClick=${() => setEditor({ id: '', name: t('내 마을'), type: 'village' })}><${Icon} name="plus" size=${22} />${t('마을 꾸미기 (집 그림 바꾸기)')}</div>
        <div class="gcard add" onClick=${() => setEditor({ id: '', name: t('내 사무실'), type: 'image', desks: [], spots: {} })}><${Icon} name="image" size=${22} />${t('이미지로 스킨 만들기')}</div>
      </div>
      <div class="hint" style="margin-top:8px">${t('크루 마을: 쉬는 에이전트는 자기 집에 들어가 있고, 일을 시작하면 회사로 출근해. 집 그림을 내 그림으로 바꿀 수 있어.')}</div>
      <div class="hint">${t('내 사무실 그림(예: AI로 만든 아이소메트릭 사무실)을 올리고 책상 위치를 찍으면 캐릭터가 그 위에서 일해.')}</div>
    </div>
    ${editor && (editor.type === 'village'
      ? html`<${VillageSkinModal} skin=${editor} onClose=${() => setEditor(null)} />`
      : html`<${SkinEditorModal} skin=${editor} onClose=${() => setEditor(null)} />`)}`;
}

function VillageSkinModal({ skin, onClose }) {
  const [v, setV] = useState(() => ({ name: skin.name || t('내 마을'), homeImage: skin.homeImage || '', homePixel: !!skin.homePixel }));
  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const { image, pixel } = await imageFileToDataURL(f, 256);
      setV((x) => ({ ...x, homeImage: image, homePixel: pixel }));
    } catch (er) { toast(er.message, 'error'); }
  };
  const save = async () => {
    try {
      const saved = await post('/api/skins', { id: skin.id || undefined, name: v.name.trim() || t('내 마을'), type: 'village', base: 'village', homeImage: v.homeImage || null, homePixel: v.homePixel });
      await saveSettings({ skin: saved.id });
      toast(t('스킨을 저장하고 적용했어'), 'ok');
      onClose();
    } catch (er) { toast(er.message, 'error'); }
  };
  return html`<${Modal} title=${t('마을 꾸미기')} onClose=${onClose} foot=${html`
    <span class="grow" style="flex:1"></span>
    <button class="btn" onClick=${onClose}>${t('취소')}</button>
    <button class="btn primary" onClick=${save}>${t('저장')}</button>`}>
    <div class="field"><label>${t('이름')}</label><input class="input" value=${v.name} onInput=${(e) => setV((x) => ({ ...x, name: e.target.value }))} /></div>
    <div class="field"><label>${t('집 그림')}</label>
      <div class="row" style="gap:10px;align-items:center">
        <div style="width:96px;height:96px;border-radius:12px;background:var(--panel-2);display:grid;place-items:center;overflow:hidden">
          ${v.homeImage ? html`<img src=${v.homeImage} style=${`max-width:88px;max-height:88px;${v.homePixel ? 'image-rendering:pixelated' : ''}`} alt="" />` : html`<span style="font-size:40px">🏠</span>`}
        </div>
        <div class="row" style="flex-wrap:wrap;gap:6px">
          <label class="btn sm"><${Icon} name="image" /> ${v.homeImage ? t('다른 그림') : t('그림 올리기')}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none" onChange=${pick} /></label>
          ${v.homeImage && html`<button class="btn sm" onClick=${() => setV((x) => ({ ...x, homeImage: '', homePixel: false }))}>${t('기본 집으로')}</button>`}
        </div>
      </div>
      <div class="hint">${t('쉬는 에이전트가 들어가 있는 집이야. 투명 배경 PNG를 추천해(예: 캡슐·둥지·텐트). 그림은 이 PC에만 저장돼.')}</div>
    </div>
    <div class="hint">${t('에이전트 모습은 에이전트 편집에서 사람·크리처·내 그림 중에 골라.')}</div>
  </${Modal}>`;
}
function previewBg(k) {
  if (k.type === 'village') return 'linear-gradient(160deg, #e8f4ec 0 30%, #9fd47f 30% 100%)';
  const p = k.palette || {};
  return `linear-gradient(135deg, ${p.wallL || p.wall || '#eee'} 0 45%, ${p.floor || p.floorA || '#d9b38c'} 45% 100%)`;
}

function SkinEditorModal({ skin, onClose }) {
  const host = useRef(null);
  useEffect(() => {
    const m = officeMod.m;
    if (!m?.createSkinEditor || !host.current) return undefined;
    const ed = m.createSkinEditor(host.current, {
      skin, lang: getLang(),
      onSave: async (obj) => {
        try {
          const saved = await post('/api/skins', { ...obj, id: skin.id || undefined, type: 'image' });
          await saveSettings({ skin: saved.id });
          toast(t('스킨을 저장하고 적용했어'), 'ok');
          onClose();
        } catch (e) { toast(e.message, 'error'); }
      },
      onCancel: onClose,
    });
    return () => ed?.destroy?.();
  }, []);
  return html`<${Modal} title=${t('이미지 스킨 편집기')} onClose=${onClose} size="full">
    ${!officeMod.m?.createSkinEditor && html`<div class="muted">${t('편집기를 불러오는 중…')}</div>`}
    <div ref=${host} style="height:100%;min-height:520px"></div>
  </${Modal}>`;
}

const mb = (n = 0) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}GB` : `${(n / 1e6).toFixed(1)}MB`);

function Storage() {
  const s = state.settings;
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState('');
  const [days, setDays] = useState(90);
  const load = () => get('/api/storage').then(setR).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []);
  const clean = async (target, label) => {
    if (!confirm(t('{label} — 정리할까? 되돌릴 수 없어.', { label }))) return;
    setBusy(target);
    try {
      const x = await post('/api/storage/cleanup', { target, days });
      toast(t('{n}개 정리, {size} 확보', { n: x.removed, size: mb(x.freed) }), 'ok');
      await load();
    } catch (e) { toast(e.message, 'error'); }
    setBusy('');
  };
  const Q = [['full', t('최고')], ['lite', t('가볍게')], ['static', t('정지 화면')]];
  return html`
    <div class="card"><h4>${t('사무실 그래픽 품질')}</h4>
      <div class="seg">${Q.map(([k, l]) => html`<button class=${(s.officeQuality || 'full') === k ? 'on' : ''} onClick=${() => saveSettings({ officeQuality: k })}>${l}</button>`)}</div>
      <div class="hint">${t('가볍게: 반복 애니메이션을 끄고 걷기만 유지 · 정지 화면: 애니메이션 0(말풍선·이름표만 갱신). 저사양 PC·노트북 배터리 절약에 좋아.')}</div>
      <div class="row" style="margin-top:10px"><${Toggle} checked=${s.reducedMotion} onChange=${(v) => saveSettings({ reducedMotion: v })} /><span>${t('화면 전환 애니메이션 줄이기(멀미 방지)')}</span></div>
    </div>
    <${PhoneCard} s=${s} />
    <div class="card"><h4>${t('데스크톱 알림')}</h4>
      <div class="row"><${Toggle} checked=${s.desktopNotify === true} onChange=${async (v) => {
        if (v && !(await askNotifyPermission())) { toast(t('알림이 막혀 있어. 브라우저 사이트 설정에서 알림을 허용해줘.'), 'warn'); return; }
        saveSettings({ desktopNotify: v });
      }} /><span>${t('창이 뒤에 있을 때 승인 대기·작업 끝을 알려줘')}</span></div>
      ${s.desktopNotify === true && (typeof Notification === 'undefined' || Notification.permission !== 'granted') && html`<div class="hint">${t('이 브라우저에는 알림 권한이 없어. 껐다 켜서 허용해줘.')}</div>`}
    </div>
    <div class="card"><h4>${t('저장공간')} <button class="btn sm ghost" title=${t('다시 계산')} onClick=${load}><${Icon} name="refresh" /></button></h4>
      ${!r ? html`<div class="muted">${t('계산 중…')}</div>` : html`
        <div class="stat"><span>${t('전체 ({path})', { path: r.home })}</span><span>${mb(r.total)}</span></div>
        <div class="stat"><span>${t('세션 {n}개', { n: r.sessions.count })}</span><span>${mb(r.sessions.bytes)}</span></div>
        <div class="stat"><span>${t('첨부 파일 {n}개 · 안 쓰는 것 {u}개({size})', { n: r.uploads.count, u: r.uploads.unused.count, size: mb(r.uploads.unused.bytes) })}</span><span>${mb(r.uploads.bytes)}</span></div>
        <div class="stat"><span>${t('작업 폴더 · 주인 없는 것 {n}개({size})', { n: r.workspaces.orphan.count, size: mb(r.workspaces.orphan.bytes) })}</span><span>${mb(r.workspaces.bytes)}</span></div>
        <div class="stat"><span>${t('임시 파일')}</span><span>${mb(r.tmp.bytes)}</span></div>
        <div class="stat"><span>${t('서버 메모리 · 메모리에 올린 세션 {n}개', { n: r.memory.cachedSessions })}</span><span>${mb(r.memory.rss)}</span></div>
        <div class="row wrap" style="margin-top:12px">
          <button class="btn sm" disabled=${!!busy || !r.uploads.unused.count} onClick=${() => clean('uploads-unused', t('안 쓰는 첨부 {n}개', { n: r.uploads.unused.count }))}>${t('안 쓰는 첨부 정리')}</button>
          <button class="btn sm" disabled=${!!busy || !r.workspaces.orphan.count} onClick=${() => clean('workspaces-orphan', t('삭제된 세션의 작업 폴더 {n}개(안의 파일도 지워져)', { n: r.workspaces.orphan.count }))}>${t('주인 없는 작업 폴더 정리')}</button>
          <span class="row" style="gap:6px"><input class="input" type="number" min="1" style="width:80px" value=${days} onInput=${(e) => setDays(Number(e.target.value) || 90)} /> ${t('일 넘은 세션')}</span>
          <button class="btn sm danger" disabled=${!!busy} onClick=${() => clean('sessions-older', t('{n}일 넘게 안 쓴 세션(고정한 건 제외)', { n: days }))}>${t('오래된 세션 정리')}</button>
        </div>`}
    </div>`;
}

function Defaults() {
  const s = state.settings;
  const [cwd, setCwd] = useState(s.defaultCwd || '');
  return html`
    <div class="card">
      <div class="grid2">
        <div class="field"><label>${t('새 세션 기본 팀')}</label><select class="select" value=${s.defaultTeamId || ''} onChange=${(e) => saveSettings({ defaultTeamId: e.target.value || null })}><option value="">${t('(팀 없이 기본 에이전트)')}</option>${state.teams.map((tm) => html`<option value=${tm.id}>${tm.name}</option>`)}</select></div>
        <div class="field"><label>${t('기본 에이전트 (팀 없을 때)')}</label><select class="select" value=${s.defaultAgentId || ''} onChange=${(e) => saveSettings({ defaultAgentId: e.target.value })}>${state.agents.map((a) => html`<option value=${a.id}>${a.name} (${a.model})</option>`)}</select></div>
      </div>
      <div class="field"><label>${t('기본 작업 폴더')}</label>
        <div class="row"><input class="input mono" value=${cwd} onInput=${(e) => setCwd(e.target.value)} placeholder=${t('비우면 세션마다 {path}', { path: `${state.home}\\workspaces\\<${t('세션')}>` })} /><button class="btn" onClick=${() => saveSettings({ defaultCwd: cwd.trim() }).then((ok) => ok && toast(t('저장했어'), 'ok'))}>${t('저장')}</button></div>
        <div class="hint">${t('에이전트가 파일을 만들고 읽는 곳. 이미 있는 폴더 경로를 넣어.')}</div></div>
      <div class="grid2">
        <div class="field"><label>${t('기억 못 하는 모델에 넣어줄 최근 대화 수')}</label><input class="input" type="number" min="0" max="40" value=${s.historyTurns ?? 8} onChange=${(e) => saveSettings({ historyTurns: Number(e.target.value) })} /></div>
        <div class="field"><label>${t('멈춘 실행으로 볼 시간(분)')}</label><input class="input" type="number" min="0" max="1440" value=${s.stallMinutes ?? 30} onChange=${(e) => saveSettings({ stallMinutes: Number(e.target.value) })} /><div class="hint">${t('출력이 이만큼 없으면 CLI를 끄고 오류로 돌려. 도구가 도는 중엔 4배까지 기다려. 0이면 끄기.')}</div></div>
        <div class="field"><label>${t('보내기 키')}</label><div class="seg"><button class=${s.sendOnEnter !== false ? 'on' : ''} onClick=${() => saveSettings({ sendOnEnter: true })}>Enter</button><button class=${s.sendOnEnter === false ? 'on' : ''} onClick=${() => saveSettings({ sendOnEnter: false })}>Ctrl+Enter</button></div></div>
      </div>
    </div>`;
}

// 계정 사용 원칙(정보 탭·첫 화면 공용). onOk 를 주면 "확인" 버튼이 붙는다
const POLICY_URL = { ko: 'README.ko.md#-계정-사용-원칙', en: 'README.md#-using-your-accounts', zh: 'README.zh-CN.md#-账号使用原则', ja: 'README.ja.md#-アカウント利用の原則' };
export function PolicyNotice({ onOk }) {
  const url = `https://github.com/yw8837/office-crew/blob/main/${POLICY_URL[getLang()] || POLICY_URL.en}`;
  return html`<div class="card">
    <h4>📜 ${t('계정 사용 원칙')}</h4>
    <ul class="small" style="margin:0 0 8px;padding-left:18px">
      <li>${t('오피스 크루는 내 PC에 설치·로그인한 공식 CLI를 그대로 실행해. 로그인 토큰은 읽지도, 저장하지도, 다른 곳으로 보내지도 않아.')}</li>
      <li>${t('구독 로그인은 내 PC에서 나 혼자 쓰는 용도야. 계정을 나눠 쓰거나 다른 사람에게 서비스로 제공하지 마.')}</li>
      <li>${t('제품을 만들거나 회사에서 쓰거나 사람 없이 돌릴 땐 Claude·Codex 결제 방식을 API 키로 바꿔줘 (설정 → AI 계정).')}</li>
      <li>${t('Hermes에서 Anthropic을 고르면 Claude Code 로그인을 가져다 쓸 수 있어. 대신 Anthropic API 키나 다른 제공자를 지정해줘.')}</li>
      <li>${t('약관은 바뀔 수 있고 이 안내는 법률 자문이 아니야. 각 서비스의 최신 약관을 확인해줘.')}</li>
    </ul>
    <div class="row" style="gap:8px">
      <a class="small" href=${url} target="_blank" rel="noopener noreferrer">${t('자세히 보기')}</a>
      ${onOk && html`<span class="grow" style="flex:1"></span><button class="btn sm primary" onClick=${onOk}>${t('확인했어')}</button>`}
    </div>
  </div>`;
}

function About() {
  const quit = async () => {
    if (!confirm(t('오피스 크루를 끌까? 진행 중인 작업과 예약 작업도 멈춰. 다시 쓰려면 바로가기로 켜.'))) return;
    try {
      const r = await post('/api/quit');
      if (r.ok) toast(t('오피스 크루를 껐어. 이 창은 닫아도 돼.'), 'ok', 10000);
      else toast(t('이 방식으로 켠 서버는 여기서 끌 수 없어. 켠 터미널에서 Ctrl+C로 꺼줘.'), 'error', 8000);
    } catch (e) { toast(e.message, 'error'); }
  };
  return html`<${PolicyNotice} /><div class="card row wrap" style="gap:10px;align-items:center;margin-bottom:12px">
    <span style="flex:1;min-width:220px"><b>⏻ ${t('오피스 크루 끄기')}</b><div class="hint">${t('창 없이 켰다면 여기서 꺼. 앱 창만 닫으면 서버는 계속 켜져 있어서 예약 작업이 돌아.')}</div></span>
    <button class="btn danger sm" onClick=${quit}>${t('끄기')}</button>
  </div><div class="card">
    <h4>🏢 ${t('오피스 크루')} ${state.version}</h4>
    <p class="small">${t('여러 AI CLI(Claude Code·Codex·Gemini CLI·Hermes)와 OpenAI 호환 API를 한 화면에서 팀으로 묶어 쓰는 로컬 앱이야. 서버는 이 PC(127.0.0.1)에서만 열리고, 런타임 의존성이 없어 가벼워.')}</p>
    <ul class="small">
      <li>${t('단축키:')} <b>Ctrl+Shift+O</b> ${t('새 세션')} · <b>Ctrl+.</b> ${t('오른쪽 패널')} · <b>Ctrl+/</b> ${t('사이드바')} · <b>Esc</b> ${t('창 닫기')}</li>
      <li>${t('입력창:')} <b>@${t('이름')}</b> ${t('특정 에이전트에게만')} · <b>/${t('스킬')}</b> ${t('스킬 실행')} · ${t('Ctrl+V 이미지 붙여넣기')} · ${t('파일 끌어놓기')}</li>
      <li>${t('작업 중 입력: "지금 끼어들기"는 실행 중인 에이전트에게 바로 전달, "다음 차례로"는 끝난 뒤 실행')}</li>
    </ul>
  </div>`;
}

// ── 사용량 화면 ──
export function UsagePage() {
  const u = state.usage || {};
  const byP = Object.entries(u.byProvider || {});
  const byA = Object.entries(u.byAgent || {}).sort((a, b) => usageTotal(b[1]) - usageTotal(a[1]));
  const max = Math.max(1, ...byA.map(([, v]) => usageTotal(v)));
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('사용량')} desc=${t('토큰·비용은 실행마다 실시간으로 쌓여. 계정 한도(%)는 Claude·Codex가 실행 때 알려주는 값이야.')} />
    <div class="grid2" style="gap:14px">
      <div class="card"><h4>🔋 ${t('계정 한도')}</h4><${Limits} lim=${u.limits} /></div>
      <div class="card"><h4>📅 ${t('오늘')}</h4>
        ${Object.entries(u.today || {}).map(([p, v]) => html`<div class="stat"><span><${ProviderChip} id=${p} /></span><span>${t('{n} 토큰', { n: fmtTok(usageTotal(v)) })} ${fmtCost(v.cost)} · ${t('{n}회', { n: v.calls })}</span></div>`)}
        ${!Object.keys(u.today || {}).length && html`<div class="muted small">${t('오늘 기록 없음')}</div>`}
      </div>
    </div>
    <div class="section">${t('AI별 누적')}</div>
    <div class="list">${byP.map(([p, v]) => html`<div class="li-row"><${ProviderChip} id=${p} /><div class="grow small">${t('입력 {i} · 출력 {o} · 캐시 {c}', { i: fmtTok(v.input), o: fmtTok(v.output), c: fmtTok(v.cacheRead + v.cacheWrite) })}</div><b>${fmtTok(usageTotal(v))}</b><span class="muted small">${fmtCost(v.cost)} · ${t('{n}회', { n: v.calls })}</span></div>`)}
      ${!byP.length && html`<div class="li-row muted">${t('아직 기록이 없어.')}</div>`}</div>
    <div class="section">${t('에이전트별 누적')}</div>
    <div class="list">${byA.map(([id, v]) => {
      const a = agentById(id);
      return html`<div class="li-row"><div style="width:140px" class="ellipsis"><b>${a?.name || id}</b></div><div class="grow"><div class="bar"><i style=${`width:${(usageTotal(v) / max) * 100}%;background:${providerColor(a?.provider)}`}></i></div></div><b>${fmtTok(usageTotal(v))}</b><span class="muted small">${fmtCost(v.cost)}</span></div>`;
    })}${!byA.length && html`<div class="li-row muted">${t('아직 기록이 없어.')}</div>`}</div>
  </div></div>`;
}

// 휴대폰 알림: 사용자가 정한 주소로 상태와 세션 제목만 보낸다
function PhoneCard({ s }) {
  const [url, setUrl] = useState(null);
  const shown = url ?? (s.phoneUrl || '');
  const saveUrl = async () => {
    if (url === null) return true;
    try { state.settings = await put('/api/settings', { phoneUrl: url }); setUrl(null); changed(); return true; } catch (e) { toast(e.message, 'error'); return false; }
  };
  const test = async () => {
    if (!(await saveUrl())) return;
    try { await post('/api/phone/test', {}); toast(t('시험 알림을 보냈어. 휴대폰을 확인해줘.'), 'ok'); } catch (e) { toast(e.message, 'error'); }
  };
  return html`<div class="card"><h4>${t('휴대폰 알림')}</h4>
    <div class="row"><${Toggle} checked=${s.phoneNotify === true} onChange=${async (v) => { if (await saveUrl()) saveSettings({ phoneNotify: v }); }} /><span>${t('승인 대기·작업 끝·실패를 휴대폰으로 보내기')}</span></div>
    <div class="field" style="margin-top:10px"><label>${t('받는 곳')}</label>
      <div class="seg" role="group" aria-label=${t('받는 곳')} style="align-self:flex-start"><button class=${s.phoneType !== 'webhook' ? 'on' : ''} onClick=${() => saveSettings({ phoneType: 'ntfy' })}>ntfy</button><button class=${s.phoneType === 'webhook' ? 'on' : ''} onClick=${() => saveSettings({ phoneType: 'webhook' })}>${t('웹훅')}</button></div></div>
    <div class="field"><label for="phone-url">${t('주소')}</label><input id="phone-url" class="input mono" value=${shown} placeholder=${s.phoneType === 'webhook' ? 'https://hooks.slack.com/services/…' : 'https://ntfy.sh/…'} onInput=${(e) => setUrl(e.target.value)} onBlur=${saveUrl} /></div>
    <div class="row" style="gap:8px"><button class="btn sm" disabled=${!shown} onClick=${test}>${t('시험 보내기')}</button></div>
    ${s.phoneError && html`<div class="notice" style="margin-top:8px">⚠️ ${t('마지막 알림을 못 보냈어: {msg}', { msg: s.phoneError })}</div>`}
    <div class="hint" style="margin-top:8px">${t('상태와 팀·에이전트 이름만 밖으로 나가고 대화 내용과 세션 제목은 안 나가. ntfy 공개 주제는 이름을 아는 사람이면 누구나 볼 수 있으니 맞히기 어려운 이름을 써.')}</div>
  </div>`;
}
