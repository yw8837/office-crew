// 채팅 화면이 쓰는 작은 계산들(화면 코드와 떨어져 있어 테스트에서 바로 부를 수 있다)

// 번호·글머리 목록을 쓰다가 줄을 바꾸면 다음 번호를 이어 준다. 빈 항목에서 줄을 바꾸면 목록을 끝낸다.
// start·end: 커서(선택 영역)의 시작과 끝. 돌려주는 값: { text, caret, insert | remove } 또는 null(목록이 아니면 평소처럼 줄만 바꾼다)
// insert: 커서 자리에 넣을 글. remove: 지울 범위 [시작, 끝](빈 항목에서 목록을 끝낼 때)
export function continueList(text, start, end = start) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const line = text.slice(lineStart, start);
  const m = line.match(/^(\s*)(?:(\d{1,3})([.)])|([-*•]))\s+(.*)$/);
  if (!m) return null;
  const [, indent, num, sep, bullet, rest] = m;
  if (!rest.trim()) { // 빈 항목: 표시를 지우고 목록을 끝낸다
    const lineEnd = text.indexOf('\n', end);
    if (text.slice(end, lineEnd < 0 ? undefined : lineEnd).trim()) return null; // 커서 뒤에 글이 있으면 평소처럼 줄만 바꾼다
    return { text: text.slice(0, lineStart) + text.slice(end), caret: lineStart, remove: [lineStart, end] };
  }
  const mark = num ? `${Number(num) + 1}${sep} ` : `${bullet} `;
  const ins = `\n${indent}${mark}`;
  return { text: text.slice(0, start) + ins + text.slice(end), caret: start + ins.length, insert: ins };
}

// 대화에서 찾기: 화면에 그리지 않은 앞 메시지까지 포함해, 그 말이 든 메시지의 id 를 대화 순서대로 돌려준다(대소문자 무시)
export function findInMessages(messages, q) {
  const k = String(q || '').trim().toLowerCase();
  if (!k) return [];
  return messages.filter((m) => (m.role === 'user' || m.role === 'agent') && !m.handoffAsk && (m.text || '').toLowerCase().includes(k)).map((m) => m.id);
}

