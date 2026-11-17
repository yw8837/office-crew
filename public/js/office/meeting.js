// 회의 장면 계산(DOM 없음): 사무실 그림과 세션 화면이 같이 쓰고, node --test 로 바로 불러 시험한다

/** 회의 중 조사하러 간 사람(run.stages[i].meetingNow 의 조사 단계 speakerId). 조사 중이 아니면 null */
export function researcherOf(now) {
  return now && now.phase === 'research' && now.speakerId ? String(now.speakerId) : null;
}
