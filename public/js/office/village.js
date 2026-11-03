// 벡터 아이소메트릭 마을 씬: 주민(에이전트)은 쉬면 자기 집에 들어가 있고, 일하면 회사로 출근한다.
// 도구별 목적지 — 읽기=도서관, 검색=전망탑, 실행=작업장, 계획·긴 생각=광장 분수.
// 씬 인터페이스는 buildVectorScene 과 같다(+ houses: 에이전트마다 집 하나).
import {
  el, pts, projector, planeX, planeY, planeF, box, cylinder, floorShadow, setDetail,
  shade, rng, L,
} from './iso.js';
import { makeGridNav } from './nav.js';
import { deskUnit, plant, zoneLabel, MAX_DESKS } from './scene.js';

const W = 32, D = 26;
const S = 22;                 // 땅 단면 두께(px)
const ROAD_Y = [13.0, 14.6];  // 큰길(가로)
const ROAD_X = [8.4, 10.0];   // 큰길(세로)
const CO = { x0: 12, y0: 0.6, x1: 31, y1: 11.6, wall: 96, side: 34 }; // 회사 부지
const DESK_X = [14.0, 17.6, 21.2, 24.8];
const DESK_Y = [2.4, 5.6, 8.8];
const DESK_ORDER = [[0, 1], [0, 2], [1, 1], [1, 2], [0, 0], [0, 3], [1, 0], [1, 3], [2, 1], [2, 2], [2, 0], [2, 3]];
// 집 자리(가운데부터 채움). 집은 2×2 타일, 문은 +y 면
const HOUSE_SLOTS = [
  [11.2, 15.6], [14.4, 15.6], [4.0, 15.6], [17.6, 15.6], [0.8, 15.6], [20.8, 15.6],
  [11.2, 20.8], [14.4, 20.8], [4.0, 20.8], [17.6, 20.8], [24.0, 15.6], [27.2, 15.6],
];
const HS = 2.0, HH = 38; // 집 한 변(타일), 벽 높이(px)

const stand = (pos, face, flip) => ({ pos, pose: 'stand', face, flip });
const SPOTS = {
  shelf: [[1.5, 3.95], [2.5, 3.95], [3.5, 3.95], [2.0, 4.6], [3.0, 4.6]].map((p) => stand(p, 'back', 1)),
  server: [[5.5, 3.95], [6.5, 3.95], [7.4, 3.95], [6.0, 4.6], [7.0, 4.6]].map((p) => stand(p, 'back', 1)),
  search: [[3.15, 6.4], [3.15, 7.4], [3.8, 6.9], [3.8, 7.9], [3.8, 5.9]].map((p) => stand(p, 'back', -1)),
  meeting: [
    stand([5.8, 11.15], 'back', 1), stand([7.55, 9.4], 'back', -1), stand([4.05, 9.4], 'front', 1),
    stand([5.8, 7.65], 'front', -1), stand([7.3, 10.9], 'back', -1),
  ],
  lounge: [],
};

function tree(P, x, y, pal, s = 1, seed = 1) {
  const r = rng(seed * 131 + 7);
  const g = el('g', { class: 'oc-tree' });
  g.append(floorShadow(P, x - 0.45 * s, y - 0.45 * s, 0.9 * s, 0.9 * s, 0.12));
  g.append(cylinder(P, x, y, 0, 0.09 * s, 26 * s, pal.trunk));
  const [cx, cy] = P(x, y, 26 * s);
  const cols = [pal.leafDark, pal.leaf, pal.leafLight];
  [[0, -6, 17], [-11, 0, 12], [11, -1, 12], [-5, -17, 12], [7, -15, 11], [0, -25, 9]].forEach(([dx, dy, rr], i) => {
    g.append(el('circle', { cx: cx + dx * s + (r() - 0.5) * 2, cy: cy + dy * s, r: rr * s, fill: cols[i % 3], stroke: shade(pal.leafDark, -0.25), 'stroke-width': 0.7 }));
  });
  g.append(el('circle', { cx: cx - 5 * s, cy: cy - 22 * s, r: 3 * s, fill: '#fff', 'fill-opacity': 0.22 }));
  return g;
}

