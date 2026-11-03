// HTTP 서버: 정적 파일 + REST API + SSE. 127.0.0.1 전용, Host/Origin 검사, 토큰 필수
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { VERSION, PUBLIC_DIR, HOST, PORT, homeDir, dataDirs, ensureDirs } from './config.js';
import { cleanAvatar, cleanSkin } from './media.js';
import { Store, newId } from './store.js';
import { Bus } from './bus.js';
import { Usage } from './usage.js';
import { Catalog } from './catalog.js';
import { Orchestrator } from './orchestrator.js';
import { ProviderRegistry, PROVIDERS } from './providers/index.js';
import { resolveRoute } from './routing.js';
import { storageReport, cleanup } from './storage.js';
import { listImportable, readTranscript } from './importer.js';
import { ACP_PRESETS } from './providers/acp.js';
import { resolveCommand } from './providers/util.js';
import { tr, bindLang, serverLang } from './i18n.js';
import { Scheduler, cleanSchedule } from './scheduler.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
};
const MASK = '••••••••';
// 끝 4자리만 보여준다(9자 미만인 짧은 값은 끝자리도 숨긴다)
const mask = (k) => (k ? MASK + (String(k).length > 8 ? String(k).slice(-4) : '') : '');
// 비밀값 이름 판별: 이름을 단어로 나눠(GH_TOKEN·apiKey·X-Api-Key, 붙여 쓴 PGPASSWORD 는 한 단어) 단어마다 본다
// - 긴 단어는 붙여 써도 잡는다(PGPASSWORD·ACCESSTOKEN·SECRETKEY·PASSPHRASE·CLIENT_SECRETS)
// - 짧은 단어는 단어가 정확히 맞을 때만(API_KEY·GH_PAT·DB_PASS. AUTHOR·KEYBOARD_LAYOUT·SESSION_DIR 은 일반 값)
// - 토큰 "개수" 설정(MAX_TOKENS·CLAUDE_CODE_MAX_OUTPUT_TOKENS·CONTEXT_TOKENS·X-Max-Tokens·TOKEN_LIMIT)과 TOKENIZER·SECRETARY 는
//   그 단어만 일반 값으로 보고 나머지 단어로 계속 판별한다(TOKENIZER_API_KEY·MAX_TOKENS_SECRET 은 가림)
//   · 복수 TOKENS: 앞 3단어 안에 MAX·MIN 이 있거나(AIDER_MAX_CHAT_HISTORY_TOKENS) 바로 앞에 개수 단어가 이어지면(CONTEXT_TOKENS) 개수 설정.
//     단 앞 3단어에 BOT·API·ACCESS 같은 단어가 있으면 비밀값(MAX_BOT_TOKENS), SESSION·NEW·WINDOW 만으로는 개수로 안 봄(SESSION_TOKENS)
//   · 단수 TOKEN: 이름 전체가 MAX·MIN 과 개수 단어뿐일 때만(MAX_TOKEN·MAX_OUTPUT_TOKEN. MAX_BOT_TOKEN·HBO_MAX_TOKEN 은 비밀값)
// - 짧은 단어 끝의 숫자는 떼고 본다(API_KEY2·PASS1·BEARER2·MAX_TOKENS2). AUTH0 같은 이름은 그대로(AUTH0_DOMAIN 은 일반 값)
// - PIN 은 마지막 단어이거나 PIN_CODE 일 때만(PIN_MEMORY 는 일반 값)
// - AUTH·COOKIE 가 든 이름은 비밀값으로 보되, 이름 끝 단어가 설정을 뜻하면 일반 값
//   (BASIC_AUTH·DOCKER_AUTH_CONFIG·Set-Cookie 는 비밀값, SSH_AUTH_SOCK·AUTH_GITHUB_ID·COOKIE_DOMAIN 은 일반 값)
// - TIKTOKEN(토크나이저 라이브러리) 설정은 일반 값
const SECRET_PARTS = ['password', 'passwd', 'passphrase', 'secret', 'token', 'credential', 'apikey', 'privatekey', 'accesskey', 'authkey'];
const SECRET_WORDS = new Set(['key', 'keys', 'pat', 'pass', 'pwd', 'auth', 'authorization', 'bearer', 'cookie', 'cookies']);
const NUMBERED = new Set(['key', 'keys', 'pat', 'pass', 'pwd', 'pin', 'bearer', 'cookie', 'cookies', 'authorization', 'token', 'tokens']);
const PLAIN_TAIL = new Set(['trust', 'sock', 'socket', 'domain', 'domains', 'name', 'secure', 'samesite', 'httponly', 'path', 'url', 'urls', 'uri', 'host', 'hosts',
  'enabled', 'enable', 'disabled', 'disable', 'active', 'required', 'type', 'method', 'methods', 'provider', 'version', 'mode', 'user', 'username', 'id', 'issuer',
  'email', 'timeout', 'ttl', 'age', 'expiry', 'expires', 'expire', 'duration', 'scope', 'scopes', 'audience', 'realm', 'endpoint', 'callback', 'redirect', 'server',
  'port', 'level', 'strategy', 'flow', 'dir', 'file', 'role', 'roles', 'group', 'groups', 'form', 'dn', 'providers', 'driver', 'default', 'attempts', 'creation',
  'database', 'db', 'hook', 'once', 'logging', 'preflight', 'routes', 'route', 'protect', 'site',
  // 설정을 뜻하는 끝 단어(비밀값일 수 있는 account·request·headers·session·config·ident·salt·hash·json 은 넣지 않는다)
  'login', 'up', 'menu', 'icon', 'label', 'list', 'claim', 'ids', 'organizations', 'whitelist', 'allowlist', 'strict', 'insecure', 'sync', 'pkce',
  'regex', 'format', 'guard', 'model', 'time', 'registration', 'metadata', 'endpoints', 'schedule', 'only', 'partitioned', 'masked', 'persistent',
  'minimal', 'prefix', 'timestamp', 'limit']);
