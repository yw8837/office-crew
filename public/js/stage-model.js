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

// 목표의 판정 뒤 묻기·호출 상한·한도 대기(결정 0015·0019)로 i 단계가 기다리면 그 사유('mission'|'cap'|'quota'), 아니면 ''
export const holdKind = (run, i) => (run && run.status === 'waiting' && run.hold?.stageIndex === i && ['mission', 'cap', 'quota'].includes(run.hold.reason) ? run.hold.reason : '');
// 단계 띠("사무실 크게" 보기의 진행 바)에 보일 표시. 끝난 판정 단계가 ✓ 로 보여 다 끝난 것처럼 읽히지 않게
export const goalWait = (run, i) => ({ mission: '🎯', cap: '🔢', quota: '⏳' }[holdKind(run, i)] || '');

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
export const fmtClock = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

/**
 * 흐름 무대의 모델.
 * run: 세션의 마지막 실행(없으면 null), live: 에이전트 id → 실시간 상태(agentState), mission: 세션의 목표(없으면 null),
 * questions: openQuestions 의 결과, agents: [{ id, name }](이름 찾기), team: 세션의 팀(쉬는 세션의 역), solo: 팀이 없을 때의 에이전트,
 * conn: 'ok'|'lost'(서버 연결), now: 지금 시각(ms), prev: 바로 앞에 그린 모델(단계가 넘어갔는지 보려고), request: 실행을 시작한 내 말
 */
