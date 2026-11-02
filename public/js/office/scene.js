// 벡터 아이소메트릭 사무실 씬: 바닥·벽·구역(자료실/정보검색실/휴게실/회의실/서버실/개발실)·책상
import {
  el, pts, uid, projector, planeX, planeY, planeF, box, cylinder, floorShadow, setDetail,
  shade, mix, alpha, rng, L, RX1, RY1,
} from './iso.js';
import { makeGridNav } from './nav.js';

export const ROOM = { W: 22, D: 18, WH: 190, T: 0.35, S: 18 };
const DESK_X = [6.5, 10.2, 13.9, 17.6];
const DESK_Y = [7.8, 11.2, 14.6];
// 책상 채우는 순서 [행, 열] — 적은 인원도 가운데에 모이게
const DESK_ORDER = [[0, 1], [0, 2], [1, 1], [1, 2], [0, 0], [0, 3], [1, 0], [1, 3], [2, 1], [2, 2], [2, 0], [2, 3]];
export const MAX_DESKS = 12;
let LITE = false; // 저사양(lite/static) 씬: 장식 요소 수를 줄임

/** 화면에 쓸 위치(spot)들. pose: sit|stand, face: front|back, flip: 1|-1, lift: 앉는 높이 보정 */
const SPOTS = {
  shelf: [[1.55, 1.7], [1.55, 3.1], [1.55, 4.5], [2.5, 2.4], [2.5, 3.9]].map((p) => ({ pos: p, pose: 'stand', face: 'front', flip: -1 })),
  search: [[2.55, 9.35], [1.6, 11.1], [2.5, 12.0], [3.3, 10.4], [3.4, 9.1]].map((p, i) => ({ pos: p, pose: 'stand', face: 'front', flip: i === 1 ? 1 : -1 })),
  meeting: [[6.5, 1.45], [7.9, 1.45], [9.3, 1.45], [5.3, 1.9], [10.5, 1.9]].map((p) => ({ pos: p, pose: 'stand', face: 'back', flip: 1 })),
  server: [[15.85, 2.15], [17.85, 2.15], [19.85, 2.15], [16.85, 3.05], [18.85, 3.05]].map((p) => ({ pos: p, pose: 'stand', face: 'back', flip: 1 })),
  lounge: [
    { pos: [0.98, 14.85], pose: 'sit', face: 'front', flip: 1, lift: 5 },
    { pos: [0.98, 15.8], pose: 'sit', face: 'front', flip: 1, lift: 5 },
    { pos: [0.98, 16.72], pose: 'sit', face: 'front', flip: 1, lift: 5 },
    { pos: [1.55, 13.3], pose: 'stand', face: 'back', flip: -1 },
    { pos: [3.85, 14.6], pose: 'stand', face: 'front', flip: -1 },
    { pos: [3.85, 16.3], pose: 'stand', face: 'front', flip: -1 },
  ],
};

// 1~6명일 때는 개발실 구역 전체로 퍼뜨림(머리 위 태그가 화면에서 덜 겹치게 계산해 고른 자리).
// 7명 이상은 4×3 격자. 각 배치는 화면 왼쪽→오른쪽 순서로 정렬해 팀 순서와 읽는 방향을 맞춤.
const SPREAD = {
  1: [[12.05, 11.2]],
  2: [[6.5, 14.6], [17.6, 7.8]],
  3: [[6.5, 14.6], [12.05, 7.8], [17.6, 14.6]],
  4: [[6.5, 7.8], [9.275, 14.6], [14.825, 7.8], [17.6, 14.6]],
  5: [[6.5, 7.8], [6.5, 14.6], [12.05, 11.2], [17.6, 7.8], [17.6, 14.6]],
  6: [[6.5, 11.2], [9.275, 7.8], [9.275, 14.6], [14.825, 11.2], [17.6, 7.8], [17.6, 14.6]],
};
for (const k in SPREAD) SPREAD[k].sort((a, b) => (a[0] - a[1]) - (b[0] - b[1]));

export function deskSlot(i, n = MAX_DESKS) {
  if (n <= 6 && SPREAD[n] && SPREAD[n][i]) { const [dx, dy] = SPREAD[n][i]; return { dx, dy }; }
  const [r, c] = DESK_ORDER[i % MAX_DESKS];
  return { dx: DESK_X[c], dy: DESK_Y[r] };
}

