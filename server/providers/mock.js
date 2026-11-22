// 데모 어댑터: 실제 AI 호출 없이(사용량 0) 생각→도구→타이핑 흐름을 흉내 낸다. 화면·애니메이션·개입 기능 체험과 테스트용
import fs from 'node:fs';
import path from 'node:path';
import { makeHandle } from './util.js';
import { tr } from '../i18n.js';
import { roleKind } from '../routing.js';
import { checkBlock } from '../meeting.js';
import { goalBlock, reviewBlock, researchBlock, planBlock } from '../mission.js';

// 역할 키(조사·정리·분석·빌드)는 그대로, 보이는 문구만 설정 언어로.
// 에이전트의 역할 이름은 첫 실행 때 OS 언어로 저장되므로(Research, 調査 …) 역할 종류로 바꿔서 키를 찾는다
const KEY = { research: '조사', organize: '정리', analysis: '분석', build: '빌드' };
const roleKey = (role) => KEY[roleKind(role)] || role;
const resultFile = () => tr('데모-결과.md');
const PLANS = () => ({
  조사: [[tr('웹 검색'), { query: tr('관련 자료 검색') }, 1600], [tr('자료 읽기'), { file: 'reference.md' }, 1200]],
  정리: [[tr('자료 읽기'), { file: tr('이전 단계 결과') }, 1000]],
  분석: [[tr('계획(todo)'), { items: [tr('핵심 판단'), tr('위험'), tr('우선순위')] }, 1400]],
  빌드: [['Agent', { description: tr('테스트 작성 도우미 호출') }, 1800], [tr('파일 쓰기'), { file: resultFile() }, 1100], [tr('명령 실행'), { command: 'npm test' }, 1700]],
});

function topic(prompt) {
  const head = tr('[사용자 요청]').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = prompt.match(new RegExp(`${head}\\s*\\n([^\\n]+)`)) || prompt.match(/^([^\n]{1,80})/);
  return (m?.[1] || tr('요청')).trim().slice(0, 60);
}

function answer(role, name, prompt) {
  const t = topic(prompt);
  const lines = {
    조사: [tr('## 조사 결과 — {t}', { t }), '', tr('- 핵심 자료 3건 확인(데모 데이터)'), tr('- 출처: 데모 웹 검색 · 내부 문서'), tr('- 추정: 수요가 꾸준히 늘고 있음'), '', tr('다음 단계에 넘길 요약: 자료 3건, 쟁점 2개.')],
    정리: [tr('## 정리 — {t}', { t }), '', tr('| 항목 | 내용 |'), '|---|---|', tr('| 핵심 | 자료 3건 요약 |'), tr('| 쟁점 | 비용, 일정 |'), '', tr('중복을 지우고 표로 묶었어.')],
    분석: [tr('## 분석 — {t}', { t }), '', tr('1. **우선순위**: 비용 절감 → 일정 단축'), tr('2. **위험**: 데이터 부족(중간)'), tr('3. **권장 실행안**: 작은 범위로 먼저 시도'), '', tr('승인되면 빌드 단계로 넘겨.')],
    빌드: [tr('## 빌드 결과 — {t}', { t }), '', tr('- `{file}` 파일을 작업 폴더에 만들었어', { file: resultFile() }), tr('- 테스트 3개 통과(데모)'), '', '```text', tr('✓ 결과 파일 생성'), tr('✓ 형식 검사'), '```'],
  };
  return (lines[role] || [tr('## {name}의 답변', { name }), '', tr('요청 "{t}"을(를) 처리했어 (데모 응답).', { t })]).join('\n');
}

