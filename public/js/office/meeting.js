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

// 결론의 머리말 줄: "- 결정: …", "- **결정**: …", "**Decision:** …", "1. 决定：…" (결론 프롬프트와 데모 결론이 네 언어로 쓰는 머리말).
// 결론 프롬프트가 부탁하는 다섯 칸(결정·근거·남은 이견·버린 안·다음 할 일)을 같은 꼴로 읽는다(결정 0025. 게시판 카드는 "결정" 줄만 쓴다)
const HEADS = {
  decision: ['결정', 'Decision', '决定', '決定'],
  reasons: ['근거', 'Why', 'Reasons?', '依据', '根拠'],
  dissent: ['남은 이견', 'Remaining disagreements?', '剩余分歧', '残った異論'],
  dropped: ['버린 안', 'Dropped options?', '放弃的方案', '捨てた案'],
  next: ['다음 할 일', 'Next steps?', '接下来要做的事', '次にやること'],
};
const headRe = (words) => new RegExp(`^\\s*(?:[-*+•]\\s+|\\d+[.)]\\s+)?(?:\\*\\*|__)?\\s*(?:${words.join('|')})\\s*(?:\\*\\*|__)?\\s*[:：]\\s*(?:\\*\\*|__)?\\s*(.*)$`, 'i');
const HEAD_RE = Object.fromEntries(Object.entries(HEADS).map(([k, words]) => [k, headRe(words)]));
const DECISION = HEAD_RE.decision;
// 이 줄이 어느 칸의 머리말인가 → [칸, 같은 줄의 값] 또는 null
const headOf = (line) => { for (const [k, re] of Object.entries(HEAD_RE)) { const m = line.match(re); if (m) return [k, m[1]]; } return null; };
// "없음"(네 언어): 그 칸은 빈 목록
const NONE = /^(?:없음|없어|없다|none|nothing|n\/a|-|—|なし|無し|ない|无|無|没有)[.。]?$/i;
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

/**
 * 회의 결론 글 → 다섯 칸 { decision, reasons[], dissent[], dropped[], next[] }(결정 0025). 머리말 줄의 값과, 그 아래 들여 쓴 줄(목록이면 항목마다).
 * 들여 쓰지 않은 다른 줄이나 다음 머리말에서 끝난다. "없음"은 빈 목록. 머리말을 못 찾은 칸은 비운다(지어내지 않는다).
 * 마크다운 표시는 빼고 글만(한 줄로 펴고 자르는 건 부르는 쪽이 한다)
 */
export function conclusionParts(text) {
  const out = { decision: '', reasons: [], dissent: [], dropped: [], next: [] };
  const got = {};
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const h = headOf(line);
    if (h) {
      cur = got[h[0]] ? null : (got[h[0]] = { first: plain(h[1]), items: [] }); // 같은 칸이 두 번이면 첫 번째만
      continue;
    }
    if (!cur) continue;
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { cur = null; continue; } // 들여 쓰지 않은 줄에서 그 칸이 끝난다
    const item = /^\s*(?:[-*+•]\s+|\d+[.)]\s+)/.test(line);
    const t = plain(line);
    if (!t) continue;
    if (item || !cur.items.length) cur.items.push(t); else cur.items[cur.items.length - 1] += ` ${t}`;
  }
  const vals = (k) => (got[k] ? [got[k].first, ...got[k].items].filter((x) => x && !NONE.test(x)) : []);
  out.decision = vals('decision').join(' ');
  for (const k of ['reasons', 'dissent', 'dropped', 'next']) out[k] = vals(k);
  return out;
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
