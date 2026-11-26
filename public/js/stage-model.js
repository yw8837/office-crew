// 흐름 무대(세션 화면 위쪽 그림)의 모델. DOM 없이 실행·실시간 상태·목표·질문에서 "그릴 것"을 만든다.
// 화면(views/stage.js)과 테스트(test/stage-model.test.js)가 같이 쓴다.
// 단계 이름·에이전트 이름·목표 글·말한 내용은 바깥 글이라 글 그대로 담고, 화면은 글자로만 넣는다(HTML 로 넣지 않는다)
import { t, locale } from './i18n/index.js';
import { meetingView, researcherOf, isTalking } from './office/meeting.js';

export const MAX_STATIONS = 6; // 역이 이보다 많으면 지난 역을 접는다
export const MAX_PEOPLE = 4; // 역마다 보일 사람 수(넘으면 +n)
const ACTIVE = new Set(['running', 'paused', 'waiting']);

// 회의 차례 이름: 의견 1/3, 차례 2/3, 조사 2/3, 판정 2/3, 결론. 그 밖(옛 세션의 'review')은 검토 2/2
export const meetLabel = (m) => (m.phase === 'conclude' ? t('결론') : m.phase === 'opinion' ? t('의견 {r}/{n}', { r: m.round, n: m.rounds }) : m.phase === 'turn' ? t('차례 {r}/{n}', { r: m.round, n: m.rounds }) : m.phase === 'research' ? t('조사 {r}/{n}', { r: m.round, n: m.rounds }) : m.phase === 'judge' ? t('판정 {r}/{n}', { r: m.round, n: m.rounds }) : t('검토 {r}/{n}', { r: m.round, n: m.rounds }));

// 목표의 판정 뒤 묻기·호출 상한·한도 대기·구독 한도 상한(결정 0015·0019·0026)으로 i 단계가 기다리면 그 사유('mission'|'cap'|'quota'|'limitcap'), 아니면 ''
export const holdKind = (run, i) => (run && run.status === 'waiting' && run.hold?.stageIndex === i && ['mission', 'cap', 'quota', 'limitcap'].includes(run.hold.reason) ? run.hold.reason : '');
// 단계 띠("사무실 크게" 보기의 진행 바)에 보일 표시. 끝난 판정 단계가 ✓ 로 보여 다 끝난 것처럼 읽히지 않게
export const goalWait = (run, i) => ({ mission: '🎯', cap: '🔢', quota: '⏳', limitcap: '📊' }[holdKind(run, i)] || '');

// 끝난 목표의 끝 깃발 이름. 완주 보고 카드(결정 0025)도 같은 말을 써서 둘이 어긋나지 않게 한다
export const goalEndWord = (status) => ({ done: t('통과로 끝'), accepted: t('받아들여 끝'), stopped: t('중지됨') }[status] || '');

// 서버의 에이전트 상태(agentState.state) → 무대의 사람 상태
const LIVE = { thinking: 'think', typing: 'write', tool: 'tool', searching: 'tool', reading: 'tool', running: 'tool', waiting: 'wait', error: 'error', done: 'done', paused: 'limit', offline: 'off', idle: 'idle' };
const TOOL_OF = { searching: 'search', reading: 'read', running: 'run' };
const EDIT = /edit|write|replace|patch|create|insert|apply/i; // 파일을 고치는 도구(할 일 목록 쓰기는 빼고)
const NOT_EDIT = /todo/i;
export const BUSY = new Set(['think', 'write', 'tool', 'meet']);

function personSt(l) {
  if (!l) return { st: 'idle', tool: null };
  const st = LIVE[l.state] || 'idle';
  return { st, tool: st === 'tool' ? TOOL_OF[l.state] || (EDIT.test(String(l.tool || '')) && !NOT_EDIT.test(String(l.tool || '')) ? 'edit' : 'other') : null };
}

// 사람 상태 → 표식(모양 class·아이콘·글). 색만으로 구분하지 않게 상태마다 아이콘과 모양이 다르다
export function personInfo(p) {
  switch (p?.st) {
    case 'think': return { cls: 'think', icon: 'dots', text: t('생각 중') };
    case 'write': return { cls: 'write', icon: 'write', text: t('작성 중') };
    case 'tool': return { cls: 'tool', ...({ search: { icon: 'search', text: t('검색 중') }, read: { icon: 'book', text: t('자료 읽는 중') }, run: { icon: 'term', text: t('실행 중') }, edit: { icon: 'edit', text: t('편집 중') } }[p.tool] || { icon: 'tool', text: t('도구 사용') }) };
    case 'meet': return { cls: 'meet', icon: 'chat', text: p.speaker ? t('말하는 중') : t('회의 중') };
    case 'wait': return { cls: 'wait', icon: 'alert', text: t('내 답 기다림') };
    case 'limit': return { cls: 'limit', icon: 'hour', text: t('한도 대기') };
    case 'error': return { cls: 'error', icon: 'alert', text: t('오류') };
    case 'done': return { cls: 'done', icon: 'check', text: t('완료') };
    case 'off': return { cls: 'off', icon: 'unplug', text: t('끊김') };
    default: return { cls: 'idle', icon: 'moon', text: t('대기') };
  }
}

