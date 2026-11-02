// 자동 이어받기: 한 AI의 사용량·한도가 바닥나면 작업을 멈추지 않고, 여유 있는 다른 AI가 이어받게 한다
import path from 'node:path';
import { resolveRoute, roleKind } from './routing.js';

// 각 CLI·API 가 한도 초과 때 내는 문구(실측·공식 오류 코드 기준). 일반 오류와 구분해야 엉뚱하게 넘기지 않는다
const QUOTA_RE = new RegExp([
  'rate[ _-]?limit', 'usage[ _-]?limit', 'quota', 'resource[_ ]exhausted', 'insufficient[_ ]quota',
  'too many requests', '(?:http|status|error|code)[ :]*429\\b', 'credit balance', 'out of credits',
  'exceeded your (?:current )?(?:quota|usage|plan|limit)', 'hit your (?:usage )?limit',
  'weekly limit', '5-hour limit', 'session limit', '사용량 한도', '사용 한도', '요청 한도', '한도(?:를)? ?초과', '한도에 (?:도달|걸)',
  '用量上限', '配额', '使用上限', '利用上限', 'レート制限',
].join('|'), 'i');
// 문맥 길이·출력 토큰·파일 크기 같은 "크기 한도"는 사용량 한도가 아니다(다른 AI로 넘길 이유가 아님).
const NOT_QUOTA_RE = /context (?:window|length)|max[_ ]?tokens|maximum context|output tokens?|too long|file size|upload|크기 한도|길이 한도|파일 크기|출력 토큰|(?<!사)용량 한도|업로드|컨텍스트|上下文|コンテキスト/i;
// 단, 분당 한도("8,000 output tokens per minute", TPM·OTPM, "분당 출력 토큰 한도")는 크기 한도 말이 섞여 있어도 사용량 한도다
// ("/min" 은 경로(/home/min/)와 헷갈리지 않게 tokens·requests 같은 단위가 앞에 있을 때만)
const PER_MINUTE_RE = /per[- ](?:1 |one )?min(?:ute)?\b|(?:tokens?|requests?|reqs?)\s*\/\s*min(?:ute)?\b|\b[io]?tpm\b|분당|每分钟|毎分|1分あたり/i;

export function isQuotaError(text = '') {
  const s = String(text);
  return QUOTA_RE.test(s) && (PER_MINUTE_RE.test(s) || !NOT_QUOTA_RE.test(s));
}

const HALF_HOUR = 30 * 60 * 1000;

/**
 * 한도 기록으로 이 AI를 언제까지 피할지(ms, 피할 필요 없으면 0). 화면 표시와 실행 전 회피가 같은 값을 쓴다.
 * - "다 찬 창"(사용률이 기준 이상, 거절 상태에선 사용률을 모르는 창도)이 아직 안 풀렸으면 그중 가장 늦은 초기화 시각까지
 * - 초기화 시각을 모르는 다 찬 창이 있거나, 거절 상태인데 어느 창인지 모르면 관측 뒤 30분까지
 * - 사용자가 "지금 다시 쓰기"로 푼 뒤의 옛 기록은 무시
 */
export function avoidUntil(limit, threshold = 95) {
  if (!limit?.windows) return 0;
  if (limit.releasedAt && limit.releasedAt >= (limit.observedAt || 0)) return 0;
  const now = Date.now();
  const live = Object.values(limit.windows).filter((w) => !w.resetsAt || w.resetsAt * 1000 > now);
  const rejected = limit.status === 'rejected';
  const full = live.filter((w) => (typeof w.pct === 'number' ? w.pct >= threshold : rejected));
  const timed = full.filter((w) => w.resetsAt).map((w) => w.resetsAt * 1000);
  if (timed.length) return Math.max(...timed);
  if (full.length || rejected) {
    const until = (limit.observedAt ?? now) + HALF_HOUR;
    return until > now ? until : 0;
  }
  return 0;
}

// 한도 창(%)이 기준 이상이거나 거절 상태라서 지금은 피해야 하는지
export function nearLimit(limit, threshold = 95) {
  return avoidUntil(limit, threshold) > Date.now();
}

// 한도에 걸린 AI는 초기화 시각(모르면 30분)까지 쉬게 둔다
export class Cooldown {
  constructor() { this.map = new Map(); }

