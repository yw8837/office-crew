// 사용량 숫자(결정 0026): 화면과 서버가 같은 함수로 센다(서버의 회의 사용량 상한 meetingSpend 도 이 weighted 를 부른다).
// DOM 이 없는 순수 함수라 테스트와 서버(server/orchestrator.js)가 그대로 부른다(public/js/mission-numbers.js 와 같은 방식)

export const CACHE_READ_SHARE = 10; // 캐시에서 다시 읽은 글은 10분의 1로 센다

// 환산: 새로 읽은 글(입력 + 캐시에 새로 쓴 것)과 쓴 글(출력)은 그대로, 캐시에서 다시 읽은 글은 10분의 1.
// Claude 는 새로 읽은 글 대부분이 '캐시 쓰기'로 잡히고, Codex 는 이어 가는 대화 전체가 입력·캐시 읽기로 잡힌다. 둘을 같은 저울에 올리려는 값이고 요금표와 똑같지는 않다
export function weighted(u) {
  if (!u) return 0;
  return (u.input || 0) + (u.cacheWrite || 0) + (u.output || 0) + Math.round((u.cacheRead || 0) / CACHE_READ_SHARE);
}

// 네 값을 1:1 로 더한 합(예전 화면 합계). 캐시 읽기가 대부분인 실행은 이 값이 실제 부담보다 커 보인다
export const rawSum = (u = {}) => (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);

// 나눠 보기: 새 입력·캐시 쓰기·캐시 읽기·출력, 환산, 1:1 합
export function split(u = {}) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const out = { input: n(u.input), cacheWrite: n(u.cacheWrite), cacheRead: n(u.cacheRead), output: n(u.output) };
  return { ...out, weighted: weighted(out), raw: rawSum(out) };
}

// 캐시 적중률: 캐시 읽기 / (입력 + 캐시 읽기 + 캐시 쓰기). 캐시 숫자(읽기·쓰기)를 하나도 받지 못했으면 null(그 AI 가 캐시 숫자를 주지 않거나 아직 기록이 없다)
export function cacheHit(u = {}) {
  const r = u.cacheRead || 0;
  const w = u.cacheWrite || 0;
  if (!r && !w) return null;
  const all = (u.input || 0) + r + w;
  return all > 0 ? r / all : null;
}

const blank = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, n: 0 });
const add = (a, u) => {
  for (const k of ['input', 'cacheWrite', 'cacheRead', 'output', 'cost']) a[k] += Number.isFinite(u?.[k]) ? u[k] : 0;
  a.n += 1;
  return a;
};

// 답 하나가 어디에 쓴 것인지(메시지에 코드가 단 표시로만). 완주 보고(server/report.js, 결정 0025)와 세션의 "어디에 썼는지"(결정 0026)가 같이 쓰는 하나의 함수:
// 목표 잡기 · 기준 판정(검수) · 계획 · 조사(훑어보기·조사 질문·조사, 회의 중 조사) · 팀 초안(결정 0024) · 회의(회의 차례 전부와 준비 회의) · 일 카드(끝 두 칸 다시 쓰기 포함) ·
// 인수인계 메모 · 일 단계(목표의 일 실행 답: 단계표의 단계와 되돌림) · 보통 실행(그 밖).
// goal: 부르는 쪽이 목표 실행의 답이라는 걸 이미 안다(완주 보고는 그 목표의 실행 기록으로 고른 답만 넘긴다). 목표 표시(missionId)가 없던 옛 답도 일 단계로 센다
// 교차 검수(결정 0032)의 둘째 검수자(레드팀) 답은 검수와 따로 cross
export const ANSWER_KINDS = ['normal', 'goal', 'research', 'meeting', 'plan', 'work', 'cards', 'review', 'cross', 'team', 'handoff', 'fork', 'lead'];
export function answerKind(m, { goal = false } = {}) {
  if (m?.goalDraft) return 'goal';
  if (m?.review) return m.review.role === 'red' ? 'cross' : 'review';
  const pk = m?.prep?.kind;
  if (pk === 'plan') return 'plan';
  if (pk === 'fork') return 'fork'; // 두 갈래의 한 장 요약(결정 0031)
  if (pk === 'lead') return 'lead'; // 카드 질문에 진행자가 한 답(결정 0031)
  if (pk === 'scan' || pk === 'questions' || pk === 'research' || m?.meeting?.phase === 'research') return 'research';
  if (pk === 'team') return 'team';
  if (m?.meeting || pk === 'meeting' || pk === 'meet') return 'meeting'; // 작은 회의(결정 0031)도 회의
  if (m?.card) return 'cards';
  if (m?.handoff) return 'handoff';
  return goal || m?.missionId ? 'work' : 'normal';
}

