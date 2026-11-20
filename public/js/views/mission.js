// 목표 모드 화면(결정 0014): 채팅의 목표 카드(확인·고쳐서 확인·그만, 끊긴 목표 이어서·버리기)와 오른쪽 패널의 "진행 기록" 탭.
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
  unreviewed: [t('일 끝 · 판정 없음'), ' ok'], done: [t('통과로 끝'), ' ok'], accepted: [t('받아들임'), ' ok'], stopped: [t('멈춤'), ' warn'], cancelled: [t('닫힘'), ''], cut: [t('끊김'), ' err'],
}[status] || [status, '']);

// 기준 판정 칩(결정 0015): [글, 칩 모양]
export const verdictChip = (status) => ({ pass: [t('통과'), ' ok'], fail: [t('불합격'), ' err'], unknown: [t('확인 못 함'), ' warn'] }[status] || [t('아직'), '']);

// 기준 한 줄: 칩, 기준(사용자 확인), 근거(에이전트가 씀)
function CritRow({ c, n }) {
  const [label, cls] = verdictChip(c.status);
  return html`<div class="crit" role="listitem">
    <div class="crit-head"><span class=${`chip${cls}`}>${label}</span><span>${n ? `${n}. ` : ''}${c.text || c.id}</span></div>
    ${c.evidence && html`<div class="small muted crit-ev">${c.evidence} <span class="crit-who">· ${t('에이전트가 씀 · 사용자 확인 안 함')}</span></div>`}
  </div>`;
}

// 검수 답의 기준표: 서버가 받은 판정(msg.review). 판정 블록을 받지 못했으면 그렇다고만 보여 준다(블록 글은 본문에 그대로 남는다)
export function ReviewTable({ r }) {
  if (!r || (!r.results?.length && !r.missing)) return null;
  if (r.missing) return html`<div class="notice">🎯 ${t('이 답에서는 판정 블록을 받지 못했어(판정 없음).')}</div>`;
  const t2 = { pass: 0, fail: 0, unknown: 0 };
  for (const x of r.results) t2[x.verdict] = (t2[x.verdict] || 0) + 1;
  return html`<div class="crit-table" role="list" aria-label=${t('기준 판정')}>
    <div class="small muted">${t('기준 {total}개 중 통과 {pass} · 불합격 {fail} · 확인 못 함 {unknown}', { total: r.results.length, pass: t2.pass, fail: t2.fail, unknown: t2.unknown })}</div>
    ${r.results.map((x) => html`<${CritRow} c=${{ status: x.verdict, text: x.text ? `${x.id}. ${x.text}` : x.id, evidence: x.evidence, id: x.id }} />`)}
  </div>`;
}

// 끊긴 목표 버리기
export async function discardMission(sid, missionId) {
  if (!window.confirm(t('끊긴 목표를 버릴까? 버리면 새 요청을 보낼 수 있어.'))) return;
  try { await post(`/api/sessions/${sid}/mission/discard`, { missionId }); } catch (e) { toast(e.message, 'error'); }
}

// 끊긴 목표를 이어서 하면 어디서부터 다시 도는지 한 줄(결정 0016). 끊긴 자리(m.at)와 끊긴 실행의 단계 이름으로. 자리가 적혀 있지 않은 옛 목표면 null
export function resumeFrom(s, m) {
  const at = m?.at;
  if (!at || !Array.isArray(m.keep)) return null;
  if (at.wait) return t('끊기기 전에 묻던 질문을 AI 호출 없이 다시 띄워.');
  const run = (s?.runs || []).findLast((r) => r.mission === 'work' && r.missionId === m.id);
  const label = run?.stages?.[at.stageIndex]?.label || '?';
  const head = at.back ? t('"{label}" 단계의 되돌림(걸린 기준 고치기)부터 다시 해.', { label }) : t('"{label}" 단계부터 다시 해.', { label });
  return at.working?.length ? `${head} ${t('그 단계 담당은 새 대화로 시작해.')}` : head;
}