function lampPost(P, x, y) {
  const [bx, by] = P(x, y, 0);
  return el('g', { class: 'oc-lamp' },
    el('ellipse', { cx: bx, cy: by, rx: 5, ry: 2.4, fill: '#000', 'fill-opacity': 0.18 }),
    el('rect', { x: bx - 1.3, y: by - 62, width: 2.6, height: 62, fill: '#3c4350' }),
    el('path', { d: `M${bx} ${by - 62} q0 -6 7 -6`, stroke: '#3c4350', 'stroke-width': 2.4, fill: 'none' }),
    el('ellipse', { class: 'oc-lamp-glow', cx: bx + 8, cy: by - 64, rx: 6, ry: 3.5, fill: '#ffe9a8' }),
  );
}

/** 집 한 채. skin.homeImage 가 있으면 그 그림으로(예: 사용자가 올린 캡슐·공 그림) */
function house(P, i, x, y, pal, homeImage, homePixel) {
  const g = el('g', { class: 'oc-house', 'data-house': i });
  const roofC = pal.roofs[i % pal.roofs.length];
  const wallC = pal.houseWalls[i % pal.houseWalls.length];
  const door = [x + HS * 0.5, y + HS + 0.38];
  if (homeImage) {
    const [cx, cy] = P(x + HS / 2, y + HS / 2, 0);
    g.append(floorShadow(P, x + 0.2, y + 0.2, HS - 0.4, HS - 0.4, 0.14));
    g.append(el('image', { class: 'oc-home-img', href: homeImage, x: cx - 46, y: cy - 78, width: 92, height: 92, preserveAspectRatio: 'xMidYMax meet', style: homePixel ? 'image-rendering:pixelated' : null }));
  } else {
    g.append(floorShadow(P, x, y, HS, HS, 0.14));
    g.append(box(P, x, y, 0, HS, HS, HH, wallC, { hl: 0.3 }));
    // 지붕(용마루가 x 방향): 뒤 경사 → 앞 경사 → 오른쪽 박공 순서로
    const o = 0.22, zr = HH + 26;
    g.append(
      el('polygon', { points: pts([P(x - o, y - o, HH - 2), P(x + HS + o, y - o, HH - 2), P(x + HS + o, y + HS / 2, zr), P(x - o, y + HS / 2, zr)]), fill: shade(roofC, -0.18) }),
      el('polygon', { points: pts([P(x + HS, y, HH), P(x + HS, y + HS, HH), P(x + HS, y + HS / 2, zr - 2)]), fill: shade(wallC, -0.12) }),
      el('polygon', { points: pts([P(x - o, y + HS / 2, zr), P(x + HS + o, y + HS / 2, zr), P(x + HS + o, y + HS + o, HH - 2), P(x - o, y + HS + o, HH - 2)]), fill: roofC, stroke: shade(roofC, -0.35), 'stroke-width': 1 }),
      el('path', { d: `M${P(x - o, y + HS / 2, zr).join(' ')} L${P(x + HS + o, y + HS / 2, zr).join(' ')}`, stroke: shade(roofC, 0.3), 'stroke-width': 2 }),
    );
    // 굴뚝
    g.append(box(P, x + HS * 0.72, y + 0.45, HH + 12, 0.28, 0.28, 22, shade(wallC, -0.25), { hl: 0 }));
    // 앞면: 문 + 창문 2개
    const f = el('g', { transform: planeY(P, x, y + HS, HH) });
    const fw = HS * L;
    f.append(
      el('rect', { x: fw * 0.38, y: HH - 26, width: fw * 0.24, height: 26, rx: 2, fill: pal.door, stroke: shade(pal.door, -0.35), 'stroke-width': 0.8 }),
      el('circle', { cx: fw * 0.58, cy: HH - 12, r: 1.3, fill: '#f5d27a' }),
      el('rect', { class: 'oc-win', x: fw * 0.1, y: HH - 27, width: fw * 0.2, height: 13, rx: 1.5 }),
      el('rect', { class: 'oc-win', x: fw * 0.7, y: HH - 27, width: fw * 0.2, height: 13, rx: 1.5 }),
      el('path', { d: `M${fw * 0.2} ${HH - 27} L${fw * 0.2} ${HH - 14} M${fw * 0.8} ${HH - 27} L${fw * 0.8} ${HH - 14}`, stroke: '#fff', 'stroke-width': 1, 'stroke-opacity': 0.7 }),
    );
    g.append(f);
    const side = el('g', { transform: planeX(P, x + HS, y + HS, HH) });
    side.append(el('rect', { class: 'oc-win', x: HS * L * 0.35, y: HH - 27, width: HS * L * 0.3, height: 13, rx: 1.5 }));
    g.append(side);
  }
  // 우체통(주인 색) — 문 옆
  const plate = el('g', { class: 'oc-plate' });
  g.append(plate);
  // 안에 있을 때 굴뚝·지붕 위로 zzz
  const [zx, zy] = P(x + HS * 0.85, y + 0.6, HH + 40);
  g.append(el('g', { class: 'oc-hz' },
    ...[[0, 0, 6], [8, -10, 8], [17, -22, 10]].map(([dx, dy, s], k) => el('path', {
      class: `oc-hz${k}`, d: `M${zx + dx} ${zy + dy} l${s} 0 l${-s} ${s} l${s} 0`, fill: 'none', stroke: '#6d7cff', 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }))));
  const mb = [x + HS + 0.12, y + HS + 0.15];
  return {
    index: i, group: g, door, plate,
    items: [{ el: g, depth: x + HS / 2 + y + HS / 2 }],
    obstacles: [{ x, y, w: HS, d: HS }],
    setPlate(color) {
      plate.replaceChildren(
        box(P, mb[0], mb[1], 0, 0.08, 0.08, 16, '#5b4636', { hl: 0, stroke: null }),
        box(P, mb[0] - 0.12, mb[1] - 0.1, 16, 0.32, 0.26, 9, color || '#94a3b8', { hl: 0.5 }),
      );
    },
    setHome(inside) { g.classList.toggle('lit', !!inside); },
  };
}