const COUNT_WORDS = new Set(['max', 'min', 'n', 'num', 'new', 'context', 'window', 'session', 'thinking', 'reasoning', 'output', 'input', 'completion', 'prompt', 'response', 'budget', 'total', 'reserved', 'limit', 'map', 'chunk', 'size', 'overlap']);
const WEAK_COUNT = new Set(['new', 'window', 'session']);
const SECRETISH = new Set(['bot', 'api', 'access', 'auth', 'oauth', 'refresh', 'user', 'id', 'client', 'app', 'bearer', 'personal', 'service']);
const COUNT_AFTER = new Set(['limit', 'limits', 'count', 'budget', 'per', 'length']);
const isCountTokens = (ws, i) => {
  const near = ws.slice(Math.max(0, i - 3), i);
  if (near.some((x) => SECRETISH.has(x))) return false;
  if (near.includes('max') || near.includes('min')) return true;
  const run = [];
  for (let j = i - 1; j >= 0 && COUNT_WORDS.has(ws[j]); j--) run.push(ws[j]);
  return run.some((x) => !WEAK_COUNT.has(x));
};
const isSecretName = (name) => {
  const ws = String(name).split(/[_\-.\s]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((w) => {
    const l = w.toLowerCase();
    const bare = l.replace(/\d+$/, '');
    return NUMBERED.has(bare) ? bare : l;
  });
  return ws.some((w, i) => {
    if (/^(?:de)?tokeniz|^tiktoken|^secretar(?:y|ies|iat)$|^(?:max|min)(?:output|input|new|completion|context|thinking)?tokens?$/.test(w)) return false;
    if (w === 'tokens' || w === 'token') {
      const run = []; // 단수 TOKEN 바로 앞에 이어진 개수 단어(최대 3개)
      for (let j = i - 1; j >= 0 && run.length < 3 && COUNT_WORDS.has(ws[j]); j--) run.push(ws[j]);
      const count = w === 'tokens' ? isCountTokens(ws, i) : run.length === i && (run.includes('max') || run.includes('min'));
      if (count || COUNT_AFTER.has(ws[i + 1])) return false;
    }
    if (w === 'pin') return i === ws.length - 1 || ['code', 'number'].includes(ws[i + 1]);
    if (w === 'auth' || w === 'cookie' || w === 'cookies') return i === ws.length - 1 || !PLAIN_TAIL.has(ws.at(-1));
    return SECRET_WORDS.has(w) || SECRET_PARTS.some((p) => w.includes(p));
  });
};
const maskSecrets = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, isSecretName(k) && v ? mask(v) : v]));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// 가린 값을 그대로 다시 보내면 원래 값을 유지한다(이름만 바꿨으면 같은 가림 표시의 원래 값을 찾아 유지).
// - 가린 값은 비밀값 이름으로만 옮길 수 있다(일반 이름으로 옮기면 화면에 그대로 보이게 되므로)
// - 같은 값을 여러 이름에 넣어 둔 경우는 하나로 센다. 찾는 범위는 화면에 가려서 보낸 비밀값 이름뿐
// - 가림 표시에 글자를 덧붙이는 식으로 고치면 어느 값인지 알 수 없어서 저장하지 않고 알린다
const keepSecrets = (nv = {}, ov = {}) => Object.fromEntries(Object.entries(nv || {}).map(([k, v]) => {
  if (typeof v !== 'string' || !v.startsWith(MASK)) return [k, v];
  if (!isSecretName(k)) throw new HttpError(400, tr('가려진 값은 비밀값 이름으로만 옮길 수 있어. {name}에는 새로 입력해줘.', { name: k }));
  if (ov?.[k] != null && mask(ov[k]) === v) return [k, ov[k]];
  const same = [...new Set(Object.entries(ov || {}).filter(([ok, x]) => isSecretName(ok) && mask(x) === v).map(([, x]) => x))];
  if (same.length === 1) return [k, same[0]];
  throw new HttpError(400, tr('가려진 값({name})을 고치려면 지우고 새로 입력해줘.', { name: k }));
}));

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, tr('요청이 너무 커.'))); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 25 * 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, tr('JSON 형식이 아니야.')); }
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function loadToken(home) {
  const f = path.join(home, '.token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* 새로 만듦 */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

const PERMS = new Set(['plan', 'default', 'edit', 'auto', 'full']);
function cleanAgent(a, prev = {}) {
  const x = { ...prev, ...a };
  if (!x.name || !String(x.name).trim()) throw new HttpError(400, tr('에이전트 이름이 필요해.'));
  const routing = x.routing === 'auto' ? 'auto' : 'manual';
  // 자동 라우팅이면 프로바이더는 실행 때 정해지므로 비어 있어도 된다(마지막 값은 표시용)
  if (routing === 'manual' && !PROVIDERS[x.provider]) throw new HttpError(400, tr('모르는 프로바이더: {id}', { id: x.provider }));
  if (x.provider && !PROVIDERS[x.provider]) x.provider = 'claude';
  return {
    id: x.id, name: String(x.name).trim().slice(0, 40), role: String(x.role || '').slice(0, 30), emoji: String(x.emoji || '🤖').slice(0, 8),
    provider: x.provider || 'claude', model: String(x.model || '').slice(0, 120), effort: String(x.effort || '').slice(0, 20),
    permission: PERMS.has(x.permission) ? x.permission : 'default', systemPrompt: String(x.systemPrompt || '').slice(0, 20000),
    skills: Array.isArray(x.skills) ? x.skills.map(String) : [], connectors: Array.isArray(x.connectors) ? x.connectors.map(String) : [],
    routing, routingProfile: ['economy', 'balanced', 'best'].includes(x.routingProfile) ? x.routingProfile : 'balanced',
    light: !!x.light, apiProfile: String(x.apiProfile || ''), avatar: cleanAvatar(x.avatar),
    ...(x.pluginId ? { pluginId: x.pluginId } : {}),
  };
}

function cleanTeam(t) {
  if (!t.name || !String(t.name).trim()) throw new HttpError(400, tr('팀 이름이 필요해.'));
  const stages = (Array.isArray(t.stages) ? t.stages : []).map((s) => ({
    id: s.id || newId('st'), label: String(s.label || tr('단계')).slice(0, 30), agentIds: (s.agentIds || []).map(String).slice(0, 8),
    instruction: String(s.instruction || '').slice(0, 4000), approve: !!s.approve,
  })).filter((s) => s.agentIds.length);
  if (!stages.length) throw new HttpError(400, tr('단계가 최소 1개, 단계마다 에이전트가 최소 1명 필요해.'));
  return { id: t.id, name: String(t.name).trim().slice(0, 40), description: String(t.description || '').slice(0, 300), stages };
}

function openTerminal(command) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/s', '/c', `start "Office Crew Login" cmd /k ${command}`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  }
  if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${command}"`], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
    try { spawn(term, ['-e', `sh -c '${command}; exec sh'`], { detached: true, stdio: 'ignore' }).unref(); return true; } catch { /* 다음 */ }
  }
  return false;
}

