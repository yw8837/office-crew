// 사무실 렌더러 본체: 상태 → 위치/포즈, 걷기(rAF는 이동 중에만), 깊이 정렬, handoff, 서브에이전트, 카메라
import { el, NS } from './iso.js';
import { resolveSkin } from './skins.js';
import { buildVectorScene, MAX_DESKS } from './scene.js';
import { buildVillageScene } from './village.js';
import { buildRig } from './character.js';
import { renderScreen, SCREEN_OF } from './screens.js';
import { tr, normLang } from './i18n.js';

const QUALITIES = ['full', 'lite', 'static'];

const STATES = new Set(['idle', 'thinking', 'typing', 'tool', 'searching', 'reading', 'running', 'waiting', 'error', 'done', 'paused', 'offline']);
const LONG_THINK_MS = 7000;   // thinking 이 이만큼 길어지면 회의실 화이트보드로
const DONE_RELAX_MS = 2800;   // done 기지개 후 휴게실로
const DONE_BUBBLE_MS = 3500;  // done 말풍선(✓완료)은 이만큼 뒤 숨김(태그는 유지)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isMcp = (t) => /(^|_|\b)mcp/i.test(t || '');
const isPlan = (t) => /plan|todo|task/i.test(t || '');

/** 도구 이름 → 아이콘 */
export function toolIcon(name) {
  const t = String(name || '');
  if (isMcp(t)) return '🔌';
  if (/edit|write|patch|replace|create|apply|insert|rename|delete/i.test(t)) return '✏️';
  if (/read|view|cat\b|open|notebook/i.test(t)) return '📄';
  if (/bash|shell|exec|command|run|terminal|powershell|cmd|spawn/i.test(t)) return '⌨️';
  if (/search|web|fetch|grep|glob|find|browse|query|lookup|crawl|url/i.test(t)) return '🔎';
  return '🛠';
}

function fmtTokens(t) {
  if (t == null || t === '') return '';
  if (typeof t === 'string') return t;
  const n = Number(t);
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tok`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k tok`;
  return `${Math.round(n)} tok`;
}
const tail = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
};
const head = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const div = (cls) => { const d = document.createElement('div'); d.className = cls; return d; };
const colorOf = (a) => (a && typeof a.color === 'string' && a.color) || '#6b7cff';

