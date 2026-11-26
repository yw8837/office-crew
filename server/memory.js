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
// 반복 실패 줄(결정 0030, failures.json): 줄 수 상한(넘으면 마지막으로 본 때가 오래된 것부터 버린다. 줄 길이 상한과 합쳐 파일 크기 상한),
// 한 줄의 글자 상한, 한 줄에 적어 두는 목표 id 수 상한(오래된 것부터 버린다)
export const FAIL_KEEP = 100;
export const FAIL_LINE_MAX = 160;
export const FAIL_GOALS = 10;

// 글에 섞인 흔한 토큰 모양은 저장 전에 가린다(모든 비밀을 잡지는 못한다). 반복 실패 줄과 실행 기록 내보내기도 이 함수로 가린다(결정 0030)
export const redact = (s) => String(s).replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_\w{8,}|github_pat_\w{8,}|xox[abprs]-[\w-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[\w-]{10,}\.[\w.-]+)\b/g, '•••')
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

// 찾을 때만 쓰는 낱말 고르기(저장·색인은 tokenize 그대로).
// 질문에는 조사·어미·물음말 같은 꾸밈말이 섞인다("포트가 몇 번이었지"). 기억이 작을 땐 이런 말이 기억에 한 번도 안 나와
// 가장 무거운 낱말로 계산되고, 정작 핵심 낱말을 다 맞힌 조각이 관련 없다고 밀려난다. 그래서 질문 쪽에서 걸러 낸다.
const JOSA1 = new Set('가이은는을를에의로도와과만야'.split(''));
const JOSA2 = new Set(['에서', '으로', '에게', '까지', '부터', '이다', '이야', '이고', '이랑', '하고', '처럼', '보다', '한테', '라고', '이라']);
const STOP = new Set(['이었', '었지', '였지', '했지', '인지', '는지', '어떻', '떻게', '하는', '하고', '해서', '해줘', '알려', '려줘', '뭐였', '무엇', '이야', '거야', '그리', '리고',
  '지만', '니다', '습니', '합니', '있다', '있어', '없어', '없다', '이다', '입니', '에서', '으로', '한다', '했다', '된다', '됐다', '같은', '같이', '대해', '대한', '어디', '언제', '누가', '얼마',
  '몇', '뭐', '왜', '좀', '그', '이', '저', '것', '수', '때', '번이', '뭐야', '뭐지', '줘요', '세요', '주세', '어요', '아요', '는데', '은데', '인데', '라고', '다고', '냐고',
  'the', 'is', 'are', 'was', 'were', 'what', 'when', 'where', 'who', 'how', 'why', 'which', 'do', 'does', 'did', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'it', 'this', 'that',
  'with', 'about', 'me', 'my', 'we', 'our', 'you', 'please', 'tell', 'can', 'could', 'be', 'an', 'at', 'as', 'by', 'from', 'has', 'have', 'had', 'again']);
