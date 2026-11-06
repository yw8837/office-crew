// 칸반 보드: 카드를 팀에게 맡기면 세션 상태에 따라 칸이 저절로 옮겨 간다. 완료만 사람이 정한다
import { useState } from 'preact/hooks';
import { html, Icon, Modal, ago } from '../ui.js';
import { state, toast, go, agentById, teamById } from '../state.js';
import { post, put, del } from '../api.js';
import { PageHead } from './manage.js';
import { t } from '../i18n/index.js';

const COLUMNS = () => [['todo', t('할 일')], ['doing', t('진행 중')], ['check', t('확인 필요')], ['done', t('완료')]];
const fail = (e) => toast(e.message, 'error');
const targetName = (c) => (c.teamId ? `👥 ${teamById(c.teamId)?.name || t('(없는 팀)')}` : `${agentById(c.agentId)?.emoji || '🤖'} ${agentById(c.agentId)?.name || t('(없는 에이전트)')}`);
const blank = () => ({ title: '', detail: '', teamId: state.settings.defaultTeamId || state.teams[0]?.id || null, agentId: null, cwd: '' });

// 확인 필요 칸에서 왜 기다리는지(기다리는 일 목록과 같은 정보)
function why(c) {
  const kind = state.sessions.find((x) => x.id === c.sessionId)?.attention?.kind;
  return { approve: `✋ ${t('승인 필요')}`, decide: `⚠️ ${t('결정 필요')}`, failed: `🛑 ${t('오류로 멈춤')}`, paused: `⏸️ ${t('일시정지됨')}`, done: `🏁 ${t('끝남')}` }[kind] || '';
}

export function BoardPage() {
  const [edit, setEdit] = useState(null);
  const [over, setOver] = useState(null);
  const tasks = state.tasks || [];
  // 실제 AI 를 돌려 사용량을 쓰니 한 번 묻는다
  const start = async (c) => {
    if (!confirm(t("'{name}' 카드를 맡길까? 실제 AI가 일해서 사용량을 써.", { name: c.title }))) return;
    try { const r = await post(`/api/tasks/${c.id}/start`, {}); toast(t('맡겼어.'), 'ok'); return r; } catch (e) { fail(e); }
    return null;
  };
  const close = (id) => post(`/api/tasks/${id}/close`, {}).catch(fail);
  const reopen = (id) => post(`/api/tasks/${id}/reopen`, {}).catch(fail);
  const onDrop = (col, e) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/task');
    const c = tasks.find((x) => x.id === id);
    if (!c || c.column === col) return;
    if (col === 'done' && c.working) toast(t('아직 일하는 중이야. 끝나거나 멈춘 뒤에 완료해줘.'), 'warn');
    else if (col === 'done') close(id);
    else if (c.column === 'done') reopen(id);
    else if (col === 'doing' && c.column === 'todo') start(c);
  };
  return html`<div class="page"><div class="page-inner" style="max-width:none">
    <${PageHead} title=${t('칸반 보드')} desc=${t('할 일을 카드로 적어 팀에게 맡겨. 일이 진행되면 칸이 저절로 옮겨 가고, 결과를 확인한 뒤 완료는 네가 눌러.')}>
      <button class="btn primary" onClick=${() => setEdit(blank())}><${Icon} name="plus" /> ${t('새 카드')}</button>
    </${PageHead}>
    <div class="kanban">
      ${COLUMNS().map(([col, label]) => {
        const cards = tasks.filter((c) => c.column === col);
        return html`<section key=${col} class=${`kcol${over === col ? ' over' : ''}`} aria-label=${label}
          onDragOver=${(e) => { e.preventDefault(); setOver(col); }} onDragLeave=${() => setOver(null)} onDrop=${(e) => onDrop(col, e)}>
          <h4>${label} <span class="muted small">${cards.length}</span></h4>
          ${cards.map((c) => html`<div key=${c.id} class="kcard" draggable="true" onDragStart=${(e) => e.dataTransfer.setData('text/task', c.id)}>
            <div class="nm" role="button" tabindex="0" onClick=${() => setEdit(c)} onKeyDown=${(e) => { if (e.key === 'Enter') setEdit(c); }}>${c.title}</div>
            ${c.detail && html`<div class="desc">${c.detail}</div>`}
            <div class="small muted">${targetName(c)}${col === 'check' && why(c) ? html` · <b>${why(c)}</b>` : ''}</div>
            <div class="small muted">${ago(c.closedAt || c.createdAt)}</div>
            <div class="row wrap" style="gap:6px">
              ${col === 'todo' && html`<button class="btn sm primary" onClick=${() => start(c)}><${Icon} name="play" /> ${t('맡기기')}</button>`}
              ${col === 'check' && !c.working && html`<button class="btn sm primary" onClick=${() => close(c.id)}>${t('완료')}</button><button class="btn sm" onClick=${() => start(c)}>${t('다시 맡기기')}</button>`}
              ${col === 'done' && html`<button class="btn sm" onClick=${() => reopen(c.id)}>${t('되돌리기')}</button>`}
              ${c.sessionId && html`<button class="btn sm ghost" onClick=${() => go('session', c.sessionId)}>${t('세션 보기')}</button>`}
            </div>
          </div>`)}
          ${cards.length === 0 && html`<div class="small muted" style="padding:8px">${t('비어 있어')}</div>`}
        </section>`;
      })}
    </div>
    ${edit && html`<${CardEditor} card=${edit} onClose=${() => setEdit(null)} />`}
  </div></div>`;
}