// 역 상태 → 머리줄 표식. todo 는 아이콘 없이 번호만
export function stationInfo(state) {
  return ({
    todo: { cls: 'idle', icon: null, text: t('할 일') },
    run: { cls: 'think', icon: 'dots', text: t('하는 중') },
    done: { cls: 'done', icon: 'check', text: t('끝') },
    wait: { cls: 'wait', icon: 'alert', text: t('기다림') },
    limit: { cls: 'limit', icon: 'hour', text: t('한도 대기') },
    error: { cls: 'error', icon: 'warn', text: t('오류') },
    skipped: { cls: 'idle', icon: 'skip', text: t('건너뜀') },
    stopped: { cls: 'off', icon: 'stop', text: t('중지됨') },
    cut: { cls: 'off', icon: 'unplug', text: t('끊김') },
  })[state] || { cls: 'idle', icon: null, text: t('할 일') };
}

// 실행 단계의 status → 역 상태
const ST_STATE = { pending: 'todo', running: 'run', done: 'done', review: 'wait', error: 'error', skipped: 'skipped', stopped: 'stopped' };

// 메시지에서 아직 답하지 않은 에이전트 질문(결정 0009): [{ id, agentId, runId, stageIndex, text }]
export function openQuestions(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    for (const a of m?.asks || []) {
      if (a.status !== 'open') continue;
      const q = a.questions?.[0];
      out.push({ id: a.id, agentId: String(m.agentId || ''), runId: m.runId || null, stageIndex: Number.isInteger(m.stageIndex) ? m.stageIndex : null, text: String(q?.question || q?.header || '') });
    }
  }
  return out;
}

// 실행을 시작한 내 말(목표 모드가 아닐 때 맨 위 줄에 보인다)
export function requestOf(messages, run) {
  if (!run?.userMessageId) return '';
  const m = (Array.isArray(messages) ? messages : []).find((x) => x.id === run.userMessageId);
  return m?.text || '';
}

const firstLine = (s) => [...(String(s || '').split(/\r?\n/).find((l) => l.trim()) || '').trim()].slice(0, 200).join('');
// 내 차례 알약·문을 누르면 갈 답 창. 다른 화면 파일(views/session.js·views/mission.js)의 클래스 이름이라
// test/stage-model.test.js 가 그 파일들에 이 이름이 실제로 있는지 본다(이름이 바뀌면 테스트가 깨진다)
export const ANSWER_BOX = {
  gate: '.chat-inner .mission-gate, .chat-inner .gate, .session > .mission-gate, .session > .gate',
  ask: '.composer-wrap .ask-panel:not(.mission-gate)',
  askMini: '.composer-wrap .ask-mini',
  cut: '.composer-wrap .warnbox',
  card: (id) => `.chat [data-mid="${id}"] .goal-card`,
};