// 에이전트가 사용자에게 묻는 블록(oc-ask)은 선택 카드로 보여 주니 본문에서는 뺀다.
// asks: 서버가 질문으로 받은 블록들({ from, to } = 글에서의 자리). 그 자리만 뺀다.
// 쓰는 중이면 마지막으로 받은 블록 뒤에 나오는 블록(아직 서버가 읽기 전이거나 쓰다 만 것)도 감춘다.
// 다 쓴 뒤에 서버가 받지 않은 블록(형식이 틀렸거나, 횟수를 넘었거나, 예로 든 것)은 그대로 보여서 사용자가 글로 읽을 수 있다
export function hideAsks(text, asks = [], streaming = false) {
  const src = String(text || '');
  const spans = (asks || []).filter((a) => Number.isInteger(a.from) && Number.isInteger(a.to) && a.from >= 0 && a.to > a.from && a.to <= src.length).sort((a, b) => a.from - b.from);
  let out = '';
  let at = 0;
  for (const a of spans) {
    if (a.from < at) continue;
    out += src.slice(at, a.from);
    at = a.to;
  }
  const tail = src.slice(at);
  return out + (streaming ? tail.replace(/```oc-ask[\s\S]*$/, '') : tail);
}

// 회의 차례 답 끝의 질문 블록(oc-check)은 글 아래 "확인 필요" 줄로 보여 주니 본문에서는 뺀다(hideAsks 와 같은 방식).
// check: 서버가 질문으로 받은 블록({ from, to } = 글에서의 자리). 그 자리에서 글이 정말 ```oc-check 로 시작할 때만 감춘다(아니면 글을 그대로 둔다).
// 쓰는 중이면 끝에 오는 블록(아직 서버가 읽기 전이거나 쓰다 만 것)도 감춘다. 다 쓴 뒤에 서버가 받지 않은 블록(형식이 틀린 것)은 그대로 보인다
export function hideCheck(text, check = null, streaming = false) {
  const src = String(text || '');
  const ok = check && Number.isInteger(check.from) && Number.isInteger(check.to) && check.from >= 0 && check.to > check.from && check.to <= src.length
    && src.startsWith('```oc-check', check.from);
  const out = ok ? src.slice(0, check.from) + src.slice(check.to) : src;
  return streaming ? out.replace(/```oc-check[\s\S]*$/, '') : out;
}

// 진행자 답 끝의 목표 카드 블록(oc-goal)은 목표 카드로 보여 주니 본문에서는 뺀다(hideCheck 와 같은 방식, 결정 0014).
// goal: 서버가 카드로 받은 블록의 자리({ from, to }). 블록은 답의 맨 끝이라 질문 블록 자리보다 뒤에 있다: 질문 블록을 빼기 전에 먼저 부른다
export function hideGoal(text, goal = null, streaming = false) {
  const src = String(text || '');
  const ok = goal && Number.isInteger(goal.from) && Number.isInteger(goal.to) && goal.from >= 0 && goal.to > goal.from && goal.to <= src.length
    && src.startsWith('```oc-goal', goal.from);
  const out = ok ? src.slice(0, goal.from) + src.slice(goal.to) : src;
  return streaming ? out.replace(/```oc-goal[\s\S]*$/, '') : out;
}

// 진행자 답 끝의 조사 질문 블록(oc-research)은 질문 목록으로 보여 주니 본문에서는 뺀다(hideGoal 과 같은 방식, 결정 0017).
// block: 서버가 질문으로 받은 블록의 자리({ from, to }). 받지 않은 블록(형식이 깨진 것)은 그대로 보인다. 쓰는 중이면 끝의 블록도 감춘다
export function hideResearch(text, block = null, streaming = false) {
  const src = String(text || '');
  const ok = block && Number.isInteger(block.from) && Number.isInteger(block.to) && block.from >= 0 && block.to > block.from && block.to <= src.length
    && src.startsWith('```oc-research', block.from);
  const out = ok ? src.slice(0, block.from) + src.slice(block.to) : src;
  return streaming ? out.replace(/```oc-research[\s\S]*$/, '') : out;
}

// 진행자 답 끝의 계획 블록(oc-plan)은 계획 카드로, 일 단계 답 끝의 막힘 블록(oc-blocked)은 "막힘: 이유" 줄로 보여 주니 본문에서는 뺀다(결정 0018, hideGoal 과 같은 방식).
// 받지 않은 블록(형식이 깨진 것)은 그대로 보인다. 쓰는 중이면 끝의 블록도 감춘다
const hideBlock = (name) => (text, block = null, streaming = false) => {
  const src = String(text || '');
  const ok = block && Number.isInteger(block.from) && Number.isInteger(block.to) && block.from >= 0 && block.to > block.from && block.to <= src.length && src.startsWith(`\`\`\`${name}`, block.from);
  const out = ok ? src.slice(0, block.from) + src.slice(block.to) : src;
  return streaming ? out.replace(new RegExp(`\`\`\`${name}[\\s\\S]*$`), '') : out;
};
export const hidePlan = hideBlock('oc-plan');
export const hideBlocked = hideBlock('oc-blocked');

// 검수 답 끝의 판정 블록(oc-review)은 기준표로 보여 주니 본문에서는 뺀다(hideGoal 과 같은 방식, 결정 0015).
// block: 서버가 판정으로 받은 블록의 자리({ from, to }). 받지 않은 블록(일회용 값이 틀렸거나 형식이 깨진 것)은 그대로 보인다. 쓰는 중이면 끝의 블록도 감춘다
export function hideReview(text, block = null, streaming = false) {
  const src = String(text || '');
  const ok = block && Number.isInteger(block.from) && Number.isInteger(block.to) && block.from >= 0 && block.to > block.from && block.to <= src.length
    && src.startsWith('```oc-review', block.from);
  const out = ok ? src.slice(0, block.from) + src.slice(block.to) : src;
  return streaming ? out.replace(/```oc-review[\s\S]*$/, '') : out;
}
