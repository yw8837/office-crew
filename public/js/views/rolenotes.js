// 역할 노트(결정 0013): 에이전트 편집 창의 "역할 노트" 부분과, 에이전트 목록·오른쪽 패널의 초안 수 칩.
// 받은 항목만 이 에이전트의 다음 일에 들어간다. 여기서 쓰는 항목은 바로 확정이고, 에이전트·바깥 자료 항목은 초안으로 와서 받아야 들어간다.
// 지우는 단추는 없다(보관). 바꾼 것은 최근 변경 목록에서 하나씩 되돌린다
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Icon } from '../ui.js';
import { state, changed, onServerEvent } from '../state.js';
import { get, post, put, patch } from '../api.js';
import { t, locale } from '../i18n/index.js';

const TEXT_MAX = 400;
const TASK_MAX = 8;
const KINDS = ['method', 'pitfall', 'criterion', 'tool'];
const KIND_LABEL = () => ({ method: t('방법'), pitfall: t('함정'), criterion: t('기준'), tool: t('도구 쓰는 법') });

// 글자 수: 서버(server/notes.js chars)와 같은 방법으로 센다(이모지 하나 = 1)
const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
const pieces = (s) => (seg ? [...seg.segment(String(s ?? ''))].map((x) => x.segment) : [...String(s ?? '')]);
export const chars = (s) => pieces(s).length;
export const cutChars = (s, max) => pieces(s).slice(0, max).join('');
const short = (s, n = 50) => { const p = pieces(String(s ?? '').replace(/\s+/g, ' ').trim()); return p.length > n ? `${p.slice(0, n).join('')}…` : p.join(''); };

// 한 기록이 건드린 것(서버 notes.js 와 같은 규칙): 그 뒤에 같은 것이 또 바뀌었으면 되돌릴 수 없다
const touched = (e) => (e.after && typeof e.after === 'object' && 'tasks' in e.after ? ['#role'] : Array.isArray(e.after?.ids) ? e.after.ids : [e.itemId]);

// 초안 수 칩: 초안이 있을 때만. 누르면 그 에이전트의 편집 창을 노트 부분부터 연다
export function DraftChip({ agent }) {
  const n = state.noteDrafts?.[agent.id] || 0;
  if (!n) return null;
  const label = t('{name}의 역할 노트에 받지 않은 초안이 {n}개 있어. 눌러서 보기', { name: agent.name, n });
  const open = (e) => { e.stopPropagation(); state.ui.editAgent = agent.id; state.ui.editAgentNotes = true; changed(); };
  return html`<button type="button" class="chip btnish warn" title=${label} aria-label=${label} onClick=${open}>${t('초안 {n}', { n })}</button>`;
}

