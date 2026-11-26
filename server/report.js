// 목표의 완주 보고(결정 0025): 목표가 끝나면(통과·받아들임·중지) 코드가 아는 사실로만 묶는다(AI 호출 없음).
// 사실을 먼저: 끝 상태·걸린 시간·실제 호출과 어림·종류별 답 수·기준별 최종 판정·사용자가 누른 것·확인 못 한 것·실패 종류·배정이 평소와 다른 횟수.
// 에이전트가 쓴 글(기준의 근거, 회의 결론의 결정·남은 이견)은 따로 표시를 달고 길이 상한까지만. 바뀐 파일 목록은 오케스트레이터가 git 으로 채운다.
// 글 판(reportText)은 사용자가 "기억에 넣기"를 누를 때 프로젝트 기억에 넣는 글이다: 코드가 모은 사실과 기준별 결과만(회의 결론·조사 노트는 넣지 않는다)
import { tr } from './i18n.js';
import { verdictWord, answerNames, durationWords, unverifiedLines, failWords, raisedWords } from '../public/js/report-lines.js'; // 화면과 같은 글줄
import { answerKind } from '../public/js/usage-numbers.js'; // 답의 종류는 세션의 "어디에 썼는지"와 같은 함수(결정 0026)

export const REPORT_EVIDENCE = 200; // 보고에 싣는 기준 근거(에이전트가 씀) 하나의 최대 글자
export const REPORT_USER = 30; // 보고에 싣는 "사용자가 누른 것" 줄 수(넘으면 앞을 버리고 수만 센다)
export const REPORT_TEXT_MAX = 6000; // 기억에 넣는 글 판의 최대 글자

const cut = (s, max) => { const c = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return c.length > max ? c.slice(0, max).join('') : c.join(''); };


// 이 목표의 실행(목표 잡기·일 실행. 실행 기록이 잘렸으면 남은 것만)
const runsOf = (m, runs) => (runs || []).filter((r) => r.missionId === m.id && (r.mission === 'goal' || r.mission === 'work'));

// 이 목표를 내 PC 모델만 받았는가(결정 0007): 그 목표의 실행에서 내 PC 모델이 답했거나(이어받기 사슬 포함) 요청이 내 PC 전용 표시.
// 그러면 기억에 넣을 때 내 PC 모델 표시(provider 'local')로 넣어 클라우드 AI 에게 줄 기억에서 빠지게 한다
export function reportLocal({ m, messages = [], runs = [] }) {
  const ids = new Set(runsOf(m, runs).map((r) => r.id));
  if (messages.some((x) => x.role === 'agent' && ids.has(x.runId) && (x.provider === 'local' || (x.aiChain || []).includes('local')))) return true;
  return !!m.requestMsgId && messages.some((x) => x.id === m.requestMsgId && x.role === 'user' && x.local === true);
}

