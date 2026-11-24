// 목표 카드의 숫자(결정 0019): 호출 어림을 고른 값으로 더하기, 앱이 이미 받은 구독 한도 기록에서 보일 창 고르기.
// 화면 코드와 떨어져 있어 서버(server/mission.js 의 estimateCalls)와 테스트가 같은 함수를 부른다(서버와 화면 값이 어긋나지 않게)

// 서버가 카드에 실어 준 어림 조각(estimateParts)을 사용자가 고른 값으로 더한다. 예측이 아니라 대략치다.
// est: { spent(목표 잡기에 이미 쓴 호출), cap, research: { can, min, max }, meeting: { can, min, max }, review(기준 판정 0|1), returns(자동 되돌림 최대 횟수),
//        cards: null | { min, max, last }, stages: [{ index, min, max, review(검수 단계), drop(기준 판정으로 대신해 빠질 수 있는 단계), last(되돌림 때 드는 호출) }] }
// pick: { work: 'cards'|'stages', research, meeting, kept: 사용자가 "남기기"를 고른 팀 단계 번호 }
// 되돌림 한 번 = 마지막 일 단계(남은 단계 중 검수 단계가 아닌 마지막, 없으면 남은 마지막. 서버의 reviewPlan 과 같은 규칙) + 기준 판정.
// → { min, max, returns, cap, spent }
export function sumEstimate(est, { work = 'stages', research = false, meeting = false, kept = [] } = {}) {
  const e = est && typeof est === 'object' ? est : {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  let min = n(e.spent);
  let max = n(e.spent);
  if (research && e.research?.can) { min += n(e.research.min); max += n(e.research.max); }
  if (meeting && e.meeting?.can) { min += n(e.meeting.min); max += n(e.meeting.max); }
  let last = 0;
  if (work === 'cards' && e.cards) {
    min += n(e.cards.min);
    max += n(e.cards.max);
    last = n(e.cards.last);
  } else {
    const keep = new Set((Array.isArray(kept) ? kept : []).map(Number));
    const left = (Array.isArray(e.stages) ? e.stages : []).filter((s) => !s.drop || keep.has(Number(s.index)));
    for (const s of left) { min += n(s.min); max += n(s.max); }
    const back = left.filter((s) => !s.review).at(-1) || left.at(-1);
    last = back ? n(back.last) : 0;
  }
  const review = n(e.review);
  const returns = n(e.returns);
  min += review;
  max += review + returns * (last + review);
  return { min, max, returns, cap: n(e.cap), spent: n(e.spent) };
}

// 그 목표에서 일할 프로바이더들의 한도 기록 가운데 아직 유효한 창만(초기화 시각이 미래이거나 없고, 사용률이 숫자). 새로 읽지 않고 받은 기록만 본다.
// limits: { [provider]: { windows: { [창 이름]: { pct, resetsAt(초) } }, observedAt(ms) } }, providers: 보일 프로바이더 순서.
// → [{ provider, windows: [{ key, pct, resetsAt }], observedAt, ago(관측 뒤 지난 분, 모르면 null) }] (보일 창이 없는 프로바이더는 빠진다)
const ORDER = ['five_hour', 'seven_day'];
export function limitRows(limits, providers, now = Date.now()) {
  const out = [];
  for (const p of [...new Set(providers || [])]) {
    const l = limits?.[p];
    if (!l || typeof l !== 'object') continue;
    const windows = Object.entries(l.windows || {})
      .filter(([, w]) => w && typeof w.pct === 'number' && Number.isFinite(w.pct) && (!w.resetsAt || w.resetsAt * 1000 > now))
      .map(([key, w]) => ({ key, pct: w.pct, resetsAt: w.resetsAt || 0 }))
      .sort((a, b) => (ORDER.indexOf(a.key) < 0 ? 9 : ORDER.indexOf(a.key)) - (ORDER.indexOf(b.key) < 0 ? 9 : ORDER.indexOf(b.key)));
    if (!windows.length) continue;
    const at = Number(l.observedAt) || 0;
    out.push({ provider: p, windows, observedAt: at, ago: at ? Math.max(0, Math.floor((now - at) / 60000)) : null });
  }
  return out;
}
