// 흐름 무대: 나눠 보기에서 세션 화면 위쪽 그림. 단계가 왼쪽에서 오른쪽으로 "역"이 되고, 일감 카드는 쥔 사람 옆에,
// 내가 답해야 하는 곳은 길 위의 "문"으로 보인다. 접으면 한 줄 띠(StageStrip). 모델은 stage-model.js(DOM 없음)
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Avatar } from '../ui.js';
import { state, changed, agentById, teamById, latestRun, toast } from '../state.js';
import { t } from '../i18n/index.js';
import { stageModel, openQuestions, requestOf, personInfo, stationInfo, critFold, MAX_CRIT, ANSWER_BOX } from '../stage-model.js';

// 같은 굵기의 선 아이콘(24 격자). 이모지는 쓰지 않는다
const P = {
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  write: 'M4 7h11M4 12h8M4 17h5M14 19l6-6-2-2-6 6v2z',
  search: 'M11 4.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM16 16l4.5 4.5',
  book: 'M4 5.5c2.5-1.5 5.5-1.5 8 .5 2.5-2 5.5-2 8-.5V19c-2.5-1.5-5.5-1.5-8 .5-2.5-2-5.5-2-8-.5zM12 6v13.5',
  term: 'M3 5h18v14H3zM7 10l3 2.5L7 15M12.5 15H17',
  edit: 'M14 4l6 6L9 21H3v-6z',
  tool: 'M15 4a5 5 0 0 0-4.6 6.9L4 17.3V20h2.7l6.4-6.4A5 5 0 0 0 20 9l-3 1-2-2 1-3z',
  hand: 'M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-3a2 2 0 0 0-4 0',
  ask: 'M9.2 9a3 3 0 1 1 5.2 2c-1 .9-2.4 1.5-2.4 3M12 18h.01',
  target: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM12 12h.01',
  gauge: 'M4 17a8 8 0 1 1 16 0M12 17l4-5M4 20h16',
  hour: 'M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9',
  alert: 'M12 7v6M12 17.5h.01',
  warn: 'M12 3.5 21.5 20h-19zM12 10v4.5M12 17.3h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  unplug: 'M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5M3 3l18 18',
  wifi: 'M2.5 9a14 14 0 0 1 19 0M6 12.5a9 9 0 0 1 12 0M9.5 16a4 4 0 0 1 5 0M12 19h.01M3 3l18 18',
  doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h4',
  ret: 'M9 6 4 11l5 5M4 11h10a5 5 0 0 1 0 10h-2',
  flag: 'M5 21V4h12l-2.5 4L17 12H5',
  gavel: 'M13 4l7 7M10 7l7 7M14.5 5.5l-5 5M3 21l7-7M4 21h8',
  chat: 'M4 5h16v11H9l-5 4z',
  moon: 'M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z',
  pause: 'M8 5v14M16 5v14',
  skip: 'M5 5l10 7-10 7zM19 5v14',
  stop: 'M7 7h10v10H7z',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
};
function Ico({ n }) {
  return html`<svg class="stg-ico" viewBox="0 0 24 24" aria-hidden="true"><path d=${P[n] || P.dots} /></svg>`;
}

const DEFAULT_H = 156; // 기본 높이
const MIN_H = 120;
const MAX_H = 240;
const SMALL_H = 140; // 이보다 낮으면 작은 모양(이름 숨김, 맨 위 줄 한 줄)
const FLY_MS = 900; // 넘기기·되돌림 카드가 날아가는 시간(1초 이내)

const reduced = () => !!state.settings.reducedMotion || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
let seenConn = false; // 처음 연결되기 전(켜는 중)을 "연결 끊김"으로 보이지 않게
let focusNext = null; // 접기·펼치기 뒤에 초점을 받을 단추('fold' | 'unfold'). 바뀐 쪽이 그려질 때 옮긴다

