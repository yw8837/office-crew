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
      for (const [name, input, ms] of PLANS()[roleKey(agent.role)] || []) {
        if (stopped) break;
        const id = `t${++n}`;
        emit({ type: 'tool', id, name, input, status: 'running' });
        await wait(ms);
        if (name === tr('파일 쓰기') && cwd && agent.permission !== 'plan') {
          try { fs.writeFileSync(path.join(cwd, resultFile()), `# ${tr('데모 결과')}\n\n${topic(prompt)}\n`); } catch { /* 폴더 없음 */ }
        }
        emit({ type: 'tool', id, name, status: 'done', output: tr('{name} 완료(데모)', { name }) });
      }
      const body = answer(roleKey(agent.role), agent.name, prompt);
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
