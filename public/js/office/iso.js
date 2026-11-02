// 아이소메트릭(2:1) 투영, SVG 생성, 색 계산 헬퍼 — 의존성 없음

export const NS = 'http://www.w3.org/2000/svg';
export const HX = 32;                 // 타일 반폭(px)
export const HY = 16;                 // 타일 반높이(px)
export const L = Math.hypot(HX, HY);  // 타일 한 변의 화면 길이(≈35.8px)
export const CX = HX / L;             // 축 단위벡터 성분(≈0.894)
export const CY = HY / L;             // (≈0.447)
export const RX1 = Math.SQRT2 * HX;   // 반지름 1타일 바닥 원 → 화면 타원 반경
export const RY1 = Math.SQRT2 * HY;

const r1 = (n) => Math.round(n * 10) / 10;

/** 월드(x,y 타일, z px) → 화면 좌표 투영기 */
export function projector(ox, oy) {
  return (x, y, z = 0) => [ox + (x - y) * HX, oy + (x + y) * HY - z];
}

/** SVG 요소 생성. attrs 의 null/false 는 건너뜀 */
export function el(tag, attrs, ...kids) {
  const n = document.createElementNS(NS, tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      n.setAttribute(k, typeof v === 'number' ? r1(v) : v);
    }
  }
  for (const c of kids.flat(3)) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

export const pts = (arr) => arr.map((p) => r1(p[0]) + ',' + r1(p[1])).join(' ');

// 장식 세부 수준(1=전체, 0=저사양: 광택·하이라이트·이중 그림자 생략) — 씬을 만드는 동안만 바뀜
let DETAIL = 1;
export function setDetail(d) { DETAIL = d ? 1 : 0; }

let uidN = 0;
export const uid = (p = 'oc') => `${p}-${(++uidN).toString(36)}`;

// ── 평면 변환: 로컬 (u=가로 px, v=아래쪽 px) → 화면 ─────────────────────
/** +y 를 바라보는 면(y=y 평면, 화면 왼쪽 아래 면). u 는 +x 방향. 원점=(x,y,z) */
export function planeY(P, x, y, z) {
  const [a, b] = P(x, y, z);
  return `matrix(${CX} ${CY} 0 1 ${r1(a)} ${r1(b)})`;
}
/** +x 를 바라보는 면(x=x 평면, 화면 오른쪽 아래 면). u 는 -y 방향(읽는 방향). 원점=(x,y,z) */
export function planeX(P, x, y, z) {
  const [a, b] = P(x, y, z);
  return `matrix(${CX} ${-CY} 0 1 ${r1(a)} ${r1(b)})`;
}
/** 바닥(z) 평면. u=+x px, v=+y px. 원점=(x,y,z) */
export function planeF(P, x, y, z = 0) {
  const [a, b] = P(x, y, z);
  return `matrix(${CX} ${CY} ${-CX} ${CY} ${r1(a)} ${r1(b)})`;
}

