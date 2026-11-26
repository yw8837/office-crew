// 회의 차례 정하기와 판정 읽기: 반대편 고르기, 차례 순서, 진행자 답 끝의 ```oc-verdict 블록 읽기(질문 블록 oc-ask 와 같은 규칙).
// 회의 중 조사: 차례 답 끝의 ```oc-check 블록 읽기, 조사하러 갈 사람 고르기
// 회의 정체(결정 0028): 차례 답의 "입장:" 줄 읽기, 반대편을 뺀 차례 발언자의 입장이 앞 바퀴와 그대로인지(그 바퀴에 조사 답이 왔으면 정체가 아니다)
import { tr } from './i18n.js';
import { roleKind } from './routing.js';

const OPEN = '```oc-verdict';
const LAST = /^```oc-verdict[ \t]*\r?\n([\s\S]*?)```\s*$/; // 글의 맨 끝에 있는 블록만 판정이다
// ask: 팀이 아니라 사용자가 정할 일이라 진행자가 사용자에게 묻는다(결정 0028). 질문 한 줄과 보기 2~ASK_OPTIONS 개를 판정 블록 안에 같이 적는다
const VERDICTS = new Set(['agree', 'continue', 'ask']);
export const MEET_ASK_MAX = 2; // 회의 하나에서 사용자에게 물을 수 있는 횟수(넘으면 ask 를 "계속"으로 본다)
const ASK_OPTIONS = 4; // 회의 질문의 보기 최대 개수(결정 0009 의 질문 블록보다 적게: 진행자가 안을 좁혀서 묻게)
export const CHECK_MAX = 3; // 회의 한 번에 조사할 수 있는 횟수
const CHECK_OPEN = '```oc-check';
const CHECK_LAST = /^```oc-check[ \t]*\r?\n([\s\S]*?)```\s*$/; // 글의 맨 끝에 있는 블록만 질문이다

const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// 프롬프트에 넣는 판정 블록 예시. 설명 글은 설정 언어로, agree / continue 는 번역하지 않는 고정 키워드다
export const verdictBlock = () => `\`\`\`oc-verdict\n${JSON.stringify({ verdict: tr('agree 또는 continue'), reason: tr('한 문장') })}\n\`\`\``;

// 반대편: 정해 둔 사람(참석자이고 진행자가 아닐 때) → 진행자와 다른 AI를 쓰는 첫 참석자 → 진행자를 뺀 마지막 참석자. 진행자뿐이면 null
export function pickOpposer(ids, chairId, wanted, providerOf) {
  const rest = ids.filter((id) => id !== chairId);
  if (!rest.length) return null;
  if (wanted && rest.includes(wanted)) return wanted;
  const chairAi = providerOf(chairId);
  return rest.find((id) => providerOf(id) !== chairAi) || rest.at(-1);
}

// 차례 발언 순서: 반대편이 맨 앞(그 지적에 나머지가 같은 바퀴 안에서 답할 수 있게), 나머지는 진행자를 빼고 팀에 적힌 순서대로
export function turnOrder(ids, chairId, opposerId) {
  const rest = ids.filter((id) => id !== chairId && id !== opposerId);
  return opposerId && opposerId !== chairId && ids.includes(opposerId) ? [opposerId, ...rest] : rest;
}

// text 의 맨 끝에 있는 oc-verdict 블록을 읽는다. 없으면 null, JSON 이 아니면 { error: 'json' }, 값이 세 가지가 아니면 { error: 'shape' },
// 맞으면 { verdict, reason, from, to }(블록의 자리). 끝이 아닌 곳의 블록(예로 든 것, 뒤에 글을 더 쓴 것)은 판정으로 보지 않는다.
// ask(결정 0028)는 질문 블록(결정 0009)과 같은 다듬기로 질문 한 줄(300자)과 보기 2~ASK_OPTIONS 개(글 또는 { label, description })를 읽어
// { ..., ask: { questions: [하나] } } 로 준다. 질문이 비었거나 보기가 2개 미만·ASK_OPTIONS 개 초과면 { error: 'shape' }(결론을 바꿀 질문을 코드가 지어내지 않는다)
export function parseVerdict(text) {
  const src = String(text || '');
  const from = src.lastIndexOf(OPEN);
  if (from < 0) return null;
  const m = src.slice(from).match(LAST);
  if (!m) return null;
  const to = from + m[0].trimEnd().length;
  let data;
  try { data = JSON.parse(m[1]); } catch { return { error: 'json' }; }
  const verdict = typeof data?.verdict === 'string' ? data.verdict.toLowerCase() : null; // "Agree"·"CONTINUE"도 읽는다
  if (!VERDICTS.has(verdict)) return { error: 'shape' };
  if (verdict !== 'ask') return { verdict, reason: line(data.reason, 300), from, to };
  const question = line(data.question, 300);
  const options = (Array.isArray(data.options) ? data.options : [])
    .map((o) => (typeof o === 'string' ? { label: line(o, 80), description: '' } : { label: line(o?.label, 80), description: line(o?.description, 200) }))
    .filter((o) => o.label);
  if (!question || options.length < 2 || options.length > ASK_OPTIONS) return { error: 'shape' };
  return { verdict, reason: line(data.reason, 300), ask: { questions: [{ header: '', question, options, multi: false }] }, from, to };
}