// 읽기 스트림 오류(파일이 사라짐 등)로 서버가 죽지 않게
function pipeFile(file, res) {
  const st = fs.createReadStream(file);
  st.on('error', () => { try { res.destroy(); } catch { /* 이미 닫힘 */ } });
  st.pipe(res);
}

function openFolder(dir) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
}

// schedule: 예약 작업 시계(테스트는 끄고 tick 을 직접 부른다)
export function createApp({ home = homeDir(), port = PORT, detect = true, schedule = detect } = {}) {
  const dirs = dataDirs(home);
  ensureDirs(dirs);
  // 지난 실행이 남긴 임시 파일(프롬프트·MCP 설정 등) 청소
  for (const f of fs.readdirSync(dirs.tmp)) fs.rmSync(path.join(dirs.tmp, f), { recursive: true, force: true });
  const store = new Store(dirs);
  // 서버 문구(오류·알림·에이전트 지침)는 설정 언어를 따른다(비면 OS 언어).
  // 초기화 전에 연결해야 첫 실행 기본 데이터(에이전트·팀 이름)도 그 언어로 만들어진다
  bindLang(() => store.settings.lang);
  store.init();
  const bus = new Bus();
  const usage = new Usage(store, bus);
  usage.init();
  const catalog = new Catalog(store, dirs);
  const providers = new ProviderRegistry(store);
  const orch = new Orchestrator({ store, bus, usage, catalog, dirs, providers });
  orch.recover();
  const scheduler = new Scheduler({ store, orch, bus });
  const token = loadToken(home);
  let actualPort = port;

  const publicSettings = () => {
    const s = structuredClone(store.settings);
    s.apiKeys = Object.fromEntries(Object.entries(s.apiKeys || {}).map(([k, v]) => [k, mask(v)]));
    s.apiProfiles = (s.apiProfiles || []).map((p) => ({ ...p, apiKey: mask(p.apiKey) }));
    s.acpAgents = (s.acpAgents || []).map((a) => ({ ...a, env: maskSecrets(a.env) }));
    return s;
  };
  // 커넥터의 환경변수·헤더 중 비밀값처럼 보이는 것은 화면에 가려서 보낸다
  const publicConnector = (c) => (c ? { ...c, env: maskSecrets(c.env), headers: maskSecrets(c.headers) } : c);
  const publicConnectors = () => store.all('connectors').map(publicConnector);

  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

  route('GET', '/api/bootstrap', () => ({
    version: VERSION, home, agents: store.all('agents'), teams: store.all('teams'), sessions: store.listSessions(),
    settings: publicSettings(), providers: providers.list(), usage: usage.snapshot(), skills: catalog.skills(),
    connectors: publicConnectors(), plugins: store.all('plugins'), skins: store.all('skins'),
    active: [...orch.ctx.keys()], cooldown: orch.restingList(), schedules: scheduler.list(),
  }));

  // 프로바이더
  route('GET', '/api/providers', async (req, url) => (url.searchParams.get('refresh') ? providers.refresh() : providers.list()));
  route('POST', '/api/providers/([\\w-]+)/refresh', async (req, url, [id]) => {
    if (!PROVIDERS[id]) throw new HttpError(404, tr('프로바이더 없음'));
    await providers.refresh(id);
    const list = providers.list();
    bus.emit('providers', list);
    return list.find((p) => p.id === id);
  });
  route('GET', '/api/providers/([\\w-]+)/models', async (req, url, [id]) => {
    const p = PROVIDERS[id];
    if (!p) throw new HttpError(404, tr('프로바이더 없음'));
    return providers.models(id, { force: !!url.searchParams.get('refresh'), query: { profile: url.searchParams.get('profile') } });
  });
  route('POST', '/api/providers/([\\w-]+)/login', async (req, url, [id]) => {
    const p = PROVIDERS[id];
    if (!p?.login) throw new HttpError(400, tr('이 프로바이더는 로그인 대신 설정에서 API 키를 넣어줘.'));
    const ok = openTerminal(p.login.command);
    return { ok, command: p.login.command, hint: tr(p.login.hint) };
  });

  // 에이전트
  route('POST', '/api/agents', async (req) => {
    const a = store.upsert('agents', cleanAgent(await readJson(req)), 'agent');
    bus.emit('agents', store.all('agents'));
    return a;
  });
  route('PUT', '/api/agents/([\\w-]+)', async (req, url, [id]) => {
    const prev = store.get('agents', id);
    if (!prev) throw new HttpError(404, tr('에이전트 없음'));
    const a = store.upsert('agents', cleanAgent({ ...(await readJson(req)), id }, prev));
    bus.emit('agents', store.all('agents'));
    return a;
  });
  route('DELETE', '/api/agents/([\\w-]+)', async (req, url, [id]) => {
    store.remove('agents', id);
    for (const t of store.all('teams')) {
      const stages = t.stages.map((s) => ({ ...s, agentIds: s.agentIds.filter((x) => x !== id) })).filter((s) => s.agentIds.length);
      if (stages.length !== t.stages.length || stages.some((s, i) => s.agentIds.length !== t.stages[i].agentIds.length)) store.upsert('teams', { ...t, stages });
    }
    bus.emit('agents', store.all('agents'));
    bus.emit('teams', store.all('teams'));
    return { ok: true };
  });

  // 팀
  route('POST', '/api/teams', async (req) => { const t = store.upsert('teams', cleanTeam(await readJson(req)), 'team'); bus.emit('teams', store.all('teams')); return t; });
  route('PUT', '/api/teams/([\\w-]+)', async (req, url, [id]) => {
    if (!store.get('teams', id)) throw new HttpError(404, tr('팀 없음'));
    const t = store.upsert('teams', cleanTeam({ ...(await readJson(req)), id }));
    bus.emit('teams', store.all('teams'));
    return t;
  });
  route('DELETE', '/api/teams/([\\w-]+)', async (req, url, [id]) => { store.remove('teams', id); bus.emit('teams', store.all('teams')); return { ok: true }; });

  // 예약 작업
  route('GET', '/api/schedules', () => scheduler.list());
  route('POST', '/api/schedules', async (req) => scheduler.save(cleanSchedule({ ...(await readJson(req)), id: undefined }, null, store)));
  route('PUT', '/api/schedules/([\\w-]+)', async (req, url, [id]) => {
    const body = await readJson(req);
    // 본문을 다 받은 뒤에 이전 값을 읽는다(기다리는 사이 실행된 회차 기록을 옛 값으로 덮지 않게)
    const prev = store.get('schedules', id);
    if (!prev) throw new HttpError(404, tr('예약 없음'));
    return scheduler.save(cleanSchedule({ ...body, id }, prev, store));
  });
  route('POST', '/api/schedules/([\\w-]+)/run', async (req, url, [id]) => {
    const s = store.get('schedules', id);
    if (!s) throw new HttpError(404, tr('예약 없음'));
    const r = scheduler.fire(s, { manual: true });
    scheduler.emit();
    return r;
  });
  route('DELETE', '/api/schedules/([\\w-]+)', async (req, url, [id]) => { store.remove('schedules', id); scheduler.emit(); return { ok: true }; });

  // 세션
  route('POST', '/api/sessions', async (req) => {
    const b = await readJson(req);
    // teamId 를 명시(null 포함)하면 그대로, 에이전트만 주면 팀 없이, 아무것도 없으면 기본 팀
    const teamId = 'teamId' in b ? (b.teamId || null) : (b.agentId ? null : (store.settings.defaultTeamId || null));
    if (b.cwd && !fs.existsSync(b.cwd)) throw new HttpError(400, tr('그 폴더가 없어.'));
    const s = store.createSession({ title: b.title, teamId, agentId: b.agentId || null, cwd: b.cwd || '' });
    bus.emit('session', store.sessionMeta(s));
    return s;
  });

  // 다른 곳(Claude Code·Codex CLI)에서 하던 세션 불러오기: 원래 기록은 읽기만 하고, 앱 세션으로 옮겨 같은 대화를 이어간다
  const IMPORT_AGENTS = {
    claude: { id: 'import-claude', name: tr('Claude 이어하기'), emoji: '🔁', avatar: { skin: '#f2c9a6', hair: '#3a2a1e', hairStyle: 'short', outfit: '#d97757', accessory: 'none' } },
    codex: { id: 'import-codex', name: tr('Codex 이어하기'), emoji: '🔁', avatar: { skin: '#e3b38f', hair: '#1d1d24', hairStyle: 'bob', outfit: '#10a37f', accessory: 'none' } },
  };
  const importAgent = (source) => {
    const def = IMPORT_AGENTS[source];
    const have = store.get('agents', def.id);
    if (have) return have;
    // 모델·노력은 비워 두면 그 CLI 기본값(원래 대화가 쓰던 설정)으로 이어간다
    const a = store.upsert('agents', {
      ...def, role: tr('일반'), provider: source, model: '', effort: '', permission: 'edit', light: false, routing: 'manual',
      systemPrompt: tr('다른 곳에서 하던 대화를 이어받았어. 앞 대화의 맥락과 작업 상태를 이어서 진행해.'), skills: [], connectors: [],
    });
    bus.emit('agents', store.all('agents'));
    return a;
  };
  route('GET', '/api/import/list', async (req, url) => listImportable({ query: url.searchParams.get('q') || '' }));
  route('POST', '/api/import', async (req) => {
    const b = await readJson(req);
    let tx;
    try { tx = await readTranscript(b.source, b.id); } catch (e) { throw new HttpError(e.status || 500, tr(e.message)); }
    const agent = importAgent(tx.source);
    const s = store.createSession({ title: tx.title, teamId: null, agentId: agent.id, cwd: tx.cwdExists ? tx.cwd : '' });
    s.messages = tx.messages.map((m) => ({ ...m, id: newId('m'), imported: true, ...(m.role === 'agent' ? { agentId: agent.id, provider: tx.source, model: m.model || tx.model || '' } : {}) }));
    const from = tx.source === 'claude' ? 'Claude Code' : 'Codex CLI';
    const notes = [tr('{from}에서 하던 대화를 불러왔어 (메시지 {n}개).', { from, n: tx.total })];
    if (tx.truncated) notes.push(tr('화면에는 최근 {n}개만 보여. 앞부분 맥락도 이어하기로 그대로 유지돼.', { n: tx.messages.length }));
    if (!tx.cwdExists) notes.push(tr('원래 프로젝트 폴더가 없어서 새 작업 폴더에서 이어가. 이어하기가 안 되면 최근 대화를 넣어서 맥락을 잇게 해.'));
    s.messages.push({ id: newId('m'), role: 'system', text: notes.join(' '), createdAt: Date.now(), status: 'done' });
    s.providerSessions[agent.id] = tx.id;
    s.sessionProvider = { [agent.id]: tx.source };
    s.importedFrom = { source: tx.source, id: tx.id, cwd: tx.cwd, total: tx.total, at: Date.now() };
    store.saveSessionNow(s);
    bus.emit('session', store.sessionMeta(s));
    return { sessionId: s.id, agentId: agent.id, total: tx.total, shown: tx.messages.length, truncated: tx.truncated, cwdExists: tx.cwdExists };
  });
  route('GET', '/api/sessions/([\\w-]+)', async (req, url, [id]) => {
    const s = store.getSession(id);
    if (!s) throw new HttpError(404, tr('세션 없음'));
    return { ...s, live: orch.liveStates(id), cwdResolved: s.cwd || store.settings.defaultCwd || path.join(dirs.workspaces, s.id) };
  });
  route('PATCH', '/api/sessions/([\\w-]+)', async (req, url, [id]) => {
    const s = store.getSession(id);
    if (!s) throw new HttpError(404, tr('세션 없음'));
    const b = await readJson(req);
    if ('cwd' in b && b.cwd && !(fs.existsSync(b.cwd) && fs.statSync(b.cwd).isDirectory())) throw new HttpError(400, tr('그 폴더가 없어.'));
    if ('teamId' in b && b.teamId && !store.get('teams', b.teamId)) throw new HttpError(400, tr('없는 팀이야.'));
    if ('agentId' in b && b.agentId && !store.get('agents', b.agentId)) throw new HttpError(400, tr('없는 에이전트야.'));
    if ('title' in b) b.title = String(b.title || '').slice(0, 120) || s.title;
    for (const k of ['title', 'teamId', 'agentId', 'cwd', 'pinned']) if (k in b) s[k] = b[k];
    store.saveSessionNow(s);
    bus.emit('session', store.sessionMeta(s));
    return store.sessionMeta(s);
  });
  route('DELETE', '/api/sessions/([\\w-]+)', async (req, url, [id]) => {
    if (orch.ctx.has(id)) {
      orch.ctx.get(id).queue.length = 0; // 대기열 메시지가 삭제 뒤에 다시 실행되지 않게
      orch.control(id, { action: 'stop' });
    }
    store.deleteSession(id);
    bus.emit('sessionDeleted', { id });
    return { ok: true };
  });
  route('POST', '/api/sessions/([\\w-]+)/messages', async (req, url, [id]) => {
    const b = await readJson(req);
    const atts = (b.attachments || []).map((aid) => {
      const f = path.join(dirs.uploads, `${String(aid).replace(/[^\w-]/g, '')}.json`);
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
    }).filter(Boolean);
    return orch.send(id, { text: b.text || '', attachments: atts, mention: b.mention || null, mode: b.mode || 'queue' });
  });
  route('POST', '/api/sessions/([\\w-]+)/control', async (req, url, [id]) => orch.control(id, await readJson(req)));
  route('POST', '/api/sessions/([\\w-]+)/open-folder', async (req, url, [id]) => {
    const s = store.getSession(id);
    if (!s) throw new HttpError(404, tr('세션 없음'));
    openFolder(orch.cwdOf(s));
    return { ok: true };
  });
  route('POST', '/api/sessions/([\\w-]+)/clear', async (req, url, [id]) => {
    const s = store.getSession(id);
    if (!s) throw new HttpError(404, tr('세션 없음'));
    if (orch.ctx.has(id)) throw new HttpError(409, tr('작업 중엔 비울 수 없어. 먼저 중지해줘.'));
    s.messages = []; s.runs = []; s.providerSessions = {};
    store.saveSessionNow(s);
    bus.emit('session', store.sessionMeta(s));
    return { ok: true };
  });

  // 업로드(붙여넣기·드래그 이미지/파일)
  route('POST', '/api/uploads', async (req) => {
    const buf = await readBody(req, 30 * 1024 * 1024);
    if (!buf.length) throw new HttpError(400, tr('빈 파일'));
    const name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'file';
    const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    const id = newId('up');
    const ext = (path.extname(name) || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] || '')).toLowerCase();
    const file = path.join(dirs.uploads, id + ext);
    fs.writeFileSync(file, buf);
    const meta = { id, name, mime, size: buf.length, path: file, createdAt: Date.now() };
    fs.writeFileSync(path.join(dirs.uploads, `${id}.json`), JSON.stringify(meta));
    return meta;
  });
  route('GET', '/api/uploads/([\\w-]+)', async (req, url, [id], res) => {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dirs.uploads, `${id}.json`), 'utf8')); } catch { throw new HttpError(404, tr('파일 없음')); }
    // 메타의 경로를 믿지 않고 업로드 폴더 안의 실제 파일만 보낸다
    const file = path.join(dirs.uploads, path.basename(String(meta.path || '')));
    if (!file.startsWith(dirs.uploads + path.sep) || !fs.existsSync(file)) throw new HttpError(404, tr('원본 파일이 없어.'));
    res.writeHead(200, { 'Content-Type': String(meta.mime || 'application/octet-stream'), 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
    pipeFile(file, res);
    return undefined;
  });

  // 설정
  route('GET', '/api/settings', () => publicSettings());
  // 자동 이어받기: 쉬는 중인 AI 목록과 수동 해제(요금제를 올렸거나 한도가 풀렸을 때)
  route('GET', '/api/cooldown', () => orch.restingList());
  // ACP 표준 에이전트 프리셋(이 PC에 명령이 있는지 함께)
  route('GET', '/api/acp/presets', () => ACP_PRESETS.map((p) => ({ ...p, npx: p.command === 'npx', installed: p.command !== 'npx' && !!resolveCommand(p.command) })));
  route('DELETE', '/api/cooldown/([\\w-]+)', async (req, url, [id]) => {
    orch.cooldown.clear(id);
    usage.release(id); // 저장된 한도 기록(거절 상태 포함)으로 계속 피하지 않게
    bus.emit('cooldown', orch.restingList());
    return orch.restingList();
  });
  route('PUT', '/api/settings', async (req) => {
    const b = await readJson(req);
    const cur = store.settings;
    const keep = (nv, ov) => (typeof nv === 'string' && nv.startsWith(MASK) ? ov : nv);
    // 일부 키만 보내도 나머지 키는 그대로 둔다
    if (b.apiKeys) b.apiKeys = { ...(cur.apiKeys || {}), ...Object.fromEntries(Object.entries(b.apiKeys).map(([k, v]) => [k, keep(v, cur.apiKeys?.[k] || '')])) };
    if (b.apiProfiles) b.apiProfiles = b.apiProfiles.map((p) => ({ ...p, id: p.id || newId('api'), apiKey: keep(p.apiKey || '', (cur.apiProfiles || []).find((x) => x.id === p.id)?.apiKey || '') }));
    if ('defaultCwd' in b && b.defaultCwd && !fs.existsSync(b.defaultCwd)) throw new HttpError(400, tr('기본 작업 폴더가 없어.'));
    if ('failoverThreshold' in b) b.failoverThreshold = Math.min(100, Math.max(50, Math.round(Number(b.failoverThreshold) || 95)));
    if ('failover' in b) b.failover = b.failover !== false;
    // ACP 에이전트: 명령은 셸 없이 실행되지만 형식은 엄격히(이름·명령·인자 문자열만)
    if ('acpAgents' in b) {
      const seen = new Set();
      const prev = cur.acpAgents || [];
      b.acpAgents = (Array.isArray(b.acpAgents) ? b.acpAgents : []).slice(0, 30).map((e) => {
        const args = Array.isArray(e?.args) ? e.args.map(String) : String(e?.args || '').split(/\s+/).filter(Boolean);
        const command = String(e?.command || '').trim().slice(0, 200);
        // id 가 비었으면 같은 명령·인자의 기존 항목 id 를 다시 쓴다(저장할 때마다 id 가 바뀌어 에이전트 연결이 끊기지 않게)
        const same = !e?.id && prev.find((x) => x.command === command && JSON.stringify(x.args) === JSON.stringify(args.slice(0, 40)) && !seen.has(x.id));
        let id = same ? same.id : (String(e?.id || e?.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || newId('acp'));
        while (seen.has(id)) id = `${id}-2`;
        seen.add(id);
        const env = e?.env && typeof e.env === 'object' ? Object.fromEntries(Object.entries(e.env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => [k, String(v)])) : {};
        return { id, name: String(e?.name || id).slice(0, 60), command, args: args.slice(0, 40), env: keepSecrets(env, prev.find((x) => x.id === id)?.env) };
      }).filter((e) => e.command && !/[\r\n]/.test(e.command));
    }
    const acpChanged = 'acpAgents' in b && JSON.stringify(b.acpAgents) !== JSON.stringify(cur.acpAgents || []);
    // 인증 방식: 구독 로그인(login) 또는 API 키(apikey). 바뀌면 로그인 상태를 다시 확인한다
    if ('authMode' in b) {
      const m = { ...(cur.authMode || {}), ...(b.authMode || {}) };
      b.authMode = Object.fromEntries(['claude', 'codex'].map((p) => [p, m[p] === 'apikey' ? 'apikey' : 'login']));
    }
    const authChanged = ('authMode' in b && JSON.stringify(b.authMode) !== JSON.stringify(cur.authMode || {}))
      || (b.apiKeys && ['anthropic', 'openai'].some((k) => (b.apiKeys[k] || '') !== (cur.apiKeys?.[k] || '')));
    const langChanged = 'lang' in b && b.lang !== cur.lang;
    store.settings = { ...cur, ...b };
    store.saveSettings();
    bus.emit('settings', publicSettings());
    if (acpChanged) { delete providers.modelCache.acp; providers.refresh('acp').then(() => bus.emit('providers', providers.list())).catch(() => {}); }
    if (authChanged && detect && !langChanged) Promise.all(['claude', 'codex'].map((p) => providers.refresh(p))).then(() => bus.emit('providers', providers.list())).catch(() => {});
    // 언어가 바뀌면 프로바이더 안내·모델 라벨을 새 언어로 다시 만든다
    if (langChanged) {
      providers.modelCache = {};
      bus.emit('providers', providers.list());
      if (detect) providers.refresh().then((list) => bus.emit('providers', list)).catch(() => {});
    }
    return publicSettings();
  });

  // 스킬
  route('GET', '/api/skills', async (req, url) => { if (url.searchParams.get('rescan')) catalog.scanExternalSkills(); return catalog.skills(); });
  route('GET', '/api/skills/(.+)', async (req, url, [id]) => { const s = catalog.skillContent(decodeURIComponent(id)); if (!s) throw new HttpError(404, tr('스킬 없음')); return s; });
  route('POST', '/api/skills', async (req) => { const s = catalog.saveSkill({ ...(await readJson(req)), id: undefined }); bus.emit('skills', catalog.skills()); return s; });
  route('PUT', '/api/skills/([\\w-]+)', async (req, url, [id]) => { if (!store.get('skills', id)) throw new HttpError(404, tr('스킬 없음')); const s = catalog.saveSkill({ ...(await readJson(req)), id }); bus.emit('skills', catalog.skills()); return s; });
  route('DELETE', '/api/skills/([\\w-]+)', async (req, url, [id]) => { catalog.deleteSkill(id); bus.emit('skills', catalog.skills()); return { ok: true }; });

  // 커넥터(MCP)
  route('GET', '/api/connectors/existing', () => catalog.existingConnectors());
  route('POST', '/api/connectors', async (req) => { const c = catalog.saveConnector(await readJson(req)); bus.emit('connectors', publicConnectors()); return publicConnector(c); });
  route('PUT', '/api/connectors/([\\w-]+)', async (req, url, [id]) => {
    const old = store.get('connectors', id);
    if (!old) throw new HttpError(404, tr('커넥터 없음'));
    const b = await readJson(req);
    const c = catalog.saveConnector({ ...b, env: keepSecrets(b.env, old.env), headers: keepSecrets(b.headers, old.headers), id });
    bus.emit('connectors', publicConnectors());
    return publicConnector(c);
  });
  route('DELETE', '/api/connectors/([\\w-]+)', async (req, url, [id]) => {
    store.remove('connectors', id);
    for (const a of store.all('agents')) if ((a.connectors || []).includes(id)) store.upsert('agents', { ...a, connectors: a.connectors.filter((x) => x !== id) });
    bus.emit('connectors', publicConnectors());
    bus.emit('agents', store.all('agents'));
    return { ok: true };
  });

  // 플러그인
  route('POST', '/api/plugins/import', async (req) => {
    const body = await readJson(req);
    let p;
    // 가져오는 에이전트·팀도 직접 만든 것과 같은 검증을 거친다(길이 제한·권한 값·프로바이더)
    try {
      if (body && body.format === 'office-crew-plugin') {
        body.agents = (body.agents || []).map((a) => ({ ...cleanAgent(a), id: a.id }));
        body.teams = (body.teams || []).map((t) => ({ ...t, name: String(t.name || tr('팀')).slice(0, 40), description: String(t.description || '').slice(0, 300) }));
      }
      p = catalog.importPlugin(body);
    } catch (e) { throw new HttpError(400, e.message); }
    for (const ev of ['agents', 'teams', 'connectors', 'plugins', 'skins']) bus.emit(ev, ev === 'connectors' ? publicConnectors() : store.all(ev));
    bus.emit('skills', catalog.skills());
    return p;
  });
  route('POST', '/api/plugins/export', async (req) => catalog.exportPlugin(await readJson(req)));
  route('GET', '/api/plugins/native', () => catalog.nativePlugins());
  route('DELETE', '/api/plugins/([\\w-]+)', async (req, url, [id]) => {
    catalog.removePlugin(id);
    for (const ev of ['agents', 'teams', 'connectors', 'plugins', 'skins']) bus.emit(ev, ev === 'connectors' ? publicConnectors() : store.all(ev));
    bus.emit('skills', catalog.skills());
    return { ok: true };
  });

  // 스킨(커스텀 배경 이미지)
  route('POST', '/api/skins', async (req) => { const s = store.upsert('skins', cleanSkin(await readJson(req)), 'skin'); bus.emit('skins', store.all('skins')); return s; });
  route('DELETE', '/api/skins/([\\w-]+)', async (req, url, [id]) => { store.remove('skins', id); bus.emit('skins', store.all('skins')); return { ok: true }; });

  // ── 라우팅 ──
  // 드롭다운용 카탈로그: 로그인된 AI 의 모델 목록(등급·지원 노력 포함)
  route('GET', '/api/routing/catalog', async (req, url) => providers.catalog({ force: !!url.searchParams.get('refresh') }));
  // 역할·프로필별 자동 라우팅 미리보기
  route('POST', '/api/routing/preview', async (req) => {
    const b = await readJson(req);
    const cat = await providers.catalog();
    return (b.items || []).map((it) => ({ key: it.key, route: orch.previewRoute({ role: it.role, routingProfile: it.profile }, cat) }));
  });
  // 한 번에 적용: mode 'auto' = 자동 라우팅으로 전환(+프로필), 'fill' = 지금 자동값을 직접 설정으로 고정
  route('POST', '/api/routing/apply', async (req) => {
    const b = await readJson(req);
    const profile = ['economy', 'balanced', 'best'].includes(b.profile) ? b.profile : 'balanced';
    const ids = Array.isArray(b.agentIds) && b.agentIds.length ? b.agentIds : store.all('agents').filter((a) => a.provider !== 'mock').map((a) => a.id);
    const cat = b.mode === 'fill' ? await providers.catalog() : null;
    const changed = [];
    for (const id of ids) {
      const a = store.get('agents', id);
      if (!a || a.provider === 'mock') continue;
      if (b.mode === 'fill') {
        const r = resolveRoute({ ...a, routingProfile: profile }, cat);
        if (!r) continue;
        store.upsert('agents', { ...a, routing: 'manual', routingProfile: profile, provider: r.provider, model: r.model, effort: r.effort });
      } else store.upsert('agents', { ...a, routing: 'auto', routingProfile: profile });
      changed.push(id);
    }
    bus.emit('agents', store.all('agents'));
    return { changed };
  });

  // ── 저장공간(용량 보기·확인 후 정리) ──
  route('GET', '/api/storage', () => storageReport(dirs, store));
  route('POST', '/api/storage/cleanup', async (req) => {
    const b = await readJson(req);
    let r;
    try { r = await cleanup(dirs, store, b); } catch (e) { throw new HttpError(400, e.message); }
    if (b.target === 'sessions-older') bus.emit('sessionsReset', {});
    return r;
  });

  route('GET', '/api/usage', () => usage.snapshot());
  route('GET', '/api/live', () => Object.fromEntries([...orch.ctx.keys()].map((id) => [id, { run: orch.ctx.get(id).run, states: orch.liveStates(id) }])));

  const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      // DNS 리바인딩·외부 사이트 요청 차단
      if (!allowedHosts().has(String(req.headers.host || ''))) throw new HttpError(403, tr('Host 거부'));
      const origin = req.headers.origin;
      if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, tr('Origin 거부'));

      if (url.pathname.startsWith('/api/')) {
        const t = req.headers['x-office-token'] || url.searchParams.get('token');
        if (t !== token) throw new HttpError(401, tr('토큰이 맞지 않아. 페이지를 새로고침해줘.'));
        if (url.pathname === '/api/events') { bus.attach(res); bus.emit('hello', { version: VERSION }); return; }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          const out = await r.fn(req, url, m.slice(1), res);
          if (out !== undefined) send(res, 200, out);
          return;
        }
        throw new HttpError(404, tr('없는 API'));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, tr('허용 안 됨'));
      serveStatic(url.pathname, res);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('[오류]', e);
      if (!res.headersSent) send(res, status, { error: e.message || String(e) });
      else try { res.end(); } catch { /* 이미 닫힘 */ }
    }
  });

  function serveStatic(pathname, res) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, tr('잘못된 경로')); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    const inside = path.relative(PUBLIC_DIR, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new HttpError(403, tr('경로 거부'));
    let stat;
    try { stat = fs.statSync(file); } catch { throw new HttpError(404, tr('파일 없음')); }
    if (!stat.isFile()) throw new HttpError(404, tr('파일 없음'));
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";
      const html = fs.readFileSync(file, 'utf8').replace('<!--TOKEN-->', `<meta name="office-token" content="${token}">`)
        // 앱 JS가 뜨기 전 첫 화면(제목·준비 중)도 설정 언어로
        .replace('<html lang="ko">', `<html lang="${serverLang() === 'zh' ? 'zh-CN' : serverLang()}">`)
        .replace('<title>오피스 크루</title>', `<title>${tr('오피스 크루')}</title>`)
        .replace('오피스 크루 준비 중…', tr('오피스 크루 준비 중…'));
      res.writeHead(200, headers);
      res.end(html);
      return;
    }
    res.writeHead(200, headers);
    pipeFile(file, res);
  }

  return {
    server, store, bus, orch, providers, catalog, usage, token, dirs, scheduler,
    listen(p = port, host = HOST) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, host, () => {
          actualPort = server.address().port;
          if (detect) {
            providers.refresh().then((list) => bus.emit('providers', list)).catch(() => {});
            providers.startAutoRefresh((list) => bus.emit('providers', list));
          }
          if (schedule) scheduler.start();
          resolve(actualPort);
        });
      });
    },
    async close() {
      scheduler.stop();
      orch.stopAll();
      providers.stop();
      usage.close();
      store.close();
      bus.close();
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    },
  };
}