// ── 공용 그리기 ─────────────────────────────────────────────────────
function leaf(cx, cy, len, w, ang, fill, rib) {
  const d = `M0 0 C${w * 0.95} ${-len * 0.25} ${w * 0.7} ${-len * 0.78} 0 ${-len} C${-w * 0.7} ${-len * 0.78} ${-w * 0.95} ${-len * 0.25} 0 0 Z`;
  return el('g', { transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${ang.toFixed(1)})` },
    el('path', { d, fill, stroke: shade(fill, -0.3), 'stroke-width': 0.6 }),
    rib ? el('path', { d: `M0 -2 L0 ${-len * 0.8}`, stroke: shade(fill, 0.35), 'stroke-width': 0.7, 'stroke-opacity': 0.7 }) : null,
  );
}

function plant(P, x, y, kind, pal, size = 1, seed = 1) {
  const r = rng(seed * 977 + 13);
  const g = el('g', { class: 'oc-plant' });
  const potR = 0.2 * size, potH = 17 * size;
  const [sx, sy] = P(x, y, 0);
  g.append(el('ellipse', { cx: sx + 4, cy: sy + 2, rx: potR * RX1 * 1.5, ry: potR * RY1 * 1.5, fill: '#000', 'fill-opacity': 0.12 }));
  g.append(cylinder(P, x, y, 0, potR, potH, pal.pot, { inner: '#5a3c25' }));
  g.append(el('path', { d: `M${sx - potR * RX1} ${sy - potH * 0.72} L${sx + potR * RX1} ${sy - potH * 0.72}`, stroke: shade(pal.pot, -0.18), 'stroke-width': 1.4 }));
  const [cx, cy] = P(x, y, potH);
  const cols = [pal.plantDark, pal.plant, pal.plantLight];
  if (kind === 'tall') {
    const n = 11;
    for (let i = 0; i < n; i++) {
      const a = -70 + (140 * i) / (n - 1) + (r() - 0.5) * 14;
      const len = (26 + r() * 22) * size * (1 - Math.abs(a) / 220);
      g.append(leaf(cx + (r() - 0.5) * 4, cy - 2, len, 6.5 * size, a, cols[i % 3], true));
    }
  } else if (kind === 'snake') {
    for (let i = 0; i < 7; i++) {
      const a = -24 + i * 8 + (r() - 0.5) * 6;
      g.append(leaf(cx - 6 + i * 2, cy, (24 + r() * 16) * size, 3.6 * size, a, i % 2 ? pal.plant : pal.plantDark, false));
    }
  } else {
    const blobs = [[-8, -10, 10], [8, -11, 10], [0, -18, 11], [-5, -24, 9], [6, -25, 9], [0, -30, 8]];
    blobs.forEach(([dx, dy, rr], i) => {
      g.append(el('circle', { cx: cx + dx * size, cy: cy + dy * size, r: rr * size, fill: cols[i % 3], stroke: shade(pal.plantDark, -0.25), 'stroke-width': 0.6 }));
    });
    g.append(el('circle', { cx: cx - 4 * size, cy: cy - 27 * size, r: 2.5 * size, fill: '#fff', 'fill-opacity': 0.25 }));
  }
  return g;
}

function succulent(P, x, y, z, pal) {
  const g = el('g');
  g.append(cylinder(P, x, y, z, 0.07, 6, pal.pot, { inner: '#5a3c25' }));
  const [cx, cy] = P(x, y, z + 6);
  [[-3, -2, -30], [3, -2, 30], [0, -4, 0], [-1.5, -1, -60], [1.5, -1, 60]].forEach(([dx, dy, a], i) => {
    g.append(leaf(cx + dx, cy + dy, 7, 2.6, a, i % 2 ? pal.plant : pal.plantLight, false));
  });
  return g;
}

/**
 * 사무용 의자. back: 'near'(+x/+y 쪽)|'far'(-x/-y 쪽)|'both'(둘 다 그려 두고 클래스로 전환)
 * axis: 'x' 면 등받이가 x 축 방향 앞뒤, 'y' 면 y 축 방향
 */
function officeChair(P, x, y, pal, axis = 'x') {
  const col = pal.chair, frame = pal.chairFrame;
  const base = el('g', { class: 'oc-chair-base' });
  const [cx, cy] = P(x, y, 0);
  base.append(el('ellipse', { cx: cx + 3, cy: cy + 1.5, rx: 0.36 * RX1, ry: 0.36 * RY1, fill: '#000', 'fill-opacity': 0.14 }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const [ex, ey] = P(x + Math.cos(a) * 0.27, y + Math.sin(a) * 0.27, 2);
    base.append(
      el('path', { d: `M${cx} ${cy - 3} L${ex} ${ey}`, stroke: frame, 'stroke-width': 2.4, 'stroke-linecap': 'round' }),
      el('circle', { cx: ex, cy: ey + 1, r: 1.6, fill: '#1a1d22' }),
    );
  }
  base.append(el('rect', { x: cx - 1.6, y: cy - 14, width: 3.2, height: 11, fill: shade(frame, 0.2) }));
  base.append(box(P, x - 0.27, y - 0.27, 13, 0.54, 0.54, 4.5, col, { hl: 0.25, gloss: false }));
  const back = (side) => {
    const g = el('g', { class: `oc-chair-back oc-cb-${side}` });
    const off = side === 'near' ? 0.25 : -0.25;
    if (axis === 'x') {
      const [px, py] = P(x + off, y, 17);
      g.append(el('rect', { x: px - 1.5, y: py - 10, width: 3, height: 10, fill: frame }));
      g.append(el('g', { transform: planeX(P, x + off, y + 0.29, 52) },
        el('rect', { x: 0, y: 0, width: 0.58 * L, height: 33, rx: 6, fill: shade(col, side === 'near' ? -0.1 : 0.05), stroke: shade(col, -0.45), 'stroke-width': 0.9 }),
        el('rect', { x: 3, y: 3, width: 0.58 * L - 6, height: 9, rx: 4, fill: '#fff', 'fill-opacity': 0.08 }),
      ));
    } else {
      const [px, py] = P(x, y + off, 17);
      g.append(el('rect', { x: px - 1.5, y: py - 10, width: 3, height: 10, fill: frame }));
      g.append(el('g', { transform: planeY(P, x - 0.29, y + off, 52) },
        el('rect', { x: 0, y: 0, width: 0.58 * L, height: 33, rx: 6, fill: shade(col, side === 'near' ? 0.02 : 0.08), stroke: shade(col, -0.45), 'stroke-width': 0.9 }),
        el('rect', { x: 3, y: 3, width: 0.58 * L - 6, height: 9, rx: 4, fill: '#fff', 'fill-opacity': 0.08 }),
      ));
    }
    return g;
  };
  return { base, near: back('near'), far: back('far') };
}

// 구역 표지판은 HTML 오버레이로 그림(SVG text 는 확대/축소 뒤 크롬에서 글자 크기가 어긋나는 문제가 있어 쓰지 않음)
function zoneLabel(P, x, y, z, key) {
  const [sx, sy] = P(x, y, z);
  return { x: sx, y: sy, key }; // 글자는 언어 사전(zone.<key>)에서
}

// ── 벽 장식 ─────────────────────────────────────────────────────────
function windowBack(P, defs, x0, x1, zb, zt, pal, props, seed) {
  const w = (x1 - x0) * L, h = zt - zb;
  const r = rng(seed);
  const frame = props.sky === 'night' ? '#4a5582' : props.wainscot ? shade(pal.wood, 0.1) : '#ffffff';
  const g = el('g', { class: 'oc-window' });
  const plane = el('g', { transform: planeY(P, x0, 0, zt) });
  const clip = uid('wclip');
  defs.append(el('clipPath', { id: clip }, el('rect', { x: 4, y: 4, width: w - 8, height: h - 8 })));
  const inner = el('g', { 'clip-path': `url(#${clip})` });
  inner.append(el('rect', { x: 0, y: 0, width: w, height: h, fill: 'url(#oc-sky)' }));
  if (props.sky === 'night') {
    for (let i = 0; i < 14; i++) inner.append(el('circle', { cx: r() * w, cy: r() * h * 0.45, r: r() * 0.9 + 0.4, fill: '#fff', 'fill-opacity': 0.5 + r() * 0.5 }));
    inner.append(el('circle', { cx: w * 0.78, cy: h * 0.2, r: 7, fill: '#fff6d8' }), el('circle', { cx: w * 0.78 + 3, cy: h * 0.2 - 2, r: 6, fill: pal.sky1 }));
  } else {
    inner.append(el('circle', { cx: w * 0.2, cy: h * (props.sky === 'sunset' ? 0.55 : 0.22), r: props.sky === 'sunset' ? 13 : 9, fill: props.sky === 'sunset' ? '#ffd27a' : '#fff8d6', 'fill-opacity': 0.9 }));
    for (let i = 0; i < 3; i++) {
      const cx = r() * w, cy = 10 + r() * h * 0.3;
      inner.append(el('g', { fill: pal.cloud, 'fill-opacity': 0.85 },
        el('ellipse', { cx, cy, rx: 12, ry: 4.5 }), el('ellipse', { cx: cx + 7, cy: cy - 3, rx: 7, ry: 4.5 }), el('ellipse', { cx: cx - 6, cy: cy - 2, rx: 6, ry: 3.5 })));
    }
  }
  // 도시 스카이라인(먼 층 → 가까운 층)
  for (const layer of [0, 1]) {
    let bx = -4;
    while (bx < w) {
      const bw = 9 + r() * 16;
      const bh = h * (layer ? 0.18 + r() * 0.3 : 0.3 + r() * 0.35);
      const col = layer ? pal.city2 : pal.city;
      inner.append(el('rect', { x: bx, y: h - bh, width: bw - 1.5, height: bh, fill: col }));
      if (layer || props.sky === 'night') {
        for (let wy = h - bh + 4; wy < h - 3; wy += 5.5) {
          for (let wx = bx + 2; wx < bx + bw - 4; wx += 4) {
            if (r() < (props.sky === 'night' ? 0.45 : 0.18) * (LITE ? 0.35 : 1)) inner.append(el('rect', { x: wx, y: wy, width: 1.8, height: 2.4, fill: pal.cityLight, 'fill-opacity': props.sky === 'night' ? 0.95 : 0.55 }));
          }
        }
      }
      bx += bw;
    }
  }
  inner.append(
    el('polygon', { points: `${w * 0.15},0 ${w * 0.32},0 ${w * 0.12},${h} ${-w * 0.05},${h}`, fill: '#fff', 'fill-opacity': props.sky === 'night' ? 0.05 : 0.16 }),
    el('polygon', { points: `${w * 0.4},0 ${w * 0.46},0 ${w * 0.26},${h} ${w * 0.2},${h}`, fill: '#fff', 'fill-opacity': props.sky === 'night' ? 0.04 : 0.12 }),
  );
  plane.append(
    el('rect', { x: -3, y: -3, width: w + 6, height: h + 6, rx: 3, fill: shade(frame, -0.12) }),
    el('rect', { x: 0, y: 0, width: w, height: h, rx: 2, fill: frame }),
    inner,
  );
  const n = Math.max(1, Math.round(w / 42));
  for (let i = 1; i < n; i++) plane.append(el('rect', { x: (w / n) * i - 1.6, y: 4, width: 3.2, height: h - 8, fill: frame }));
  plane.append(el('rect', { x: 4, y: h * 0.34, width: w - 8, height: 3, fill: frame }));
  g.append(plane);
  g.append(box(P, x0 - 0.06, 0, zb - 5, x1 - x0 + 0.12, 0.16, 5, frame, { hl: 0.6 }));
  return g;
}

function whiteboard(P, x0, x1, zb, zt, pal) {
  const w = (x1 - x0) * L, h = zt - zb;
  const g = el('g', { class: 'oc-board', transform: planeY(P, x0, 0, zt) });
  g.append(
    el('rect', { x: -3, y: -3, width: w + 6, height: h + 6, rx: 3, fill: '#aab2bd' }),
    el('rect', { x: 0, y: 0, width: w, height: h, rx: 2, fill: pal.board }),
    el('path', { d: `M14 16 q10 -8 20 0 t20 0 M14 26 L70 26 M14 34 L56 34`, fill: 'none', stroke: '#3b82f6', 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
    el('path', { d: `M80 40 l14 -14 l12 8 l16 -18`, fill: 'none', stroke: '#ef4444', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    el('rect', { x: 78, y: 12, width: 46, height: 32, fill: 'none', stroke: '#94a3b8', 'stroke-width': 0.8 }),
  );
  const notes = ['#fde047', '#f9a8d4', '#86efac', '#93c5fd', '#fdba74', '#c4b5fd'];
  let k = 0;
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 4; i++) {
      const x = w - 62 + i * 13 + (row ? 5 : 0), y = 10 + row * 16 + (i % 2) * 2;
      g.append(el('rect', { x, y, width: 10.5, height: 10.5, fill: notes[k++ % notes.length], transform: `rotate(${(i % 3) - 1} ${x} ${y})` }));
    }
  }
  // 회의실 사용 중일 때 그려지는 선(스트로크 애니메이션)
  g.append(el('path', { class: 'oc-scribble', d: `M18 ${h - 18} q8 -10 16 0 t16 0 t16 0 t16 0 M18 ${h - 9} L80 ${h - 9}`, fill: 'none', stroke: '#16a34a', 'stroke-width': 1.8, 'stroke-linecap': 'round' }));
  g.append(el('rect', { x: 8, y: h, width: w - 16, height: 4, rx: 1.5, fill: '#9aa3ae' }));
  g.append(el('rect', { x: 20, y: h - 1.5, width: 9, height: 2.4, rx: 1, fill: '#ef4444' }), el('rect', { x: 32, y: h - 1.5, width: 9, height: 2.4, rx: 1, fill: '#2563eb' }));
  return g;
}

function worldMap(P, y0, y1, zb, zt, pal, defs) {
  const w = (y1 - y0) * L, h = zt - zb;
  const g = el('g', { class: 'oc-map', transform: planeX(P, 0, y1, zt) });
  const clip = uid('mclip');
  defs.append(el('clipPath', { id: clip }, el('rect', { x: 4, y: 4, width: w - 8, height: h - 8, rx: 2 })));
  const s = (w - 8) / 150, t = (h - 8) / 80;
  const land = (d) => el('path', { d, fill: '#5fd39a', 'fill-opacity': 0.85, transform: `translate(4 4) scale(${s.toFixed(3)} ${t.toFixed(3)})` });
  const inner = el('g', { 'clip-path': `url(#${clip})` },
    el('rect', { x: 0, y: 0, width: w, height: h, fill: 'url(#oc-ocean)' }),
    land('M10 18 C18 8 40 8 46 16 C50 24 42 30 38 40 C34 46 28 44 26 38 C22 30 12 30 10 18 Z'),
    land('M36 46 C42 44 46 52 44 62 C42 72 36 74 34 66 C32 58 32 50 36 46 Z'),
    land('M64 14 C72 8 84 10 86 18 C84 24 76 24 72 30 C76 36 78 46 72 56 C66 60 62 50 62 42 C60 34 58 22 64 14 Z'),
    land('M86 12 C100 6 124 8 136 16 C140 24 130 28 120 30 C112 36 104 34 98 30 C92 26 84 22 86 12 Z'),
    land('M116 50 C124 48 132 52 130 60 C126 64 118 62 116 56 Z'),
  );
  for (let i = 1; i < 6; i++) inner.append(el('path', { d: `M${(w / 6) * i} 0 L${(w / 6) * i} ${h}`, stroke: '#9fe8ff', 'stroke-opacity': 0.15, 'stroke-width': 0.8 }));
  for (let i = 1; i < 4; i++) inner.append(el('path', { d: `M0 ${(h / 4) * i} L${w} ${(h / 4) * i}`, stroke: '#9fe8ff', 'stroke-opacity': 0.15, 'stroke-width': 0.8 }));
  [[0.22, 0.32], [0.5, 0.25], [0.7, 0.42], [0.86, 0.3], [0.3, 0.72]].forEach(([px, py], i) => {
    inner.append(
      el('circle', { class: `oc-ping oc-ping${i % 3}`, cx: px * w, cy: py * h, r: 6, fill: 'none', stroke: '#ffe066', 'stroke-width': 1.4, style: `transform-origin:${(px * w).toFixed(1)}px ${(py * h).toFixed(1)}px` }),
      el('circle', { cx: px * w, cy: py * h, r: 1.8, fill: '#ffe066' }),
    );
  });
  inner.append(
    el('rect', { x: 10, y: 8, width: w * 0.45, height: 9, rx: 4.5, fill: '#ffffff', 'fill-opacity': 0.92 }),
    el('circle', { cx: 16, cy: 12.5, r: 2.4, fill: 'none', stroke: '#2563eb', 'stroke-width': 1.2 }),
    el('rect', { x: 22, y: 11.4, width: w * 0.25, height: 2.2, rx: 1, fill: '#94a3b8' }),
  );
  g.append(
    el('rect', { x: -4, y: -4, width: w + 8, height: h + 8, rx: 4, fill: '#1c2230' }),
    inner,
    el('rect', { x: w / 2 - 6, y: h + 4, width: 12, height: 2, rx: 1, fill: '#3df5ff', 'fill-opacity': 0.8 }),
  );
  return g;
}

function elevator(P, y0, y1, pal) {
  const w = (y1 - y0) * L, h = 122;
  const g = el('g', { class: 'oc-door', transform: planeX(P, 0, y1, h) });
  const metal = '#c5ccd6';
  g.append(
    el('rect', { x: -6, y: -20, width: w + 12, height: h + 20, rx: 2, fill: '#9aa3b0' }),
    el('rect', { x: -3, y: -3, width: w + 6, height: h + 3, fill: '#6b7482' }),
    el('rect', { x: 0, y: 0, width: w, height: h, fill: '#2b303a' }),
    el('rect', { x: w * 0.25, y: 20, width: w * 0.5, height: 60, fill: '#ffeebb', 'fill-opacity': 0.25 }),
    el('g', { class: 'oc-door-l' }, el('rect', { x: 0, y: 0, width: w / 2, height: h, fill: metal }), el('rect', { x: 3, y: 4, width: w / 2 - 6, height: h - 8, fill: '#fff', 'fill-opacity': 0.18 })),
    el('g', { class: 'oc-door-r' }, el('rect', { x: w / 2, y: 0, width: w / 2, height: h, fill: shade(metal, -0.06) }), el('rect', { x: w / 2 + 3, y: 4, width: w / 2 - 6, height: h - 8, fill: '#fff', 'fill-opacity': 0.14 })),
    el('path', { d: `M${w / 2} 0 L${w / 2} ${h}`, stroke: '#7a8492', 'stroke-width': 1 }),
    el('rect', { x: w / 2 - 12, y: -16, width: 24, height: 10, rx: 2, fill: '#111827' }),
    el('path', { class: 'oc-door-arrow', d: `M${w / 2 - 4} -9 L${w / 2} -14 L${w / 2 + 4} -9 Z`, fill: '#34d399' }),
    el('rect', { x: w + 9, y: 52, width: 7, height: 14, rx: 2, fill: '#9aa3b0' }),
    el('circle', { cx: w + 12.5, cy: 56, r: 1.6, fill: '#fbbf24' }), el('circle', { cx: w + 12.5, cy: 62, r: 1.6, fill: '#e5e7eb' }),
  );
  return g;
}

function clock(P, x, z) {
  const now = new Date();
  const sec = now.getSeconds(), min = now.getMinutes() + sec / 60, hr = (now.getHours() % 12) + min / 60;
  const g = el('g', { class: 'oc-clock', transform: planeY(P, x, 0, z) });
  g.append(el('circle', { cx: 0, cy: 0, r: 14, fill: '#ffffff', stroke: '#3a414d', 'stroke-width': 2.4 }));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.append(el('path', { d: `M${Math.sin(a) * 10.5} ${-Math.cos(a) * 10.5} L${Math.sin(a) * 12} ${-Math.cos(a) * 12}`, stroke: '#3a414d', 'stroke-width': i % 3 ? 0.8 : 1.6 }));
  }
  const hand = (len, wid, col, cls, dur, val) => el('path', {
    class: `oc-hand ${cls}`, d: `M0 2 L0 ${-len}`, stroke: col, 'stroke-width': wid, 'stroke-linecap': 'round',
    style: `animation-duration:${dur}s;animation-delay:-${(val * dur).toFixed(1)}s`,
  });
  g.append(
    hand(6.5, 2, '#3a414d', 'oc-hand-h', 43200, hr / 12),
    hand(9.5, 1.4, '#3a414d', 'oc-hand-m', 3600, min / 60),
    hand(11, 0.7, '#ef4444', 'oc-hand-s', 60, sec / 60),
    el('circle', { cx: 0, cy: 0, r: 1.4, fill: '#3a414d' }),
  );
  return g;
}

function bookshelf(P, y0, len, pal, seed, items) {
  const depth = 0.72, H = 150;
  const g = el('g', { class: 'oc-shelf' });
  g.append(floorShadow(P, 0, y0, depth, len, 0.12));
  g.append(box(P, 0, y0, 0, depth, len, H, pal.wood, { hl: 0.3 }));
  const w = len * L;
  const f = el('g', { transform: planeX(P, depth, y0 + len, H) });
  f.append(el('rect', { x: 4, y: 5, width: w - 8, height: H - 10, fill: shade(pal.wood, -0.45) }));
  const r = rng(seed);
  const shelves = [6, 41, 76, 111];
  for (const sy of shelves) {
    let bx = 6;
    const base = sy + 32;
    while (bx < w - 9) {
      const roll = r();
      if (roll < 0.06) { // 작은 소품
        f.append(el('rect', { x: bx + 1, y: base - 9, width: 9, height: 9, rx: 1.5, fill: mix(pal.pot, pal.plant, 0.15) }));
        f.append(el('circle', { cx: bx + 5.5, cy: base - 13, r: 5, fill: pal.plant }));
        bx += 12; continue;
      }
      const bw = LITE ? 7 + r() * 5 : 3.6 + r() * 3.6, bh = 19 + r() * 11;
      const col = pal.books[Math.floor(r() * pal.books.length)];
      if (roll > 0.94 && bx > 12) {
        f.append(el('rect', { x: bx, y: base - bh, width: bw, height: bh, fill: col, transform: `rotate(16 ${bx} ${base})` }));
        bx += bw + 7; continue;
      }
      f.append(el('rect', { x: bx, y: base - bh, width: bw, height: bh, fill: col }));
      if (!LITE) f.append(el('rect', { x: bx + 0.6, y: base - bh + 3, width: bw - 1.2, height: 1.4, fill: '#fff', 'fill-opacity': 0.35 }));
      bx += bw + (r() < 0.12 ? 3 : 0.4);
    }
    f.append(el('rect', { x: 2, y: base, width: w - 4, height: 4, fill: shade(pal.wood, 0.12) }));
  }
  f.append(el('rect', { x: 0, y: 0, width: w, height: 5, fill: shade(pal.wood, 0.05) }));
  g.append(f);
  items.push({ el: g, depth: depth / 2 + y0 + len / 2 });
}

function serverRack(P, x0, pal, seed, items) {
  const w = 1.7, d = 1.05, H = 140, y0 = 0.15;
  const g = el('g', { class: 'oc-rack' });
  g.append(floorShadow(P, x0, y0, w, d, 0.16));
  g.append(box(P, x0, y0, 0, w, d, H, pal.server, { hl: 0.2, stroke: '#0b0d12' }));
  const fw = w * L;
  const f = el('g', { transform: planeY(P, x0, y0 + d, H) });
  f.append(el('rect', { x: 3, y: 4, width: fw - 6, height: H - 8, fill: pal.serverFace }));
  const r = rng(seed);
  const leds = ['#4ade80', '#60a5fa', '#fbbf24', '#4ade80'];
  // LED 는 깜빡임 주기별 3묶음으로 모아 묶음 단위로 애니메이션(개별 수십 개 → 3개)
  const ledG = [0, 1, 2].map((k) => el('g', { class: `oc-led oc-led${k}`, style: `animation-delay:-${(r() * 2).toFixed(2)}s` }));
  for (let y = 8; y < H - 12; y += 11) {
    f.append(el('rect', { x: 6, y, width: fw - 12, height: 8.5, rx: 1, fill: shade(pal.serverFace, r() < 0.5 ? 0.08 : -0.12) }));
    for (let k = 0; k < (LITE ? 1 : 3); k++) {
      const c = leds[Math.floor(r() * leds.length)];
      ledG[Math.floor(r() * 3)].append(el('circle', { cx: 10 + k * 4, cy: y + 4.2, r: 1.25, fill: c }));
    }
    if (!LITE) for (let v = 0; v < 6; v++) f.append(el('rect', { x: fw - 30 + v * 3.6, y: y + 2, width: 1.6, height: 4.5, fill: '#000', 'fill-opacity': 0.35 }));
  }
  f.append(...ledG);
  f.append(el('polygon', { points: `${fw * 0.55},4 ${fw * 0.75},4 ${fw * 0.35},${H - 4} ${fw * 0.15},${H - 4}`, fill: '#fff', 'fill-opacity': 0.05 }));
  g.append(f);
  items.push({ el: g, depth: x0 + w / 2 + y0 + d / 2 });
}

function globe(P, x, y, pal, defs, items) {
  const g = el('g', { class: 'oc-globe' });
  const [bx, by] = P(x, y, 0);
  g.append(el('ellipse', { cx: bx + 3, cy: by + 2, rx: 0.42 * RX1, ry: 0.42 * RY1, fill: '#000', 'fill-opacity': 0.14 }));
  g.append(cylinder(P, x, y, 0, 0.3, 5, '#6b4f2a'));
  g.append(el('rect', { x: bx - 1.8, y: by - 36, width: 3.6, height: 31, fill: '#8a6a3a' }));
  const cx = bx, cy = by - 55, R = 19;
  const clip = uid('gclip');
  defs.append(el('clipPath', { id: clip }, el('circle', { cx, cy, r: R })));
  const strip = (ox) => el('g', { transform: `translate(${ox} 0)` },
    el('path', { d: `M${cx - 30} ${cy - 10} c6 -6 14 -4 16 2 c1 6 -6 8 -8 14 c-4 2 -8 -4 -8 -16 Z`, fill: '#5fbf6a' }),
    el('path', { d: `M${cx - 8} ${cy - 14} c8 -4 16 -2 18 4 c-2 6 -8 4 -8 12 c-2 8 -8 4 -10 -2 c-2 -6 -4 -10 0 -14 Z`, fill: '#5fbf6a' }),
    el('path', { d: `M${cx + 12} ${cy - 8} c6 -2 10 2 9 6 c-3 3 -6 1 -9 -6 Z`, fill: '#5fbf6a' }),
  );
  const spin = el('g', { class: 'oc-globe-spin' }, strip(0), strip(40));
  g.append(
    el('circle', { cx, cy, r: R, fill: 'url(#oc-sphere)' }),
    el('g', { 'clip-path': `url(#${clip})` }, spin),
    el('circle', { cx: cx - 6, cy: cy - 7, r: 6, fill: '#fff', 'fill-opacity': 0.28 }),
    el('circle', { cx, cy, r: R, fill: 'none', stroke: '#2a5f8a', 'stroke-width': 0.8 }),
    el('ellipse', { cx, cy, rx: R + 4, ry: R + 4, fill: 'none', stroke: '#c9a24a', 'stroke-width': 2.2, 'stroke-dasharray': '70 30', transform: `rotate(-24 ${cx} ${cy})` }),
  );
  items.push({ el: g, depth: x + y });
}

// ── 책상 유닛 ───────────────────────────────────────────────────────
function deskUnit(P, i, n, pal, props, defs) {
  const { dx, dy } = deskSlot(i, n);
  const r = rng(i * 131 + 7);
  const g = el('g', { class: 'oc-desk', 'data-desk': i });
  g.append(floorShadow(P, dx, dy, 1.0, 2.0, 0.12));
  // 다리·서랍
  g.append(box(P, dx + 0.06, dy + 0.06, 0, 0.86, 0.08, 30, pal.deskBody, { hl: 0.2 }));
  g.append(box(P, dx + 0.06, dy + 0.15, 4, 0.06, 1.2, 24, shade(pal.deskBody, -0.08), { hl: 0 }));
  const ped = box(P, dx + 0.08, dy + 1.38, 0, 0.84, 0.56, 30, pal.cabinet, { hl: 0.25 });
  g.append(ped);
  const dr = el('g', { transform: planeX(P, dx + 0.92, dy + 1.94, 30) });
  for (let k = 0; k < 3; k++) {
    dr.append(el('rect', { x: 2, y: 2 + k * 9.3, width: 0.56 * L - 4, height: 8.3, rx: 1, fill: 'none', stroke: shade(pal.cabinet, -0.25), 'stroke-width': 0.8 }));
    dr.append(el('rect', { x: 0.28 * L - 4, y: 5 + k * 9.3, width: 8, height: 1.6, rx: 0.8, fill: shade(pal.cabinet, -0.45) }));
  }
  g.append(dr);
  // 상판
  g.append(box(P, dx, dy, 30, 1.0, 2.0, 4, pal.desktop, { hl: 0.55 }));
  // 조명(나이트/코지) 빛 번짐
  const glow = el('ellipse', { class: 'oc-mglow', cx: 0, cy: 0, rx: 34, ry: 15, fill: 'url(#oc-glow)' });
  const [gx, gy] = P(dx + 0.85, dy + 1.0, 34);
  glow.setAttribute('cx', gx.toFixed(1)); glow.setAttribute('cy', gy.toFixed(1));
  g.append(glow);
  // 소품
  if (r() < 0.6) g.append(succulent(P, dx + 0.28, dy + 1.82, 34, pal));
  else g.append(box(P, dx + 0.12, dy + 1.6, 34, 0.4, 0.3, 7, pal.books[i % pal.books.length], { hl: 0.4 }), box(P, dx + 0.14, dy + 1.62, 41, 0.36, 0.26, 5, pal.books[(i + 3) % pal.books.length], { hl: 0.4 }));
  if (r() < 0.5) g.append(box(P, dx + 0.15, dy + 0.12, 34, 0.42, 0.22, 3, '#ffffff', { hl: 0.4, stroke: '#c9ced6' }));
  if (props.lamps && i % 3 === 1) {
    const [lx, ly] = P(dx + 0.3, dy + 0.2, 34);
    g.append(
      el('ellipse', { cx: lx + 14, cy: ly + 4, rx: 24, ry: 10, fill: 'url(#oc-lamp)' }),
      el('ellipse', { cx: lx, cy: ly, rx: 4.5, ry: 2, fill: '#2a2f38' }),
      el('path', { d: `M${lx} ${ly} L${lx + 2} ${ly - 18} L${lx + 10} ${ly - 22}`, stroke: '#2a2f38', 'stroke-width': 1.6, fill: 'none' }),
      el('path', { d: `M${lx + 5} ${ly - 26} L${lx + 15} ${ly - 23} L${lx + 13} ${ly - 17} L${lx + 6} ${ly - 19} Z`, fill: props.neon ? '#ff4fd8' : '#e9a23b' }),
    );
  }
  // 모니터
  g.append(box(P, dx + 0.16, dy + 0.8, 34, 0.26, 0.36, 2, '#3a3f48', { hl: 0.3 }));
  g.append(box(P, dx + 0.24, dy + 0.93, 36, 0.07, 0.1, 10, '#4a505b', { hl: 0 }));
  g.append(box(P, dx + 0.25, dy + 0.36, 44, 0.08, 1.34, 32, '#20242c', { hl: 0.25, stroke: '#0b0d12', gloss: false }));
  const SW = 1.34 * L - 4.4, SH = 27.6;
  const clip = uid('sclip');
  defs.append(el('clipPath', { id: clip }, el('rect', { x: 2.2, y: 2.2, width: SW, height: SH, rx: 1 })));
  const screen = el('g', { class: 'oc-screen', 'clip-path': `url(#${clip})` });
  const scrPlane = el('g', { transform: planeX(P, dx + 0.33, dy + 1.7, 76) }, screen);
  g.append(scrPlane);
  // 키보드·마우스
  g.append(box(P, dx + 0.6, dy + 0.55, 34, 0.24, 0.82, 1.8, props.neon ? '#2a3150' : '#e9ebef', { hl: 0.5, stroke: props.neon ? '#3df5ff' : '#aab0ba', so: props.neon ? 0.5 : 0.4 }));
  const kb = el('g', { transform: planeF(P, dx + 0.6, dy + 0.55, 35.9) });
  if (!LITE) for (let k = 0; k < 3; k++) kb.append(el('path', { d: `M${1.6 + k * 2.6} 2 L${1.6 + k * 2.6} ${0.82 * L - 2}`, stroke: props.neon ? '#3df5ff' : '#b7bcc6', 'stroke-width': 1.1, 'stroke-dasharray': '1.6 0.9', 'stroke-opacity': 0.7 }));
  g.append(kb);
  const [mx, my] = P(dx + 0.72, dy + 1.55, 34.5);
  g.append(el('ellipse', { cx: mx, cy: my, rx: 3.2, ry: 2, fill: props.neon ? '#2a3150' : '#f4f5f7', stroke: '#9aa1ac', 'stroke-width': 0.6 }));
  // 명패(프로바이더 색)
  const plate = el('g', { class: 'oc-plate' });
  g.append(plate);
  // 선택 하이라이트(상판 테두리)
  g.append(el('polygon', { class: 'oc-desk-hl', points: pts([P(dx - 0.08, dy - 0.08, 34), P(dx + 1.08, dy - 0.08, 34), P(dx + 1.08, dy + 2.08, 34), P(dx - 0.08, dy + 2.08, 34)]) }));
  const chairPos = [dx + 1.42, dy + 1.0];
  const ch = officeChair(P, chairPos[0], chairPos[1], pal, 'x');
  const cdepth = chairPos[0] + chairPos[1];
  ch.base.setAttribute('data-desk', i); ch.near.setAttribute('data-desk', i); ch.far.setAttribute('data-desk', i);
  return {
    index: i, dx, dy, group: g, screen, SW, SH, plate, chairPos,
    chairNear: ch.near, chairFar: ch.far,
    items: [
      { el: g, depth: dx + 0.5 + dy + 1.0 },
      { el: ch.far, depth: cdepth - 0.27 },
      { el: ch.base, depth: cdepth - 0.1 },
      { el: ch.near, depth: cdepth + 0.27 },
    ],
    obstacles: [{ x: dx, y: dy, w: 1, d: 2 }, { x: chairPos[0] - 0.25, y: chairPos[1] - 0.25, w: 0.5, d: 0.5, m: 0.05 }],
    setPlate(color) {
      plate.replaceChildren(box(P, dx + 0.7, dy + 1.62, 34, 0.24, 0.3, 7, color || '#94a3b8', { hl: 0.5 }));
    },
  };
}

// ── 씬 조립 ─────────────────────────────────────────────────────────
export function buildVectorScene(skin, nDesks, opts = {}) {
  LITE = !!opts.lite;
  setDetail(LITE ? 0 : 1);
  const pal = skin.palette, props = skin.props || {};
  const { W, D, WH, T, S } = ROOM;
  const OX = D * 32 + 72, OY = WH + 62;
  const P = projector(OX, OY);
  const width = (W + D) * 32 + 144, height = OY + (W + D) * 16 + S + 60;
  const night = props.sky === 'night';

  const defs = el('defs');
  defs.append(
    el('linearGradient', { id: 'oc-shadeV', x1: 0, y1: 0, x2: 0, y2: 1 },
      el('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0.12 }),
      el('stop', { offset: 0.5, 'stop-color': '#fff', 'stop-opacity': 0 }),
      el('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0.1 })),
    el('linearGradient', { id: 'oc-cyl', x1: 0, y1: 0, x2: 1, y2: 0 },
      el('stop', { offset: 0, 'stop-color': '#000', 'stop-opacity': 0.12 }),
      el('stop', { offset: 0.32, 'stop-color': '#fff', 'stop-opacity': 0.22 }),
      el('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0.26 })),
    el('linearGradient', { id: 'oc-sky', x1: 0, y1: 0, x2: 0, y2: 1 },
      el('stop', { offset: 0, 'stop-color': pal.sky1 }), el('stop', { offset: 1, 'stop-color': pal.sky2 })),
    el('linearGradient', { id: 'oc-wallG', x1: 0, y1: 0, x2: 0, y2: 1 },
      el('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': night ? 0 : 0.18 }),
      el('stop', { offset: 0.75, 'stop-color': '#000', 'stop-opacity': 0 }),
      el('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0.08 })),
    el('linearGradient', { id: 'oc-ocean', x1: 0, y1: 0, x2: 0, y2: 1 },
      el('stop', { offset: 0, 'stop-color': '#0f4c81' }), el('stop', { offset: 1, 'stop-color': '#0a2f57' })),
    el('radialGradient', { id: 'oc-sphere', cx: 0.38, cy: 0.35, r: 0.7 },
      el('stop', { offset: 0, 'stop-color': '#8fd3ff' }), el('stop', { offset: 0.6, 'stop-color': '#2f8fd8' }), el('stop', { offset: 1, 'stop-color': '#1b5d96' })),
    el('radialGradient', { id: 'oc-glow' },
      el('stop', { offset: 0, 'stop-color': pal.glow, 'stop-opacity': night ? 0.55 : 0 }),
      el('stop', { offset: 1, 'stop-color': pal.glow, 'stop-opacity': 0 })),
    el('radialGradient', { id: 'oc-lamp' },
      el('stop', { offset: 0, 'stop-color': '#ffd27a', 'stop-opacity': night ? 0.55 : 0.35 }),
      el('stop', { offset: 1, 'stop-color': '#ffd27a', 'stop-opacity': 0 })),
  );

  const stat = el('g', { class: 'oc-static' });
  const items = [];
  const obstacles = [];
  const ob = (x, y, w, d, m) => obstacles.push({ x, y, w, d, m });

  // 디오라마 그림자 + 바닥 슬래브
  stat.append(
    el('polygon', { points: pts([P(-T, -T, -S - 28), P(W + 1.2, -T, -S - 28), P(W + 1.2, D + 1.2, -S - 28), P(-T, D + 1.2, -S - 28)]), fill: '#000', 'fill-opacity': night ? 0.35 : 0.07 }),
    el('polygon', { points: pts([P(-T, D, 0), P(W, D, 0), P(W, D, -S), P(-T, D, -S)]), fill: pal.slab }),
    el('polygon', { points: pts([P(W, -T, 0), P(W, D, 0), P(W, D, -S), P(W, -T, -S)]), fill: pal.slabDark }),
    el('polyline', { points: pts([P(-T, D, 0), P(W, D, 0), P(W, -T, 0)]), fill: 'none', stroke: '#fff', 'stroke-opacity': 0.3, 'stroke-width': 1.2 }),
  );
  // 바닥(마루 판자)
  const fl = el('g', { transform: planeF(P, 0, 0, 0) });
  fl.append(el('rect', { x: 0, y: 0, width: W * L, height: D * L, fill: pal.floor }));
  const fr = rng(42);
  const rowH = L * 0.5;
  for (let j = 0; j < D * 2; j++) {
    if (j % 2) fl.append(el('rect', { x: 0, y: j * rowH, width: W * L, height: rowH, fill: pal.floorAlt }));
    fl.append(el('path', { d: `M0 ${j * rowH} L${W * L} ${j * rowH}`, stroke: pal.floorLine, 'stroke-width': 0.8, 'stroke-opacity': 0.55 }));
    let u = LITE ? W * L : fr() * 60;
    while (u < W * L) {
      fl.append(el('path', { d: `M${u.toFixed(1)} ${j * rowH} l0 ${rowH}`, stroke: pal.floorLine, 'stroke-width': 0.8, 'stroke-opacity': 0.5 }));
      u += 70 + fr() * 70;
    }
  }
  stat.append(fl);
  // 서버실 바닥 타일
  const tl = el('g', { transform: planeF(P, 14.6, 0, 0.3) });
  const tw = (W - 14.6) * L, th = 4.1 * L;
  tl.append(el('rect', { x: 0, y: 0, width: tw, height: th, fill: pal.tile, stroke: pal.tileLine, 'stroke-width': 1 }));
  for (let u = 0; u < tw; u += L * 0.62) tl.append(el('path', { d: `M${u} 0 L${u} ${th}`, stroke: pal.tileLine, 'stroke-width': 0.8 }));
  for (let v = 0; v < th; v += L * 0.62) tl.append(el('path', { d: `M0 ${v} L${tw} ${v}`, stroke: pal.tileLine, 'stroke-width': 0.8 }));
  for (let k = 0; k < 6; k++) tl.append(el('rect', { x: L * 0.62 * (1 + k * 1.6) + 4, y: L * 0.62 * 2 + 4, width: L * 0.62 - 8, height: L * 0.62 - 8, fill: pal.tileLine, 'fill-opacity': 0.35 }));
  stat.append(tl);
  // 러그(자료실·회의실·휴게실)
  const rug = (x, y, w, d, c1, c2, rx = 10) => {
    const gg = el('g', { transform: planeF(P, x, y, 0.4) });
    gg.append(
      el('rect', { x: 2, y: 3, width: w * L, height: d * L, rx, fill: '#000', 'fill-opacity': 0.06 }),
      el('rect', { x: 0, y: 0, width: w * L, height: d * L, rx, fill: c1 }),
      el('rect', { x: 7, y: 7, width: w * L - 14, height: d * L - 14, rx: rx * 0.6, fill: 'none', stroke: c2, 'stroke-width': 3 }),
      el('rect', { x: 13, y: 13, width: w * L - 26, height: d * L - 26, rx: rx * 0.4, fill: 'none', stroke: c2, 'stroke-width': 1, 'stroke-opacity': 0.7 }),
    );
    if (props.neon) gg.append(el('rect', { x: 0, y: 0, width: w * L, height: d * L, rx, fill: 'none', stroke: pal.neon2 || pal.accent, 'stroke-width': 1.5, 'stroke-opacity': 0.8 }));
    stat.append(gg);
  };
  rug(1.0, 0.6, 3.5, 5.2, pal.rug, pal.rug2);
  rug(4.95, 0.75, 6.0, 5.3, pal.meetRug, shade(pal.meetRug, -0.12), 6);
  rug(1.35, 13.4, 3.4, 4.3, pal.rug, pal.rug2, 30);
  // 창문 햇빛
  if (!night) {
    stat.append(el('polygon', { points: pts([P(1.1, 0.2, 0.5), P(4.1, 0.2, 0.5), P(7.2, 4.6, 0.5), P(4.2, 4.6, 0.5)]), fill: pal.light, 'fill-opacity': pal.lightOp }));
    stat.append(el('polygon', { points: pts([P(11.3, 0.2, 0.5), P(13.7, 0.2, 0.5), P(16.4, 4.4, 0.5), P(14.0, 4.4, 0.5)]), fill: pal.light, 'fill-opacity': pal.lightOp * 0.8 }));
  }

  // 벽
  const walls = el('g', { class: 'oc-walls' });
  const backFace = pts([P(0, 0, 0), P(W, 0, 0), P(W, 0, WH), P(0, 0, WH)]);
  const leftFace = pts([P(0, 0, 0), P(0, D, 0), P(0, D, WH), P(0, 0, WH)]);
  walls.append(
    el('polygon', { points: backFace, fill: pal.wall }),
    el('polygon', { points: backFace, fill: 'url(#oc-wallG)' }),
    el('polygon', { points: leftFace, fill: shade(pal.wall, -0.06) }),
    el('polygon', { points: leftFace, fill: 'url(#oc-wallG)' }),
  );
  if (props.wainscot) {
    const wz = 64;
    walls.append(
      el('polygon', { points: pts([P(0, 0, 0), P(W, 0, 0), P(W, 0, wz), P(0, 0, wz)]), fill: pal.wallLow }),
      el('polygon', { points: pts([P(0, 0, 0), P(0, D, 0), P(0, D, wz), P(0, 0, wz)]), fill: shade(pal.wallLow, -0.08) }),
    );
    const pb = el('g', { transform: planeY(P, 0, 0, wz) });
    for (let u = 0; u < W * L; u += 26) pb.append(el('path', { d: `M${u} 4 L${u} ${wz - 10}`, stroke: shade(pal.wallLow, -0.22), 'stroke-width': 1 }));
    pb.append(el('rect', { x: 0, y: -3, width: W * L, height: 5, fill: shade(pal.wallLow, 0.15) }));
    walls.append(pb);
    const pl = el('g', { transform: planeX(P, 0, D, wz) });
    for (let u = 0; u < D * L; u += 26) pl.append(el('path', { d: `M${u} 4 L${u} ${wz - 10}`, stroke: shade(pal.wallLow, -0.3), 'stroke-width': 1 }));
    pl.append(el('rect', { x: 0, y: -3, width: D * L, height: 5, fill: shade(pal.wallLow, 0.08) }));
    walls.append(pl);
  }
  // 걸레받이
  walls.append(
    el('polygon', { points: pts([P(0, 0, 0), P(W, 0, 0), P(W, 0, 9), P(0, 0, 9)]), fill: pal.base }),
    el('polygon', { points: pts([P(0, 0, 0), P(0, D, 0), P(0, D, 9), P(0, 0, 9)]), fill: shade(pal.base, -0.08) }),
  );
  // 벽 윗면·끝면(두께)
  walls.append(
    el('polygon', { points: pts([P(-T, -T, WH), P(W, -T, WH), P(W, 0, WH), P(0, 0, WH)]), fill: pal.wallTop, stroke: shade(pal.wallTop, -0.2), 'stroke-width': 0.8 }),
    el('polygon', { points: pts([P(-T, 0, WH), P(0, 0, WH), P(0, D, WH), P(-T, D, WH)]), fill: pal.wallTop, stroke: shade(pal.wallTop, -0.2), 'stroke-width': 0.8 }),
    el('polygon', { points: pts([P(W, -T, 0), P(W, 0, 0), P(W, 0, WH), P(W, -T, WH)]), fill: pal.wallEnd }),
    el('polygon', { points: pts([P(-T, D, 0), P(0, D, 0), P(0, D, WH), P(-T, D, WH)]), fill: shade(pal.wallEnd, 0.04) }),
    el('path', { d: `M${P(0, 0, 0).join(' ')} L${P(0, 0, WH).join(' ')}`, stroke: '#000', 'stroke-opacity': 0.08, 'stroke-width': 2 }),
  );
  if (props.neon) {
    const neonLine = (a, b, c) => [
      el('path', { d: `M${a.join(' ')} L${b.join(' ')}`, stroke: c, 'stroke-width': 7, 'stroke-opacity': 0.18, 'stroke-linecap': 'round' }),
      el('path', { d: `M${a.join(' ')} L${b.join(' ')}`, stroke: c, 'stroke-width': 2, 'stroke-linecap': 'round' }),
    ];
    walls.append(...neonLine(P(0.2, 0, WH - 12), P(W - 0.2, 0, WH - 12), pal.accent), ...neonLine(P(0, 0.2, WH - 12), P(0, D - 0.2, WH - 12), pal.neon2));
  }
  stat.append(walls);

  // 뒷벽 장식
  stat.append(windowBack(P, defs, 1.0, 4.2, 62, 160, pal, props, 11));
  stat.append(whiteboard(P, 5.6, 9.8, 62, 142, pal));
  stat.append(clock(P, 10.5, 150));
  stat.append(windowBack(P, defs, 11.2, 13.9, 62, 160, pal, props, 23));
  // 서버실 간판·케이블 트레이
  const sign = el('g', { transform: planeY(P, 15.2, 0, 180) },
    el('rect', { x: 0, y: 0, width: 5.4 * L, height: 7, rx: 2, fill: shade(pal.server, 0.15) }),
    el('rect', { x: 0, y: 9, width: 5.4 * L, height: 3, fill: '#4ade80', 'fill-opacity': 0.35 }),
  );
  stat.append(sign);
  // 왼벽 장식: 엘리베이터 문, 대형 지도 모니터, 커피 메뉴
  const door = elevator(P, 6.0, 7.5, pal);
  stat.append(door);
  stat.append(worldMap(P, 8.0, 12.25, 72, 152, pal, defs));
  stat.append(el('g', { transform: planeX(P, 0, 13.95, 104) },
    el('rect', { x: 0, y: 0, width: 1.3 * L, height: 26, rx: 3, fill: props.neon ? '#141b33' : '#3a2f28' }),
    // 커피잔 아이콘 + 김
    el('path', { d: 'M9 10 L21 10 L20 19 Q15 22 10 19 Z', fill: props.neon ? pal.neon2 : '#ffe8c2' }),
    el('path', { d: 'M21 12 q4 0 3.5 3 q-0.5 2.6 -4 2.4', fill: 'none', stroke: props.neon ? pal.neon2 : '#ffe8c2', 'stroke-width': 1.4 }),
    el('path', { d: 'M12 8 q-1.5 -2 0 -4 M15.5 8 q-1.5 -2 0 -4 M19 8 q-1.5 -2 0 -4', fill: 'none', stroke: props.neon ? pal.accent : '#d9c4a3', 'stroke-width': 1, 'stroke-linecap': 'round' }),
    el('path', { d: `M29 10 L${1.3 * L - 5} 10 M29 14 L${1.3 * L - 9} 14 M29 18 L${1.3 * L - 7} 18`, stroke: props.neon ? pal.accent : '#d9c4a3', 'stroke-width': 1.2 }),
  ));
  // 네온 간판(나이트): 왼벽 평면에 붙는 HTML 글자 — 오버레이에서 같은 행렬로 기울여 그림
  const neon = props.neon ? { origin: P(0, 17.65, 122), text: 'OFFICE CREW', color: pal.neon2 } : null;

  // ── 자료실 ──
  bookshelf(P, 0.35, 2.5, pal, 3, items);
  bookshelf(P, 3.05, 2.5, pal, 7, items);
  ob(0, 0.35, 0.72, 5.2);
  {
    const g = el('g');
    g.append(floorShadow(P, 3.35, 0.45, 0.95, 0.6, 0.12));
    g.append(box(P, 3.35, 0.45, 4, 0.95, 0.6, 20, pal.wood, { hl: 0.3 }));
    for (let k = 0; k < 5; k++) g.append(box(P, 3.42 + k * 0.17, 0.52, 24, 0.12, 0.42, 12 + (k % 3) * 3, pal.books[(k + 2) % pal.books.length], { hl: 0.35 }));
    const [wx, wy] = P(3.4, 1.05, 0);
    g.append(el('circle', { cx: wx, cy: wy - 2, r: 2.4, fill: '#333' }), el('circle', { cx: wx + 28, cy: wy - 16, r: 2.4, fill: '#333' }));
    items.push({ el: g, depth: 3.8 + 0.75 });
    ob(3.35, 0.45, 0.95, 0.6);
  }
  // ── 정보검색실 ──
  globe(P, 1.5, 8.85, pal, defs, items);
  ob(1.1, 8.45, 0.8, 0.8);
  {
    const g = el('g');
    g.append(floorShadow(P, 0, 10.05, 0.85, 2.15, 0.12));
    g.append(box(P, 0, 10.05, 0, 0.85, 2.15, 32, pal.cabinet, { hl: 0.3 }));
    g.append(box(P, -0.02, 10.0, 32, 0.92, 2.25, 4, pal.desktop, { hl: 0.5 }));
    // 노트북
    g.append(box(P, 0.35, 10.9, 36, 0.36, 0.55, 1.5, '#c9ced6', { hl: 0.5 }));
    g.append(el('g', { transform: planeX(P, 0.38, 11.45, 56) },
      el('rect', { x: 0, y: 0, width: 0.55 * L, height: 19, rx: 1.5, fill: '#2a2f38' }),
      el('rect', { x: 1.5, y: 1.5, width: 0.55 * L - 3, height: 16, fill: '#e8f1ff' }),
      el('rect', { x: 3, y: 4, width: 0.55 * L - 6, height: 3, rx: 1.5, fill: '#ffffff', stroke: '#93c5fd', 'stroke-width': 0.6 }),
      el('path', { d: `M3 10 L14 10 M3 13 L12 13`, stroke: '#3b82f6', 'stroke-width': 1 }),
    ));
    const [mx, my] = P(0.55, 10.45, 36);
    g.append(el('circle', { cx: mx, cy: my - 3, r: 4, fill: 'rgba(200,232,255,.6)', stroke: '#6b4f2a', 'stroke-width': 1.6 }), el('path', { d: `M${mx + 3} ${my} l4 3`, stroke: '#6b4f2a', 'stroke-width': 2, 'stroke-linecap': 'round' }));
    items.push({ el: g, depth: 0.42 + 11.1 });
    ob(0, 10.0, 0.9, 2.25);
  }
  // ── 휴게실 ──
  {
    const g = el('g');
    g.append(floorShadow(P, 0, 12.6, 0.85, 1.3, 0.12));
    g.append(box(P, 0, 12.6, 0, 0.85, 1.3, 34, pal.cabinet, { hl: 0.3 }));
    const cd = el('g', { transform: planeX(P, 0.85, 13.9, 34) });
    cd.append(el('path', { d: `M${0.65 * L} 3 L${0.65 * L} 31`, stroke: shade(pal.cabinet, -0.25), 'stroke-width': 1 }));
    cd.append(el('rect', { x: 0.65 * L - 6, y: 12, width: 2, height: 8, rx: 1, fill: shade(pal.cabinet, -0.45) }), el('rect', { x: 0.65 * L + 4, y: 12, width: 2, height: 8, rx: 1, fill: shade(pal.cabinet, -0.45) }));
    g.append(cd);
    g.append(box(P, -0.02, 12.55, 34, 0.9, 1.4, 3, shade(pal.desktop, -0.1), { hl: 0.5 }));
    // 에스프레소 머신
    g.append(box(P, 0.08, 12.7, 37, 0.55, 0.62, 28, props.neon ? '#2a3150' : '#c0392b', { hl: 0.35 }));
    g.append(el('g', { transform: planeX(P, 0.63, 13.32, 61) },
      el('rect', { x: 2, y: 3, width: 0.62 * L - 4, height: 6, rx: 1, fill: '#1f2329' }),
      el('circle', { cx: 6, cy: 6, r: 1.3, fill: '#4ade80' }),
      el('rect', { x: 0.31 * L - 4, y: 11, width: 8, height: 5, fill: '#9aa3ae' }),
      el('rect', { x: 3, y: 21, width: 0.62 * L - 6, height: 2.5, fill: '#2b2f36' }),
    ));
    g.append(cylinder(P, 0.42, 13.02, 37, 0.07, 6, '#ffffff'));
    for (let k = 0; k < 3; k++) g.append(cylinder(P, 0.45, 13.55 + k * 0.15 - 0.15, 37, 0.06, 6, ['#ffffff', pal.accent, '#f2cc8f'][k]));
    items.push({ el: g, depth: 0.42 + 13.25 });
    ob(0, 12.55, 0.9, 1.4);
  }
  {
    // 소파(앉는 캐릭터를 가리지 않게 앞 팔걸이만 분리)
    const base = el('g', { class: 'oc-sofa' });
    const col = pal.sofa, dk = pal.sofaDark;
    base.append(floorShadow(P, 0.12, 14.2, 1.2, 3.1, 0.14));
    base.append(box(P, 0.15, 14.2, 3, 1.15, 3.1, 11, dk, { hl: 0.2 }));
    base.append(box(P, 0.15, 14.2, 14, 0.36, 3.1, 30, col, { hl: 0.35 }));
    for (let k = 0; k < 3; k++) base.append(box(P, 0.5, 14.5 + k * 0.94, 14, 0.8, 0.9, 7, shade(col, 0.06), { hl: 0.45 }));
    base.append(box(P, 0.15, 14.2, 0, 1.15, 0.28, 31, col, { hl: 0.35 }));
    const pillow = (y, c) => {
      const [px, py] = P(0.6, y, 30);
      return el('rect', { x: px - 7, y: py - 9, width: 13, height: 12, rx: 4, fill: c, stroke: shade(c, -0.3), 'stroke-width': 0.7, transform: `rotate(-14 ${px} ${py})` });
    };
    base.append(pillow(14.75, pal.accent), pillow(16.75, '#f2cc8f'));
    items.push({ el: base, depth: 14.3 });
    const arm = el('g');
    arm.append(box(P, 0.15, 17.02, 0, 1.15, 0.28, 31, col, { hl: 0.35 }));
    items.push({ el: arm, depth: 0.7 + 17.16 + 0.4 });
    ob(0, 14.2, 1.3, 3.1);
    const tbl = el('g');
    tbl.append(floorShadow(P, 2.1, 14.85, 1.0, 1.6, 0.12));
    tbl.append(box(P, 2.18, 14.95, 0, 0.84, 1.4, 12, shade(pal.wood, -0.12), { hl: 0.2 }));
    tbl.append(box(P, 2.1, 14.85, 12, 1.0, 1.6, 3, pal.wood, { hl: 0.5 }));
    tbl.append(cylinder(P, 2.5, 15.3, 15, 0.07, 6, '#ffffff'), cylinder(P, 2.7, 16.0, 15, 0.07, 6, pal.accent));
    tbl.append(box(P, 2.35, 15.55, 15, 0.45, 0.32, 1.5, '#f8fafc', { hl: 0.4, stroke: '#cbd5e1' }));
    items.push({ el: tbl, depth: 2.6 + 15.65 });
    ob(2.1, 14.85, 1.0, 1.6);
    if (props.cat) {
      // 고양이(레퍼런스1)
      const [cx, cy] = P(3.3, 13.55, 0);
      const cat = el('g', { class: 'oc-cat', transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)})` },
        el('ellipse', { cx: 2, cy: 0.5, rx: 11, ry: 3.5, fill: '#000', 'fill-opacity': 0.14 }),
        el('path', { class: 'oc-cat-tail', d: 'M7 -4 C15 -4 16 -12 12 -16', fill: 'none', stroke: '#e8913a', 'stroke-width': 3.2, 'stroke-linecap': 'round', style: 'transform-origin:7px -4px' }),
        el('ellipse', { cx: 0, cy: -7, rx: 8.5, ry: 7.5, fill: '#f4a24c' }),
        el('ellipse', { cx: -1.5, cy: -4, rx: 5, ry: 4, fill: '#fff4e6' }),
        el('circle', { cx: -3, cy: -17, r: 6.5, fill: '#f4a24c' }),
        el('path', { d: 'M-8.5 -20 L-8 -27 L-4 -22 Z M2.5 -20 L2 -27 L-2 -22 Z', fill: '#f4a24c' }),
        el('path', { d: 'M-7.5 -21.5 L-7.4 -25 L-5.2 -22.4 Z', fill: '#ffb3b3' }),
        el('circle', { cx: -5.4, cy: -17.5, r: 0.9, fill: '#2b2420' }), el('circle', { cx: -0.8, cy: -17.5, r: 0.9, fill: '#2b2420' }),
        el('path', { d: 'M-4.2 -15 q1 0.8 2 0', stroke: '#2b2420', 'stroke-width': 0.6, fill: 'none' }),
        el('path', { d: 'M-6 -11 L-6 -2 M-1 -11 L-1 -2', stroke: '#e8913a', 'stroke-width': 0.8 }),
      );
      items.push({ el: cat, depth: 3.3 + 13.55 });
      ob(2.9, 13.25, 0.7, 0.6);
    }
  }
  // ── 회의실 ──
  {
    const g = el('g');
    g.append(floorShadow(P, 6.0, 2.5, 3.8, 1.8, 0.14));
    g.append(box(P, 6.5, 3.15, 0, 0.35, 0.5, 30, shade(pal.wood, -0.25), { hl: 0.1 }));
    g.append(box(P, 8.95, 3.15, 0, 0.35, 0.5, 30, shade(pal.wood, -0.25), { hl: 0.1 }));
    g.append(box(P, 6.0, 2.5, 30, 3.8, 1.8, 5, pal.desktop, { hl: 0.6 }));
    g.append(box(P, 6.5, 3.0, 35, 0.5, 0.36, 1.5, '#ffffff', { hl: 0.4, stroke: '#cbd5e1' }));
    g.append(box(P, 8.6, 3.7, 35, 0.5, 0.4, 1.5, '#ffffff', { hl: 0.4, stroke: '#cbd5e1' }));
    g.append(cylinder(P, 7.4, 3.9, 35, 0.07, 6, '#ffffff'), cylinder(P, 9.4, 2.9, 35, 0.07, 6, pal.accent));
    g.append(box(P, 7.75, 2.75, 35, 0.4, 0.55, 1.4, '#c9ced6', { hl: 0.5 }));
    g.append(el('g', { transform: planeY(P, 7.75, 2.78, 54) },
      el('rect', { x: 0, y: 0, width: 0.4 * L, height: 18, rx: 1.5, fill: '#2a2f38' }),
      el('rect', { x: 1.5, y: 1.5, width: 0.4 * L - 3, height: 15, fill: '#dbeafe' }),
      el('rect', { x: 3, y: 4, width: 6, height: 9, fill: '#60a5fa' }), el('rect', { x: 10, y: 8, width: 3, height: 5, fill: '#f472b6' }),
    ));
    g.append(succulent(P, 8.4, 3.55, 35, pal));
    items.push({ el: g, depth: 7.9 + 3.4 });
    ob(6.0, 2.5, 3.8, 1.8);
    for (const x of [6.7, 7.9, 9.1]) {
      const c = officeChair(P, x, 5.0, pal, 'y');
      const cg = el('g', null, c.base, c.near);
      items.push({ el: cg, depth: x + 5.0 });
      ob(x - 0.25, 4.75, 0.5, 0.5, 0.05);
    }
    const cl = officeChair(P, 5.4, 3.4, pal, 'x');
    items.push({ el: el('g', null, cl.far, cl.base), depth: 5.4 + 3.4 });
    const cr = officeChair(P, 10.4, 3.4, pal, 'x');
    items.push({ el: el('g', null, cr.base, cr.near), depth: 10.4 + 3.4 });
    ob(5.15, 3.15, 0.5, 0.5, 0.05); ob(10.15, 3.15, 0.5, 0.5, 0.05);
  }
  // ── 서버실 ──
  serverRack(P, 15.0, pal, 5, items);
  serverRack(P, 17.0, pal, 9, items);
  serverRack(P, 19.0, pal, 15, items);
  ob(15.0, 0.15, 5.7, 1.05);
  {
    // 냉방기
    const g = el('g');
    g.append(floorShadow(P, 21.0, 0.2, 0.75, 0.7, 0.12));
    g.append(box(P, 21.0, 0.2, 0, 0.75, 0.7, 70, '#e5e7eb', { hl: 0.4 }));
    g.append(el('g', { transform: planeY(P, 21.0, 0.9, 64) },
      ...[0, 1, 2, 3, 4, 5].map((k) => el('rect', { x: 4, y: 6 + k * 5, width: 0.75 * L - 8, height: 2, rx: 1, fill: '#9ca3af' })),
      el('circle', { cx: 0.75 * L / 2, cy: 46, r: 2, fill: '#22c55e' }),
    ));
    items.push({ el: g, depth: 21.4 + 0.55 });
    ob(21.0, 0.2, 0.75, 0.7);
  }
  // ── 개발실 부속 ──
  {
    const g = el('g');
    g.append(floorShadow(P, 20.7, 4.7, 0.95, 0.8, 0.12));
    g.append(box(P, 20.7, 4.7, 0, 0.95, 0.8, 28, pal.cabinet, { hl: 0.3 }));
    g.append(box(P, 20.72, 4.75, 28, 0.9, 0.7, 14, '#eef0f3', { hl: 0.5 }));
    g.append(box(P, 20.8, 4.85, 42, 0.6, 0.5, 1.2, '#ffffff', { hl: 0.4, stroke: '#cbd5e1' }));
    items.push({ el: g, depth: 21.2 + 5.1 });
    ob(20.7, 4.7, 0.95, 0.8);
  }
  const plants = [
    [4.5, 0.55, 'tall', 1.1], [14.35, 0.6, 'tall', 1.05], [0.55, 7.8, 'snake', 0.9], [4.35, 17.4, 'bush', 1.1],
    [21.4, 17.4, 'tall', 1.2], [21.4, 11.0, 'bush', 1.0], [21.35, 3.5, 'snake', 1.0], [10.9, 5.6, 'bush', 0.85],
  ];
  if ((props.plants || 1) > 1) plants.push([0.55, 17.55, 'bush', 0.95], [21.4, 14.2, 'tall', 0.9], [5.0, 12.8, 'snake', 0.85]);
  plants.forEach(([x, y, k, s], i) => {
    items.push({ el: plant(P, x, y, k, pal, s, i + 1), depth: x + y });
    ob(x - 0.3, y - 0.3, 0.6, 0.6, 0.05);
  });
  if (props.lamps) {
    const [lx, ly] = P(4.4, 13.2, 0);
    const lamp = el('g', null,
      el('ellipse', { cx: lx, cy: ly, rx: 26, ry: 12, fill: 'url(#oc-lamp)' }),
      el('ellipse', { cx: lx, cy: ly, rx: 6, ry: 2.6, fill: '#3a3530' }),
      el('rect', { x: lx - 1, y: ly - 72, width: 2, height: 72, fill: '#3a3530' }),
      el('path', { d: `M${lx - 9} ${ly - 70} L${lx + 9} ${ly - 70} L${lx + 6} ${ly - 86} L${lx - 6} ${ly - 86} Z`, fill: props.neon ? '#ff4fd8' : '#f3d6a4', stroke: '#c79a5a', 'stroke-width': 0.8 }),
      el('ellipse', { cx: lx, cy: ly - 78, rx: 18, ry: 14, fill: 'url(#oc-lamp)' }),
    );
    items.push({ el: lamp, depth: 4.4 + 13.2 });
    ob(4.2, 13.0, 0.4, 0.4);
  }

  // 책상
  const desks = [];
  const nD = Math.min(nDesks, MAX_DESKS);
  for (let i = 0; i < nD; i++) {
    const u = deskUnit(P, i, nD, pal, props, defs);
    items.push(...u.items);
    obstacles.push(...u.obstacles);
    desks.push(u);
  }

  // 구역 표지판(화면 좌표 데이터)
  const zones = [
    zoneLabel(P, 1.2, 2.9, 178, 'shelf'),
    zoneLabel(P, 0.6, 10.2, 175, 'search'),
    zoneLabel(P, 0.3, 15.5, 176, 'lounge'),
    zoneLabel(P, 7.7, 0.2, 168, 'meeting'),
    zoneLabel(P, 17.8, 0.2, 172, 'server'),
    zoneLabel(P, 21.3, 7.0, 30, 'dev'),
  ];
  const labels = el('g', { class: 'oc-labels' });

  const nav = makeGridNav(W, D, obstacles);
  setDetail(1);
  return {
    mode: 'vector', width, height, P, defs, stat, labels, zones, neon, items, desks, door,
    spots: SPOTS, doorPos: [0.85, 6.75], charScale: 1, speed: 3.2, stride: 0.34,
    toScreen: (p, lift = 0) => P(p[0], p[1], lift),
    depth: (p) => p[0] + p[1],
    path: (a, b) => nav.path(a, b),
    visitor(desk, k) {
      const [cx, cy] = desk.chairPos;
      const opts = [[cx + 0.85, cy - 0.55], [cx + 0.85, cy + 0.6], [cx + 1.25, cy]];
      return opts[k % opts.length];
    },
    beside(p, k) {
      const opts = [[0.75, 0.55], [0.75, -0.55], [1.1, 0], [-0.1, 0.9]];
      const o = opts[k % opts.length];
      return nav.nearestFree([p[0] + o[0], p[1] + o[1]]);
    },
  };
}
