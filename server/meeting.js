// 회의 차례 정하기와 판정 읽기: 반대편 고르기, 차례 순서, 진행자 답 끝의 ```oc-verdict 블록 읽기(질문 블록 oc-ask 와 같은 규칙)
import { tr } from './i18n.js';

const OPEN = '```oc-verdict';
const LAST = /^```oc-verdict[ \t]*\r?\n([\s\S]*?)```\s*$/; // 글의 맨 끝에 있는 블록만 판정이다
const VERDICTS = new Set(['agree', 'continue']);

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