// ── 씬 조립 ─────────────────────────────────────────────────────────
export function buildVillageScene(skin, nAgents, opts = {}) {
  setDetail(opts.lite ? 0 : 1);
  const pal = skin.palette, props = skin.props || {};
  const OX = D * 32 + 72, OY = 190;
  const P = projector(OX, OY);
  const width = (W + D) * 32 + 144, height = OY + (W + D) * 16 + S + 70;
  const lite = !!opts.lite;

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
    el('radialGradient', { id: 'oc-glow' },
      el('stop', { offset: 0, 'stop-color': pal.glow, 'stop-opacity': 0 }),
      el('stop', { offset: 1, 'stop-color': pal.glow, 'stop-opacity': 0 })),
    el('radialGradient', { id: 'oc-lamp' },
      el('stop', { offset: 0, 'stop-color': '#ffd27a', 'stop-opacity': 0.35 }),
      el('stop', { offset: 1, 'stop-color': '#ffd27a', 'stop-opacity': 0 })),
  );

  const stat = el('g', { class: 'oc-static' });
  const items = [];
  const obstacles = [];
  const ob = (x, y, w, d, m) => obstacles.push({ x, y, w, d, m });

  // 땅 단면 + 잔디
  stat.append(
    el('polygon', { points: pts([P(-0.3, -0.3, -S - 30), P(W + 1.4, -0.3, -S - 30), P(W + 1.4, D + 1.4, -S - 30), P(-0.3, D + 1.4, -S - 30)]), fill: '#000', 'fill-opacity': 0.07 }),
    el('polygon', { points: pts([P(0, D, 0), P(W, D, 0), P(W, D, -S), P(0, D, -S)]), fill: pal.soil }),
    el('polygon', { points: pts([P(W, 0, 0), P(W, D, 0), P(W, D, -S), P(W, 0, -S)]), fill: shade(pal.soil, -0.15) }),
    el('polygon', { points: pts([P(0, D, -4), P(W, D, -4), P(W, D, 0), P(0, D, 0)]), fill: pal.grassDark }),
    el('polygon', { points: pts([P(W, 0, -4), P(W, D, -4), P(W, D, 0), P(W, 0, 0)]), fill: shade(pal.grassDark, -0.1) }),
  );
  const gr = el('g', { transform: planeF(P, 0, 0, 0) });
  gr.append(el('rect', { x: 0, y: 0, width: W * L, height: D * L, fill: pal.grass }));
  if (!lite) {
    const r = rng(7);
    for (let j = 0; j < D; j += 2) for (let i = (j / 2) % 2 ? 2 : 0; i < W; i += 4) {
      gr.append(el('rect', { x: i * L, y: j * L, width: 2 * L, height: 2 * L, fill: pal.grassAlt, 'fill-opacity': 0.5 }));
    }
    for (let k = 0; k < 90; k++) {
      const u = r() * W * L, v = r() * D * L;
      gr.append(el('path', { d: `M${u.toFixed(1)} ${v.toFixed(1)} l2 -5 M${(u + 4).toFixed(1)} ${v.toFixed(1)} l-1 -6`, stroke: pal.grassDark, 'stroke-width': 1, 'stroke-opacity': 0.55 }));
    }
  }
  stat.append(gr);
  // 큰길(가로·세로) + 가운데 점선 + 횡단보도
  const road = el('g', { class: 'oc-road' });
  const rf = (x, y, w, d) => el('g', { transform: planeF(P, x, y, 0.2) }, el('rect', { x: 0, y: 0, width: w * L, height: d * L, fill: pal.road }));
  road.append(rf(0, ROAD_Y[0], W, ROAD_Y[1] - ROAD_Y[0]), rf(ROAD_X[0], 0, ROAD_X[1] - ROAD_X[0], D));
  const dash = el('g', { transform: planeF(P, 0, (ROAD_Y[0] + ROAD_Y[1]) / 2, 0.4) });
  for (let u = 6; u < W * L; u += 34) if (u / L < ROAD_X[0] - 0.2 || u / L > ROAD_X[1] + 0.2) dash.append(el('rect', { x: u, y: -1.5, width: 16, height: 3, fill: pal.roadLine }));
  const dash2 = el('g', { transform: planeF(P, (ROAD_X[0] + ROAD_X[1]) / 2, 0, 0.4) });
  for (let v = 6; v < D * L; v += 34) if (v / L < ROAD_Y[0] - 0.2 || v / L > ROAD_Y[1] + 0.2) dash2.append(el('rect', { x: -1.5, y: v, width: 3, height: 16, fill: pal.roadLine }));
  const zebra = el('g', { transform: planeF(P, ROAD_X[1] + 0.25, ROAD_Y[0], 0.4) });
  for (let k = 0; k < 5; k++) zebra.append(el('rect', { x: k * 9, y: 3, width: 5, height: (ROAD_Y[1] - ROAD_Y[0]) * L - 6, fill: '#fff', 'fill-opacity': 0.8 }));
  road.append(dash, dash2, zebra);
  stat.append(road);
  // 집 앞마당 오솔길(문 앞 1타일)
  const paths = el('g');
  for (const [hx, hy] of HOUSE_SLOTS.slice(0, Math.min(Math.max(0, nAgents), MAX_DESKS))) {
    paths.append(el('g', { transform: planeF(P, hx + 0.65, hy + HS, 0.3) }, el('rect', { x: 0, y: 0, width: 0.7 * L, height: 1.0 * L, rx: 5, fill: pal.path })));
  }
  stat.append(paths);

  // ── 회사 ──
  const co = el('g', { class: 'oc-company' });
  const cf = el('g', { transform: planeF(P, CO.x0, CO.y0, 0.5) });
  const cw = (CO.x1 - CO.x0) * L, cd = (CO.y1 - CO.y0) * L;
  cf.append(el('rect', { x: 0, y: 0, width: cw, height: cd, fill: pal.floor }));
  for (let v = 0; v < cd; v += L * 0.5) cf.append(el('path', { d: `M0 ${v} L${cw} ${v}`, stroke: pal.floorLine, 'stroke-width': 0.8, 'stroke-opacity': 0.5 }));
  co.append(cf);
  // 앞·오른쪽 낮은 턱
  co.append(
    el('polygon', { points: pts([P(CO.x0, CO.y1, 0), P(CO.x1, CO.y1, 0), P(CO.x1, CO.y1, 6), P(CO.x0, CO.y1, 6)]), fill: shade(pal.wall, -0.15) }),
    el('polygon', { points: pts([P(CO.x1, CO.y0, 0), P(CO.x1, CO.y1, 0), P(CO.x1, CO.y1, 6), P(CO.x1, CO.y0, 6)]), fill: shade(pal.wall, -0.25) }),
  );
  // 뒷벽(높게, 창문 + 간판) / 왼벽(낮게: 뒤로 지나가는 주민을 가리지 않을 높이, 입구는 비움)
  const ENT = [8.4, 11.6]; // 왼벽 입구(y 구간)
  co.append(
    el('polygon', { points: pts([P(CO.x0, CO.y0, 0), P(CO.x1, CO.y0, 0), P(CO.x1, CO.y0, CO.wall), P(CO.x0, CO.y0, CO.wall)]), fill: pal.wall }),
    el('polygon', { points: pts([P(CO.x0 - 0.3, CO.y0 - 0.3, CO.wall), P(CO.x1, CO.y0 - 0.3, CO.wall), P(CO.x1, CO.y0, CO.wall), P(CO.x0, CO.y0, CO.wall)]), fill: pal.wallTop }),
    el('polygon', { points: pts([P(CO.x0, CO.y0, 0), P(CO.x0, ENT[0], 0), P(CO.x0, ENT[0], CO.side), P(CO.x0, CO.y0, CO.side)]), fill: shade(pal.wall, -0.06) }),
    el('polygon', { points: pts([P(CO.x0 - 0.3, CO.y0, CO.side), P(CO.x0, CO.y0, CO.side), P(CO.x0, ENT[0], CO.side), P(CO.x0 - 0.3, ENT[0], CO.side)]), fill: pal.wallTop }),
    el('polygon', { points: pts([P(CO.x0 - 0.3, ENT[0], 0), P(CO.x0, ENT[0], 0), P(CO.x0, ENT[0], CO.side), P(CO.x0 - 0.3, ENT[0], CO.side)]), fill: shade(pal.wall, -0.2) }),
  );
  const bw = el('g', { transform: planeY(P, CO.x0, CO.y0, CO.wall) });
  for (let k = 0; k < 6; k++) {
    const wx = (1.2 + k * 3.0) * L;
    bw.append(
      el('rect', { x: wx, y: 22, width: 1.9 * L, height: 44, rx: 3, fill: pal.glass, stroke: shade(pal.wall, -0.3), 'stroke-width': 1.5 }),
      el('path', { d: `M${wx + 0.95 * L} 22 L${wx + 0.95 * L} 66 M${wx} 44 L${wx + 1.9 * L} 44`, stroke: '#fff', 'stroke-width': 1.4, 'stroke-opacity': 0.8 }),
      el('polygon', { points: `${wx + 8},24 ${wx + 20},24 ${wx + 10},64 ${wx - 2},64`, fill: '#fff', 'fill-opacity': 0.18 }),
    );
  }
  bw.append(el('rect', { x: 0, y: 0, width: (CO.x1 - CO.x0) * L, height: 8, fill: pal.accent, 'fill-opacity': 0.85 }));
  co.append(bw);
  // 입구 매트
  co.append(el('g', { transform: planeF(P, CO.x0 + 0.1, ENT[0] + 0.5, 0.6) }, el('rect', { x: 0, y: 0, width: 1.2 * L, height: 2.2 * L, rx: 4, fill: pal.accent, 'fill-opacity': 0.35 })));
  stat.append(co);
  ob(CO.x0, 0, CO.x1 - CO.x0, CO.y0 + 0.1, 0.05);
  ob(CO.x0 - 0.3, CO.y0, 0.3, ENT[0] - CO.y0, 0.1);
  // 앞·오른쪽 턱: 길찾기 격자(0.5)보다 두껍게 막아야 가로질러 들어오지 않음 → 드나드는 곳은 왼벽 입구뿐
  ob(CO.x0 + 0.4, CO.y1 - 0.3, CO.x1 - CO.x0, 0.6, 0.05);
  ob(CO.x1 - 0.3, CO.y0, 0.6, CO.y1 - CO.y0 + 0.3, 0.05);
  // 회사 안 소품: 정수기·화분
  {
    const g = el('g');
    g.append(floorShadow(P, 29.6, 1.0, 0.7, 0.7, 0.12));
    g.append(box(P, 29.6, 1.0, 0, 0.7, 0.7, 42, '#e5e7eb', { hl: 0.4 }));
    g.append(cylinder(P, 29.95, 1.35, 42, 0.22, 20, '#9fd3f7'));
    items.push({ el: g, depth: 29.95 + 1.35 });
    ob(29.6, 1.0, 0.7, 0.7);
  }
  [[12.6, 1.2, 'tall', 1.1], [30.3, 10.9, 'bush', 1.0], [27.8, 1.2, 'snake', 1.0]].forEach(([x, y, k, s], i) => {
    items.push({ el: plant(P, x, y, k, pal, s, i + 3), depth: x + y });
    ob(x - 0.3, y - 0.3, 0.6, 0.6, 0.05);
  });

  // ── 도서관(읽기) ──
  {
    const x = 0.8, y = 0.8, w = 3.4, d = 2.4, h = 72;
    const g = el('g', { class: 'oc-library' });
    g.append(floorShadow(P, x, y, w, d, 0.14));
    g.append(box(P, x, y, 0, w, d, h, pal.library, { hl: 0.3 }));
    g.append(box(P, x - 0.15, y - 0.15, h, w + 0.3, d + 0.3, 8, shade(pal.library, -0.3), { hl: 0.4 }));
    const f = el('g', { transform: planeY(P, x, y + d, h) });
    const fw = w * L;
    for (let k = 0; k < 4; k++) f.append(el('rect', { x: 8 + k * (fw - 16) / 4, y: 12, width: 10, height: h - 12, fill: shade(pal.library, 0.18) })); // 기둥
    f.append(el('rect', { x: fw / 2 - 12, y: h - 34, width: 24, height: 34, rx: 10, fill: pal.door }));
    const books = el('g', { transform: `translate(${fw * 0.12} 18)` });
    for (let k = 0; k < 8; k++) books.append(el('rect', { x: k * 4.2, y: 0, width: 3.4, height: 12 + (k % 3) * 2, fill: pal.books[k % pal.books.length] }));
    f.append(books);
    g.append(f);
    items.push({ el: g, depth: x + w / 2 + y + d / 2 });
    ob(x, y, w, d);
  }
  // ── 작업장(실행) ──
  {
    const x = 5.0, y = 0.8, w = 2.8, d = 2.4, h = 58;
    const g = el('g', { class: 'oc-workshop' });
    g.append(floorShadow(P, x, y, w, d, 0.14));
    g.append(box(P, x, y, 0, w, d, h, pal.workshop, { hl: 0.25 }));
    g.append(box(P, x + 0.3, y + 0.3, h, 0.5, 0.5, 34, shade(pal.workshop, -0.3), { hl: 0 })); // 굴뚝
    const smoke = el('g', { class: 'oc-smoke' });
    const [sx, sy] = P(x + 0.55, y + 0.55, h + 40);
    [[0, 0, 5], [6, -10, 7], [2, -22, 8]].forEach(([dx, dy, rr]) => smoke.append(el('circle', { cx: sx + dx, cy: sy + dy, r: rr, fill: '#fff', 'fill-opacity': 0.55 })));
    g.append(smoke);
    const f = el('g', { transform: planeY(P, x, y + d, h) });
    const fw = w * L;
    f.append(el('rect', { x: fw * 0.15, y: h - 36, width: fw * 0.7, height: 36, fill: shade(pal.workshop, -0.35) })); // 셔터
    for (let v = h - 32; v < h; v += 5) f.append(el('path', { d: `M${fw * 0.15} ${v} L${fw * 0.85} ${v}`, stroke: shade(pal.workshop, -0.5), 'stroke-width': 1 }));
    const leds = el('g', { class: 'oc-led' });
    for (let k = 0; k < 5; k++) leds.append(el('circle', { cx: fw * 0.2 + k * 9, cy: 10, r: 2, fill: ['#4ade80', '#60a5fa', '#fbbf24'][k % 3] }));
    f.append(leds);
    g.append(f);
    items.push({ el: g, depth: x + w / 2 + y + d / 2 });
    ob(x, y, w, d);
  }
  // ── 전망탑(검색) ──
  {
    const x = 1.6, y = 6.8;
    const g = el('g', { class: 'oc-tower' });
    g.append(floorShadow(P, x - 0.7, y - 0.7, 1.4, 1.4, 0.14));
    g.append(cylinder(P, x, y, 0, 0.6, 30, shade(pal.tower, -0.1)));
    g.append(cylinder(P, x, y, 30, 0.38, 92, pal.tower));
    g.append(cylinder(P, x, y, 122, 0.62, 12, shade(pal.tower, 0.15)));
    const [tx, ty] = P(x, y, 134);
    g.append(
      el('path', { d: `M${tx} ${ty} L${tx} ${ty - 30}`, stroke: '#3c4350', 'stroke-width': 2 }),
      el('circle', { class: 'oc-led', cx: tx, cy: ty - 32, r: 3.2, fill: '#ef4444' }),
      el('path', { class: 'oc-dish', d: `M${tx - 16} ${ty - 6} Q${tx - 8} ${ty - 22} ${tx + 4} ${ty - 14}`, fill: '#e5e7eb', stroke: '#9aa3ae', 'stroke-width': 1.2 }),
    );
    items.push({ el: g, depth: x + y });
    ob(x - 0.75, y - 0.75, 1.5, 1.5);
  }
  // ── 광장 분수(계획·긴 생각) ──
  {
    const x = 5.8, y = 9.4;
    const pl = el('g', { transform: planeF(P, x - 2.0, y - 2.0, 0.3) });
    pl.append(el('rect', { x: 0, y: 0, width: 4 * L, height: 4 * L, rx: 2 * L, fill: pal.path }));
    stat.append(pl);
    const g = el('g', { class: 'oc-fountain' });
    g.append(cylinder(P, x, y, 0, 0.95, 10, pal.stone, { inner: pal.water }));
    g.append(cylinder(P, x, y, 10, 0.2, 22, pal.stone));
    g.append(cylinder(P, x, y, 32, 0.45, 5, pal.stone, { inner: pal.water }));
    const [wx, wy] = P(x, y, 44);
    g.append(el('path', { class: 'oc-spray', d: `M${wx} ${wy} q-10 -6 -16 12 M${wx} ${wy} q10 -6 16 12`, fill: 'none', stroke: '#bfe7ff', 'stroke-width': 2, 'stroke-linecap': 'round' }));
    items.push({ el: g, depth: x + y });
    ob(x - 1.0, y - 1.0, 2.0, 2.0);
    // 벤치 2개
    for (const [bx, by] of [[3.6, 11.2], [7.4, 7.2]]) {
      const b = el('g');
      b.append(box(P, bx, by, 8, 0.9, 0.36, 3, pal.wood, { hl: 0.4 }));
      b.append(box(P, bx + 0.05, by + 0.05, 0, 0.08, 0.26, 8, '#5b4636', { hl: 0, stroke: null }), box(P, bx + 0.77, by + 0.05, 0, 0.08, 0.26, 8, '#5b4636', { hl: 0, stroke: null }));
      items.push({ el: b, depth: bx + by + 0.6 });
      ob(bx, by, 0.9, 0.36, 0.05);
    }
  }

  // 집
  const houses = [];
  const nH = Math.min(Math.max(0, nAgents), MAX_DESKS);
  for (let i = 0; i < nH; i++) {
    const [hx, hy] = HOUSE_SLOTS[i];
    const hu = house(P, i, hx, hy, pal, skin.homeImage, !!skin.homePixel);
    items.push(...hu.items);
    obstacles.push(...hu.obstacles);
    houses.push(hu);
  }
  // 나무·가로등(빈 집 자리와 가장자리)
  const trees = [[0.7, 11.8, 1.1], [3.2, 12.2, 0.9], [30.6, 12.4, 1.0], [31.0, 18.0, 1.2], [30.4, 24.6, 1.1], [7.3, 24.8, 1.0], [1.2, 24.6, 1.2], [23.8, 24.7, 0.9]];
  for (let i = nH; i < HOUSE_SLOTS.length; i++) trees.push([HOUSE_SLOTS[i][0] + 1, HOUSE_SLOTS[i][1] + 1, 1.15]);
  trees.forEach(([x, y, s], i) => {
    items.push({ el: tree(P, x, y, pal, s, i + 1), depth: x + y });
    ob(x - 0.35, y - 0.35, 0.7, 0.7, 0.05);
  });
  for (const [x, y] of [[7.9, 12.7], [10.5, 12.7], [20.0, 12.4], [7.9, 15.0], [10.5, 19.5]]) {
    items.push({ el: lampPost(P, x, y), depth: x + y });
    ob(x - 0.12, y - 0.12, 0.24, 0.24, 0.02);
  }

  // 회사 책상
  const desks = [];
  const nD = Math.min(nAgents, MAX_DESKS);
  for (let i = 0; i < nD; i++) {
    const [r, c] = DESK_ORDER[i];
    const u = deskUnit(P, i, nD, pal, props, defs, { dx: DESK_X[c], dy: DESK_Y[r] });
    items.push(...u.items);
    obstacles.push(...u.obstacles);
    desks.push(u);
  }

  const zones = [
    zoneLabel(P, (CO.x0 + CO.x1) / 2, CO.y0, CO.wall + 26, 'company'),
    zoneLabel(P, 2.5, 2.0, 104, 'library'),
    zoneLabel(P, 6.4, 2.0, 112, 'workshop'),
    zoneLabel(P, 1.6, 6.8, 190, 'tower'),
    zoneLabel(P, 5.8, 9.4, 70, 'plaza'),
  ];
  const labels = el('g', { class: 'oc-labels' });
  const nav = makeGridNav(W, D, obstacles);
  setDetail(1);
  const homeDoor = [CO.x0 + 0.7, (ENT[0] + ENT[1]) / 2];
  return {
    mode: 'vector', kind: 'village', width, height, P, defs, stat, labels, zones, neon: null, items, desks, houses, door: null,
    spots: SPOTS, doorPos: homeDoor, charScale: 1, speed: 3.6, stride: 0.34,
    toScreen: (p, lift = 0) => P(p[0], p[1], lift),
    depth: (p) => p[0] + p[1],
    path: (a, b) => nav.path(a, b),
    visitor(desk, k) {
      const [cx, cy] = desk.chairPos;
      const o = [[cx + 0.85, cy - 0.55], [cx + 0.85, cy + 0.6], [cx + 1.25, cy]];
      return nav.nearestFree(o[k % o.length]);
    },
    beside(p, k) {
      const o = [[0.75, 0.55], [0.75, -0.55], [1.1, 0], [-0.1, 0.9]][k % 4];
      return nav.nearestFree([p[0] + o[0], p[1] + o[1]]);
    },
  };
}