  mark(provider, { until, reason = '' } = {}) {
    const t = until && until > Date.now() ? until : Date.now() + 30 * 60 * 1000;
    this.map.set(provider, { until: t, reason: String(reason).slice(0, 200), at: Date.now() });
    return this.map.get(provider);
  }

  active(provider) {
    const c = this.map.get(provider);
    if (!c) return null;
    if (c.until <= Date.now()) { this.map.delete(provider); return null; }
    return c;
  }

  clear(provider) { this.map.delete(provider); }

  list() {
    const out = {};
    for (const [p] of this.map) { const c = this.active(p); if (c) out[p] = c; }
    return out;
  }
}

// 쉬는 시간이 끝나는 시각(ms): 다 찬 창이 있으면 그중 가장 늦은 초기화 시각, 없으면 0(= 쉬는 시간 기본 30분).
// (다 차지 않은 창의 초기화 시각을 쓰면, 옛 기록에 주간 창만 남았을 때 며칠씩 쉬게 된다)
export function resetTime(limit, threshold = 95) {
  const ws = Object.values(limit?.windows || {}).filter((w) => w.resetsAt && w.resetsAt * 1000 > Date.now());
  if (!ws.length) return 0;
  const full = ws.filter((w) => typeof w.pct === 'number' && w.pct >= threshold);
  return full.length ? Math.max(...full.map((w) => w.resetsAt * 1000)) : 0;
}

// 오류 문구에 적힌 초기화 시각(ms). 사용량 창 정보가 없을 때 쓴다. 못 찾거나 이상하면 0(= 쉬는 시간 기본 30분).
// 읽는 모양: "limit reached|1730480400"(옛 Claude, 초), "Retry-After: 120", "try again in 2 days 3 hours"·"retry in 41.5s"·"1h30m",
// "reset at 2026-11-03T00:00:00Z", "try again at Nov 4th, 2026 5:30 PM"·"resets Nov 9, 10am", "try again at 3:07 PM"·"resets 3pm"(지난 시각이면 다음 날)
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const UNIT_MS = { d: 86400e3, h: 3600e3, m: 60e3, s: 1e3 };
const DUR = '(\\d+(?:\\.\\d+)?)\\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])';
const WHEN = '\\b(?:try again|retry|resets?|available again)\\s+';
const IN_RE = new RegExp(`${WHEN}(?:in|after)\\s+((?:${DUR}[\\s,]*(?:and\\s+)?)+)`, 'i');
const ISO_RE = new RegExp(`${WHEN}(?:at\\s+|on\\s+)?(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)`, 'i');
const DATE_RE = new RegExp(`${WHEN}(?:at\\s+|on\\s+)?([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?,?\\s+(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\b`, 'i');
const AT_RE = new RegExp(`${WHEN}(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(?:([ap])\\.?m\\b)?`, 'i');
const MAX_WAIT = 8 * 86400e3; // 주간 한도보다 먼 시각은 잘못 읽은 걸로 본다

// 12시간제(am/pm)·24시간제 시를 0~23으로. 말이 안 되면 null
function hour24(h, min, ap) {
  let hour = Number(h);
  if (ap) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (/p/i.test(ap) ? 12 : 0);
  }
  return hour > 23 || Number(min) > 59 ? null : hour;
}

export function resetFromText(text = '', now = Date.now()) {
  const s = String(text);
  const ok = (t) => (Number.isFinite(t) && t > now && t - now <= MAX_WAIT ? Math.round(t) : 0);
  let m = s.match(/limit reached\|(\d{9,11})\b/i);
  if (m) return ok(Number(m[1]) * 1000);
  m = s.match(/retry[-_ ]after(?:[-_ ]seconds)?["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i);
  if (m) return ok(now + Number(m[1]) * 1000);
  m = s.match(IN_RE);
  if (m) return ok(now + [...m[1].matchAll(new RegExp(DUR, 'gi'))].reduce((sum, [, n, u]) => sum + Number(n) * UNIT_MS[u[0].toLowerCase()], 0));
  m = s.match(ISO_RE);
  if (m) return ok(Date.parse(m[1].replace(' ', 'T')));
  m = s.match(DATE_RE);
  const mon = m ? MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) : -1;
  if (mon >= 0) {
    const hour = hour24(m[4], m[5] || 0, m[6]);
    if (hour === null) return 0;
    const year = m[3] ? Number(m[3]) : new Date(now).getFullYear();
    const at = (y) => new Date(y, mon, Number(m[2]), hour, Number(m[5] || 0)).getTime();
    return ok(!m[3] && at(year) <= now ? at(year + 1) : at(year)); // 연도가 없고 지났으면 내년(12월 → 1월)
  }
  m = s.match(AT_RE);
  if (m && (m[2] !== undefined || m[3])) { // 시만 있고 분·am/pm 이 없으면("retry 3 times") 시각이 아니다
    const hour = hour24(m[1], m[2] || 0, m[3]);
    if (hour === null) return 0;
    const d = new Date(now);
    const at = (plus) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus, hour, Number(m[2] || 0)).getTime();
    return ok(at(0) > now ? at(0) : at(1)); // 이미 지난 시각이면 다음 날
  }
  return 0;
}

