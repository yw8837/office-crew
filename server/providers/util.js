// CLI 실행 공통 도구: 셸 없이 실제 실행 파일을 찾아 띄우고, 줄 단위로 읽고, 프로세스 트리를 끈다
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tr } from '../i18n.js';

const isWin = process.platform === 'win32';
const cache = new Map();

// 이름 → { file, prefixArgs, shell } (못 찾으면 null)
export function resolveCommand(name) {
  if (cache.has(name)) return cache.get(name);
  const found = /[\\/]/.test(name) ? resolvePath(name) : (isWin ? resolveWin(name) : resolvePosix(name));
  if (found) cache.set(name, found); // 못 찾은 건 저장하지 않는다(나중에 설치하면 바로 잡히게)
  return found;
}

// 경로로 준 명령(절대·상대)
function resolvePath(p) {
  const f = path.resolve(p);
  if (!isWin) {
    try { fs.accessSync(f, fs.constants.X_OK); return { file: f, prefixArgs: [], shell: false }; } catch { return null; }
  }
  const cands = path.extname(f) ? [f] : ['.exe', '.cmd', '.bat'].map((e) => f + e);
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    const ext = path.extname(c).toLowerCase();
    if (ext === '.exe' || ext === '.com') return { file: c, prefixArgs: [], shell: false };
    if (ext === '.cmd' || ext === '.bat') return winWrapper(c, path.dirname(c));
  }
  return null;
}
export function clearResolveCache() { cache.clear(); }

function pathDirs() {
  return (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
}

function resolvePosix(name) {
  for (const d of pathDirs()) {
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); return { file: f, prefixArgs: [], shell: false }; } catch { /* 다음 */ }
  }
  return null;
}

function resolveWin(name) {
  const exts = ['.exe', '.cmd', '.bat'];
  for (const d of pathDirs()) {
    for (const ext of exts) {
      const f = path.join(d, name + ext);
      if (!fs.existsSync(f)) continue;
      if (ext === '.exe') return { file: f, prefixArgs: [], shell: false };
      return winWrapper(f, d);
    }
  }
  return null;
}

// npm 래퍼(.cmd)를 열어 실제 대상(js 스크립트 또는 exe)을 찾는다 → 셸을 안 거쳐서 인자 주입 위험이 없다
// (래퍼 앞부분의 "%dp0%\node.exe" 같은 조건부 경로는 없을 수 있으니 실제로 있는 대상만 고른다)
function winWrapper(f, d) {
  try {
    const txt = fs.readFileSync(f, 'utf8');
    const found = [...txt.matchAll(/"%~?dp0%?\\([^"]+?\.(exe|js|cjs|mjs))"/gi)]
      .map((m) => ({ target: path.join(d, m[1]), ext: m[2].toLowerCase() }))
      .filter((x) => !/\\node\.exe$/i.test(x.target) && fs.existsSync(x.target));
    const script = found.find((x) => x.ext !== 'exe');
    const exe = found.find((x) => x.ext === 'exe');
    if (script) return { file: process.execPath, prefixArgs: [script.target], shell: false };
    if (exe) return { file: exe.target, prefixArgs: [], shell: false };
  } catch { /* 읽기 실패 시 아래로 */ }
  return { file: f, prefixArgs: [], shell: true };
}

// 셸을 써야만 할 때 인자 하나를 안전하게 만든다(허용 문자 외에는 거부)
function safeShellArg(a) {
  if (!/^[\w.:=/\\@,+-]*$/.test(a)) throw new Error(tr('셸 실행에 안전하지 않은 인자: {arg}', { arg: a.slice(0, 40) }));
  return a;
}

export function spawnCli(name, args, { cwd, env, unset = [], stdin = 'pipe' } = {}) {
  const r = resolveCommand(name);
  if (!r) {
    const err = new Error(tr('{name} 명령을 찾을 수 없어. 설치했는지 확인해줘.', { name }));
    err.code = 'ENOENT';
    throw err;
  }
  const finalArgs = [...r.prefixArgs, ...args];
  const opts = {
    // 뺄 변수와 새로 넣을 변수의 기존 값(대소문자 다른 것 포함)을 먼저 지우고 넣는다
    cwd, env: { ...withoutKeys({ ...process.env }, [...unset, ...Object.keys(env || {})]), ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: [stdin, 'pipe', 'pipe'], windowsHide: true, shell: r.shell,
    // 리눅스·맥: 프로세스 그룹으로 띄워서 중지할 때 손자 프로세스(MCP 서버 등)까지 한 번에 끈다
    detached: !isWin,
  };
  // 셸로 실행할 땐 실행 파일 경로를 항상 따옴표로 감싼다(공백·& ·괄호·^ 가 든 경로).
  // 따옴표 안에서도 해석되는 " 와 %(환경변수 펼침)가 든 경로는 거부한다
  if (r.shell && /["%]/.test(r.file)) throw new Error(tr('셸 실행에 안전하지 않은 인자: {arg}', { arg: r.file.slice(0, 40) }));
  const child = spawn(r.shell ? `"${r.file}"` : r.file, r.shell ? finalArgs.map(safeShellArg) : finalArgs, opts);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // CLI 가 먼저 끝난 뒤 stdin 에 쓰면 EPIPE/EOF 오류가 난다 → 처리 안 하면 서버 전체가 죽음
  child.stdin?.on('error', () => {});
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  return child;
}

// 표준출력을 줄 단위로 넘겨준다
export function onLines(stream, fn) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) fn(line);
    }
  });
  stream.on('end', () => { if (buf.trim()) fn(buf.trim()); buf = ''; });
}

