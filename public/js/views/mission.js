// 목표 모드 화면(결정 0014): 채팅의 목표 카드(확인·고쳐서 확인·그만, 끊긴 목표 버리기)와 오른쪽 패널의 "진행 기록" 탭.
// 카드는 서버가 저장한 초안을 그대로 보여 주고, 확인할 때 보여 주던 값 전체를 같이 보낸다(서버가 저장된 초안과 글자까지 대조한다)
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../ui.js';
import { state, changed, toast, agentById } from '../state.js';
import { post, put } from '../api.js';
import { t, locale } from '../i18n/index.js';

const CRIT_COUNT = 7; // 서버와 같은 상한(server/mission.js)
const lines = (text) => String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const viewOf = (x) => ({ goal: x?.goal || '', criteria: [...(x?.criteria || [])], outOfScope: [...(x?.outOfScope || [])], userDecides: [...(x?.userDecides || [])] });

// 목표 상태 칩: [글, 칩 모양]
export const missionChip = (status) => ({
  drafting: [t('초안 쓰는 중'), ' accent'], draft: [t('확인 기다림'), ' warn'], active: [t('진행 중'), ' accent'], waiting: [t('답을 기다림'), ' warn'],
  unreviewed: [t('일 끝 · 판정 없음'), ' ok'], done: [t('완료'), ' ok'], accepted: [t('받아들임'), ' ok'], stopped: [t('멈춤'), ' warn'], cancelled: [t('닫힘'), ''], cut: [t('끊김'), ' err'],
}[status] || [status, '']);

// 끊긴 목표 버리기(이어서 하기는 아직 없다)
export async function discardMission(sid, missionId) {
  if (!window.confirm(t('끊긴 목표를 버릴까? 버리면 새 요청을 보낼 수 있어.'))) return;
  try { await post(`/api/sessions/${sid}/mission/discard`, { missionId }); } catch (e) { toast(e.message, 'error'); }
}

// 카드의 목록 한 칸(목표·기준·범위 밖·사용자가 정할 것)
function Section({ title, items, ordered = false, empty }) {
  return html`<div class="goal-sec">
    <div class="small muted"><b>${title}</b></div>
    ${items.length ? (ordered ? html`<ol>${items.map((x) => html`<li>${x}</li>`)}</ol>` : html`<ul>${items.map((x) => html`<li>${x}</li>`)}</ul>`)
      : html`<div class="small muted">${empty}</div>`}
  </div>`;
}

function CardBody({ v }) {
  return html`
    <div class="goal-sec"><div class="small muted"><b>${t('목표')}</b></div><div>${v.goal || html`<span class="muted">${t('(비어 있음)')}</span>`}</div></div>
    <${Section} title=${t('합격 기준')} items=${v.criteria} ordered=${true} empty=${t('기준이 없어. "고쳐서 시작"으로 기준을 적어 줘.')} />
    <${Section} title=${t('범위 밖')} items=${v.outOfScope} empty=${t('없음')} />
    <${Section} title=${t('사용자가 정할 것')} items=${v.userDecides} empty=${t('없음')} />`;
}