// ── 회의 차례 ──
// 회의 단계의 프롬프트에는 차례마다 정해진 형식 문구가 들어 있다. 그 문구로 차례를 알아보고 같은 형식의 짧은 답을 낸다
// (그러지 않으면 데모 팀으로 회의를 돌렸을 때 "조사 결과" 같은 엉뚱한 글이 나온다)
function meetingPhase(prompt) {
  if (prompt.includes(tr('[회의 — 조사 ({r}/{n}바퀴)]').split('{')[0])) return 'research';
  if (prompt.includes(tr('[회의 — 결론 내기]'))) return 'conclude';
  if (prompt.includes(tr('[회의 — 판정 ({r}/{n}바퀴)]').split('{')[0])) return 'judge'; // 바퀴 숫자 앞까지만 맞춰 본다
  if (prompt.includes(tr('답하는 말: 누구의 어떤 말인지'))) return 'turn';
  if (prompt.includes(tr('내가 틀렸다고 볼 기준: 무엇이 확인되면 이 주장을 버릴지'))) return 'opinion';
  return null;
}
const OPINIONS = () => ({
  조사: [tr('자료로 확인된 수요가 가장 큰 안으로 가자.'), tr('자료 3건이 같은 방향을 가리키고, 비슷한 사례가 2건 있어.'), tr('반대되는 자료가 2건 넘게 나오면 버릴게.'), tr('중간')],
  정리: [tr('한 문장으로 설명되는 가장 단순한 안으로 가자.'), tr('설명이 짧을수록 전달이 쉽고, 준비할 것도 적어.'), tr('설명에 세 문장이 넘게 필요해지면 버릴게.'), tr('중간')],
  분석: [tr('위험이 가장 작은 안을 작게 먼저 해 보자.'), tr('되돌리기 쉽고, 틀려도 드는 비용이 작아.'), tr('작게 해 봤는데 효과가 안 보이면 버릴게.'), tr('높음')],
  빌드: [tr('지금 있는 것으로 이번 주 안에 만들 수 있는 안으로 가자.'), tr('새로 들일 것이 없고, 시험해 보기도 쉬워.'), tr('새로 만들 부품이 둘 넘게 필요해지면 버릴게.'), tr('중간')],
});
// 차례 답은 누가 말했는지 특정하지 않는다(회의에 그 역할이 없을 수 있다)
const TURNS = () => ({
  조사: [tr('앞에서 나온 "작게 먼저 해 보자"는 말'), tr('동의해. 자료로 수요가 확인된 안부터 작게 시작하면 돼.'), tr('수요가 확인된 안을 작게 먼저 해 보자.')],
  정리: [tr('앞에서 나온 "수요가 확인된 안"이라는 말'), tr('동의해. 그 안이면 설명도 한 문장으로 줄일 수 있어.'), tr('자료 3건을 보고 수요가 확인된 안 쪽으로 바꿨어.')],
  분석: [tr('앞에서 나온 "이번 주 안에 된다"는 말'), tr('반대해. 시험할 시간이 빠져 있어.'), tr('작게 먼저 해 보고, 일정은 시험까지 넣어서 잡자.')],
  빌드: [tr('앞에서 나온 "자료 3건"이라는 말'), tr('자료 3건 중 2건은 출처가 같아. 하나로 세면 근거가 약해져.'), tr('범위를 작게 잡으면 이번 주 안에 만들 수 있어.')],
});
// 반대편 차례: 역할과 상관없이 가장 힘을 받는 안의 약점 하나와 틀릴 조건을 짚는다
const OPPOSE = () => [tr('지금 가장 힘을 받는 안'), tr('그 안의 약점은 근거가 한쪽 자료에만 기대고 있다는 거야. 다른 자료에서 반대 결과가 나오면 이 안은 틀려.'), tr('다른 자료 하나만 더 확인해서 같은 결과가 나오면 그 안을 따를게.')];
const isOpposer = (prompt) => prompt.includes(tr('너는 이번 회의에서 반대편이야. 지금 가장 힘을 받는 안의 약점, 빠진 것, 틀릴 조건을 찾아서 말해. 근거 없이 꾸며 내지는 마. 반대할 게 정말 없으면 무엇을 확인했는지 적어.'));
// 반대편이 2바퀴 차례에서 질문 블록 안내를 받았으면 답 끝에 질문 하나를 붙인다(데모에서 회의 중 조사가 보이게)
const asksCheck = (prompt) => prompt.includes(checkBlock()) && prompt.includes(tr('[회의 — 차례 발언 ({r}/{n}바퀴)]', { r: 2, n: '\u0000' }).split('\u0000')[0]);
function meetingAnswer(phase, role, opposer, ask, prompt = '') {
  if (phase === 'research') {
    // 조사 답 형식("- 사실 | 출처 | 확인함·확인 못 함")대로. 출처는 데모라 실제로 열리지 않는 example.test 주소
    return [`- ${tr('다른 자료 2건에서도 같은 방향의 결과가 나왔어.')} | https://example.test/demo/check/source-a | ${tr('확인함')}`, `- ${tr('그중 1건은 표본이 작아서 근거로는 약해.')} | https://example.test/demo/check/source-b | ${tr('확인함')}`,
      `- ${tr('반대 결과를 낸 자료는 찾지 못했어.')} | ${tr('없음')} | ${tr('확인 못 함')}`].join('\n');
  }
  if (phase === 'opinion') {
    const [claim, why, wrong, sure] = OPINIONS()[role] || OPINIONS().분석;
    return [`- **${tr('주장')}**: ${claim}`, `- **${tr('근거')}**: ${why}`, `- **${tr('내가 틀렸다고 볼 기준')}**: ${wrong}`, `- **${tr('확신')}**: ${sure}`].join('\n');
  }
  if (phase === 'turn') {
    const [to, mine, stand] = opposer ? OPPOSE() : TURNS()[role] || TURNS().분석;
    const check = opposer && ask ? `\n\n\`\`\`oc-check\n${JSON.stringify({ question: tr('다른 자료에서도 같은 결과가 나오는지 확인해 줄래?') })}\n\`\`\`` : '';
    return [`- **${tr('답하는 말')}**: ${to}`, `- **${tr('내 말')}**: ${mine}`, `- **${tr('입장')}**: ${stand}`].join('\n') + check;
  }
  // 판정: 데모 진행자는 한 바퀴 만에 합의한다
  if (phase === 'judge') {
    // 목표 회의의 1바퀴 뒤 판정은 반대편을 포함해서 본다(결정 0017). 그 밖의 판정은 반대편을 뺀다(결정 0010)
    const first = String(prompt || '').includes(tr('너는 이 회의의 진행자야. 1바퀴 의견만 보고 차례 바퀴를 건너뛸지 판정해. 반대편을 포함한 모든 참석자의 "입장"이 같은 안을 가리킬 때만 합의야. 한 사람이라도 다른 안이면 계속이야.'));
    return `${first ? tr('1바퀴에 반대편을 포함한 모두의 입장이 같은 안을 가리켜. 차례 바퀴 없이 결론을 낼게.') : tr('반대편을 뺀 참석자들의 입장이 같은 안을 가리켜. 반대편이 짚은 약점은 결론의 남은 이견에 적을게.')}\n\n\`\`\`oc-verdict\n${JSON.stringify({ verdict: 'agree', reason: tr('모두 같은 안을 가리켜.') })}\n\`\`\``;
  }
  return [
    `## ${tr('회의 결론')}`, '',
    `- **${tr('결정')}**: ${tr('합침. 수요가 확인된 안을, 가장 작은 범위로 먼저 만든다.')}`,
    `- **${tr('근거')}**: ${tr('자료가 같은 방향이고, 작게 시작하면 되돌리기 쉬워.')}`,
    `- **${tr('남은 이견')}**: ${tr('범위를 어디까지 줄일지는 의견이 갈렸어.')}`,
    `- **${tr('버린 안')}**: ${tr('새 부품부터 만드는 안은 시험할 시간이 모자라서 버렸어.')}`,
    `- **${tr('다음 할 일')}**: ${tr('반대 자료를 한 번 더 확인하고, 그다음에 첫 화면을 만들어.')}`,
  ].join('\n');
}

