// 읽기 전용 흐름도(결정 0030): 목표 하나(세션의 mission·실행·메시지)를 마디와 선으로. DOM 없는 순수 함수라 화면(views/flowmap.js)과 시험(test/flow-graph.test.js)이 같이 쓴다.
// 마디: 목표 잡기 → 조사 → 준비 회의 → 계획 → 카드들(물결마다 한 줄) 또는 팀의 일 단계 → 검수 → 완주 보고. 옆 마디: 회의에서 사용자에게 물은 것, 한도 대기.
// 선: 큰 흐름, 카드의 needs, 검수에서 되돌린 선(회차), 윗등급에게 넘긴 선(카드 스스로에게), 물음·한도 대기로 가는 옆 선.
// 상태(대기·하는 중·끝·막힘·구멍·오류·건너뜀·멈춤)는 색만이 아니라 기호·낱말·테두리 모양으로도 가른다. 이름·목표 글은 바깥 글이라 화면은 글자로만 넣는다
import { t } from './i18n/index.js';

export const FLOW_STATES = ['wait', 'run', 'done', 'blocked', 'hole', 'error', 'skipped', 'stopped'];
// 상태 → 기호·낱말·모양(테두리 꼴). 모양은 views/flowmap.js 와 public/css/stage.css 가 그린다
export function stateInfo(st) {
  switch (st) {
    case 'run': return { icon: '▶', word: t('하는 중'), shape: 'bold' };
    case 'done': return { icon: '✓', word: t('끝'), shape: 'round' };
    case 'blocked': return { icon: '⛔', word: t('막힘'), shape: 'notch' };
    case 'hole': return { icon: '○', word: t('구멍'), shape: 'dotted' };
    case 'error': return { icon: '!', word: t('오류'), shape: 'bar' };
    case 'skipped': return { icon: '↷', word: t('건너뜀'), shape: 'faint' };
    case 'stopped': return { icon: '■', word: t('중지됨'), shape: 'square' };
    default: return { icon: '…', word: t('기다림'), shape: 'dash' };
  }
}

const STAGE_STATE = { pending: 'wait', running: 'run', done: 'done', error: 'error', skipped: 'skipped', stopped: 'stopped', review: 'wait' };
const CARD_STATE = { waiting: 'wait', running: 'run', done: 'done', blocked: 'blocked', hole: 'hole', skipped: 'skipped' };
// 여러 실행 단계(조사의 훑어보기·질문·조사처럼)를 마디 하나로: 오류·하는 중·멈춤이 먼저, 다 끝(건너뜀 포함)이면 끝, 일부만 끝이면 하는 중, 아니면 대기
function combine(list) {
  if (!list.length) return null;
  const ss = list.map((x) => STAGE_STATE[x.st.status] || 'wait');
  for (const k of ['error', 'run', 'stopped']) if (ss.includes(k)) return k;
  if (ss.every((x) => x === 'done' || x === 'skipped')) return ss.every((x) => x === 'skipped') ? 'skipped' : 'done';
  return ss.includes('done') ? 'run' : 'wait';
}
// 실행 단계 정보가 없는 카드(계획 뒤 단계표를 아직 못 받은 화면 등): needs 깊이로 물결을 어림한다
function depthWaves(cards) {
  const depth = new Map();
  const of = (c, seen = new Set()) => {
    if (depth.has(c.id)) return depth.get(c.id);
    if (seen.has(c.id)) return 0;
    seen.add(c.id);
    const d = Math.max(0, ...(c.needs || []).map((n) => { const p = cards.find((x) => x.id === n); return p ? of(p, seen) + 1 : 0; }));
    depth.set(c.id, d);
    return d;
  };
  const out = [];
  for (const c of cards) (out[of(c)] ||= []).push(c.id);
  return out.filter(Boolean).map((ids) => ({ ids, i: -1, st: null }));
}

