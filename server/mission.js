// 목표 모드(결정 0014): 세션에 살아 있는 목표 하나(session.mission)와 그걸 다루는 순수 함수들.
// - 진행자가 쓴 목표 카드 초안(답 맨 끝의 ```oc-goal 블록)을 읽고 다듬는다(질문 블록 oc-ask 와 같은 규칙: 글 맨 끝의 블록만)
// - 사용자가 본 카드와 저장된 초안을 글자까지 대조한다(확인한 값만 지시가 된다)
// - 진행자 고르기, 내 PC 모델 섞임 검사, 진행 기록 한 줄, 앱이 꺼졌을 때 끊김 표시
// notes.js 는 store.js 를 부르고 store.js 는 이 파일을 부른다(돌아오는 import). 이 파일은 맨 위에서 notes.js 의 함수를 부르지 않는다
import { randomBytes } from 'node:crypto';
import { tr } from './i18n.js';
import { roleKind } from './routing.js';
import { strip, suspiciousKind } from './notes.js';

export const GOAL_MAX = 200; // 목표 한 줄 최대 글자
export const CRIT_MAX = 300; // 합격 기준 하나 최대 글자
export const CRIT_COUNT = 7; // 합격 기준 최대 개수
export const LIST_COUNT = 5; // 범위 밖·사용자가 정할 것 최대 개수
export const ITEM_MAX = 200; // 범위 밖·사용자가 정할 것 하나 최대 글자
export const REQUEST_MAX = 2000; // 목표에 적어 두는 요청 글 최대 글자
export const LOG_MAX = 200; // 진행 기록 최대 줄 수(넘으면 앞을 버리고 "앞 n줄 생략" 한 줄)
export const NOTE_COUNT = 50; // 목표 하나에 받는 추가 지시 최대 개수(넘으면 400)
// 살아 있는 목표: 이 동안은 새 목표를 만들지 못하고, 목표 모드를 끄거나 팀을 바꾸지 못한다
const ALIVE = new Set(['drafting', 'draft', 'active', 'waiting', 'cut']);
const OPEN = '```oc-goal';
const LAST = /^```oc-goal[ \t]*\r?\n([\s\S]*?)```\s*$/; // 글의 맨 끝에 있는 블록만 목표 카드다

export const alive = (m) => !!m && typeof m === 'object' && ALIVE.has(m.status);

// 한 줄로 펴고(줄바꿈·제어 문자 → 공백) 보이지 않는 글자를 빼고 max 글자(코드 포인트)까지
const pick = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : v && typeof v.text === 'string' ? v.text : '');
// eslint-disable-next-line no-control-regex
const one = (v, max) => [...strip(pick(v)).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
// 목록: 배열(글 하나가 한 항목) 또는 줄 단위 글. 빈 항목은 빼고 max 개까지
const list = (v, count, max) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n/) : []).map((x) => one(x, max)).filter(Boolean).slice(0, count);

// 목표 카드 값 다듬기(진행자가 쓴 초안과 사용자가 고친 값 모두): 목표 200자, 기준 하나 300자·7개까지, 나머지 목록 5개·200자
export function cleanGoal(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    goal: one(r.goal, GOAL_MAX),
    criteria: list(r.criteria, CRIT_COUNT, CRIT_MAX),
    outOfScope: list(r.outOfScope, LIST_COUNT, ITEM_MAX),
    userDecides: list(r.userDecides, LIST_COUNT, ITEM_MAX),
  };
}