// 입장 줄의 머리(네 언어. 회의 프롬프트의 "입장: …" 형식 줄을 각 언어로 옮긴 말). 줄 맨 앞의 목록 기호·번호·굵게 표시는 건너뛴다
const POSITION = /^\s*(?:[-*+•]\s+|\d+[.)]\s+)?(?:\*\*|__)?\s*(?:입장|position|立场|立場)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
const FENCE = /^ {0,3}(?:```|~~~)/; // 코드 펜스를 여닫는 줄
const INDENTED = /^(?: {2,}|\t)/; // 두 칸 이상(또는 탭) 들여 쓴 줄: 하위 목록·코드
// 차례 답에서 입장 값: "입장:" 머리로 시작하는 마지막 줄의 값을 NFKC 로 정규화(전각 글자·쌍점·공백)하고 공백을 펴고 소문자로. 없거나 값이 비면 null(지어내지 않는다).
// 코드 펜스 안의 줄(css 의 position: absolute;, YAML 의 position: 3)과 두 칸 이상 들여 쓴 줄(하위 목록)은 입장 줄로 읽지 않는다.
// raw: 소문자로 바꾸지 않은 값(두 갈래 카드에 보일 글, 결정 0031)
export function positionOf(text, raw = false) {
  const lines = String(text ?? '').normalize('NFKC').split(/\r?\n/);
  let fenced = false;
  let found = null;
  for (const l of lines) {
    if (FENCE.test(l)) { fenced = !fenced; continue; }
    if (fenced || INDENTED.test(l)) continue;
    const m = l.match(POSITION);
    if (m) found = m[1];
  }
  if (found === null) return null;
  const v = found.replace(/\s+/g, ' ').trim();
  return (raw ? v : v.toLowerCase()) || null;
}

// 정체(결정 0028): round 바퀴의 차례 발언자 ids(반대편을 뺀. 진행자는 차례 발언을 하지 않는다)가 둘 이상이고, 모두 이번 바퀴와 앞 바퀴(2바퀴면 1바퀴 의견)에
// 입장 줄이 있고, 사람마다 앞 바퀴와 같으면 true. 서로 달라도 각자 그대로면 정체다(더 얘기해도 안 바뀐다). 입장 줄이 없거나 이번 바퀴에 말하지 못한 사람이 있으면 false.
// 그 바퀴에 답이 온 조사(answered)가 하나라도 있으면 false: 새 사실을 진행자가 판정에서 보게 한다(결정 0011). 답을 못 받은 조사는 새 사실이 아니라 보지 않는다.
// said: 회의에서 나온 말 [{ agent: { id }, text, round, phase, answered? }]
export function stalled({ said = [], round = 0, ids = [] } = {}) {
  if (round < 2 || ids.length < 2) return false;
  if (said.some((s) => s.round === round && s.phase === 'research' && s.answered)) return false;
  const pos = (id, r, phase) => { const x = said.findLast((s) => s.agent?.id === id && s.round === r && s.phase === phase); return x ? positionOf(x.text) : null; };
  return ids.every((id) => {
    const now = pos(id, round, 'turn');
    const before = pos(id, round - 1, round - 1 === 1 ? 'opinion' : 'turn');
    return now !== null && now === before;
  });
}

// 프롬프트에 넣는 질문 블록 예시(설명 글은 설정 언어로)
export const checkBlock = () => `\`\`\`oc-check\n${JSON.stringify({ question: tr('결론을 바꿀 수 있는 사실 하나를 묻는 질문') })}\n\`\`\``;

// text 의 맨 끝에 있는 oc-check 블록을 읽는다. 없으면 null, 맞으면 { question, from, to }(블록의 자리, parseAsk 와 같은 뜻).
// JSON 이 아니면 { error: 'json' }, 질문이 앞뒤 공백을 빼고 1~300자(글자 단위. 이모지도 한 글자)의 글이 아니면 { error: 'shape' }. 틀린 블록도 자리(from, to)는 같이 준다(한 말에서 블록을 빼려고).
// 끝이 아닌 곳의 블록(예로 든 것, 뒤에 글을 더 쓴 것)은 질문으로 보지 않는다
export function parseCheck(text) {
  const src = String(text || '');
  const from = src.lastIndexOf(CHECK_OPEN);
  if (from < 0) return null;
  const m = src.slice(from).match(CHECK_LAST);
  if (!m) return null;
  const to = from + m[0].trimEnd().length;
  let data;
  try { data = JSON.parse(m[1]); } catch { return { error: 'json', from, to }; }
  const question = typeof data?.question === 'string' ? data.question.trim() : '';
  if (!question || [...question].length > 300) return { error: 'shape', from, to };
  return { question, from, to };
}

// 조사하러 갈 사람: 팀의 단계 순서, 단계 안에서는 적힌 순서대로 본 에이전트 중 역할 종류가 조사인 첫 사람. 진행자는 고르지 않는다. 없으면 null
// team: { stages: [{ agentIds }] }, agentsById: { [id]: agent }
export function pickResearcher(team, agentsById, chairId) {
  for (const st of team?.stages || []) {
    for (const id of st.agentIds || []) {
      const a = agentsById?.[id];
      if (a && id !== chairId && roleKind(a.role) === 'research') return id;
    }
  }
  return null;
}
