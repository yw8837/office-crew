// 치비 캐릭터 SVG 리그(앞/뒷모습, 앉기/서기/걷기, 표정·소품 레이어)
// 원점 = 발밑 중앙, 위쪽이 -y. 키 약 90px.
// 그리기 함수는 빌더 h(tag, attrs, ...kids) 를 받아 DOM(el) 과 문자열(svgStr) 양쪽에 재사용한다.
import { el, shade, hash, rng } from './iso.js';

export const HAIR_STYLES = ['short', 'bob', 'long', 'ponytail', 'bun', 'spiky'];
export const ACCESSORIES = ['none', 'glasses', 'headphones', 'cap', 'ribbon'];
export const OUTFITS = ['hoodie', 'shirt', 'suit', 'sweater'];
export const SKIN_TONES = { pale: '#fde7d6', light: '#f8d5b8', tan: '#eab68c', brown: '#c88d61', dark: '#8f5b3c' };
const ACC_ALIAS = { headset: 'headphones', headphone: 'headphones', hat: 'cap', bow: 'ribbon' };

const SKIN_LIST = ['#fde4d0', '#f8d3b5', '#efbf98', '#d79d70', '#a8714d'];
const HAIR_LIST = ['#2b2420', '#4a3426', '#7a4e2d', '#c58b4a', '#e6c27c', '#3b3f58', '#8b3a3a', '#d8d2cc', '#5a7bd8', '#e58fb0'];
const OUTFIT_LIST = ['#f3f3f0', '#3d5a80', '#e07a5f', '#81b29a', '#f2cc8f', '#6d597a', '#ef476f', '#118ab2', '#495057', '#8ecae6'];
const OUTFIT_NAMED = { hoodie: '#8ecae6', shirt: '#f3f3f0', suit: '#3a4256', sweater: '#e9c46a' };

const isColor = (v) => typeof v === 'string' && /^(#|rgb|hsl)/i.test(v.trim());

/** 문자열 SVG 빌더(DOM 없이 동작) */
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export function svgStr(tag, attrs, ...kids) {
  let a = '';
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      a += ` ${k}="${esc(typeof v === 'number' ? Math.round(v * 100) / 100 : v)}"`;
    }
  }
  const inner = kids.flat(3).filter((c) => c != null && c !== false).join('');
  return `<${tag}${a}>${inner}</${tag}>`;
}

/**
 * avatar 보정: 빈 값은 id 해시로 결정, 모르는 hairStyle 은 short, headset → headphones
 */
export function normalizeAvatar(agent) {
  const a = (agent && agent.avatar) || {};
  const r = rng(hash(String(agent.id || agent.name || 'x')));
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  let skin = a.skin;
  skin = SKIN_TONES[skin] || (isColor(skin) ? skin : pick(SKIN_LIST));
  const hair = isColor(a.hair) ? a.hair : pick(HAIR_LIST);
  const hairStyle = a.hairStyle ? (HAIR_STYLES.includes(a.hairStyle) ? a.hairStyle : 'short') : pick(HAIR_STYLES);
  let outfitStyle = OUTFITS.includes(a.outfitStyle) ? a.outfitStyle : null;
  let outfit = a.outfit;
  if (OUTFITS.includes(outfit)) { outfitStyle = outfit; outfit = OUTFIT_NAMED[outfit]; }
  if (!isColor(outfit)) outfit = pick(OUTFIT_LIST);
  if (!outfitStyle) outfitStyle = pick(OUTFITS);
  const r2 = r();
  let accessory = ACC_ALIAS[a.accessory] || a.accessory;
  if (!ACCESSORIES.includes(accessory)) accessory = a.accessory ? 'none' : (r2 < 0.4 ? 'none' : pick(ACCESSORIES.slice(1)));
  return { skin, hair, hairStyle, outfit, outfitStyle, accessory };
}

