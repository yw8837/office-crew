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