// ── 목표 카드 ──
export function GoalCard({ m }) {
  const sid = state.route.id;
  const s = state.sessionData[sid];
  const mission = s?.mission && s.mission.id === m.missionId ? s.mission : null;
  const [shown, setShown] = useState(null); // 확인이 어긋났을 때 서버가 준 지금 초안(있으면 이걸 보여 준다)
  const [edit, setEdit] = useState(null); // 고치는 중인 글 { goal, criteria, outOfScope, userDecides }(목록은 줄 단위 글)
  const [busy, setBusy] = useState(false);
  const goalIn = useRef(null);
  const editBtn = useRef(null);
  const editing = !!edit;
  useEffect(() => { if (editing) goalIn.current?.focus(); }, [editing]);
  const lead = agentById(m.leadId);

  if (m.status === 'cancelled') return html`<div class="msg system"><span role="status">${t('목표 카드를 닫았어.')}</span></div>`;

  // 확정한 카드: 읽기 전용, "사용자 확인" 표시. 끊긴 목표면 "끊김"과 버리기
  if (m.status === 'confirmed') {
    const v = viewOf(m.confirmed);
    const [label, cls] = mission ? missionChip(mission.status) : [t('지난 목표'), ''];
    return html`<div class="msg proposal"><div class="hire goal-card" role="group" aria-label=${t('목표 카드')}>
      <div class="hire-head"><b>🎯 ${t('목표 카드')}</b><span class="chip ok">${t('사용자 확인')}</span>${m.edited && html`<span class="chip">${t('고쳐서 확인')}</span>`}<span class=${`chip${cls}`}>${label}</span></div>
      <${CardBody} v=${v} />
      ${mission?.status === 'unreviewed' && html`<div class="notice">${t('일은 끝났어. 기준 판정은 아직 없어.')}</div>`}
      ${mission?.status === 'cut' && html`<div class="warnbox" role="note">${t('앱이 꺼져서 목표가 끊겼어. 저절로 다시 시작하지 않아.')} ${t('이어서 하기는 아직 없어.')}</div>
        <div class="hire-acts"><button class="btn sm danger" onClick=${() => discardMission(sid, mission.id)}>${t('버리기')}</button></div>`}
    </div></div>`;
  }

  // 지금 목표의 카드가 아니거나 이미 다른 상태면 닫힌 카드로
  if (!mission || mission.status !== 'draft') return html`<div class="msg system"><span role="status">${t('목표 카드를 닫았어.')}</span></div>`;

  const v = shown || viewOf(m);
  // 카드 뒤에 사용자의 새 말이 있으면 이 카드로는 시작할 수 없다(서버도 409)
  const at = s.messages.findIndex((x) => x.id === m.id);
  const stale = at >= 0 && s.messages.slice(at + 1).some((x) => x.role === 'user');
  const send = async (path, body) => {
    if (busy) return false;
    setBusy(true);
    try { await post(`/api/sessions/${sid}/mission/${path}`, body); setBusy(false); return true; } catch (e) {
      // 본 것과 저장된 초안이 달랐으면 서버가 준 지금 초안으로 다시 그린다. 고치는 중이면 고치던 글은 그대로 두고, 지금 초안을 고치는 칸 위에 보여 준다
      if (e.data?.draft) setShown(viewOf(e.data.draft));
      toast(e.message, 'error');
      setBusy(false);
      return false;
    }
  };
  const start = () => send('confirm', { missionId: m.missionId, expected: v });
  const edited = edit && { goal: edit.goal.trim(), criteria: lines(edit.criteria), outOfScope: lines(edit.outOfScope), userDecides: lines(edit.userDecides) };
  const canEdited = !!edited && !!edited.goal && edited.criteria.length > 0;
  const startEdited = () => { if (canEdited) send('confirm', { missionId: m.missionId, expected: v, edited }); };
  const openEdit = () => setEdit({ goal: v.goal, criteria: v.criteria.join('\n'), outOfScope: v.outOfScope.join('\n'), userDecides: v.userDecides.join('\n') });
  const closeEdit = () => { setEdit(null); setTimeout(() => editBtn.current?.focus(), 0); };
  const cancel = () => send('cancel', { missionId: m.missionId });
  // 고치는 칸: Esc 는 고치기 취소, Ctrl+Enter 만 이 내용으로 시작(목표 한 줄 칸도 Enter 만으로는 시작하지 않는다)
  const onKey = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEdit(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startEdited(); }
  };
  const field = (key, label, rows) => html`<label>${label}<textarea class="textarea" rows=${rows} value=${edit[key]} disabled=${busy}
    onInput=${(e) => setEdit({ ...edit, [key]: e.target.value })} onKeyDown=${(e) => onKey(e)}></textarea></label>`;
  return html`<div class="msg proposal"><div class="hire goal-card" role="group" aria-label=${t('목표 카드')}>
    <div class="hire-head"><b>🎯 ${t('목표 카드')}</b><span class="chip warn">${t('사용자 확인 전')}</span>
      <span class="small muted">${t('{name}이(가) 쓴 초안이야. 확인해야 팀이 일을 시작해. 아직 아무것도 시작하지 않았어.', { name: lead?.name || t('진행자') })}</span></div>
    ${m.fallback && html`<div class="warnbox" role="note">${t('진행자 답에서 목표 카드를 읽지 못해서 요청 글로 만들었어. 기준을 직접 적어 줘.')}</div>`}
    ${m.warn && html`<div class="warnbox" role="note">⚠ ${t('진행자가 쓴 초안에 걱정되는 부분이 있어. 확인하기 전에 잘 읽어 봐.')} ${m.warn}</div>`}
    ${shown && !editing && html`<div class="notice" role="status">${t('저장된 초안으로 다시 그렸어. 다시 확인해 줘.')}</div>`}
    ${stale && html`<div class="warnbox" role="note">${t('카드 뒤에 새 말이 있어서 이 카드로는 시작할 수 없어. 요청을 다시 보내 줘.')}</div>`}
    ${editing ? html`<div class="goal-edit">
        ${shown && html`<div class="notice" role="status">${t('초안이 바뀌었어. 아래 내용을 확인해 줘. 고치던 글은 그대로 뒀어.')}</div><${CardBody} v=${shown} />`}
        <label>${t('목표 (한 줄)')}<input class="input" ref=${goalIn} value=${edit.goal} maxlength="200" disabled=${busy}
          onInput=${(e) => setEdit({ ...edit, goal: e.target.value })} onKeyDown=${onKey} /></label>
        ${field('criteria', t('합격 기준 (한 줄에 하나, {n}개까지)', { n: CRIT_COUNT }), 4)}
        ${field('outOfScope', t('범위 밖 (한 줄에 하나)'), 2)}
        ${field('userDecides', t('사용자가 정할 것 (한 줄에 하나)'), 2)}
        <div class="small muted">${t('기준 {n}개', { n: edited.criteria.length })}${edited.criteria.length > CRIT_COUNT ? ` · ${t('{n}개를 넘는 줄은 빠져.', { n: CRIT_COUNT })}` : ''} · ${t('Esc 고치기 취소 · Ctrl+Enter 시작')}</div>
        <div class="hire-acts">
          <button class="btn primary sm" disabled=${busy || !canEdited} onClick=${startEdited}>${t('이 내용으로 시작')}</button>
          <button class="btn sm" disabled=${busy} onClick=${closeEdit}>${t('고치기 취소')}</button>
        </div>
      </div>` : html`<${CardBody} v=${v} />`}
    ${!editing && html`<div class="hire-acts">
      <button class="btn primary sm" disabled=${busy || stale || !v.goal || !v.criteria.length} onClick=${start}>${t('이대로 시작')}</button>
      <button class="btn sm" ref=${editBtn} disabled=${busy || stale} aria-expanded=${editing ? 'true' : 'false'} onClick=${openEdit}>${t('고쳐서 시작')}</button>
      <span class="grow"></span>
      <button class="btn sm" disabled=${busy} onClick=${cancel}>${t('그만')}</button>
    </div>`}
  </div></div>`;
}