function CardEditor({ card, onClose }) {
  const isNew = !card.id;
  const [c, setC] = useState(() => structuredClone(card));
  const set = (k, v) => setC((x) => ({ ...x, [k]: v }));
  const target = c.teamId ? `team:${c.teamId}` : c.agentId ? `agent:${c.agentId}` : '';
  const pick = (v) => { const [kind, id] = v.split(':'); setC((x) => ({ ...x, teamId: kind === 'team' ? id : null, agentId: kind === 'agent' ? id : null })); };
  const save = async () => {
    try {
      if (isNew) await post('/api/tasks', c); else await put(`/api/tasks/${c.id}`, c);
      onClose();
    } catch (e) { fail(e); }
  };
  const remove = async () => {
    if (!confirm(t("'{name}' 카드를 삭제할까? 맡긴 세션은 그대로 남아.", { name: c.title }))) return;
    try { await del(`/api/tasks/${c.id}`); onClose(); } catch (e) { fail(e); }
  };
  return html`<${Modal} title=${isNew ? t('새 카드') : t('카드 편집')} onClose=${onClose} foot=${html`
    ${!isNew && html`<button class="btn danger" onClick=${remove}><${Icon} name="trash" /> ${t('삭제')}</button>`}
    <span style="flex:1"></span>
    <button class="btn" onClick=${onClose}>${t('취소')}</button>
    <button class="btn primary" onClick=${save}>${t('저장')}</button>`}>
    <div class="field"><label for="kb-title">${t('할 일')}</label><input id="kb-title" class="input" maxlength="120" value=${c.title} onInput=${(e) => set('title', e.target.value)} placeholder=${t('예: 로그인 오류 원인 찾기')} /></div>
    <div class="field"><label for="kb-detail">${t('자세한 지시 (선택)')}</label><textarea id="kb-detail" class="textarea" rows="5" maxlength="20000" value=${c.detail} onInput=${(e) => set('detail', e.target.value)}></textarea></div>
    <div class="field"><label for="kb-target">${t('맡길 팀·에이전트')}</label>
      <select id="kb-target" class="input" value=${target} onChange=${(e) => pick(e.target.value)}>
        <optgroup label=${t('팀')}>${state.teams.map((tm) => html`<option value=${`team:${tm.id}`}>👥 ${tm.name}</option>`)}</optgroup>
        <optgroup label=${t('에이전트 한 명')}>${state.agents.map((a) => html`<option value=${`agent:${a.id}`}>${a.emoji} ${a.name}</option>`)}</optgroup>
      </select></div>
    <div class="field"><label for="kb-cwd">${t('작업 폴더 (선택)')}</label><input id="kb-cwd" class="input" value=${c.cwd} onInput=${(e) => set('cwd', e.target.value)} placeholder=${t('비우면 세션마다 새 폴더')} /></div>
  </${Modal}>`;
}
