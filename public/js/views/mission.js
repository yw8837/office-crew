// 목표 모드 화면(결정 0014): 채팅의 목표 카드(확인·고쳐서 확인·그만, 끊긴 목표 이어서·버리기)와 오른쪽 패널의 "진행 기록" 탭.
// 카드는 서버가 저장한 초안을 그대로 보여 주고, 확인할 때 보여 주던 값 전체를 같이 보낸다(서버가 저장된 초안과 글자까지 대조한다)
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, ProviderChip } from '../ui.js';
import { state, changed, toast, agentById } from '../state.js';
import { post, put } from '../api.js';
import { t, locale } from '../i18n/index.js';
import { sumEstimate, limitRows, recordAge } from '../mission-numbers.js';
import { WIN_LABEL } from './session.js'; // 한도 창 이름(세션 화면의 계정 한도와 같은 이름)
import { answerNames, durationWords, unverifiedLines, failWords } from '../report-lines.js'; // 완주 보고의 글줄(서버가 기억에 넣는 글 판과 같은 함수, 결정 0025)
import { goalEndWord } from '../stage-model.js'; // 끝 상태 이름(흐름 무대의 끝 깃발과 같은 말)

const CRIT_COUNT = 7; // 서버와 같은 상한(server/mission.js)
const lines = (text) => String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
// 카드 값(서버가 대조하는 모양). 기준마다 확인 방법(checks)과 바뀌면 안 되는 것(keep)은 있을 때만(결정 0014 개정. 옛 카드는 없다)
const viewOf = (x) => ({
  goal: x?.goal || '', criteria: [...(x?.criteria || [])], outOfScope: [...(x?.outOfScope || [])], userDecides: [...(x?.userDecides || [])],
  ...(x?.checks?.some(Boolean) ? { checks: [...x.checks] } : {}), ...(x?.keep?.length ? { keep: [...x.keep] } : {}),
});
const checksOf = (v) => v.criteria.map((_, i) => v.checks?.[i] || '');

// 목표 상태 칩: [글, 칩 모양]
export const missionChip = (status) => ({
  drafting: [t('초안 쓰는 중'), ' accent'], draft: [t('확인 기다림'), ' warn'], active: [t('진행 중'), ' accent'], waiting: [t('답을 기다림'), ' warn'],
  unreviewed: [t('일 끝 · 판정 없음'), ' ok'], done: [t('통과로 끝'), ' ok'], accepted: [t('받아들임'), ' ok'], stopped: [t('멈춤'), ' warn'], cancelled: [t('닫힘'), ''], cut: [t('끊김'), ' err'],
}[status] || [status, '']);

// 기준 판정 칩(결정 0015): [글, 칩 모양]
export const verdictChip = (status) => ({ pass: [t('통과'), ' ok'], fail: [t('불합격'), ' err'], unknown: [t('확인 못 함'), ' warn'] }[status] || [t('아직'), '']);