// 쓸 수 없는 AI(쉬는 중·한도 임박)를 빼고 라우팅 카탈로그를 만든다
export function availableCatalog(catalog, { cooldown, limits = {}, threshold = 95, exclude = [] } = {}) {
  const blocked = new Set(exclude);
  for (const p of catalog.providers || []) {
    if (cooldown?.active(p.id) || nearLimit(limits[p.id], threshold)) blocked.add(p.id);
  }
  return {
    ...catalog,
    providers: (catalog.providers || []).map((p) => (blocked.has(p.id) ? { ...p, loggedIn: false, blocked: true } : p)),
    blocked: [...blocked],
  };
}

/**
 * 이어받을 AI 고르기: 같은 역할·프로필 기준으로, 막힌 AI를 빼고 라우팅 엔진에 다시 묻는다
 * @returns { provider, model, effort, modelLabel, reason } | null
 */
export function pickFallback(agent, catalog, opts = {}) {
  const cat = availableCatalog(catalog, opts);
  const r = resolveRoute({ role: agent.role, routingProfile: agent.routingProfile || 'balanced' }, cat);
  if (!r || r.provider === agent.provider) return null;
  return r;
}

// ── 이어받기 인계서 ──
// 앞 담당의 말이 아니라 서버가 본 도구 기록에서 사실만 뽑는다: 쓴 도구(횟수·실패·안 끝남), 손댄 파일, 마지막 명령
const EDIT_TOOL = /writ|edit|replace|patch|create|delete|remove|move|rename|notebook|편집|쓰기|수정|삭제|编辑|写入|修改|删除|編集|書き込み|削除/i;
const READ_TOOL = /read|view|search|find|list|읽기|读取|読み/i;
const PATH_KEYS = ['file_path', 'notebook_path', 'absolute_path', 'filePath', 'target_file', 'path'];
const MAX_TOOLS = 10, MAX_FILES = 20, MAX_CMDS = 3;
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// 명령에 섞인 비밀값만 가린다: Bearer·Basic 값, 주소 속 계정, 비밀 이름 뒤 값(--password x, API_KEY=x), 잘 알려진 키 모양
const SECRET_KEY = '[\\w-]{0,40}(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\\w-]{0,40}';
const SECRET_FLAG = new RegExp(`((?:^|[\\s"'])-{1,2}${SECRET_KEY}\\s+)("[^"]*"|'[^']*'|[^\\s'"]+)`, 'gi');
const SECRET_PAIR = new RegExp(`((?:${SECRET_KEY}|auth|authorization)\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s'"]+)`, 'gi');
function redactCommand(cmd) {
  return cmd.slice(0, 2000) // 아주 긴 명령(heredoc 등)에서 정규식이 느려지지 않게. 보여주는 건 앞 160자뿐
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 ***')
    .replace(/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@')
    .replace(SECRET_FLAG, '$1***')
    .replace(SECRET_PAIR, '$1***')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,})/g, '***');
}

// 작업 폴더 안 파일은 상대 경로로(짧고, 이어받는 AI도 같은 폴더에서 일한다)
function relPath(cwd, p) {
  const s = oneLine(p);
  if (!cwd || !path.isAbsolute(s)) return s;
  const r = path.relative(cwd, s);
  return r && r.split(path.sep)[0] !== '..' && !path.isAbsolute(r) ? r.split(path.sep).join('/') : s;
}