// 시각: 한도 대기 창과 같은 24시간 HH:MM. 오늘이 아니면 날짜도 붙인다
export const fmtClock = (ms, nowMs = Date.now()) => {
  const d = new Date(ms);
  const same = new Date(nowMs).toDateString() === d.toDateString();
  return d.toLocaleString(locale(), same ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
};

// 기준 조각 접기: 한 줄에 max 칸까지. 넘치면 마지막 칸이 "+n"(숨은 기준은 툴팁·이름으로 읽는다)
export const MAX_CRIT = 3;
export function critFold(review, max = MAX_CRIT) {
  const list = Array.isArray(review) ? review : [];
  return list.length <= max ? { shown: list, hidden: [] } : { shown: list.slice(0, max - 1), hidden: list.slice(max - 1) };
}

/**
 * 흐름 무대의 모델.
 * run: 세션의 마지막 실행(없으면 null), live: 에이전트 id → 실시간 상태(agentState), mission: 세션의 목표(없으면 null),
 * questions: openQuestions 의 결과, agents: [{ id, name }](이름 찾기. 없는 id 는 지워진 에이전트), team: 세션의 팀(쉬는 세션의 역), solo: 팀이 없을 때의 에이전트,
 * conn: 'ok'|'lost'(서버 연결), now: 지금 시각(ms), prev: 바로 앞에 그린 모델(단계가 넘어갔는지 보려고), request: 실행을 시작한 내 말
 */
export function stageModel(input = {}) {
  const { run = null, live = {}, mission = null, questions = [], agents = [], team = null, solo = null, conn = 'ok', now = Date.now(), prev = null, request = '' } = input;
  const names = new Map((agents || []).map((a) => [String(a.id), a.name || String(a.id)]));
  const known = (id) => names.has(String(id));
  const nameOf = (id) => names.get(String(id)) || t('삭제된 에이전트');
  const liveOf = (id) => (live && live[id]) || null;
  const active = !!run && !run.endedAt && ACTIVE.has(run.status);
  const hold = active && run.status === 'waiting' ? run.hold || null : null;
  // 이 그림이 보여 줄 목표: 마지막 실행이 그 목표의 실행이거나, 카드 확인 대기·끊긴 목표
  const mis = mission && ((run && run.missionId === mission.id) || ['draft', 'cut'].includes(mission.status)) ? mission : null;
  const drafted = mis?.status === 'draft' || mis?.status === 'drafting';
  const cutGoal = mis?.status === 'cut';
  const cutRun = cutGoal && run?.missionId === mis.id; // 끊긴 자리는 그 목표의 실행에서만 찾는다(그 뒤의 다른 실행이면 표시하지 않는다)
  // 역: 실행의 단계. 실행이 없으면(쉬는 세션) 팀 단계표를 흐린 역으로, 팀이 없으면 에이전트 하나의 역 하나.
  // 목표 카드 확인 대기면 아직 아무 단계도 시작하지 않았으니 팀 단계표를 할 일로 둔다
  const useRun = !!run && !(mis?.status === 'draft' && !active);
  const src = useRun ? run.stages || [] : team?.stages?.length ? team.stages : solo ? [{ label: solo.role || solo.name || '', agentIds: [String(solo.id)] }] : [];
  const cur = useRun && active && Number.isInteger(run.stageIndex) ? run.stageIndex : null;
  const quotaAuto = hold?.reason === 'quota' && !!hold.autoAt;
  const capAuto = hold?.reason === 'limitcap' && !!hold.autoAt; // 구독 한도 상한에서 자동 이어서를 골랐다(결정 0026): 내 차례가 아니라 한도 대기
  const qs = active ? (questions || []).filter((q) => !q.runId || q.runId === run.id) : [];
  const curStage = cur != null ? src[cur] : null;
  const holdStage = hold && Number.isInteger(hold.stageIndex) ? src[hold.stageIndex] || null : null;
  const errand = curStage?.meetingNow ? researcherOf(curStage.meetingNow) : null; // 회의 중 조사하러 간 사람(결정 0011)
  // 되돌림 중(결정 0015). 지금 단계가 되돌릴 단계일 때만: 서버는 되돌림 단계를 끝낸 뒤 바뀐 자리(at)를 저장만 하고 알리지 않아서,
  // 판정 앞 일시정지 동안 화면의 목표에는 옛 at.back 이 남아 있다
  // 그 목표의 실행일 때만(끊긴 목표가 되돌림 중이었어도 그 뒤의 다른 실행에는 붙이지 않는다)
  const back = !!(mis && active && run.missionId === mis.id && mis.at?.back && mis.at.stageIndex === cur);
  // 지금 실행에서 일하는 사람: 지금 단계·대기가 가리키는 단계의 담당과 조사하러 간 사람. 다른 사람의 지난 상태는 "지금" 줄·한도 표시에 섞지 않는다
  const inRun = new Set([...(curStage?.agentIds || []), ...(holdStage?.agentIds || []), ...(errand ? [errand] : [])].map(String));
  // 호출 상한·카드 되풀이 상한(시간당 카드 시작 수 포함): 보통은 단계를 시작하기 전에 묻는다(문은 그 단계 앞). 이미 돈 단계에서 물으면 그 역 안에서 기다린다.
  // 둘 다 같은 규칙: 서버가 이미 돈 단계라고 알리거나(hold.ran: 막힘 "한 번 더"의 다음 바퀴, 일 카드의 끝 두 칸 다시 요청, 한도 대기 뒤 다시 하기,
  // 끊긴 한도 대기를 이어서 다시 하기 앞) 단계가 오류로 멈춘 채(error: 오류 다시 하기 앞)면 역 안. 단계 상태만으로는 못 가른다
  // (되돌림 바퀴의 done 은 지난 바퀴 것일 수도 이번 바퀴 것일 수도 있고, 이어서 한 실행은 그 단계를 pending 으로 다시 만든다)
  const ran = !!hold && (hold.ran === true || holdStage?.status === 'error');
  const capInside = hold?.reason === 'cap' && ran;
  const limitInside = hold?.reason === 'mission' && hold.kind === 'limit' && ran;
  // 구독 한도 상한(결정 0026)도 같은 규칙: 새 일을 시작하기 전이면 그 단계 앞, 이미 돈 단계(막힘 "한 번 더"의 다음 바퀴)면 역 안
  const limitcapInside = hold?.reason === 'limitcap' && ran;

  const stations = src.map((st, i) => {
    const ids = (st.agentIds || []).map(String);
    let state = useRun ? ST_STATE[st.status] || 'todo' : 'todo';
    const hk = useRun ? holdKind(run, i) : '';
    if (hk === 'mission' && (hold.kind !== 'limit' || limitInside)) state = 'wait'; // 카드 되풀이 상한은 보통 단계를 시작하기 전에 묻는다(그 단계는 아직 돌지 않았다)
    if (hk === 'quota') state = quotaAuto ? 'limit' : 'wait';
    if (hk === 'cap' && capInside) state = 'wait';
    if (hk === 'limitcap' && limitcapInside) state = capAuto ? 'limit' : 'wait';
    if (cutRun && useRun && state !== 'done' && (st.status === 'stopped' || i === mis.at?.stageIndex)) state = 'cut';
    const isCur = cur === i;
    const showLive = isCur || (!!hold && hold.stageIndex === i);
    const meet = isCur && st.meetingNow ? st.meetingNow : null;
    const chairId = st.meeting ? String(st.meeting.chairId || ids[0] || '') : null;
    const mv = meet ? meetingView(meet, chairId) : null;
    const asking = new Set(qs.filter((q) => (q.stageIndex ?? cur) === i).map((q) => q.agentId));
    const working = ['run', 'wait', 'error', 'limit'].includes(state);
    // 되돌림에서 회의 단계를 고치는 사람: 서버와 같이 진행자(목표의 leadId)가 그 단계에 있으면 그 사람, 없으면 첫 에이전트
    const fixer = back && st.meeting && i === mis.at.stageIndex ? (ids.includes(String(mis.leadId)) ? String(mis.leadId) : ids[0]) : null;
    const people = ids.map((id) => {
      const p = { id, name: nameOf(id), gone: !known(id), st: null, tool: null, held: false, chair: !!chairId && id === chairId, opp: false, speaker: false, away: false, limitLeft: null, detail: '' };
      if (showLive || id === errand) {
        const ps = personSt(liveOf(id));
        Object.assign(p, ps, { detail: String(liveOf(id)?.detail || '') });
      }
      if (mv && id !== errand) {
        p.opp = mv.opposerId === id;
        p.speaker = isTalking(mv, id, true);
        if (!['wait', 'error', 'limit', 'off'].includes(p.st)) p.st = 'meet';
      }
      if (id === errand) {
        p.away = true;
        if (!p.st || p.st === 'idle' || p.st === 'done') Object.assign(p, { st: 'tool', tool: 'search' });
      }
      // 한도 대기(0019)에 걸린 사람, 구독 한도 상한(0026)에서 자동 이어서를 기다리는 사람
      if ((hold?.reason === 'quota' || capAuto) && hold.stageIndex === i && (hold.who || []).some((w) => String(w.agentId) === id)) {
        const until = hold.autoAt || hold.until || 0;
        Object.assign(p, { st: 'limit', tool: null, limitLeft: until > now ? until - now : null });
      }
      if (asking.has(id)) Object.assign(p, { st: 'wait', tool: null });
      if (state === 'cut') Object.assign(p, { st: 'off', tool: null });
      // 일감 카드: 지금 단계에서 일을 맡은 사람(회의는 진행자, 회의 단계의 되돌림은 고치는 사람). 병렬 단계는 먼저 끝낸 사람도 두 몫이 합쳐질 때까지 쥐고 있다
      p.held = isCur && working && (fixer ? id === fixer : st.meeting ? id === chairId : true);
      return p;
    });
    // 보일 순서: 회의는 말하는 사람·반대편·진행자·조사하러 간 사람을 앞에, 그 밖은 나를 기다리는 사람·일하는 사람을 앞에(넘치면 +n 뒤로 가지 않게)
    const rank = mv ? (p) => (p.speaker && mv.phase !== 'opinion' ? 0 : p.opp ? 1 : p.chair ? 2 : p.away ? 3 : 4)
      : (p) => (['wait', 'error', 'limit'].includes(p.st) ? 0 : p.held || BUSY.has(p.st) ? 1 : 2);
    const shown = people.map((p, k) => [p, k]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([p]) => p);
    const parallel = Number(st.count) || (ids.length > 1 && !st.meeting ? ids.length : 0);
    const ret = back && i === mis.at.stageIndex ? { n: Math.max(1, Number(mis.returns) || 1), of: Math.max(1, Number(mis.returnCap) || 1, Number(mis.returns) || 1) } : null;
    const cards = st.mission === 'cards' && mis && Array.isArray(st.cardIds) ? st.cardIds.map((id) => ({ id, title: String((mis.cards || []).find((c) => c.id === id)?.title || '') })) : null;
    const speakerP = mv && mv.phase !== 'opinion' ? people.find((p) => p.speaker) || null : null;
    return {
      i, label: String(st.label || ''), state, cur: isCur,
      people: shown.slice(0, MAX_PEOPLE), more: Math.max(0, shown.length - MAX_PEOPLE),
      names: people.map((p) => p.name), hiddenNames: shown.slice(MAX_PEOPLE).map((p) => p.name), // 툴팁·+n 은 자르기 전 전체 이름으로
      parallel, isMeeting: !!st.meeting && st.mission !== 'meeting',
      meeting: mv ? {
        phase: mv.phase, round: mv.round, rounds: mv.rounds, label: meetLabel(meet), speakerId: mv.speakerId, chairId, away: errand && ids.includes(errand) ? errand : null,
        speaker: speakerP ? { name: speakerP.name, detail: speakerP.detail, opp: speakerP.opp, chair: speakerP.chair } : null,
        awayName: errand ? nameOf(errand) : '',
      } : null,
      review: st.mission === 'review' && mis ? (mis.criteria || []).map((c) => ({ id: String(c.id), text: String(c.text || ''), verdict: state === 'run' ? 'check' : c.status || 'open' })) : null,
      note: ret ? 'ret' : asking.size ? 'question' : state === 'done' && parallel > 1 && !st.note ? 'merged' : null, // 누가 건너뛰었으면(메모) 합침 대신 메모를 보인다
      ret, memo: String(st.note || ''), cards, ask: false,
    };
  });

  // ── 내 차례: 무엇을 기다리는지와 길 위의 자리(문: 그 단계 뒤 / 그 단계 앞 / 역 안 / 맨 앞) ──
  let ask = null;
  const labelAt = (i) => String(src[i]?.label || '');
  // 끊긴 목표 알약은 그 목표의 실행을 그릴 때, 또는 기다리는 게 없을 때만(끊긴 뒤 다른 실행이 나를 기다리면 그 차례가 먼저)
  const cutAsk = cutGoal ? { kind: 'cut', icon: 'unplug', cls: 'cut', title: t('목표 끊김'), short: t('앱이 꺼져서 끊겼어 · 저절로 다시 시작 안 함'), target: 'cut' } : null;
  if (cutRun) ask = cutAsk;
  else if (active && run.status === 'paused') ask = { kind: 'paused', icon: 'pause', cls: 'me', title: t('일시정지됨'), short: t('재개해야 다음 단계로 가'), target: 'gate' };
  else if (hold) {
    const i = hold.stageIndex;
    const label = labelAt(i);
    if (hold.reason === 'approve') ask = { kind: 'approve', icon: 'hand', cls: 'me', title: t('승인 필요'), short: t('"{label}" 결과 확인', { label }), target: 'gate', gateAfter: i };
    else if (hold.reason === 'error') ask = { kind: 'error', icon: 'warn', cls: 'err', title: t('오류'), short: t('"{label}" 단계에서 멈춤', { label }), target: 'gate', station: i };
    else if (hold.reason === 'mission') {
      const k = hold.kind;
      const title = k === 'notes' ? t('추가 지시 반영') : k === 'blocked' ? t('막힘') : k === 'limit' ? t('카드 되풀이 상한') : t('목표 판정');
      const base = k === 'notes' ? t('반영 안 한 추가 지시 {n}개', { n: Number(hold.notes) || 0 })
        : k === 'blocked' ? (hold.blocked || []).map((b) => b.name).filter(Boolean).join(', ')
          : k === 'limit' ? (hold.cards || []).map((c) => c.id).join(', ')
            : t('남은 기준 {n}개', { n: (hold.left || []).length });
      // 사다리 팀의 되풀이 상한·막힘 질문에 윗등급에게 넘기기 보기가 있으면(결정 0027) 문 문구에 그 후보. 대기 종류는 그대로 limit·blocked
      const up = (k === 'limit' || k === 'blocked') && Array.isArray(hold.raise) ? [...new Set(hold.raise.map((r) => r.name || nameOf(r.to)).filter(Boolean))] : [];
      const short = up.length ? [base, t('윗등급 {names}에게 넘길 수 있어', { names: up.join(', ') })].filter(Boolean).join(' · ') : base;
      // 판정·추가 지시는 판정 역 뒤, 막힘은 막힌 일 단계 뒤, 카드 되풀이 상한은 그 카드 단계를 시작하기 전(앞). 이미 돈 단계에서 묻는 되풀이 상한은 역 안(limitInside)
      ask = { kind: k === 'limit' ? 'limit' : k === 'blocked' ? 'blocked' : k === 'notes' ? 'notes' : 'verdict', icon: k === 'limit' ? 'gauge' : 'target', cls: 'me', title, short, target: 'gate', ...(limitInside ? { station: i } : { gateAfter: k === 'limit' ? i - 1 : i }) };
    } else if (hold.reason === 'cap') {
      // plan: 계획 뒤 어림이 남은 호출보다 많다(결정 0025. 상한을 다 쓴 게 아니다)
      const short = hold.kind === 'rate' ? t('한 시간에 카드 {used}장 시작함', { used: hold.used })
        : hold.kind === 'plan' ? t('어림 {min}~{max}번 · 남은 {left}번', { min: hold.min, max: hold.max, left: Math.max(0, (Number(hold.cap) || 0) - (Number(hold.used) || 0)) })
          : t('{used}/{cap} 다 씀', { used: hold.used, cap: hold.cap });
      ask = { kind: 'cap', icon: 'gauge', cls: 'me', title: hold.kind === 'rate' ? t('카드 시작 수 상한') : t('호출 상한'), short, target: 'gate', ...(capInside ? { station: i } : { gateAfter: i - 1 }) };
    } else if (hold.reason === 'quota' && !quotaAuto) {
      ask = { kind: 'quota', icon: 'hour', cls: 'me', title: t('사용량 한도'), short: (hold.who || []).map((w) => w.name || nameOf(w.agentId)).join(', '), target: 'gate', station: i };
    } else if (hold.reason === 'limitcap' && !capAuto) {
      // 구독 한도 상한(결정 0026): 누구의 AI 가 몇 %인지. 문은 그 단계 앞(이미 돈 단계면 역 안)
      const short = (hold.who || []).map((w) => `${w.name || nameOf(w.agentId)} ${Math.max(...(w.windows || []).map((x) => Number(x.pct) || 0), 0)}%`).join(', ');
      ask = { kind: 'limitcap', icon: 'gauge', cls: 'me', title: t('구독 한도 상한'), short, target: 'gate', ...(limitcapInside ? { station: i } : { gateAfter: i - 1 }) };
    }
  } else if (qs.length) {
    const q = qs[0];
    const i = q.stageIndex ?? cur;
    ask = { kind: 'question', icon: 'ask', cls: 'me', title: t('질문'), short: q.text ? `${nameOf(q.agentId)}: ${q.text}` : nameOf(q.agentId), target: 'ask', station: i };
  }
  if (!ask && cutAsk) ask = cutAsk;
  if (!ask && mis?.status === 'draft') ask = { kind: 'confirm', icon: 'target', cls: 'me', title: t('목표 카드 확인'), short: t('확인해야 팀이 일을 시작해'), target: 'card', msgId: mis.cardMsgId || null, gateAfter: -1 };
  if (ask && Number.isInteger(ask.station) && stations[ask.station]) stations[ask.station].ask = true;

  // ── 지난 역 접기: 지금 역 하나 앞까지는 남긴다. 앞으로 올 역은 접지 않는다(역 줄이 가로로 넘치면 화면이 민다) ──
  const anchor = cur ?? (useRun && !active ? stations.length : stations.findIndex((s) => !['done', 'skipped'].includes(s.state)));
  const start = stations.length > MAX_STATIONS ? Math.max(0, Math.min((anchor < 0 ? stations.length : anchor) - 1, stations.length - MAX_STATIONS)) : 0;
  const visible = stations.slice(start);
  const gate = ask && Number.isInteger(ask.gateAfter) ? { kind: ask.kind, icon: ask.icon, after: ask.gateAfter } : null;
  const links = visible.map((s) => ({ after: s.i, done: s.state === 'done', cut: cutGoal, gate: gate && gate.after === s.i ? { kind: gate.kind, icon: gate.icon } : null }));
  if (gate && (gate.after === -1 || gate.after === start - 1)) links.unshift({ after: gate.after, done: false, cut: cutGoal, gate: { kind: gate.kind, icon: gate.icon } });

  // ── 한도 대기(내 차례 아님): 자동 이어서가 걸린 한도 대기, 한도가 곧 풀려 기다리는 사람(결정 0019) ──
  const waiting = Object.entries(live || {}).filter(([id, l]) => l?.state === 'paused' && inRun.has(String(id))).map(([id]) => id);
  const limit = quotaAuto || capAuto ? { until: hold.autoAt, names: (hold.who || []).map((w) => w.name || nameOf(w.agentId)) }
    : active && waiting.length ? { until: null, names: waiting.map(nameOf) } : null;

  // ── 목표 줄 ──
  const kindOf = mis ? ({ drafting: 'run', draft: 'run', active: 'run', waiting: 'run', done: 'done', unreviewed: 'done', accepted: 'accepted', stopped: 'stopped', cancelled: 'stopped', cut: 'cut' }[mis.status] || 'run')
    : run ? (active ? 'run' : { done: 'done', stopped: 'stopped', error: 'error' }[run.status] || 'done') : 'none';
  const goal = { kind: kindOf, mission: !!mis, text: mis ? firstLine(mis.goal || mis.request) : run ? firstLine(request) : '' };
  // 기준: 판정이 하나라도 있으면 "통과 n/m", 아직 없으면 "기준 m개"
  const crit = mis?.criteria?.length ? { pass: mis.criteria.filter((c) => c.status === 'pass').length, total: mis.criteria.length, judged: mis.criteria.some((c) => ['pass', 'fail', 'unknown'].includes(c.status)) } : null;
  const meta = { criteria: crit, calls: mis?.calls ? { used: Number(mis.calls.used) || 0, cap: Number(mis.calls.cap) || 0 } : null };

  // ── 끝 깃발: 목표가 있으면 목표 상태를 실행 상태보다 먼저 본다. 아직 안 끝났으면 "끝"(완료)이 아니라 "도착" ──
  // 카드 없이 닫힌 목표: 목표 잡기가 카드를 내기 전에 오류·중지·앱 꺼짐으로 끝나 서버가 닫았다(카드 메시지가 없다). 사용자가 카드를 닫은 게 아니다
  const noCard = mis?.status === 'cancelled' && !mis.cardMsgId;
  const end = cutGoal ? { kind: 'cut', text: t('끊김') }
    : drafted ? { kind: 'open', text: t('도착') }
      : mis?.status === 'done' ? { kind: 'pass', text: goalEndWord('done') }
        : mis?.status === 'accepted' ? { kind: 'pass', text: goalEndWord('accepted') }
          : noCard ? ({ stopped: { kind: 'stopped', text: t('중지됨') }, error: { kind: 'error', text: t('오류로 끝') } }[run?.status] || { kind: 'stopped', text: t('닫힘') })
            : mis?.status === 'cancelled' ? { kind: 'stopped', text: t('닫힘') }
              : mis?.status === 'stopped' && !active ? { kind: 'stopped', text: goalEndWord('stopped') }
                : run && !active ? ({ done: { kind: 'pass', text: t('끝') }, stopped: { kind: 'stopped', text: t('중지됨') }, error: { kind: 'error', text: t('오류로 끝') } }[run.status] || { kind: 'open', text: t('도착') })
                  : { kind: 'open', text: t('도착') };

  // ── 지금 한 줄: 마지막 활동으로 정한다 ──
  const curSt = cur != null ? stations[cur] : null;
  let line = null;
  if (conn === 'lost') line = { icon: 'wifi', cls: 'off', text: t('서버 연결 끊김 — 다시 연결 중…') };
  else if (ask) line = { icon: ask.icon, cls: ask.cls === 'err' ? 'error' : ask.cls === 'cut' ? 'off' : 'wait', text: ask.short || ask.title };
  else if (mis?.status === 'done') line = { icon: 'check', cls: 'done', text: crit ? t('통과로 끝 · 기준 {pass}/{total}', crit) : t('통과로 끝') };
  else if (limit) line = { icon: 'hour', cls: 'limit', text: limit.until ? t('한도 대기 · {time}에 자동으로 이어서', { time: fmtClock(limit.until, now) }) : t('{names} · 한도가 풀리길 기다리는 중', { names: limit.names.join(', ') }) };
  else if (back && curSt) line = { icon: 'ret', cls: 'error', text: t('되돌림 — "{label}" 단계가 걸린 기준을 고치는 중', { label: curSt.label }) };
  else if (curSt?.meeting) {
    const m = curSt.meeting;
    const who = m.phase === 'opinion' ? t('참석자가 동시에 의견 쓰는 중') : m.phase === 'research' && errand ? t('{name}이(가) 자료 확인하러 감', { name: nameOf(errand) }) : m.speakerId ? t('{name} 말하는 중', { name: nameOf(m.speakerId) }) : '';
    line = { icon: 'chat', cls: 'meet', text: who ? `${t('회의 · {label}', { label: m.label })} — ${who}` : t('회의 · {label}', { label: m.label }) };
  } else if (active) {
    // 지금 일하는 사람 중 가장 최근에 상태가 바뀐 사람(이번 실행에 없는 사람의 지난 상태는 빼고)
    const busy = Object.entries(live || {}).filter(([id]) => inRun.has(String(id))).map(([id, l]) => [id, l, personSt(l)]).filter(([, l, ps]) => l && BUSY.has(ps.st)).sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))[0];
    if (busy) {
      const info = personInfo(busy[2]);
      line = { icon: info.icon, cls: info.cls, text: `${nameOf(busy[0])} · ${String(busy[1].detail || '') || info.text}` };
    } else line = { icon: 'dots', cls: 'think', text: t('진행 중') };
  } else if (noCard) line = { icon: run?.status === 'error' ? 'warn' : 'stop', cls: run?.status === 'error' ? 'error' : 'off', text: t('목표 카드가 나오기 전에 끝나서 이 목표는 닫았어.') };
  else if (mis?.status === 'cancelled') line = { icon: 'stop', cls: 'off', text: t('목표 카드를 닫았어.') };
  else if (run) {
    line = mis?.status === 'accepted' ? { icon: 'check', cls: 'done', text: t('받아들여서 끝냈어') }
      : mis?.status === 'stopped' ? { icon: 'stop', cls: 'off', text: t('중지됨') }
        : ({ done: { icon: 'check', cls: 'done', text: t('끝났어') }, stopped: { icon: 'stop', cls: 'off', text: t('중지됨') }, error: { icon: 'warn', cls: 'error', text: t('오류로 끝났어') } }[run.status] || { icon: 'check', cls: 'done', text: t('끝났어') });
  } else line = { icon: 'moon', cls: 'idle', text: t('모두 쉬는 중 · 할 일을 보내면 팀이 시작해') };

  // ── 진행 한 줄(접은 띠·작은 모양): "3/4 만들기 ×2 · 기다림" ──
  const n = stations.length;
  const tail = (s) => ({ wait: ` · ${t('기다림')}`, error: ` · ${t('오류')}`, cut: ` · ${t('끊김')}`, limit: ` · ${t('한도 대기')}` }[s.state] || '');
  const focus = curSt || (cutRun && Number.isInteger(mis.at?.stageIndex) ? stations[mis.at.stageIndex] || null : null);
  const progress = focus ? `${focus.i + 1}/${n} ${focus.label}${focus.parallel > 1 ? ` ×${focus.parallel}` : ''}${focus.meeting ? ` · ${focus.meeting.label}` : ''}${tail(focus)}`
    : mis?.status === 'draft' && !active ? t('시작 전')
      : useRun && run && !active ? (end.kind === 'pass' && run.status === 'done' ? `${n}/${n} ${t('끝')}` : end.text)
        : t('쉬는 중');

  // ── 넘기기·되돌림: 바로 앞 모델과 비교해 지금 단계가 바뀌었을 때만 ──
  const runId = run?.id || null;
  const fly = prev && runId && prev.runId === runId && prev.cur != null && cur != null && prev.cur !== cur ? { from: prev.cur, to: cur, kind: cur < prev.cur ? 'ret' : 'hand' } : null;
  // 좁은 창에서 역 줄을 밀어 보일 곳: 지금 역, 없으면 내 차례 문(또는 그 역)
  const scrollTo = cur ?? (ask && Number.isInteger(ask.station) ? ask.station : gate ? Math.max(gate.after, 0) : null);

  return {
    runId, cur, active, lost: conn === 'lost', cut: cutGoal, scrollTo,
    goal, meta, now: line, stations: visible, links, ask, limit, end, fly, progress,
    done: mis?.status === 'done' ? crit || { pass: 0, total: 0 } : null,
    folded: start, total: n, segs: stations.map((s) => ({ i: s.i, state: s.state, label: s.label })),
  };
}
