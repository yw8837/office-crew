// 팀 제안 카드(결정 0024): 붙인 문서를 AI 가 읽고 쓴 팀 초안. 만들기를 눌러야 에이전트와 팀이 생긴다.
// 에이전트가 쓴 글(팀·에이전트 이름, 역할, 문서의 표현, 언제 쓰나, 옮기지 못한 것)은 글자로만 그린다(htm 이 이스케이프한다).
// 권한은 사용자가 고른다(전원 한 번에 + 에이전트별, 기본은 default). 서버는 화면이 보낸 초안을 믿지 않고 권한 선택·팀 바꾸기 여부·본 판(rev)만 받는다
import { useState } from 'preact/hooks';
import { html, Icon, PERM_LABEL, EFFORT_LABEL } from '../ui.js';
import { state, toast, teamById, go } from '../state.js';
import { post } from '../api.js';
import { t } from '../i18n/index.js';

const PERMS = ['plan', 'default', 'edit', 'auto', 'full'];
const PROFILE = () => ({ economy: t('경제'), balanced: t('균형'), best: t('최고') });
const WARN = () => ({
  provider: t('문서의 AI를 지금 쓸 수 없어서 자동 라우팅으로 바꿨어'),
  model: t('목록에 없는 모델이라 등급이 가까운 모델로 바꿨어'),
  effort: t('그 모델이 받는 세기로 바꿨어'),
  suspect: t('지시처럼 보이는 글이 있어. 이름·역할을 확인해 줘'),
});
const providerName = (id) => state.providers.find((p) => p.id === id)?.label || id;
// AI · 모델 · 세기(자동 라우팅이면 프로필)
const aiText = (a) => (a.routing === 'auto' ? `✨ ${t('자동 라우팅')} · ${PROFILE()[a.routingProfile] || a.routingProfile}`
  : [providerName(a.provider), a.modelLabel || a.model || t('기본 모델'), a.effort ? EFFORT_LABEL[a.effort] || a.effort : ''].filter(Boolean).join(' · '));

function PermSelect({ value, label, onChange }) {
  return html`<select class="select team-perm" aria-label=${label} value=${value} onChange=${(e) => onChange(e.target.value)}>
    ${PERMS.map((p) => html`<option value=${p}>${PERM_LABEL[p][0]}</option>`)}
  </select>`;
}

export function TeamCard({ m }) {
  const sid = state.route.id;
  const [all, setAll] = useState('default');
  const [each, setEach] = useState({}); // 에이전트 번호 → 고른 권한(고르지 않았으면 전원 값)
  const [sw, setSw] = useState(true);
  const [busy, setBusy] = useState(false);
  const d = m.draft || { name: '', agents: [], stages: [] };
  const act = async (action, body = {}) => {
    if (busy) return;
    setBusy(true);
    try { await post(`/api/sessions/${sid}/proposals/${m.id}`, { action, ...body }); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  if (m.status === 'done') {
    const tm = teamById(m.teamId);
    return html`<div class="msg proposal"><div class="hire done" role="status">
      <b>✓ ${t('"{team}" 팀과 에이전트 {n}명을 만들었어', { team: tm?.name || d.name, n: (m.agentIds || []).length })}</b>
      <span class="small muted">${m.switched ? t('이 세션은 이제 이 팀으로 일해.') : t('이 세션의 팀은 그대로야. 맨 위에서 이 팀으로 바꿀 수 있어.')}${m.goalModeOff ? ` ${m.goalModeOff}` : ''}</span>
      <button class="btn sm" onClick=${() => go('teams')}><${Icon} name="users" /> ${t('팀 배치에서 보기')}</button>
    </div></div>`;
  }
  if (m.status !== 'open') return html`<div class="msg system"><span role="status">${m.status === 'sent' ? t('팀 제안 대신 그 말을 그대로 보냈어.') : t('팀 제안을 그만뒀어.')}</span></div>`;
  const permOf = (i) => each[i] || all;
  const cols = [t('이름'), t('역할'), t('AI · 모델 · 세기'), t('문서의 표현'), t('권한')];
  return html`<div class="msg proposal"><div class="hire team-card" role="group" aria-label=${t('팀 제안')}>
    <div class="hire-head"><b>👥 ${t('팀 제안')}: ${d.name}</b><span class="chip">${t('에이전트 {n}명', { n: d.agents.length })}</span>
      <span class="small muted">${t('AI가 문서를 읽고 쓴 초안이야. 만들기를 눌러야 생겨.')}</span></div>
    ${m.cut && html`<div class="warnbox" role="note">${t('문서가 길어서 앞부분만 읽었어.')}</div>`}
    <div class="team-table-wrap"><table class="team-table">
      <thead><tr>${cols.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead>
      <tbody>${d.agents.map((a, i) => html`<tr key=${`a${i}`}>
        <td data-label=${cols[0]}><b>${a.name}</b> <span class="chip" title=${t('등급: 1 = 가장 싸고 단순한 일, 4 = 가장 비싸고 어려운 일')}>T${a.tier}</span>${a.when && html`<div class="small muted">${a.when}</div>`}</td>
        <td data-label=${cols[1]}>${a.role || '—'}</td>
        <td data-label=${cols[2]}>${aiText(a)}</td>
        <td data-label=${cols[3]} class="small">${a.said || '—'}</td>
        <td data-label=${cols[4]}><${PermSelect} value=${permOf(i)} label=${t('{name}의 권한', { name: a.name })} onChange=${(v) => setEach({ ...each, [i]: v })} />
          ${a.suggest === 'edit' && permOf(i) !== 'edit' && html`<div class="small muted">${t('파일을 고치는 역할이면 "파일 편집 허용"이 필요할 수 있어')}</div>`}</td>
      </tr>${a.warn?.length ? html`<tr key=${`w${i}`} class="team-warn"><td colspan="5">⚠ ${a.warn.map((w) => WARN()[w] || w).join(' · ')}</td></tr>` : ''}`)}</tbody>
    </table></div>
    <div class="small"><b>${t('단계')}</b> ${d.stages.map((st, k) => `${k + 1}. ${st.label} (${st.agents.join(' · ')})`).join(' → ')}</div>
    <div class="small muted">${t('같은 단계의 에이전트는 메시지마다 같이 돌아.')}</div>
    ${m.notes && html`<div class="small"><b>${t('옮기지 못한 것')}</b> ${m.notes}</div>`}
    <div class="team-opts">
      <label class="hire-check team-all"><span>${t('전원 권한')}</span><${PermSelect} value=${all} label=${t('전원 권한')} onChange=${(v) => { setAll(v); setEach({}); }} /></label>
      <label class="hire-check"><input type="checkbox" checked=${sw} onChange=${(e) => setSw(e.target.checked)} /> <span>${t('이 세션을 이 팀으로 바꾸기')}</span></label>
    </div>
    <div class="hire-acts">
      <button class="btn primary sm" disabled=${busy} onClick=${() => act('accept', { rev: m.rev || 0, permission: all, permissions: each, switchTeam: sw })}><${Icon} name="plus" /> ${t('만들기')}</button>
      <button class="btn sm" disabled=${busy} onClick=${() => act('dismiss')}>${t('그만')}</button>
      <span class="grow"></span>
      <button class="btn ghost sm" disabled=${busy} title=${t('팀을 짜 달라는 말이 아니었으면, 이 말과 문서를 그대로 에이전트에게 보내')} onClick=${() => act('send')}>${t('그냥 보내기')}</button>
    </div>
  </div></div>`;
}