// text 의 맨 끝에 있는 oc-goal 블록을 읽는다. 없으면 null(끝이 아닌 곳의 블록도), JSON 이 아니면 { error: 'json' },
// 목표가 비었거나 기준이 하나도 없으면 { error: 'shape' }, 맞으면 { card(다듬은 값), raw(받은 그대로), from, to }(블록의 자리)
export function parseGoal(text) {
  const src = String(text || '');
  const from = src.lastIndexOf(OPEN);
  if (from < 0) return null;
  const m = src.slice(from).match(LAST);
  if (!m) return null;
  const to = from + m[0].trimEnd().length;
  let data;
  try { data = JSON.parse(m[1]); } catch { return { error: 'json', from, to }; }
  const card = cleanGoal(data);
  if (!card.goal || !card.criteria.length) return { error: 'shape', from, to };
  return { card, raw: data, from, to };
}

// 프롬프트에 넣는 블록 예시(설명 글은 설정 언어로)
export const goalBlock = () => `\`\`\`oc-goal\n${JSON.stringify({ goal: tr('목표 한 줄'), criteria: [tr('끝난 뒤 확인할 수 있는 문장'), tr('끝난 뒤 확인할 수 있는 문장')], outOfScope: [tr('이번에 하지 않을 것')], userDecides: [tr('사용자만 정할 수 있는 것')] })}\n\`\`\``;

// 진행자가 쓴 초안에 흔한 주입 무늬(결정 0013 의 검사)가 있으면 카드에 띄울 이유, 없으면 ''. 막지는 않는다(사용자가 읽고 정한다)
const WARN = {
  invisible: () => tr('보이지 않는 글자가 있었어(카드에서는 뺐어).'),
  control: () => tr('제어 문자가 있었어(카드에서는 뺐어).'),
  ignore: () => tr('지시를 무시하라는 문장이 있어.'),
  system: () => tr('시스템 지시를 흉내 내는 문장이 있어.'),
  permission: () => tr('권한을 넓히라는 문장이 있어.'),
  secret: () => tr('비밀·키·토큰을 보내라는 문장이 있어.'),
};
export function goalWarn(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const all = [r.goal, ...[r.criteria, r.outOfScope, r.userDecides].flatMap((v) => (Array.isArray(v) ? v : [v]))].map(pick);
  const c = cleanGoal(r);
  const kind = suspiciousKind(all.join('\n')) || suspiciousKind([c.goal, ...c.criteria, ...c.outOfScope, ...c.userDecides].join('\n'));
  return kind ? WARN[kind]() : '';
}

// 새 목표(목표 차례를 시작할 때). 2a-1 에는 검수·호출 상한·이어서가 없어서 그 칸은 아직 없다
export function newMission({ request = '', requestMsgId = null, leadId = null } = {}, now = Date.now()) {
  return {
    version: 1, id: `ms-${randomBytes(4).toString('hex')}`, status: 'drafting', phase: 'goal',
    request: [...String(request || '')].slice(0, REQUEST_MAX).join(''), requestMsgId, leadId,
    goal: '', criteria: [], outOfScope: [], userDecides: [], notes: [],
    cardMsgId: null, confirmedAt: 0, editedByUser: false, log: [], createdAt: now,
  };
}

// 기준 문장 목록 → 저장 모양(c1, c2 …). 판정은 아직 없어서 모두 open
export const toCriteria = (texts) => texts.map((text, i) => ({ id: `c${i + 1}`, text, status: 'open', evidence: '' }));

// 목표에 저장된 카드 값(sameCard 로 대조하는 모양)
export const cardOf = (m) => ({ goal: m?.goal || '', criteria: (m?.criteria || []).map((c) => c.text), outOfScope: [...(m?.outOfScope || [])], userDecides: [...(m?.userDecides || [])] });

// 화면이 보던 카드(expected)와 저장된 초안(draft, cardOf 모양)이 글자까지 같은가: 목표·기준·범위 밖·사용자가 정할 것 전부
export function sameCard(expected, draft) {
  if (!expected || typeof expected !== 'object' || !draft) return false;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  return expected.goal === draft.goal && same(expected.criteria, draft.criteria) && same(expected.outOfScope, draft.outOfScope) && same(expected.userDecides, draft.userDecides);
}

