// 목표의 완주 보고(결정 0025): 목표가 끝나면(통과·받아들임·중지) 코드가 아는 사실로만 묶는다(AI 호출 없음).
// 사실을 먼저: 끝 상태·걸린 시간·실제 호출과 어림·종류별 답 수·기준별 최종 판정·사용자가 누른 것·확인 못 한 것·실패 종류·배정이 평소와 다른 횟수.
// 에이전트가 쓴 글(기준의 근거, 회의 결론의 결정·남은 이견)은 따로 표시를 달고 길이 상한까지만. 바뀐 파일 목록은 오케스트레이터가 git 으로 채운다.
// 글 판(reportText)은 사용자가 "기억에 넣기"를 누를 때 프로젝트 기억에 넣는 글이다: 코드가 모은 사실과 기준별 결과만(회의 결론·조사 노트는 넣지 않는다)
import { tr } from './i18n.js';
import { verdictWord, answerNames, durationWords, unverifiedLines, failWords, raisedWords } from '../public/js/report-lines.js'; // 화면과 같은 글줄
import { answerKind, weighted } from '../public/js/usage-numbers.js'; // 답의 종류는 세션의 "어디에 썼는지"와 같은 함수(결정 0026)
import { redact } from './memory.js'; // 실행 기록 내보내기의 비밀 가리기는 기억과 같은 함수(결정 0030)
import { isQuotaError, isTransientError } from './failover.js';
import { maskMore } from './mission.js'; // 메일 주소·Bearer 꼴 가리기(반복 실패 줄과 같은 함수)

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