export function queryTerms(text) {
  // 어절 끝의 조사를 떼고 나눈다: "포트가" → 포트, "서버에서" → 서버
  const trimmed = String(text || '').replace(/[぀-ヿ㐀-鿿가-힣]+/g, (run) => {
    if (run.length >= 4 && JOSA2.has(run.slice(-2))) return run.slice(0, -2);
    if (run.length >= 3 && JOSA1.has(run.slice(-1))) return run.slice(0, -1);
    return run;
  });
  return [...new Set(tokenize(trimmed).filter((w) => !STOP.has(w)))];
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
    // 검색에서 뺀 메시지 id(사용자가 완주 보고를 기억에서 뺐을 때, 결정 0025). 원문 조각은 지우지 않고 찾을 때만 건너뛴다(hidden.json)
    this.hidden = new Set();
  }

  // 여는 일은 한 번만 돈다: 여는 중에 또 부르면(처음 쓰는 기억에 요청 둘이 동시에 오면) 같은 열기를 기다린다.
  // 두 열기가 겹치면 늦게 끝나는 쪽이 그사이 덧붙인 조각의 meta(조각 수·다음 자리)를 파일 크기로 덮어써 위치표가 어긋난다
  open() {
    if (this.opened) return Promise.resolve(this);
    this.opening ||= this.#open().finally(() => { this.opening = null; });
    return this.opening;
  }

  async #open() {
    await fsp.mkdir(this.idxDir, { recursive: true });
    try { this.meta = { ...this.meta, ...JSON.parse(await fsp.readFile(path.join(this.dir, 'meta.json'), 'utf8')) }; } catch { /* 처음 */ }
    // 위치표가 원문의 기준이다: meta 가 낡았으면(쓰다가 꺼짐) 위치표 크기로 맞춘다
    try {
      const n = Math.floor((await fsp.stat(path.join(this.dir, 'loc.bin'))).size / LOC_REC);
      if (n !== this.meta.chunks) this.meta.chunks = n;
    } catch { this.meta.chunks = 0; }
    this.meta.indexed = Math.min(this.meta.indexed, this.meta.chunks);
    await this.#readHidden();
    // 다음에 덧붙일 자리도 실제 파일에서 다시 읽는다(낡은 meta 로 계산하면 조각 위치가 어긋난다)
    this.meta.seg = this.meta.chunks ? (await this.#loc(this.meta.chunks - 1)).seg : 0;
    try { this.meta.segBytes = (await fsp.stat(path.join(this.dir, segName(this.meta.seg)))).size; } catch { this.meta.segBytes = 0; }
    this.opened = true;
    if (this.meta.indexed < this.meta.chunks) await this.#reindexFrom(this.meta.indexed);
    return this;
  }

  // 검색에서 뺀 메시지 id 읽기(hidden.json). 없으면 뺀 것 없음. 깨졌으면(JSON 이 아니거나 목록이 아님) 덮어쓰지 않게 hidden.json.bad 로 옮겨 두고
  // 빈 목록으로 새로 시작하며 hiddenBad 를 세운다(기억 화면과 넣기·빼기 응답이 알린다. 전에 뺀 보고가 검색에 다시 나올 수 있다)
  async #readHidden() {
    const file = path.join(this.dir, 'hidden.json');
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') this.hiddenBad = true; return; }
    let list = null;
    try { list = JSON.parse(raw); } catch { /* 깨짐 */ }
    if (Array.isArray(list)) { this.hidden = new Set(list.filter((x) => typeof x === 'string')); return; }
    this.hiddenBad = true;
    const bad = path.join(this.dir, 'hidden.json.bad');
    let to = bad;
    try { await fsp.access(bad); to = path.join(this.dir, `hidden.json.${Date.now()}.bad`); } catch { /* 처음 깨짐 */ }
    try { await fsp.rename(file, to); } catch { await fsp.copyFile(file, to).catch(() => {}); } // 옮기지 못하면 사본이라도 남긴다(다음 쓰기가 원래 파일을 덮어쓴다)
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

  // 메시지 하나의 조각을 검색에서 빼거나(on) 다시 넣는다(off). 원문·색인은 그대로 두고 hidden.json 에 id 만 적는다(결정 0025)
  hide(messageId, on = true) {
    return this.#serial(async () => {
      await this.open();
      if (on) this.hidden.add(String(messageId)); else this.hidden.delete(String(messageId));
      const tmp = path.join(this.dir, `hidden.json.${process.pid}.tmp`);
      await fsp.writeFile(tmp, JSON.stringify([...this.hidden]));
      await fsp.rename(tmp, path.join(this.dir, 'hidden.json'));
    });
  }

  // ── 반복 실패 줄(결정 0030): failures.json ──
  // { version: 1, items: [{ key(첫 줄을 정리한 열쇠), line(보여 줄 줄), tool?(도구 이름), n(센 횟수), goals:[목표 id](FAIL_GOALS 개까지), first, last, local?(내 PC 모델 답에서만 나온 줄) }] }
  // 깨졌으면(JSON 이 아니거나 모양이 틀림) 덮어쓰지 않게 failures.json.bad 로 옮기고(있으면 시각 붙은 이름) 빈 목록으로 새로 시작하며 failsBad 를 세운다(hidden.json 과 같은 방식)
  // 읽지 못했으면(파일 없음이 아닌 오류: 다른 프로그램이 쥐고 있는 등) null: 빈 목록을 붙잡지 않고 다음에 다시 읽으며, 그동안은 덮어쓰지 않는다
  async #readFails() {
    if (this.fails) return this.fails;
    const file = path.join(this.dir, 'failures.json');
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return (this.fails = []);
      return null;
    }
    let data = null;
    try { data = JSON.parse(raw); } catch { /* 깨짐 */ }
    if (data && typeof data === 'object' && Array.isArray(data.items)) {
      return (this.fails = data.items.filter((x) => x && typeof x.key === 'string' && x.key && typeof x.line === 'string').map((x) => ({
        key: x.key.slice(0, 400), line: [...x.line].slice(0, FAIL_LINE_MAX).join(''), ...(x.tool ? { tool: String(x.tool).slice(0, 60) } : {}), n: Math.max(1, Math.round(Number(x.n)) || 1),
        goals: (Array.isArray(x.goals) ? x.goals.filter((g) => typeof g === 'string') : []).slice(-FAIL_GOALS), first: Number(x.first) || 0, last: Number(x.last) || 0, ...(x.local === true ? { local: true } : {}),
      })));
    }
    this.failsBad = true;
    const bad = path.join(this.dir, 'failures.json.bad');
    let to = bad;
    try { await fsp.access(bad); to = path.join(this.dir, `failures.json.${Date.now()}.bad`); } catch { /* 처음 깨짐 */ }
    try { await fsp.rename(file, to); } catch { await fsp.copyFile(file, to).catch(() => {}); }
    return (this.fails = []);
  }

  async #writeFails() {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `failures.json.${process.pid}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, items: this.fails }));
    await fsp.rename(tmp, path.join(this.dir, 'failures.json'));
  }

  #failsView() {
    if (!this.fails) return { items: [], unread: true };
    return { items: this.fails.map((x) => ({ ...x, goals: [...x.goals] })), ...(this.failsBad ? { bad: true } : {}) };
  }

  // 반복 실패 줄 목록 → { items, bad?(깨져서 .bad 로 옮김), unread?(읽지 못함. 빈 목록이지만 파일은 그대로) }
  failures() { return this.#serial(async () => { await this.#readFails(); return this.#failsView(); }); }

  // 한 목표(missionId)의 답에서 나온 실패 줄들을 센다. list: [{ key, line, tool? }](같은 열쇠가 여러 번이면 그만큼 센다).
  // local: 내 PC 모델 답에서 나온 줄(결정 0007: 클라우드 AI 프롬프트에 넣지 않는다). 같은 열쇠가 클라우드 AI 답에서도 나오면 그 줄로 바꾸고 표시를 뗀다
  addFailures(list = [], missionId = '', { local = false } = {}) {
    return this.#serial(async () => {
      const items = await this.#readFails();
      if (!items) return 0; // 읽지 못한 파일은 덮어쓰지 않는다(이번 줄은 세지 못한다)
      const now = Date.now();
      for (const f of list) {
        if (!f?.key || !f.line) continue;
        let x = items.find((y) => y.key === f.key);
        if (!x) { x = { key: f.key, line: f.line, ...(f.tool ? { tool: f.tool } : {}), n: 0, goals: [], first: now, last: now, ...(local ? { local: true } : {}) }; items.push(x); }
        else if (x.local && !local) { x.line = f.line; delete x.local; }
        x.n++;
        x.last = now;
        if (missionId && !x.goals.includes(missionId)) { x.goals.push(missionId); if (x.goals.length > FAIL_GOALS) x.goals.splice(0, x.goals.length - FAIL_GOALS); }
      }
      // 넘으면 목표 수가 적은 줄부터, 같으면 마지막으로 본 때가 오래된 줄부터 버린다(여러 목표에서 되풀이된 줄을 지킨다)
      if (items.length > FAIL_KEEP) { items.sort((a, b) => a.goals.length - b.goals.length || a.last - b.last); items.splice(0, items.length - FAIL_KEEP); }
      await this.#writeFails();
      return items.length;
    });
  }

  // 사용자가 기억 화면에서 지운다: key 가 있으면 그 줄만, 없으면 전부 → { items, bad? }
  dropFailures(key = null) {
    return this.#serial(async () => {
      const items = await this.#readFails();
      if (!items) return this.#failsView(); // 읽지 못하면 지우지도 않는다(화면이 다시 해 보라고 알린다)
      if (key == null) items.length = 0;
      else { const k = items.findIndex((x) => x.key === key); if (k >= 0) items.splice(k, 1); }
      await this.#writeFails();
      return this.#failsView();
    });
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
      if (c) { this.#post(g, c.text); this.meta.chars += c.text.length; }
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
      this.pending = new Map(); this.pendingChunks = 0; this.meta.indexed = 0; this.meta.chars = 0;
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
    const terms = queryTerms(query).slice(0, QUERY_TERMS);
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
      if (!c || this.hidden.has(c.messageId) || (exclude && exclude(c))) continue;
      if (chars + c.text.length > budget && hits.length) continue;
      if (c.text.length > budget) c.text = c.text.slice(0, budget);
      hits.push({ ...c, score: Math.round(sc * 1000) / 1000 });
      chars += c.text.length;
      if (chars >= budget) break;
    }
    return { hits, chars, terms: terms.length, scanned: score.size };
  }

  // 조각·글자 수는 디스크에 쌓인 전부(검색에서 뺀 보고의 조각도 들어 있다). hidden: 검색에서 뺀 메시지(보고) 수, hiddenBad: 뺀 목록 파일이 깨져서 새로 시작함
  stats() { return { chunks: this.meta.chunks, chars: this.meta.chars, indexed: this.meta.indexed, files: this.meta.seg + (this.meta.chunks ? 1 : 0), hidden: this.hidden.size, ...(this.hiddenBad ? { hiddenBad: true } : {}) }; }

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

  // 폴더 이름(키)으로 열기. 화면에서 고른 기억을 볼 때 쓴다. 키 모양이 아니면 열지 않는다(경로를 넘겨받지 않는다)
  async byKey(key) {
    if (!/^(?:[0-9a-f]{16}|none)$/.test(String(key))) return null;
    let m = this.open.get(key);
    if (!m) {
      try { await fsp.access(path.join(this.root, key, 'loc.bin')); } catch { return null; }
      m = new ProjectMemory(path.join(this.root, key));
      this.open.set(key, m);
      await m.open();
    }
    return m;
  }

  // 쌓인 기억 목록: [{ key, cwd, chunks, chars }] (cwd 가 빈 것은 작업 폴더를 안 정한 세션들의 기억)
  async list() {
    let names;
    try { names = await fsp.readdir(this.root); } catch { return []; }
    const out = [];
    for (const key of names) {
      const m = await this.byKey(key);
      if (!m || !m.stats().chunks) continue;
      let cwd = '';
      try { cwd = JSON.parse(await fsp.readFile(path.join(this.root, key, 'project.json'), 'utf8')).cwd || ''; } catch { /* 폴더 없는 기억 */ }
      out.push({ key, cwd, ...m.stats() });
    }
    return out.sort((a, b) => b.chars - a.chars);
  }

  async close() { await Promise.all([...this.open.values()].map((m) => m.close().catch(() => {}))); this.open.clear(); }
}
