// 에이전트가 사용자에게 묻기: 답 끝의 ```oc-ask 블록을 읽어 선택 카드로 띄우고, 고른 답을 그 에이전트에게 돌려준다.
// CLI의 질문 도구를 가로채지 않는다(어느 CLI에서나 같은 방식으로 통하게 글로 약속한 형식만 쓴다).
import { tr } from './i18n.js';

export const ASK_MAX = 3; // 한 번 맡은 일에서 물을 수 있는 횟수
const Q_MAX = 4;
const OPT_MAX = 6;
const OPEN = '```oc-ask';
const LAST = /^```oc-ask[ \t]*\r?\n([\s\S]*?)```\s*$/; // 글의 맨 끝에 있는 블록만 질문이다
const ANY = /```oc-ask[ \t]*\r?\n[\s\S]*?```/g;

const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// 글에서 질문 블록을 뺀다(다른 AI에게 지금까지 쓴 답을 다시 줄 때)
export const stripAsks = (text) => String(text || '').replace(ANY, '');

// text 의 맨 끝에 있는 oc-ask 블록을 읽는다. 없으면 null, 형식이 틀리면 { error }, 맞으면 { ask: { questions }, from, to }(블록의 자리).
// 끝이 아닌 곳의 블록(형식을 예로 든 것, 뒤에 글을 더 쓴 것)은 질문으로 보지 않는다
export function parseAsk(text) {
  const src = String(text || '');
  const from = src.lastIndexOf(OPEN);
  if (from < 0) return null;
  const m = src.slice(from).match(LAST);
  if (!m) return null;
  const to = from + m[0].trimEnd().length;
  let data;
  try { data = JSON.parse(m[1]); } catch { return { error: 'json' }; }
  const list = Array.isArray(data) ? data : data?.questions;
  if (!Array.isArray(list) || !list.length) return { error: 'empty' };
  const questions = [];
  for (const q of list.slice(0, Q_MAX)) {
    const question = line(q?.question, 300);
    const options = (Array.isArray(q?.options) ? q.options : []).slice(0, OPT_MAX)
      .map((o) => (typeof o === 'string' ? { label: line(o, 80), description: '' } : { label: line(o?.label, 80), description: line(o?.description, 200) }))
      .filter((o) => o.label);
    if (!question || options.length < 2) return { error: 'shape' };
    questions.push({ header: line(q.header, 30), question, options, multi: q.multi === true });
  }
  return { ask: { questions }, from, to };
}

// 화면에서 온 답을 질문에 맞춰 다듬는다: [{ picked: [보기 번호], other: '직접 쓴 답' }]
export function cleanAnswers(ask, raw) {
  const list = Array.isArray(raw) ? raw : [];
  return ask.questions.map((q, i) => {
    const a = list[i] || {};
    let picked = [...new Set((Array.isArray(a.picked) ? a.picked : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length))];
    if (!q.multi) picked = picked.slice(0, 1);
    return { picked, other: line(a.other, 1000) };
  });
}

export const answered = (answers) => answers.every((a) => a.picked.length || a.other);

const said = (q, a) => [...a.picked.map((n) => q.options[n].label), a.other ? tr('직접 입력: {text}', { text: a.other }) : ''].filter(Boolean).join(', ');

// 에이전트에게 돌려주는 글
export function answerPrompt(ask, answers) {
  if (!answers) return `${tr('[사용자 답변]')}\n${tr('사용자가 답하지 않고 넘겼어. 합리적인 가정을 정해서 그 가정을 답에 적고 이어서 진행해. 같은 질문을 다시 하지 마.')}`;
  const body = ask.questions.map((q, i) => `${i + 1}. ${q.question}\n   → ${said(q, answers[i])}`).join('\n');
  return `${tr('[사용자 답변]')}\n${body}\n${tr('이 답을 반영해서 이어서 진행해. 같은 질문을 다시 하지 마.')}`;
}

// 대화에 남기는 한 줄씩의 기록(내보내기·기억·다른 에이전트가 읽을 때 질문과 답이 같이 보이게)
export function answerRecord(ask, answers) {
  const asked = (q) => `> ❓ ${q.header ? `[${q.header}] ` : ''}${q.question}`;
  if (!answers) return `${ask.questions.map(asked).join('\n')}\n> 🙋 ${tr('질문을 넘겼어. 에이전트가 가정을 정해서 진행해.')}`;
  return ask.questions.map((q, i) => `${asked(q)}\n> 🙋 **${said(q, answers[i])}**`).join('\n>\n');
}

// 지침에 넣는 규칙. 묻는 조건을 좁게 잡는다(아무 때나 물으면 일이 계속 멈춘다)
export function askNote() {
  return [
    tr('사용자에게 묻기: 사용자만 정할 수 있는 것(취향·범위·돈이 드는 일·되돌릴 수 없는 일)이고, 파일이나 대화에서 네가 찾을 수 없을 때만 물어. 네가 정해도 되는 것은 묻지 말고 가정을 적은 뒤 진행해.'),
    tr('물을 때는 답 맨 끝에 아래 형식의 블록 하나만 쓰고 거기서 멈춰. 블록 뒤에는 아무것도 쓰지 마. 질문은 1~4개, 보기는 2~6개, 추천하는 보기는 맨 앞에 두고 label 끝에 "(추천)"을 붙여. 사용자는 보기 대신 직접 써서 답할 수도 있어. 답을 받으면 이어서 진행하게 돼.'),
    '```oc-ask\n{"questions":[{"header":"…","question":"…?","options":[{"label":"…","description":"…"},{"label":"…","description":"…"}],"multi":false}]}\n```',
  ].join('\n');
}