export function RoleNotes({ agentId, focus = false }) {
  const [notes, setNotes] = useState(null); // null = 불러오는 중
  const [loadErr, setLoadErr] = useState('');
  const [fail, setFail] = useState(null); // 저장 실패 { where, msg }
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(focus ? 'draft' : 'confirmed');
  const [tasks, setTasks] = useState(null); // 고치는 중인 하는 일 목록(null = 저장된 그대로)
  const [add, setAdd] = useState({ kind: 'method', text: '' });
  const [edit, setEdit] = useState(null); // 고치는 중인 항목 { id, kind, text }
  const head = useRef(null);
  const box = useRef(null);
  const listRef = useRef(null);
  const editRef = useRef(null);
  const base = `/api/agents/${agentId}/notes`;

  const load = () => get(base).then((n) => { setNotes(n); setLoadErr(''); }).catch((e) => setLoadErr(e.message));
  useEffect(() => {
    load();
    // 다른 곳(채팅 우클릭, 다른 창)에서 바뀌면 다시 읽는다
    return onServerEvent((type, d) => { if (type === 'notes' && d?.agentId === agentId) load(); });
  }, [agentId]);
  // 초안 칩으로 열었으면 노트 부분으로 옮기고 그 제목에 초점을 둔다
  useEffect(() => {
    if (!focus || !head.current) return;
    head.current.scrollIntoView?.({ block: 'start' });
    head.current.focus({ preventScroll: true });
  }, [focus]);
  useEffect(() => { if (edit) editRef.current?.focus(); }, [edit?.id]);

  // 저장: 성공하면 서버가 돌려준 노트로 바꾸고, 실패하면 그 자리에 이유를 보여 준다
  const act = async (where, call, done) => {
    setBusy(true);
    setFail(null);
    try { const n = await call(); setNotes(n); done?.(n); return true; } catch (e) { setFail({ where, msg: e.message }); return false; } finally { setBusy(false); }
  };
  const failBox = (where) => fail?.where === where && html`<div class="msg-err" role="alert">${t('저장하지 못했어: {msg}', { msg: fail.msg })}</div>`;
  const toList = () => listRef.current?.focus({ preventScroll: true }); // 단추가 있던 줄이 사라지면 초점을 목록으로

  const items = notes?.items || [];
  const by = (st) => items.filter((x) => x.status === st);
  const counts = { confirmed: by('confirmed').length, draft: by('draft').length, archived: by('archived').length };
  const used = by('confirmed').reduce((s, x) => s + chars(x.text), 0);

  // ── 이 역할이 하는 일 ──
  const rows = tasks ?? notes?.role?.tasks ?? [];
  const dirty = tasks !== null;
  const emptyTitle = rows.some((r) => !String(r.title || '').trim());
  // 고치는 목록은 앞 상태에서 이어 바꾼다(빠르게 친 글이 서로 덮지 않게)
  const saved = () => notes?.role?.tasks || [];
  const setRow = (i, k, v) => setTasks((cur) => (cur ?? saved()).map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const addRow = () => {
    setTasks((cur) => [...(cur ?? saved()), { title: '', done: '', check: '' }]);
    setTimeout(() => box.current?.querySelector(`[data-task="${rows.length}"]`)?.focus(), 0);
  };
  const saveRole = () => act('role', () => put(`${base}/role`, { tasks: rows }), () => setTasks(null));
  const roleView = html`<div class="field"><label>${t('이 역할이 하는 일')}</label>
    ${rows.length ? rows.map((r, i) => html`<div class="note-task" role="group" aria-label=${t('{n}번째 일', { n: i + 1 })} key=${r.id || `new-${i}`}>
      <input class="input" data-task=${i} value=${r.title || ''} placeholder=${t('제목')} aria-label=${t('제목')} onInput=${(e) => setRow(i, 'title', e.target.value)} />
      <input class="input" value=${r.done || ''} placeholder=${t('끝났다고 볼 기준')} aria-label=${t('끝났다고 볼 기준')} onInput=${(e) => setRow(i, 'done', e.target.value)} />
      <input class="input" value=${r.check || ''} placeholder=${t('확인 방법')} aria-label=${t('확인 방법')} onInput=${(e) => setRow(i, 'check', e.target.value)} />
      <button type="button" class="icon-btn" title=${t('이 일 빼기')} aria-label=${t('이 일 빼기')} onClick=${() => setTasks((cur) => (cur ?? saved()).filter((_, j) => j !== i))}><${Icon} name="trash" /></button>
    </div>`) : html`<div class="small muted">${t('아직 적힌 일이 없어. 이 역할이 자주 하는 일과, 끝났다고 볼 기준·확인 방법을 적어 둬.')}</div>`}
    <div class="row wrap" style="gap:6px;margin-top:4px">
      <button type="button" class="btn sm" disabled=${rows.length >= TASK_MAX} onClick=${addRow}><${Icon} name="plus" /> ${t('일 더하기')}</button>
      ${dirty && html`<button type="button" class="btn sm primary" disabled=${busy || emptyTitle} onClick=${saveRole}>${t('하는 일 저장')}</button>
        <button type="button" class="btn sm" onClick=${() => { setTasks(null); setFail(null); }}>${t('취소')}</button>`}
      ${rows.length >= TASK_MAX && html`<span class="small muted">${t('하는 일은 {max}개까지야.', { max: TASK_MAX })}</span>`}
      ${dirty && emptyTitle && html`<span class="small muted">${t('제목이 빈 줄이 있어.')}</span>`}
    </div>
    ${failBox('role')}
  </div>`;

  // ── 항목 ──
  const source = (x) => {
    if (x.source?.type === 'agent') return t('에이전트 경험');
    if (x.source?.type === 'web') return x.source.ref ? t('바깥 자료: {ref}', { ref: short(x.source.ref, 40) }) : t('바깥 자료');
    return String(x.source?.ref || '').startsWith('chat:') ? t('채팅에서 고름') : t('내가 씀');
  };
  const setStatus = (x, status) => act('items', () => patch(`${base}/items/${x.id}`, { status }), toList);
  const acceptAll = () => act('items', () => post(`${base}/accept-all`), toList);
  const editor = (x) => {
    const n = chars(edit.text.trim());
    const ok = n > 0 && n <= TEXT_MAX;
    const save = () => act('items', () => patch(`${base}/items/${x.id}`, { text: edit.text, kind: edit.kind }), () => { setEdit(null); toList(); });
    const cancel = () => { setEdit(null); toList(); };
    return html`<div>
      <select class="select" style="width:auto;margin-bottom:6px" aria-label=${t('종류')} value=${edit.kind} onChange=${(e) => { const kind = e.target.value; setEdit((cur) => ({ ...cur, kind })); }}>${KINDS.map((k) => html`<option value=${k}>${KIND_LABEL()[k]}</option>`)}</select>
      <textarea class="textarea" style="min-height:64px" ref=${editRef} aria-label=${t('항목 글')} aria-describedby=${`rn-ec-${x.id}`} value=${edit.text}
        onInput=${(e) => { const text = e.target.value; setEdit((cur) => ({ ...cur, text })); }}
        onKeyDown=${(e) => {
          // Esc 는 편집 창 전체가 아니라 이 고치기만 닫는다. Ctrl+Enter 로 저장
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ok && !busy) { e.preventDefault(); save(); }
        }}></textarea>
      <div class="row" style="gap:6px;margin-top:4px">
        <span id=${`rn-ec-${x.id}`} class=${`small ${n > TEXT_MAX ? 'note-over' : 'muted'}`}>${t('{n} / {max}자', { n, max: TEXT_MAX })}</span>
        <span class="grow"></span>
        <button type="button" class="btn sm" onClick=${cancel}>${t('취소')}</button>
        <button type="button" class="btn sm primary" disabled=${busy || !ok} onClick=${save}>${t('저장')}</button>
      </div>
    </div>`;
  };
  const row = (x) => html`<div class="li-row note-item" key=${x.id}>
    <div class="grow">${edit?.id === x.id ? editor(x) : html`
      <div class="row wrap" style="gap:5px;margin-bottom:4px">
        <span class="chip">${KIND_LABEL()[x.kind] || KIND_LABEL().method}</span>
        <span class=${`chip${x.source?.type === 'user' ? '' : ' info'}`} title=${x.source?.ref || ''}>${source(x)}</span>
        ${x.localOnly && html`<span class="chip" title=${t('클라우드 AI에게는 주지 않고 내 PC 모델에게만 줘.')}>${t('내 PC 모델만')}</span>`}
        <span class="small muted">${t('도움 {helped} · 해로움 {harmed}', { helped: x.helped || 0, harmed: x.harmed || 0 })}</span>
      </div>
      <div class="note-text">${x.text}</div>`}
    </div>
    ${edit?.id !== x.id && html`<div class="row" style="gap:4px;flex:none">
      ${x.status === 'draft' && html`<button type="button" class="btn sm primary" disabled=${busy} onClick=${() => setStatus(x, 'confirmed')}>${t('받기')}</button>`}
      <button type="button" class="btn sm" disabled=${busy} onClick=${() => { setFail(null); setEdit({ id: x.id, kind: x.kind, text: x.text }); }}>${t('고치기')}</button>
      ${x.status === 'confirmed' && html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => setStatus(x, 'archived')}>${t('보관')}</button>`}
      ${x.status === 'draft' && html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => setStatus(x, 'archived')}>${t('버리기')}</button>`}
    </div>`}
  </div>`;
  const shown = by(tab).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const EMPTY = { confirmed: t('확정한 항목이 없어.'), draft: t('받을 초안이 없어.'), archived: t('보관한 항목이 없어.') };
  const itemsView = html`<div class="field"><label>${t('항목')}</label>
    <div class="row wrap" style="gap:8px;margin-bottom:6px">
      <div class="seg" role="group" aria-label=${t('항목 상태')}>
        ${[['confirmed', t('확정 {n}', { n: counts.confirmed })], ['draft', t('초안 {n}', { n: counts.draft })], ['archived', t('보관 {n}', { n: counts.archived })]]
          .map(([k, l]) => html`<button type="button" class=${tab === k ? 'on' : ''} aria-pressed=${tab === k} onClick=${() => { setTab(k); setEdit(null); }}>${l}</button>`)}
      </div>
      ${counts.draft > 0 && html`<button type="button" class="btn sm primary" disabled=${busy} onClick=${acceptAll}><${Icon} name="check" /> ${t('초안 전부 받기')}</button>`}
    </div>
    <div class="list" tabindex="-1" ref=${listRef}>${shown.length ? shown.map(row) : html`<div class="li-row muted small">${EMPTY[tab]}</div>`}</div>
    ${failBox('items')}
  </div>`;

  // ── 항목 더하기 ──
  const addN = chars(add.text.trim());
  const addOk = addN > 0 && addN <= TEXT_MAX;
  const addItem = () => act('add', () => post(`${base}/items`, { kind: add.kind, text: add.text, source: { type: 'user' } }), () => { setAdd((x) => ({ ...x, text: '' })); setTab('confirmed'); });
  const addView = html`<div class="field"><label for=${`rn-new-${agentId}`}>${t('항목 더하기')}</label>
    <div class="row" style="gap:6px;align-items:flex-start">
      <select class="select" style="width:auto" aria-label=${t('종류')} value=${add.kind} onChange=${(e) => { const kind = e.target.value; setAdd((cur) => ({ ...cur, kind })); }}>${KINDS.map((k) => html`<option value=${k}>${KIND_LABEL()[k]}</option>`)}</select>
      <textarea id=${`rn-new-${agentId}`} class="textarea" style="min-height:60px" aria-describedby=${`rn-nc-${agentId}`} placeholder=${t('이 에이전트가 다음 일에 지킬 것 한 가지')} value=${add.text}
        onInput=${(e) => { const text = e.target.value; setAdd((cur) => ({ ...cur, text })); }}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && addOk && !busy) { e.preventDefault(); addItem(); } }}></textarea>
    </div>
    <div class="row" style="gap:6px;margin-top:4px">
      <span id=${`rn-nc-${agentId}`} class=${`small ${addN > TEXT_MAX ? 'note-over' : 'muted'}`}>${t('{n} / {max}자', { n: addN, max: TEXT_MAX })}</span>
      <span class="grow"></span>
      <button type="button" class="btn sm primary" disabled=${busy || !addOk} onClick=${addItem}><${Icon} name="plus" /> ${t('더하기')}</button>
    </div>
    ${failBox('add')}
  </div>`;

  // ── 최근 변경(10개) ──
  const log = notes?.log || [];
  const what = (id) => { const it = items.find((x) => x.id === id); return it ? `“${short(it.text)}”` : ''; };
  const describe = (e) => {
    const w = what(e.itemId);
    if (e.op === 'role') return t('하는 일을 바꿈');
    if (e.op === 'acceptAll') return t('초안 {n}개를 전부 받음', { n: e.after?.ids?.length || 0 });
    if (e.op === 'add') return t('더함: {what}', { what: w });
    if (e.op === 'edit') return t('고침: {what}', { what: w });
    if (e.op === 'status') {
      const to = e.after?.status;
      if (to === 'archived') return t('보관함: {what}', { what: w });
      if (to === 'draft') return t('초안으로 돌림: {what}', { what: w });
      return e.before?.status === 'draft' ? t('받음: {what}', { what: w }) : t('확정으로 돌림: {what}', { what: w });
    }
    return t('되돌림: {what}', { what: e.itemId ? w : e.after?.tasks ? t('이 역할이 하는 일') : t('항목 {n}개', { n: e.after?.ids?.length || 0 }) });
  };
  const undoable = (e) => { const i = log.indexOf(e); const k = touched(e); return !log.slice(i + 1).some((x) => touched(x).some((y) => k.includes(y))); };
  const when = (at) => new Date(at).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const logView = html`<div class="field"><label>${t('최근 변경')}</label>
    <div class="list">${log.length ? log.slice(-10).reverse().map((e) => {
      const ok = undoable(e);
      return html`<div class="li-row" key=${e.id}>
        <span class="small muted" style="flex:none">${when(e.at)}</span>
        <div class="grow small ellipsis" title=${describe(e)}>${describe(e)}</div>
        <button type="button" class="btn sm" disabled=${busy || !ok} title=${ok ? '' : t('그 뒤에 같은 항목이 또 바뀌어서 되돌릴 수 없어. 더 나중 변경부터 되돌려 줘.')}
          onClick=${() => act('log', () => post(`${base}/undo`, { logId: e.id }))}>${t('변경 되돌리기')}</button>
      </div>`;
    }) : html`<div class="li-row muted small">${t('아직 바뀐 게 없어.')}</div>`}</div>
    ${failBox('log')}
  </div>`;

  return html`<section class="role-notes" ref=${box} aria-labelledby=${`rn-h-${agentId}`}>
    <div class="section" id=${`rn-h-${agentId}`} tabindex="-1" ref=${head}>📒 ${t('역할 노트')}${counts.draft > 0 ? html` <span class="chip warn">${t('초안 {n}', { n: counts.draft })}</span>` : ''}</div>
    <div class="small muted" style="margin-bottom:10px">${t('여기 적힌 것 가운데 받은 것만 이 에이전트의 다음 일에 들어가. 지금은 {n}자 / 2,000자.', { n: used.toLocaleString(locale()) })}</div>
    ${notes === null && !loadErr && html`<div class="small muted" role="status">${t('불러오는 중…')}</div>`}
    ${loadErr && html`<div class="msg-err" role="alert">${t('역할 노트를 불러오지 못했어: {msg}', { msg: loadErr })} <button type="button" class="btn sm" onClick=${load}>${t('다시 시도')}</button></div>`}
    ${notes && html`${roleView}${itemsView}${addView}${logView}`}
  </section>`;
}
