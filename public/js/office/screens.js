// 책상 모니터 화면 내용(상태별). 좌표는 모니터 평면의 로컬 px(원점 = 베젤 왼쪽 위)
import { el, rng } from './iso.js';

export const SCREEN_OF = {
  idle: 'idle', thinking: 'spin', typing: 'code', tool: 'tool', searching: 'web', reading: 'doc',
  running: 'term', waiting: 'wait', error: 'err', done: 'done', paused: 'pause', offline: 'off',
};

const CODE_COLS = ['#7dd3fc', '#c4b5fd', '#86efac', '#fda4af', '#fde68a', '#e5e7eb', '#93c5fd'];

export function renderScreen(g, kind, o) {
  const { SW, SH, seed = 1, icon = '🛠', idleColor = '#3c5d8f', accent = '#4c8dff', lite = false } = o;
  const X = 2.2, Y = 2.2;
  const r = rng(seed * 31 + 5);
  const rect = (x, y, w, h, fill, extra) => el('rect', { x, y, width: w, height: h, fill, ...extra });
  const kids = [];
  switch (kind) {
    case 'idle': {
      kids.push(rect(X, Y, SW, SH, idleColor),
        el('path', { d: `M${X} ${Y + SH * 0.7} Q${X + SW * 0.3} ${Y + SH * 0.45} ${X + SW * 0.55} ${Y + SH * 0.65} T${X + SW} ${Y + SH * 0.55} L${X + SW} ${Y + SH} L${X} ${Y + SH} Z`, fill: '#fff', 'fill-opacity': 0.14 }),
        el('circle', { cx: X + SW * 0.5, cy: Y + SH * 0.38, r: 4.5, fill: accent, 'fill-opacity': 0.75 }),
        rect(X + SW * 0.3, Y + SH - 4.5, SW * 0.4, 2.6, '#fff', { rx: 1.3, 'fill-opacity': 0.35 }));
      break;
    }
    case 'code': {
      kids.push(rect(X, Y, SW, SH, '#1b2130'), rect(X, Y, 5, SH, '#151a26'));
      const lines = [];
      const n = 12, step = 3.3;
      const mk = (off) => {
        const gg = [];
        for (let i = 0; i < n; i++) {
          const y = Y + 2 + off + i * step;
          gg.push(rect(X + 1.2, y, 2.4, 1.5, '#4b5563'));
          let x = X + 7 + Math.floor(r() * 3) * 3;
          const segs = 1 + Math.floor(r() * 3);
          for (let s = 0; s < segs && x < X + SW - 4; s++) {
            const w = 3 + r() * 12;
            gg.push(rect(x, y, Math.min(w, X + SW - 3 - x), 1.6, CODE_COLS[Math.floor(r() * CODE_COLS.length)], { rx: 0.6 }));
            x += w + 1.6;
          }
        }
        return gg;
      };
      lines.push(...mk(0));
      if (!lite) lines.push(...mk(n * step)); // 스크롤용 두 번째 벌(저사양에선 스크롤 안 함)
      kids.push(el('g', { class: 'oc-code', style: `--oc-scroll:-${(n * step).toFixed(1)}px` }, lines));
      kids.push(rect(X + 8, Y + SH - 5, 2.2, 3, '#e5e7eb', { class: 'oc-cursor' }));
      break;
    }
    case 'spin': {
      const cx = X + SW / 2, cy = Y + SH / 2;
      kids.push(rect(X, Y, SW, SH, '#1c2233'),
        el('circle', { cx, cy, r: 7, fill: 'none', stroke: '#334155', 'stroke-width': 2.4 }),
        el('circle', { class: 'oc-spin', cx, cy, r: 7, fill: 'none', stroke: '#a78bfa', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-dasharray': '14 40', style: `transform-origin:${cx.toFixed(1)}px ${cy.toFixed(1)}px` }),
        rect(X + SW / 2 - 9, cy + 10, 18, 1.6, '#475569', { rx: 0.8 }));
      break;
    }
    case 'tool': {
      kids.push(rect(X, Y, SW, SH, '#22293a'),
        rect(X + 4, Y + 3.5, SW - 8, SH - 7, '#eef2ff', { rx: 2 }),
        rect(X + 4, Y + 3.5, SW - 8, 4, '#c7d2fe', { rx: 2 }),
        // 도구 표시(톱니) — 아이콘 자체는 말풍선에 표시
        el('circle', { cx: X + SW / 2, cy: Y + SH / 2 + 0.5, r: 4.6, fill: 'none', stroke: icon === '🔌' ? '#0ea5e9' : icon === '✏️' ? '#f59e0b' : icon === '⌨️' ? '#22c55e' : '#6366f1', 'stroke-width': 2.6, 'stroke-dasharray': '2.4 1.4' }),
        el('circle', { cx: X + SW / 2, cy: Y + SH / 2 + 0.5, r: 1.6, fill: '#6366f1' }));
      for (let i = 0; i < 3; i++) kids.push(el('circle', { class: `oc-tdot oc-tdot${i}`, cx: X + SW / 2 - 4 + i * 4, cy: Y + SH - 6.5, r: 1.1, fill: '#6366f1' }));
      break;
    }
    case 'term': {
      kids.push(rect(X, Y, SW, SH, '#0d1117'));
      for (let i = 0; i < 4; i++) {
        kids.push(rect(X + 2.5, Y + 3 + i * 3.6, 2, 1.6, '#22c55e'), rect(X + 5.5, Y + 3 + i * 3.6, 6 + r() * 20, 1.6, i === 3 ? '#86efac' : '#9ca3af'));
      }
      kids.push(rect(X + 3, Y + SH - 7, SW - 6, 3.6, '#1f2937', { rx: 1.8 }),
        rect(X + 3, Y + SH - 7, SW - 6, 3.6, '#22c55e', { rx: 1.8, class: 'oc-prog', style: `transform-origin:${(X + 3).toFixed(1)}px 0` }));
      break;
    }
    case 'web': {
      kids.push(rect(X, Y, SW, SH, '#ffffff'), rect(X, Y, SW, 3.5, '#e5e7eb'),
        rect(X + 5, Y + 6, SW - 10, 3.6, '#ffffff', { rx: 1.8, stroke: '#93c5fd', 'stroke-width': 0.7 }),
        el('circle', { cx: X + 7.2, cy: Y + 7.8, r: 1, fill: 'none', stroke: '#2563eb', 'stroke-width': 0.6 }));
      for (let i = 0; i < 3; i++) kids.push(rect(X + 4, Y + 12 + i * 5, 10 + r() * 14, 1.5, '#2563eb'), rect(X + 4, Y + 14.2 + i * 5, 18 + r() * 12, 1.1, '#9ca3af'));
      break;
    }
    case 'doc': {
      kids.push(rect(X, Y, SW, SH, '#e9edf3'), rect(X + 7, Y + 2, SW - 14, SH - 2, '#ffffff'), rect(X + 10, Y + 5, 14, 2, '#334155'));
      for (let i = 0; i < 5; i++) kids.push(rect(X + 10, Y + 9.5 + i * 3.2, SW - 22 - r() * 6, 1.1, '#94a3b8'));
      break;
    }
    case 'wait': {
      kids.push(rect(X, Y, SW, SH, '#1f2430'),
        el('g', { class: 'oc-blinkcard' },
          rect(X + 5, Y + 4, SW - 10, SH - 8, '#fde047', { rx: 2 }),
          rect(X + SW / 2 - 1.2, Y + 7, 2.4, 7, '#713f12', { rx: 1 }), el('circle', { cx: X + SW / 2, cy: Y + 16.6, r: 1.3, fill: '#713f12' }),
          rect(X + 9, Y + SH - 9, 9, 3, '#16a34a', { rx: 1 }), rect(X + SW - 18, Y + SH - 9, 9, 3, '#9ca3af', { rx: 1 })));
      break;
    }
    case 'err': {
      const cx = X + SW / 2, cy = Y + SH / 2;
      kids.push(rect(X, Y, SW, SH, '#b91c1c'), rect(X, Y, SW, SH * 0.45, '#ef4444', { 'fill-opacity': 0.5 }),
        el('path', { d: `M${cx} ${cy - 8} L${cx + 8} ${cy + 6} L${cx - 8} ${cy + 6} Z`, fill: '#fff', 'stroke-linejoin': 'round', stroke: '#fff', 'stroke-width': 1.2 }),
        rect(cx - 1, cy - 3, 2, 5.4, '#b91c1c', { rx: 0.8 }), el('circle', { cx, cy: cy + 4.2, r: 1.1, fill: '#b91c1c' }));
      break;
    }
    case 'done': {
      const cx = X + SW / 2, cy = Y + SH / 2;
      kids.push(rect(X, Y, SW, SH, '#15803d'), rect(X, Y, SW, SH * 0.45, '#22c55e', { 'fill-opacity': 0.5 }),
        el('circle', { cx, cy, r: 8, fill: '#fff', 'fill-opacity': 0.2 }),
        el('path', { d: `M${cx - 5} ${cy} L${cx - 1.5} ${cy + 3.6} L${cx + 5.5} ${cy - 4}`, fill: 'none', stroke: '#fff', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      break;
    }
    case 'pause': {
      const cx = X + SW / 2, cy = Y + SH / 2;
      kids.push(rect(X, Y, SW, SH, '#475569'), rect(cx - 5, cy - 6, 3.6, 12, '#e2e8f0', { rx: 1 }), rect(cx + 1.4, cy - 6, 3.6, 12, '#e2e8f0', { rx: 1 }));
      break;
    }
    default: // off
      kids.push(rect(X, Y, SW, SH, '#0b0d12'));
  }
  kids.push(el('polygon', { points: `${X + SW * 0.55},${Y} ${X + SW * 0.78},${Y} ${X + SW * 0.42},${Y + SH} ${X + SW * 0.2},${Y + SH}`, fill: '#fff', 'fill-opacity': 0.07 }));
  g.replaceChildren(...kids);
}