// ── 실행 기록 내보내기(결정 0030) ──
// 목표 하나의 실행을 JSON 하나로: 목표·기준, 카드와 상태, 진행 기록, 회의 결론·사용자가 정한 것, 호출(답)마다 누가·어느 AI·모델·종류·시작/끝·사용량·배정·실패 종류, 완주 보고의 사실, 실행의 단계.
// 답 글·요청 글·카드 꼬리(에이전트가 쓴 끝의 두 칸)는 body 일 때만. 프롬프트 전문은 앱이 저장하지 않아서 넣지 못한다(notes.prompts).
// 모든 글은 내보내기 전에 가린다(exportCleaner): 설정의 비밀 값(API 키·알림 주소·앱 토큰 등, secrets)을 그대로 찾아 가리고, 기억과 같은 토큰 모양 가리기(redact),
// 메일 주소·"Bearer 글자"(maskMore), 이름_KEY=값·이름_TOKEN=값·이름_SECRET=값 꼴의 값, 절대 경로는 작업 폴더(roots: 목표가 돈 폴더) 안이면 "." 기준 상대 경로로,
// 앱 데이터 폴더는 <data>, 사용자 홈은 ~ 로 바꾼다(긴 경로부터)
export const EXPORT_FORMAT = 'office-crew-goal-run';
export const EXPORT_VERSION = 1;
export const SECRET_MASK = '••••••••';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '[\\\\/]+'; // 경로 구분자 하나 이상(역슬래시·슬래시 섞임, JSON 이스케이프의 두 겹 역슬래시도)
const AFTER = '(?=$|[\\\\/"\'`\\s)\\]},;:>])'; // 뿌리 경로 뒤: 구분자·글 끝·따옴표·공백·닫는 괄호·쉼표·쌍반점·쌍점(D:\work\app2 가 D:\work\app 로 읽히지 않게)
// 뿌리 경로 하나 → 찾을 정규식. 드라이브가 있는 경로(Windows)는 C:\…·c:/… 와 Git Bash 의 /c/…, WSL 의 /mnt/c/… 꼴까지, 대소문자 무시.
// 드라이브가 없는 경로(POSIX)는 그대로(대소문자 구분). 앞이 글자·숫자·점·물결·붙임표면 다른 경로의 한가운데라 바꾸지 않는다
export function rootPattern(p) {
  const parts = String(p ?? '').split(/[\\/]+/).filter(Boolean);
  const drive = /^[A-Za-z]:$/.test(parts[0] || '') ? parts.shift()[0] : '';
  if (!parts.length) return null;
  const rest = parts.map(escRe).join(SEP);
  const head = drive ? `(?:${drive}:|/${drive}|/mnt/${drive})` : '';
  return new RegExp(`(?<![\\w.~-])${head}${SEP}${rest}${AFTER}`, drive ? 'gi' : 'g');
}
const ENV_SECRET = /(\b[A-Za-z][A-Za-z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'&,;]+)/gi;
export function exportCleaner({ secrets = [], roots = [], dataDir = '', home = '' } = {}) {
  const keys = [...new Set(secrets.map((x) => String(x ?? '')).filter((x) => x.length >= 4))].sort((a, b) => b.length - a.length);
  const pathRes = [...roots.filter(Boolean).map((p) => [p, '.']), ...(dataDir ? [[dataDir, '<data>']] : []), ...(home ? [[home, '~']] : [])]
    .map(([p, to]) => [String(p).replace(/[\\/]+$/, ''), to]).filter(([p]) => p).sort((a, b) => b[0].length - a[0].length)
    .map(([p, to]) => [rootPattern(p), to]).filter(([re]) => re);
  return (v) => {
    let x = String(v);
    for (const k of keys) x = x.split(k).join(SECRET_MASK);
    x = maskMore(redact(x)).replace(ENV_SECRET, `$1${SECRET_MASK}`);
    for (const [re, to] of pathRes) x = x.replace(re, to);
    return x;
  };
}
// 실패 종류(코드가 오류 문구로 가를 수 있는 것만): 사용량 한도 outside, 일시 장애 transient, 그 밖 unknown
export const answerFail = (error) => (isQuotaError(error) ? 'outside' : isTransientError(error) ? 'transient' : 'unknown');
// 본문을 빼면(body false) 사용자가 쓴 글도 뺀다: 세션 제목(첫 요청 앞부분), 진행 기록의 추가 지시 줄(글 없이 종류만), 완주 보고의 같은 줄.
// 회의 질문에 사용자가 고른 답(decided, 답 줄)은 "사용자가 정한 것"이라 그대로 둔다
const userText = (x) => x?.by === 'user' && x.kind === 'note';
export function exportRun({ s, m, nameOf = (id) => id, body = false, secrets = [], roots = [], dataDir = '', home = '', now = Date.now(), appVersion = '' }) {
  const clean = exportCleaner({ secrets, roots, dataDir, home });
  const deep = (v) => (typeof v === 'string' ? clean(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  const who = (id) => (id ? { id: String(id), name: String(nameOf(id) || id) } : null);
  const runs = (s.runs || []).filter((r) => r.missionId === m.id);
  const runIds = new Set(runs.map((r) => r.id));
  const answers = (s.messages || []).filter((x) => x.role === 'agent' && (x.missionId === m.id || runIds.has(x.runId)));
  const first = (t) => [...String(t || '').split(/\r?\n/).find((l) => l.trim()) || ''].slice(0, 300).join('');
  const rep = m.reportMsgId ? (s.messages || []).find((x) => x.id === m.reportMsgId && x.kind === 'report') : null;
  const report = rep ? Object.fromEntries(Object.entries(rep).filter(([k]) => !['id', 'role', 'kind', 'status', 'text', 'createdAt', 'missionId', 'memory', 'memFolder'].includes(k))) : null;
  // 본문을 빼면 사용자가 쓴 추가 지시 줄은 글 없이(종류·시각·누가만), 완주 보고의 "사용자가 확정한 것"에서도 같은 줄의 글을 뺀다
  const omit = new Set(body ? [] : (m.log || []).filter(userText).map((x) => x.text));
  if (report && !body && Array.isArray(report.user)) report.user = report.user.map((u) => (omit.has(u.text) ? { at: u.at, textOmitted: true } : u));
  const out = {
    format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date(now).toISOString(), app: { version: appVersion }, body: !!body,
    notes: { prompts: 'not-stored', paths: 'work-folder-relative', masked: ['secrets', 'token-like text', 'absolute paths'], ...(body ? {} : { omitted: ['answer text', 'request text', 'session title', 'extra instruction text', 'card closing lines'] }) },
    session: { id: s.id, title: body ? s.title || '' : '' },
    goal: {
      id: m.id, status: m.status, goal: m.goal || '', work: m.work || 'stages', createdAt: m.createdAt || 0, confirmedAt: m.confirmedAt || 0, editedByUser: !!m.editedByUser,
      criteria: (m.criteria || []).map((c) => ({ id: c.id, text: c.text, status: c.status || 'open', evidence: c.evidence || '', ...(c.check ? { check: c.check } : {}) })),
      outOfScope: [...(m.outOfScope || [])], userDecides: [...(m.userDecides || [])], mustKeep: [...(m.mustKeep || [])],
      lead: who(m.leadId), reviewer: who(m.reviewerId), dropped: [...(m.dropped || [])], prep: m.prep || null,
      calls: m.calls || null, estimate: m.estimate || null, round: m.round || 0, returns: m.returns || 0, returnCap: m.returnCap ?? null,
      ...(body ? { request: m.request || '' } : {}),
    },
    research: m.research ? { questions: (m.research.questions || []).map((q) => ({ id: q.id, text: q.text, status: q.status, agent: who(q.agentId) })), ...(m.research.fallback ? { fallback: true } : {}) } : null,
    cards: (m.cards || []).map((c) => ({
      id: c.id, title: c.title, owner: who(c.ownerId), kind: c.kind, needs: [...(c.needs || [])], files: [...(c.files || [])], done: c.done || '', not: c.not || '',
      status: c.status, ...(c.by ? { by: c.by } : {}), ...(c.reason ? { reason: c.reason } : {}), starts: c.starts || 0, cap: c.cap || 0,
      ...(c.raised?.length ? { raised: c.raised.map((r) => ({ from: who(r.from), to: who(r.to), at: r.at, why: r.why, ...(r.later ? { later: true } : {}) })) } : {}),
      ...(c.proof ? { proof: { files: [...(c.proof.files || [])], at: c.proof.at } } : {}), msgId: c.msgId || null, ...(body && c.tail ? { tail: c.tail } : {}),
    })),
    log: (m.log || []).map((x) => ({ at: x.at, kind: x.kind, ...(body || !userText(x) ? { text: x.text } : { textOmitted: true }), ...(x.msgId ? { msgId: x.msgId } : {}), ...(x.fail ? { fail: x.fail } : {}), ...(x.by ? { by: x.by } : {}), ...(x.agentKind ? { agentKind: x.agentKind } : {}), ...(x.n ? { n: x.n } : {}) })),
    meetings: (m.meetings || []).map((x) => ({ ...x })), decided: (m.decided || []).map((x) => ({ ...x })),
    calls: answers.map((x) => ({
      msgId: x.id, runId: x.runId || null, stageIndex: x.stageIndex ?? null, stage: x.stageLabel || '', agent: who(x.agentId),
      provider: x.provider || '', model: x.model || '', effort: x.effort || '', kind: answerKind(x, { goal: true }), status: x.status,
      start: x.createdAt || 0, end: (x.createdAt || 0) + (x.usage?.durationMs || 0),
      usage: { input: x.usage?.input || 0, output: x.usage?.output || 0, cacheRead: x.usage?.cacheRead || 0, cacheWrite: x.usage?.cacheWrite || 0, cost: x.usage?.cost || 0, weighted: weighted(x.usage || {}) },
      route: x.route || null, ...(x.card ? { card: x.card.id } : {}), ...(x.aiChain ? { aiChain: [...x.aiChain] } : {}),
      ...(x.status === 'error' ? { fail: answerFail(x.error), error: first(x.error) } : {}),
      ...(body ? { text: x.text || '' } : {}),
    })),
    report,
    runs: runs.map((r) => ({ id: r.id, mission: r.mission, status: r.status, startedAt: r.startedAt || 0, endedAt: r.endedAt || null, ...(r.resumed ? { resumed: true } : {}),
      stages: (r.stages || []).map((st) => ({ label: st.label, status: st.status, ...(st.mission ? { mission: st.mission } : {}), agents: (st.agentIds || []).map(who), ...(st.cardIds ? { cardIds: [...st.cardIds] } : {}), ...(st.raised ? { raised: true } : {}) })) })),
  };
  return deep(JSON.parse(JSON.stringify(out)));
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
