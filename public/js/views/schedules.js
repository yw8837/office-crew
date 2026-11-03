// 예약 작업: 정해 둔 요일·시각에 팀(또는 에이전트 한 명)이 알아서 출근해서 일한다
import { useState } from 'preact/hooks';
import { html, Icon, Modal, Toggle, ago } from '../ui.js';
import { state, toast, go, agentById, teamById } from '../state.js';
import { post, put, del } from '../api.js';
import { PageHead } from './manage.js';
import { t, locale } from '../i18n/index.js';

const WEEK = [1, 2, 3, 4, 5, 6, 0]; // 월요일부터
const dayName = (d) => new Date(2026, 10, 1 + d).toLocaleDateString(locale(), { weekday: 'short' }); // 2026-11-01 은 일요일
const daysText = (days) => (days.length === 7 ? t('매일') : days.join() === '1,2,3,4,5' ? t('평일') : days.join() === '0,6' ? t('주말') : WEEK.filter((d) => days.includes(d)).map(dayName).join(' '));
const when = (ms) => new Date(ms).toLocaleString(locale(), { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const LAST = () => ({ started: ['✅', t('실행함')], missed: ['💤', t('놓침')], skipped: ['⏭️', t('건너뜀')], error: ['🛑', t('오류')] });
// 최근 회차 세션이 지금 어떤 상태인지(시작만 했는지, 승인을 기다리는지, 끝났는지)
const LIVE = () => ({ approve: ['✋', t('승인 필요')], decide: ['⚠️', t('결정 필요')], failed: ['🛑', t('오류로 멈춤')], paused: ['⏸️', t('일시정지됨')], done: ['🏁', t('끝남')] });
// 예전 기록(resultSessionId 없음)은 마지막 실행 기록의 세션으로
const resultOf = (s) => s.resultSessionId || s.lastRun?.sessionId || null;
function liveOf(s) {
  const id = resultOf(s);
  if (!id) return null;
  if (state.active.has(id)) return ['🏃', t('작업 중')];
  const m = state.sessions.find((x) => x.id === id);
  return (m?.attention && LIVE()[m.attention.kind]) || null;
}
const targetName = (s) => (s.teamId ? `👥 ${teamById(s.teamId)?.name || t('(없는 팀)')}` : `${agentById(s.agentId)?.emoji || '🤖'} ${agentById(s.agentId)?.name || t('(없는 에이전트)')}`);

const blank = () => ({ name: '', prompt: '', time: '09:00', days: [1, 2, 3, 4, 5], teamId: state.settings.defaultTeamId || state.teams[0]?.id || null, agentId: null, cwd: '', enabled: true, session: 'new', catchUp: false });

export function SchedulesPage() {
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(null);
  const list = [...state.schedules].sort((a, b) => (a.nextAt || Infinity) - (b.nextAt || Infinity));
  const toggle = (s, v) => put(`/api/schedules/${s.id}`, { ...s, enabled: v }).catch((e) => toast(e.message, 'error'));
  // 실제 AI 를 돌려 사용량을 쓰니 한 번 묻고, 요청 중엔 버튼을 잠근다
  const runNow = async (s) => {
    if (busy || !confirm(t("'{name}' 예약을 지금 실행할까? 실제 AI가 일해서 사용량을 써.", { name: s.name }))) return;
    setBusy(s.id);
    try {
      const r = await post(`/api/schedules/${s.id}/run`, {});
      if (r.status === 'started') { toast(t('실행을 시작했어.'), 'ok'); go('session', r.sessionId); } else toast(r.note || t('실행하지 못했어.'), 'error');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(null); }
  };
  const openKey = (e, s) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setEdit(s); } };
  return html`<div class="page"><div class="page-inner">
    <${PageHead} title=${t('예약 작업')} desc=${t('정해 둔 요일·시각이 되면 팀이 알아서 출근해서 일해. 결과는 새 세션으로 남고, 승인 단계가 있으면 기다리는 일에 올라와.')}>
      <button class="btn primary" onClick=${() => setEdit(blank())}><${Icon} name="plus" /> ${t('새 예약')}</button>
    </${PageHead}>
    <div class="notice" style="margin-bottom:14px">⏰ ${t('이 PC에서 앱이 켜져 있을 때만 돌아. 실제 AI를 실행해서 구독 한도를 쓰니까, 자주 돌릴수록 사용량이 늘어.')}</div>
    <div class="cards">
      ${list.map((s) => {
        const [ic, label] = (s.lastRun && LAST()[s.lastRun.status]) || [];
        const live = s.lastRun?.status === 'started' ? liveOf(s) : null;
        return html`<div class=${`gcard${s.enabled ? '' : ' off'}`} role="button" tabindex="0" aria-label=${t('예약 편집 — {name}', { name: s.name })} onClick=${() => setEdit(s)} onKeyDown=${(e) => openKey(e, s)}>
          <div class="row" style="justify-content:space-between">
            <div class="nm">⏰ ${s.name}</div>
            <span style="display:flex" onClick=${(e) => e.stopPropagation()}><${Toggle} checked=${s.enabled} title=${t('예약 켜기')} onChange=${(v) => toggle(s, v)} /></span>
          </div>
          <div class="small"><b>${daysText(s.days)} ${s.time}</b> · ${targetName(s)}</div>
          <div class="desc">${s.prompt}</div>
          <div class="small muted">${s.enabled && s.nextAt ? t('다음: {when}', { when: when(s.nextAt) }) : t('꺼져 있음')}</div>
          ${ic && html`<div class="small muted" title=${s.lastRun.note || ''}>${ic} ${label} · ${ago(s.lastRun.at)}${s.lastRun.note ? ` — ${s.lastRun.note}` : ''}${live ? html` → <b>${live[0]} ${live[1]}</b>` : ''}</div>`}
          <div class="row" style="gap:6px" onClick=${(e) => e.stopPropagation()}>
            <button class="btn sm" disabled=${!!busy} onClick=${() => runNow(s)}><${Icon} name="play" /> ${t('지금 실행')}</button>
            ${resultOf(s) && state.sessions.some((x) => x.id === resultOf(s)) && html`<button class="btn sm ghost" onClick=${() => go('session', resultOf(s))}>${t('최근 결과 보기')}</button>`}
          </div>
        </div>`;
      })}
      <div class="gcard add" role="button" tabindex="0" onClick=${() => setEdit(blank())} onKeyDown=${(e) => openKey(e, blank())}><${Icon} name="plus" size=${22} />${t('새 예약')}</div>
    </div>
    ${edit && html`<${ScheduleEditor} sched=${edit} onClose=${() => setEdit(null)} />`}
  </div></div>`;
}

