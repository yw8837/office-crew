// 프로젝트 기억: 대화 원문을 잘게 쪼개 디스크에 쌓고, 요청과 관련된 조각만 정해진 양만큼 꺼낸다.
// - 원문 조각(chunks-*.jsonl)은 덧붙이기만 한다. 고치거나 지우지 않는다(요약으로 바꿔 치우지 않는다 = 잃지 않는다)
// - 색인(idx/)은 원문에서 언제든 다시 만들 수 있는 사본이다. 깨지면 rebuild() 한다
// - 찾을 때 AI를 부르지 않는다(추가 토큰 0). 꺼내는 양은 기억 크기와 상관없이 budget 글자까지다
// - 관련된 게 없으면 빈 결과를 준다(억지로 채우지 않는다)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fsp = fs.promises;
export const CHUNK_CHARS = 900; // 조각 하나의 최대 글자 수
const SEG_BYTES = 4 * 1024 * 1024; // 원문 파일 하나의 최대 크기
const SHARDS = 1024; // 색인 파일 수(낱말 해시로 나눈다)
const LOC_REC = 20; // 위치표 한 줄: 파일 번호 u32, 시작 u32, 길이 u32, 시각 f64
const FLUSH_CHUNKS = 64; // 색인을 이만큼 모아서 쓴다
const QUERY_TERMS = 40; // 한 번 찾을 때 쓰는 낱말 수 상한(읽는 색인 파일 수 상한)
const K1 = 1.2;

// 글에 섞인 흔한 토큰 모양은 저장 전에 가린다(모든 비밀을 잡지는 못한다)
const redact = (s) => String(s).replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_\w{8,}|github_pat_\w{8,}|xox[abprs]-[\w-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[\w-]{10,}\.[\w.-]+)\b/g, '•••')
  .replace(/([?&](?:[\w-]*(?:token|key|secret|auth|password)[\w-]*)=)[^\s&]+/gi, '$1•••');

const CJK = /[぀-ヿ㐀-鿿가-힣]/;

// 낱말 나누기: 영문·숫자는 낱말 단위, 한글·한자·가나는 두 글자씩(형태소 분석기 없이 조사·어미에 덜 흔들리게)
export function tokenize(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  let word = '', run = '';
  const endWord = () => { if (word.length >= 2 && word.length <= 40) out.push(word); word = ''; };
  const endRun = () => {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    run = '';
  };
  for (const ch of s) {
    if (/[a-z0-9_]/.test(ch)) { endRun(); word += ch; } else if (CJK.test(ch)) { endWord(); run += ch; } else { endWord(); endRun(); }
  }
  endWord(); endRun();
  return out;
}

// 긴 글을 조각으로: 문단·줄 경계를 먼저 쓰고, 그래도 길면 글자 수로 자른다
export function split(text, max = CHUNK_CHARS) {
  const parts = [];
  let cur = '';
  const push = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };
  for (const line of String(text || '').split(/\n/)) {
    if (cur.length + line.length + 1 > max) push();
    if (line.length > max) { for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max)); continue; }
    cur += (cur ? '\n' : '') + line;
  }
  push();
  return parts;
}

const shardOf = (term) => crypto.createHash('md5').update(term).digest().readUInt16BE(0) % SHARDS;
const shardName = (n) => `${n.toString(36).padStart(3, '0')}.idx`;
const segName = (n) => `chunks-${String(n).padStart(6, '0')}.jsonl`;

// 작업 폴더 하나의 기억
export class ProjectMemory {
  constructor(dir) {
    this.dir = dir;
    this.idxDir = path.join(dir, 'idx');
    this.meta = { chunks: 0, indexed: 0, seg: 0, segBytes: 0, chars: 0 };
    this.pending = new Map(); // 색인 파일 번호 → 덧붙일 줄들
    this.pendingChunks = 0;
    this.queue = Promise.resolve();
    this.opened = false;
  }