// 이 세션의 모델. 바로 앞 모델을 들고 있다가 단계가 바뀌면 카드를 날린다
function useStage(s, flyRef, trackRef) {
  const prev = useRef(null);
  if (state.connected) seenConn = true;
  const run = latestRun(s);
  const team = s.teamId ? teamById(s.teamId) : null;
  const soloId = team ? null : s.agentId || state.settings.defaultAgentId || null;
  // 메시지 전체를 훑는 계산은 메시지 수·마지막 메시지·열린 질문(run.asks)이 바뀔 때만 다시 한다
  const msgs = s.messages || [];
  const lastId = msgs.length ? msgs[msgs.length - 1].id : '';
  const askKey = (run?.asks || []).map((a) => a.id).join(',');
  const questions = useMemo(() => openQuestions(msgs), [s.id, msgs.length, lastId, askKey]);
  const request = useMemo(() => requestOf(msgs, run), [s.id, msgs.length, run?.userMessageId]);
  const m = stageModel({
    run, live: state.live[s.id] || {}, mission: s.mission || null, questions, agents: state.agents,
    team, solo: soloId ? agentById(soloId) || null : null, conn: !state.connected && seenConn ? 'lost' : 'ok', now: Date.now(), prev: prev.current, request,
  });
  useLayoutEffect(() => {
    prev.current = m;
    if (m.fly && flyRef?.current && trackRef?.current) flyCard(trackRef.current, flyRef.current, m.fly);
  });
  useEffect(() => { prev.current = null; }, [s.id]);
  // 한도 대기의 남은 시간은 30초마다 다시 센다(초 단위로 돌리지 않는다)
  const [, tick] = useState(0);
  const counting = !!m.limit || m.stations.some((st) => st.people.some((p) => p.limitLeft));
  useEffect(() => {
    if (!counting) return undefined;
    const id = setInterval(() => tick((x) => x + 1), 30000);
    return () => clearInterval(id);
  }, [counting]);
  return m;
}

// 넘기기·되돌림: 일감 카드가 앞 역에서 지금 역으로(되돌림은 붉은 표시로 거꾸로) 날아간다. 움직임 줄이기·숨은 탭이면 건너뛴다.
// 카드는 Preact 가 그리지 않는 층(layer)에 붙였다가 끝나면 뗀다
function flyCard(track, layer, fly) {
  if (reduced() || (typeof document !== 'undefined' && document.hidden) || !layer.animate) return;
  const at = (i) => track.querySelector(`[data-st="${i}"] .stg-p.held .avatar`) || track.querySelector(`[data-st="${i}"] .stg-hd`);
  const a = at(fly.from);
  const b = at(fly.to);
  if (!a || !b) return;
  const base = track.getBoundingClientRect();
  const mid = (el) => { const r = el.getBoundingClientRect(); return [r.left - base.left + track.scrollLeft + r.width / 2, r.top - base.top + track.scrollTop + r.height / 2]; };
  const [x0, y0] = mid(a);
  const [x1, y1] = mid(b);
  const tok = document.createElement('div');
  tok.className = `stg-tok ${fly.kind}`;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'stg-ico');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', P[fly.kind === 'ret' ? 'ret' : 'doc']);
  svg.append(path);
  tok.append(svg);
  layer.append(tok);
  const h = 12;
  const my = Math.min(y0, y1) - (fly.kind === 'ret' ? 26 : 16);
  const anim = tok.animate([
    { transform: `translate(${x0 - h}px,${y0 - h}px) scale(.8)`, opacity: 0 },
    { transform: `translate(${x0 - h}px,${y0 - h}px)`, opacity: 1, offset: 0.12 },
    { transform: `translate(${(x0 + x1) / 2 - h}px,${my - h}px) scale(1.08)`, offset: 0.55 },
    { transform: `translate(${x1 - h}px,${y1 - h}px)`, opacity: 1, offset: 0.92 },
    { transform: `translate(${x1 - h}px,${y1 - h}px) scale(.8)`, opacity: 0 },
  ], { duration: FLY_MS, easing: 'cubic-bezier(.45,0,.25,1)' });
  anim.onfinish = () => tok.remove();
  anim.oncancel = () => tok.remove();
}