// 목표 → { nodes: [{ id, kind, label, sub?, who?, state, msgId, rank }], edges: [{ from, to, kind, label? }] }. rank 는 줄(같은 물결의 카드와 옆 마디는 같은 줄)
export function flowModel({ mission: m = null, runs = [], messages = [], nameOf = (id) => id } = {}) {
  const nodes = [];
  const edges = [];
  if (!m) return { nodes, edges };
  const run = (runs || []).filter((r) => r.missionId === m.id && r.mission === 'work').at(-1) || null;
  const stages = (run?.stages || []).map((st, i) => ({ st, i }));
  const stOf = (pred) => stages.filter(({ st }) => pred(st));
  const at = new Map(); // 실행 단계 번호 → 그 단계를 그리는 마디 id(한도 대기 옆 마디를 달 자리)
  let rank = 0;
  let prev = [];
  const add = (n) => { nodes.push({ sub: '', msgId: null, ...n, rank }); return n.id; };
  const flow = (to) => { for (const p of prev) edges.push({ from: p, to, kind: 'flow' }); };
  // 옆 마디: 그 마디 바로 뒤(이미 단 옆 마디 뒤)에 같은 줄로
  const side = (anchor, n, kind) => {
    const k = nodes.findIndex((x) => x.id === anchor);
    if (k < 0) return;
    let j = k + 1;
    while (nodes[j] && nodes[j].side === anchor) j++;
    nodes.splice(j, 0, { sub: '', msgId: null, ...n, side: anchor, rank: nodes[k].rank });
    edges.push({ from: anchor, to: n.id, kind });
  };
  // 회의에서 사용자에게 물은 것(결정 0028): 답한 것(decided)과 지금 열린 질문(meetAsk)
  const askSide = (anchor, pred, stageIndex) => {
    const done = (m.decided || []).filter(pred);
    const open = m.meetAsk && m.meetAsk.stageIndex === stageIndex ? m.meetAsk : null;
    const n = done.length + (open ? 1 : 0);
    if (n) side(anchor, { id: `ask:${anchor}`, kind: 'ask', label: t('사용자에게 물음 {n}번', { n }), state: open ? 'wait' : 'done', msgId: open?.msgId || null }, 'ask');
  };

  add({ id: 'goal', kind: 'goal', label: t('목표 잡기'), sub: m.goal || '', state: m.confirmedAt ? 'done' : m.status === 'drafting' ? 'run' : m.status === 'draft' ? 'wait' : 'stopped', msgId: m.cardMsgId || m.requestMsgId || null });
  prev = ['goal'];
  rank++;
  if (m.prep?.research) {
    const list = stOf((st) => ['scan', 'questions', 'research'].includes(st.mission));
    const qs = m.research?.questions || [];
    add({ id: 'research', kind: 'research', label: t('조사'), sub: qs.length ? t('질문 {n}개 중 {m}개 확인 못 함.', { n: qs.length, m: qs.filter((q) => q.status !== 'done').length }) : '',
      state: combine(list) || (m.research?.noteMsgId ? 'done' : 'wait'), msgId: m.research?.noteMsgId || m.research?.scanMsgId || null });
    for (const { i } of list) at.set(i, 'research');
    flow('research');
    prev = ['research'];
    rank++;
  }
  if (m.prep?.meeting) {
    const list = stOf((st) => st.mission === 'meeting');
    add({ id: 'meeting', kind: 'meeting', label: t('준비 회의'), state: combine(list) || (m.meetingMsgId ? 'done' : 'wait'), msgId: m.meetingMsgId || null });
    for (const { i } of list) at.set(i, 'meeting');
    askSide('meeting', (d) => d.prep, list[0]?.i ?? -2);
    flow('meeting');
    prev = ['meeting'];
    rank++;
  }
  let lastWork = [];
  if (m.work === 'cards') {
    const list = stOf((st) => st.mission === 'plan');
    add({ id: 'plan', kind: 'plan', label: t('계획'), state: combine(list) || (m.planMsgId ? 'done' : 'wait'), msgId: m.planMsgId || null });
    for (const { i } of list) at.set(i, 'plan');
    flow('plan');
    rank++;
    const cards = m.cards || [];
    const byId = new Map(cards.map((c) => [c.id, c]));
    const waves = stOf((st) => st.mission === 'cards' && st.cardIds?.length).map(({ st, i }) => ({ ids: st.cardIds.filter((id) => byId.has(id)), i, st })).filter((w) => w.ids.length);
    const placed = new Set(waves.flatMap((w) => w.ids));
    waves.push(...depthWaves(cards.filter((c) => !placed.has(c.id))));
    // 줄 번호(물결). needs 가 없는 카드·순환·앞이 아닌 줄을 가리키는 needs 가 있어도 떨어진 마디가 없게: 앞 줄의 카드를 기다리지 않는 카드는 계획에서,
    // 뒤 줄의 카드가 기다리지 않는 카드는 검수(없으면 보고)로 잇는다
    const row = new Map();
    waves.forEach((w, k) => { for (const id of w.ids) if (!row.has(id)) row.set(id, k); });
    const earlier = (c) => (c.needs || []).some((n) => row.has(n) && row.get(n) < row.get(c.id));
    const laterNeeds = (c) => cards.some((d) => row.get(d.id) > row.get(c.id) && (d.needs || []).includes(c.id));
    const seen = new Set();
    for (const w of waves) {
      for (const id of w.ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const c = byId.get(id);
        let state = CARD_STATE[c.status] || 'wait';
        if (w.st?.status === 'error' && !['done', 'hole', 'skipped', 'blocked'].includes(c.status)) state = 'error';
        if (w.st?.status === 'stopped' && ['wait', 'run'].includes(state)) state = 'stopped';
        add({ id: `card:${c.id}`, kind: 'card', label: `${c.id} · ${c.title || ''}`, who: nameOf(c.ownerId), state, msgId: c.msgId || null });
        if (!earlier(c)) edges.push({ from: 'plan', to: `card:${c.id}`, kind: 'flow' });
        for (const n of new Set(c.needs || [])) if (byId.has(n) && n !== c.id) edges.push({ from: `card:${n}`, to: `card:${c.id}`, kind: 'needs' });
        if (c.raised?.length) edges.push({ from: `card:${c.id}`, to: `card:${c.id}`, kind: 'raise', label: `↑ ${[c.raised[0].from, ...c.raised.map((r) => r.to)].map((x) => nameOf(x)).join(' → ')}` });
      }
      if (w.i >= 0) at.set(w.i, `card:${w.ids[0]}`);
      lastWork = w.ids.map((id) => `card:${id}`);
      rank++;
    }
    prev = cards.filter((c) => row.has(c.id) && !laterNeeds(c)).map((c) => `card:${c.id}`);
    if (!cards.length) prev = ['plan'];
  } else {
    for (const { st, i } of stOf((x) => !x.mission)) {
      const id = `stage:${i}`;
      const last = (messages || []).findLast((x) => x.role === 'agent' && x.runId === run.id && x.stageIndex === i);
      add({ id, kind: 'stage', label: st.label || '', state: STAGE_STATE[st.status] || 'wait', msgId: last?.id || null });
      at.set(i, id);
      askSide(id, (d) => d.stageIndex === i && !d.prep, i);
      flow(id);
      prev = [id];
      lastWork = [id];
      rank++;
    }
  }
  if (m.reviewerId) {
    const list = stOf((st) => st.mission === 'review');
    const crit = m.criteria || [];
    const last = (messages || []).findLast((x) => x.role === 'agent' && x.review && x.missionId === m.id);
    add({ id: 'review', kind: 'review', label: t('검수'), sub: m.round ? t('기준 {pass}/{total} 통과', { pass: crit.filter((c) => c.status === 'pass').length, total: crit.length }) : '', state: combine(list) || 'wait', msgId: last?.id || null });
    for (const { i } of list) at.set(i, 'review');
    flow('review');
    if (m.returns > 0 && lastWork.length) edges.push({ from: 'review', to: lastWork[0], kind: 'return', label: t('되돌림 {n}번 · 검수 {r}회차까지', { n: m.returns, r: m.round || m.returns + 1 }) });
    prev = ['review'];
    rank++;
  }
  // 끊긴 목표(cut)는 이어서 할 수 있어서 보고는 아직 기다림
  const repState = m.reportMsgId ? 'done' : ['stopped', 'cancelled'].includes(m.status) ? 'stopped' : ['done', 'accepted', 'unreviewed'].includes(m.status) ? 'skipped' : 'wait';
  add({ id: 'report', kind: 'report', label: t('완주 보고'), state: repState, msgId: m.reportMsgId || null });
  flow('report');
  // 한도 대기(결정 0019)·구독 한도 상한(결정 0026): 지금 기다리는 단계(끊긴 목표면 끊긴 자리)의 마디 옆에
  const hold = run && run.status === 'waiting' && ['quota', 'limitcap'].includes(run.hold?.reason) ? { i: run.hold.stageIndex, reason: run.hold.reason }
    : m.status === 'cut' && ['quota', 'limitcap'].includes(m.at?.wait?.reason) ? { i: m.at.stageIndex, reason: m.at.wait.reason } : null;
  if (hold && at.has(hold.i)) side(at.get(hold.i), { id: 'quota', kind: 'quota', label: hold.reason === 'quota' ? t('한도 대기') : t('구독 한도 상한'), state: 'wait' }, 'quota');
  return { nodes, edges };
}