function buildImageScene(skin, n) {
  const W = Math.max(50, +skin.width || 1200), H = Math.max(50, +skin.height || 800);
  const cs = clamp(+skin.scale || Math.min(W, H) / 900, 0.3, 3);
  const stat = el('g', { class: 'oc-static' }, el('image', { href: skin.image, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none' }));
  const src = Array.isArray(skin.desks) ? skin.desks : [];
  const desks = [];
  for (let i = 0; i < n; i++) {
    const d = src[i] && src[i].x != null ? src[i] : { x: W * (0.12 + 0.76 * ((i % 6) / 5)), y: H * (0.93 - Math.floor(i / 6) * 0.07) };
    desks.push({ index: i, chairPos: [+d.x, +d.y], screen: null, group: null, setPlate() {} });
  }
  const sp = skin.spots || {};
  const mk = (name, face) => {
    const p = sp[name];
    if (!p || p.x == null) return [];
    return [[0, 0], [42, 6], [-42, 6], [0, 26], [66, 18]].map(([ox, oy], i) => ({ pos: [p.x + ox * cs, p.y + oy * cs], pose: 'stand', face, flip: i % 2 ? -1 : 1 }));
  };
  const door = sp.door && sp.door.x != null ? [+sp.door.x, +sp.door.y] : [Math.min(40 * cs, W * 0.05), H - 8];
  return {
    mode: 'image', width: W, height: H, defs: el('defs'), stat, labels: el('g'), items: [], desks, door: null,
    spots: { search: mk('search', 'front'), shelf: mk('shelf', 'front'), server: mk('server', 'back'), meeting: mk('meeting', 'back'), lounge: mk('lounge', 'front') },
    doorPos: door, charScale: cs, speed: 120 * cs, stride: 13 * cs,
    toScreen: (p, lift = 0) => [p[0], p[1] - lift * cs],
    depth: (p) => p[1] / 10,
    path: (a, b) => [a.slice(), b.slice()],
    visitor(desk, k) { const [x, y] = desk.chairPos; return [[x + 44 * cs, y + 4 * cs], [x - 44 * cs, y + 4 * cs], [x, y + 30 * cs]][k % 3]; },
    beside(p, k) { return [[p[0] + 40 * cs, p[1] + 6 * cs], [p[0] - 40 * cs, p[1] + 6 * cs], [p[0] + 70 * cs, p[1] + 14 * cs], [p[0] - 70 * cs, p[1] + 14 * cs]][k % 4]; },
  };
}

/**
 * 사무실 렌더러 생성
 * @param {HTMLElement} container
 * @param {{skin?:string|object, reducedMotion?:boolean, onSelect?:(id:string)=>void,
 *          lang?:'ko'|'en'|'zh'|'ja', quality?:'full'|'lite'|'static'}} opts
 */
export function createOffice(container, opts = {}) {
  if (!container) throw new Error('createOffice: container 가 필요해');
  const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reducedOpt = opts.reducedMotion;
  let reduced = !!(reducedOpt ?? (mq && mq.matches));
  let lang = normLang(opts.lang);
  let quality = QUALITIES.includes(opts.quality) ? opts.quality : 'full';
  let offscreen = false;
  const T = (k, v) => tr(lang, k, v);
  /** 움직임을 생략(순간이동)할지: 줄이기 모드·static 품질·탭 숨김·화면 밖 */
  const still = () => reduced || quality === 'static' || document.hidden || offscreen;

  // ── DOM ──
  const root = div('office-root');
  root.tabIndex = 0;
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', T('ui.office'));
  root.lang = lang;
  const viewport = div('oc-viewport');
  const world = div('oc-world');
  const svg = el('svg', { class: 'oc-svg', xmlns: NS, 'aria-hidden': 'true' });
  const sortLayer = el('g', { class: 'oc-sort' });
  const ovl = div('oc-ovl');
  world.append(svg, ovl);
  viewport.append(world);
  const ctl = div('oc-ctl');
  const ctlBtns = [];
  const mkBtn = (txt, key, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = txt; b.title = T(key); b.setAttribute('aria-label', T(key));
    ctlBtns.push([b, key]);
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    ctl.append(b);
  };
  root.append(viewport, ctl);
  container.append(root);

  // ── 상태 ──
  let skin = resolveSkin(opts.skin);
  let scene = null;
  let list = [];
  const chars = new Map();
  let sorted = [];
  let selected = null;
  let raf = 0, lastT = 0, gen = 0, helperSeq = 0, destroyed = false, doorTimer = 0;
  const spotOcc = new Map();

  // ── 깊이 정렬 ──
  function insertItem(item) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m].depth <= item.depth) lo = m + 1; else hi = m; }
    sorted.splice(lo, 0, item);
    sortLayer.insertBefore(item.el, sorted[lo + 1] ? sorted[lo + 1].el : null);
  }
  function removeItem(item) {
    const i = sorted.indexOf(item);
    if (i >= 0) sorted.splice(i, 1);
    item.el.remove();
  }
  function setDepth(item, d) {
    const i = sorted.indexOf(item);
    item.depth = d;
    if (i >= 0) {
      const p = sorted[i - 1], n = sorted[i + 1];
      if ((!p || p.depth <= d) && (!n || n.depth >= d)) return;
      sorted.splice(i, 1);
    }
    insertItem(item);
  }

  // ── 캐릭터 ──
  function makeOverlay(id) {
    const o = { root: div('oc-ov'), in: div('oc-ov-in'), bub: div('oc-bub'), bi: document.createElement('span'), bt: document.createElement('span'), tag: div('oc-tag') };
    o.bi.className = 'oc-bub-i'; o.bt.className = 'oc-bub-t';
    const dots = document.createElement('span'); dots.className = 'oc-dots'; dots.innerHTML = '<i></i><i></i><i></i>';
    o.bub.append(o.bi, dots, o.bt);
    o.tag.dataset.agent = id;
    const l1 = div('oc-tag-l1');
    o.dot = document.createElement('i'); o.dot.className = 'oc-dot';
    o.name = document.createElement('b'); o.name.className = 'oc-name';
    o.chip = document.createElement('span'); o.chip.className = 'oc-chip';
    l1.append(o.dot, o.name, o.chip);
    o.l2 = div('oc-tag-l2');
    o.tok = document.createElement('span'); o.tok.className = 'oc-tok';
    o.badge = document.createElement('span'); o.badge.className = 'oc-badge';
    o.l2.append(o.tok, o.badge);
    o.tag.append(l1, o.l2);
    o.l1 = l1;
    o.in.append(o.bub, o.tag);
    // 충돌 회피용: 들어 올리는 래퍼 + 머리까지 이어지는 점선
    o.lifter = div('oc-ov-lift');
    o.stem = div('oc-stem');
    o.lifter.append(o.in);
    o.root.append(o.stem, o.lifter);
    o.key = { bub: '', tag: '' };
    Object.assign(o, { lift: 0, compact: false, dirty: true, ax: 0, ay: 0, tw: 0, l1h: 0, l2h: 12, tpad: 0, bw: 0, bh: 0 });
    return o;
  }

  function makeChar(agent, extra = {}) {
    const ch = {
      id: agent.id, agent, helper: !!extra.helper, parentId: extra.parentId || null,
      st: { state: 'idle', text: '', tool: '', tokens: null, badge: '' },
      desk: null, pos: [0, 0], lift: 0, face: 'front', flip: 1, pose: 'stand', at: 'desk',
      dest: null, targetKey: null, spot: null, walking: null, dist: 0,
      busy: false, queue: Promise.resolve(), carry: null, flash: null, visitors: 0,
      timers: {}, longThink: false, relax: false, leaving: false, gone: false,
      scale: extra.helper ? 0.7 : 1, home: null, house: null, screenKey: null,
      ov: makeOverlay(agent.id),
    };
    newRig(ch);
    return ch;
  }
  function newRig(ch) {
    ch.rig = buildRig(ch.agent);
    ch.rig.root.style.setProperty('--oc-c', colorOf(ch.agent));
    ch.item = { el: ch.rig.root, depth: 0 };
    ch.cls = ''; ch.flipKey = null;
    ch.ov.root.style.setProperty('--c', colorOf(ch.agent));
  }
  function attach(ch) {
    insertItem(ch.item);
    ovl.append(ch.ov.root);
  }
  function clearTimers(ch) {
    for (const k in ch.timers) clearTimeout(ch.timers[k]);
    ch.timers = {};
  }
  function removeChar(ch) {
    stopWalk(ch, false);
    clearTimers(ch);
    clearTimeout(ch.flashTimer);
    releaseSpot(ch);
    removeItem(ch.item);
    ch.ov.root.remove();
    chars.delete(ch.id);
    if (selected === ch.id) selected = null;
    for (const h of [...chars.values()]) if (h.helper && h.parentId === ch.id) removeChar(h);
  }

  // ── 표시 갱신 ──
  function classOf(ch) {
    let c = `oc-char st-${ch.st.state} pose-${ch.pose} face-${ch.face} at-${ch.at}`;
    if (ch.carry != null) c += ' carry';
    if (selected === ch.id) c += ' sel';
    if (ch.helper) c += ' helper';
    if (ch.gone) c += ' gone';
    return c;
  }
  function applyClass(ch) {
    const c = classOf(ch);
    if (c !== ch.cls) { ch.cls = c; ch.rig.root.setAttribute('class', c); }
    ch.rig.setFace(ch.face);
    const fk = ch.flip < 0 ? 'scale(-1 1)' : '';
    if (fk !== ch.flipKey) { ch.flipKey = fk; if (fk) ch.rig.flip.setAttribute('transform', fk); else ch.rig.flip.removeAttribute('transform'); }
  }
  function bubbleFor(ch) {
    if (ch.flash) return ['recv', ch.flash.icon, ch.flash.text];
    if (ch.carry != null) return ['carry', '📄', head(ch.carry, 18) || T('bub.carry')];
    const s = ch.st, t = s.text;
    switch (s.state) {
      case 'thinking': return ['think', '', ''];
      case 'typing': return ['say', '', tail(t, 40) || '…'];
      case 'tool': return ['tool', toolIcon(s.tool), head(s.tool || T('bub.tool'), 18)];
      case 'searching': return ['tool', '🔎', tail(t, 22) || T('bub.searching')];
      case 'reading': return ['tool', '📖', tail(t, 22) || T('bub.reading')];
      case 'running': return ['tool', '⚙️', tail(t, 22) || T('bub.running')];
      case 'waiting': return ['wait', '!', tail(t, 24) || T('bub.waiting')];
      case 'error': return ['err', '!', tail(t, 24) || T('bub.error')];
      case 'done': return ch.doneQuiet ? null : ['done', '✓', T('bub.done')];
      case 'paused': return ['pause', '⏸', T('bub.paused')];
      default: return null;
    }
  }
  function updateBubble(ch) {
    const b = bubbleFor(ch);
    const key = b ? b.join('\u0001') : '';
    const o = ch.ov;
    if (key === o.key.bub) return;
    o.key.bub = key;
    o.dirty = true;
    scheduleLayout();
    if (!b) { o.bub.className = 'oc-bub'; return; }
    o.bub.className = `oc-bub show k-${b[0]}`;
    o.bi.textContent = b[1];
    o.bt.textContent = b[2];
  }
  function updateTag(ch) {
    const a = ch.agent, s = ch.st, o = ch.ov;
    const name = a.name || String(a.id);
    const chip = ch.helper ? T('misc.helperChip') : (a.model || '');
    const tok = fmtTokens(s.tokens);
    const badge = s.badge ? String(s.badge) : '';
    const key = [name, chip, tok, badge, s.state, lang].join('\u0001');
    if (key === o.key.tag) return;
    o.key.tag = key;
    o.dirty = true;
    scheduleLayout();
    o.name.textContent = name;
    o.chip.textContent = chip; o.chip.hidden = !chip;
    o.tok.textContent = tok; o.tok.hidden = !tok;
    o.badge.textContent = badge; o.badge.hidden = !badge;
    o.l2.hidden = !tok && !badge;
    o.root.dataset.state = s.state;
    o.tag.title = `${name}${a.role ? ' · ' + a.role : ''}${chip ? ' · ' + chip : ''} — ${T('st.' + s.state)}${tok ? ' · ' + tok : ''}${badge ? ' · ' + badge : ''}`;
  }
  function updateScreen(ch) {
    const d = ch.desk;
    if (!d || !d.screen) return;
    const kind = SCREEN_OF[ch.st.state] || 'idle';
    const icon = kind === 'tool' ? toolIcon(ch.st.tool) : '';
    const key = kind + icon;
    if (ch.screenKey === key) return;
    ch.screenKey = key;
    renderScreen(d.screen, kind, { SW: d.SW, SH: d.SH, seed: d.index + 1, icon, idleColor: skin.palette ? skin.palette.screenIdle : '#3c5d8f', accent: colorOf(ch.agent), lite: quality !== 'full' });
    d.group.setAttribute('class', `oc-desk scr-${kind}${selected === ch.id ? ' sel' : ''}`);
  }
  function updateChair(ch) {
    const d = ch.desk;
    if (!d || !d.chairNear) return;
    const seated = ch.at === 'desk' && !ch.walking && ch.st.state !== 'offline';
    const front = seated && ch.face === 'front';
    d.chairNear.style.display = front ? 'none' : '';
    d.chairFar.style.display = front ? '' : 'none';
  }
  // 마을: 집 안에 있으면 캐릭터는 숨기고 집 창문에 불을 켬
  function updateHouse(ch) {
    const inside = ch.at === 'house' && !ch.walking;
    if (ch.ov.root.classList.contains('home') !== inside) {
      ch.ov.root.classList.toggle('home', inside); // 집 안: 이름표를 이름만 남게 줄임 → 크기 다시 재기
      ch.ov.dirty = true;
      scheduleLayout();
    }
    if (ch.house) ch.house.setHome(inside);
  }
  function apply(ch) {
    applyClass(ch);
    updateBubble(ch);
    updateTag(ch);
    updateScreen(ch);
    updateChair(ch);
    updateHouse(ch);
  }
  function place(ch) {
    const [sx, sy] = scene.toScreen(ch.pos, ch.lift);
    const s = ch.scale * scene.charScale;
    ch.rig.pos.setAttribute('transform', `translate(${sx.toFixed(1)} ${sy.toFixed(1)})${s !== 1 ? ` scale(${s.toFixed(3)})` : ''}`);
    ch.ov.root.style.transform = `translate(${sx.toFixed(1)}px,${(sy - 95 * s).toFixed(1)}px)`;
    ch.ov.ax = sx;
    ch.ov.ay = sy - 95 * s;
    scheduleLayout();
    const d = scene.depth(ch.pos) + 0.001;
    setDepth(ch.item, d);
    ch.ov.root.style.zIndex = String(Math.round(d * 20) + (selected === ch.id ? 100000 : 0));
  }

  // ── 위치 결정 ──
  function homeDef(ch) {
    if (ch.helper) return { pos: ch.home || scene.doorPos.slice(), pose: 'stand', face: 'front', flip: -1, at: 'helper' };
    if (ch.desk) return { pos: ch.desk.chairPos.slice(), pose: scene.mode === 'vector' ? 'sit' : 'stand', face: 'front', flip: 1, at: 'desk' };
    return { pos: scene.doorPos.slice(), pose: 'stand', face: 'front', flip: 1, at: 'desk' };
  }
  function desired(ch) {
    const s = ch.st.state, t = ch.st.tool;
    if (ch.leaving) return 'door';
    // 마을: 쉬거나 퇴근(완료 후)이면 자기 집으로
    if (ch.house && (s === 'idle' || s === 'offline' || (s === 'done' && ch.relax))) return 'house';
    let spot = null;
    if (s === 'searching' || (s === 'tool' && isMcp(t))) spot = 'search';
    else if (s === 'reading') spot = 'shelf';
    else if (s === 'running') spot = 'server';
    else if ((s === 'thinking' && ch.longThink) || (s === 'tool' && isPlan(t))) spot = 'meeting';
    else if (s === 'done' && ch.relax) spot = 'lounge';
    if (spot && scene.spots[spot] && scene.spots[spot].length) return spot;
    return 'home';
  }
  function claimSpot(ch, name) {
    const defs = scene.spots[name];
    let occ = spotOcc.get(name);
    if (!occ) spotOcc.set(name, (occ = []));
    let k = occ.findIndex((x) => !x);
    if (k < 0) k = occ.length;
    occ[k] = ch.id;
    ch.spot = { name, k };
    const def = defs[k % defs.length];
    const over = Math.floor(k / defs.length);
    const j = scene.mode === 'vector' ? 0.38 : 24 * scene.charScale;
    return { pos: [def.pos[0] + over * j, def.pos[1] + over * j * 0.6], pose: over ? 'stand' : def.pose, face: def.face, flip: def.flip, lift: over ? 0 : def.lift || 0, at: name };
  }
  function releaseSpot(ch) {
    if (!ch.spot) return;
    const occ = spotOcc.get(ch.spot.name);
    if (occ && occ[ch.spot.k] === ch.id) occ[ch.spot.k] = null;
    ch.spot = null;
  }
  function reconcile(ch, instant) {
    if (!scene || ch.busy || destroyed) return;
    const want = desired(ch);
    if (ch.targetKey === want) {
      if (!ch.walking) settle(ch);
      else apply(ch);
      return;
    }
    releaseSpot(ch);
    const dest = want === 'home' ? homeDef(ch) : want === 'door'
      ? { pos: scene.doorPos.slice(), pose: 'stand', face: 'back', flip: -1, at: 'door' }
      : want === 'house' ? { pos: ch.house.door.slice(), pose: 'stand', face: 'back', flip: 1, at: 'house' }
      : claimSpot(ch, want);
    ch.targetKey = want;
    ch.dest = dest;
    if (instant || still()) {
      // 즉시 이동: 같은 틱 안에서 위치·포즈까지 확정
      stopWalk(ch, false);
      ch.pos = dest.pos.slice();
      settle(ch);
      return;
    }
    walkTo(ch, dest.pos).then((ok) => { if (ok && ch.dest === dest) settle(ch); });
  }
  function settle(ch) {
    const d = ch.dest;
    if (!d) return;
    ch.at = d.at;
    ch.pose = d.pose;
    ch.lift = d.lift || 0;
    const s = ch.st.state;
    ch.face = d.at === 'desk' ? ((s === 'typing' || s === 'tool') ? 'back' : 'front') : d.face;
    ch.flip = d.flip ?? 1;
    place(ch);
    apply(ch);
    updateZones();
  }
  function updateZones() {
    const act = new Set();
    for (const ch of chars.values()) if (!ch.walking && ch.spot && ch.at === ch.spot.name) act.add(ch.spot.name);
    for (const z of ['search', 'meeting', 'server', 'lounge', 'shelf']) svg.classList.toggle('act-' + z, act.has(z));
  }

  // ── 태그 충돌 회피 ──
  // 화면 좌표의 태그·말풍선 사각형이 겹치면, 앞(화면 아래)쪽 캐릭터 태그는 제자리에 두고
  // 뒤쪽 태그의 토큰 줄을 접은 뒤 그래도 겹치면 위로 밀어 올린다. 선택된 태그는 항상 제자리·맨 앞.
  let layoutRaf = 0, curUi = 1, zoneEls = [];
  let layoutQueued = false;
  function scheduleLayout() {
    if (destroyed) return;
    if (quality === 'static') {
      // static: 렌더 루프(rAF) 없이 같은 틱 끝에 한 번만 계산
      if (!layoutQueued) { layoutQueued = true; queueMicrotask(() => { layoutQueued = false; layoutTags(); }); }
      return;
    }
    if (!layoutRaf) layoutRaf = requestAnimationFrame(layoutTags);
  }
  function measure(o) {
    o.dirty = false;
    const l2vis = !o.l2.hidden && !o.compact;
    if (l2vis) o.l2h = o.l2.offsetHeight;
    else if (o.l2.hidden) o.l2h = 0;
    o.tw = o.tag.offsetWidth;
    o.l1h = o.l1.offsetHeight;
    o.tpad = Math.max(0, o.tag.offsetHeight - o.l1h - (l2vis ? o.l2h : 0));
    const show = o.bub.classList.contains('show');
    o.bw = show ? o.bub.offsetWidth : 0;
    o.bh = show ? o.bub.offsetHeight : 0;
  }
  function layoutTags() {
    if (layoutRaf) { cancelAnimationFrame(layoutRaf); layoutRaf = 0; }
    if (!scene || destroyed) return;
    const list = [];
    for (const ch of chars.values()) if (!ch.gone && ch.ov.root.isConnected) list.push(ch);
    for (const ch of list) if (ch.ov.dirty) measure(ch.ov); // 읽기를 먼저 몰아서(레이아웃 강제 1회)
    // 이미 올라가 있는 태그는 계속 뒤쪽 취급(걷는 두 캐릭터가 엇갈릴 때 위아래가 자꾸 뒤바뀌지 않게)
    const key = (c) => c.item.depth - (c.ov.lift > 0 ? 0.8 : 0);
    list.sort((a, b) => ((b.id === selected) - (a.id === selected)) || (key(b) - key(a)));
    const ui = curUi, gap = 3 * ui, maxLift = 160 * ui;
    const placed = [];
    const rects = (o, lift, compact) => {
      const th = (o.l1h + (compact ? 0 : o.l2h) + o.tpad) * ui, tw = o.tw * ui, b = o.ay - lift;
      const out = [[o.ax - tw / 2, b - th, o.ax + tw / 2, b]];
      if (o.bw) {
        const bw = o.bw * ui, bb = b - th - 4 * ui;
        out.push([o.ax - bw / 2, bb - o.bh * ui, o.ax + bw / 2, bb]);
      }
      return out;
    };
    const hit = (rs) => {
      for (const a of rs) for (const p of placed) if (a[0] < p[2] && a[2] > p[0] && a[1] < p[3] && a[3] > p[1]) return a[3] - p[1];
      return 0;
    };
    for (const ch of list) {
      const o = ch.ov;
      let compact = false, lift = 0;
      let rs = rects(o, 0, false);
      if (ch.id !== selected) {
        if (o.l2h && hit(rs)) { compact = true; rs = rects(o, 0, true); }
        for (let k = 0; k < 12; k++) {
          const need = hit(rs);
          if (!need) break;
          lift = Math.min(maxLift, lift + need + gap);
          rs = rects(o, lift, compact);
          if (lift >= maxLift) break;
        }
      }
      placed.push(...rs);
      if (compact !== o.compact) { o.compact = compact; o.root.classList.toggle('compact', compact); }
      if (Math.abs(lift - o.lift) > 0.5) {
        // 피할 때(위로)는 빠르게, 제자리로 내려올 때만 천천히
        const dur = lift > o.lift ? '0s' : '.16s';
        o.lifter.style.transitionDuration = dur;
        o.stem.style.transitionDuration = dur;
        o.lift = lift;
        o.lifter.style.transform = lift ? `translateY(${(-lift).toFixed(1)}px)` : '';
        o.stem.style.height = `${lift.toFixed(1)}px`;
        o.root.classList.toggle('lifted', lift > 4);
      }
    }
    // 태그에 가려지는 구역 표지판은 흐리게
    const zs = ui * 0.82;
    for (const z of zoneEls) {
      if (!z.w) { const r = z.el.firstChild; z.w = r.offsetWidth; z.h = r.offsetHeight; }
      const a = [z.x - (z.w * zs) / 2, z.y - (z.h * zs) / 2, z.x + (z.w * zs) / 2, z.y + (z.h * zs) / 2];
      const dim = placed.some((p) => a[0] < p[2] && a[2] > p[0] && a[1] < p[3] && a[3] > p[1]);
      if (dim !== z.dim) { z.dim = dim; z.el.classList.toggle('dim', dim); }
    }
  }

  // ── 걷기 ──
  function walkTo(ch, pos, instant) {
    stopWalk(ch, false);
    const far = Math.hypot(pos[0] - ch.pos[0], pos[1] - ch.pos[1]);
    if (instant || still() || far < 1e-3) {
      ch.pos = pos.slice();
      place(ch);
      return Promise.resolve(true);
    }
    return new Promise((res) => {
      ch.walking = { path: scene.path(ch.pos, pos), i: 1, res };
      ch.pose = 'walk'; ch.lift = 0; ch.at = 'walk';
      apply(ch);
      updateZones();
      kick();
    });
  }
  function stopWalk(ch, ok) {
    const w = ch.walking;
    if (!w) return;
    ch.walking = null;
    ch.rig.setWalk(null);
    w.res(ok);
  }
  function dirFace(ch, dx, dy) {
    const sx = scene.mode === 'vector' ? dx - dy : dx;
    const sy = scene.mode === 'vector' ? dx + dy : dy;
    const face = sy < -0.2 * Math.abs(sx) ? 'back' : 'front';
    const flip = Math.abs(sx) > 1e-3 ? (sx < 0 ? -1 : 1) : ch.flip;
    if (face !== ch.face || flip !== ch.flip) { ch.face = face; ch.flip = flip; applyClass(ch); }
  }
  function tick(t) {
    raf = 0;
    if (destroyed) return;
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 1 / 60;
    lastT = t;
    let any = false;
    for (const ch of chars.values()) {
      const w = ch.walking;
      if (!w) continue;
      any = true;
      let rem = scene.speed * dt * (ch.helper ? 1.15 : 1);
      while (rem > 0 && w.i < w.path.length) {
        const tg = w.path[w.i];
        const dx = tg[0] - ch.pos[0], dy = tg[1] - ch.pos[1];
        const d = Math.hypot(dx, dy);
        if (d > 1e-4) dirFace(ch, dx, dy);
        if (d <= rem) { ch.pos = tg.slice(); rem -= d; ch.dist += d; w.i++; }
        else { ch.pos[0] += (dx / d) * rem; ch.pos[1] += (dy / d) * rem; ch.dist += rem; rem = 0; }
      }
      // 다리 프레임은 이동 거리로 넘김(발 미끄러짐 방지)
      ch.rig.setWalk((ch.dist / (scene.stride || 0.36)) * Math.PI);
      place(ch);
      if (w.i >= w.path.length) { ch.walking = null; ch.rig.setWalk(null); w.res(true); }
    }
    if (any) { layoutTags(); raf = requestAnimationFrame(tick); }
    else { lastT = 0; layoutTags(); }
  }
  function kick() {
    if (!raf && !destroyed) { lastT = 0; raf = requestAnimationFrame(tick); }
  }
  function finishAll() {
    for (const ch of chars.values()) {
      if (!ch.walking) continue;
      const p = ch.walking.path;
      ch.pos = p[p.length - 1].slice();
      place(ch);
      stopWalk(ch, true);
    }
  }

  // ── 상태 변경 ──
  // 상태가 실제로 바뀔 때만 호출됨 → 같은 상태 반복 setState 로는 타이머가 리셋되지 않음
  function onStateChange(ch) {
    clearTimers(ch);
    ch.longThink = false;
    ch.relax = false;
    ch.doneQuiet = false;
    const s = ch.st.state;
    if (s === 'done') ch.timers.doneBub = setTimeout(() => { if (ch.st.state === 'done') { ch.doneQuiet = true; updateBubble(ch); } }, DONE_BUBBLE_MS);
    if (s === 'thinking') ch.timers.think = setTimeout(() => { if (ch.st.state === 'thinking') { ch.longThink = true; reconcile(ch); } }, LONG_THINK_MS);
    if (s === 'done') ch.timers.done = setTimeout(() => { if (ch.st.state === 'done') { ch.relax = true; reconcile(ch); apply(ch); } }, DONE_RELAX_MS);
    reconcile(ch);
  }
  function setState(id, patch = {}) {
    const ch = chars.get(id);
    if (!ch || !patch || typeof patch !== 'object') return;
    const prev = ch.st.state, prevTool = ch.st.tool;
    for (const k of ['state', 'text', 'tool', 'tokens', 'badge']) if (patch[k] !== undefined) ch.st[k] = patch[k];
    if (!STATES.has(ch.st.state)) ch.st.state = 'idle';
    if (ch.st.state !== prev) onStateChange(ch);
    else if (ch.st.tool !== prevTool) reconcile(ch);
    apply(ch);
  }

  // ── handoff ──
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function flyPaper(from, to) {
    if (still()) return;
    const a = scene.toScreen(from.pos, 0), b = scene.toScreen(to.pos, to.lift);
    const sa = from.scale * scene.charScale, sb = to.scale * scene.charScale;
    const f = div('oc-fly');
    f.textContent = '📄';
    f.style.transform = `translate(${a[0]}px,${a[1] - 40 * sa}px)`;
    ovl.append(f);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      f.style.transform = `translate(${b[0]}px,${b[1] - 62 * sb}px) scale(.7)`;
      f.style.opacity = '0';
    }));
    setTimeout(() => f.remove(), 900);
  }
  function flash(ch, icon, text, ms = 1900) {
    ch.flash = { icon, text: head(text, 18) };
    updateBubble(ch);
    // 상태 타이머(clearTimers)와 분리: 상태가 바뀌어도 받은 표시는 제시간에 사라지게
    clearTimeout(ch.flashTimer);
    ch.flashTimer = setTimeout(() => { ch.flash = null; updateBubble(ch); }, ms);
  }
  function handoff(fromId, toId, label = '') {
    const from = chars.get(fromId), to = chars.get(toId);
    if (!scene || !from || !to || from === to) return Promise.resolve(false);
    return new Promise((resolve) => {
      const job = async () => {
        let ok = false, dest = null;
        const cleanup = () => {
          to.visitors = Math.max(0, to.visitors - 1);
          from.carry = null;
          from.busy = false;
          from.targetKey = null;
          if (chars.get(fromId) === from) { apply(from); reconcile(from); }
        };
        // 걷는 도중 씬이 다시 만들어지면(스킨·인원 변경) 새 씬에서 이어서 전달(최대 3번)
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          if (destroyed || chars.get(fromId) !== from || chars.get(toId) !== to) return resolve(false);
          const g0 = gen;
          from.busy = true;
          from.carry = String(label || T('misc.papers'));
          releaseSpot(from);
          from.targetKey = 'visit';
          const k = to.visitors++;
          const atDesk = to.at === 'desk' && to.desk && !to.walking;
          // 마을: 받는 사람이 집에 있으면(곧 출근할 다음 단계) 빈 집 대신 그 사람 회사 책상으로 가져다 둠
          const atHome = to.house && to.desk && (to.at === 'house' || to.dest?.at === 'house' || to.dest?.at === 'desk');
          const vpos = atDesk || atHome ? scene.visitor(to.desk, k) : scene.beside(to.pos, k);
          dest = { pos: vpos, pose: 'stand', face: 'front', flip: 1, at: 'visit' };
          from.dest = dest;
          apply(from);
          ok = await walkTo(from, vpos);
          if (ok && !destroyed && gen === g0 && chars.get(toId) === to) break;
          ok = false;
          const rebuilt = gen !== g0;
          cleanup();
          if (!rebuilt || destroyed) return resolve(false);
        }
        if (!ok) return resolve(false);
        const [ax] = scene.toScreen(from.pos), [bx] = scene.toScreen(to.pos);
        dest.flip = bx < ax ? -1 : 1;
        settle(from);
        flyPaper(from, to);
        from.carry = null;
        apply(from);
        flash(to, '📥', label || T('bub.received'));
        resolve(true);
        await sleep(still() ? 120 : 700);
        cleanup();
      };
      from.queue = from.queue.then(job, job);
    });
  }

  // ── 서브에이전트 ──
  function openDoor() {
    if (!scene || !scene.door) return;
    scene.door.classList.add('open');
    clearTimeout(doorTimer);
    doorTimer = setTimeout(() => scene && scene.door && scene.door.classList.remove('open'), 1700);
  }
  function helperHome(ch) {
    const p = chars.get(ch.parentId);
    if (!p) return scene.doorPos.slice();
    const sibs = [...chars.values()].filter((h) => h.helper && h.parentId === ch.parentId && !h.leaving);
    const k = Math.max(0, sibs.indexOf(ch));
    // 부모가 자리에 있으면 책상 옆, 다른 방에 가 있으면(또는 가는 중이면) 그 목적지 옆
    const away = p.dest && p.dest.at !== 'desk' && p.dest.at !== 'visit';
    const base = away ? p.dest.pos : p.desk ? p.desk.chairPos : p.pos;
    return scene.beside(base, k);
  }
  function spawnHelper(parentId, o = {}) {
    const parent = chars.get(parentId);
    if (!scene || !parent || parent.helper) return null;
    const id = `${parentId}::sub${++helperSeq}`;
    const agent = { id, name: o.label || o.name || T('misc.helper'), color: colorOf(parent.agent), model: '', avatar: o.avatar };
    const ch = makeChar(agent, { helper: true, parentId });
    ch.autoName = !(o.label || o.name); // 기본 이름이면 언어를 바꿀 때 같이 바뀜
    chars.set(id, ch);
    ch.pos = scene.doorPos.slice();
    ch.home = helperHome(ch);
    ch.st.state = o.state && STATES.has(o.state) ? o.state : 'idle';
    attach(ch);
    ch.dest = { pos: ch.pos.slice(), pose: 'stand', face: 'front', flip: 1, at: 'door' };
    settle(ch);
    openDoor();
    ch.timers.spawn = setTimeout(() => reconcile(ch), still() ? 0 : 420);
    return id;
  }
  function dismissHelper(id) {
    const ch = chars.get(id);
    if (!ch || !ch.helper) return Promise.resolve(false);
    if (ch.leavingP) return ch.leavingP;
    ch.leaving = true;
    clearTimers(ch);
    ch.leavingP = new Promise((res) => {
      flash(ch, '👋', T('bub.leave'), 4000);
      const go = () => {
        ch.busy = false;
        ch.targetKey = null;
        reconcile(ch);
        const wait = () => {
          if (destroyed || chars.get(id) !== ch) return res(false);
          if (ch.walking || ch.at !== 'door') { setTimeout(wait, 120); return; }
          openDoor();
          ch.gone = true;
          applyClass(ch);
          ch.ov.root.classList.add('gone');
          setTimeout(() => { if (chars.get(id) === ch) removeChar(ch); res(true); }, still() ? 0 : 480);
        };
        wait();
      };
      // handoff 중이면 끝난 뒤 퇴근
      ch.queue = ch.queue.then(go, go);
    });
    return ch.leavingP;
  }

  // ── 씬 구성 ──
  function applySkinVars() {
    root.className = root.className.replace(/\boc-skin-\S+/g, '').trim() + ` oc-skin-${skin.type === 'image' ? 'custom' : skin.type === 'village' ? 'village' : skin.id}`;
    const p = skin.palette;
    root.style.setProperty('--oc-bg1', p ? p.bg : '#20242c');
    root.style.setProperty('--oc-bg2', p ? p.bg2 : '#14171d');
    applyModeClasses();
  }
  function applyModeClasses() {
    root.classList.toggle('oc-reduced', reduced);
    root.classList.toggle('oc-q-lite', quality === 'lite');
    root.classList.toggle('oc-q-static', quality === 'static');
  }
  function rebuild() {
    gen++;
    for (const ch of chars.values()) stopWalk(ch, false);
    spotOcc.clear();
    clearTimeout(doorTimer);
    scene = skin.type === 'image' ? buildImageScene(skin, list.length)
      : skin.type === 'village' ? buildVillageScene(skin, list.length, { lite: quality !== 'full' })
        : buildVectorScene(skin, list.length, { lite: quality !== 'full' });
    applySkinVars();
    svg.setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`);
    svg.setAttribute('width', scene.width);
    svg.setAttribute('height', scene.height);
    world.style.width = scene.width + 'px';
    world.style.height = scene.height + 'px';
    sorted = scene.items.slice().sort((a, b) => a.depth - b.depth);
    sortLayer.replaceChildren(...sorted.map((i) => i.el));
    svg.replaceChildren(scene.defs, scene.stat, sortLayer, scene.labels);
    ovl.replaceChildren();
    // 구역 표지판·네온 간판(HTML)
    zoneEls = [];
    for (const z of scene.zones || []) {
      const d = div('oc-zone');
      const t = div('oc-zone-in');
      zoneEls.push({ el: d, t, key: z.key, x: z.x, y: z.y, w: 0, h: 0, dim: false });
      d.style.transform = `translate(${z.x.toFixed(1)}px,${z.y.toFixed(1)}px)`;
      t.textContent = T('zone.' + z.key);
      d.append(t);
      ovl.append(d);
    }
    if (scene.neon) {
      const n = div('oc-neon');
      const [ox, oy] = scene.neon.origin;
      n.style.transform = `matrix(0.8944,-0.4472,0,1,${ox.toFixed(1)},${oy.toFixed(1)}) translateY(-100%)`;
      n.style.setProperty('--neon', scene.neon.color);
      n.textContent = scene.neon.text;
      ovl.append(n);
    }
    list.forEach((a, i) => {
      const ch = chars.get(a.id);
      ch.desk = scene.desks[i] || null;
      if (ch.desk) {
        ch.desk.setPlate(colorOf(a));
        ch.desk.group && ch.desk.group.setAttribute('data-agent-desk', a.id);
      }
      ch.house = (scene.houses && scene.houses[i]) || null;
      if (ch.house) ch.house.setPlate(colorOf(a));
    });
    for (const ch of [...chars.values()]) {
      if (ch.helper && !chars.has(ch.parentId)) { chars.delete(ch.id); continue; }
      newRig(ch);
      ch.screenKey = null;
      ch.targetKey = null;
      ch.spot = null;
      attach(ch);
    }
    for (const ch of chars.values()) {
      if (ch.helper) ch.home = helperHome(ch);
      ch.pos = homeDef(ch).pos;
      reconcile(ch, true);
      if (ch.busy) { ch.dest = homeDef(ch); settle(ch); }
      apply(ch);
    }
    for (const ch of chars.values()) ch.ov.dirty = true;
    updateZones();
    fit();
    scheduleLayout();
  }
  const visualKey = (a) => JSON.stringify([a.color || '', a.avatar || null]);
  function setAgents(arr) {
    const next = (Array.isArray(arr) ? arr : []).filter((a) => a && a.id != null).slice(0, MAX_DESKS).map((a) => ({ ...a, id: String(a.id) }));
    const same = !!scene && next.length === list.length && next.every((a, i) => a.id === list[i].id);
    const ids = new Set(next.map((a) => a.id));
    for (const ch of [...chars.values()]) if (!ch.helper && !ids.has(ch.id)) removeChar(ch);
    const changed = [];
    for (const a of next) {
      const ch = chars.get(a.id);
      if (!ch) chars.set(a.id, makeChar(a));
      else {
        if (visualKey(ch.agent) !== visualKey(a)) changed.push(ch);
        ch.agent = a;
      }
    }
    list = next;
    if (!same) { rebuild(); return; }
    for (const ch of chars.values()) {
      if (changed.includes(ch)) {
        removeItem(ch.item);
        newRig(ch);
        insertItem(ch.item);
        if (ch.desk) ch.desk.setPlate(colorOf(ch.agent));
        if (ch.house) ch.house.setPlate(colorOf(ch.agent));
        ch.screenKey = null;
        place(ch);
      }
      apply(ch);
    }
  }
  function setSkin(s) {
    skin = resolveSkin(s);
    rebuild();
  }
  function select(id) {
    const prev = selected;
    selected = id != null && chars.has(String(id)) ? String(id) : null;
    for (const x of new Set([prev, selected])) {
      const ch = x != null && chars.get(x);
      if (!ch) continue;
      applyClass(ch);
      const on = selected === x;
      ch.ov.root.classList.toggle('sel', on);
      ch.ov.root.style.zIndex = String(Math.round(ch.item.depth * 20) + (on ? 100000 : 0));
      scheduleLayout();
      if (ch.desk && ch.desk.group) ch.desk.group.classList.toggle('sel', on);
      if (ch.house) ch.house.group.classList.toggle('sel', on);
    }
  }

  // ── 카메라 ──
  const cam = { s: 1, x: 0, y: 0, fit: 1 };
  let wcTimer = 0, roRaf = 0;
  function applyCam() {
    world.style.transform = `translate(${cam.x.toFixed(1)}px,${cam.y.toFixed(1)}px) scale(${cam.s.toFixed(4)})`;
    const ui = +clamp(0.98 / cam.s, 0.75, 2.4).toFixed(3);
    world.style.setProperty('--ui', String(ui));
    if (ui !== curUi) { curUi = ui; scheduleLayout(); }
  }
  function hint() {
    world.style.willChange = 'transform';
    clearTimeout(wcTimer);
    wcTimer = setTimeout(() => { world.style.willChange = ''; }, 240);
  }
  function fit() {
    if (!scene) return;
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    if (vw < 10 || vh < 10) return;
    const s = Math.min(vw / scene.width, vh / scene.height) * 0.98;
    cam.fit = s; cam.s = s;
    cam.x = (vw - scene.width * s) / 2;
    cam.y = (vh - scene.height * s) / 2;
    applyCam();
  }
  /** 캐릭터를 화면 가운데로(zoom = 맞춤 배율의 몇 배) */
  function focus(id, zoom = 2) {
    const ch = chars.get(String(id));
    if (!ch || !scene) return;
    const [sx, sy] = scene.toScreen(ch.pos, ch.lift);
    cam.s = clamp(cam.fit * zoom, cam.fit * 0.5, cam.fit * 2.5);
    cam.x = viewport.clientWidth / 2 - sx * cam.s;
    cam.y = viewport.clientHeight / 2 - (sy - 50 * ch.scale * scene.charScale) * cam.s;
    applyCam();
    hint();
  }
  function zoomAt(mx, my, f) {
    const ns = clamp(cam.s * f, cam.fit * 0.5, cam.fit * 2.5);
    cam.x = mx - (mx - cam.x) * (ns / cam.s);
    cam.y = my - (my - cam.y) * (ns / cam.s);
    cam.s = ns;
    applyCam();
    hint();
  }
  mkBtn('+', 'ui.zoomIn', () => zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1.25));
  mkBtn('−', 'ui.zoomOut', () => zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 0.8));
  mkBtn('⤢', 'ui.fit', fit);

  const onWheel = (e) => {
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-clamp(e.deltaY, -120, 120) * 0.0018));
  };
  let drag = null;
  const onDown = (e) => {
    if (e.button !== 0) return;
    root.focus({ preventScroll: true });
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, target: e.target };
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      try { viewport.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
      root.classList.add('oc-grabbing');
    }
    if (drag.moved) { cam.x = drag.cx + dx; cam.y = drag.cy + dy; applyCam(); hint(); }
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    root.classList.remove('oc-grabbing');
    if (!d.moved && e.type === 'pointerup') clickAt(d.target);
  };
  function clickAt(target) {
    if (!target || !target.closest) return;
    let id = null;
    const a = target.closest('[data-agent]');
    if (a) id = a.getAttribute('data-agent');
    if (!id) {
      const dk = target.closest('[data-desk]') || target.closest('[data-house]');
      if (dk) { const i = +(dk.getAttribute('data-desk') ?? dk.getAttribute('data-house')); id = list[i] ? list[i].id : null; }
    }
    const ch = id && chars.get(id);
    if (!ch) return;
    const pick = ch.helper ? ch.parentId : ch.id;
    select(pick);
    if (onSelect) onSelect(pick);
  }
  const onKey = (e) => {
    const step = 40;
    if (e.key === '+' || e.key === '=') zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1.2);
    else if (e.key === '-') zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1 / 1.2);
    else if (e.key === '0') fit();
    else if (e.key === 'ArrowLeft') { cam.x += step; applyCam(); }
    else if (e.key === 'ArrowRight') { cam.x -= step; applyCam(); }
    else if (e.key === 'ArrowUp') { cam.y += step; applyCam(); }
    else if (e.key === 'ArrowDown') { cam.y -= step; applyCam(); }
    else return;
    e.preventDefault();
  };
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('pointerdown', onDown);
  viewport.addEventListener('pointermove', onMove);
  viewport.addEventListener('pointerup', onUp);
  viewport.addEventListener('pointercancel', onUp);
  viewport.addEventListener('dblclick', fit);
  root.addEventListener('keydown', onKey);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(roRaf); roRaf = requestAnimationFrame(fit); }) : null;
  if (ro) ro.observe(viewport);
  const onVis = () => {
    root.classList.toggle('oc-hidden', !!document.hidden);
    if (document.hidden) finishAll();
    else scheduleLayout();
  };
  document.addEventListener('visibilitychange', onVis);
  const onMq = () => { if (reducedOpt == null) setReducedMotion(null); };
  if (mq && mq.addEventListener) mq.addEventListener('change', onMq);
  onVis();

  function setReducedMotion(v) {
    reducedOpt = v;
    reduced = !!(v ?? (mq && mq.matches));
    applyModeClasses();
    if (reduced) finishAll();
  }

  // 컨테이너가 화면 밖이면(스크롤·접힌 패널) 애니메이션 일시정지, 이동은 순간이동
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((ents) => {
    const vis = ents.some((e) => e.isIntersecting);
    if (offscreen === !vis) return;
    offscreen = !vis;
    root.classList.toggle('oc-offscreen', offscreen);
    if (offscreen) finishAll(); else scheduleLayout();
  }) : null;
  if (io) io.observe(root);

  /** 언어 바꾸기(ko/en/zh/ja, 모르면 en) — 표지판·말풍선·태그·버튼을 바로 다시 그림 */
  function setLanguage(l) {
    lang = normLang(l || 'en');
    root.lang = lang;
    root.setAttribute('aria-label', T('ui.office'));
    for (const [b, key] of ctlBtns) { b.title = T(key); b.setAttribute('aria-label', T(key)); }
    for (const z of zoneEls) { z.t.textContent = T('zone.' + z.key); z.w = 0; }
    for (const ch of chars.values()) {
      if (ch.helper && ch.autoName) ch.agent.name = T('misc.helper');
      ch.ov.key.tag = '';
      ch.ov.key.bub = '';
      updateTag(ch);
      updateBubble(ch);
      ch.ov.dirty = true;
    }
    scheduleLayout();
  }
  /** 품질: full(기본) | lite(장식 반복 애니메이션 끔·장식 요소 축소, 걷기 유지) | static(애니메이션 0, 순간이동, 렌더 루프 없음) */
  function setQuality(q) {
    if (!QUALITIES.includes(q) || q === quality) return;
    const wasLite = quality !== 'full';
    quality = q;
    applyModeClasses();
    if (still()) finishAll();
    if ((q !== 'full') !== wasLite && skin.type !== 'image') rebuild();
    else scheduleLayout();
  }

  rebuild();

  return {
    setAgents,
    setState,
    handoff,
    setSkin,
    select,
    spawnHelper,
    dismissHelper,
    fit,
    focus,
    setReducedMotion,
    setLanguage,
    setQuality,
    get skin() { return skin; },
    get lang() { return lang; },
    get quality() { return quality; },
    getSnapshot() {
      return [...chars.values()].map((ch) => {
        const [sx, sy] = scene ? scene.toScreen(ch.pos, ch.lift) : [0, 0];
        const o = {
          id: ch.id, state: ch.st.state,
          pos: { x: Math.round(ch.pos[0] * 1000) / 1000, y: Math.round(ch.pos[1] * 1000) / 1000 },
          screen: { x: Math.round(sx), y: Math.round(sy) },
          at: ch.walking ? 'walking' : ch.at, moving: !!ch.walking, face: ch.face, pose: ch.pose,
        };
        if (ch.carry != null) o.carry = ch.carry;
        if (ch.helper) { o.helper = true; o.parentId = ch.parentId; }
        return o;
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      gen++;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(roRaf);
      cancelAnimationFrame(layoutRaf);
      clearTimeout(wcTimer);
      clearTimeout(doorTimer);
      for (const ch of chars.values()) { stopWalk(ch, false); clearTimers(ch); clearTimeout(ch.flashTimer); }
      chars.clear();
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq);
      root.remove();
    },
  };
}
