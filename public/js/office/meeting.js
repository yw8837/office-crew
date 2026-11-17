// 회의 장면 계산(DOM 없음): 사무실 그림과 세션 화면이 같이 쓰고, node --test 로 바로 불러 시험한다

export const MEET_PHASES = ['opinion', 'turn', 'research', 'judge', 'conclude'];

/**
 * 사무실 그림에 넘길 회의 상태(office.setMeeting 의 인자). 회의 중이 아니거나 모르는 단계면 null.
 * speakerId 는 지금 모임 자리에서 말하는 한 사람: 차례는 그 사람, 판정·결론은 진행자(chairId).
 * 의견(모두가 동시에)과 조사(조사하는 사람은 조사 자리에 가 있다)는 한 사람을 고르지 않아 null.
 */
export function meetingView(now, chairId) {
  if (!now || !MEET_PHASES.includes(now.phase)) return null;
  const p = now.phase;
  const speakerId = p === 'turn' ? now.speakerId || null : p === 'judge' || p === 'conclude' ? chairId || null : null;
  return { phase: p, round: Number(now.round) || 1, rounds: Number(now.rounds) || 1, speakerId: speakerId == null ? null : String(speakerId), opposerId: now.opposerId ? String(now.opposerId) : null };
}

/** 이 사람이 지금 말하는지(말풍선·끄덕임): 의견은 참석자 모두, 그 밖은 meetingView 의 speakerId 한 사람 */
export function isTalking(view, id, participant) {
  if (!view || !participant) return false;
  if (view.phase === 'opinion') return true;
  return view.phase !== 'research' && !!view.speakerId && view.speakerId === String(id);
}

/** 회의 중 조사하러 간 사람(run.stages[i].meetingNow 의 조사 단계 speakerId). 조사 중이 아니면 null */
export function researcherOf(now) {
  return now && now.phase === 'research' && now.speakerId ? String(now.speakerId) : null;
}