// 글 너비 어림(px): 한글·한자·가나·전각은 글자 크기만큼, 나머지는 0.6. 실제로 재지 않는(DOM 없는) 어림이라 넉넉하게 자른다
const wide = /[\u{1100}-\u{11ff}\u{2e80}-\u{a4cf}\u{ac00}-\u{d7af}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{1f300}-\u{1faff}]/u;
const charW = (c, px) => (wide.test(c) ? px : px * 0.6);
export function fitText(text, maxW, px = 12) {
  const cs = [...String(text ?? '')];
  let w = 0;
  for (const c of cs) w += charW(c, px);
  if (w <= maxW) return cs.join('');
  const room = maxW - px;
  let out = '';
  w = 0;
  for (const c of cs) {
    const d = charW(c, px);
    if (w + d > room) break;
    out += c;
    w += d;
  }
  return out ? `${out}…` : '';
}

// 자리 잡기(px): 줄(rank)마다 위에서 아래로, 한 줄의 마디는 가운데 맞춤으로 왼쪽부터. 들어가지 않으면 그 줄 안에서 다음 줄로(가로로 넘치지 않는다).
// 왼쪽 여백은 되돌림 선, 오른쪽 여백은 윗등급 넘김 고리 자리. width 는 그릴 곳의 너비(좁은 창에서 오른쪽 패널 안)
export const FLOW_SIZE = Object.freeze({ pad: 8, left: 14, right: 16, h: 46, gapX: 10, gapY: 30, lineGap: 8, main: 220, card: 124, side: 104, font: 12, small: 11 });
export function flowLayout(model, { width = 320 } = {}) {
  const Z = FLOW_SIZE;
  const W = Math.max(60, Math.round(Number(width) || 0));
  const x0 = Z.pad + Z.left;
  const avail = Math.max(20, W - Z.pad * 2 - Z.left - Z.right);
  const wOf = (n) => Math.min(n.side ? Z.side : n.kind === 'card' ? Z.card : Z.main, avail);
  const raised = new Set(model.edges.filter((e) => e.kind === 'raise').map((e) => e.from)); // 윗등급에게 넘긴 카드: 이름 끝에 ↑(상자 안에 들어가게 미리 자리를 뺀다)
  const ranks = [];
  for (const n of model.nodes) (ranks[n.rank] ||= []).push(n);
  const nodes = [];
  let y = Z.pad + 14; // 맨 위: 되돌림 선의 이름이 들어갈 자리
  for (const row of ranks.filter(Boolean)) {
    const lines = [];
    let cur = [];
    let used = 0;
    for (const n of row) {
      const w = wOf(n);
      if (cur.length && used + Z.gapX + w > avail) { lines.push(cur); cur = []; used = 0; }
      used += (cur.length ? Z.gapX : 0) + w;
      cur.push({ n, w });
    }
    if (cur.length) lines.push(cur);
    lines.forEach((line, li) => {
      const total = line.reduce((s, x, k) => s + x.w + (k ? Z.gapX : 0), 0);
      let x = x0 + Math.max(0, (avail - total) / 2);
      for (const { n, w } of line) {
        const info = stateInfo(n.state);
        const words = [info.word, n.who || '', n.sub || ''].filter(Boolean).join(' · ');
        nodes.push({ ...n, x: Math.round(x), y, w, h: Z.h, text: raised.has(n.id) ? `${fitText(n.label, w - 30 - Z.font * 1.2, Z.font)} ↑` : fitText(n.label, w - 30, Z.font), line2: fitText(`${info.icon} ${words}`, w - 16, Z.small) });
        x += w + Z.gapX;
      }
      y += Z.h + (li < lines.length - 1 ? Z.lineGap : 0);
    });
    y += Z.gapY;
  }
  const height = Math.max(Z.h + Z.pad * 2, y - Z.gapY + Z.pad);
  const by = new Map(nodes.map((n) => [n.id, n]));
  const f = (v) => (Math.round(v * 10) / 10).toString();
  const edges = [];
  for (const e of model.edges) {
    const a = by.get(e.from);
    const b = by.get(e.to);
    if (!a || !b) continue;
    let d;
    let lx = null;
    let ly = null;
    if (e.kind === 'raise') {
      const rx = a.x + a.w;
      d = `M${f(rx)} ${f(a.y + 12)} C${f(rx + 14)} ${f(a.y + 12)} ${f(rx + 14)} ${f(a.y + a.h - 12)} ${f(rx + 1)} ${f(a.y + a.h - 12)}`;
    } else if (e.kind === 'return') {
      const gx = Math.max(2, a.x - Z.left - 8 < Z.pad ? Z.pad : x0 - Z.left + 2);
      d = `M${f(a.x)} ${f(a.y + a.h / 2)} C${f(gx)} ${f(a.y + a.h / 2)} ${f(gx)} ${f(b.y + b.h / 2)} ${f(b.x - 1)} ${f(b.y + b.h / 2)}`;
      lx = a.x;
      ly = a.y - 8;
    } else if (b.y === a.y) {
      d = `M${f(a.x + a.w)} ${f(a.y + a.h / 2)} L${f(b.x - 1)} ${f(b.y + b.h / 2)}`;
    } else {
      const sx = a.x + a.w / 2;
      const sy = a.y + a.h;
      const tx = b.x + b.w / 2;
      const ty = b.y - 1;
      const k = (ty - sy) / 2;
      d = `M${f(sx)} ${f(sy)} C${f(sx)} ${f(sy + k)} ${f(tx)} ${f(ty - k)} ${f(tx)} ${f(ty)}`;
    }
    edges.push({ ...e, d, ...(lx !== null ? { lx, ly } : {}) });
  }
  return { width: W, height: Math.ceil(height), nodes, edges, order: nodes.map((n) => n.id) };
}