  async open() {
    if (this.opened) return this;
    await fsp.mkdir(this.idxDir, { recursive: true });
    try { this.meta = { ...this.meta, ...JSON.parse(await fsp.readFile(path.join(this.dir, 'meta.json'), 'utf8')) }; } catch { /* 처음 */ }
    // 위치표가 원문의 기준이다: meta 가 낡았으면(쓰다가 꺼짐) 위치표 크기로 맞춘다
    try {
      const n = Math.floor((await fsp.stat(path.join(this.dir, 'loc.bin'))).size / LOC_REC);
      if (n !== this.meta.chunks) this.meta.chunks = n;
    } catch { this.meta.chunks = 0; }
    this.meta.indexed = Math.min(this.meta.indexed, this.meta.chunks);
    // 다음에 덧붙일 자리도 실제 파일에서 다시 읽는다(낡은 meta 로 계산하면 조각 위치가 어긋난다)
    this.meta.seg = this.meta.chunks ? (await this.#loc(this.meta.chunks - 1)).seg : 0;
    try { this.meta.segBytes = (await fsp.stat(path.join(this.dir, segName(this.meta.seg)))).size; } catch { this.meta.segBytes = 0; }
    this.opened = true;
    if (this.meta.indexed < this.meta.chunks) await this.#reindexFrom(this.meta.indexed);
    return this;
  }

  // 한 번에 하나씩(파일을 덧붙이는 순서가 섞이지 않게)
  #serial(fn) { const p = this.queue.then(fn, fn); this.queue = p.catch(() => {}); return p; }

  // 메시지 하나를 기억에 넣는다. src = { sessionId, messageId, agentId, role, provider, at, title }
  add(text, src = {}) {
    return this.#serial(async () => {
      await this.open();
      const pieces = split(redact(text));
      for (let i = 0; i < pieces.length; i++) await this.#append(pieces[i], { ...src, part: i, parts: pieces.length });
      if (this.pendingChunks >= FLUSH_CHUNKS) await this.#flush();
      return pieces.length;
    });
  }

  async #append(text, src) {
    const g = this.meta.chunks;
    const line = `${JSON.stringify({ g, s: src.sessionId || '', m: src.messageId || '', a: src.agentId || '', r: src.role || '', p: src.provider || '', t: src.at || Date.now(), n: src.title || '', i: src.part || 0, k: src.parts || 1, x: text })}\n`;
    const bytes = Buffer.from(line, 'utf8');
    if (this.meta.segBytes && this.meta.segBytes + bytes.length > SEG_BYTES) { this.meta.seg++; this.meta.segBytes = 0; }
    await fsp.appendFile(path.join(this.dir, segName(this.meta.seg)), bytes);
    const rec = Buffer.alloc(LOC_REC);
    rec.writeUInt32LE(this.meta.seg, 0); rec.writeUInt32LE(this.meta.segBytes, 4); rec.writeUInt32LE(bytes.length, 8); rec.writeDoubleLE(src.at || Date.now(), 12);
    await fsp.appendFile(path.join(this.dir, 'loc.bin'), rec);
    this.meta.segBytes += bytes.length;
    this.meta.chunks++;
    this.meta.chars += text.length;
    this.#post(g, text);
  }

  // 조각의 낱말을 색인 대기열에 올린다
  #post(g, text) {
    const tf = new Map();
    for (const term of tokenize(text)) tf.set(term, (tf.get(term) || 0) + 1);
    for (const [term, n] of tf) {
      const sh = shardOf(term);
      let lines = this.pending.get(sh);
      if (!lines) this.pending.set(sh, lines = []);
      lines.push(`${term}\t${g.toString(36)}:${n}\n`);
    }
    this.pendingChunks++;
  }

  async #flush() {
    if (!this.pendingChunks) return;
    const batch = [...this.pending];
    const upto = this.meta.chunks;
    this.pending = new Map();
    this.pendingChunks = 0;
    for (const [sh, lines] of batch) await fsp.appendFile(path.join(this.idxDir, shardName(sh)), lines.join(''));
    this.meta.indexed = upto;
    await this.#saveMeta();
  }

  async #saveMeta() {
    const tmp = path.join(this.dir, `meta.json.${process.pid}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(this.meta));
    await fsp.rename(tmp, path.join(this.dir, 'meta.json'));
  }

  // 대기 중인 색인을 디스크에 쓴다(끌 때, 테스트에서)
  flush() { return this.#serial(async () => { await this.open(); await this.#flush(); }); }

  async #loc(g) {
    const fh = await fsp.open(path.join(this.dir, 'loc.bin'), 'r');
    try {
      const b = Buffer.alloc(LOC_REC);
      await fh.read(b, 0, LOC_REC, g * LOC_REC);
      return { seg: b.readUInt32LE(0), off: b.readUInt32LE(4), len: b.readUInt32LE(8), at: b.readDoubleLE(12) };
    } finally { await fh.close(); }
  }

  // 조각 원문 읽기(번호로 바로 찾는다)
  async chunk(g) {
    if (g < 0 || g >= this.meta.chunks) return null;
    const { seg, off, len } = await this.#loc(g);
    const fh = await fsp.open(path.join(this.dir, segName(seg)), 'r');
    try {
      const b = Buffer.alloc(len);
      await fh.read(b, 0, len, off);
      const o = JSON.parse(b.toString('utf8'));
      return { g: o.g, sessionId: o.s, messageId: o.m, agentId: o.a, role: o.r, provider: o.p, at: o.t, title: o.n, part: o.i, parts: o.k, text: o.x };
    } finally { await fh.close(); }
  }

  // 색인이 원문보다 뒤처졌을 때(쓰다가 꺼짐) 뒤처진 만큼만 다시 만든다
  async #reindexFrom(from) {
    for (let g = from; g < this.meta.chunks; g++) {
      const c = await this.chunk(g);
      if (c) this.#post(g, c.text);
      if (this.pendingChunks >= FLUSH_CHUNKS * 8) await this.#flush();
    }
    await this.#flush();
  }

  // 색인을 지우고 원문에서 전부 다시 만든다
  rebuild() {
    return this.#serial(async () => {
      await this.open();
      await fsp.rm(this.idxDir, { recursive: true, force: true });
      await fsp.mkdir(this.idxDir, { recursive: true });
      this.pending = new Map(); this.pendingChunks = 0; this.meta.indexed = 0;
      await this.#reindexFrom(0);
    });
  }

  async #postings(term) {
    let buf;
    try { buf = await fsp.readFile(path.join(this.idxDir, shardName(shardOf(term))), 'utf8'); } catch { buf = ''; }
    const out = new Map();
    const take = (text) => {
      const head = `${term}\t`;
      let i = text.startsWith(head) ? 0 : text.indexOf(`\n${head}`);
      while (i !== -1) {
        const start = i + (text[i] === '\n' ? 1 : 0) + head.length;
        const end = text.indexOf('\n', start);
        const [g, n] = text.slice(start, end === -1 ? undefined : end).split(':');
        out.set(parseInt(g, 36), Number(n) || 1);
        i = end === -1 ? -1 : text.indexOf(`\n${head}`, end);
      }
    };
    take(buf);
    const waiting = this.pending.get(shardOf(term));
    if (waiting) take(waiting.join(''));
    return out;
  }

  /**
   * 관련 조각 찾기
   * @param query 요청 글
   * @param opt { budget: 꺼낼 글자 상한, limit: 조각 수 상한, exclude: (조각 정보) => 뺄지, minCover: 요청 낱말 중 맞아야 하는 비중 }
   * @returns { hits: [{ ...조각, score }], chars, terms, scanned }
   */
  async search(query, { budget = 2000, limit = 8, exclude = null, minCover = 0.34 } = {}) {
    await this.open();
    await this.queue;
    const N = this.meta.chunks;
    const terms = [...new Set(tokenize(query))].slice(0, QUERY_TERMS);
    if (!N || !terms.length) return { hits: [], chars: 0, terms: terms.length, scanned: 0 };
    const lists = await Promise.all(terms.map((t) => this.#postings(t)));
    const score = new Map(), cover = new Map(), rare = new Map(), count = new Map();
    const rareMax = Math.max(2, Math.ceil(N * 0.002)); // 기억 전체에서 이만큼 이하로만 나오면 "드문 낱말"
    let mass = 0;
    lists.forEach((post, ti) => {
      // 거의 모든 조각에 나오는 낱말은 구별하는 힘이 없고, 기억에 한 번도 안 나온 낱말이 가장 무겁다.
      // 안 나온 낱말도 요청의 무게에 넣어야 한다: 빼면 "우연히 맞은 흔한 낱말"만으로 관련 있다고 판정한다
      const idf = Math.log(1 + (N - post.size + 0.5) / (post.size + 0.5));
      mass += idf;
      if (!post.size) return;
      // 드문 낱말을 맞혔는지: 이름·식별자 같은 영문·숫자 낱말(3자 이상)은 하나로도 강한 단서, 한글 두 글자 조각은 둘 이상이어야 한다
      const strength = post.size <= rareMax ? (/^[a-z0-9_]{3,}$/.test(terms[ti]) ? 2 : 1) : 0;
      for (const [g, tf] of post) {
        score.set(g, (score.get(g) || 0) + idf * (tf * (K1 + 1)) / (tf + K1));
        cover.set(g, (cover.get(g) || 0) + idf);
        count.set(g, (count.get(g) || 0) + 1);
        if (strength) rare.set(g, (rare.get(g) || 0) + strength);
      }
    });
    // 관련 있다고 보는 조건(하나라도 맞으면):
    //  1) 요청 낱말 전체의 무게를 충분히 맞혔다(minCover)
    //  2) 드문 낱말을 정확히 맞혔다(이름·식별자)
    //  3) 요청 낱말 수의 대부분을 맞혔다(기억 어디에나 나오는 주제는 낱말 무게가 0에 가까워 1번으로는 못 잡는다)
    // 셋 다 아니면 흔한 낱말이 우연히 겹친 것으로 보고 뺀다(없는 내용을 물으면 비운다)
    const need = Math.max(2, Math.ceil(terms.length * 0.6));
    const ranked = [...score].filter(([g]) => cover.get(g) / mass >= minCover || (rare.get(g) || 0) >= 2 || count.get(g) >= need)
      .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const hits = [];
    let chars = 0;
    for (const [g, sc] of ranked) {
      if (hits.length >= limit) break;
      const c = await this.chunk(g);
      if (!c || (exclude && exclude(c))) continue;
      if (chars + c.text.length > budget && hits.length) continue;
      if (c.text.length > budget) c.text = c.text.slice(0, budget);
      hits.push({ ...c, score: Math.round(sc * 1000) / 1000 });
      chars += c.text.length;
      if (chars >= budget) break;
    }
    return { hits, chars, terms: terms.length, scanned: score.size };
  }

  stats() { return { chunks: this.meta.chunks, chars: this.meta.chars, indexed: this.meta.indexed, files: this.meta.seg + (this.meta.chunks ? 1 : 0) }; }

  close() { return this.flush(); }
}

// 작업 폴더 → 기억 폴더 이름(경로를 이름에 그대로 쓰지 않는다)
export function projectKey(cwd) {
  const norm = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return norm ? crypto.createHash('sha256').update(process.platform === 'win32' ? norm.toLowerCase() : norm).digest('hex').slice(0, 16) : 'none';
}

// 프로젝트별 기억을 열어 두고 돌려 쓴다
export class MemoryStore {
  constructor(root) { this.root = root; this.open = new Map(); }

  async of(cwd) {
    const key = projectKey(cwd);
    let m = this.open.get(key);
    if (!m) {
      m = new ProjectMemory(path.join(this.root, key));
      this.open.set(key, m);
      await m.open();
      if (cwd) fsp.writeFile(path.join(this.root, key, 'project.json'), JSON.stringify({ cwd })).catch(() => {});
    }
    return m;
  }

  async close() { await Promise.all([...this.open.values()].map((m) => m.close().catch(() => {}))); this.open.clear(); }
}