// 팀의 단계(지워진 에이전트는 빼고). agents: 에이전트 목록
const teamStages = (team, agents) => {
  const byId = new Map((agents || []).map((a) => [String(a.id), a]));
  return (team?.stages || []).map((st) => ({ ...st, agentIds: [...new Set((st.agentIds || []).map(String))].filter((id) => byId.has(id)) }))
    .filter((st) => st.agentIds.length).map((st) => ({ ...st, agents: st.agentIds.map((id) => byId.get(id)) }));
};

// 진행자: 팀의 첫 회의 단계의 진행자 → 역할 종류가 analysis 인 첫 팀원(단계 순서, 단계 안은 적힌 순서) → 팀 첫 단계의 첫 에이전트. 없으면 null
export function pickLead(team, agents) {
  const stages = teamStages(team, agents);
  for (const st of stages) {
    if (st.meeting && st.agentIds.length >= 2) return st.agentIds.includes(String(st.meeting.chairId)) ? String(st.meeting.chairId) : st.agentIds[0];
  }
  for (const st of stages) for (const a of st.agents) if (roleKind(a.role) === 'analysis') return String(a.id);
  return stages[0]?.agentIds[0] || null;
}

// 내 PC 모델과 클라우드 AI 가 섞인 팀인가(결정 0007 을 지키려고 목표 모드에서 막는다).
// 자동 라우팅 에이전트는 어느 쪽으로도 갈 수 있으니, 내 PC 모델 에이전트와 같이 있으면 섞인 것으로 본다
export function mixedLocal(team, agents) {
  const all = teamStages(team, agents).flatMap((st) => st.agents);
  const local = all.some((a) => a.routing !== 'auto' && a.provider === 'local');
  const other = all.some((a) => a.routing === 'auto' || a.provider !== 'local');
  return local && other;
}

// 진행 기록 한 줄. LOG_MAX 줄을 넘으면 앞을 버리고 맨 앞에 "앞 n줄 생략" 한 줄을 둔다
export function logLine(m, kind, text, msgId = null, now = Date.now()) {
  const line = { at: now, kind, text: [...String(text || '')].slice(0, 300).join(''), ...(msgId ? { msgId } : {}) };
  (m.log ||= []).push(line);
  if (m.log.length > LOG_MAX) {
    const head = m.log[0]?.kind === 'skip' ? m.log.shift() : null;
    const drop = m.log.length - (LOG_MAX - 1);
    const gone = m.log.splice(0, drop);
    const n = (head?.n || 0) + gone.length;
    m.log.unshift({ at: gone.at(-1)?.at || now, kind: 'skip', n, text: tr('앞 {n}줄 생략', { n }) });
  }
  return line;
}

// 앱이 꺼졌다 켜졌을 때(세션을 디스크에서 읽을 때 store.js #fixStale 이 부른다). 저절로 다시 시작하지 않는다.
// 목표 차례 중(drafting)이면 초안이 없으니 그 목표는 닫고(cancelled) 알림 표시를 단다. 도는 중(active·waiting)이면 끊김(cut). 카드 대기(draft)는 그대로.
// cutNotice: 다시 켤 때 오케스트레이터가 대화에 알림 한 줄을 남기고 지운다. 바꿨으면 true
export function cutMission(s, now = Date.now()) {
  const m = s?.mission;
  if (!m || typeof m !== 'object') return false;
  if (m.status === 'drafting') {
    m.status = 'cancelled';
    m.cutNotice = 'drafting';
    logLine(m, 'cut', tr('목표 초안을 쓰는 중에 앱이 꺼져서 이 목표는 닫았어.'), null, now);
    return true;
  }
  if (m.status === 'active' || m.status === 'waiting') {
    m.status = 'cut';
    m.cutNotice = 'cut';
    logLine(m, 'cut', tr('앱이 꺼져서 목표가 끊겼어. 저절로 다시 시작하지 않아.'), null, now);
    return true;
  }
  return false;
}
