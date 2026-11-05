// 에이전트 스킬 고르기: 역할 추천 · 이 AI의 스킬 · 선택됨 · 전체를 탭으로, 한글 설명과 함께 체크해서 고른다
import { useState } from 'preact/hooks';
import { html } from '../ui.js';
import { state } from '../state.js';
import { t, getLang } from '../i18n/index.js';

export const SOURCE_LABEL = () => ({ app: t('앱'), plugin: t('플러그인'), claude: 'Claude', codex: 'Codex', agents: t('공용'), gemini: 'Gemini' });

// 화면 언어가 한국어면 한글 설명을 먼저
export const skillDesc = (k) => (getLang() === 'ko' && k.descKo) || k.description || '';

// 역할 종류별로 스킬 이름·설명에서 찾을 말(서버 routing.js 의 역할 분류와 같은 종류)
const ROLE_WORDS = {
  research: /research|search|crawl|scrap|fetch|web|browse|조사|검색|리서치/i,
  organize: /summar|organi|note|report|memory|wiki|정리|요약|보고/i,
  analysis: /analy|plan|design|architect|brainstorm|strategy|분석|계획|설계|기획/i,
  build: /implement|build|code|coding|tdd|execut|debug|refactor|frontend|backend|구현|개발|빌드|코드/i,
  review: /review|verif|audit|test|qa|security|lint|검토|검수|검증|테스트|리뷰/i,
  writing: /writ|copy|humaniz|blog|translat|docs|content|글|작성|번역|윤문/i,
};
function roleKind(role = '') {
  const r = String(role).toLowerCase();
  if (/조사|검색|리서치|research|search|调研|调查|検索|調査|リサーチ/.test(r)) return 'research';
  if (/정리|요약|organize|summar|整理|总结|要約/.test(r)) return 'organize';
  if (/검수|리뷰|테스트|검토|review|test|qa|审查|测试|レビュー|テスト/.test(r)) return 'review';
  if (/빌드|구현|개발|코딩|build|implement|code|dev|构建|开发|実装|開発|ビルド/.test(r)) return 'build';
  if (/분석|계획|기획|설계|analy|plan|design|分析|计划|設計|計画/.test(r)) return 'analysis';
  if (/글|작성|번역|write|writ|translat|写作|翻译|執筆|翻訳/.test(r)) return 'writing';
  return 'general';
}

// 같은 이름의 스킬(Claude·Codex 에 같이 깔린 것)은 하나로: 이 AI 의 것을 먼저, 나머지 출처는 표시만
function merged(skills, provider) {
  const by = new Map();
  for (const k of skills) {
    const key = k.name.toLowerCase();
    const cur = by.get(key);
    if (!cur) { by.set(key, { ...k, sources: [k.source], ids: [k.id] }); continue; }
    cur.sources.push(k.source); cur.ids.push(k.id);
    if (k.source === provider && cur.source !== provider) Object.assign(cur, { ...k, sources: cur.sources, ids: cur.ids });
  }
  return [...by.values()];
}

export function SkillPicker({ agent, onChange }) {
  const [tab, setTab] = useState(null);
  const [q, setQ] = useState('');
  const picked = new Set(agent.skills || []);
  // Codex 추가 계정 에이전트도 Codex 스킬을 "이 AI 스킬"로
  const base = state.providers.find((p) => p.id === agent.provider)?.base || agent.provider;
  const all = merged(state.skills, base);
  const isOn = (k) => k.ids.some((id) => picked.has(id));
  const toggle = (k) => onChange(isOn(k) ? (agent.skills || []).filter((id) => !k.ids.includes(id)) : [...(agent.skills || []), k.id]);
  const kind = roleKind(agent.role);
  const words = ROLE_WORDS[kind];
  const hay = (k) => `${k.name} ${k.description} ${k.descKo || ''}`;
  const lists = {
    rec: words ? all.filter((k) => words.test(hay(k))) : [],
    mine: all.filter((k) => k.sources.includes(base) || k.source === 'app' || k.source === 'plugin'),
    on: all.filter(isOn),
    all,
  };
  const cur = tab && (tab !== 'rec' || lists.rec.length) ? tab : (lists.rec.length ? 'rec' : 'mine');
  const needle = q.trim().toLowerCase();
  const shown = (needle ? all : lists[cur]).filter((k) => !needle || hay(k).toLowerCase().includes(needle));
  const TABS = [['rec', t('역할 추천')], ['mine', base === 'codex' ? t('Codex 스킬') : base === 'claude' ? t('Claude 스킬') : t('앱 스킬')], ['on', t('선택됨')], ['all', t('전체')]];
  const SRC = SOURCE_LABEL();
  return html`<div class="skill-pick">
    <div class="row wrap" style="gap:6px;margin-bottom:6px">
      <div class="seg" role="tablist" aria-label=${t('스킬 보기')}>${TABS.filter(([k]) => k !== 'rec' || lists.rec.length).map(([k, l]) => html`<button role="tab" aria-selected=${!needle && cur === k} class=${!needle && cur === k ? 'on' : ''} onClick=${() => { setTab(k); setQ(''); }}>${l} <span class="muted">${lists[k].length}</span></button>`)}</div>
      <input class="input" style="flex:1;min-width:160px" placeholder=${t('스킬 검색 ({n}개)', { n: all.length })} aria-label=${t('스킬 검색')} value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>
    ${cur === 'mine' && !needle && ['claude', 'codex'].includes(base) && html`<div class="hint" style="margin-bottom:6px">${t('이 AI의 CLI에 깔린 스킬은 보통 필요할 때 CLI가 알아서 꺼내 써. 여기서 고르면 매번 지침에 붙여서 항상 적용돼(토큰을 더 써).')}</div>`}
    <div class="skill-list" role="list">
      ${shown.slice(0, 80).map((k) => html`<label class=${`skill-row${isOn(k) ? ' on' : ''}`} role="listitem">
        <input type="checkbox" checked=${isOn(k)} onChange=${() => toggle(k)} />
        <span class="grow"><b>/${k.name}</b> ${k.sources.map((s) => html`<span class="src">${SRC[s] || s}</span>`)}<span class="d">${skillDesc(k)}</span></span>
      </label>`)}
      ${!shown.length && html`<div class="small muted" style="padding:10px">${needle ? t('검색 결과 없음') : cur === 'on' ? t('아직 고른 스킬이 없어.') : t('스킬이 없어. 스킬 메뉴에서 만들거나 가져와.')}</div>`}
      ${shown.length > 80 && html`<div class="small muted" style="padding:8px 10px">${t('외 {n}개 — 검색해서 찾아', { n: shown.length - 80 })}</div>`}
    </div>
  </div>`;
}