/**
 * 메시지의 도구 블록에서 인계 사실을 뽑는다(AI마다 input 모양이 달라 흔한 모양을 다 본다:
 * Claude·Gemini file_path, Codex changes "종류 경로", ACP path, 명령은 command 문자열·배열)
 * @returns {{ tools: {name,n,fail,open}[], files: string[], cmds: {cmd,fail,open}[] } | null} 도구를 안 썼으면 null
 */
export function handoffFacts(blocks = [], cwd = '') {
  const tools = new Map(), files = [], cmds = [];
  for (const b of blocks || []) {
    if (b?.kind !== 'tool') continue;
    const name = oneLine(b.name || '?').slice(0, 60);
    const t = tools.get(name) || { name, n: 0, fail: 0, open: 0 };
    t.n++;
    if (b.status === 'error') t.fail++;
    else if (b.status === 'running') t.open++;
    tools.set(name, t);
    const inp = b.input && typeof b.input === 'object' ? b.input : {};
    const touched = Array.isArray(inp.changes) ? inp.changes.map((c) => (typeof c === 'string' ? c.replace(/^\S*\s+/, '') : c?.path))
      : EDIT_TOOL.test(name) && !READ_TOOL.test(name) ? [PATH_KEYS.map((k) => inp[k]).find((v) => typeof v === 'string' && v.trim())] : [];
    for (const f of touched) {
      if (typeof f !== 'string' || !f.trim()) continue;
      const r = relPath(cwd, f);
      if (!files.includes(r)) files.push(r);
    }
    const c = Array.isArray(inp.command) ? inp.command.join(' ') : inp.command;
    if (typeof c === 'string' && c.trim()) cmds.push({ cmd: redactCommand(oneLine(c)).slice(0, 160), fail: b.status === 'error', open: b.status === 'running' });
  }
  return tools.size ? { tools: [...tools.values()].sort((a, b) => b.n - a.n), files, cmds: cmds.slice(-MAX_CMDS) } : null;
}

function handoffCard(facts, tr) {
  const more = (list, max) => (list.length > max ? [...list.slice(0, max), tr('외 {n}개', { n: list.length - max })] : list);
  const used = facts.tools.map((t) => {
    const why = [t.fail && tr('실패 {n}', { n: t.fail }), t.open && tr('안 끝남 {n}', { n: t.open })].filter(Boolean);
    return `${tr('{name} {n}번', { name: t.name, n: t.n })}${why.length ? ` (${why.join(', ')})` : ''}`;
  });
  const lines = [tr('[인계서 — 앞 담당의 말이 아니라 서버가 기록한 사실]'), `- ${tr('쓴 도구: {list}', { list: more(used, MAX_TOOLS).join(', ') })}`];
  if (facts.files.length) lines.push(`- ${tr('손댄 파일: {list}', { list: more(facts.files, MAX_FILES).join(', ') })}`);
  if (facts.cmds.length) lines.push(`- ${tr('마지막 명령:')}`, ...facts.cmds.map((c) => `  · ${c.cmd}${c.fail ? ` (${tr('실패')})` : c.open ? ` (${tr('안 끝남')})` : ''}`));
  lines.push(`- ${tr('먼저 할 일: 위 파일과 작업 폴더의 지금 상태부터 확인해. 일부는 이미 반영됐을 수 있으니 한 일을 되풀이하지 말고 남은 부분만 이어서 해.')}`);
  return lines.join('\n');
}

// 이어받는 AI에게 줄 지시: 원래 요청 + (도구를 썼으면) 인계서 + 지금까지 쓴 내용
export function continuationPrompt(prompt, partial, fromLabel, tr = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v?.[k] ?? ''), facts = null) {
  const head = tr('[이어받기] {from}이(가) 사용량 한도에 걸려 중단됐어. 아래 원래 요청을 네가 이어서 끝까지 완성해.', { from: fromLabel });
  const card = facts?.tools?.length ? `\n\n${handoffCard(facts, tr)}` : '';
  const done = partial?.trim() ? `\n\n${tr('[앞 담당이 지금까지 쓴 내용 — 중복 없이 이어서 써]')}\n${partial.slice(-12000)}` : '';
  return `${head}\n\n${prompt}${card}${done}`;
}

export { roleKind };