// 키보드 이동: 좌우는 같은 줄(같은 높이)의 옆 마디, 위아래는 윗줄·아랫줄에서 가운데가 가장 가까운 마디, Home·End 는 처음·끝. 끝에 닿으면 그대로. 다른 키는 null
export function flowNext(L, id, key) {
  const ns = L.nodes || [];
  const cur = ns.find((n) => n.id === id);
  if (!cur) return ns[0]?.id ?? null;
  const ys = [...new Set(ns.map((n) => n.y))].sort((a, b) => a - b);
  const onLine = (y) => ns.filter((n) => n.y === y).sort((a, b) => a.x - b.x);
  const cx = (n) => n.x + n.w / 2;
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const row = onLine(cur.y);
    return (row[row.indexOf(cur) + (key === 'ArrowRight' ? 1 : -1)] || cur).id;
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const li = ys.indexOf(cur.y) + (key === 'ArrowDown' ? 1 : -1);
    if (li < 0 || li >= ys.length) return cur.id;
    return onLine(ys[li]).reduce((best, n) => (Math.abs(cx(n) - cx(cur)) < Math.abs(cx(best) - cx(cur)) ? n : best)).id;
  }
  if (key === 'Home') return L.order[0] ?? null;
  if (key === 'End') return L.order.at(-1) ?? null;
  return null;
}