// ── 목표 잡기 차례(결정 0014) ──
// 목표 차례 프롬프트는 코드가 만든 끝 모양(블록 예시 goalBlock())으로 끝난다. 그 끝 모양일 때만 목표 차례로 보고 그럴듯한 목표 카드 블록을 낸다
// (요청 글에 "[목표 잡기]"가 들어 있다고 착각하지 않게. 데모 팀으로 사용량 0으로 눌러 볼 수 있게)
const isGoalTurn = (prompt) => String(prompt).trimEnd().endsWith(goalBlock());
function goalAnswer(prompt) {
  const t = topic(prompt);
  const card = {
    goal: tr('"{t}"을(를) 작게 끝까지 해내기', { t }),
    criteria: [tr('작업 폴더에 결과 파일이 있다'), tr('결과에 요청의 핵심이 빠짐없이 들어 있다'), tr('처음 보는 사람이 한 번 읽고 무엇을 했는지 안다')],
    outOfScope: [tr('실제 배포나 결제')],
    userDecides: [tr('결과물의 형식(문서·표·화면)')],
  };
  return `${tr('요청을 목표 카드로 정리했어(데모). 확인하면 팀이 이 기준을 들고 일해.')}\n\n\`\`\`oc-goal\n${JSON.stringify(card)}\n\`\`\``;
}