// ── 일하기 전 조사와 회의(결정 0017) ──
// 카드의 기본 체크: 할 수 있고 진행자가 바로 실행을 권하지 않았으면 켜짐(서버가 정한 on)
const prepOf = (p) => ({ research: !!p?.research?.on, meeting: !!p?.meeting?.on });
// 확인한 카드에 남는 한 줄
const prepWords = (c) => (c.research && c.meeting ? t('일하기 전에 조사하고 회의해.') : c.research ? t('일하기 전에 조사해(회의는 안 해).') : c.meeting ? t('일하기 전에 회의해(조사는 안 해).') : t('조사·회의 없이 바로 일해.'));
// 어림값 한 줄(이 대목만): 조사는 훑어보기 1 + 질문 뽑기 1 + 질문마다 1, 회의는 서버가 지금 회의 엔진대로 센 수(참석자 × 바퀴). 목표 차례·일 단계·기준 판정은 따로
function prepEstimate(pp, on) {
  const parts = [];
  if (on.research) parts.push(t('조사 {min}~{max}번(훑어보기 1 + 질문 뽑기 1 + 질문마다 1, 질문 {a}~{b}개)', { min: pp.research.min, max: pp.research.max, a: pp.research.min - 2, b: pp.research.max - 2 }));
  if (on.meeting) {
    // 1바퀴에 반대편을 포함한 모두의 입장이 같으면 차례 바퀴를 건너뛰어 덜 든다(결정 0017. 서버가 센 fewer 가 calls 보다 작을 때만)
    const fewer = pp.meeting.fewer && pp.meeting.fewer < pp.meeting.calls ? pp.meeting.fewer : 0;
    parts.push(fewer ? t('회의 약 {n}번(참석자 {p}명 · {r}바퀴, 1바퀴에 반대편을 포함한 모두의 입장이 같으면 {f}번으로 줄어)', { n: pp.meeting.calls, p: pp.meeting.who.length, r: pp.meeting.rounds, f: fewer })
      : t('회의 약 {n}번(참석자 {p}명 · {r}바퀴)', { n: pp.meeting.calls, p: pp.meeting.who.length, r: pp.meeting.rounds }));
    if (pp.meeting.checks) parts.push(t('회의 중 조사로 최대 {n}번 더', { n: pp.meeting.checks }));
  }
  // 질문 블록·빈 답을 다시 요청하거나, 다시 시도·이어받기를 하면 그만큼 더 든다
  return `${t('어림값(일하기 전 대목만)')}: ${parts.join(' · ')}. ${t('블록이나 빈 답을 다시 요청하거나 다시 시도하면 더 들어.')}`;
}
// ── 호출 어림·구독 한도·한도 대기(결정 0019) ──
// 시각 한 줄: 오늘이면 시:분, 아니면 월/일 시:분(24시간제는 0~23시로. 자정이 24:05 로 보이지 않게)
const when = (ms) => {
  const d = new Date(ms);
  const same = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(locale(), same ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
};
// 목표 카드의 호출 어림 줄: 서버가 실은 조각(m.estimate)을 지금 고른 값으로 더한다(서버도 같은 함수로 확인 시점의 값을 적는다). 예측이 아니라 대략치라고 밝힌다
function EstimateLine({ est, pick }) {
  if (!est) return null;
  const e = sumEstimate(est, pick);
  const words = { min: e.min, max: e.max, spent: e.spent, n: e.returns, cap: e.cap };
  return html`<div class="goal-sec goal-estimate">
    <div class="small muted"><b>${t('호출 어림')}</b></div>
    <div class="small">${e.returns ? t('대략 {min}~{max}번 호출(목표 잡기에 이미 쓴 {spent}번·자동 되돌림 최대 {n}번 포함) · 상한 {cap}번', words) : t('대략 {min}~{max}번 호출(목표 잡기에 이미 쓴 {spent}번 포함) · 상한 {cap}번', words)}</div>
    ${e.max > e.cap && html`<div class="small">${t('상한에 닿으면 물어볼게.')}</div>`}
    <div class="small muted">${t('예측이 아니라 대략치야. 블록이나 빈 답을 다시 요청하거나, 오류로 다시 하거나, 다른 AI가 이어받거나, 한도에 걸려 다시 하면 더 들어.')}</div>
  </div>`;
}
// 구독 한도 줄: 그 목표에서 일할 AI들의 한도 기록 중 아직 유효한 창만(앱이 이미 받은 기록. 새로 읽지 않고, 이 목표가 몇 %를 쓸지 어림하지 않는다). 보일 창이 없으면 줄 자체를 안 그린다
// 기록이 몇 분·시간·일 전 것인지(24시간을 넘으면 오래된 기록)
const ageWords = (min) => {
  const a = recordAge(min);
  if (!a) return '';
  if (a.unit === 'min') return a.n < 1 ? t('방금 받은 기록') : t('{n}분 전 기준', { n: a.n });
  return a.unit === 'hour' ? t('{n}시간 전 기준', { n: a.n }) : t('{n}일 전 기준', { n: a.n });
};
// 구독 한도 % 상한(결정 0026): 줄 머리에 상한, 지금 일을 시작하면 상한 질문이 물을 AI 에는 "상한 넘음". 그 판단은 서버가 실제 검사와 같게 센 값(ask:
// 일을 다른 AI 로 넘기면 넘겨받는 AI, 이 목표에서 "계속"을 고른 AI·이미 다 찬 AI 는 빼고)이고, 서버 값이 아직 없으면 칩을 달지 않는다. 0 이면 끔
const capOf = () => { const n = Number(state.settings?.limitCap); return Number.isFinite(n) ? n : 90; };
function LimitLine({ providers, ask = [] }) {
  const asked = ask || [];
  const rows = limitRows(state.usage?.limits, [...new Set([...(providers || []), ...asked])]);
  if (!rows.length) return null;
  const cap = capOf();
  const over = (p) => cap > 0 && asked.includes(p);
  return html`<div class="goal-sec goal-limits">
    <div class="small muted"><b>${t('구독 한도(받은 기록)')}</b>${cap > 0 ? ` · ${t('상한 {n}%', { n: cap })}` : ` · ${t('상한 꺼짐')}`}</div>
    ${rows.map((r) => html`<div class="small"><${ProviderChip} id=${r.provider} /> ${r.windows.map((w) => `${WIN_LABEL[w.key] || w.key} ${w.pct}%${w.resetsAt ? ` (${t('{time} 초기화', { time: when(w.resetsAt * 1000) })})` : ''}`).join(' · ')}
      ${r.ago !== null && html`<span class="muted"> · ${ageWords(r.ago)}</span>`}${recordAge(r.ago)?.old ? html` <span class="chip warn">${t('오래된 기록')}</span>` : ''}${over(r.provider) ? html` <span class="chip warn">${t('상한 넘음 · 일을 시작하기 전에 물어')}</span>` : ''}</div>`)}
    <div class="small muted">${t('앱이 이미 받은 기록이야. 이 목표가 몇 %를 쓸지는 어림하지 않아.')}${cap > 0 ? ` ${t('일을 돌 AI 의 창이 상한 이상이면 새 일을 시작하기 전에 물어(사용률을 알려 주는 AI 만).')}` : ''}</div>
  </div>`;
}

// 조사 한 갈래가 끝나지 못한 이유(칩)
// 빈 답은 빈 답 다시 요청까지 두 번 놓친 갈래라 일 카드·판정과 같은 이름 "구멍"을 붙인다(결정 0018)
const missChip = (status) => ({ empty: `${t('빈 답')} · ${t('구멍')}`, failed: t('오류'), skipped: t('건너뜀') }[status] || t('끝나지 않음'));

// 조사 노트 카드(결정 0017): 코드가 묶은 카드. 머리에 확인 못 한 수, 질문마다 답의 앞부분과 그 답으로 가는 "전체 보기". 모두 에이전트가 쓴 글이다
export function ResearchCard({ m }) {
  const qs = m.questions || [];
  return html`<div class="msg proposal"><div class="hire goal-card" role="group" aria-label=${t('조사 노트')}>
    <div class="hire-head"><b>🔎 ${t('조사 노트')}</b><span class=${`chip${m.missing ? ' warn' : ' ok'}`}>${t('질문 {n}개 중 {m}개 확인 못 함', { n: m.total, m: m.missing })}</span>
      <span class="small muted">${t('에이전트가 씀 · 사용자 확인 안 함')}</span></div>
    ${(m.suspect !== undefined || m.unsourced !== undefined) && html`<div class="small">
      <span class=${`chip${m.suspect ? ' warn' : ''}`}>${t('지시처럼 보이는 줄 {n}개', { n: m.suspect || 0 })}</span> <span class=${`chip${m.unsourced ? ' warn' : ''}`}>${t('출처 없는 줄 {n}개', { n: m.unsourced || 0 })}</span>
      <span class="muted">${t('코드가 센 수')}</span></div>`}
    ${m.fallback && html`<div class="warnbox" role="note">${t('진행자 답에서 조사 질문을 읽지 못해서 질문 하나로 조사했어.')}</div>`}
    ${m.textOnly?.length && html`<div class="warnbox" role="note">${t('읽기 전용을 강제하는 장치가 없는 AI로 조사해서, 글 지시로만 묶였어: {names}', { names: m.textOnly.map((x) => `${x.name}(${x.ai})`).join(', ') })}</div>`}
    ${m.noTools?.length && html`<div class="small muted" role="note">${t('도구가 없는 AI라 검색 없이 아는 것으로만 조사했어: {names}', { names: m.noTools.map((x) => `${x.name}(${x.ai})`).join(', ') })}</div>`}
    ${qs.map((q) => html`<div class="research-q">
      <div class="small"><b>${q.id}</b> · ${q.text} <span class="muted">— ${agentById(q.agentId)?.name || q.agentId}</span>${q.status !== 'done' ? html` <span class="chip warn">${t('확인 못 함')} · ${missChip(q.status)}</span>` : ''}</div>
      ${q.suspect > 0 && html`<div class="warnbox" role="note">${t('이 답에는 지시처럼 보이는 줄이 {n}개 있어. 일 단계에는 그 줄만 빼고 가.', { n: q.suspect })}</div>`}
      ${q.excerpt && html`<div class="small research-ex">${q.excerpt}${q.more ? '…' : ''}</div>`}
      ${q.msgId && html`<button type="button" class="btn ghost sm" onClick=${() => jump(q.msgId)}>${t('전체 보기')}</button>`}
    </div>`)}
  </div></div>`;
}

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
  if (r.quota) return html`<div class="notice">🎯 ${t('검수자가 사용량 한도에 걸려 이 답에는 판정이 없어(같은 회차는 다시 판정하면 다음 답에 있어).')}</div>`; // 결정 0019
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

// 일하기 전 조사·회의(결정 0017)의 대목 이름(서버 mission.js 의 PREP_KINDS 와 같다)
const PREP = ['scan', 'questions', 'research', 'meeting'];
const Q_FINAL = ['done', 'empty', 'failed', 'skipped']; // 끝난 조사 질문(이어서 할 때 다시 안 돈다)

// 끊긴 목표를 이어서 하면 어디서부터 다시 도는지 한 줄(결정 0016). 끊긴 자리(m.at)와 끊긴 실행의 단계로, 서버가 하는 대로 적는다. 자리가 적혀 있지 않은 옛 목표면 null
export function resumeFrom(s, m) {
  const at = m?.at;
  if (!at || !Array.isArray(m.keep)) return null;
  const prep = PREP.includes(at.phase);
  // 승인·오류·판정 뒤 묻기·호출 상한. 준비 대목(결정 0017)은 호출 상한만 다시 묻고, 그 밖의 대기는 그 대목을 처음부터 다시
  if (at.wait && (!prep || ['cap', 'limitcap'].includes(at.wait.reason))) return t('끊기기 전에 묻던 질문을 다시 띄워(AI 호출 없음).'); // 구독 한도 상한(결정 0026)도 그 대목 앞에서 다시 묻는다
  const run = (s?.runs || []).findLast((r) => r.mission === 'work' && r.missionId === m.id);
  const st = run?.stages?.[at.stageIndex];
  const label = st?.label || '?';
  // 준비 대목은 한 번 실행이라 새 대화로 바꿀 사람이 없다. 끝난 대목은 다시 안 돌고, 조사는 안 끝난 질문만, 회의는 1바퀴부터
  if (at.phase === 'research') return t('조사에서 끝나지 않은 질문 {n}개만 다시 해. 끝난 질문의 답은 그대로 써.', { n: (m.research?.questions || []).filter((q) => !Q_FINAL.includes(q.status)).length });
  if (at.phase === 'meeting') return t('일하기 전 회의를 1바퀴부터 다시 해.');
  if (prep) return t('"{label}" 단계부터 다시 해.', { label });
  if (at.phase === 'review') return st?.mission === 'review' ? t('"{label}" 단계부터 다시 해.', { label }) : t('검수할 다른 팀원이 없어서 판정 없이 바로 물어.'); // 기준 판정은 늘 새 대화(바꿀 것 없음)
  const head = at.back ? t('"{label}" 단계의 되돌림(걸린 기준 고치기)부터 다시 해.', { label }) : t('"{label}" 단계부터 다시 해.', { label });
  if (st?.meeting && !at.back) return `${head} ${t('회의는 1바퀴부터 다시 해. 회의 차례는 늘 새 대화라 참석자의 저장된 대화는 그대로 둬.')}`;
  const names = (at.working || []).map((id) => agentById(id)?.name || id);
  const parts = [head];
  if (at.finished?.length) parts.push(t('이미 끝낸 담당의 답은 그대로 써.'));
  if (names.length) parts.push(t('끊긴 담당({names})만 새 대화로 시작해.', { names: names.join(', ') }));
  return parts.join(' ');
}

// 이어서가 거절된 이유와 누르는 중 표시는 끊긴 목표 알림 세 군데(카드·진행 기록·입력창 위)가 같이 쓴다(목표 id 마다)
const resumeUi = () => (state.ui.resume ||= {});

// 끊긴 목표 알림: 이어서(주 단추) / 버리기, 어디서부터 다시 도는지 한 줄. 이어서가 거절되면(409·400) 그 이유를 보여 준다.
// compact: 입력창 위처럼 좁은 자리(한 줄로)
export function CutBox({ s, m, compact = false }) {
  const ui = resumeUi()[m.id] || {};
  const busy = !!ui.busy;
  const why = ui.why || '';
  const from = resumeFrom(s, m);
  const set = (v) => { resumeUi()[m.id] = { ...(resumeUi()[m.id] || {}), ...v }; changed(); };
  const resume = async () => {
    if (busy) return;
    set({ busy: true, why: '' });
    try { await post(`/api/sessions/${s.id}/mission/resume`, { missionId: m.id }); set({ busy: false }); } catch (e) { set({ busy: false, why: e.message }); toast(e.message, 'error'); }
  };
  // 한도 대기에서 끊겼으면 초기화 예정 시각(결정 0019. 자동 이어서 타이머는 메모리라 앱을 끄면 사라진다)
  const q = m.at?.wait?.reason === 'quota' ? m.at.wait : null;
  const quota = q ? (q.until > Date.now() ? t('한도 초기화 예정 {time}.', { time: when(q.until) }) : q.until ? t('한도 초기화 예정 시각({time})이 지났어.', { time: when(q.until) }) : t('사용량 한도에 걸려 기다리던 중이었어(초기화 시각은 몰라).')) : '';
  return html`<div class=${compact ? 'warnbox row' : 'warnbox'} role="note" style=${compact ? 'max-width:860px;margin:0 auto 8px;flex-wrap:wrap' : ''}>
    <span>${compact ? '⚠ ' : ''}${t('앱이 꺼져서 목표가 끊겼어. 저절로 다시 시작하지 않아.')} ${from ? html`<span class="small">${from}</span>` : t('이 목표는 끊긴 자리가 적혀 있지 않아서 이어 갈 수 없어. 버리고 요청을 다시 보내 줘.')}${quota ? html` <span class="small">${quota}</span>` : ''}</span>
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
  const checks = checksOf(v);
  // 기준마다 확인 방법이 있으면 그 기준 아래 작게(결정 0014 개정)
  const crit = v.criteria.map((c, i) => (checks[i] ? html`${c}<div class="small muted">${t('확인 방법')}: ${checks[i]}</div>` : c));
  return html`
    <div class="goal-sec"><div class="small muted"><b>${t('목표')}</b></div><div>${v.goal || html`<span class="muted">${t('(비어 있음)')}</span>`}</div></div>
    <${Section} title=${t('합격 기준')} items=${crit} ordered=${true} empty=${t('기준이 없어. "고쳐서 시작"으로 기준을 적어 줘.')} />
    <${Section} title=${t('범위 밖')} items=${v.outOfScope} empty=${t('없음')} />
    <${Section} title=${t('사용자가 정할 것')} items=${v.userDecides} empty=${t('없음')} />
    ${v.keep?.length > 0 && html`<${Section} title=${t('바뀌면 안 되는 것')} items=${v.keep} empty=${t('없음')} />`}`;
}

// ── 일 카드(결정 0018) ──
// 일하는 방식을 못 쓰는 이유
const workWhy = (why) => ({
  approve: t('팀 단계에 승인 관문이 있어서 일 카드로는 못 해(관문을 말없이 없애지 않아).'),
  meeting: t('팀 단계에 회의가 있어서 일 카드로는 못 해(회의를 말없이 없애지 않아).'),
  few: t('검수 역할이 아닌 팀원이 한 명뿐이라 일 카드로 나눌 수 없어.'),
}[why] || '');
// 카드 상태 칩: [글, 칩 모양]. 기다리는 카드는 하는 중으로 세지 않는다
export const cardChip = (status) => ({ waiting: [t('기다림'), ''], running: [t('하는 중'), ' accent'], done: [t('끝'), ' ok'], blocked: [t('막힘'), ' err'], skipped: [t('건너뜀'), ' warn'], hole: [t('구멍'), ' warn'] }[status] || [status, '']);
const KIND = () => ({ research: t('조사'), write: t('글'), build: t('만들기'), check: t('확인') });
// 기다리는 카드가 무엇을 기다리는지(앞 카드가 다 끝났으면 차례를 기다림)
const waitWords = (c, cards) => {
  const left = (c.needs || []).filter((n) => !['done', 'hole', 'skipped', 'blocked'].includes(cards.find((x) => x.id === n)?.status));
  return left.length ? t('{ids}을(를) 기다림', { ids: left.join(', ') }) : t('차례를 기다림');
};

// 계획 뒤 남은 호출 어림 한 줄(결정 0025): 카드 단계·기준 판정·남은 자동 되돌림. 대략치
const planEstimateWords = (e, n) => (e.returns
  ? t('남은 호출 어림 {min}~{max}번(카드 {n}장 · 기준 판정 · 자동 되돌림 최대 {r}번) · 지금까지 {used}번 · 상한 {cap}번', { min: e.min, max: e.max, n, r: e.returns, used: e.used, cap: e.cap })
  : t('남은 호출 어림 {min}~{max}번(카드 {n}장) · 지금까지 {used}번 · 상한 {cap}번', { min: e.min, max: e.max, n, used: e.used, cap: e.cap }));

// 계획 카드: 진행자가 쓴 일 카드 목록(코드가 다듬고 번호·단계를 붙임). 사용자 확인 없이 이어 간다. 지금 목표의 카드면 상태 칩도
export function PlanCard({ m }) {
  const s = state.sessionData[state.route.id];
  const live = s?.mission?.id === m.missionId ? s.mission.cards || [] : [];
  return html`<div class="msg proposal"><div class="hire goal-card" role="group" aria-label=${t('일 계획')}>
    <div class="hire-head"><b>📋 ${t('일 계획')}</b><span class="chip">${t('카드 {n}장', { n: m.cards.length })}</span>
      <span class="small muted">${t('에이전트가 씀 · 사용자 확인 안 함')}</span></div>
    ${m.fallback && html`<div class="warnbox" role="note">${t('진행자 답에서 계획 블록을 읽지 못해서 카드 하나로 일해.')}</div>`}
    ${(m.reassigned || []).map((x) => html`<div class="notice" role="note">${t('{id}의 담당 "{from}"이(가) 팀 명단에 없어서 {to}에게 맡겼어.', { id: x.id, from: x.from || '?', to: x.to })}</div>`)}
    <div class="small">${m.wavesText}</div>
    ${m.estimate && html`<div class="small">${planEstimateWords(m.estimate, m.cards.length)}</div>
      ${m.estimate.max > m.estimate.cap - m.estimate.used && html`<div class="small muted">${t('어림의 큰 쪽이 상한까지 남은 호출보다 많아서 첫 카드 단계 앞에서 물어봐.')}</div>`}`}
    <ol class="plan-cards">${m.cards.map((c) => {
      const now = live.find((x) => x.id === c.id);
      const [label, cls] = now ? cardChip(now.status) : ['', ''];
      return html`<li>
        <div><b>${c.id}</b> · ${c.title} <span class="muted">— ${agentById(c.ownerId)?.name || c.owner} · ${KIND()[c.kind] || c.kind}</span>${now && html` <span class=${`chip${cls}`}>${label}</span>`}</div>
        ${c.needs?.length > 0 && html`<div class="small muted">${t('{ids}의 결과를 기다려', { ids: c.needs.join(', ') })}</div>`}
        ${c.done && html`<div class="small muted">${t('끝 기준')}: ${c.done}</div>`}
        <div class="small muted">${t('맡을 파일')}: ${c.files?.length ? c.files.join(', ') : t('(적지 않음)')}${c.solo ? ` · ${t('파일을 안 적어서 혼자 돌아')}` : ''}</div>
        ${c.not && html`<div class="small muted">${t('건드리면 안 되는 것')}: ${c.not}</div>`}
      </li>`;
    })}</ol>
  </div></div>`;
}

// ── 완주 보고(결정 0025) ──
// 목표가 끝나면 코드가 모은 사실로 만든 카드(AI 호출 없음). 처음엔 한 줄 요약으로 접혀 있고, 펼치면 호출·기준·사용자가 누른 것·확인 못 한 것·실패 종류·바뀐 파일·회의 결론.
// 에이전트가 쓴 글(기준 근거·회의 결론)은 "에이전트가 씀" 표시와 함께. 기억에는 사용자가 "기억에 넣기"를 눌러야 들어가고, 빼면 검색에서 빠진다
export function ReportCard({ m }) {
  const sid = state.route.id;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyId = `report-${m.id}`;
  const crit = m.criteria || [];
  const pass = crit.filter((c) => c.status === 'pass').length;
  const used = m.calls?.used ?? 0;
  const calls = m.estimate ? t('실제 호출 {k}번(어림 {min}~{max}번)', { k: used, min: m.estimate.min, max: m.estimate.max }) : t('실제 호출 {k}번', { k: used });
  const names = answerNames(t);
  const left = unverifiedLines(t, m);
  const fails = failWords(t, m.fails);
  const memOn = state.settings.memory === true;
  const inMem = !!m.memory?.added && m.memory.on !== false;
  const remember = async (on) => {
    if (busy) return;
    setBusy(true);
    try { const r = await post(`/api/sessions/${sid}/report/${m.id}/memory`, { on }); if (r?.notice) toast(r.notice, 'error'); } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  const files = m.filesState === 'pending' ? html`<div class="small muted">${t('git 에 물어보는 중…')}</div>`
    : m.filesState !== 'done' || !m.files?.list?.length ? html`<div class="small muted">${t('git 저장소가 아니거나 커밋 안 된 변경이 없어.')}</div>`
      : html`<ul class="small report-files">${m.files.list.map((f) => html`<li>${f}</li>`)}</ul>${m.files.more ? html`<div class="small muted">${t('…(그 밖에 {n}개)', { n: m.files.more })}</div>` : ''}
        <div class="small muted">${t('끝났을 때 커밋 안 된 변경이야(이 목표 전부터 있던 변경도 섞일 수 있어).')}</div>`;
  return html`<div class="msg proposal"><div class="hire goal-card report-card" role="group" aria-label=${t('완주 보고')}>
    <div class="hire-head"><b>📊 ${t('완주 보고')}</b><span class=${`chip${m.end === 'stopped' ? ' warn' : ' ok'}`}>${goalEndWord(m.end) || m.end}</span>
      <span class="small muted">${t('코드가 모은 기록 · AI 호출 없음')}</span></div>
    <div class="small">${t('확인부터 끝까지 {t}', { t: durationWords(t, (m.to || 0) - (m.from || 0)) })} · ${calls} · ${t('기준 {pass}/{total} 통과', { pass, total: crit.length })}</div>
    <div class="hire-acts">
      <button type="button" class="btn ghost sm" aria-expanded=${open ? 'true' : 'false'} aria-controls=${bodyId} onClick=${() => setOpen(!open)}>${open ? t('보고 접기') : t('보고 펼치기')}</button>
      <span class="grow"></span>
      ${!memOn ? html`<span class="small muted">${t('프로젝트 기억이 꺼져 있어서 기억에 넣을 수 없어.')}</span>`
        : inMem ? html`<span class="chip ok">${t('기억에 넣었어')}</span><button type="button" class="btn sm" disabled=${busy} onClick=${() => remember(false)}>${t('기억에서 빼기')}</button>`
          : html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => remember(true)}>${m.memory?.added ? t('기억에 다시 넣기') : t('기억에 넣기')}</button>`}
    </div>
    ${memOn && html`<div class="small muted">${inMem ? t('빼면 기억 검색에서 빠져(원문은 디스크에 남아).') : t('넣으면 이 작업 폴더의 다음 실행들이 참고 자료로 찾을 수 있어. 코드가 모은 사실과 기준별 결과만 넣고, 회의 결론·조사 노트는 넣지 않아.')}${m.local ? ` ${t('내 PC 모델만 받은 목표라 내 PC 모델 전용으로 넣어(클라우드 AI 에게는 안 줘).')}` : ''}</div>`}
    <div id=${bodyId} class="report-body" role="region" aria-label=${t('완주 보고 자세히')} hidden=${!open}>
      <div class="goal-sec"><div class="small muted"><b>${t('호출')}</b></div>
        <div class="small">${calls} · ${t('상한 {cap}번', { cap: m.calls?.cap ?? 0 })}</div>
        <div class="small">${t('종류별 답 수')}: ${Object.keys(names).map((k) => `${names[k]} ${m.answers?.[k] || 0}`).join(' · ')}${m.answerFails > 0 ? ` ${t('(오류·중지로 끝난 답 {n}개 포함)', { n: m.answerFails })}` : ''}</div>
        <div class="small muted">${t('메시지 표시로 센 답 수야(오류·중지로 끝난 답도 들어가). 다시 요청·이어받기는 한 답 안에서 호출이 더 들 수 있어.')}</div></div>
      <div class="goal-sec"><div class="small muted"><b>${t('기준별 최종 판정')}</b></div>
        ${crit.length ? html`<div class="crit-table" role="list" aria-label=${t('기준별 최종 판정')}>${crit.map((c, i) => html`<${CritRow} c=${c} n=${i + 1} />`)}</div>` : html`<div class="small muted">${t('없음')}</div>`}</div>
      <div class="goal-sec"><div class="small muted"><b>${t('사용자가 확정한 것')}</b></div>
        ${m.user?.length ? html`<ul class="small">${m.user.map((x) => html`<li>${x.text}</li>`)}</ul>` : html`<div class="small muted">${t('없음')}</div>`}
        ${m.userMore > 0 && html`<div class="small muted">${t('그 앞의 {n}줄은 줄였어.', { n: m.userMore })}</div>`}
        <div class="small muted">${t('진행 기록에서 뽑았어. 승인·오류 대기에서 고른 것과 에이전트에게 바로 보낸 지시는 진행 기록에 없어서 빠져.')}</div></div>
      <div class="goal-sec"><div class="small muted"><b>${t('확인 못 한 것')}</b></div>
        ${left.length ? html`<ul class="small">${left.map((x) => html`<li>${x}</li>`)}</ul>` : html`<div class="small muted">${t('없음')}</div>`}</div>
      <div class="goal-sec"><div class="small muted"><b>${t('실패 종류')}</b></div>
        <div class="small">${fails || t('없음')}</div>
        ${m.routes > 0 && html`<div class="small">${t('배정이 평소와 달랐던 답: {n}개', { n: m.routes })}</div>`}
        ${m.logCut > 0 && html`<div class="small muted">${t('진행 기록의 앞 {n}줄이 잘려서 그 앞의 선택·실패는 빠졌어.', { n: m.logCut })}</div>`}
        <div class="small muted">${t('코드가 진행 기록에서 센 수야.')}</div></div>
      <div class="goal-sec"><div class="small muted"><b>${t('바뀐 파일(git)')}</b></div>${files}</div>
      ${m.meetings?.length > 0 && html`<div class="goal-sec"><div class="small muted"><b>${t('회의 결론(결정·남은 이견)')}</b> · ${t('에이전트가 씀 · 사용자 확인 안 함')}</div>
        ${m.meetings.map((x) => html`<div class="research-q">
          <div class="small"><b>${x.prep ? t('준비 회의') : x.label || t('회의')}</b></div>
          ${x.decision ? html`<div class="small">${t('결정')}: ${x.decision}</div>` : html`<div class="small muted">${t('결론 형식을 읽지 못했어(전문은 그 메시지에).')}</div>`}
          ${x.dissent?.length > 0 && html`<div class="small">${t('남은 이견')}: ${x.dissent.join(' · ')}</div>`}
          ${x.msgId && html`<button type="button" class="btn ghost sm" onClick=${() => jump(x.msgId)}>${t('그 메시지로 가기')}</button>`}
        </div>`)}</div>`}
    </div>
  </div></div>`;
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
  const [prepShown, setPrepShown] = useState(null); // 조사·회의 먼저가 지금 팀으로 안 될 때 서버가 준 지금 값(결정 0017)
  const [prepOn, setPrepOn] = useState(null); // 사용자가 고친 체크 { research, meeting }(없으면 카드의 기본값)
  const [workShown, setWorkShown] = useState(null); // 일 카드를 지금 팀으로 못 쓸 때 서버가 준 지금 값(결정 0018)
  const [workSel, setWorkSel] = useState(null); // 사용자가 고른 일하는 방식('cards' | 'stages', 없으면 카드의 기본값)
  const [estShown, setEstShown] = useState(null); // 확인이 어긋났을 때 서버가 준 지금 팀의 호출 어림 조각(결정 0019)
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
      ${m.prepChosen && html`<div class="small muted">${prepWords(m.prepChosen)}</div>`}
      ${m.workChosen && html`<div class="small muted">${m.workChosen === 'cards' ? t('일 카드로 나눠 해.') : t('팀 단계표대로 해.')}</div>`}
      ${mission?.status === 'unreviewed' && html`<div class="notice">${t('일은 끝났어. 기준 판정은 아직 없어.')}</div>`}
      ${mission?.status === 'done' && html`<div class="notice">✅ ${t('기준 {n}개를 모두 통과해서 끝냈어.', { n: mission.criteria.length })}</div>`}
      ${mission?.status === 'accepted' && html`<div class="notice">${t('받아들여서 끝냈어 · 남은 기준 {n}개', { n: left })}</div>`}
      ${mission?.calls && ['done', 'accepted', 'stopped'].includes(mission.status) && html`<div class="small muted">${mission.estimate ? t('실제 호출 {k}번(어림 {min}~{max}번)', { k: mission.calls.used, min: mission.estimate.min, max: mission.estimate.max }) : t('실제 호출 {k}번', { k: mission.calls.used })}</div>`}
      ${mission && ['active', 'waiting', 'cut'].includes(mission.status) && html`<${LimitLine} providers=${m.providers} ask=${s?.capAsk} />`}
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
      // 조사·회의 먼저가 지금 팀으로 안 되면 지금 값으로 다시 그린다(이제 못 하는 대목의 체크는 끈다)
      if (e.data?.prep) { const p = e.data.prep; setPrepShown(p); setPrepOn((o) => ({ research: !!(o || prepOf(p)).research && p.research.can, meeting: !!(o || prepOf(p)).meeting && p.meeting.can })); }
      // 일 카드를 지금 팀으로 못 쓰면 지금 값으로 다시 그리고 팀 단계표로 돌린다
      if (e.data?.work) { setWorkShown(e.data.work); setWorkSel(e.data.work.can ? null : 'stages'); }
      // 팀이 바뀌어 어긋났으면 호출 어림도 지금 팀의 조각으로 다시 더한다
      if (e.data?.estimate) setEstShown(e.data.estimate);
      toast(e.message, 'error');
      setBusy(false);
      return false;
    }
  };
  // 보여 주던 뺄 단계 목록도 같이 보낸다(서버가 지금 팀과 글자까지 대조한다)
  const review = rv ? { reviewerId: rv.reviewerId || null, droppable: rv.droppable || [], drop: (rv.droppable || []).map((d) => d.index).filter((i) => !kept.includes(i)) } : undefined;
  // 조사·회의 먼저(결정 0017): 고른 체크와 보여 주던 조사 담당·참석자를 같이 보낸다(서버가 지금 팀으로 할 수 있는지 대조한다). 옛 카드(이 칸 없음)는 보내지 않는다(바로 일한다)
  const pp = prepShown || m.prep || null;
  const on = pp ? prepOn || prepOf(pp) : null;
  const prep = pp ? { research: !!on.research && pp.research.can, meeting: !!on.meeting && pp.meeting.can, ...(pp.lead ? { lead: pp.lead.id } : {}), researchers: pp.research.who.map((w) => w.id), attendees: pp.meeting.who.map((w) => w.id) } : undefined;
  const noLead = !!pp?.lead && !pp.lead.inTeam; // 카드를 본 뒤 진행자가 팀에서 빠졌다(조사 질문·회의를 맡을 사람이 없다)
  // 일하는 방식(결정 0018): 옛 카드(이 칸 없음)는 보내지 않는다(팀 단계표대로)
  const wk = workShown || m.work || null;
  const work = wk ? (workSel || wk.on) : undefined;
  // 호출 어림(결정 0019): 보여 주는 범위의 두 숫자도 보낸다(지금 팀으로 다시 센 값과 다르면 서버가 409 와 지금 조각을 준다). 옛 카드(이 칸 없음)는 보내지 않는다
  const est = estShown || m.estimate || null;
  const estPick = { work: work === 'cards' ? 'cards' : 'stages', research: !!prep?.research, meeting: !!prep?.meeting, kept };
  const seen = est ? sumEstimate(est, estPick) : null;
  const estimate = seen ? { estimate: { min: seen.min, max: seen.max } } : {};
  const start = () => send('confirm', { missionId: m.missionId, expected: v, review, prep, ...(wk ? { work } : {}), ...estimate });
  // 고친 값: 기준 줄과 같은 줄의 확인 방법을 짝지어 빈 기준은 그 확인 방법과 같이 뺀다
  const pairs = edit ? String(edit.criteria).split(/\r?\n/).map((c, i) => [c.trim(), (String(edit.checks || '').split(/\r?\n/)[i] || '').trim()]).filter(([c]) => c) : [];
  const edited = edit && { goal: edit.goal.trim(), criteria: pairs.map((x) => x[0]), checks: pairs.map((x) => x[1]), outOfScope: lines(edit.outOfScope), userDecides: lines(edit.userDecides), keep: lines(edit.keep) };
  const canEdited = !!edited && !!edited.goal && edited.criteria.length > 0;
  const startEdited = () => { if (canEdited) send('confirm', { missionId: m.missionId, expected: v, edited, review, prep, ...(wk ? { work } : {}), ...estimate }); };
  const names = (who) => who.map((w) => agentById(w.id)?.name || w.name || w.id).join(', ');
  const prepLine = pp && html`<div class="goal-sec goal-prep">
    <div class="small muted"><b>${t('조사·회의 먼저')}</b></div>
    ${prepShown && html`<div class="notice" role="status">${t('조사·회의를 맡을 팀원이 바뀌어서 지금 값으로 다시 그렸어. 다시 확인해 줘.')}</div>`}
    ${pp.direct && html`<div class="small">💡 ${t('진행자가 작은 목표라 조사·회의 없이 바로 일하기를 권했어.')}</div>`}
    <label class="goal-keep small">
      <input type="checkbox" checked=${prep.research} disabled=${busy || !pp.research.can} onChange=${(e) => setPrepOn({ ...on, research: e.target.checked })} />
      <span><b>${t('조사')}</b> — ${pp.research.can ? t('훑어보고, 조사 질문을 뽑아, 질문마다 찾아 와({names}).', { names: names(pp.research.who) }) : noLead ? t('진행자({name})가 지금 팀에 없어서 조사·회의는 못 해.', { name: pp.lead.name }) : t('팀에 조사 역할이 없어서 조사는 못 해.')}</span>
    </label>
    <label class="goal-keep small">
      <input type="checkbox" checked=${prep.meeting} disabled=${busy || !pp.meeting.can} onChange=${(e) => setPrepOn({ ...on, meeting: e.target.checked })} />
      <span><b>${t('회의')}</b> — ${!pp.meeting.can ? (noLead ? t('진행자({name})가 지금 팀에 없어서 조사·회의는 못 해.', { name: pp.lead.name }) : t('회의에 들 사람이 둘이 안 돼서 회의는 못 해(진행자와, 만들기·검수가 아닌 팀원이 들어가).'))
        : prep.research ? t('조사 노트를 놓고 무엇을 할지 회의해(참석자 {names}, 새 대화로).', { names: names(pp.meeting.who) }) : t('무엇을 해야 목표를 채우는지 회의해(참석자 {names}, 새 대화로).', { names: names(pp.meeting.who) })}</span>
    </label>
    ${(prep.research || prep.meeting) && html`<div class="small muted">${prepEstimate(pp, prep)}</div>`}
  </div>`;
  const keep = (i, on) => setKept((k) => (on ? [...new Set([...k, i])] : k.filter((x) => x !== i)));
  const reviewLine = rv && html`<div class="goal-sec goal-review">
    <div class="small muted"><b>${t('검수')}</b></div>
    ${rvShown && html`<div class="notice" role="status">${t('검수자나 건너뛸 단계가 바뀌어서 지금 값으로 다시 그렸어. 다시 확인해 줘.')}</div>`}
    <div>${rv.reviewerId ? t('검수: {name}이(가) 기준마다 판정해.', { name: rv.reviewerName || agentById(rv.reviewerId)?.name || rv.reviewerId }) : t('검수할 다른 팀원이 없어서 판정 없이 끝나고 네게 물어.')}</div>
    ${rv.reviewerId && m.reviewerReadOnly !== undefined && html`<div class="small">${m.reviewerReadOnly ? t('읽기 전용이라 명령·테스트를 못 돌려. 파일을 읽어서 확인하는 데까지만 판정해.') : t('명령·테스트를 돌려 확인할 수 있어.')}</div>`}
    ${work !== 'cards' && (rv.droppable || []).map((d) => html`<label class="goal-keep small">
      <input type="checkbox" checked=${kept.includes(d.index)} disabled=${busy} onChange=${(e) => keep(d.index, e.target.checked)} />
      <span><b>${t('남기기')}</b> · "${d.label}"${d.names?.length ? ` (${d.names.join(', ')})` : ''} — ${kept.includes(d.index) ? t('남겨서 그대로 돌려.') : t('이 단계는 기준 판정으로 대신해서 건너뛰어.')}
        ${d.instruction && html`<span class="muted goal-keep-ins">${t('이 단계의 지시(건너뛰면 안 쓰여): {text}', { text: d.instruction })}</span>`}</span>
    </label>`)}
  </div>`;
  const workLine = wk && html`<div class="goal-sec goal-work" role="radiogroup" aria-label=${t('일하는 방식')}>
    <div class="small muted"><b>${t('일하는 방식')}</b></div>
    ${workShown && html`<div class="notice" role="status">${t('지금 팀으로는 일 카드로 나눠 할 수 없어서 다시 그렸어. 다시 확인해 줘.')}</div>`}
    <label class="goal-keep small"><input type="radio" name=${`work-${m.id}`} checked=${work === 'cards'} disabled=${busy || !wk.can} onChange=${() => setWorkSel('cards')} />
      <span><b>${t('일 카드로 나눠 하기')}</b> — ${wk.can ? t('진행자가 일을 카드 몇 장으로 나눠 담당에게 맡겨(계획 1번). 결과가 실제로 필요할 때만 순서를 걸어. 팀 단계표의 단계는 이번 목표에서 돌지 않아.') : workWhy(wk.why)}</span></label>
    <label class="goal-keep small"><input type="radio" name=${`work-${m.id}`} checked=${work !== 'cards'} disabled=${busy} onChange=${() => setWorkSel('stages')} />
      <span><b>${t('팀 단계표대로')}</b> — ${t('팀에 짜 둔 단계를 순서대로 돌아.')}</span></label>
  </div>`;
  // 호출 어림(결정 0019): 조사·회의 체크, 일하는 방식, 남기기를 바꾸면 바로 다시 더한다(옛 카드는 이 칸이 없어 안 보인다). 구독 한도는 받은 기록이 있을 때만
  const estLine = est && html`<${EstimateLine} est=${est} pick=${estPick} />`;
  const limLine = html`<${LimitLine} providers=${m.providers} ask=${s?.capAsk} />`;
  const openEdit = () => setEdit({ goal: v.goal, criteria: v.criteria.join('\n'), checks: checksOf(v).join('\n'), outOfScope: v.outOfScope.join('\n'), userDecides: v.userDecides.join('\n'), keep: (v.keep || []).join('\n') });
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
        ${field('checks', t('확인 방법 (기준과 같은 줄에, 없으면 빈 줄)'), 3)}
        ${field('outOfScope', t('범위 밖 (한 줄에 하나)'), 2)}
        ${field('userDecides', t('사용자가 정할 것 (한 줄에 하나)'), 2)}
        ${field('keep', t('바뀌면 안 되는 것 (한 줄에 하나)'), 2)}
        <div class="small muted">${t('기준 {n}개', { n: edited.criteria.length })}${edited.criteria.length > CRIT_COUNT ? ` · ${t('{n}개를 넘는 줄은 빠져.', { n: CRIT_COUNT })}` : ''} · ${t('Esc 고치기 취소 · Ctrl+Enter 시작')}</div>
        ${workLine}
        ${reviewLine}
        ${prepLine}
        ${estLine}
        ${limLine}
        <div class="hire-acts">
          <button class="btn primary sm" disabled=${busy || !canEdited} onClick=${startEdited}>${t('이 내용으로 시작')}</button>
          <button class="btn sm" disabled=${busy} onClick=${closeEdit}>${t('고치기 취소')}</button>
        </div>
      </div>` : html`<${CardBody} v=${v} />${workLine}${reviewLine}${prepLine}${estLine}${limLine}`}
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
  // 한도 대기(결정 0019): 이어받을 AI 없이 사용량 한도에 걸려 멈춤. 보기 순서: 그 시각 뒤 이어서(자동, 시각을 알 때만) · 지금 다시 · 건너뛰기(일 단계)/받아들이기(판정) · 그만
  if (hold.reason === 'quota') {
    const names = (hold.who || []).map((w) => w.name).join(', ');
    const review = hold.phase === 'review';
    const auto = !!hold.canAuto && !hold.autoAt;
    let k = 0;
    return html`<div class="ask-panel mission-gate" role="group" aria-label=${t('사용량 한도 대기')}>
      <div class="ask-head"><span class="ask-who">⏳ ${t('사용량 한도 대기')}</span></div>
      <div class="ask-question">${review ? t('검수자 {names}이(가) 사용량 한도에 걸려 기준 판정을 못 했어. 이어받을 다른 AI가 없어. 어떻게 할까?', { names }) : t('{names}이(가) 사용량 한도에 걸려 멈췄어. 이어받을 다른 AI가 없어. 어떻게 할까?', { names })}</div>
      ${hold.until ? html`<div class="small">${t('한도는 {time}에 초기화돼(한도 기록이나 오류 문구로 안 시각).', { time: when(hold.until) })}</div>`
        : hold.passed ? html`<div class="small">${t('한도 초기화 예정 시각({time})이 지났어. "지금 다시"를 눌러.', { time: when(hold.passed) })}</div>`
          : html`<div class="small">${t('초기화 시각을 몰라. 한도가 풀리면 "지금 다시"를 눌러.')}</div>`}
      ${!!hold.autoAt && html`<div class="notice" role="status">${t('{time}에 자동으로 이어서 해. 그 전에 "지금 다시"나 "그만"을 눌러도 돼.', { time: when(hold.autoAt) })}</div>`}
      ${!!hold.until && !hold.canAuto && html`<div class="small muted">${t('자동 이어서는 목표 하나에 {n}번까지야. 이번엔 직접 골라 줘.', { n: hold.autoMax })}</div>`}
      ${(hold.who || []).some((w) => w.error) && html`<ul class="small">${hold.who.filter((w) => w.error).map((w) => html`<li><b>${w.name}</b>${w.ai ? ` (${w.ai})` : ''}: ${w.error} <span class="muted">· ${t('AI가 보낸 오류 문구')}</span></li>`)}</ul>`}
      <div class="ask-rows">
        ${auto && row(++k, t('{time} 뒤 이어서(자동)', { time: when(hold.until) }), t('초기화 시각에 여유를 조금 두고 같은 단계를 다시 시작해(자동 이어서 {n}/{max}번째).', { n: (hold.autos || 0) + 1, max: hold.autoMax }), 'later')}
        ${row(++k, t('지금 다시'), review ? t('같은 회차의 기준 판정을 지금 다시 해. 한도가 안 풀렸으면 또 멈춰.') : t('한도에 걸린 사람만 같은 단계를 지금 다시 해(끝낸 사람의 답은 그대로 써). 한도가 안 풀렸으면 또 멈춰.'), 'retry')}
        ${review ? row(++k, t('받아들이기'), t('이번 검수는 판정 없이 끝내고, 기준은 "확인 못 함"인 채로 목표를 받아들여.'), 'accept')
          : row(++k, t('건너뛰기'), t('한도에 걸린 일은 빼고 다음으로 넘어가(일 카드면 그 카드는 구멍으로 적어).'), 'skip')}
      </div>
      <div class="ask-foot"><span class="grow"></span><button type="button" class="btn sm danger" disabled=${busy} onClick=${() => ctl('stop')}>${t('그만')}</button></div>
    </div>`;
  }
  // 구독 한도 % 상한(결정 0026): 새 일을 시작하기 전에 멈춤. 보기 순서: 계속 · 초기화 뒤 이어서(자동, 시각을 알 때만) · 그만
  if (hold.reason === 'limitcap') {
    const auto = !!hold.canAuto && !hold.autoAt;
    const ais = [...new Set((hold.who || []).map((w) => w.ai || w.provider))].join(', ');
    let k = 0;
    return html`<div class="ask-panel mission-gate" role="group" aria-label=${t('구독 한도 상한')}>
      <div class="ask-head"><span class="ask-who">📊 ${t('구독 한도 상한')}</span></div>
      <div class="ask-question">${t('다음 일을 시작하기 전에 멈췄어. 이 일을 돌 AI 의 구독 한도가 상한({cap}%) 이상이야. 어떻게 할까?', { cap: hold.cap })}</div>
      <ul class="small">${(hold.who || []).map((w) => html`<li><b>${w.name}</b> (${w.ai || w.provider}): ${(w.windows || []).map((x) => `${WIN_LABEL[x.key] || x.key} ${x.pct}%${x.resetsAt ? ` (${t('{time} 초기화', { time: when(x.resetsAt * 1000) })})` : ''}`).join(' · ')}</li>`)}</ul>
      ${!hold.until && html`<div class="small">${t('초기화 시각을 모르는 창이 있어서 자동으로 이어서는 못 해.')}</div>`}
      ${!!hold.autoAt && html`<div class="notice" role="status">${t('{time}에 한도를 다시 보고 이어서 해. 그 전에 "계속"이나 "그만"을 눌러도 돼.', { time: when(hold.autoAt) })}</div>`}
      ${!!hold.until && !hold.canAuto && html`<div class="small muted">${t('자동 이어서는 목표 하나에 {n}번까지야. 이번엔 직접 골라 줘.', { n: hold.autoMax })}</div>`}
      <div class="ask-rows">
        ${row(++k, t('계속'), t('지금 시작해. 이 목표가 끝날 때까지 {ais}로는 상한을 다시 묻지 않아.', { ais }), 'accept')}
        ${auto && row(++k, t('{time} 뒤 이어서(자동)', { time: when(hold.until) }), t('초기화 시각에 여유를 조금 두고 한도를 다시 본 뒤 시작해(자동 이어서 {n}/{max}번째, 한도 대기와 같은 횟수).', { n: (hold.autos || 0) + 1, max: hold.autoMax }), 'later')}
      </div>
      <div class="small muted">${t('사용률은 앱이 이미 받은 기록이야. 사용률을 알려 주지 않는 AI 는 보지 않아. 상한은 라우팅 화면에서 바꿔.')}</div>
      <div class="ask-foot"><span class="grow"></span><button type="button" class="btn sm danger" disabled=${busy} onClick=${() => ctl('stop')}>${t('그만')}</button></div>
    </div>`;
  }
  // 일 카드(결정 0018): 한 시간 안에 시작한 카드 수 상한
  if (hold.reason === 'cap' && hold.kind === 'rate') {
    return html`<div class="ask-panel mission-gate" role="group" aria-label=${t('카드 시작 수 상한')}>
      <div class="ask-head"><span class="ask-who">🔢 ${t('한 시간 안에 시작한 카드')}</span></div>
      <div class="ask-question">${t('한 시간 안에 카드 {used}장을 시작했어(상한 {cap}장). 더 시작할까?', { used: hold.used, cap: hold.cap })}</div>
      <div class="ask-rows">${row(1, t('{n}장 더', { n: hold.step }), t('상한을 늘리고 이어서 해.'), 'more')}</div>
      <div class="ask-foot"><span class="grow"></span><button type="button" class="btn sm danger" disabled=${busy} onClick=${() => ctl('stop')}>${t('그만')}</button></div>
    </div>`;
  }
  // 계획 뒤 어림(결정 0025): 계획을 보니 남은 호출 어림의 큰 쪽이 상한까지 남은 호출보다 많다. 첫 카드 단계를 시작하기 전에 묻는다(상한을 다 쓴 게 아니다)
  if (hold.reason === 'cap' && hold.kind === 'plan') {
    const left = Math.max(0, (Number(hold.cap) || 0) - (Number(hold.used) || 0));
    return html`<div class="ask-panel mission-gate" role="group" aria-label=${t('계획 뒤 어림')}>
      <div class="ask-head"><span class="ask-who">🔢 ${t('계획 뒤 어림')}</span></div>
      <div class="ask-question">${t('계획을 보니 남은 호출이 {min}~{max}번으로 어림돼. 상한까지 {left}번 남았어. 더 할까?', { min: hold.min, max: hold.max, left })}</div>
      <div class="small muted">${t('어림의 큰 쪽이 남은 호출보다 많아서 첫 카드 단계를 시작하기 전에 멈췄어. 대략치라 실제로는 덜 들 수도 있어. 지금까지 {used}번 · 상한 {cap}번.', { used: hold.used, cap: hold.cap })}</div>
      <div class="ask-rows">${row(1, t('{n}번 더', { n: hold.step }), t('상한을 늘리고 이어서 해.'), 'more')}</div>
      <div class="ask-foot"><span class="grow"></span><button type="button" class="btn sm danger" disabled=${busy} onClick=${() => ctl('stop')}>${t('그만')}</button></div>
    </div>`;
  }
  if (hold.reason === 'cap') {
    return html`<div class="ask-panel mission-gate" role="group" aria-label=${t('호출 상한')}>
      <div class="ask-head"><span class="ask-who">🔢 ${t('목표의 호출 상한')}</span></div>
      <div class="ask-question">${t('호출 {used}번에 닿았어(상한 {cap}번). 더 할까?', { used: hold.used, cap: hold.cap })}</div>
      <div class="small muted">${t('다음 단계를 시작하기 전에 멈췄어. 회의 단계는 회의 호출 수(의견·차례·판정·결론)를 보고 시작해. 단계 안의 다시 시도·이어받기와 회의 중 조사는 상한을 넘을 수 있어.')}</div>
      <div class="ask-rows">${row(1, t('{n}번 더', { n: hold.step }), t('상한을 늘리고 이어서 해.'), 'more')}</div>
      <div class="ask-foot"><span class="grow"></span><button type="button" class="btn sm danger" disabled=${busy} onClick=${() => ctl('stop')}>${t('그만')}</button></div>
    </div>`;
  }
  // 막힘(oc-blocked)과 일 카드의 되풀이 상한(결정 0018)
  if (hold.kind === 'blocked' || hold.kind === 'limit') {
    const blocked = hold.kind === 'blocked';
    const q = blocked ? t('기준을 지킬 수 없다는 답이 왔어. 기준 판정으로 넘기지 않고 멈췄어. 어떻게 할까?')
      : t('카드 {ids}를 시작한 횟수가 상한에 닿았어. 어떻게 할까?', { ids: (hold.cards || []).map((c) => c.id).join(', ') });
    return html`<div class="ask-panel mission-gate" role="group" aria-label=${blocked ? t('막힘') : t('카드 되풀이 상한')}>
      <div class="ask-head"><span class="ask-who">${blocked ? `⛔ ${t('막힘')}` : `🔁 ${t('카드 되풀이 상한')}`}</span></div>
      <div class="ask-question">${q}</div>
      ${blocked ? html`<ul class="small">${(hold.blocked || []).map((b) => html`<li><b>${b.card ? `${b.card} · ${b.name}` : b.name}</b>: ${b.reason} <span class="muted">· ${t('에이전트가 씀 · 사용자 확인 안 함')}</span></li>`)}</ul>`
        : html`<ul class="small">${(hold.cards || []).map((c) => html`<li><b>${c.id}</b> · ${c.title} <span class="muted">(${t('{n}번 시작함 · 상한 {cap}번', { n: c.starts, cap: c.cap })})</span></li>`)}</ul>`}
      <div class="ask-rows">
        ${row(1, t('받아들이기'), blocked ? t('막힌 일만 빼고 나머지 결과로 기준 판정까지 가(막힌 카드는 구멍으로 적어).') : t('그 카드는 다시 돌리지 않고 지금 결과로 이어 가.'), 'accept')}
        ${row(2, t('한 번 더'), blocked ? t('막힌 일만 한 번 더 해.') : t('그 카드를 한 번 더 시작해.'), 'more')}
      </div>
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
    ${hold.keepBroken?.length > 0 && html`<div class="warnbox" role="note"><b>${t('지키기로 한 것을 어김')}</b><ul class="small">${hold.keepBroken.map((x) => html`<li>${x}</li>`)}</ul><span class="small muted">${t('에이전트가 씀 · 사용자 확인 안 함')}</span></div>`}
    ${hold.noFixer && hold.more !== false && html`<div class="small muted" role="note">${t('마지막 카드 단계에 조사·확인 카드만 있어서, "한 번 더"를 골라도 고치는(만들기·글) 카드는 돌지 않아.')}</div>`}
    ${hold.extras?.length > 0 && html`<div class="notice"><b>${t('남은 일')}</b> <span class="small muted">${t('기준 밖에서 본 문제야. 막지 않아.')}</span><ul class="small">${hold.extras.map((x) => html`<li>${x}</li>`)}</ul></div>`}
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

