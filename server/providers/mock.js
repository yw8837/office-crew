// 데모 어댑터: 실제 AI 호출 없이(사용량 0) 생각→도구→타이핑 흐름을 흉내 낸다. 화면·애니메이션·개입 기능 체험과 테스트용
import fs from 'node:fs';
import path from 'node:path';
import { makeHandle } from './util.js';
import { tr } from '../i18n.js';
import { roleKind } from '../routing.js';

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
  if (prompt.includes(tr('[회의 — 결론 내기]'))) return 'conclude';
  if (prompt.includes(tr('가장 약한 가정: 누구의 무엇이고 왜'))) return 'review';
  if (prompt.includes(tr('내가 틀렸다고 볼 기준: 무엇이 확인되면 이 주장을 버릴지'))) return 'opinion';
  return null;
}
const OPINIONS = () => ({
  조사: [tr('자료로 확인된 수요가 가장 큰 안으로 가자.'), tr('자료 3건이 같은 방향을 가리키고, 비슷한 사례가 2건 있어.'), tr('반대되는 자료가 2건 넘게 나오면 버릴게.'), tr('중간')],
  정리: [tr('한 문장으로 설명되는 가장 단순한 안으로 가자.'), tr('설명이 짧을수록 전달이 쉽고, 준비할 것도 적어.'), tr('설명에 세 문장이 넘게 필요해지면 버릴게.'), tr('중간')],
  분석: [tr('위험이 가장 작은 안을 작게 먼저 해 보자.'), tr('되돌리기 쉽고, 틀려도 드는 비용이 작아.'), tr('작게 해 봤는데 효과가 안 보이면 버릴게.'), tr('높음')],
  빌드: [tr('지금 있는 것으로 이번 주 안에 만들 수 있는 안으로 가자.'), tr('새로 들일 것이 없고, 시험해 보기도 쉬워.'), tr('새로 만들 부품이 둘 넘게 필요해지면 버릴게.'), tr('중간')],
});
const REVIEWS = () => ({
  조사: [tr('작게 먼저 해 보자는 의견이야. 틀려도 손해가 작아.'), tr('"한 문장이면 충분하다"는 가정이야. 처음 보는 사람에게도 통하는지 몰라.'), tr('자료 3건 중 2건은 출처가 같아서 하나로 셀게.'), tr('수요가 확인된 안을 작게 시작하는 데 동의해.')],
  정리: [tr('자료로 수요를 확인했다는 의견이야.'), tr('"이번 주 안에 된다"는 가정이야. 시험할 시간이 빠져 있어.'), tr('단순한 안이 곧 좋은 안은 아니라는 점을 받아들일게.'), tr('수요가 확인된 안 쪽으로 바꿨어.')],
  분석: [tr('근거를 숫자로 댄 의견이야.'), tr('"다들 원한다"는 가정이야. 확인한 사람이 아직 적어.'), tr('범위를 절반으로 줄일게.'), tr('작게 먼저 해 보는 쪽으로 바꿨어.')],
  빌드: [tr('위험이 작은 것부터 하자는 의견이야.'), tr('"자료 3건이면 충분하다"는 가정이야.'), tr('새 부품 없이 되는지 먼저 확인할게.'), tr('범위가 작다면 이번 주 안에 만들 수 있어.')],
});
function meetingAnswer(phase, role) {
  if (phase === 'opinion') {
    const [claim, why, wrong, sure] = OPINIONS()[role] || OPINIONS().분석;
    return [`- **${tr('주장')}**: ${claim}`, `- **${tr('근거')}**: ${why}`, `- **${tr('내가 틀렸다고 볼 기준')}**: ${wrong}`, `- **${tr('확신')}**: ${sure}`].join('\n');
  }
  if (phase === 'review') {
    const [best, weak, fix, now] = REVIEWS()[role] || REVIEWS().분석;
    return [`- **${tr('가장 설득력 있는 점')}**: ${best}`, `- **${tr('가장 약한 가정')}**: ${weak}`, `- **${tr('내 의견에서 고칠 점')}**: ${fix}`, `- **${tr('지금 내 입장')}**: ${now}`].join('\n');
  }
  return [
    `## ${tr('회의 결론')}`, '',
    `- **${tr('결정')}**: ${tr('합침. 수요가 확인된 안을, 가장 작은 범위로 먼저 만든다.')}`,
    `- **${tr('근거')}**: ${tr('자료가 같은 방향이고, 작게 시작하면 되돌리기 쉬워.')}`,
    `- **${tr('남은 이견')}**: ${tr('범위를 어디까지 줄일지는 의견이 갈렸어.')}`,
    `- **${tr('다음 할 일')}**: ${tr('조사 담당은 반대 자료를 확인하고, 빌드 담당은 첫 화면을 만들어.')}`,
  ].join('\n');
}

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
      // 회의 중에는 도구를 쓰지 않는다(파일을 고치지 말라는 회의 지시와 같게)
      for (const [name, input, ms] of (phase ? [] : PLANS()[roleKey(agent.role)] || [])) {
        if (stopped) break;
        const id = `t${++n}`;
        emit({ type: 'tool', id, name, input, status: 'running' });
        await wait(ms);
        if (name === tr('파일 쓰기') && cwd && agent.permission !== 'plan') {
          try { fs.writeFileSync(path.join(cwd, resultFile()), `# ${tr('데모 결과')}\n\n${topic(prompt)}\n`); } catch { /* 폴더 없음 */ }
        }
        emit({ type: 'tool', id, name, status: 'done', output: tr('{name} 완료(데모)', { name }) });
      }
      if (phase && !stopped) await wait(1200); // 읽고 생각하는 시간
      const body = phase ? meetingAnswer(phase, roleKey(agent.role)) : answer(roleKey(agent.role), agent.name, prompt);
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
