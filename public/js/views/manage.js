// 관리 화면: 에이전트(라우팅: 모델·노력·권한), 팀 배치(파이프라인), 커넥터(MCP), 스킬, 플러그인
import { useEffect, useState } from 'preact/hooks';
import { html, Icon, Modal, Toggle, Avatar, ProviderChip, PERM_LABEL, EFFORT_LABEL, providerColor, officeMod, agentModelText, imageFileToDataURL } from '../ui.js';
import { state, changed, toast, agentById, providerById } from '../state.js';
import { get, post, put, del } from '../api.js';
import { RoutingFields, routeText, PROFILE_LABEL } from './routing.js';
import { t } from '../i18n/index.js';

const SKIN_TONES = ['#f6d5bd', '#f2c9a6', '#e3b38f', '#d9a77f', '#c98f68', '#a8714f', '#7a4e33'];
const HAIR = ['#1d1d24', '#3a2a1e', '#5a3825', '#8a5a3b', '#b04a2f', '#d8b26a', '#9aa3ad', '#e9e4dc', '#4f46e5', '#db2777'];
const OUTFIT = ['#3b82f6', '#10a37f', '#d97757', '#8b5cf6', '#f97316', '#0ea5e9', '#22c55e', '#ef4444', '#334155', '#eab308', '#ec4899', '#64748b'];
const STYLES = () => [['short', t('짧은 머리')], ['bob', t('단발')], ['long', t('긴 머리')], ['spiky', t('삐죽 머리')], ['ponytail', t('포니테일')]];
const ACCS = () => [['none', t('없음')], ['glasses', t('안경')], ['headset', t('헤드셋')]];
const KINDS = () => [['person', t('사람')], ['creature', t('크리처')], ['image', t('내 그림')]];
const SPECIES = () => [['puff', t('뭉게 머리')], ['ears', t('긴 귀')], ['horn', t('작은 뿔')]];
const EMOJIS = ['🤖', '🔎', '🗂️', '🧠', '🛠️', '✍️', '🎨', '📊', '🧪', '🛡️', '📣', '🧭', '🔁'];

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function PageHead({ title, desc, children }) {
  return html`<div class="page-head"><div><h1>${title}</h1>${desc && html`<p>${desc}</p>`}</div><span class="grow"></span>${children}</div>`;
}