// 끊긴 목표 알림: 이어서(주 단추) / 버리기, 어디서부터 다시 도는지 한 줄. 이어서가 거절되면(409·400) 그 이유를 보여 준다.
// compact: 입력창 위처럼 좁은 자리(한 줄로)
export function CutBox({ s, m, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
  const from = resumeFrom(s, m);
  const resume = async () => {
    if (busy) return;
    setBusy(true);
    setWhy('');
    try { await post(`/api/sessions/${s.id}/mission/resume`, { missionId: m.id }); } catch (e) { setWhy(e.message); toast(e.message, 'error'); }
    setBusy(false);
  };
  return html`<div class=${compact ? 'warnbox row' : 'warnbox'} role="note" style=${compact ? 'max-width:860px;margin:0 auto 8px;flex-wrap:wrap' : ''}>
    <span>${compact ? '⚠ ' : ''}${t('앱이 꺼져서 목표가 끊겼어. 저절로 다시 시작하지 않아.')} ${from ? html`<span class="small">${from}</span>` : t('이 목표는 끊긴 자리가 적혀 있지 않아서 이어 갈 수 없어. 버리고 요청을 다시 보내 줘.')}</span>
    ${compact && html`<span class="grow"></span>`}
    <div class="hire-acts">
      ${from && html`<button class="btn primary sm" disabled=${busy} onClick=${resume}>${t('이어서')}</button>`}
      <button class="btn sm danger" disabled=${busy} onClick=${() => discardMission(s.id, m.id)}>${t('버리기')}</button>
    </div>
    ${why && html`<div class="small" role="alert" style="flex-basis:100%">${t('이어 가지 못했어: {why}', { why })}</div>`}
  </div>`;
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
  const [rvShown, setRvShown] = useState(null); // 검수 줄이 어긋났을 때 서버가 준 지금 값(결정 0015)
  const [kept, setKept] = useState([]); // "남기기"를 고른 팀 단계 번호
  const goalIn = useRef(null);
  const editBtn = useRef(null);
  const editing = !!edit;
  useEffect(() => { if (editing) goalIn.current?.focus(); }, [editing]);
  const lead = agentById(m.leadId);

  if (m.status === 'cancelled') return html`<div class="msg system"><span role="status">${t('목표 카드를 닫았어.')}</span></div>`;

  // 확정한 카드: 읽기 전용, "사용자 확인" 표시. 검수자·건너뛴 단계·끝 상태. 끊긴 목표면 "끊김"과 이어서·버리기
  if (m.status === 'confirmed') {
    const v = viewOf(m.confirmed);
    const [label, cls] = mission ? missionChip(mission.status) : [t('지난 목표'), ''];
    const left = mission ? (mission.criteria || []).filter((c) => c.status !== 'pass').length : 0;
    return html`<div class="msg proposal"><div class="hire goal-card" role="group" aria-label=${t('목표 카드')}>
      <div class="hire-head"><b>🎯 ${t('목표 카드')}</b><span class="chip ok">${t('사용자 확인')}</span>${m.edited && html`<span class="chip">${t('고쳐서 확인')}</span>`}<span class=${`chip${cls}`}>${label}</span></div>
      <${CardBody} v=${v} />
      ${mission && 'reviewerId' in mission && mission.status !== 'unreviewed' && html`<div class="small muted">${mission.reviewerId ? t('검수: {name}이(가) 기준마다 판정해.', { name: agentById(mission.reviewerId)?.name || mission.reviewerId }) : t('검수할 다른 팀원이 없어서 판정 없이 끝나고 네게 물어.')}${mission.dropped?.length ? ` · ${t('기준 판정으로 대신해서 건너뛰는 단계: {labels}', { labels: mission.dropped.join(', ') })}` : ''}</div>`}
      ${mission?.status === 'unreviewed' && html`<div class="notice">${t('일은 끝났어. 기준 판정은 아직 없어.')}</div>`}
      ${mission?.status === 'done' && html`<div class="notice">✅ ${t('기준 {n}개를 모두 통과해서 끝냈어.', { n: mission.criteria.length })}</div>`}
      ${mission?.status === 'accepted' && html`<div class="notice">${t('받아들여서 끝냈어 · 남은 기준 {n}개', { n: left })}</div>`}
      ${mission?.status === 'cut' && html`<${CutBox} s=${s} m=${mission} />`}
    </div></div>`;
  }

  // 지금 목표의 카드가 아니거나 이미 다른 상태면 닫힌 카드로
  if (!mission || mission.status !== 'draft') return html`<div class="msg system"><span role="status">${t('목표 카드를 닫았어.')}</span></div>`;

  const v = shown || viewOf(m);
  // 카드 뒤에 사용자의 새 말이 있으면 이 카드로는 시작할 수 없다(서버도 409)
  const at = s.messages.findIndex((x) => x.id === m.id);
  const stale = at >= 0 && s.messages.slice(at + 1).some((x) => x.role === 'user');
  // 검수 줄(결정 0015): 카드를 만들 때 서버가 계산한 검수자와 기준 판정으로 대신할 수 있는 단계. 옛 카드(이 칸 없음)는 보내지 않는다(아무것도 안 뺀다)
  const rv = rvShown || m.review || null;
  const send = async (path, body) => {
    if (busy) return false;
    setBusy(true);
    try { await post(`/api/sessions/${sid}/mission/${path}`, body); setBusy(false); return true; } catch (e) {
      // 본 것과 저장된 초안이 달랐으면 서버가 준 지금 초안으로 다시 그린다. 고치는 중이면 고치던 글은 그대로 두고, 지금 초안을 고치는 칸 위에 보여 준다
      if (e.data?.draft) setShown(viewOf(e.data.draft));
      // 검수 줄이 달랐으면 서버가 준 지금 값으로 다시 그린다(남기기는 아직 뺄 수 있는 단계만 그대로 둔다)
      if (e.data?.review) { setRvShown(e.data.review); setKept((k) => k.filter((i) => e.data.review.droppable?.some((d) => d.index === i))); }
      toast(e.message, 'error');
      setBusy(false);
      return false;
    }
  };
  // 보여 주던 뺄 단계 목록도 같이 보낸다(서버가 지금 팀과 글자까지 대조한다)
  const review = rv ? { reviewerId: rv.reviewerId || null, droppable: rv.droppable || [], drop: (rv.droppable || []).map((d) => d.index).filter((i) => !kept.includes(i)) } : undefined;
  const start = () => send('confirm', { missionId: m.missionId, expected: v, review });
  const edited = edit && { goal: edit.goal.trim(), criteria: lines(edit.criteria), outOfScope: lines(edit.outOfScope), userDecides: lines(edit.userDecides) };
  const canEdited = !!edited && !!edited.goal && edited.criteria.length > 0;
  const startEdited = () => { if (canEdited) send('confirm', { missionId: m.missionId, expected: v, edited, review }); };
  const keep = (i, on) => setKept((k) => (on ? [...new Set([...k, i])] : k.filter((x) => x !== i)));
  const reviewLine = rv && html`<div class="goal-sec goal-review">
    <div class="small muted"><b>${t('검수')}</b></div>
    ${rvShown && html`<div class="notice" role="status">${t('검수자나 건너뛸 단계가 바뀌어서 지금 값으로 다시 그렸어. 다시 확인해 줘.')}</div>`}
    <div>${rv.reviewerId ? t('검수: {name}이(가) 기준마다 판정해.', { name: rv.reviewerName || agentById(rv.reviewerId)?.name || rv.reviewerId }) : t('검수할 다른 팀원이 없어서 판정 없이 끝나고 네게 물어.')}</div>
    ${(rv.droppable || []).map((d) => html`<label class="goal-keep small">
      <input type="checkbox" checked=${kept.includes(d.index)} disabled=${busy} onChange=${(e) => keep(d.index, e.target.checked)} />
      <span><b>${t('남기기')}</b> · "${d.label}"${d.names?.length ? ` (${d.names.join(', ')})` : ''} — ${kept.includes(d.index) ? t('남겨서 그대로 돌려.') : t('이 단계는 기준 판정으로 대신해서 건너뛰어.')}
        ${d.instruction && html`<span class="muted goal-keep-ins">${t('이 단계의 지시(건너뛰면 안 쓰여): {text}', { text: d.instruction })}</span>`}</span>
    </label>`)}
  </div>`;
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
        ${reviewLine}
        <div class="hire-acts">
          <button class="btn primary sm" disabled=${busy || !canEdited} onClick=${startEdited}>${t('이 내용으로 시작')}</button>
          <button class="btn sm" disabled=${busy} onClick=${closeEdit}>${t('고치기 취소')}</button>
        </div>
      </div>` : html`<${CardBody} v=${v} />${reviewLine}`}
    ${!editing && html`<div class="hire-acts">
      <button class="btn primary sm" disabled=${busy || stale || !v.goal || !v.criteria.length} onClick=${start}>${t('이대로 시작')}</button>
      <button class="btn sm" ref=${editBtn} disabled=${busy || stale} aria-expanded=${editing ? 'true' : 'false'} onClick=${openEdit}>${t('고쳐서 시작')}</button>
      <span class="grow"></span>
      <button class="btn sm" disabled=${busy} onClick=${cancel}>${t('그만')}</button>
    </div>`}
  </div></div>`;
}

// ── 목표의 대기(결정 0015): 판정 뒤에 묻기(mission)와 호출 상한(cap). 질문 창 모양으로 그린다(번호 붙은 보기 + 그만) ──
export function MissionGate({ s, run }) {
  const hold = run.hold;
  const [busy, setBusy] = useState(false);
  const ctl = async (action) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await post(`/api/sessions/${s.id}/control`, { action });
      if (r && r.ok === false) toast(t('이미 지나간 대기야.'), 'warn');
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  const row = (k, label, desc, action) => html`<button type="button" class="ask-row" disabled=${busy} onClick=${() => ctl(action)}>
    <span class="ask-num" aria-hidden="true">${k}</span><span class="ask-row-text"><b>${label}</b>${desc && html`<span>${desc}</span>`}</span><span class="ask-go" aria-hidden="true">→</span>
  </button>`;
  if (hold.reason === 'cap') {
    return html`<div class="ask-panel mission-gate" role="group" aria-label=${t('호출 상한')}>
      <div class="ask-head"><span class="ask-who">🔢 ${t('목표의 호출 상한')}</span></div>
      <div class="ask-question">${t('호출 {used}번에 닿았어(상한 {cap}번). 더 할까?', { used: hold.used, cap: hold.cap })}</div>
      <div class="small muted">${t('다음 단계를 시작하기 전에 멈췄어. 단계 안의 다시 시도·이어받기는 상한을 넘을 수 있고, 회의 단계는 인원만 보고 시작해서 바퀴 수만큼 더 넘을 수 있어.')}</div>
      <div class="ask-rows">${row(1, t('{n}번 더', { n: hold.step }), t('상한을 늘리고 이어서 해.'), 'more')}</div>
      <div class="ask-foot"><span class="grow"></span><button type="button" class="btn sm danger" disabled=${busy} onClick=${() => ctl('stop')}>${t('그만')}</button></div>
    </div>`;
  }
  const notes = hold.kind === 'notes';
  const left = hold.left || [];
  const q = notes ? t('반영 안 한 추가 지시가 {n}개 있어. 어떻게 할까?', { n: hold.notes })
    : hold.round ? t('검수 {r}회차 뒤에 통과하지 못한 기준이 {n}개 남았어. 어떻게 할까?', { r: hold.round, n: left.length })
      : t('판정 없이 기준 {n}개가 남았어. 어떻게 할까?', { n: left.length });
  return html`<div class="ask-panel mission-gate" role="group" aria-label=${t('목표 판정')}>
    <div class="ask-head"><span class="ask-who">🎯 ${t('목표 판정')}</span></div>
    <div class="ask-question">${q}</div>
    ${left.length > 0 && html`<div class="crit-table" role="list" aria-label=${t('남은 기준')}>${left.map((c) => html`<${CritRow} c=${{ ...c, text: `${c.id}. ${c.text}` }} />`)}</div>`}
    <div class="ask-rows">
      ${row(1, notes ? t('그대로 끝') : t('받아들이기'), notes ? t('추가 지시는 반영하지 않고 지금 판정으로 끝내.') : t('남은 기준은 판정 그대로 두고 끝내.'), 'accept')}
      ${hold.more !== false && row(2, notes ? t('반영해서 한 번 더') : t('한 번 더'), notes ? (hold.reviewer === false ? t('마지막 일 단계가 추가 지시를 넣어 다시 해. 검수할 사람이 없어서 그 뒤에 판정 없이 다시 물어.') : t('마지막 일 단계가 추가 지시를 넣어 다시 하고, 다시 검수해.')) : t('마지막 일 단계가 걸린 기준을 고친 뒤 다시 검수해.'), 'more')}
    </div>
    ${hold.more === false && html`<div class="small muted">${t('검수할 다른 팀원이 없어서 다시 고쳐도 판정할 사람이 없어.')}</div>`}
    <div class="ask-foot"><span class="grow"></span><button type="button" class="btn sm danger" disabled=${busy} onClick=${() => ctl('stop')}>${t('그만')}</button></div>
  </div>`;
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
  const left = (m.criteria || []).filter((c) => c.status !== 'pass').length;
  // 실패 줄의 종류(결정 0015): 검수에서 걸림 / 한도·바깥 장애
  const FAIL = { review: t('검수에서 걸림'), outside: t('바깥 장애') };
  const text = (x) => html`<span>${x.text}${x.fail && FAIL[x.fail] ? html` <span class="chip warn">${FAIL[x.fail]}</span>` : ''}</span>`;
  return html`<div>
    <div class="card"><h4>🎯 ${t('목표')} <span class=${`chip${cls}`}>${label}</span></h4>
      <div>${m.goal || html`<span class="muted">${t('(아직 없음)')}</span>`}</div>
      <div class="small muted" style="margin-top:4px">${m.confirmedAt ? `${t('사용자 확인')}${m.editedByUser ? ` · ${t('고쳐서 확인')}` : ''}` : t('에이전트가 씀 · 사용자 확인 전')}</div>
      ${m.confirmedAt > 0 && 'reviewerId' in m && html`<div class="small muted">${m.reviewerId ? t('검수: {name}이(가) 기준마다 판정해.', { name: agentById(m.reviewerId)?.name || m.reviewerId }) : t('검수할 다른 팀원이 없어서 판정 없이 끝나고 네게 물어.')}</div>`}
      ${m.calls && html`<div class="stat"><span>${t('호출')}</span><span>${m.calls.used} / ${m.calls.cap}</span></div>`}
      ${m.criteria?.length > 0 && html`<div style="margin-top:8px" class="crit-table" role="list" aria-label=${t('합격 기준')}>
        ${m.criteria.map((c, i) => html`<${CritRow} c=${c} n=${i + 1} />`)}
      </div>`}
      ${m.status === 'unreviewed' && html`<div class="notice" style="margin-top:6px">${t('일은 끝났어. 기준 판정은 아직 없어.')}</div>`}
      ${m.status === 'done' && html`<div class="notice" style="margin-top:6px">✅ ${t('기준 {n}개를 모두 통과해서 끝냈어.', { n: m.criteria.length })}</div>`}
      ${m.status === 'accepted' && html`<div class="notice" style="margin-top:6px">${t('받아들여서 끝냈어 · 남은 기준 {n}개', { n: left })}</div>`}
      ${m.status === 'cut' && html`<div style="margin-top:6px"><${CutBox} s=${s} m=${m} /></div>`}
    </div>
    <div class="log">
      ${L.map((x) => (x.msgId
        ? html`<button type="button" class="li" title=${t('그 메시지로 가기')} onClick=${() => jump(x.msgId)}><span class="tm">${time(x.at)}</span>${text(x)}</button>`
        : html`<div class="li"><span class="tm">${time(x.at)}</span>${text(x)}</div>`))}
    </div>
  </div>`;
}