export function parseJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export function killTree(child) {
  if (!child?.pid) return;
  try {
    // 부모 CLI 가 이미 끝났어도 남은 하위 프로세스가 있을 수 있어 트리 전체를 끈다
    if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  } catch { /* 이미 종료 */ }
}

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

export function runQuick(name, args, timeoutMs = 15000, { env, unset } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnCli(name, args, { stdin: 'ignore', env, unset }); } catch (e) { resolve({ ok: false, out: '', err: e.message, code: -1 }); return; }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { killTree(child); resolve({ ok: false, out, err: err || tr('시간 초과'), code: -2 }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out, err: e.message, code: -1 }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out: stripAnsi(out), err: stripAnsi(err), code }); });
  });
}

export function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
}

// 실행 핸들 기본형: done 프로미스와 stop
export function makeHandle() {
  let resolve, reject;
  const done = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { done, resolve, reject };
}

// 모델 이름·설명으로 등급 추정: fast(빠름·저렴) / top(최상) / balanced(그 외)
export function guessTier(text = '') {
  const s = String(text).toLowerCase();
  if (/frontier|most demanding|opus|fable|argon|ultra|\bpro\b|-pro|405b|max\b|astra/.test(s)) return 'top';
  if (/fast|affordable|flash|lite|mini|haiku|luna|nano|small|8b|7b|3b/.test(s)) return 'fast';
  return 'balanced';
}

// 도구 이름 → 사무실 상태(애니메이션) 분류
export function toolCategory(name = '') {
  const n = name.toLowerCase();
  if (/search|web|fetch|browse|browser|url|http|mcp|검색|웹|搜索|网页|検索|ウェブ/.test(n)) return 'searching';
  if (/read|view|grep|glob|\bls\b|list|find|open_file|\bcat\b|notebookread|읽기|열기|자료|读取|查看|资料|読み|閲覧|資料/.test(n)) return 'reading';
  if (/bash|shell|command|exec|\brun\b|run_|powershell|terminal|\bgit\b|npm|명령|실행|터미널|命令|运行|执行|终端|コマンド|実行|ターミナル/.test(n)) return 'running';
  return 'tool';
}

// 윈도우는 환경변수 이름의 대소문자를 구분하지 않으므로 대소문자 무시하고 지운다
function withoutKeys(env, keys) {
  if (!keys.length) return env;
  const drop = new Set(keys.map((k) => k.toUpperCase()));
  for (const k of Object.keys(env)) if (drop.has(k.toUpperCase())) delete env[k];
  return env;
}

// 공식 인증 방식: 'login'(구독 로그인, 기본) 또는 'apikey'(사용한 만큼 API 과금)
// -p·exec 모드에선 환경변수 키가 구독보다 항상 우선이라(공식 문서), 구독 모드에선 그 변수를 빼서 뜻밖의 API 과금을 막는다
const AUTH_ENV = { claude: 'ANTHROPIC_API_KEY', codex: 'CODEX_API_KEY' };
const AUTH_KEY = { claude: 'anthropic', codex: 'openai' };
// 구독 모드에서 빼는 변수: 키 변수 + Claude 의 게이트웨이 토큰(이것도 구독보다 우선한다)
const LOGIN_UNSET = { claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], codex: ['CODEX_API_KEY'] };
export function authEnv(settings, provider) {
  const name = AUTH_ENV[provider];
  const mode = settings?.authMode?.[provider] === 'apikey' ? 'apikey' : 'login';
  if (!name) return { mode, env: {}, unset: [], hasKey: false };
  if (mode === 'login') return { mode, env: {}, unset: LOGIN_UNSET[provider], hasKey: false };
  // 앱에 키를 넣었으면 그 키로(Claude 는 게이트웨이 토큰이 키보다 우선하므로 뺀다)
  const stored = String(settings?.apiKeys?.[AUTH_KEY[provider]] || '').trim();
  if (stored) return { mode, env: { [name]: stored }, unset: provider === 'claude' ? ['ANTHROPIC_AUTH_TOKEN'] : [], hasKey: true };
  // 앱에 키가 없으면 PC 환경변수(키·게이트웨이 토큰)를 손대지 않고 그대로 쓴다
  const envKey = process.env[name] || (provider === 'claude' ? process.env.ANTHROPIC_AUTH_TOKEN : process.env.OPENAI_API_KEY) || '';
  if (provider === 'codex' && !process.env[name] && envKey) return { mode, env: { [name]: envKey }, unset: [], hasKey: true };
  return { mode, env: {}, unset: [], hasKey: !!envKey };
}