// ── 머리카락 모양 ─────────────────────────────────────────────────────
const CAP = 'M-23.5 -57 C-26 -74 -17 -88.5 0 -88.5 C17 -88.5 26 -74 23.5 -57 ';
const FRINGE = {
  short: 'L21.5 -59 Q20 -67 15 -70 Q12 -65 7.5 -68 Q3.5 -64 -1 -69 Q-5.5 -64.5 -10 -69 Q-15 -65.5 -18 -70 Q-21 -66 -21.5 -59 Z',
  bob: 'L21.5 -60 Q11 -68.5 0 -67.5 Q-11 -68.5 -21.5 -60 Z',
  long: 'L21.5 -58 Q17 -72 3 -70.5 Q-3 -66 -8 -70 Q-15 -69 -21.5 -58 Z',
  ponytail: 'L21.5 -59 Q15 -73 -2 -68 Q-12 -66 -21.5 -59 Z',
  bun: 'L21.5 -59 Q16 -69 8 -67.5 Q2 -71 -5 -67 Q-13 -69 -21.5 -59 Z',
  spiky: 'L20.5 -64 L15 -64.5 L12 -70 L6 -65 L1.5 -70.5 L-4.5 -65 L-8.5 -70.5 L-14 -65 L-17.5 -70 L-21.5 -59 Z',
};
const SPIKY_TOP = 'M-23.5 -57 L-26.5 -70 L-21 -75 L-23.5 -86 L-12.5 -85 L-10 -96 L-1.5 -88 L6.5 -98 L11 -87.5 L21.5 -91 L20 -80 L27.5 -73 L23.5 -57 ';