// 진행 기록의 줄을 누르면 채팅에서 그 메시지로 간다("사무실 크게"면 채팅이 보이게 바꾼 뒤에)
function jump(id) {
  state.ui.jumpTo = id;
  if ((state.settings.viewMode || 'split') === 'office') {
    state.settings.viewMode = 'split';
    put('/api/settings', { viewMode: 'split' }).catch(() => {});
  }
  changed();
}

// ── 오른쪽 패널의 진행 기록 탭 ──
export function MissionLog({ s }) {
  const m = s.mission;
  if (!m) return html`<div class="muted small">${t('아직 목표가 없어. 입력창 옆의 "목표까지"를 켜고 요청을 보내면 여기에 과정이 한 줄씩 쌓여.')}</div>`;
  const [label, cls] = missionChip(m.status);
  const time = (at) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).slice(-8);
  const L = (m.log || []).slice().reverse();
  return html`<div>
    <div class="card"><h4>🎯 ${t('목표')} <span class=${`chip${cls}`}>${label}</span></h4>
      <div>${m.goal || html`<span class="muted">${t('(아직 없음)')}</span>`}</div>
      <div class="small muted" style="margin-top:4px">${m.confirmedAt ? `${t('사용자 확인')}${m.editedByUser ? ` · ${t('고쳐서 확인')}` : ''}` : t('에이전트가 씀 · 사용자 확인 전')}</div>
      ${m.criteria?.length > 0 && html`<div style="margin-top:8px" role="list" aria-label=${t('합격 기준')}>
        ${m.criteria.map((c, i) => html`<div class="stat" role="listitem"><span>${i + 1}. ${c.text}</span><span class="chip">${t('아직')}</span></div>`)}
      </div>`}
      ${m.status === 'unreviewed' && html`<div class="notice" style="margin-top:6px">${t('일은 끝났어. 기준 판정은 아직 없어.')}</div>`}
      ${m.status === 'cut' && html`<div class="row" style="margin-top:6px"><span class="small">${t('앱이 꺼져서 목표가 끊겼어. 저절로 다시 시작하지 않아.')}</span><button class="btn sm danger" onClick=${() => discardMission(s.id, m.id)}>${t('버리기')}</button></div>`}
    </div>
    <div class="log">
      ${L.map((x) => (x.msgId
        ? html`<button type="button" class="li" title=${t('그 메시지로 가기')} onClick=${() => jump(x.msgId)}><span class="tm">${time(x.at)}</span><span>${x.text}</span></button>`
        : html`<div class="li"><span class="tm">${time(x.at)}</span><span>${x.text}</span></div>`))}
    </div>
  </div>`;
}