// ── 기준 판정 차례(결정 0015) ──
// 검수 프롬프트는 코드가 만든 머리 문구("[기준 판정 — n번째 검수]")로 시작하고 판정 블록 예시(reviewBlock)로 끝난다. 둘 다 맞을 때만 검수 차례로 보고,
// 끝의 예시에서 일회용 값을, "- c1: …" 줄에서 기준 id 를 읽어 판정 블록을 낸다. 확정 목표 줄에 REVIEWFAIL(1회차에 c1 불합격)·REVIEWFAIL2(늘 c1 불합격)·REVIEWUNK(c1 확인 못 함)가 있으면 그대로 흉내 낸다
const reviewHead = () => new RegExp(`${tr('[기준 판정 — {n}번째 검수]').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{n\\}', '(\\d+)')}`);
function reviewTurn(prompt) {
  const p = String(prompt).trimEnd();
  const at = p.lastIndexOf('```oc-review\n');
  if (at < 0 || !p.endsWith('```') || !reviewHead().test(p)) return null;
  let nonce = '';
  try { nonce = JSON.parse(p.slice(at + '```oc-review\n'.length, -3)).nonce || ''; } catch { return null; }
  if (p !== p.slice(0, at) + reviewBlock(nonce)) return null; // 끝이 코드가 만든 예시 그대로일 때만
  const goal = p.match(new RegExp(`^${tr('목표').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (.*)$`, 'm'))?.[1] || '';
  return { nonce, goal, round: Number(p.match(reviewHead())?.[1] || 1), ids: [...p.matchAll(/^- (c\d+): /gm)].map((x) => x[1]) };
}
function reviewAnswer({ nonce, goal, round, ids }) {
  const fail = goal.includes('REVIEWFAIL2') || (goal.includes('REVIEWFAIL') && round === 1);
  const results = ids.map((id, k) => (k === 0 && fail ? { id, verdict: 'fail', evidence: tr('데모: 결과 파일에 이 내용이 없어') }
    : k === 0 && goal.includes('REVIEWUNK') ? { id, verdict: 'unknown', evidence: tr('데모: 확인할 방법이 없었어') }
      : { id, verdict: 'pass', evidence: tr('데모: 작업 폴더의 결과 파일을 열어 확인했어') }));
  return `${tr('기준마다 확인했어(데모).')}\n\n\`\`\`oc-review\n${JSON.stringify({ nonce, results })}\n\`\`\``;
}

// ── 일하기 전 조사(결정 0017) ──
// 훑어보기·조사 프롬프트는 코드가 만든 머리 줄("[조사 전 훑어보기]", "[조사 — 질문 n/m]")로 시작하고, 조사 질문 프롬프트는 블록 예시(researchBlock())로 끝난다.
// 그 모양일 때만 그 차례로 보고 같은 형식의 짧은 답을 낸다(데모 팀으로 사용량 0으로 조사·회의를 눌러 볼 수 있게)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function prepTurn(prompt) {
  const p = String(prompt);
  const first = p.split('\n', 1)[0];
  if (first === tr('[조사 전 훑어보기]')) return { kind: 'scan' };
  if (p.trimEnd().endsWith(researchBlock()) && p.split('\n').includes(tr('[조사 질문 뽑기]'))) return { kind: 'questions' };
  const head = new RegExp(`^${esc(tr('[조사 — 질문 {n}/{total}]')).replace('\\{n\\}', '(\\d+)').replace('\\{total\\}', '\\d+')}$`);
  const m = first.match(head);
  return m ? { kind: 'research', n: Number(m[1]) } : null;
}
function prepAnswer({ kind, n }, prompt) {
  const t = topic(prompt);
  if (kind === 'scan') {
    return [tr('## 훑어보기 — {t}', { t }), '', `- ${tr('주제: 요청을 작게 끝까지 해내는 방법(데모)')}`, `- ${tr('지금 사정: 비슷한 자료 2건이 있어(데모)')}`, `- ${tr('출발할 자료: 데모 웹 검색 · 내부 문서')}`, `- ${tr('확인해야 할 가정: 마감과 범위(확인 못 함)')}`].join('\n');
  }
  if (kind === 'questions') {
    const questions = [tr('비슷한 서비스나 사례는 무엇이 있나?'), tr('사용자들이 가장 많이 불만을 말하는 점은?'), tr('지켜야 할 조건이나 마감은 무엇인가?')];
    return `${tr('조사할 질문을 뽑았어(데모).')}\n\n\`\`\`oc-research\n${JSON.stringify({ questions })}\n\`\`\``;
  }
  // 조사 답 형식("- 사실 | 출처 | 확인함·확인 못 함")대로. 출처는 데모라 실제로 열리지 않는 example.test 주소(결정 0017)
  return [tr('## 조사 {n} — 찾은 사실(데모)', { n }), '', `- ${tr('자료 2건이 같은 방향을 가리켜.')} | https://example.test/demo/q${n}/source-a | ${tr('확인함')}`,
    `- ${tr('그중 1건은 표본이 작아.')} | https://example.test/demo/q${n}/source-b | ${tr('확인함')}`, `- ${tr('반대 결과를 낸 자료는 찾지 못했어.')} | ${tr('없음')} | ${tr('확인 못 함')}`].join('\n');
}