// ── 에이전트 ──
export function AgentsPage() {
  const [edit, setEdit] = useState(null);
  useEffect(() => {
    if (state.ui.editAgent) { setEdit(agentById(state.ui.editAgent) || null); state.ui.editAgent = null; }
  });
  const groups = {};
  for (const a of state.agents) (groups[a.provider] ||= []).push(a);
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('에이전트')} desc=${t("AI마다 모델·노력(effort)·권한·스킬·커넥터를 따로 정해 '직원'을 만들어. 팀 배치에서 순서대로 일을 넘겨받아.")}>
      <button class="btn primary" onClick=${() => setEdit({})}><${Icon} name="plus" /> ${t('새 에이전트')}</button>
    </${PageHead}>
    <div class="cards">
      ${state.agents.map((a) => html`<div class="gcard" onClick=${() => setEdit(a)}>
        <div class="hd"><${Avatar} agent=${a} size=${44} /><div style="min-width:0"><div class="nm">${a.emoji} ${a.name}</div><div class="small muted">${a.role || t('역할 없음')}</div></div></div>
        <div class="tags">${a.routing === 'auto' ? html`<span class="chip accent">${agentModelText(a)}</span>` : html`<${ProviderChip} id=${a.provider} /><span class="chip mono">${a.model || t('기본 모델')}</span>${a.effort && html`<span class="chip accent">${EFFORT_LABEL[a.effort] || a.effort}</span>`}`}<span class="chip">${PERM_LABEL[a.permission]?.[0] || a.permission}</span></div>
        <div class="desc">${a.systemPrompt || ''}</div>
        ${(a.skills?.length || a.connectors?.length) ? html`<div class="small muted">${t('스킬 {s} · 커넥터 {c}', { s: a.skills?.length || 0, c: a.connectors?.length || 0 })}</div>` : ''}
      </div>`)}
      <div class="gcard add" onClick=${() => setEdit({})}><${Icon} name="plus" size=${22} />${t('새 에이전트')}</div>
    </div>
    ${edit && html`<${AgentEditor} agent=${edit} onClose=${() => setEdit(null)} />`}
  </div></div>`;
}

export function AgentEditor({ agent, onClose }) {
  const isNew = !agent.id;
  const [a, setA] = useState(() => ({
    name: '', role: '', emoji: '🤖', provider: 'claude', model: 'opus', effort: 'high', routing: 'auto', routingProfile: 'balanced', permission: 'default', systemPrompt: '', skills: [], connectors: [], light: false, apiProfile: '',
    avatar: { skin: SKIN_TONES[1], hair: HAIR[0], hairStyle: 'short', outfit: OUTFIT[Math.floor(Math.random() * OUTFIT.length)], accessory: 'none' },
    ...structuredClone(agent),
  }));
  const [skillQ, setSkillQ] = useState('');
  const prov = providerById(a.provider);
  // 선택한 스킬을 앞에, 나머지는 검색어로 걸러 최대 16개만
  const q = skillQ.trim().toLowerCase();
  const chosen = state.skills.filter((k) => a.skills.includes(k.id));
  const rest = state.skills.filter((k) => !a.skills.includes(k.id) && (!q || `${k.name} ${k.description}`.toLowerCase().includes(q)));
  const skillList = [...chosen, ...rest.slice(0, 16)];
  const skillMore = Math.max(0, rest.length - 16);
  const set = (k, v) => setA((x) => ({ ...x, [k]: v }));
  const setAv = (k, v) => setA((x) => ({ ...x, avatar: { ...x.avatar, [k]: v } }));
  const setMany = (patch) => setA((x) => ({ ...x, ...patch }));

  const save = async () => {
    try {
      if (isNew) await post('/api/agents', a); else await put(`/api/agents/${a.id}`, a);
      toast(isNew ? t('에이전트를 만들었어') : t('저장했어'), 'ok');
      onClose();
    } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async () => {
    if (!confirm(t("'{name}' 에이전트를 삭제할까? 팀 배치에서도 빠져.", { name: a.name }))) return;
    try { await del(`/api/agents/${a.id}`); toast(t('삭제했어'), 'ok'); onClose(); } catch (e) { toast(e.message, 'error'); }
  };
  const tryIt = async () => {
    try {
      let id = a.id;
      if (isNew) id = (await post('/api/agents', a)).id; else await put(`/api/agents/${a.id}`, a);
      const s = await post('/api/sessions', { teamId: null, agentId: id, title: t('{name} 테스트', { name: a.name }) });
      onClose();
      state.route = { view: 'session', id: s.id };
      (await import('../state.js')).go('session', s.id);
    } catch (e) { toast(e.message, 'error'); }
  };
  const avatarSvg = officeMod.m?.renderAvatarSVG;
  const profiles = state.settings.apiProfiles || [];
  const kind = ['creature', 'image'].includes(a.avatar.kind) ? a.avatar.kind : 'person';
  const pickImage = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const { image, pixel } = await imageFileToDataURL(f);
      setA((x) => ({ ...x, avatar: { ...x.avatar, kind: 'image', image, pixel } }));
    } catch (er) { toast(er.message, 'error'); }
  };

  return html`<${Modal} title=${isNew ? t('새 에이전트') : t('에이전트 편집 — {name}', { name: agent.name })} onClose=${onClose} size="wide" foot=${html`
    ${!isNew && html`<button class="btn danger" onClick=${remove}><${Icon} name="trash" /> ${t('삭제')}</button>`}
    <span class="grow" style="flex:1"></span>
    <button class="btn" onClick=${tryIt} title=${t('저장하고 이 에이전트와 새 세션 열기')}><${Icon} name="msg" /> ${t('저장 후 대화해보기')}</button>
    <button class="btn" onClick=${onClose}>${t('취소')}</button>
    <button class="btn primary" disabled=${!a.name.trim()} onClick=${save}>${isNew ? t('만들기') : t('저장')}</button>`}>
    <div style="display:grid;grid-template-columns:minmax(0,1fr) 230px;gap:22px">
      <div>
        <div class="grid3">
          <div class="field"><label>${t('이름')}</label><input class="input" value=${a.name} onInput=${(e) => set('name', e.target.value)} placeholder=${t('예: 빌더')} /></div>
          <div class="field"><label>${t('역할')}</label><input class="input" value=${a.role} onInput=${(e) => set('role', e.target.value)} placeholder=${t('예: 조사 / 정리 / 분석 / 빌드')} list="roles" />
            <datalist id="roles">${[t('조사'), t('정리'), t('분석'), t('빌드'), t('검수'), t('기획'), t('디자인'), t('글쓰기')].map((r) => html`<option value=${r} />`)}</datalist></div>
          <div class="field"><label>${t('이모지')}</label><select class="select" value=${a.emoji} onChange=${(e) => set('emoji', e.target.value)}>${[...new Set([a.emoji, ...EMOJIS].filter(Boolean))].map((x) => html`<option value=${x}>${x}</option>`)}</select></div>
        </div>
        <${RoutingFields} a=${a} set=${set} setMany=${setMany} />
        ${a.routing !== 'auto' && a.provider === 'openai' && html`<div class="field"><label>${t('API 프로필')}</label>
          <select class="select" value=${a.apiProfile} onChange=${(e) => { const p = profiles.find((x) => x.id === e.target.value); setA((x) => ({ ...x, apiProfile: e.target.value, model: p?.model || x.model })); }}>
            <option value="">${t('(키가 있는 첫 프로필)')}</option>
            ${profiles.map((p) => html`<option value=${p.id}>${p.name}${p.apiKey ? ' ✓' : ''}</option>`)}
          </select><div class="hint">${t('키는 설정 → API 키에서 넣어. OpenRouter로 Hermes·Grok 등 수백 개 모델을 쓸 수 있어.')}</div></div>`}
        ${prov?.caps?.permissions !== false && html`<div class="field"><label>${t('권한')}</label>
          <div class="pick">${Object.entries(PERM_LABEL).map(([k, [l, d]]) => html`<span class=${`chip${a.permission === k ? ' on' : ''}`} title=${d} onClick=${() => set('permission', k)}>${l}</span>`)}</div>
          <div class="hint">${PERM_LABEL[a.permission]?.[1]}</div>
          ${a.permission === 'full' && html`<div class="warnbox" style="margin-top:6px">⚠ ${t('전부 허용은 에이전트가 승인 없이 명령을 실행하고 파일을 바꿔. 믿을 수 있는 작업 폴더에서만 써.')}</div>`}
        </div>`}
        <div class="field"><label>${t('역할 지침 (시스템 프롬프트)')}</label>
          <textarea class="textarea" style="min-height:110px" value=${a.systemPrompt} onInput=${(e) => set('systemPrompt', e.target.value)} placeholder=${t('이 에이전트가 늘 지킬 규칙·말투·산출물 형식')}></textarea></div>
        <div class="field"><label>${t('스킬 (항상 적용)')} ${a.skills.length > 0 && html`<span class="chip accent">${t('{n}개 선택', { n: a.skills.length })}</span>`}</label>
          <input class="input" style="margin-bottom:6px" placeholder=${t('스킬 검색 ({n}개)', { n: state.skills.length })} value=${skillQ} onInput=${(e) => setSkillQ(e.target.value)} />
          <div class="pick">${skillList.map((k) => html`<span class=${`chip${a.skills.includes(k.id) ? ' on' : ''}`} title=${k.description} onClick=${() => set('skills', a.skills.includes(k.id) ? a.skills.filter((x) => x !== k.id) : [...a.skills, k.id])}>${k.name}<span class="muted">·${k.source}</span></span>`)}
            ${skillMore > 0 && html`<span class="small muted" style="align-self:center">${t('외 {n}개 — 검색해서 찾아', { n: skillMore })}</span>`}</div>
          ${!state.skills.length && html`<div class="hint">${t('스킬이 없어. 스킬 메뉴에서 만들거나 가져와.')}</div>`}
        </div>
        ${prov?.caps?.connectors && html`<div class="field"><label>${t('커넥터 (MCP 서버)')}</label>
          <div class="pick">${state.connectors.map((c) => html`<span class=${`chip${a.connectors.includes(c.id) ? ' on' : ''}`} onClick=${() => set('connectors', a.connectors.includes(c.id) ? a.connectors.filter((x) => x !== c.id) : [...a.connectors, c.id])}>🔌 ${c.name}</span>`)}</div>
          <div class="hint">${state.connectors.length ? t('CLI에 이미 등록된 커넥터는 자동으로 같이 쓰여.') : t('앱 커넥터가 없어 — 커넥터 메뉴에서 추가해. (CLI에 이미 등록된 커넥터는 자동 사용)')}</div></div>`}
        ${['claude', 'codex'].includes(a.provider) && html`<div class="field"><div class="row"><${Toggle} checked=${a.light} onChange=${(v) => set('light', v)} /><div><b>${t('가벼운 모드')}</b><div class="hint">${a.provider === 'claude' ? t('CLI의 개인 설정·플러그인·훅·CLAUDE.md를 끄고 실행(--safe-mode). 빠르고 토큰을 덜 써.') : t('로그인·모델 설정은 그대로 두고 플러그인·앱·브라우저·컴퓨터 사용·이미지 생성 등 무거운 기능만 꺼서 실행. 매번 붙는 설명이 줄어 토큰을 크게 아껴.')}</div></div></div></div>`}
      </div>
      <div>
        <div class="field"><label>${t('미리보기')}</label>
          <div class="preview-av" dangerouslySetInnerHTML=${{ __html: avatarSvg ? avatarSvg(a.avatar, { size: 96, color: providerColor(a.provider), id: a.id || a.name }) : `<span style="font-size:44px">${escapeHtml(a.emoji)}</span>` }}></div></div>
        <div class="field"><label>${t('모습')}</label>
          <div class="seg">${KINDS().map(([k, l]) => html`<button class=${kind === k ? 'on' : ''} onClick=${() => setA((x) => ({ ...x, avatar: { ...x.avatar, kind: k, ...(k === 'creature' && !x.avatar.species ? { species: 'puff' } : {}) } }))}>${l}</button>`)}</div></div>
        ${kind === 'person' && html`
          <div class="field"><label>${t('피부')}</label><div class="swatches">${SKIN_TONES.map((c) => html`<span class=${`sw${a.avatar.skin === c ? ' on' : ''}`} style=${`background:${c}`} onClick=${() => setAv('skin', c)}></span>`)}</div></div>
          <div class="field"><label>${t('머리 색')}</label><div class="swatches">${HAIR.map((c) => html`<span class=${`sw${a.avatar.hair === c ? ' on' : ''}`} style=${`background:${c}`} onClick=${() => setAv('hair', c)}></span>`)}</div></div>
          <div class="field"><label>${t('머리 모양')}</label><select class="select" value=${a.avatar.hairStyle} onChange=${(e) => setAv('hairStyle', e.target.value)}>${STYLES().map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></div>`}
        ${kind !== 'image' && html`<div class="field"><label>${kind === 'creature' ? t('몸 색') : t('옷 색')}</label><div class="swatches">${OUTFIT.map((c) => html`<span class=${`sw${a.avatar.outfit === c ? ' on' : ''}`} style=${`background:${c}`} onClick=${() => setAv('outfit', c)}></span>`)}</div></div>`}
        ${kind === 'person' && html`<div class="field"><label>${t('소품')}</label><select class="select" value=${a.avatar.accessory} onChange=${(e) => setAv('accessory', e.target.value)}>${ACCS().map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></div>`}
        ${kind === 'creature' && html`<div class="field"><label>${t('생김새')}</label><select class="select" value=${a.avatar.species || 'puff'} onChange=${(e) => setAv('species', e.target.value)}>${SPECIES().map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></div>`}
        ${kind === 'image' && html`<div class="field"><label>${t('내 그림')}</label>
          <div class="row" style="flex-wrap:wrap;gap:6px">
            <label class="btn sm"><${Icon} name="image" /> ${a.avatar.image ? t('다른 그림') : t('그림 올리기')}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" style="display:none" onChange=${pickImage} /></label>
            ${a.avatar.image && html`<button class="btn sm" onClick=${() => setA((x) => ({ ...x, avatar: { ...x.avatar, image: undefined, pixel: undefined } }))}>${t('지우기')}</button>`}
          </div>
          <div class="hint">${t('투명 배경 PNG를 추천해. 긴 변 256px로 줄여 이 PC에만 저장돼. 작은 도트 그림은 선명하게 확대돼.')}</div></div>`}
      </div>
    </div>
  </${Modal}>`;
}

// ── 팀 배치 ──
// 단계 이름은 화면 언어로, 역할(두 번째 값)은 기본 에이전트의 역할과 맞추는 키라 그대로 둔다
const TEMPLATES = () => [
  { name: t('조사→정리→분석→빌드'), stages: [[t('조사'), '조사'], [t('정리'), '정리'], [t('분석'), '분석', true], [t('빌드'), '빌드']] },
  { name: t('기획→구현→검수'), stages: [[t('기획'), '분석'], [t('구현'), '빌드', true], [t('검수'), '분석']] },
  { name: t('설계자/작성자 (aider식)'), stages: [[t('설계'), '분석'], [t('작성'), '빌드']] },
  { name: t('병렬 조사 → 종합'), stages: [[t('병렬 조사'), '조사*'], [t('종합'), '정리']] },
];

export function TeamsPage() {
  const [edit, setEdit] = useState(null);
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('팀 배치')} desc=${t('단계마다 에이전트를 배치해. 한 단계에 여러 명이면 병렬로 일하고, 승인 체크한 단계 뒤엔 사람 확인을 기다려.')}>
      <button class="btn primary" onClick=${() => setEdit({ name: '', description: '', stages: [{ label: t('{n}단계', { n: 1 }), agentIds: [], instruction: '', approve: false }] })}><${Icon} name="plus" /> ${t('새 팀')}</button>
    </${PageHead}>
    <div class="cards">
      ${state.teams.map((tm) => html`<div class="gcard" onClick=${() => setEdit(tm)}>
        <div class="nm">👥 ${tm.name}</div>
        <div class="desc">${tm.description}</div>
        <div class="row wrap" style="gap:4px">${tm.stages.map((st, i) => html`${i > 0 && html`<span class="stage-arrow">→</span>`}<span class="stage">${st.label}${st.approve ? ' ✋' : ''}</span>`)}</div>
        <div class="row" style="gap:-6px">${[...new Set(tm.stages.flatMap((s) => s.agentIds))].map((id) => agentById(id)).filter(Boolean).map((a) => html`<span title=${`${a.name} · ${a.model}`}><${Avatar} agent=${a} size=${28} /></span>`)}</div>
      </div>`)}
      <div class="gcard add" onClick=${() => setEdit({ name: '', description: '', stages: [{ label: t('{n}단계', { n: 1 }), agentIds: [], instruction: '', approve: false }] })}><${Icon} name="plus" size=${22} />${t('새 팀')}</div>
    </div>
    <div class="section">📐 ${t('빠른 템플릿')}</div>
    <div class="row wrap">${TEMPLATES().map((tp) => html`<button class="btn" onClick=${() => setEdit(fromTemplate(tp))}>${tp.name}</button>`)}</div>
    ${edit && html`<${TeamEditor} team=${edit} onClose=${() => setEdit(null)} />`}
  </div></div>`;
}