function hairFront(h, style, c) {
  const dark = shade(c, -0.25);
  const top = style === 'spiky' ? SPIKY_TOP : CAP;
  const kids = [];
  if (style === 'bob' || style === 'long') {
    const b = style === 'bob' ? -44 : -38;
    kids.push(
      h('path', { d: `M-23.5 -66 C-27 -56 -25.5 ${b + 3} -19.5 ${b} L-16.5 ${b - 2.5} C-19 -52 -19.5 -60 -18.5 -66 Z`, fill: c, stroke: dark, 'stroke-width': 0.8 }),
      h('path', { d: `M23.5 -66 C27 -56 25.5 ${b + 3} 19.5 ${b} L16.5 ${b - 2.5} C19 -52 19.5 -60 18.5 -66 Z`, fill: c, stroke: dark, 'stroke-width': 0.8 }),
    );
  }
  kids.push(
    h('path', { d: top + FRINGE[style], fill: c, stroke: dark, 'stroke-width': 0.9, 'stroke-linejoin': 'round' }),
    h('path', { d: 'M-15 -79 Q-7 -86.5 4 -85.5', fill: 'none', stroke: shade(c, 0.45), 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-opacity': 0.55 }),
  );
  return h('g', { class: 'oc-hairf' }, kids);
}

function hairBehind(h, style, c, accent) {
  const dark = shade(c, -0.22);
  const kids = [];
  if (style === 'long') {
    kids.push(h('path', { d: 'M-23 -72 C-29.5 -52 -28.5 -34 -20 -25 L20 -25 C28.5 -34 29.5 -52 23 -72 Z', fill: dark }));
  } else if (style === 'ponytail') {
    kids.push(
      h('path', { d: 'M13 -81 C31 -86 36 -66 29 -48 C27 -42 22 -42 23.5 -49 C27 -61 25 -71 13 -74 Z', fill: c, stroke: dark, 'stroke-width': 0.9 }),
      h('circle', { cx: 16.5, cy: -79.5, r: 3.2, fill: accent }),
    );
  } else if (style === 'bun') {
    kids.push(
      h('circle', { cx: 0, cy: -89, r: 10, fill: c, stroke: dark, 'stroke-width': 0.9 }),
      h('path', { d: 'M-5 -94 Q0 -97.5 5 -94', fill: 'none', stroke: shade(c, 0.4), 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-opacity': 0.6 }),
    );
  }
  return h('g', { class: 'oc-hairback' }, kids);
}

function hairCover(h, style, c, accent) {
  const dark = shade(c, -0.25);
  const sw = { stroke: dark, 'stroke-width': 0.9, 'stroke-linejoin': 'round' };
  const kids = [];
  if (style === 'bob') kids.push(h('path', { d: 'M-24 -66 C-24 -89 24 -89 24 -66 C25 -54 23 -46 18 -43.5 L-18 -43.5 C-23 -46 -25 -54 -24 -66 Z', fill: c, ...sw }));
  else if (style === 'long') kids.push(h('path', { d: 'M-24 -66 C-24 -89 24 -89 24 -66 C27 -50 26.5 -34 20 -26 L-20 -26 C-26.5 -34 -27 -50 -24 -66 Z', fill: c, ...sw }));
  else if (style === 'spiky') kids.push(h('path', { d: SPIKY_TOP + 'C24 -50 15 -45 0 -45 C-15 -45 -24 -50 -23.5 -57 Z', fill: c, ...sw }));
  else kids.push(h('ellipse', { cx: 0, cy: -65.5, rx: 23.6, ry: 21.6, fill: c, ...sw }));
  if (style === 'ponytail') {
    kids.push(
      h('path', { d: 'M-5.5 -68 C-9 -56 -6.5 -43 0 -34 C6.5 -43 9 -56 5.5 -68 Z', fill: shade(c, -0.08), ...sw }),
      h('circle', { cx: 0, cy: -68, r: 3.4, fill: accent }),
    );
  }
  if (style === 'bun') kids.push(h('circle', { cx: 0, cy: -84, r: 10, fill: c, ...sw }));
  // 머리결(뒷모습이 밋밋한 덩어리로 보이지 않게)
  const end = style === 'long' ? -30 : style === 'bob' ? -46 : -48;
  kids.push(
    h('path', { d: `M-15 -80 Q-19 -66 -15 ${end + 2} M-5 -86 Q-8 -70 -6 ${end} M6 -86 Q8 -70 6 ${end} M15 -80 Q19 -66 15 ${end + 2}`, fill: 'none', stroke: dark, 'stroke-opacity': 0.32, 'stroke-width': 1.1, 'stroke-linecap': 'round' }),
    h('path', { d: 'M-12 -80 Q0 -87 12 -80', fill: 'none', stroke: shade(c, 0.4), 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-opacity': 0.45 }),
  );
  return h('g', { class: 'oc-hairc' }, kids);
}

function accessory(h, kind, accent, back) {
  const dk = shade(accent, -0.3);
  const kids = [];
  if (kind === 'glasses' && !back) {
    const s = { fill: 'rgba(255,255,255,.2)', stroke: '#2d2f3a', 'stroke-width': 1.3 };
    kids.push(
      h('rect', { x: -14.3, y: -63.6, width: 11, height: 8.6, rx: 3, ...s }),
      h('rect', { x: 3.3, y: -63.6, width: 11, height: 8.6, rx: 3, ...s }),
      h('path', { d: 'M-3.3 -60.5 Q0 -62 3.3 -60.5', fill: 'none', stroke: '#2d2f3a', 'stroke-width': 1.2 }),
    );
  } else if (kind === 'headphones') {
    kids.push(
      h('path', { d: 'M-24.5 -61 C-27 -97 27 -97 24.5 -61', fill: 'none', stroke: '#2f3440', 'stroke-width': 3.8, 'stroke-linecap': 'round' }),
      h('rect', { x: -29, y: -69, width: 8.5, height: 15, rx: 4, fill: accent, stroke: dk, 'stroke-width': 0.9 }),
      h('rect', { x: 20.5, y: -69, width: 8.5, height: 15, rx: 4, fill: accent, stroke: dk, 'stroke-width': 0.9 }),
    );
    if (!back) kids.push(h('path', { d: 'M-25 -56 Q-24 -47 -12 -48.5', fill: 'none', stroke: '#2f3440', 'stroke-width': 1.4, 'stroke-linecap': 'round' }), h('circle', { cx: -11.5, cy: -48.6, r: 1.8, fill: '#2f3440' }));
  } else if (kind === 'cap') {
    kids.push(h('path', { d: 'M-23.5 -67 C-24 -93 24 -93 23.5 -67 Z', fill: accent, stroke: dk, 'stroke-width': 0.9 }));
    kids.push(back ? h('path', { d: 'M-6 -67 Q0 -73 6 -67', fill: 'none', stroke: dk, 'stroke-width': 2 }) : h('path', { d: 'M-22 -67.5 Q2 -60 27 -70 Q6 -74.5 -22 -67.5 Z', fill: dk }));
    kids.push(h('circle', { cx: 0, cy: -90.5, r: 2.2, fill: dk }));
  } else if (kind === 'ribbon') {
    kids.push(
      h('path', { d: 'M15 -82 L5.5 -89 L6.5 -75.5 Z', fill: accent, stroke: dk, 'stroke-width': 0.8 }),
      h('path', { d: 'M15 -82 L24.5 -89 L23.5 -75.5 Z', fill: accent, stroke: dk, 'stroke-width': 0.8 }),
      h('circle', { cx: 15, cy: -82, r: 2.8, fill: dk }),
    );
  }
  return h('g', { class: 'oc-acc' }, kids);
}

function torso(h, style, c, accent, back, shadeFill = '#000') {
  const dk = shade(c, -0.3);
  const base = 'M-14.5 -45 C-16.5 -37 -17 -26 -15 -17 L15 -17 C17 -26 16.5 -37 14.5 -45 C7 -48.5 -7 -48.5 -14.5 -45 Z';
  const kids = [
    h('path', { d: base, fill: c, stroke: dk, 'stroke-width': 0.9 }),
    h('path', { d: 'M8.5 -46.8 C14 -40 15 -28 13 -17 L15 -17 C17 -26 16.5 -37 14.5 -45 Z', fill: shadeFill, 'fill-opacity': 0.1 }),
  ];
  const cls = back ? 'oc-torso oc-torso-b' : 'oc-torso oc-torso-f';
  if (back) {
    kids.push(style === 'hoodie'
      ? h('path', { d: 'M-12.5 -47 Q0 -50 12.5 -47 Q13 -38 0 -33 Q-13 -38 -12.5 -47 Z', fill: shade(c, -0.12), stroke: dk, 'stroke-width': 0.7 })
      : h('path', { d: 'M0 -44 L0 -19', stroke: dk, 'stroke-opacity': 0.35, 'stroke-width': 1 }));
    return h('g', { class: cls }, kids);
  }
  if (style === 'hoodie') {
    kids.push(
      h('path', { d: 'M-12 -46.5 Q0 -38.5 12 -46.5 Q0 -50.5 -12 -46.5 Z', fill: shade(c, -0.14) }),
      h('path', { d: 'M-3 -43 L-3.6 -34 M3 -43 L3.6 -34', stroke: accent, 'stroke-width': 1.4, 'stroke-linecap': 'round' }),
      h('path', { d: 'M-9.5 -28 L9.5 -28 L11 -19.5 L-11 -19.5 Z', fill: '#000', 'fill-opacity': 0.08 }),
    );
  } else if (style === 'shirt' || style === 'suit') {
    kids.push(h('path', { d: 'M-7 -46.6 L0 -37 L7 -46.6 Z', fill: '#ffffff' }));
    if (style === 'suit') kids.push(h('path', { d: 'M-7 -46.6 L-1 -33 L-3 -19 M7 -46.6 L1 -33 L3 -19', fill: 'none', stroke: shade(c, -0.35), 'stroke-width': 1.1 }));
    kids.push(h('path', { d: 'M-1.8 -41 L1.8 -41 L2.6 -29 L0 -26 L-2.6 -29 Z', fill: accent, stroke: shade(accent, -0.3), 'stroke-width': 0.6 }));
  } else {
    kids.push(
      h('path', { d: 'M-6.5 -47 Q0 -41.5 6.5 -47', fill: 'none', stroke: shade(c, -0.18), 'stroke-width': 2.4 }),
      h('path', { d: 'M-16.3 -34 L16.3 -34 L16.5 -30.5 L-16.6 -30.5 Z', fill: accent, 'fill-opacity': 0.9 }),
    );
  }
  if (style === 'hoodie' || style === 'sweater') {
    // 사원증(프로바이더 색 줄)
    kids.push(
      h('path', { d: 'M-5 -45 L-1 -32 M5 -45 L1 -32', stroke: accent, 'stroke-width': 1, fill: 'none' }),
      h('rect', { x: -3.6, y: -32.5, width: 7.2, height: 8.5, rx: 1.2, fill: '#fff', stroke: '#c7ccd4', 'stroke-width': 0.6 }),
      h('rect', { x: -3.6, y: -32.5, width: 7.2, height: 2.4, rx: 1, fill: accent }),
    );
  }
  return h('g', { class: cls }, kids);
}

function sleeve(h, outfit, skin) {
  return [
    h('path', { d: 'M-4.3 -1 L4.3 -1 L3.9 14 Q0 16.5 -3.9 14 Z', fill: shade(outfit, -0.05), stroke: shade(outfit, -0.32), 'stroke-width': 0.8 }),
    h('circle', { cx: 0, cy: 16.6, r: 4.4, fill: skin, stroke: shade(skin, -0.3), 'stroke-width': 0.8 }),
  ];
}

function face(h, skin, withVariants = true) {
  const ink = '#2d2a36';
  const mouth = '#8a4b3c';
  const eye = (x) => h('g', null,
    h('ellipse', { cx: x, cy: -59, rx: 2.9, ry: 3.7, fill: ink }),
    h('circle', { cx: x - 0.9, cy: -60.4, r: 1.15, fill: '#fff' }),
  );
  const feat = [
    h('ellipse', { cx: -13, cy: -54.5, rx: 3.8, ry: 2.3, fill: '#ff8f8f', 'fill-opacity': 0.42 }),
    h('ellipse', { cx: 13, cy: -54.5, rx: 3.8, ry: 2.3, fill: '#ff8f8f', 'fill-opacity': 0.42 }),
    h('g', { class: 'oc-look' },
      h('g', { class: 'oc-ex ex-open', style: 'transform-origin:0 -59px' }, eye(-8), eye(8)),
      withVariants ? h('g', { class: 'oc-ex ex-wide' },
        h('ellipse', { cx: -8, cy: -59.5, rx: 3.4, ry: 4.4, fill: ink }), h('circle', { cx: -9, cy: -61, r: 1.4, fill: '#fff' }),
        h('ellipse', { cx: 8, cy: -59.5, rx: 3.4, ry: 4.4, fill: ink }), h('circle', { cx: 7, cy: -61, r: 1.4, fill: '#fff' })) : null,
    ),
    h('path', { class: 'oc-mo mo-smile', d: 'M-3 -51.5 Q0 -48.8 3 -51.5', fill: 'none', stroke: mouth, 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
  ];
  if (withVariants) {
    feat.push(
      h('path', { class: 'oc-ex ex-happy', d: 'M-11 -58.5 Q-8 -63 -5 -58.5 M5 -58.5 Q8 -63 11 -58.5', fill: 'none', stroke: ink, 'stroke-width': 1.9, 'stroke-linecap': 'round' }),
      h('path', { class: 'oc-ex ex-closed', d: 'M-11 -59 Q-8 -57 -5 -59 M5 -59 Q8 -57 11 -59', fill: 'none', stroke: ink, 'stroke-width': 1.7, 'stroke-linecap': 'round' }),
      h('ellipse', { class: 'oc-mo mo-o', cx: 0, cy: -50.5, rx: 2.3, ry: 2.8, fill: mouth }),
      h('path', { class: 'oc-mo mo-flat', d: 'M-2.6 -51 L2.6 -51', stroke: mouth, 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
      h('path', { class: 'oc-mo mo-wavy', d: 'M-4.5 -50.5 q1.1 -1.6 2.25 0 t2.25 0 t2.25 0 t2.25 0', fill: 'none', stroke: mouth, 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
      h('path', { class: 'oc-mo mo-grin', d: 'M-4.6 -52.5 Q0 -45.5 4.6 -52.5 Z', fill: mouth }),
    );
  }
  return h('g', { class: 'oc-face' },
    h('circle', { cx: -21.5, cy: -61, r: 4, fill: skin, stroke: shade(skin, -0.25), 'stroke-width': 0.8 }),
    h('circle', { cx: 21.5, cy: -61, r: 4, fill: skin, stroke: shade(skin, -0.25), 'stroke-width': 0.8 }),
    h('ellipse', { cx: 0, cy: -64, rx: 22, ry: 20, fill: skin, stroke: shade(skin, -0.22), 'stroke-width': 0.9 }),
    h('ellipse', { cx: 2, cy: -52, rx: 14, ry: 5, fill: '#000', 'fill-opacity': 0.035 }),
    h('g', { class: 'oc-feat', transform: 'translate(1.3 0)' }, feat),
  );
}

/**
 * 상반신 정면 아바타 SVG 문자열(채팅·사이드바·편집기 미리보기용). DOM 불필요.
 * @param {{skin,hair,hairStyle,outfit,accessory}} avatar
 * @param {{size?:number,color?:string,id?:string}} opts
 */
export function renderAvatarSVG(avatar, { size = 40, color, id } = {}) {
  const av = normalizeAvatar({ id: id || JSON.stringify(avatar || {}), avatar: avatar || {} });
  const accent = isColor(color) ? color : '#6b7cff';
  const h = svgStr;
  const suf = Math.random().toString(36).slice(2, 9);
  const gid = `ocav-g-${suf}`;
  const defs = h('defs', null,
    h('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 0 },
      h('stop', { offset: 0, 'stop-color': '#ffffff', 'stop-opacity': 0.14 }),
      h('stop', { offset: 0.6, 'stop-color': '#ffffff', 'stop-opacity': 0 }),
      h('stop', { offset: 1, 'stop-color': '#000000', 'stop-opacity': 0.12 })));
  const arm = (x, rot) => h('g', { transform: `translate(${x} -42) rotate(${rot})` }, sleeve(h, av.outfit, av.skin));
  const body = h('g', null,
    hairBehind(h, av.hairStyle, av.hair, accent),
    torso(h, av.outfitStyle, av.outfit, accent, false),
    h('path', { d: 'M-14.5 -45 C-16.5 -37 -17 -26 -15 -17 L15 -17 C17 -26 16.5 -37 14.5 -45 C7 -48.5 -7 -48.5 -14.5 -45 Z', fill: `url(#${gid})` }),
    arm(-13.5, 10), arm(13.5, -10),
    face(h, av.skin, false),
    hairFront(h, av.hairStyle, av.hair),
    accessory(h, av.accessory, accent, false),
  );
  return h('svg', {
    xmlns: 'http://www.w3.org/2000/svg', viewBox: '-42 -102 84 84', width: size, height: size,
    'aria-hidden': 'true', focusable: 'false', style: 'background:transparent;overflow:hidden',
  }, defs, body);
}

/** 'z' 글자를 선으로(SVG text 를 쓰지 않음) */
function zzz(cls, x, y, s) {
  const d = `M${x} ${y} l${s} 0 l${-s} ${s} l${s} 0`;
  return el('g', { class: cls },
    el('path', { d, fill: 'none', stroke: '#fff', 'stroke-width': s * 0.42 + 2.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    el('path', { d, fill: 'none', stroke: '#6d7cff', 'stroke-width': s * 0.42, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
  );
}

/**
 * 캐릭터 리그 생성(DOM)
 * @returns {{root, pos, flip, setFace(face), setWalk(phase|null), avatar}}
 */
export function buildRig(agent) {
  const h = el;
  const av = normalizeAvatar(agent);
  const accent = isColor(agent.color) ? agent.color : '#6b7cff';
  const pants = av.outfitStyle === 'suit' ? shade(av.outfit, -0.15) : '#3d4352';
  const root = el('g', { class: 'oc-char st-idle face-front pose-sit', 'data-agent': agent.id });
  const pos = el('g', { class: 'oc-pos' });
  const flip = el('g', { class: 'oc-flip' });
  const bodyW = el('g', { class: 'oc-bodyw' });

  // 다리
  const leg = (side) => {
    const x = side === 'l' ? -11 : 2;
    const sx = side === 'l' ? -6.5 : 6.5;
    return el('g', { class: `oc-leg oc-leg-${side}` },
      el('rect', { x, y: -16.5, width: 9, height: 13.5, rx: 3.2, fill: pants, stroke: shade(pants, -0.3), 'stroke-width': 0.7 }),
      el('ellipse', { cx: sx, cy: -2.6, rx: 5.9, ry: 3.3, fill: '#2f3238' }),
      el('ellipse', { cx: sx - 1.4, cy: -3.6, rx: 2.3, ry: 1, fill: '#fff', 'fill-opacity': 0.25 }),
    );
  };
  const legL = leg('l'), legR = leg('r');
  const legs = el('g', { class: 'oc-legs' }, legL, legR,
    el('path', { d: 'M-15 -21 L15 -21 L14.6 -13.5 L-14.6 -13.5 Z', fill: pants, stroke: shade(pants, -0.3), 'stroke-width': 0.7 }));

  // 팔: 위치(translate) > 걷기 스윙(JS) > 포즈·애니메이션(CSS)
  const mkArm = (side) => {
    const r = el('g', { class: 'oc-armr' }, sleeve(h, av.outfit, av.skin)[0]);
    if (side === 'r') {
      r.append(
        el('g', { class: 'oc-cup' },
          el('rect', { x: -2.5, y: 12.5, width: 8, height: 9, rx: 1.6, fill: '#ffffff', stroke: '#b8bec8', 'stroke-width': 0.7 }),
          el('path', { d: 'M5.5 14.5 q3.5 0.5 3.2 3 q-0.3 2.4 -3.2 2.2', fill: 'none', stroke: '#b8bec8', 'stroke-width': 1.3 }),
          el('ellipse', { cx: 1.5, cy: 12.9, rx: 3.6, ry: 1.1, fill: '#7a4a2a' }),
          el('rect', { x: -2.5, y: 16, width: 8, height: 2, fill: accent, 'fill-opacity': 0.85 }),
        ),
        el('g', { class: 'oc-mag' },
          el('path', { d: 'M0 18 L0 23', stroke: '#6b4f2a', 'stroke-width': 2.6, 'stroke-linecap': 'round' }),
          el('circle', { cx: 0, cy: 31, r: 8.4, fill: '#d6f0ff', 'fill-opacity': 0.85, stroke: '#7a5426', 'stroke-width': 2.8 }),
          el('path', { d: 'M-3 27 Q-2 25 0.5 25', stroke: '#fff', 'stroke-width': 1.2, fill: 'none', 'stroke-linecap': 'round' }),
        ),
        el('g', { class: 'oc-pen' },
          el('path', { d: 'M0 16 L0 25', stroke: accent, 'stroke-width': 2.6, 'stroke-linecap': 'round' }),
          el('path', { d: 'M0 25 L0 27', stroke: '#222', 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
        ),
      );
    }
    r.append(sleeve(h, av.outfit, av.skin)[1]);
    const w = el('g', { class: 'oc-armw' }, r);
    const outer = el('g', { class: `oc-arm oc-arm-${side}`, transform: `translate(${side === 'l' ? -13.5 : 13.5} -42)` }, w);
    return { outer, w };
  };
  const armL = mkArm('l'), armR = mkArm('r');
  const slotBack = el('g', { class: 'oc-slot-b' });
  const slotFront = el('g', { class: 'oc-slot-f' }, armL.outer, armR.outer);

  const headF = el('g', { class: 'oc-headf' },
    face(h, av.skin, true),
    hairFront(h, av.hairStyle, av.hair),
    accessory(h, av.accessory, accent, false),
    el('path', { class: 'oc-brow', d: 'M-12 -66 L-5 -68.5 M12 -66 L5 -68.5', stroke: '#3a2a22', 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
  );
  const headB = el('g', { class: 'oc-headb' },
    el('circle', { cx: -21.8, cy: -60.5, r: 4, fill: av.skin }),
    el('circle', { cx: 21.8, cy: -60.5, r: 4, fill: av.skin }),
    el('rect', { x: -6, y: -50, width: 12, height: 6, fill: shade(av.skin, -0.08) }),
    hairCover(h, av.hairStyle, av.hair, accent),
    accessory(h, av.accessory, accent, true),
  );
  const head = el('g', { class: 'oc-head', style: 'transform-origin:0 -46px' }, headF, headB);

  // 포즈 전용 팔·소품(앞모습)
  const sk = av.skin, sks = shade(av.skin, -0.3), oc = shade(av.outfit, -0.05), ocs = shade(av.outfit, -0.32);
  const armPath = (d) => [
    el('path', { d, fill: 'none', stroke: ocs, 'stroke-width': 9.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    el('path', { d, fill: 'none', stroke: oc, 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  ];
  const hand = (x, y) => el('circle', { cx: x, cy: y, r: 4.3, fill: sk, stroke: sks, 'stroke-width': 0.8 });
  const posed = el('g', { class: 'oc-posed' },
    el('g', { class: 'oc-book' },
      el('path', { d: 'M-14 -36 L0 -32.5 L14 -36 L14 -22.5 L0 -19 L-14 -22.5 Z', fill: shade(accent, -0.25) }),
      el('path', { d: 'M-12.5 -35 L0 -31.8 L0 -20.5 L-12.5 -23.7 Z', fill: '#fffdf6', stroke: '#d9d2c3', 'stroke-width': 0.5 }),
      el('path', { d: 'M12.5 -35 L0 -31.8 L0 -20.5 L12.5 -23.7 Z', fill: '#fffaf0', stroke: '#d9d2c3', 'stroke-width': 0.5 }),
      el('path', { d: 'M-10 -31 L-3 -29.2 M-10 -28.4 L-3 -26.6 M-10 -25.8 L-4 -24.3 M3 -29.2 L10 -31 M3 -26.6 L10 -28.4', stroke: '#b9b2a6', 'stroke-width': 0.8 }),
      el('path', { class: 'oc-page', d: 'M0 -31.8 L11.5 -34.6 L11.5 -23.4 L0 -20.5 Z', fill: '#ffffff', stroke: '#d9d2c3', 'stroke-width': 0.5 }),
    ),
    el('g', { class: 'oc-papers' },
      el('rect', { x: -11.5, y: -37, width: 22, height: 15, rx: 1.5, fill: shade(accent, -0.15), transform: 'rotate(-6 0 -30)' }),
      el('rect', { x: -10, y: -36.5, width: 20, height: 14, rx: 1, fill: '#ffffff', stroke: '#cfd5de', 'stroke-width': 0.6 }),
      el('path', { d: 'M-7 -33 L7 -33 M-7 -30 L5 -30 M-7 -27 L6 -27', stroke: '#9aa4b2', 'stroke-width': 0.9 }),
    ),
    el('g', { class: 'oc-carry' },
      ...armPath('M-13.5 -42 L-15.5 -32.5 L-8.5 -27.5'), hand(-8.3, -27.6),
      ...armPath('M13.5 -42 L15.5 -32.5 L8.5 -27.5'), hand(8.3, -27.6),
    ),
    el('g', { class: 'oc-chin' },
      ...armPath('M13.5 -42 L16 -33.5 L7 -44.5'), hand(6.2, -45.6),
    ),
  );

  const upper = el('g', { class: 'oc-upper' },
    slotBack,
    torso(h, av.outfitStyle, av.outfit, accent, false),
    torso(h, av.outfitStyle, av.outfit, accent, true),
    slotFront, head, posed,
  );
  const body = el('g', { class: 'oc-body' }, hairBehind(h, av.hairStyle, av.hair, accent), legs, upper);
  bodyW.append(body);
  const sel = el('g', { class: 'oc-sel' }, bodyW);
  flip.append(sel);

  const fx = el('g', { class: 'oc-fx' },
    el('path', { class: 'oc-sweat', d: 'M22 -86 C25.5 -80.5 25.5 -77 22 -76.5 C18.5 -77 18.5 -80.5 22 -86 Z', fill: '#8fd3ff', stroke: '#4aa3e0', 'stroke-width': 0.8 }),
    el('path', { class: 'oc-sweat oc-sweat2', d: 'M-24 -78 C-21.3 -74 -21.3 -71.5 -24 -71 C-26.7 -71.5 -26.7 -74 -24 -78 Z', fill: '#8fd3ff', stroke: '#4aa3e0', 'stroke-width': 0.8 }),
    zzz('oc-z oc-z1', 19, -96, 7),
    zzz('oc-z oc-z2', 27, -108, 9),
    zzz('oc-z oc-z3', 36, -122, 11),
  );

  pos.append(
    el('ellipse', { class: 'oc-ring', cx: 0, cy: 0, rx: 27, ry: 12.5 }),
    el('ellipse', { class: 'oc-pulse', cx: 0, cy: 0, rx: 25, ry: 11.5 }),
    el('ellipse', { class: 'oc-cshadow', cx: 0, cy: 0, rx: 16, ry: 6, fill: '#000', 'fill-opacity': 0.18 }),
    flip, fx,
  );
  root.append(pos);

  // 깜빡임·숨쉬기 타이밍을 캐릭터마다 다르게
  const seed = hash(String(agent.id));
  root.style.setProperty('--oc-d', `-${(seed % 4000) / 1000}s`);

  let curFace = 'front';
  return {
    root, pos, flip, avatar: av,
    setFace(f) {
      if (f === curFace) return;
      curFace = f;
      (f === 'back' ? slotBack : slotFront).append(armL.outer, armR.outer);
    },
    setWalk(ph) {
      if (ph == null) {
        for (const n of [legL, legR, bodyW, armL.w, armR.w]) n.removeAttribute('transform');
        return;
      }
      const s = Math.sin(ph);
      legL.setAttribute('transform', `translate(0 ${(-Math.max(0, s) * 3.4).toFixed(2)})`);
      legR.setAttribute('transform', `translate(0 ${(-Math.max(0, -s) * 3.4).toFixed(2)})`);
      bodyW.setAttribute('transform', `translate(0 ${(-Math.abs(s) * 1.7).toFixed(2)})`);
      armL.w.setAttribute('transform', `rotate(${(s * 18).toFixed(1)})`);
      armR.w.setAttribute('transform', `rotate(${(-s * 18).toFixed(1)})`);
    },
  };
}