// 한 세션의 사용량을 종류별·에이전트별로(새로 저장하지 않고 메시지마다 있는 usage 로).
// missionId 를 주면 그 목표의 답만(답에 단 목표 표시로. 실행 기록이 30개로 잘려도 빠지지 않는다. 표시가 없던 옛 답은 runIds 에 든 실행의 답이면).
// goalRuns: 목표 표시가 없던 옛 답을 목표 실행의 답(일 단계)으로 알아볼 실행 id. 작성 중인 답의 추정 출력(estOutput)은 세지 않는다(실제 값이 온 것만)
// → { total, kinds: { [종류]: 합 }, agents: [[에이전트 id, 합]](환산이 큰 순) }. 합 = { input, cacheWrite, cacheRead, output, cost, n(답 수) }
export function usageBreakdown(messages, { missionId = null, runIds = null, goalRuns = null } = {}) {
  const runs = goalRuns ? new Set(goalRuns) : null;
  const mine = runIds ? new Set(runIds) : null;
  const total = blank();
  const kinds = {};
  const agents = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== 'agent' || !m.usage) continue;
    const mark = m.missionId || m.card?.missionId;
    if (missionId && (mark ? mark !== missionId : !mine?.has(m.runId))) continue;
    if (!rawSum(m.usage) && !m.usage.cost) continue;
    add(total, m.usage);
    add((kinds[answerKind(m, { goal: !!runs?.has(m.runId) })] ||= blank()), m.usage);
    const id = String(m.agentId || '');
    if (!agents.has(id)) agents.set(id, blank());
    add(agents.get(id), m.usage);
  }
  return { total, kinds, agents: [...agents].sort((a, b) => weighted(b[1]) - weighted(a[1])) };
}

// 초기화 시각을 모르는 창의 기록을 믿는 시간: 받은 뒤 30분(server/failover.js 의 avoidUntil 이 다 찬 창을 피하는 시간과 같다). 그보다 오래된 기록은 넘음으로 보지 않는다
export const UNTIMED_MS = 30 * 60 * 1000;

// 한도 창 하나가 이미 지난 기록인지(화면용. 판단 쪽 overCap·failover 와 같은 기준): 초기화 시각이 지났거나, 초기화 시각을 모르면 받은 뒤 UNTIMED_MS 가 넘었다.
// 사용률이 숫자가 아니면 보일 값이 없어 지났다고 하지 않는다(그대로 "?"). 받은 시각(observedAt)을 모르면 지났다고 하지 않는다
export function windowPassed(w, observedAt, now = Date.now()) {
  if (!w || typeof w.pct !== 'number' || !Number.isFinite(w.pct)) return false;
  if (w.resetsAt) return w.resetsAt * 1000 <= now;
  return Number.isFinite(observedAt) && observedAt + UNTIMED_MS <= now;
}

// 한 AI 의 한도 기록에서 안 지난 창 가운데 가장 찬 사용률(오른쪽 아래 표시). 안 지난 창이 없으면 null
export function livePeak(limit, now = Date.now()) {
  const pcts = Object.values(limit?.windows || {})
    .filter((w) => w && typeof w.pct === 'number' && Number.isFinite(w.pct) && !windowPassed(w, limit.observedAt, now))
    .map((w) => w.pct);
  return pcts.length ? Math.max(...pcts) : null;
}

// 구독 한도 % 상한(결정 0026): 한도 기록 하나에서 사용률이 상한(cap, %) 이상인 창. 사용률이 숫자이고 아직 안 풀린 창만 본다(초기화 시각이 지났으면 풀린 것,
// 초기화 시각을 모르는 창은 기록을 받은 뒤 UNTIMED_MS 까지만). 사용자가 "지금 다시 쓰기"로 푼 뒤의 옛 기록은 보지 않는다. cap 이 0 이하면 끔.
// → null(넘은 창 없음) | { windows: [{ key, pct, resetsAt(초) }], until(넘은 창이 모두 풀리는 시각 ms. 초기화 시각을 모르는 창이 하나라도 있으면 0) }
export function overCap(limit, cap, now = Date.now()) {
  const c = Number(cap);
  if (!limit?.windows || !(c > 0)) return null;
  if (limit.releasedAt && limit.releasedAt >= (limit.observedAt || 0)) return null;
  const fresh = (limit.observedAt ?? now) + UNTIMED_MS > now;
  const windows = Object.entries(limit.windows)
    .filter(([, w]) => w && typeof w.pct === 'number' && Number.isFinite(w.pct) && w.pct >= c && (w.resetsAt ? w.resetsAt * 1000 > now : fresh))
    .map(([key, w]) => ({ key, pct: w.pct, resetsAt: w.resetsAt || 0 }));
  if (!windows.length) return null;
  const until = windows.every((w) => w.resetsAt) ? Math.max(...windows.map((w) => w.resetsAt * 1000)) : 0;
  return { windows, until };
}