// 진행 기록의 일 카드 목록(결정 0018): 상태 칩과 담당. 기다리는 카드는 "하는 중"으로 세지 않고 무엇을 기다리는지 보여 준다
function CardList({ m }) {
  const cards = m.cards || [];
  const n = (st) => cards.filter((c) => c.status === st).length;
  const sum = [['running', t('하는 중')], ['waiting', t('기다림')], ['done', t('끝')], ['blocked', t('막힘')], ['hole', t('구멍')], ['skipped', t('건너뜀')]].filter(([st]) => n(st)).map(([st, w]) => `${w} ${n(st)}`).join(' · ');
  return html`<div style="margin-top:8px" role="list" aria-label=${t('일 카드')}>
    <div class="small muted"><b>${t('일 카드')}</b> · ${sum}</div>
    ${cards.map((c) => {
      const [label, cls] = cardChip(c.status);
      return html`<div class="crit" role="listitem">
        <div class="crit-head"><span class=${`chip${cls}`}>${label}</span><span><b>${c.id}</b> · ${c.title} <span class="muted">— ${agentById(c.ownerId)?.name || c.ownerId}</span></span></div>
        ${c.status === 'waiting' && html`<div class="small muted crit-ev">${waitWords(c, cards)}</div>`}
        ${c.status === 'blocked' && c.reason && html`<div class="small muted crit-ev">${c.reason}</div>`}
        ${c.status === 'hole' && c.by === 'blocked' && html`<div class="small muted crit-ev">${t('막혀서 뺐어: {reason}', { reason: c.reason || '' })}</div>`}
        ${c.msgId && html`<button type="button" class="btn ghost sm" onClick=${() => jump(c.msgId)}>${t('그 메시지로 가기')}</button>`}
      </div>`;
    })}
  </div>`;
}

