// 회의 차례 정하기와 판정 읽기: 반대편 고르기, 차례 순서, 진행자 답 끝의 ```oc-verdict 블록 읽기(질문 블록 oc-ask 와 같은 규칙).
// 회의 중 조사: 차례 답 끝의 ```oc-check 블록 읽기, 조사하러 갈 사람 고르기
import { tr } from './i18n.js';
import { roleKind } from './routing.js';

const OPEN = '```oc-verdict';
const LAST = /^```oc-verdict[ \t]*\r?\n([\s\S]*?)```\s*$/; // 글의 맨 끝에 있는 블록만 판정이다
const VERDICTS = new Set(['agree', 'continue']);
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

// text 의 맨 끝에 있는 oc-verdict 블록을 읽는다. 없으면 null, JSON 이 아니면 { error: 'json' }, 값이 두 가지가 아니면 { error: 'shape' },
// 맞으면 { verdict, reason, from, to }(블록의 자리). 끝이 아닌 곳의 블록(예로 든 것, 뒤에 글을 더 쓴 것)은 판정으로 보지 않는다
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
  return { verdict, reason: line(data.reason, 300), from, to };
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