export function stageModel(input = {}) {
  const { run = null, live = {}, mission = null, questions = [], agents = [], team = null, solo = null, conn = 'ok', now = Date.now(), prev = null, request = '' } = input;
  const names = new Map((agents || []).map((a) => [String(a.id), a.name || String(a.id)]));
  const nameOf = (id) => names.get(String(id)) || String(id);
  const liveOf = (id) => (live && live[id]) || null;
  const active = !!run && !run.endedAt && ACTIVE.has(run.status);
  const hold = active && run.status === 'waiting' ? run.hold || null : null;
  // 이 그림이 보여 줄 목표: 마지막 실행이 그 목표의 실행이거나, 카드 확인 대기·끊긴 목표
  const mis = mission && ((run && run.missionId === mission.id) || ['draft', 'cut'].includes(mission.status)) ? mission : null;
  const drafted = mis?.status === 'draft';
  const cutGoal = mis?.status === 'cut';
  const cutRun = cutGoal && run?.missionId === mis.id; // 끊긴 자리는 그 목표의 실행에서만 찾는다(그 뒤의 다른 실행이면 표시하지 않는다)
  // 역: 실행의 단계. 실행이 없으면(쉬는 세션) 팀 단계표를 흐린 역으로, 팀이 없으면 에이전트 하나의 역 하나.
  // 목표 카드 확인 대기면 아직 아무 단계도 시작하지 않았으니 팀 단계표를 할 일로 둔다
  const useRun = !!run && !(drafted && !active);
  const src = useRun ? run.stages || [] : team?.stages?.length ? team.stages : solo ? [{ label: solo.role || solo.name || '', agentIds: [String(solo.id)] }] : [];
  const cur = useRun && active && Number.isInteger(run.stageIndex) ? run.stageIndex : null;
  const quotaAuto = hold?.reason === 'quota' && !!hold.autoAt;
  const qs = active ? (questions || []).filter((q) => !q.runId || q.runId === run.id) : [];
  const curStage = cur != null ? src[cur] : null;
  const errand = curStage?.meetingNow ? researcherOf(curStage.meetingNow) : null; // 회의 중 조사하러 간 사람(결정 0011)
  const back = !!(mis && active && mis.at?.back); // 되돌림 중(결정 0015)

  const stations = src.map((st, i) => {
    const ids = (st.agentIds || []).map(String);
    let state = useRun ? ST_STATE[st.status] || 'todo' : 'todo';
    const hk = useRun ? holdKind(run, i) : '';
    if (hk === 'mission') state = 'wait';
    if (hk === 'quota') state = quotaAuto ? 'limit' : 'wait';
    if (cutRun && useRun && state !== 'done' && (st.status === 'stopped' || i === mis.at?.stageIndex)) state = 'cut';
    const isCur = cur === i;
    const showLive = isCur || (!!hold && hold.stageIndex === i);
    const meet = isCur && st.meetingNow ? st.meetingNow : null;
    const chairId = st.meeting ? String(st.meeting.chairId || ids[0] || '') : null;
    const mv = meet ? meetingView(meet, chairId) : null;
    const asking = new Set(qs.filter((q) => (q.stageIndex ?? cur) === i).map((q) => q.agentId));
    const working = ['run', 'wait', 'error', 'limit'].includes(state);
    const people = ids.map((id) => {
      const p = { id, name: nameOf(id), st: null, tool: null, held: false, chair: !!chairId && id === chairId, opp: false, speaker: false, away: false, limitLeft: null, detail: '' };
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
      if (hold?.reason === 'quota' && hold.stageIndex === i && (hold.who || []).some((w) => String(w.agentId) === id)) {
        const until = hold.autoAt || hold.until || 0;
        Object.assign(p, { st: 'limit', tool: null, limitLeft: until > now ? until - now : null });
      }
      if (asking.has(id)) Object.assign(p, { st: 'wait', tool: null });
      if (state === 'cut') Object.assign(p, { st: 'off', tool: null });
      // 일감 카드: 지금 단계에서 일을 맡은 사람(회의는 진행자). 병렬 단계는 먼저 끝낸 사람도 두 몫이 합쳐질 때까지 쥐고 있다
      p.held = isCur && working && (st.meeting ? id === chairId : true);
      return p;
    });
    const rank = (p) => (['wait', 'error', 'limit'].includes(p.st) ? 0 : p.held || BUSY.has(p.st) ? 1 : 2);
    const shown = mv ? people : people.map((p, k) => [p, k]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([p]) => p);
    const parallel = Number(st.count) || (ids.length > 1 && !st.meeting ? ids.length : 0);
    const ret = back && i === mis.at.stageIndex ? { n: Math.max(1, Number(mis.returns) || 1), of: Math.max(1, Number(mis.returnCap) || 1, Number(mis.returns) || 1) } : null;
    const cards = st.mission === 'cards' && mis && Array.isArray(st.cardIds) ? st.cardIds.map((id) => ({ id, title: String((mis.cards || []).find((c) => c.id === id)?.title || '') })) : null;
    return {
      i, label: String(st.label || ''), state, cur: isCur,
      people: shown.slice(0, MAX_PEOPLE), more: Math.max(0, shown.length - MAX_PEOPLE),
      parallel, isMeeting: !!st.meeting && st.mission !== 'meeting',
      meeting: mv ? { phase: mv.phase, round: mv.round, rounds: mv.rounds, label: meetLabel(meet), speakerId: mv.speakerId, chairId, away: errand && ids.includes(errand) ? errand : null } : null,
      review: st.mission === 'review' && mis ? (mis.criteria || []).map((c) => ({ id: String(c.id), text: String(c.text || ''), verdict: state === 'run' ? 'check' : c.status || 'open' })) : null,
      note: ret ? 'ret' : asking.size ? 'question' : state === 'done' && parallel > 1 && !st.note ? 'merged' : null, // 누가 건너뛰었으면(메모) 합침 대신 메모를 보인다
      ret, memo: String(st.note || ''), cards, ask: false,
    };
  });

  // ── 내 차례: 무엇을 기다리는지와 길 위의 자리(문: 그 단계 뒤 / 역 안 / 맨 앞) ──
  let ask = null;
  const labelAt = (i) => String(src[i]?.label || '');
  if (cutGoal) ask = { kind: 'cut', icon: 'unplug', cls: 'cut', title: t('목표 끊김'), short: t('앱이 꺼져서 끊겼어 · 저절로 다시 시작 안 함'), target: 'cut' };
  else if (active && run.status === 'paused') ask = { kind: 'paused', icon: 'pause', cls: 'me', title: t('일시정지됨'), short: t('재개해야 다음 단계로 가'), target: 'gate' };
  else if (hold) {
    const i = hold.stageIndex;
    const label = labelAt(i);
    if (hold.reason === 'approve') ask = { kind: 'approve', icon: 'hand', cls: 'me', title: t('승인 필요'), short: t('"{label}" 결과 확인', { label }), target: 'gate', gateAfter: i };
    else if (hold.reason === 'error') ask = { kind: 'error', icon: 'warn', cls: 'err', title: t('오류'), short: t('"{label}" 단계에서 멈춤', { label }), target: 'gate', station: i };
    else if (hold.reason === 'mission') {
      const k = hold.kind;
      const title = k === 'notes' ? t('추가 지시 반영') : k === 'blocked' ? t('막힘') : k === 'limit' ? t('카드 되풀이 상한') : t('목표 판정');
      const short = k === 'notes' ? t('반영 안 한 추가 지시 {n}개', { n: Number(hold.notes) || 0 })
        : k === 'blocked' ? (hold.blocked || []).map((b) => b.name).filter(Boolean).join(', ')
          : k === 'limit' ? (hold.cards || []).map((c) => c.id).join(', ')
            : t('남은 기준 {n}개', { n: (hold.left || []).length });
      ask = { kind: 'verdict', icon: 'target', cls: 'me', title, short, target: 'gate', gateAfter: i };
    } else if (hold.reason === 'cap') {
      // 호출 상한은 단계를 시작하기 전에 멈춘다: 문은 그 단계 앞(앞 단계 뒤)
      const short = hold.kind === 'rate' ? t('한 시간에 카드 {used}장 시작함', { used: hold.used }) : t('{used}/{cap} 다 씀', { used: hold.used, cap: hold.cap });
      ask = { kind: 'cap', icon: 'gauge', cls: 'me', title: hold.kind === 'rate' ? t('카드 시작 수 상한') : t('호출 상한'), short, target: 'gate', gateAfter: i - 1 };
    } else if (hold.reason === 'quota' && !quotaAuto) {
      ask = { kind: 'quota', icon: 'hour', cls: 'me', title: t('사용량 한도'), short: (hold.who || []).map((w) => w.name || nameOf(w.agentId)).join(', '), target: 'gate', station: i };
    }
  } else if (qs.length) {
    const q = qs[0];
    const i = q.stageIndex ?? cur;
    ask = { kind: 'question', icon: 'ask', cls: 'me', title: t('질문'), short: q.text ? `${nameOf(q.agentId)}: ${q.text}` : nameOf(q.agentId), target: 'ask', station: i };
  }
  if (!ask && drafted) ask = { kind: 'confirm', icon: 'target', cls: 'me', title: t('목표 카드 확인'), short: t('확인해야 팀이 일을 시작해'), target: 'card', msgId: mis.cardMsgId || null, gateAfter: -1 };
  if (ask && Number.isInteger(ask.station) && stations[ask.station]) stations[ask.station].ask = true;

  // ── 지난 역 접기: 지금 역 하나 앞까지는 남긴다 ──
  const anchor = cur ?? (useRun && !active ? stations.length : stations.findIndex((s) => !['done', 'skipped'].includes(s.state)));
  const start = stations.length > MAX_STATIONS ? Math.max(0, Math.min((anchor < 0 ? stations.length : anchor) - 1, stations.length - MAX_STATIONS)) : 0;
  const visible = stations.slice(start);
  const gate = ask && Number.isInteger(ask.gateAfter) ? { kind: ask.kind, icon: ask.icon, after: ask.gateAfter } : null;
  const links = visible.map((s) => ({ after: s.i, done: s.state === 'done', cut: cutGoal, gate: gate && gate.after === s.i ? { kind: gate.kind, icon: gate.icon } : null }));
  if (gate && (gate.after === -1 || gate.after === start - 1)) links.unshift({ after: gate.after, done: false, cut: cutGoal, gate: { kind: gate.kind, icon: gate.icon } });

  // ── 한도 대기(내 차례 아님): 자동 이어서가 걸린 한도 대기, 한도가 곧 풀려 기다리는 사람(결정 0019) ──
  const waiting = Object.entries(live || {}).filter(([, l]) => l?.state === 'paused').map(([id]) => id);
  const limit = quotaAuto ? { until: hold.autoAt, names: (hold.who || []).map((w) => w.name || nameOf(w.agentId)) }
    : active && waiting.length ? { until: null, names: waiting.map(nameOf) } : null;

  // ── 목표 줄 ──
  const kindOf = mis ? ({ drafting: 'run', draft: 'run', active: 'run', waiting: 'run', done: 'done', unreviewed: 'done', accepted: 'accepted', stopped: 'stopped', cancelled: 'stopped', cut: 'cut' }[mis.status] || 'run')
    : run ? (active ? 'run' : { done: 'done', stopped: 'stopped', error: 'error' }[run.status] || 'done') : 'none';
  const goal = { kind: kindOf, mission: !!mis, text: mis ? firstLine(mis.goal || mis.request) : run ? firstLine(request) : '' };
  const crit = mis?.criteria?.length ? { pass: mis.criteria.filter((c) => c.status === 'pass').length, total: mis.criteria.length } : null;
  const meta = { criteria: crit, calls: mis?.calls ? { used: Number(mis.calls.used) || 0, cap: Number(mis.calls.cap) || 0 } : null };

  // ── 끝 깃발 ──
  const end = cutGoal ? { kind: 'cut', text: t('끊김') }
    : mis?.status === 'done' ? { kind: 'pass', text: t('통과로 끝') }
      : mis?.status === 'accepted' ? { kind: 'pass', text: t('받아들여 끝') }
        : run && !active ? ({ done: { kind: 'pass', text: t('끝') }, stopped: { kind: 'stopped', text: t('중지됨') }, error: { kind: 'error', text: t('오류로 끝') } }[run.status] || { kind: 'open', text: t('끝') })
          : { kind: 'open', text: t('끝') };

  // ── 지금 한 줄: 마지막 활동으로 정한다 ──
  const curSt = cur != null ? stations[cur] : null;
  let line = null;
  if (conn === 'lost') line = { icon: 'wifi', cls: 'off', text: t('서버 연결 끊김 — 다시 연결 중…') };
  else if (ask) line = { icon: ask.icon, cls: ask.cls === 'err' ? 'error' : ask.cls === 'cut' ? 'off' : 'wait', text: ask.short || ask.title };
  else if (mis?.status === 'done') line = { icon: 'check', cls: 'done', text: crit ? t('통과로 끝 · 기준 {pass}/{total}', crit) : t('통과로 끝') };
  else if (limit) line = { icon: 'hour', cls: 'limit', text: limit.until ? t('한도 대기 · {time}에 자동으로 이어서', { time: fmtClock(limit.until) }) : t('{names} · 한도가 풀리길 기다리는 중', { names: limit.names.join(', ') }) };
  else if (back && curSt) line = { icon: 'ret', cls: 'error', text: t('되돌림 — "{label}" 단계가 걸린 기준을 고치는 중', { label: curSt.label }) };
  else if (curSt?.meeting) {
    const m = curSt.meeting;
    const who = m.phase === 'opinion' ? t('참석자가 동시에 의견 쓰는 중') : m.phase === 'research' && errand ? t('{name}이(가) 자료 확인하러 감', { name: nameOf(errand) }) : m.speakerId ? t('{name} 말하는 중', { name: nameOf(m.speakerId) }) : '';
    line = { icon: 'chat', cls: 'meet', text: who ? `${t('회의 · {label}', { label: m.label })} — ${who}` : t('회의 · {label}', { label: m.label }) };
  } else if (active) {
    // 지금 일하는 사람 중 가장 최근에 상태가 바뀐 사람
    const busy = Object.entries(live || {}).map(([id, l]) => [id, l, personSt(l)]).filter(([, l, ps]) => l && BUSY.has(ps.st)).sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))[0];
    if (busy) {
      const info = personInfo(busy[2]);
      line = { icon: info.icon, cls: info.cls, text: `${nameOf(busy[0])} · ${String(busy[1].detail || '') || info.text}` };
    } else line = { icon: 'dots', cls: 'think', text: t('진행 중') };
  } else if (run) {
    line = mis?.status === 'accepted' ? { icon: 'check', cls: 'done', text: t('받아들여서 끝냈어') }
      : ({ done: { icon: 'check', cls: 'done', text: t('끝났어') }, stopped: { icon: 'stop', cls: 'off', text: t('중지됨') }, error: { icon: 'warn', cls: 'error', text: t('오류로 끝났어') } }[run.status] || { icon: 'check', cls: 'done', text: t('끝났어') });
    if (drafted) line = { icon: 'target', cls: 'wait', text: t('확인해야 팀이 일을 시작해') };
  } else line = { icon: 'moon', cls: 'idle', text: t('모두 쉬는 중 · 할 일을 보내면 팀이 시작해') };

  // ── 진행 한 줄(접은 띠·작은 모양): "3/4 만들기 ×2 · 기다림" ──
  const n = stations.length;
  const tail = (s) => ({ wait: ` · ${t('기다림')}`, error: ` · ${t('오류')}`, cut: ` · ${t('끊김')}`, limit: ` · ${t('한도 대기')}` }[s.state] || '');
  const focus = curSt || (cutRun && Number.isInteger(mis.at?.stageIndex) ? stations[mis.at.stageIndex] || null : null);
  const progress = focus ? `${focus.i + 1}/${n} ${focus.label}${focus.parallel > 1 ? ` ×${focus.parallel}` : ''}${focus.meeting ? ` · ${focus.meeting.label}` : ''}${tail(focus)}`
    : useRun && run && !active ? (run.status === 'done' ? `${n}/${n} ${t('끝')}` : end.text)
      : drafted ? t('시작 전') : t('쉬는 중');

  // ── 넘기기·되돌림: 바로 앞 모델과 비교해 지금 단계가 바뀌었을 때만 ──
  const runId = run?.id || null;
  const fly = prev && runId && prev.runId === runId && prev.cur != null && cur != null && prev.cur !== cur ? { from: prev.cur, to: cur, kind: cur < prev.cur ? 'ret' : 'hand' } : null;

  return {
    runId, cur, active, lost: conn === 'lost', cut: cutGoal,
    goal, meta, now: line, stations: visible, links, ask, limit, end, fly, progress,
    done: mis?.status === 'done' ? crit || { pass: 0, total: 0 } : null,
    folded: start, total: n, segs: stations.map((s) => ({ i: s.i, state: s.state, label: s.label })),
  };
}