// 완주 보고 값(메시지에 그대로 싣는다). m: 끝난 목표, messages·runs: 세션의 것, now: 끝난 시각, nameOf: 에이전트 id → 이름(보고를 만들 때의 이름으로 적는다)
export function buildReport({ m, messages = [], runs = [], now = Date.now(), nameOf = (id) => id }) {
  const mine = runsOf(m, runs);
  const ids = new Set(mine.map((r) => r.id));
  // 종류별 답 수는 오류·중지로 끝난 답도 센다(그 답에도 호출이 들었다). 그중 끝나지 못한 답의 수는 따로(answerFails)
  const answers = { goal: 0, research: 0, meeting: 0, plan: 0, cards: 0, work: 0, review: 0 };
  let answerFails = 0;
  for (const x of messages) {
    if (x.role !== 'agent' || !ids.has(x.runId)) continue;
    // 이 목표의 실행에서 고른 답이라 표시 없는 답은 일 단계. 팀 초안·인수인계 메모는 목표 실행에 생기지 않는다(생겨도 일 단계로 센다)
    const k = answerKind(x, { goal: true });
    answers[k in answers ? k : 'work']++;
    if (x.status !== 'done') answerFails++;
  }
  const log = m.log || [];
  // 사용자가 고른 것: 사용자가 고른 것을 적는 곳이 단 표시(by: 'user')가 있는 줄만(목표 카드 확인, 묻는 창의 답, 추가 지시, 끊긴 목표 이어서).
  // 표시가 하나도 없는 옛 기록은 예전처럼 줄 종류로 고른다(확인·답 줄, 메시지를 가리키는 추가 지시·이어서 줄)
  const marked = log.some((x) => x.by);
  const users = log.filter((x) => (marked ? x.by === 'user' : x.kind === 'confirm' || x.kind === 'answer' || ((x.kind === 'note' || x.kind === 'resume') && x.msgId))).map((x) => ({ at: x.at || 0, text: x.text }));
  // 실패 종류: 줄마다 단 fail 을 센다. 판정이 사용량 한도로 끝난 사건은 한도(quota) 줄과 판정(review) 줄 두 줄로 남으니(둘 다 outside) 한도 줄로 한 번만 센다
  const fails = {};
  for (const x of log) if (x.fail && !(x.kind === 'review' && x.fail === 'outside')) fails[x.fail] = (fails[x.fail] || 0) + 1;
  const lastWork = mine.filter((r) => r.mission === 'work').at(-1);
  const qs = m.research?.questions || [];
  // 회의 결론(결정 0025의 구조): 회의마다(준비 회의, 팀 회의 단계 번호) 가장 최근 결론의 결정과 남은 이견만
  const meet = new Map();
  for (const x of m.meetings || []) meet.set(x.prep ? 'prep' : `s${x.stageIndex}`, x);
  return {
    end: m.status, goal: m.goal || '',
    from: m.confirmedAt || m.createdAt || now, to: now,
    calls: { used: Number(m.calls?.used) || 0, cap: Number(m.calls?.cap) || 0 },
    estimate: m.estimate ? { min: m.estimate.min, max: m.estimate.max } : null,
    answers, answerFails,
    criteria: (m.criteria || []).map((c) => ({ id: c.id, text: c.text, status: c.status || 'open', evidence: cut(c.evidence, REPORT_EVIDENCE) })),
    user: users.slice(-REPORT_USER), userMore: Math.max(0, users.length - REPORT_USER),
    unverified: {
      unknown: (m.criteria || []).filter((c) => c.status === 'unknown').map((c) => c.id),
      open: (m.criteria || []).filter((c) => !['pass', 'fail', 'unknown'].includes(c.status)).map((c) => c.id),
      research: qs.length ? { total: qs.length, missing: qs.filter((q) => q.status !== 'done').length } : null,
      cards: (m.cards || []).filter((c) => ['hole', 'blocked', 'skipped'].includes(c.status)).map((c) => ({ id: c.id, status: c.status, ...(c.by ? { by: c.by } : {}) })),
      proof: (m.cards || []).filter((c) => c.proof).map((c) => ({ id: c.id, files: [...(c.proof.files || [])] })),
      skipped: (lastWork?.stages || []).filter((st) => st.status === 'skipped').map((st) => String(st.label || '')),
      quota: log.filter((x) => x.kind === 'quota').length,
      noProgress: log.filter((x) => x.kind === 'no-progress').length, // 한 번 더 해도 같은 기준이 같은 근거로 걸린 회차(결정 0028)
    },
    fails, routes: log.filter((x) => x.kind === 'route').length,
    // 윗등급에게 넘긴 카드(결정 0027): 카드 기록(raised)에서 카드마다 처음 담당 → 넘겨받은 담당들(이름)
    raised: (m.cards || []).filter((c) => c.raised?.length).map((c) => ({ id: c.id, chain: [c.raised[0].from, ...c.raised.map((r) => r.to)].map((id) => String(nameOf(id) || id)) })),
    logCut: log[0]?.kind === 'skip' ? Number(log[0].n) || 0 : 0,
    meetings: [...meet.values()].map((x) => ({ ...(x.prep ? { prep: true } : { stageIndex: x.stageIndex, label: String(lastWork?.stages?.[x.stageIndex]?.label || '') }), msgId: x.msgId, decision: x.decision || '', dissent: [...(x.dissent || [])] })),
  };
}