function ScheduleEditor({ sched, onClose }) {
  const isNew = !sched.id;
  const [s, setS] = useState(() => structuredClone(sched));
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const target = s.teamId ? `team:${s.teamId}` : s.agentId ? `agent:${s.agentId}` : '';
  const pickTarget = (v) => { const [kind, id] = v.split(':'); setS((x) => ({ ...x, teamId: kind === 'team' ? id : null, agentId: kind === 'agent' ? id : null })); };
  const toggleDay = (d) => set('days', s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d]);
  const save = async () => {
    try {
      if (isNew) await post('/api/schedules', s); else await put(`/api/schedules/${s.id}`, s);
      toast(t('저장했어'), 'ok');
      onClose();
    } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async () => {
    if (!confirm(t("'{name}' 예약을 삭제할까?", { name: s.name }))) return;
    try { await del(`/api/schedules/${s.id}`); onClose(); } catch (e) { toast(e.message, 'error'); }
  };
  return html`<${Modal} title=${isNew ? t('새 예약') : t('예약 편집 — {name}', { name: sched.name })} onClose=${onClose} size="wide" foot=${html`
    ${!isNew && html`<button class="btn danger" onClick=${remove}><${Icon} name="trash" /> ${t('삭제')}</button>`}
    <span style="flex:1"></span>
    <button class="btn" onClick=${onClose}>${t('취소')}</button>
    <button class="btn primary" onClick=${save}>${t('저장')}</button>`}>
    <div class="grid2">
      <div class="field"><label for="sc-name">${t('예약 이름')}</label><input id="sc-name" class="input" maxlength="40" value=${s.name} onInput=${(e) => set('name', e.target.value)} placeholder=${t('예: 아침 뉴스 정리')} /></div>
      <div class="field"><label for="sc-target">${t('맡길 팀·에이전트')}</label>
        <select id="sc-target" class="input" value=${target} onChange=${(e) => pickTarget(e.target.value)}>
          <optgroup label=${t('팀')}>${state.teams.map((tm) => html`<option value=${`team:${tm.id}`}>👥 ${tm.name}</option>`)}</optgroup>
          <optgroup label=${t('에이전트 한 명')}>${state.agents.map((a) => html`<option value=${`agent:${a.id}`}>${a.emoji} ${a.name}</option>`)}</optgroup>
        </select>
        ${s.teamId && teamById(s.teamId)?.stages.some((st) => st.approve) && html`<div class="hint">✋ ${t('이 팀엔 승인 단계가 있어. 그 단계에서 내 승인을 기다려.')}</div>`}
      </div>
    </div>
    <div class="field"><label for="sc-prompt">${t('매번 보낼 지시')}</label><textarea id="sc-prompt" class="textarea" rows="4" maxlength="8000" value=${s.prompt} onInput=${(e) => set('prompt', e.target.value)} placeholder=${t('예: 어제 나온 AI 뉴스 5개를 골라 한 줄씩 요약해줘')}></textarea></div>
    <div class="grid2">
      <div class="field"><label for="sc-time">${t('시각')}</label><input id="sc-time" class="input" type="time" value=${s.time} onInput=${(e) => set('time', e.target.value)} onChange=${(e) => set('time', e.target.value)} style="max-width:160px" /></div>
      <div class="field"><label>${t('요일')}</label>
        <div class="pick" role="group" aria-label=${t('요일')}>${WEEK.map((d) => html`<button type="button" class=${`chip${s.days.includes(d) ? ' on' : ''}`} aria-pressed=${s.days.includes(d)} onClick=${() => toggleDay(d)}>${dayName(d)}</button>`)}</div>
        <div class="row" style="gap:4px;margin-top:6px">
          <button class="btn sm ghost" onClick=${() => set('days', [0, 1, 2, 3, 4, 5, 6])}>${t('매일')}</button>
          <button class="btn sm ghost" onClick=${() => set('days', [1, 2, 3, 4, 5])}>${t('평일')}</button>
          <button class="btn sm ghost" onClick=${() => set('days', [0, 6])}>${t('주말')}</button>
        </div>
      </div>
    </div>
    <div class="field"><label>${t('결과를 남길 곳')}</label>
      <div class="seg" role="group" aria-label=${t('결과를 남길 곳')} style="align-self:flex-start"><button class=${s.session === 'new' ? 'on' : ''} aria-pressed=${s.session === 'new'} onClick=${() => set('session', 'new')}>${t('매번 새 세션')}</button><button class=${s.session === 'same' ? 'on' : ''} aria-pressed=${s.session === 'same'} onClick=${() => set('session', 'same')}>${t('같은 세션에 이어서')}</button></div>
      <div class="hint">${s.session === 'same' ? t('앞 회차 대화를 기억하고 이어가. 대화가 길어질수록 매번 읽는 양(토큰)이 늘어.') : t('회차마다 깨끗하게 시작해. 결과가 날짜별 세션으로 쌓여.')}</div>
    </div>
    <div class="field"><label for="sc-cwd">${t('작업 폴더 (선택)')}</label><input id="sc-cwd" class="input" value=${s.cwd} onInput=${(e) => set('cwd', e.target.value)} placeholder=${t('비우면 세션마다 새 폴더')} /></div>
    <div class="field"><div class="row"><${Toggle} checked=${s.catchUp} title=${t('놓친 회차는 앱을 켤 때 한 번 실행')} onChange=${(v) => set('catchUp', v)} /><div><b>${t('놓친 회차는 앱을 켤 때 한 번 실행')}</b><div class="hint">${t('끄면 앱이 꺼져 있던 동안의 회차는 건너뛰어(켜자마자 사용량을 쓰지 않게). 여러 번 놓쳐도 한 번만 실행해.')}</div></div></div></div>
    <div class="field"><div class="row"><${Toggle} checked=${s.enabled} title=${t('예약 켜기')} onChange=${(v) => set('enabled', v)} /><b>${t('예약 켜기')}</b></div></div>
  </${Modal}>`;
}