// ── 일 카드(결정 0018) ──
// 계획 대목 프롬프트는 "[일 계획]" 줄이 있고 블록 예시(planBlock())로 끝난다. 그 모양일 때만 계획 차례로 보고, 팀 명단("- 이름 (역할)" 줄)의 사람에게 카드를 나눈다:
// 첫 사람은 조사 카드(파일 없음), 나머지는 저마다 다른 결과 파일을 맡고, 마지막 카드는 첫 카드를 기다린다(단계가 둘로 나뉘는 걸 보이려고)
function planTurn(prompt) {
  const p = String(prompt);
  if (!p.trimEnd().endsWith(planBlock()) || !p.split('\n').includes(tr('[일 계획]'))) return null;
  const head = `${tr('[팀 명단 — 담당은 이 이름 그대로]')}\n`;
  const at = p.indexOf(head);
  const lines = at < 0 ? [] : p.slice(at + head.length).split('\n\n')[0].split('\n');
  return lines.map((l) => l.match(/^- (.+) \(([^()]*)\)$/)).filter(Boolean).map((m) => ({ name: m[1], role: m[2] }));
}
function planAnswer(roster) {
  const people = roster.slice(0, 3);
  const cards = people.map((a, k) => {
    const kind = k === 0 ? 'research' : roleKind(a.role) === 'build' ? 'build' : 'write';
    return {
      title: k === 0 ? tr('자료를 모으고 요점을 정리한다(데모)') : tr('결과 {n}을(를) 만든다(데모)', { n: k }), owner: a.name, kind,
      needs: k > 0 && k === people.length - 1 ? ['k1'] : [], files: k === 0 ? [] : [tr('데모-결과-{n}.md', { n: k })], not: tr('다른 카드의 파일은 고치지 마'),
      done: k === 0 ? tr('요점 3개가 있다') : tr('결과 파일이 작업 폴더에 있다'),
    };
  });
  return `${tr('일을 카드로 나눴어(데모).')}\n\n\`\`\`oc-cards\n${JSON.stringify({ cards })}\n\`\`\``;
}
const cardTurn = (prompt) => String(prompt).match(new RegExp(`^${esc(tr('[일 카드 {id}]')).replace('\\{id\\}', '(k\\d+)')}$`, 'm'))?.[1] || null;