function fromTemplate(tp) {
  const byRole = (r) => state.agents.filter((a) => a.provider !== 'mock' && a.role === r.replace('*', ''));
  return {
    name: tp.name, description: t('템플릿으로 만든 팀'),
    stages: tp.stages.map(([label, role, approve]) => ({ label, agentIds: role.endsWith('*') ? byRole(role).map((a) => a.id).slice(0, 3) : byRole(role).slice(0, 1).map((a) => a.id), instruction: '', approve: !!approve })),
  };
}

function TeamEditor({ team, onClose }) {
  const isNew = !team.id;
  const [tm, setT] = useState(() => structuredClone(team));
  const setStage = (i, k, v) => setT((x) => ({ ...x, stages: x.stages.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));
  const move = (i, d) => setT((x) => { const st = [...x.stages]; const [m] = st.splice(i, 1); st.splice(i + d, 0, m); return { ...x, stages: st }; });
  const save = async () => {
    try {
      if (isNew) await post('/api/teams', tm); else await put(`/api/teams/${tm.id}`, tm);
      toast(t('저장했어'), 'ok');
      onClose();
    } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async () => {
    if (!confirm(t("'{name}' 팀을 삭제할까?", { name: tm.name }))) return;
    try { await del(`/api/teams/${tm.id}`); onClose(); } catch (e) { toast(e.message, 'error'); }
  };
  const start = async () => {
    try {
      let id = tm.id;
      if (isNew) id = (await post('/api/teams', tm)).id; else await put(`/api/teams/${tm.id}`, tm);
      const s = await post('/api/sessions', { teamId: id, title: t('{name} 작업', { name: tm.name }) });
      onClose();
      (await import('../state.js')).go('session', s.id);
    } catch (e) { toast(e.message, 'error'); }
  };
  return html`<${Modal} title=${isNew ? t('새 팀 배치') : t('팀 편집 — {name}', { name: team.name })} onClose=${onClose} size="wide" foot=${html`
    ${!isNew && html`<button class="btn danger" onClick=${remove}><${Icon} name="trash" /> ${t('삭제')}</button>`}
    <span style="flex:1"></span>
    <button class="btn" onClick=${start}><${Icon} name="play" /> ${t('저장하고 이 팀으로 새 세션')}</button>
    <button class="btn" onClick=${onClose}>${t('취소')}</button>
    <button class="btn primary" onClick=${save}>${t('저장')}</button>`}>
    <div class="grid2">
      <div class="field"><label>${t('팀 이름')}</label><input class="input" value=${tm.name} onInput=${(e) => setT({ ...tm, name: e.target.value })} placeholder=${t('예: 신제품 TF')} /></div>
      <div class="field"><label>${t('설명')}</label><input class="input" value=${tm.description} onInput=${(e) => setT({ ...tm, description: e.target.value })} /></div>
    </div>
    <div class="pipeline-editor">
      ${tm.stages.map((st, i) => html`<div class="stage-row">
        <div class="stage-num">${i + 1}</div>
        <div>
          <div class="grid2" style="grid-template-columns:180px 1fr">
            <div class="field" style="margin-bottom:8px"><label>${t('단계 이름')}</label><input class="input" value=${st.label} onInput=${(e) => setStage(i, 'label', e.target.value)} /></div>
            <div class="field" style="margin-bottom:8px"><label>${t('담당 에이전트')} ${st.agentIds.length > 1 ? html`<span class="chip accent">${t('병렬 {n}명', { n: st.agentIds.length })}</span>` : ''}</label>
              <div class="pick">${state.agents.map((a) => html`<span class=${`chip${st.agentIds.includes(a.id) ? ' on' : ''}`} title=${`${a.role} · ${a.model} · ${EFFORT_LABEL[a.effort] || ''}`} onClick=${() => setStage(i, 'agentIds', st.agentIds.includes(a.id) ? st.agentIds.filter((x) => x !== a.id) : [...st.agentIds, a.id])}>${a.emoji} ${a.name}<span class="muted">·${({ claude: 'C', codex: 'G', gemini: 'Gm', hermes: 'H', openai: 'API', mock: t('데모') })[a.provider] || ''}</span></span>`)}</div>
            </div>
          </div>
          <div class="field" style="margin-bottom:6px"><label>${t('이 단계 지시 (선택)')}</label><input class="input" value=${st.instruction} onInput=${(e) => setStage(i, 'instruction', e.target.value)} placeholder=${t('예: 출처 링크를 꼭 붙여')} /></div>
          <div class="row"><${Toggle} checked=${st.approve} onChange=${(v) => setStage(i, 'approve', v)} /><span class="small">${t('이 단계가 끝나면 내 승인을 기다리기 (수정 요청 가능)')}</span></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px">
          <button class="icon-btn" title=${t('위로')} disabled=${i === 0} onClick=${() => move(i, -1)}>▲</button>
          <button class="icon-btn" title=${t('아래로')} disabled=${i === tm.stages.length - 1} onClick=${() => move(i, 1)}>▼</button>
          <button class="icon-btn" title=${t('단계 삭제')} onClick=${() => setT({ ...tm, stages: tm.stages.filter((_, j) => j !== i) })}><${Icon} name="trash" /></button>
        </div>
      </div>`)}
      <button class="btn" onClick=${() => setT({ ...tm, stages: [...tm.stages, { label: t('{n}단계', { n: tm.stages.length + 1 }), agentIds: [], instruction: '', approve: false }] })}><${Icon} name="plus" /> ${t('단계 추가')}</button>
    </div>
  </${Modal}>`;
}

// ── 커넥터(MCP) ──
const MCP_PRESETS = () => [
  { name: t('파일 시스템'), type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', t('C:/작업폴더')] },
  { name: t('웹 가져오기(Fetch)'), type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
  { name: t('Playwright 브라우저'), type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  { name: t('GitHub (원격)'), type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
  { name: t('Context7 문서'), type: 'http', url: 'https://mcp.context7.com/mcp' },
];

export function ConnectorsPage() {
  const [edit, setEdit] = useState(null);
  const [existing, setExisting] = useState(null);
  useEffect(() => { get('/api/connectors/existing').then(setExisting).catch(() => setExisting([])); }, []);
  const toggle = async (c, v) => { try { await put(`/api/connectors/${c.id}`, { ...c, enabled: v }); } catch (e) { toast(e.message, 'error'); } };
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('커넥터')} desc=${t('MCP 서버를 등록해 두면 에이전트별로 켜서 쓸 수 있어 (Claude·Codex에 실행할 때마다 주입).')}>
      <button class="btn primary" onClick=${() => setEdit({ type: 'stdio', args: [], env: {}, headers: {} })}><${Icon} name="plus" /> ${t('커넥터 추가')}</button>
    </${PageHead}>
    <div class="warnbox" style="margin-bottom:14px">${t('MCP 서버는 내 PC에서 명령을 실행할 수 있어. 출처를 믿을 수 있는 것만 추가해.')}</div>
    <div class="list">
      ${state.connectors.map((c) => html`<div class="li-row">
        <span style="font-size:20px">🔌</span>
        <div class="grow"><div class="t">${c.name} <span class="chip mono">${c.key}</span> <span class="chip">${c.type}</span></div><div class="d mono ellipsis">${c.type === 'http' ? c.url : [c.command, ...(c.args || [])].join(' ')}</div>
          <div class="d">${t('사용 에이전트: {names}', { names: state.agents.filter((a) => a.connectors?.includes(c.id)).map((a) => a.name).join(', ') || t('없음') })}</div></div>
        <${Toggle} checked=${c.enabled !== false} onChange=${(v) => toggle(c, v)} title=${t('켜기/끄기')} />
        <button class="btn sm" onClick=${() => setEdit(c)}>${t('편집')}</button>
      </div>`)}
      ${!state.connectors.length && html`<div class="li-row muted">${t('아직 앱 커넥터가 없어. 아래 프리셋으로 시작해봐.')}</div>`}
    </div>
    <div class="section">⚡ ${t('프리셋')}</div>
    <div class="row wrap">${MCP_PRESETS().map((p) => html`<button class="btn" onClick=${() => setEdit({ ...p, env: {}, headers: {} })}>${p.name}</button>`)}</div>
    <div class="section">📦 ${t('각 CLI에 이미 등록된 커넥터')} <span class="small muted">${t('(자동으로 같이 쓰임 · 읽기 전용)')}</span></div>
    <div class="list">
      ${existing === null ? html`<div class="li-row muted">${t('불러오는 중…')}</div>` : existing.length ? existing.map((c) => html`<div class="li-row"><${ProviderChip} id=${c.source} /><div class="grow"><div class="t">${c.name}</div><div class="d mono ellipsis">${c.target}</div></div><span class="chip">${c.type}</span></div>`) : html`<div class="li-row muted">${t('찾은 게 없어.')}</div>`}
    </div>
    ${edit && html`<${ConnectorEditor} c=${edit} onClose=${() => setEdit(null)} />`}
  </div></div>`;
}

function kvText(o) { return Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join('\n'); }
function parseKv(txt) { const o = {}; for (const l of txt.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } return o; }

function ConnectorEditor({ c, onClose }) {
  const isNew = !c.id;
  const [x, setX] = useState(() => ({ ...c, argsText: (c.args || []).join(' '), envText: kvText(c.env), headersText: kvText(c.headers) }));
  const save = async () => {
    const body = { ...x, args: x.argsText.split(/\s+/).filter(Boolean), env: parseKv(x.envText), headers: parseKv(x.headersText) };
    try { if (isNew) await post('/api/connectors', body); else await put(`/api/connectors/${x.id}`, body); toast(t('저장했어'), 'ok'); onClose(); } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async () => { if (!confirm(t('이 커넥터를 삭제할까?'))) return; try { await del(`/api/connectors/${x.id}`); onClose(); } catch (e) { toast(e.message, 'error'); } };
  return html`<${Modal} title=${isNew ? t('커넥터 추가') : t('커넥터 편집')} onClose=${onClose} foot=${html`${!isNew && html`<button class="btn danger" onClick=${remove}>${t('삭제')}</button>`}<span style="flex:1"></span><button class="btn" onClick=${onClose}>${t('취소')}</button><button class="btn primary" disabled=${!x.name} onClick=${save}>${t('저장')}</button>`}>
    <div class="grid2">
      <div class="field"><label>${t('이름')}</label><input class="input" value=${x.name || ''} onInput=${(e) => setX({ ...x, name: e.target.value })} /></div>
      <div class="field"><label>${t('방식')}</label><div class="seg"><button class=${x.type === 'stdio' ? 'on' : ''} onClick=${() => setX({ ...x, type: 'stdio' })}>${t('로컬 명령(stdio)')}</button><button class=${x.type === 'http' ? 'on' : ''} onClick=${() => setX({ ...x, type: 'http' })}>${t('원격(HTTP)')}</button></div></div>
    </div>
    ${x.type === 'stdio' ? html`
      <div class="field"><label>${t('명령')}</label><input class="input mono" value=${x.command || ''} onInput=${(e) => setX({ ...x, command: e.target.value })} placeholder="npx" /></div>
      <div class="field"><label>${t('인자 (공백으로 구분)')}</label><input class="input mono" value=${x.argsText} onInput=${(e) => setX({ ...x, argsText: e.target.value })} /></div>
      <div class="field"><label>${t('환경 변수 (줄마다 이름=값)')}</label><textarea class="textarea mono" value=${x.envText} onInput=${(e) => setX({ ...x, envText: e.target.value })}></textarea></div>`
    : html`
      <div class="field"><label>URL</label><input class="input mono" value=${x.url || ''} onInput=${(e) => setX({ ...x, url: e.target.value })} placeholder="https://…/mcp" /></div>
      <div class="field"><label>${t('헤더 (줄마다 이름=값)')}</label><textarea class="textarea mono" value=${x.headersText} onInput=${(e) => setX({ ...x, headersText: e.target.value })} placeholder="Authorization=Bearer …"></textarea></div>`}
  </${Modal}>`;
}

// ── 스킬 ──
export function SkillsPage() {
  const [edit, setEdit] = useState(null);
  const [view, setView] = useState(null);
  const [q, setQ] = useState('');
  const rescan = async () => { try { state.skills = await get('/api/skills?rescan=1'); changed(); toast(t('다시 찾았어'), 'ok'); } catch (e) { toast(e.message, 'error'); } };
  const open = async (k) => { try { const full = await get(`/api/skills/${encodeURIComponent(k.id)}`); if (k.readOnly) setView(full); else setEdit(full); } catch (e) { toast(e.message, 'error'); } };
  const list = state.skills.filter((k) => !q || `${k.name} ${k.description}`.toLowerCase().includes(q.toLowerCase()));
  const groups = [['app', t('앱 스킬')], ['plugin', t('플러그인 스킬')], ['claude', t('Claude Code 스킬')], ['codex', t('Codex 스킬')], ['agents', t('공용(.agents) 스킬')], ['gemini', t('Gemini 스킬')]];
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('스킬')} desc=${t('자주 쓰는 지침 묶음. 입력창에서 /이름 으로 실행하거나, 에이전트에 붙여 항상 적용해.')}>
      <button class="btn" onClick=${rescan}><${Icon} name="refresh" /> ${t('다시 찾기')}</button>
      <button class="btn primary" onClick=${() => setEdit({ name: '', description: '', content: '' })}><${Icon} name="plus" /> ${t('새 스킬')}</button>
    </${PageHead}>
    <input class="input" style="margin-bottom:12px" placeholder=${t('스킬 검색')} value=${q} onInput=${(e) => setQ(e.target.value)} />
    ${groups.map(([src, label]) => {
      const items = list.filter((k) => k.source === src);
      if (!items.length) return null;
      return html`<div class="section">${label} <span class="chip">${items.length}</span></div>
        <div class="list">${items.slice(0, 200).map((k) => html`<div class="li-row" style="cursor:pointer" onClick=${() => open(k)}>
          <span>✨</span><div class="grow"><div class="t">/${k.name}</div><div class="d ellipsis">${k.description}</div></div>${k.readOnly ? html`<span class="chip">${t('읽기 전용')}</span>` : html`<span class="chip accent">${t('편집')}</span>`}
        </div>`)}</div>`;
    })}
    ${!list.length && html`<div class="empty">${t('스킬이 없어.')}</div>`}
    ${edit && html`<${SkillEditor} k=${edit} onClose=${() => setEdit(null)} />`}
    ${view && html`<${Modal} title=${`/${view.name}`} onClose=${() => setView(null)} size="wide" foot=${html`
      <button class="btn" onClick=${async () => { try { await post('/api/skills', { name: view.name, description: view.description, content: view.content }); toast(t('앱 스킬로 복사했어(편집 가능)'), 'ok'); setView(null); } catch (e) { toast(e.message, 'error'); } }}><${Icon} name="copy" /> ${t('앱 스킬로 복사')}</button>
      <button class="btn primary" onClick=${() => setView(null)}>${t('닫기')}</button>`}>
      <div class="small muted" style="margin-bottom:8px">${view.path}</div><p>${view.description}</p><pre class="raw">${view.content}</pre>
    </${Modal}>`}
  </div></div>`;
}

function SkillEditor({ k, onClose }) {
  const isNew = !k.id;
  const [x, setX] = useState(() => ({ ...k }));
  const save = async () => { try { if (isNew) await post('/api/skills', x); else await put(`/api/skills/${x.id}`, x); toast(t('저장했어'), 'ok'); onClose(); } catch (e) { toast(e.message, 'error'); } };
  const remove = async () => { if (!confirm(t('이 스킬을 삭제할까?'))) return; try { await del(`/api/skills/${x.id}`); onClose(); } catch (e) { toast(e.message, 'error'); } };
  return html`<${Modal} title=${isNew ? t('새 스킬') : t('스킬 편집 — /{name}', { name: k.name })} onClose=${onClose} size="wide" foot=${html`${!isNew && html`<button class="btn danger" onClick=${remove}>${t('삭제')}</button>`}<span style="flex:1"></span><button class="btn" onClick=${onClose}>${t('취소')}</button><button class="btn primary" disabled=${!x.name?.trim()} onClick=${save}>${t('저장')}</button>`}>
    <div class="grid2">
      <div class="field"><label>${t('이름 (/뒤에 쓰는 이름)')}</label><input class="input" value=${x.name} onInput=${(e) => setX({ ...x, name: e.target.value.replace(/\s+/g, '-') })} placeholder=${t('예: 3줄요약')} /></div>
      <div class="field"><label>${t('설명')}</label><input class="input" value=${x.description} onInput=${(e) => setX({ ...x, description: e.target.value })} /></div>
    </div>
    <div class="field"><label>${t('지침 내용 (마크다운)')}</label><textarea class="textarea mono" style="min-height:300px" value=${x.content} onInput=${(e) => setX({ ...x, content: e.target.value })} placeholder=${t('이 스킬이 실행될 때 에이전트가 따를 단계·규칙·출력 형식')}></textarea></div>
  </${Modal}>`;
}

// ── 플러그인 ──
export function PluginsPage() {
  const [native, setNative] = useState(null);
  const [exp, setExp] = useState(null);
  const importFile = async (file) => {
    try {
      const json = JSON.parse(await file.text());
      // 설치 전에 무엇이 들어오는지 보여주고 위험 항목은 따로 경고
      const full = (json.agents || []).filter((x) => x.permission === 'full').map((x) => x.name);
      const cmds = (json.connectors || []).filter((x) => x.type !== 'http').map((x) => `${x.name}: ${[x.command, ...(x.args || [])].join(' ')}`);
      const summary = [
        t("'{name}'을(를) 설치할까?", { name: json.name || t('플러그인') }),
        t('에이전트 {a} · 팀 {t} · 스킬 {s} · 커넥터 {c} · 스킨 {k}', { a: json.agents?.length || 0, t: json.teams?.length || 0, s: json.skills?.length || 0, c: json.connectors?.length || 0, k: json.skins?.length || 0 }),
        full.length ? `\n⚠ ${t("'전부 허용' 권한 에이전트: {names}", { names: full.join(', ') })}` : '',
        cmds.length ? `\n⚠ ${t('내 PC에서 실행될 명령(커넥터):')}\n${cmds.join('\n')}` : '',
      ].filter(Boolean).join('\n');
      if (!confirm(summary)) return;
      const p = await post('/api/plugins/import', json);
      toast(t("'{name}' 설치 완료", { name: p.name }), 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };
  const loadNative = async () => { setNative('loading'); try { setNative(await get('/api/plugins/native')); } catch (e) { setNative([]); toast(e.message, 'error'); } };
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('플러그인')} desc=${t('에이전트·팀·스킬·커넥터·스킨을 하나의 파일(.json)로 묶어 공유하고 설치해.')}>
      <label class="btn"><${Icon} name="upload" /> ${t('플러그인 설치(.json)')}<input type="file" accept=".json,application/json" hidden onChange=${(e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; }} /></label>
      <button class="btn primary" onClick=${() => setExp({ name: '', description: '', agentIds: [], teamIds: [], skillIds: [], connectorIds: [], skinIds: [] })}><${Icon} name="download" /> ${t('내보내기')}</button>
    </${PageHead}>
    <div class="list">
      ${state.plugins.map((p) => html`<div class="li-row"><span style="font-size:20px">🧩</span><div class="grow"><div class="t">${p.name}</div><div class="d">${p.description} · ${t('에이전트 {a} · 팀 {t} · 스킬 {s} · 커넥터 {c}', { a: p.items?.agents?.length || 0, t: p.items?.teams?.length || 0, s: p.items?.skills?.length || 0, c: p.items?.connectors?.length || 0 })}</div></div>
        <button class="btn sm danger" onClick=${async () => { if (confirm(t("'{name}'과(와) 함께 설치된 항목을 모두 지울까?", { name: p.name }))) { try { await del(`/api/plugins/${p.id}`); toast(t('제거했어'), 'ok'); } catch (e) { toast(e.message, 'error'); } } }}>${t('제거')}</button></div>`)}
      ${!state.plugins.length && html`<div class="li-row muted">${t('설치된 플러그인이 없어. 다른 사람이 내보낸 .json 파일을 설치하거나, 내 팀을 내보내 공유해봐.')}</div>`}
    </div>
    <div class="section">🧰 ${t('각 CLI의 플러그인')} <span class="small muted">${t('(Claude Code·Codex에 설치된 것 — 실행 때 그대로 쓰임)')}</span> <button class="btn sm" onClick=${loadNative}>${t('불러오기')}</button></div>
    ${native === 'loading' && html`<div class="muted">${t('불러오는 중…')}</div>`}
    ${Array.isArray(native) && native.map((n) => html`<div class="card"><h4><${ProviderChip} id=${n.cli} /> ${n.ok ? '' : html`<span class="chip warn">${t('명령 실패')}</span>`}</h4><pre class="raw">${n.text || t('(없음)')}</pre></div>`)}
    ${exp && html`<${ExportModal} e=${exp} onClose=${() => setExp(null)} />`}
  </div></div>`;
}

function ExportModal({ e, onClose }) {
  const [x, setX] = useState(e);
  const togg = (k, id) => setX({ ...x, [k]: x[k].includes(id) ? x[k].filter((y) => y !== id) : [...x[k], id] });
  const go = async () => {
    try {
      const bundle = await post('/api/plugins/export', x);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(x.name || 'office-crew-plugin').replace(/[\\/:*?"<>|]+/g, '_')}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(t('파일로 내보냈어 (API 키는 안 들어가)'), 'ok');
      onClose();
    } catch (err) { toast(err.message, 'error'); }
  };
  const Sec = (label, k, items) => html`<div class="field"><label>${label}</label><div class="pick">${items.map((it) => html`<span class=${`chip${x[k].includes(it.id) ? ' on' : ''}`} onClick=${() => togg(k, it.id)}>${it.name}</span>`)}</div></div>`;
  return html`<${Modal} title=${t('플러그인으로 내보내기')} onClose=${onClose} size="wide" foot=${html`<button class="btn" onClick=${onClose}>${t('취소')}</button><button class="btn primary" onClick=${go}><${Icon} name="download" /> ${t('.json 저장')}</button>`}>
    <div class="grid2">
      <div class="field"><label>${t('이름')}</label><input class="input" value=${x.name} onInput=${(ev) => setX({ ...x, name: ev.target.value })} placeholder=${t('예: 우리 팀 리서치 세트')} /></div>
      <div class="field"><label>${t('설명')}</label><input class="input" value=${x.description} onInput=${(ev) => setX({ ...x, description: ev.target.value })} /></div>
    </div>
    ${Sec(t('팀 (팀에 속한 에이전트는 자동 포함)'), 'teamIds', state.teams)}
    ${Sec(t('에이전트'), 'agentIds', state.agents)}
    ${Sec(t('스킬'), 'skillIds', state.skills.filter((k) => !k.readOnly).concat(state.skills.filter((k) => k.readOnly).slice(0, 40)))}
    ${Sec(t('커넥터'), 'connectorIds', state.connectors)}
    ${state.skins.length > 0 && Sec(t('사무실 스킨'), 'skinIds', state.skins)}
  </${Modal}>`;
}