// ── 오른쪽 패널의 진행 기록 탭 ──
export function MissionLog({ s }) {
  const m = s.mission;
  if (!m) return html`<div class="muted small">${t('아직 목표가 없어. 입력창 옆의 "목표까지"를 켜고 요청을 보내면 여기에 과정이 한 줄씩 쌓여.')}</div>`;
  const [label, cls] = missionChip(m.status);
  const time = (at) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).slice(-8);
  const L = (m.log || []).slice().reverse();
  const left = (m.criteria || []).filter((c) => c.status !== 'pass').length;
  // 실패 줄의 종류(결정 0015·0022): 코드가 아는 사실로 붙인 종류. 넘겨받음은 기다린 앞 카드에 결과가 없었다는 것, 원인 모름은 보통 오류
  const FAIL = { review: t('검수에서 걸림'), outside: t('바깥 장애'), blocked: t('막힘'), hole: t('구멍'), keep: t('지킬 것 어김'), input: t('넘겨받음'), unknown: t('원인 모름') };
  // 막힘 줄에 에이전트가 블록에 적은 종류(결정 0022). 코드가 정한 종류가 아니라서 "에이전트가 적음"을 같이 보인다. 안 적었거나 모르는 값이면 칩 없음
  const TOLD = { unclear: t('지시가 모호함'), input: t('넘겨받은 것이 틀림'), capability: t('권한·도구가 없음'), dependency: t('다른 일이 먼저') };
  const text = (x) => html`<span>${x.text}${x.fail && FAIL[x.fail] ? html` <span class="chip warn">${FAIL[x.fail]}</span>` : ''}${x.agentKind && TOLD[x.agentKind] ? html` <span class="chip" title=${t('에이전트가 막힘 블록에 적은 종류야(사용자 확인 안 함).')}>${TOLD[x.agentKind]} · ${t('에이전트가 적음')}</span>` : ''}</span>`;
  return html`<div>
    <div class="card"><h4>🎯 ${t('목표')} <span class=${`chip${cls}`}>${label}</span></h4>
      <div>${m.goal || html`<span class="muted">${t('(아직 없음)')}</span>`}</div>
      <div class="small muted" style="margin-top:4px">${m.confirmedAt ? `${t('사용자 확인')}${m.editedByUser ? ` · ${t('고쳐서 확인')}` : ''}` : t('에이전트가 씀 · 사용자 확인 전')}</div>
      ${m.confirmedAt > 0 && 'reviewerId' in m && html`<div class="small muted">${m.reviewerId ? t('검수: {name}이(가) 기준마다 판정해.', { name: agentById(m.reviewerId)?.name || m.reviewerId }) : t('검수할 다른 팀원이 없어서 판정 없이 끝나고 네게 물어.')}</div>`}
      ${m.confirmedAt > 0 && m.prep && html`<div class="small muted">${prepWords(m.prep)}</div>`}
      ${m.research?.questions?.length > 0 && (() => {
        const n = m.research.questions.length;
        const miss = m.research.questions.filter((q) => q.status !== 'done').length;
        const d = m.research.questions.filter((q) => Q_FINAL.includes(q.status)).length;
        // 노트가 없으면 아직 조사 중이거나(목표가 도는 중) 조사 중에 멈춘 것(중지·끊김·끝남)
        const words = m.research.noteMsgId ? t('조사 노트: 질문 {n}개 · 확인 못 함 {m}개', { n, m: miss })
          : ['active', 'waiting'].includes(m.status) ? t('조사 중: 질문 {n}개 중 {d}개 끝', { n, d }) : t('조사가 멈췄어: 질문 {n}개 중 {d}개 끝', { n, d });
        return m.research.noteMsgId ? html`<button type="button" class="btn ghost sm" style="align-self:flex-start;margin-top:4px" title=${t('그 메시지로 가기')} onClick=${() => jump(m.research.noteMsgId)}>🔎 ${words}</button>`
          : html`<div class="small muted">🔎 ${words}</div>`;
      })()}
      ${m.calls && html`<div class="stat"><span>${t('호출')}</span><span>${m.calls.used} / ${m.calls.cap}</span></div>`}
      ${m.criteria?.length > 0 && html`<div style="margin-top:8px" class="crit-table" role="list" aria-label=${t('합격 기준')}>
        ${m.criteria.map((c, i) => html`<${CritRow} c=${c} n=${i + 1} />`)}
      </div>`}
      ${m.mustKeep?.length > 0 && html`<div class="small muted" style="margin-top:6px"><b>${t('바뀌면 안 되는 것')}</b> · ${t('사용자 확인')}<ul>${m.mustKeep.map((x) => html`<li>${x}</li>`)}</ul></div>`}
      ${m.keepBroken?.length > 0 && html`<div class="warnbox" style="margin-top:6px"><b>${t('지키기로 한 것을 어김')}</b><ul class="small">${m.keepBroken.map((x) => html`<li>${x}</li>`)}</ul><span class="small muted">${t('에이전트가 씀 · 사용자 확인 안 함')}</span></div>`}
      ${m.extras?.length > 0 && html`<div class="notice" style="margin-top:6px"><b>${t('남은 일')}</b> <span class="small muted">${t('기준 밖에서 본 문제야. 막지 않아.')} · ${t('에이전트가 씀 · 사용자 확인 안 함')}</span><ul class="small">${m.extras.map((x) => html`<li>${x}</li>`)}</ul></div>`}
      ${m.cards?.length > 0 && html`<${CardList} m=${m} />`}
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
