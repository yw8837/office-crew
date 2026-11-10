// 프로젝트 기억 보기: 작업 폴더별로 쌓인 대화 원문을 찾아본다(읽기만, AI 사용량 0)
import { useEffect, useState } from 'preact/hooks';
import { html, Icon, fmtTok } from '../ui.js';
import { state, go, toast } from '../state.js';
import { get, put } from '../api.js';
import { PageHead } from './manage.js';
import { t, locale } from '../i18n/index.js';

// 글자 수 → 토큰 어림값. 모델·언어마다 달라서 정확하지 않다(한글·영문이 섞인 글에서 글자 둘에 토큰 하나쯤)
export const roughTokens = (chars) => Math.round((chars || 0) / 2);
const folderName = (p) => (p.cwd ? p.cwd.split(/[\\/]/).filter(Boolean).pop() : t('작업 폴더를 안 정한 세션'));
const when = (ms) => new Date(ms).toLocaleString(locale(), { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// 세션 상태 줄에 붙는 표시: 이 세션이 쓰는 기억에 쌓인 양
export function MemoryBadge({ s }) {
  const [m, setM] = useState(null);
  const on = state.settings.memory === true;
  const runs = s.runs?.length || 0;
  const ended = s.runs?.at(-1)?.endedAt || 0;
  useEffect(() => {
    if (!on) { setM(null); return undefined; }
    let alive = true;
    // 답이 끝난 뒤 저장되는 데 잠깐 걸려서 조금 늦게 읽는다
    const id = setTimeout(() => get(`/api/sessions/${s.id}/memory`).then((d) => { if (alive) setM(d); }).catch(() => {}), 600);
    return () => { alive = false; clearTimeout(id); };
  }, [s.id, on, runs, ended]);
  if (!on || !m) return null;
  return html`<button class="mem-badge" title=${t('이 세션의 작업 폴더에 쌓인 대화. 전부 원문 그대로 보관돼 있고, 실행마다 관련된 조각만 꺼내 넣어. 눌러서 찾아봐.')} onClick=${() => { state.ui.memoryKey = m.key; go('memory'); }}>
    🧠 ${t('쌓인 맥락 약 {n} 토큰', { n: fmtTok(roughTokens(m.chars)) })}
  </button>`;
}

export function MemoryPage() {
  const [data, setData] = useState(null);
  const [key, setKey] = useState(state.ui.memoryKey || '');
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => get('/api/memory').then((d) => { setData(d); if (!key && d.projects[0]) setKey(d.projects[0].key); }).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []);
  const search = async (e) => {
    e?.preventDefault();
    if (!key || !q.trim()) return;
    setBusy(true);
    try { setRes(await get(`/api/memory/search?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q.trim())}`)); } catch (err) { toast(err.message, 'error'); }
    setBusy(false);
  };
  const turnOn = () => put('/api/settings', { memory: true }).then(load).catch((e) => toast(e.message, 'error'));
  const projects = data?.projects || [];
  const cur = projects.find((p) => p.key === key);
  const total = projects.reduce((n, p) => n + p.chars, 0);

  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('기억')} desc=${t('끝난 대화를 작업 폴더별로 원문 그대로 쌓아 둔 곳이야. 실행을 시작할 때 요청과 관련된 조각만 여기서 꺼내 에이전트에게 줘. 찾는 데 AI를 쓰지 않아.')} />
    ${data && !data.on && html`<div class="card"><div class="row"><span>${t('프로젝트 기억이 꺼져 있어. 켜면 그 뒤의 대화부터 쌓여.')}</span><span class="grow"></span><button class="btn primary sm" onClick=${turnOn}>${t('켜기')}</button></div></div>`}
    ${data && !projects.length && html`<div class="muted" style="padding:20px 4px">${t('아직 쌓인 기억이 없어.')}</div>`}
    ${projects.length > 0 && html`
      <div class="small muted" style="margin:4px 2px 10px">${t('전체 약 {n} 토큰 · {c}자 · 폴더 {k}개', { n: fmtTok(roughTokens(total)), c: total.toLocaleString(locale()), k: projects.length })} <span title=${t('토큰 수는 글자 수로 어림한 값이야(글자 둘에 토큰 하나쯤). 모델과 언어에 따라 달라.')}>ⓘ</span></div>
      <div class="mem-projects">
        ${projects.map((p) => html`<button class=${`mem-proj${p.key === key ? ' on' : ''}`} onClick=${() => { setKey(p.key); setRes(null); }} title=${p.cwd || ''}>
          <b>${folderName(p)}</b>
          <span class="small muted">${t('약 {n} 토큰 · 조각 {k}개', { n: fmtTok(roughTokens(p.chars)), k: p.chunks.toLocaleString(locale()) })}</span>
        </button>`)}
      </div>
      <form class="row" style="margin:14px 0 8px" onSubmit=${search}>
        <input class="input" style="flex:1" placeholder=${t('이 기억에서 찾을 말 (예: 결제 서버 포트)')} value=${q} onInput=${(e) => setQ(e.target.value)} aria-label=${t('기억 검색')} />
        <button class="btn primary" disabled=${busy || !q.trim() || !cur}><${Icon} name="search" /> ${t('찾기')}</button>
      </form>
      <div class="hint">${t('낱말이 겹치는 내용만 찾을 수 있어. 다른 말로 물으면 못 찾을 수 있으니 핵심 낱말로 찾아봐.')}</div>
      ${res && html`<div class="mem-results">
        ${!res.hits.length && html`<div class="muted" style="padding:14px 2px">${t('관련된 조각을 찾지 못했어.')}</div>`}
        ${res.hits.map((h, i) => html`<div class="mem-hit">
          <div class="mem-src">
            <span class="chip">${t('기억 {n}', { n: i + 1 })}</span>
            <span>${when(h.at)}</span>
            <span>·</span>
            <span>${h.role === 'user' ? t('사용자') : (h.who || 'AI')}</span>
            <span>·</span>
            ${h.sessionExists
              ? html`<a href="#" onClick=${(e) => { e.preventDefault(); go('session', h.sessionId); }}>${h.sessionTitle || t('세션')}</a>`
              : html`<span class="muted" title=${t('세션은 지워졌지만 기억에는 남아 있어.')}>${h.sessionTitle || t('지워진 세션')}</span>`}
            ${h.parts > 1 && html`<span class="muted">(${h.part + 1}/${h.parts})</span>`}
          </div>
          <div class="mem-text">${h.text}</div>
        </div>`)}
      </div>`}`}
  </div></div>`;
}