// 끝 상태 이름(흐름 무대의 끝 깃발과 같은 말)
const endWord = (s) => ({ done: tr('통과로 끝'), accepted: tr('받아들여 끝'), stopped: tr('중지됨') }[s] || s);

// 완주 보고의 글 판(프로젝트 기억에 넣는 글). 머리에 출처(report, 목표 id, 시각)와 "사용자가 확정하지 않은 기록" 표시.
// 코드가 모은 사실과 기준별 결과만 넣고, 에이전트가 쓴 근거는 "에이전트가 씀" 표시와 함께. 회의 결론·조사 노트는 넣지 않는다(저장소 주인 결정)
export function reportText(r, { missionId = '' } = {}) {
  const d = new Date(r.to || Date.now());
  const p = (x) => String(x).padStart(2, '0');
  const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const a = r.answers || {};
  const names = answerNames(tr);
  const lines = [
    tr('[완주 보고 — 코드가 모은 기록]'),
    tr('출처: 완주 보고(report) · 목표 {id} · {time} · 사용자가 확정하지 않은 기록', { id: missionId, time }),
    `${tr('목표')}: ${cut(r.goal, 200)}`,
    `${tr('끝 상태')}: ${endWord(r.end)} · ${tr('확인부터 끝까지 {t}', { t: durationWords(tr, (r.to || 0) - (r.from || 0)) })} · ${r.estimate ? tr('실제 호출 {k}번(어림 {min}~{max}번)', { k: r.calls?.used ?? 0, min: r.estimate.min, max: r.estimate.max }) : tr('실제 호출 {k}번', { k: r.calls?.used ?? 0 })} · ${tr('상한 {cap}번', { cap: r.calls?.cap ?? 0 })}`,
    `${tr('종류별 답 수')}: ${Object.keys(names).map((k) => `${names[k]} ${a[k] || 0}`).join(' · ')}${r.answerFails ? ` ${tr('(오류·중지로 끝난 답 {n}개 포함)', { n: r.answerFails })}` : ''}`,
    `${tr('기준별 결과')}:`,
    ...(r.criteria || []).map((c) => `- ${c.id} ${verdictWord(tr, c.status)}: ${cut(c.text, 300)}${c.evidence ? `\n  ${tr('근거(에이전트가 씀)')}: ${c.evidence}` : ''}`),
  ];
  if (r.user?.length) lines.push(`${tr('사용자가 확정한 것')}:`, ...r.user.map((x) => `- ${cut(x.text, 200)}`));
  const u = unverifiedLines(tr, r);
  if (u.length) lines.push(`${tr('확인 못 한 것')}:`, ...u.map((x) => `- ${x}`));
  const f = failWords(tr, r.fails);
  if (f) lines.push(`${tr('실패 종류')}: ${f}`);
  if (r.routes) lines.push(tr('배정이 평소와 달랐던 답: {n}개', { n: r.routes }));
  const up = raisedWords(tr, r.raised);
  if (up) lines.push(up);
  if (r.files?.list?.length) lines.push(`${tr('바뀐 파일(git)')}: ${r.files.list.slice(0, 20).join(', ')}${r.files.list.length > 20 || r.files.more ? ` ${tr('…(그 밖에 {n}개)', { n: r.files.list.length - Math.min(20, r.files.list.length) + (r.files.more || 0) })}` : ''}`);
  const text = [...lines.join('\n')];
  return text.length > REPORT_TEXT_MAX ? text.slice(0, REPORT_TEXT_MAX).join('') : text.join('');
}