// ── 색 ─────────────────────────────────────────────────────────────
export function rgb(c) {
  if (typeof c !== 'string') return null;
  let h = c.trim();
  if (h[0] !== '#') return null;
  h = h.slice(1);
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex = (a) => '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
/** amt>0 밝게, amt<0 어둡게(-1..1). hex 가 아니면 원본 반환 */
export function shade(c, amt) {
  const a = rgb(c);
  if (!a) return c;
  return hex(a.map((v) => (amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
}
export function mix(c1, c2, t) {
  const a = rgb(c1), b = rgb(c2);
  if (!a || !b) return c1;
  return hex(a.map((v, i) => v + (b[i] - v) * t));
}
export function alpha(c, a) {
  const v = rgb(c);
  return v ? `rgba(${v[0]},${v[1]},${v[2]},${a})` : c;
}

// ── 입체 도형 ───────────────────────────────────────────────────────
/**
 * 직육면체(보이는 3면: 윗면, +y면, +x면). x,y,w,d 는 타일, z,h 는 px.
 * o: { top,left,right 색, stroke, hl(하이라이트 투명도), cls, gloss }
 */
export function box(P, x, y, z, w, d, h, color, o = {}) {
  const top = o.top || shade(color, 0.12);
  const left = o.left || color;
  const right = o.right || shade(color, -0.16);
  const A = P(x, y, z + h), B = P(x + w, y, z + h), C = P(x + w, y + d, z + h), D = P(x, y + d, z + h);
  const B0 = P(x + w, y, z), C0 = P(x + w, y + d, z), D0 = P(x, y + d, z);
  const g = el('g', o.cls ? { class: o.cls } : null);
  if (h > 0.01) {
    g.append(
      el('polygon', { points: pts([D, C, C0, D0]), fill: left }),
      el('polygon', { points: pts([C, B, B0, C0]), fill: right }),
    );
    if (o.gloss !== false && h > 14 && DETAIL) {
      // 옆면 위쪽이 살짝 밝아지는 부드러운 음영
      g.append(
        el('polygon', { points: pts([D, C, C0, D0]), fill: 'url(#oc-shadeV)' }),
        el('polygon', { points: pts([C, B, B0, C0]), fill: 'url(#oc-shadeV)' }),
      );
    }
  }
  g.append(el('polygon', { points: pts([A, B, C, D]), fill: top }));
  const stroke = o.stroke === undefined ? shade(color, -0.42) : o.stroke;
  if (stroke) {
    g.append(el('polygon', {
      points: pts(h > 0.01 ? [A, B, B0, C0, D0, D] : [A, B, C, D]),
      fill: 'none', stroke, 'stroke-opacity': o.so ?? 0.38, 'stroke-width': 1, 'stroke-linejoin': 'round',
    }));
  }
  if (o.hl !== 0 && DETAIL) {
    g.append(el('polyline', {
      points: pts([D, C, B]), fill: 'none', stroke: '#fff', 'stroke-opacity': o.hl ?? 0.4, 'stroke-width': 1,
    }));
  }
  return g;
}

/** 원기둥(중심 x,y, 반지름 r 타일, 높이 h px) */
export function cylinder(P, x, y, z, r, h, color, o = {}) {
  const [cx, cy] = P(x, y, z);
  const rx = r * RX1, ry = r * RY1;
  const g = el('g', o.cls ? { class: o.cls } : null);
  const body = `M${r1(cx - rx)} ${r1(cy - h)} L${r1(cx - rx)} ${r1(cy)} A${r1(rx)} ${r1(ry)} 0 0 0 ${r1(cx + rx)} ${r1(cy)} L${r1(cx + rx)} ${r1(cy - h)} Z`;
  g.append(
    el('path', { d: body, fill: color }),
    el('path', { d: body, fill: 'url(#oc-cyl)' }),
    el('ellipse', { cx, cy: cy - h, rx, ry, fill: o.top || shade(color, 0.14), stroke: shade(color, -0.35), 'stroke-opacity': 0.35 }),
  );
  if (o.inner) g.append(el('ellipse', { cx, cy: cy - h + 0.6, rx: rx * 0.82, ry: ry * 0.82, fill: o.inner }));
  return g;
}

/** 바닥 그림자(부드러운 2겹) */
export function floorShadow(P, x, y, w, d, op = 0.13, spread = 0.12) {
  const g = el('g', { class: 'oc-shd' });
  const poly = (m) => pts([P(x - m, y - m), P(x + w + m, y - m), P(x + w + m, y + d + m), P(x - m, y + d + m)]);
  if (!DETAIL) { g.append(el('polygon', { points: poly(spread), fill: '#000', 'fill-opacity': op * 0.7 })); return g; }
  g.append(
    el('polygon', { points: poly(spread * 2), fill: '#000', 'fill-opacity': op * 0.35 }),
    el('polygon', { points: poly(spread * 0.6), fill: '#000', 'fill-opacity': op * 0.6 }),
  );
  return g;
}

/** 해시(문자열 → 0..2^32) */
export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** 시드 고정 난수 */
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
