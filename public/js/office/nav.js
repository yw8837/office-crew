// 격자 A* 경로 탐색(0.5 타일 격자, 8방향, 시야 기반 경로 단순화)

export function makeGridNav(W, D, obstacles, cell = 0.5) {
  const cols = Math.ceil(W / cell), rows = Math.ceil(D / cell);
  const N = cols * rows;
  const blocked = new Uint8Array(N);
  const cx = (i) => (i + 0.5) * cell;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = cx(i), y = cx(j);
      if (x < 0.45 || y < 0.45 || x > W - 0.2 || y > D - 0.2) { blocked[j * cols + i] = 1; continue; }
      for (const o of obstacles) {
        const m = o.m ?? 0.16;
        if (x > o.x - m && x < o.x + o.w + m && y > o.y - m && y < o.y + o.d + m) { blocked[j * cols + i] = 1; break; }
      }
    }
  }
  const idx = (p) => {
    const i = Math.max(0, Math.min(cols - 1, Math.floor(p[0] / cell)));
    const j = Math.max(0, Math.min(rows - 1, Math.floor(p[1] / cell)));
    return j * cols + i;
  };
  const center = (k) => [cx(k % cols), cx(Math.floor(k / cols))];

  /** 시작·도착 주변을 임시로 열어 준 막힘 정보 */
  function withOpen(a, b) {
    const bl = blocked.slice();
    for (const p of [a, b]) {
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const dx = cx(i) - p[0], dy = cx(j) - p[1];
          if (dx * dx + dy * dy <= 0.36) bl[j * cols + i] = 0;
        }
      }
    }
    return bl;
  }

  function clear(bl, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const n = Math.ceil(Math.hypot(dx, dy) / (cell * 0.35));
    for (let s = 1; s < n; s++) {
      const t = s / n;
      if (bl[idx([a[0] + dx * t, a[1] + dy * t])]) return false;
    }
    return true;
  }

  function astar(bl, s, g) {
    const gS = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = [];
    const push = (k, f) => {
      heap.push([f, k]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top[1];
    };
    const gx = g % cols, gy = Math.floor(g / cols);
    const hfn = (k) => { const dx = Math.abs((k % cols) - gx), dy = Math.abs(Math.floor(k / cols) - gy); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    gS[s] = 0; push(s, hfn(s));
    while (heap.length) {
      const k = pop();
      if (k === g) break;
      if (closed[k]) continue;
      closed[k] = 1;
      const x = k % cols, y = Math.floor(k / cols);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nk = ny * cols + nx;
          if (bl[nk] || closed[nk]) continue;
          if (ox && oy && (bl[y * cols + nx] || bl[ny * cols + x])) continue; // 모서리 뚫기 금지
          const ng = gS[k] + (ox && oy ? 1.414 : 1);
          if (ng < gS[nk]) { gS[nk] = ng; came[nk] = k; push(nk, ng + hfn(nk)); }
        }
      }
    }
    if (came[g] === -1 && s !== g) return null;
    const out = [];
    for (let k = g; k !== -1; k = came[k]) { out.push(k); if (k === s) break; }
    return out.reverse();
  }

  return {
    path(a, b) {
      const bl = withOpen(a, b);
      if (clear(bl, a, b)) return [a.slice(), b.slice()];
      const cells = astar(bl, idx(a), idx(b));
      if (!cells) return [a.slice(), b.slice()];
      const raw = [a.slice(), ...cells.slice(1, -1).map(center), b.slice()];
      // 시야가 트이는 가장 먼 점으로 건너뛰기
      const out = [raw[0]];
      let i = 0;
      while (i < raw.length - 1) {
        let j = raw.length - 1;
        while (j > i + 1 && !clear(bl, raw[i], raw[j])) j--;
        out.push(raw[j]);
        i = j;
      }
      return out;
    },
    /** 막히지 않은 가장 가까운 칸 중심(없으면 원래 점) */
    nearestFree(p) {
      const k0 = idx(p);
      if (!blocked[k0]) return p;
      let best = null, bd = Infinity;
      for (let k = 0; k < N; k++) {
        if (blocked[k]) continue;
        const c = center(k), d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      return best || p;
    },
    isBlocked: (p) => !!blocked[idx(p)],
  };
}