export default {
  id: 'mock', get label() { return tr('데모'); }, get sub() { return tr('가상 에이전트 · 사용량 0'); }, kind: 'mock', color: '#64748b',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  caps: { images: true, steer: true, resume: true, tools: true, connectors: true, permissions: true },
  login: null,
  async detect() { return { installed: true, version: 'built-in', loggedIn: true, account: tr('로그인 불필요'), note: '' }; },
  async models() { return [{ id: 'mock-fast', label: tr('빠른 데모'), tier: 'balanced' }, { id: 'mock-slow', label: tr('느린 데모(관전용)'), tier: 'fast' }]; },

  run(opts, emit) {
    const { agent, prompt, cwd, resumeId } = opts;
    const h = makeHandle();
    const speed = agent.model === 'mock-slow' ? 2.5 : (opts.settings?.mockSpeed || 1);
    const timers = new Set();
    let stopped = false, text = '';
    const steers = [];
    const wait = (ms) => new Promise((res) => { const t = setTimeout(() => { timers.delete(t); res(); }, ms * speed); timers.add(t); });
    const sid = resumeId || `mock-${Date.now().toString(36)}`;

    (async () => {
      emit({ type: 'session', id: sid });
      emit({ type: 'meta', model: agent.model || 'mock-fast' });
      emit({ type: 'thinking', text: `${tr('요청을 읽고 할 일을 정리하는 중…')}\n` });
      await wait(900);
      let n = 0;
      const phase = meetingPhase(prompt);
      const goal = !phase && isGoalTurn(prompt);
      const review = !phase && !goal ? reviewTurn(prompt) : null;
      const prep = !phase && !goal && !review ? prepTurn(prompt) : null;
      const plan = !phase && !goal && !review && !prep ? planTurn(prompt) : null;
      const card = !phase && !goal && !review && !prep && !plan ? cardTurn(prompt) : null;
      // 회의 중과 목표 잡기·기준 판정·조사 질문·일 계획 차례에는 도구를 쓰지 않는다(파일을 고치지 말라는 지시와 같게). 훑어보기·조사는 웹 검색만
      for (const [name, input, ms] of (phase || goal || review || plan || prep?.kind === 'questions' ? [] : prep ? PLANS().조사.slice(0, 1) : PLANS()[roleKey(agent.role)] || [])) {
        if (stopped) break;
        const id = `t${++n}`;
        emit({ type: 'tool', id, name, input, status: 'running' });
        await wait(ms);
        if (name === tr('파일 쓰기') && cwd && agent.permission !== 'plan') {
          try { fs.writeFileSync(path.join(cwd, resultFile()), `# ${tr('데모 결과')}\n\n${topic(prompt)}\n`); } catch { /* 폴더 없음 */ }
        }
        emit({ type: 'tool', id, name, status: 'done', output: tr('{name} 완료(데모)', { name }) });
      }
      if ((phase || goal || review || plan || prep?.kind === 'questions') && !stopped) await wait(1200); // 읽고 생각하는 시간
      // 일 카드 차례는 역할 답 뒤에 끝의 두 칸(바꾼 파일·다음 카드가 알아야 할 것)을 붙인다
      const tail = card ? `\n\n${tr('바꾼 파일')}: ${agent.permission === 'plan' ? tr('없음') : resultFile()}\n${tr('다음 카드가 알아야 할 것')}: ${tr('{id} 카드는 데모라 결과 파일 하나만 만들었어.', { id: card })}` : '';
      const body = phase ? meetingAnswer(phase, roleKey(agent.role), isOpposer(prompt), asksCheck(prompt), prompt) : goal ? goalAnswer(prompt) : review ? reviewAnswer(review)
        : prep ? prepAnswer(prep, prompt) : plan ? planAnswer(plan) : answer(roleKey(agent.role), agent.name, prompt) + tail;
      for (let i = 0; i < body.length && !stopped;) {
        const step = 2 + Math.floor(Math.random() * 5);
        const piece = body.slice(i, i + step);
        i += step;
        text += piece;
        emit({ type: 'text', text: piece });
        await wait(28 + Math.random() * 30);
        // 추가 지시는 줄이 끝난 자리에서만 끼워 넣는다(제목·문장 중간이 깨지지 않게)
        while (steers.length && !stopped && text.endsWith('\n')) {
          const s = `\n> 📝 ${tr('추가 지시 반영: {text}', { text: steers.shift() })}\n\n`;
          text += s;
          emit({ type: 'text', text: s });
        }
      }
      while (steers.length && !stopped) {
        const s = `\n\n> 📝 ${tr('추가 지시 반영: {text}', { text: steers.shift() })}\n`;
        text += s;
        emit({ type: 'text', text: s });
      }
      if (!stopped) {
        const inTok = Math.ceil(prompt.length / 2), outTok = Math.ceil(text.length / 2);
        emit({ type: 'usage', input: inTok, output: outTok, cacheRead: 0, cacheWrite: 0, cost: 0 });
      }
      h.resolve({ text, providerSessionId: sid, error: null, stopped });
    })();

    return {
      done: h.done,
      steer: (t) => { if (stopped) return false; steers.push(t); return true; },
      stop: () => { stopped = true; for (const t of timers) clearTimeout(t); timers.clear(); h.resolve({ text, providerSessionId: sid, error: null, stopped: true }); },
    };
  },
};