// 내 차례 알약·문을 누르면 답 창으로: 채팅을 그 창까지 내리고 창 자체에 초점을 둔다(첫 단추에 두면 Enter 한 번에 승인·받아들이기가 될 수 있다)
function goAnswer(ask) {
  if (!ask) return;
  if (ask.target === 'card') {
    if (ask.msgId) { state.ui.jumpTo = ask.msgId; changed(); }
    const id = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(ask.msgId || '')) : String(ask.msgId || '');
    focusSoon(() => document.querySelector(ANSWER_BOX.card(id)));
    return;
  }
  const find = {
    gate: () => document.querySelector(ANSWER_BOX.gate),
    ask: () => document.querySelector(ANSWER_BOX.ask) || document.querySelector(ANSWER_BOX.askMini),
    cut: () => document.querySelector(ANSWER_BOX.cut),
  }[ask.target];
  if (find) focusSoon(find);
}
function focusBox(box) {
  if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
  // 보이는 초점 테두리(stage.css 의 [data-stg-target]:focus). 창 밖으로 초점이 나가면 지운다
  box.setAttribute('data-stg-target', '');
  box.addEventListener('blur', () => box.removeAttribute('data-stg-target'), { once: true });
  box.scrollIntoView?.({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
  box.focus?.({ preventScroll: true });
}
function focusSoon(find, tries = 8) {
  const step = (left) => {
    const box = find();
    if (box && box.classList.contains('ask-mini')) { box.click(); setTimeout(() => step(left - 1), 60); return; } // 접어 둔 질문 창은 펼친 뒤에
    if (box) { focusBox(box); return; }
    if (left > 0) setTimeout(() => step(left - 1), 80);
    else toast(t('답할 창을 찾지 못했어. 채팅 맨 아래를 봐 줘.'), 'warn');
  };
  step(tries);
}

// 상태 표식: 모양(동그라미·마름모·세모·네모) + 아이콘 + 화면 낭독기 글. 옆에 같은 글이 이미 있으면 hidden 으로 읽지 않게
function Badge({ info, pulse, hidden }) {
  return hidden ? html`<span class=${`stg-bd s-${info.cls}${pulse ? ' pulse' : ''}`} aria-hidden="true"><${Ico} n=${info.icon} /></span>`
    : html`<span class=${`stg-bd s-${info.cls}${pulse ? ' pulse' : ''}`} role="img" aria-label=${info.text}><${Ico} n=${info.icon} /></span>`;
}

// 내 차례 알약(내 차례·오류·끊김) 또는 연결 끊김·통과로 끝·한도 대기 알약. 없으면 null.
// 좁으면 알약은 줄이지 않고(목표 글이 먼저 준다) 짧은 설명(.sh)만 숨긴다
function Pill({ m, compact }) {
  const k = m.ask;
  if (k) {
    const lead = k.cls === 'me' ? t('내 차례 · {title}', { title: k.title }) : k.title;
    const go = k.kind === 'error' || k.kind === 'cut' ? t('보기') : t('답하기');
    return html`<span class=${`stg-pill ${k.cls}`} role="status" title=${k.short ? `${lead} — ${k.short}` : lead}>
      <${Ico} n=${k.icon} /><span class="tx">${lead}${!compact && k.short && html`<span class="sh"> — ${k.short}</span>`}</span>
      <button type="button" class="go" aria-label=${`${lead} — ${go}`} onClick=${() => goAnswer(k)}>${go}</button>
    </span>`;
  }
  if (m.lost) return html`<span class="stg-pill cut" role="status"><${Ico} n="wifi" /><span class="tx">${m.now.text}</span></span>`;
  if (m.done) return html`<span class="stg-pill ok" role="status"><${Ico} n="check" /><span class="tx">${m.done.total ? t('통과로 끝 · 기준 {pass}/{total}', m.done) : t('통과로 끝')}</span></span>`;
  if (m.limit) return html`<span class="stg-pill lim" role="status"><${Ico} n="hour" /><span class="tx">${m.now.text}</span></span>`;
  return null;
}

// 사람 동그라미: 누르면 에이전트 상세. 카드(일감을 쥔 사람)·진행자 망치·반대편·남은 한도 시간. 지워진 에이전트는 누를 수 없다
function Person({ p, small }) {
  const a = p.gone ? null : agentById(p.id);
  const info = p.st ? personInfo(p) : null;
  const label = [p.name, info?.text, p.held && t('일감 카드를 쥔 사람'), p.chair && t('진행자'), p.opp && t('반대편')].filter(Boolean).join(' · ');
  const mins = p.limitLeft ? Math.max(1, Math.ceil(p.limitLeft / 60000)) : 0;
  const under = p.opp ? html`<span class="opp">${t('반대편')}</span>`
    : p.away ? html`<span class="away">${t('조사하러 감')}</span>`
      : mins ? html`<span class="lim">${t('{m}분 남음', { m: mins })}</span>`
        : html`<span class="nm">${p.name}</span>`;
  const inner = html`<span class="av"><${Avatar} agent=${a || { id: p.id, name: p.name }} size=${small ? 24 : 30} />${info && html`<${Badge} info=${info} pulse=${p.st === 'wait'} />`}</span>
    ${p.held && html`<span class="card" aria-hidden="true"><${Ico} n="doc" /></span>`}
    ${p.chair && html`<span class="chair" aria-hidden="true"><${Ico} n="gavel" /></span>`}
    ${!small && under}`;
  const cls = `stg-p${info ? '' : ' dim'}${p.speaker ? ' talk' : ''}${p.held ? ' held' : ''}${p.gone ? ' gone' : ''}`;
  const tip = p.detail ? `${label}\n${p.detail}` : label;
  if (p.gone) return html`<span class=${cls} role="img" title=${tip} aria-label=${label}>${inner}</span>`;
  return html`<button type="button" class=${cls} title=${tip} aria-label=${label} onClick=${() => { state.ui.inspector = p.id; changed(); }}>${inner}</button>`;
}

const CR = { pass: ['check', '통과'], fail: ['x', '불합격'], unknown: ['ask', '확인 못 함'], check: ['dots', '확인 중'], open: ['dots', '아직'] };
const critWord = (c) => t((CR[c.verdict] || CR.open)[1]);
// 기준 조각: 한 줄에 다 안 들어가면 마지막 칸이 +n. 전체는 묶음의 툴팁·이름으로
function Crits({ list, small }) {
  const { shown, hidden } = critFold(list, small ? MAX_CRIT + 1 : MAX_CRIT);
  const all = list.map((c) => `${c.id} ${critWord(c)}`).join(', ');
  return html`<span class="stg-crit" role="group" aria-label=${all} title=${list.map((c) => `${c.id} ${c.text} — ${critWord(c)}`).join('\n')}>
    ${shown.map((c) => html`<span key=${c.id} class=${`stg-cr ${c.verdict}`} aria-hidden="true"><${Ico} n=${(CR[c.verdict] || CR.open)[0]} />${c.id}</span>`)}
    ${hidden.length > 0 && html`<span key="more" class=${`stg-cr more${hidden.some((c) => c.verdict === 'fail') ? ' fail' : ''}`} aria-hidden="true">+${hidden.length}</span>`}
  </span>`;
}

// 회의 역의 말 한 줄: 의견은 모두 동시에, 조사는 자리를 비우고, 그 밖은 말하는 사람과 그 사람의 최근 글
function Say({ m }) {
  if (m.phase === 'opinion') return html`<span class="stg-say"><${Ico} n="chat" /><span class="t">${t('참석자가 동시에 의견 쓰는 중')}</span></span>`;
  if (m.phase === 'research') {
    return html`<span class="stg-say"><${Ico} n="search" /><span class="t">${m.awayName ? `${t('{name}이(가) 자료 확인하러 감', { name: m.awayName })}${m.away ? ` · ${t('자리는 비워 둠')}` : ''}` : t('조사하러 간 사람을 기다리는 중')}</span></span>`;
  }
  const sp = m.speaker;
  if (!sp) return null;
  const role = sp.opp ? ` (${t('반대편')})` : sp.chair ? ` (${t('진행자')})` : '';
  return html`<span class="stg-say"><${Ico} n="chat" /><span class="t"><b>${sp.name}${role}</b> ${sp.detail || t('말하는 중')}</span></span>`;
}

function Station({ st, small }) {
  const info = stationInfo(st.state);
  const tip = [st.names.join(', '), st.memo, ...(st.cards || []).map((c) => `${c.id} · ${c.title}`)].filter(Boolean).join('\n');
  const tag = st.meeting ? html`<span class="tag">${st.meeting.label}</span>`
    : st.ret ? html`<span class="tag ret"><${Ico} n="ret" />${t('되돌림 {n}/{of}', st.ret)}</span>`
      : st.note === 'question' ? html`<span class="tag me"><${Ico} n="ask" />${t('질문')}</span>`
        : st.note === 'merged' ? html`<span class="tag ok">${t('합침')}</span>`
          : st.memo ? html`<span class="tag plain">${st.memo}</span>`
            : st.isMeeting ? html`<span class="tag plain">${t('회의')}</span>` : '';
  const seats = st.people.map((p) => (st.meeting?.away === p.id
    ? html`<span key=${p.id} class="stg-p seat" title=${`${p.name} · ${t('조사하러 감')}`}><span class="stg-seat"></span>${!small && html`<span class="nm">${t('비움')}</span>`}</span>`
    : html`<${Person} key=${p.id} p=${p} small=${small} />`));
  const moreLabel = st.more > 0 ? `${t('{n}명 더', { n: st.more })}: ${st.hiddenNames.join(', ')}` : '';
  return html`<div class=${`stg-st ${st.state}${st.meeting ? ' meet' : ''}${st.review ? ' rev' : ''}${st.ask ? ' ask' : ''}${st.cur ? ' cur' : ''}`} data-st=${st.i} role="group" aria-label=${`${st.label} · ${info.text} · ${st.names.join(', ')}`} title=${tip}>
    <div class="stg-hd">
      ${info.icon ? html`<${Badge} info=${info} hidden=${true} />` : html`<span class="num" aria-hidden="true">${st.i + 1}</span>`}
      <span class="lab">${st.label}</span>${st.parallel > 1 && html`<span class="x">×${st.parallel}</span>`}${tag}
    </div>
    <div class="stg-body">
      ${seats}${st.more > 0 && html`<span class="more" title=${moreLabel} aria-label=${moreLabel}>+${st.more}</span>`}
      ${st.meeting && !small && html`<span class="stg-mb"><${Say} m=${st.meeting} /></span>`}
      ${st.review?.length > 0 && html`<${Crits} list=${st.review} small=${small} />`}
    </div>
  </div>`;
}

function Link({ l, ask }) {
  if (!l.gate) return html`<div class=${`stg-link${l.done ? ' done' : ''}${l.cut ? ' cut' : ''}`} aria-hidden="true"></div>`;
  const label = `${t('내 차례')} · ${ask.title}${ask.short ? ` — ${ask.short}` : ''}`;
  return html`<div class=${`stg-link gate${l.done ? ' done' : ''}`} data-gate="1">
    <button type="button" class="stg-gate" title=${label} aria-label=${`${label} — ${t('답하기')}`} onClick=${() => goAnswer(ask)}>
      <span class="stg-bd s-wait pulse"><${Ico} n=${l.gate.icon} /></span><span class="gl">${t('내 차례')}</span>
    </button>
  </div>`;
}

function End({ end }) {
  const cls = { pass: 'done', stopped: 'off', error: 'error', cut: 'off', open: 'idle' }[end.kind] || 'idle';
  return html`<div class=${`stg-end ${end.kind}`}><span class=${`stg-bd s-${cls}`} aria-hidden="true"><${Ico} n=${end.kind === 'error' ? 'warn' : end.kind === 'stopped' ? 'stop' : end.kind === 'cut' ? 'unplug' : 'flag'} /></span><span>${end.text}</span></div>`;
}

function Top({ m, small, onCollapse, foldRef }) {
  const g = m.goal;
  const pillShown = !!(m.ask || m.lost || m.done || m.limit);
  const goal = g.kind === 'none'
    ? html`<${Ico} n="target" /><b>${t('목표 없음')}</b><span class="g">${t('할 일을 보내면 팀이 시작해')}</span>`
    : small ? html`<${Ico} n="target" /><b>${m.progress}</b>${!pillShown && html`<span class="g">${m.now.text}</span>`}`
      : html`<${Ico} n="target" /><b>${g.mission ? t('목표') : t('요청')}</b><span class="g" title=${g.text}>${g.text}</span>`;
  const c = m.meta.calls;
  const cr = m.meta.criteria;
  const meta = !small && (cr || c) && html`<span class="stg-meta">
    ${cr && html`<span>${cr.judged ? t('기준 {pass}/{total} 통과', cr) : t('기준 {n}개', { n: cr.total })}</span>`}
    ${c && html`<span class=${`mono${c.cap && c.used >= c.cap ? ' over' : ''}`}>${t('호출 {used}/{cap}', c)}</span>`}
  </span>`;
  const right = pillShown ? html`<${Pill} m=${m} compact=${small} />`
    : !small && html`<span class="stg-now"><${Badge} info=${{ cls: m.now.cls, icon: m.now.icon, text: m.now.text }} hidden=${true} /><span class="t" title=${m.now.text}>${m.now.text}</span></span>`;
  return html`<div class="stg-top">
    <span class="stg-goal">${goal}</span>${meta}${right}
    <button type="button" class="stg-fold" ref=${foldRef} title=${t('위쪽 그림 접기 (채팅만 보기)')} aria-label=${t('위쪽 그림 접기 (채팅만 보기)')} onClick=${onCollapse}><${Ico} n="up" /></button>
  </div>`;
}

// 나눠 보기의 위쪽 그림. 높이 손잡이로 120px 까지 줄이면 작은 모양
export function FlowStage({ s, onCollapse }) {
  const track = useRef(null);
  const layer = useRef(null);
  const wrap = useRef(null);
  const foldRef = useRef(null);
  const m = useStage(s, layer, track);
  const [height, setHeight] = useState(() => {
    let v = 0;
    try { v = Number(localStorage.getItem('ui.stageH')); } catch { v = 0; }
    return v >= MIN_H && v <= MAX_H ? v : DEFAULT_H;
  });
  const small = height < SMALL_H;
  // 펼치기 단추로 왔으면 초점을 접기 단추로(초점이 body 로 떨어지지 않게)
  useEffect(() => { if (focusNext === 'fold') { focusNext = null; foldRef.current?.focus(); } }, []);
  // 역 줄이 가로로 넘치면 지금 역(없으면 내 차례 문)이 보이게 역 줄만 민다(페이지는 밀지 않는다). 창 크기가 바뀌어도 다시 본다
  const target = useRef(null);
  target.current = { to: m.scrollTo, gate: m.cur == null };
  const reveal = () => {
    const el = track.current;
    const { to, gate } = target.current || {};
    if (!el || to == null || el.scrollWidth <= el.clientWidth + 1) return;
    const node = (gate && el.querySelector('[data-gate]')) || el.querySelector(`[data-st="${to}"]`);
    if (!node) return;
    const left = node.offsetLeft;
    const right = left + node.offsetWidth;
    if (left >= el.scrollLeft && right <= el.scrollLeft + el.clientWidth) return; // 이미 보인다
    const x = Math.max(0, Math.round(left - (el.clientWidth - node.offsetWidth) / 2));
    if (el.scrollTo) el.scrollTo({ left: x, behavior: reduced() ? 'auto' : 'smooth' });
    else el.scrollLeft = x;
  };
  const lastKey = useRef('');
  const key = `${s.id}:${m.runId}:${m.scrollTo}`;
  useEffect(() => { if (lastKey.current !== key) { lastKey.current = key; reveal(); } });
  useEffect(() => {
    const el = track.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => reveal());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const collapse = () => { focusNext = 'unfold'; onCollapse?.(); };
  const startDrag = (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = height;
    const mv = (ev) => setHeight(Math.max(MIN_H, Math.min(MAX_H, Math.round(h0 + ev.clientY - y0))));
    const up = () => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', up);
      try { localStorage.setItem('ui.stageH', String(Math.round(wrap.current?.offsetHeight || h0))); } catch { /* 저장 못 해도 이번 화면은 그대로 */ }
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  };
  const reset = () => { try { localStorage.removeItem('ui.stageH'); } catch { /* 무시 */ } setHeight(DEFAULT_H); };
  // 역 줄의 자식: 카드가 날아가는 층(Preact 가 자식을 그리지 않는다) → 접힌 역 → 맨 앞 문 → 역·연결선 → 끝 깃발. 모두 key 를 준다
  const first = m.stations[0]?.i ?? 0;
  const kids = [html`<div key="fly" class="stg-fly" ref=${layer} aria-hidden="true"></div>`];
  if (m.folded > 0) kids.push(html`<div key="folded" class="stg-folded" title=${t('지난 단계 {n}개 접음', { n: m.folded })} aria-label=${t('지난 단계 {n}개 접음', { n: m.folded })}>+${m.folded}</div>`);
  for (const l of m.links.filter((x) => x.after < first)) kids.push(html`<${Link} key=${`g${l.after}`} l=${l} ask=${m.ask} />`);
  for (const st of m.stations) {
    kids.push(html`<${Station} key=${`s${st.i}`} st=${st} small=${small} />`);
    const l = m.links.find((x) => x.after === st.i);
    if (l) kids.push(html`<${Link} key=${`l${st.i}`} l=${l} ask=${m.ask} />`);
  }
  kids.push(html`<${End} key="end" end=${m.end} />`);
  return html`<div ref=${wrap} class=${`stg-wrap${small ? ' small' : ''}${m.lost ? ' lost' : ''}${m.cut ? ' cut' : ''}${reduced() ? ' rm' : ''}`} style=${`height:${height}px`} role="group" aria-label=${t('작업 흐름')}>
    <${Top} m=${m} small=${small} onCollapse=${collapse} foldRef=${foldRef} />
    <div class="stg-track" ref=${track}>${kids}</div>
    <div class="resizer" onPointerDown=${startDrag} onDblClick=${reset} title=${t('드래그해서 높이 조절 · 두 번 누르면 기본 크기')}></div>
  </div>`;
}

// 접은 한 줄 띠: 단계 조각 + 지금 단계 + 내 차례 알약 + 펼치기
export function StageStrip({ s, onExpand }) {
  const m = useStage(s, null, null);
  const unfold = useRef(null);
  // 접기 단추로 왔으면 초점을 펼치기 단추로
  useEffect(() => { if (focusNext === 'unfold') { focusNext = null; unfold.current?.focus(); } }, []);
  const expand = () => { focusNext = 'fold'; onExpand?.(); };
  return html`<div class=${`stg-strip${m.lost ? ' lost' : ''}${m.cut ? ' cut' : ''}${reduced() ? ' rm' : ''}`} role="group" aria-label=${t('작업 흐름 (접음)')}>
    <span class="segs" aria-hidden="true">${m.segs.map((g) => html`<i key=${g.i} class=${`sg ${g.state}`} title=${`${g.i + 1}. ${g.label} · ${stationInfo(g.state).text}`}></i>`)}</span>
    <span class="prog" title=${m.progress}>${m.progress}</span>
    <span class="grow"></span>
    <${Pill} m=${m} compact=${true} />
    <button type="button" class="stg-unfold" ref=${unfold} title=${t('위쪽 그림 펼치기')} onClick=${expand}><${Ico} n="down" /> ${t('펼치기')}</button>
  </div>`;
}
