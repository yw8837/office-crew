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

// 결론의 "결정" 줄: "- 결정: …", "- **결정**: …", "**Decision:** …", "1. 决定：…" (결론 프롬프트와 데모 결론이 네 언어로 쓰는 머리말)
const DECISION = /^\s*(?:[-*+•]\s+|\d+[.)]\s+)?(?:\*\*|__)?\s*(?:결정|Decision|决定|決定)\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*)$/i;
// 마크다운 표시를 뺀 한 줄 글
const plain = (s) => String(s)
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\*\*|__|~~|`/g, '')
  .replace(/^\s*#{1,6}\s+/, '')
  .replace(/^\s*(?:[-*+•]\s+|\d+[.)]\s+|>\s*)/, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * 결론 메시지 글 → 게시판 카드 글. "결정" 줄의 글, 없으면 첫 글줄(제목 줄은 다른 글이 없을 때만).
 * max 글자(그림 글자도 한 글자)를 넘으면 잘라서 "…"를 붙인다. 쓸 글이 없으면 ''
 */
export function cardText(text, max = 30) {
  const lines = String(text || '').split(/\r?\n/);
  let pick = '';
  for (const line of lines) {
    const m = line.match(DECISION);
    if (m && plain(m[1])) { pick = plain(m[1]); break; }
  }
  if (!pick) {
    let heading = '';
    for (const line of lines) {
      if (!line.trim() || /^\s*(```|~~~)/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
      const t = plain(line);
      if (!t) continue;
      if (/^\s*#{1,6}\s/.test(line)) { heading ||= t; continue; }
      pick = t;
      break;
    }
    pick ||= heading;
  }
  const chars = [...pick];
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : pick;
}

/** 게시판 카드: 메시지 목록에서 회의 결론(다 쓴 것) 최근 n개를 새것부터 [{ id, text }] */
export function boardCards(messages, n = 3) {
  const out = [];
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0 && out.length < n; i--) {
    const m = list[i];
    if (!m || m.role !== 'agent' || m.status !== 'done' || !m.meeting || m.meeting.phase !== 'conclude') continue;
    const text = cardText(m.text);
    if (text) out.push({ id: m.id, text });
  }
  return out;
}

/**
 * 말풍선에 넣을 글: 쓰는 중인 답의 끝부분 n글자. 약속한 블록(``` 뒤)과 마크다운 기호는 뺀다.
 * 앞이 잘려 블록 안쪽(JSON 조각)만 남았으면 '…'만 준다.
 */
export function sayText(text, n = 40) {
  let s = String(text || '');
  const fence = s.indexOf('```');
  if (fence >= 0) s = s.slice(0, fence);
  if (/"\s*:\s*["{[\d]|^\s*[{}]/.test(s)) return '…';
  s = s.split(/\r?\n/).map(plain).filter(Boolean).join(' ').trim();
  const chars = [...s];
  return chars.length > n ? `…${chars.slice(-n).join('')}` : s;
}
