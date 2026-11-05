// OpenAI Codex CLI 어댑터: codex exec --json (ChatGPT 구독 로그인). 한도는 로컬 rollout 기록에서 읽는다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCli, onLines, parseJsonLine, killTree, makeHandle, runQuick, guessTier, authEnv } from './util.js';
import { tr } from '../i18n.js';

// 기본 계정은 ~/.codex(또는 CODEX_HOME). 추가 계정은 앱 데이터 폴더 아래 계정마다 따로 둔 폴더를 CODEX_HOME 으로 넘긴다
export const defaultCodexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

const FALLBACK_MODELS = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
];

const LIGHT_OFF = ['plugins', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'multi_agent', 'goals', 'skill_search', 'tool_suggest', 'remote_plugin'];

function sandbox(p) {
  if (p === 'full') return null;
  return p === 'edit' || p === 'auto' ? 'workspace-write' : 'read-only';
}

// 최신 rollout 파일들에서 rate_limits 를 찾는다(최근 날짜 폴더부터)
export function readCodexLimits(threadId, home = defaultCodexHome(), provider = 'codex') {
  const base = path.join(home, 'sessions');
  const files = [];
  try {
    const years = fs.readdirSync(base).filter((x) => /^\d{4}$/.test(x)).sort().reverse();
    outer: for (const y of years) {
      for (const m of fs.readdirSync(path.join(base, y)).sort().reverse()) {
        for (const d of fs.readdirSync(path.join(base, y, m)).sort().reverse()) {
          const dir = path.join(base, y, m, d);
          for (const f of fs.readdirSync(dir)) if (f.startsWith('rollout-')) files.push(path.join(dir, f));
          if (files.length >= 12) break outer;
        }
      }
    }
  } catch { return null; }
  const target = threadId ? files.find((f) => f.includes(threadId)) : null;
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const ordered = target ? [target] : files.map((f) => [f, mtime(f)]).sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 4);
  for (const f of ordered) {
    let text;
    try {
      const st = fs.statSync(f);
      const fd = fs.openSync(f, 'r');
      const len = Math.min(st.size, 2_000_000);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      const ev = parseJsonLine(lines[i]);
      const rl = ev?.payload?.rate_limits;
      if (!rl) continue;
      const windows = {};
      for (const k of ['primary', 'secondary']) {
        const w = rl[k];
        if (w) windows[w.window_minutes >= 10000 ? 'seven_day' : w.window_minutes <= 300 ? 'five_hour' : k] = { pct: Math.round(w.used_percent), resetsAt: w.resets_at, windowMinutes: w.window_minutes };
      }
      return { provider, windows, plan: rl.plan_type || '', observedAt: Date.parse(ev.timestamp) || Date.now() };
    }
  }
  return null;
}

function tomlStr(s) { return JSON.stringify(String(s)); }

// GPT-6.1-Sol → GPT-6.1 Sol (Codex 앱의 모델 고르기와 같은 표기)
export function codexName(name = '') { return String(name).replace(/^(GPT-[\d.]+)-(?=[A-Za-z])/, '$1 '); }

// 계정 하나 = Codex 프로바이더 하나(id 는 기본 'codex', 추가 계정은 'codex-<계정id>'). 한도·쉬는 시간·라우팅이 계정마다 따로 간다
export function makeCodex({ id = 'codex', name = '', home = null } = {}) {
  const codexHome = () => home || defaultCodexHome();
  const homeEnv = home ? { CODEX_HOME: home } : {};
  return {
  id, base: 'codex', account: name, home, label: name ? `ChatGPT · Codex (${name})` : 'ChatGPT · Codex',
  get sub() { return name ? tr('Codex CLI · 추가 ChatGPT 계정') : tr('Codex CLI · ChatGPT 구독 로그인'); }, kind: 'cli', color: '#10a37f',
  // 모델마다 실제 단계는 models_cache.json 에서 읽고, 이건 목록이 없을 때 쓰는 기본값(Codex 캐시와 같은 단계)
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  caps: { images: true, steer: false, resume: true, tools: true, connectors: true, permissions: true },
  login: { command: 'codex login', env: home ? homeEnv : null, get hint() { return name ? tr('브라우저가 열리면 "{name}"으로 쓸 ChatGPT 계정으로 로그인해줘(다른 계정이면 먼저 로그아웃).', { name }) : tr('브라우저가 열리면 ChatGPT 계정으로 로그인해줘.'); } },

  async detect(settings) {
    const auth = authEnv(settings, 'codex');
    const v = await runQuick('codex', ['--version']);
    if (v.code === -1) return { installed: false, note: tr('Codex CLI 미설치') };
    if (auth.mode === 'apikey' && name) return { installed: true, version: v.out.trim().split(/\s+/).pop(), loggedIn: false, authMode: 'apikey', account: '', note: tr('추가 계정은 구독 로그인에서만 써. API 키 모드는 기본 Codex 에서 써줘.') };
    if (auth.mode === 'apikey') return { installed: true, version: v.out.trim().split(/\s+/).pop(), loggedIn: auth.hasKey, authMode: 'apikey', account: tr('API 키 · 사용한 만큼 과금'), note: auth.hasKey ? '' : tr('API 키를 입력해줘 (설정 → API 키)') };
    const s = await runQuick('codex', ['login', 'status'], 15000, { env: homeEnv, unset: auth.unset });
    const txt = `${s.out}\n${s.err}`;
    const loggedIn = /logged in/i.test(txt) && !/not logged in/i.test(txt);
    return { installed: true, version: v.out.trim().split(/\s+/).pop(), loggedIn, authMode: 'login', account: loggedIn ? txt.trim().split('\n').pop() : '', note: loggedIn ? '' : tr('로그인 필요') };
  },

  // Codex 가 스스로 갱신하는 models_cache.json 을 매번 읽어서, 새 모델·지원 노력 단계가 바로 반영된다
  async models() {
    const out = [];
    let configured = '';
    let configuredEffort = '';
    try {
      const cfg = fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8');
      configured = cfg.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || '';
      configuredEffort = cfg.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] || '';
    } catch { /* 설정 없음 */ }
    try {
      // 추가 계정이 아직 한 번도 안 돌아 목록 캐시가 없으면 기본 계정의 목록을 쓴다
      const own = path.join(codexHome(), 'models_cache.json');
      const cache = JSON.parse(fs.readFileSync(fs.existsSync(own) ? own : path.join(defaultCodexHome(), 'models_cache.json'), 'utf8'));
      const list = [...(cache.models || [])].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
      for (const m of list) {
        const id = m.slug || m.id;
        if (!id || out.some((x) => x.id === id)) continue;
        const desc = m.description || '';
        out.push({
          id, label: `${codexName(m.display_name || id)}${id === configured ? ` (${tr('내 기본')})` : ''}`, description: desc,
          tier: guessTier(`${id} ${desc}`), efforts: (m.supported_reasoning_levels || []).map((x) => x.effort),
          defaultEffort: id === configured && configuredEffort ? configuredEffort : (m.default_reasoning_level || ''),
          recommendedEffort: m.default_reasoning_level || '', mine: id === configured,
          hidden: m.visibility === 'hide' && id !== configured,
          // 이전 세대는 Codex 처럼 목록엔 보이지만, 자동 라우팅은 고르지 않는다
          older: /older|previous/i.test(desc) && id !== configured,
        });
      }
    } catch { /* 캐시 없음 */ }
    if (configured && !out.some((x) => x.id === configured)) out.unshift({ id: configured, label: `${codexName(configured)} (${tr('내 기본')})`, tier: guessTier(configured), mine: true, defaultEffort: configuredEffort });
    for (const m of FALLBACK_MODELS) if (!out.some((x) => x.id === m.id)) out.push({ ...m, tier: guessTier(m.id), legacy: true });
    return out;
  },

  run(opts, emit) {
    const { agent, prompt, system, images = [], cwd, resumeId, connectors = [] } = opts;
    const args = resumeId ? ['exec', 'resume', resumeId] : ['exec'];
    args.push('--json', '--skip-git-repo-check');
    if (agent.model) args.push('-m', agent.model);
    if (agent.effort) args.push('-c', `model_reasoning_effort=${tomlStr(agent.effort)}`);
    const sb = sandbox(agent.permission);
    if (sb) args.push('-c', `sandbox_mode=${tomlStr(sb)}`);
    else args.push('--dangerously-bypass-approvals-and-sandbox');
    // 읽기 전용 에이전트는 훅을 돌리지 않는다(읽기만 시켰는데 그 저장소의 명령이 도는 걸 막는다. 사용자 훅도 함께 꺼진다).
    // --disable 은 이름을 모르는 옛 Codex 에서 실패할 수 있어 설정 값으로 넘긴다
    if (sb === 'read-only') args.push('-c', 'features.hooks=false');
    // 가벼운 모드: 설정(로그인·모델 경로)은 유지하고, 매 실행마다 큰 설명을 붙이는 무거운 기능만 끈다
    // (--ignore-user-config 는 사용자 전용 model_provider 까지 빠져 모델 오류가 나는 것을 실측으로 확인)
    if (agent.light) for (const f of LIGHT_OFF) args.push('--disable', f);
    for (const c of connectors) {
      const key = `mcp_servers.${c.key}`;
      if (c.type === 'http') args.push('-c', `${key}.url=${tomlStr(c.url)}`);
      else {
        args.push('-c', `${key}.command=${tomlStr(c.command)}`);
        args.push('-c', `${key}.args=${JSON.stringify(c.args || [])}`);
        if (c.env && Object.keys(c.env).length) {
          const table = Object.entries(c.env).map(([k, v]) => `${JSON.stringify(k)}=${tomlStr(v)}`).join(',');
          args.push('-c', `${key}.env={${table}}`);
        }
      }
    }
    for (const img of images) args.push('-i', img);
    args.push('-'); // 프롬프트는 stdin 으로(명령줄 길이 제한·특수문자 회피)

    const h = makeHandle();
    const auth = authEnv(opts.settings, 'codex');
    // 하루 예산: 한도는 실행이 끝나야 읽히니, 시작 전 값을 먼저 읽어 이번 실행 사용량도 오늘 쓴 양에 들어가게 한다
    if (opts.settings?.dailyBudget) {
      const lim = readCodexLimits(null, codexHome(), id);
      if (lim) emit({ type: 'limits', ...lim });
    }
    const child = spawnCli('codex', args, { cwd, env: { ...auth.env, ...homeEnv }, unset: auth.unset });
    // 이어하기(resume)면 이전 턴에 이미 지침을 줬으므로 다시 붙이지 않는다(토큰 절약)
    const fullPrompt = system && !resumeId ? `<${tr('역할 지침')}>\n${system}\n</${tr('역할 지침')}>\n\n${prompt}` : prompt;
    child.stdin.end(fullPrompt);

    let text = '', threadId = resumeId || null, errorMsg = null, stderr = '', stopped = false;
    const emitted = new Map();

    const item = (it, phase) => {
      if (!it) return;
      const id = it.id;
      switch (it.type) {
        case 'agent_message': {
          const t = it.text || '';
          const prev = emitted.get(id) ?? -1;
          if (prev === -1 && text && !text.endsWith('\n')) { text += '\n\n'; emit({ type: 'text', text: '\n\n' }); }
          const from = Math.max(prev, 0);
          if (t.length > from) { const d = t.slice(from); text += d; emit({ type: 'text', text: d }); }
          emitted.set(id, t.length);
          break;
        }
        case 'reasoning':
          if (phase === 'item.completed' && it.text) emit({ type: 'thinking', text: `${it.text}\n` });
          break;
        case 'command_execution':
          emit({ type: 'tool', id, name: tr('명령 실행'), input: { command: it.command }, status: it.status === 'failed' ? 'error' : phase === 'item.completed' ? 'done' : 'running', output: (it.aggregated_output || '').slice(-4000) });
          break;
        case 'file_change':
          emit({ type: 'tool', id, name: tr('파일 편집'), input: { changes: (it.changes || []).map((c) => `${c.kind || ''} ${c.path}`) }, status: phase === 'item.completed' ? (it.status === 'failed' ? 'error' : 'done') : 'running' });
          break;
        case 'mcp_tool_call':
          emit({ type: 'tool', id, name: `mcp:${it.server}.${it.tool}`, input: it.arguments, status: it.status === 'failed' ? 'error' : phase === 'item.completed' ? 'done' : 'running', output: it.result ? JSON.stringify(it.result).slice(0, 4000) : (it.error?.message || '') });
          break;
        case 'web_search':
          emit({ type: 'tool', id, name: tr('웹 검색'), input: { query: it.query }, status: phase === 'item.completed' ? 'done' : 'running' });
          break;
        case 'todo_list':
          emit({ type: 'tool', id, name: tr('계획(todo)'), input: { items: (it.items || []).map((x) => `${x.completed ? '✓' : '·'} ${x.text}`) }, status: phase === 'item.completed' ? 'done' : 'running' });
          break;
        case 'error':
          if (phase === 'item.completed') emit({ type: 'notice', text: it.message, quiet: /skipping MCP|metadata|shortened|hook/i.test(it.message || '') });
          break;
        default: break;
      }
    };

    onLines(child.stdout, (line) => {
      const ev = parseJsonLine(line);
      if (!ev) return;
      switch (ev.type) {
        case 'thread.started': threadId = ev.thread_id; emit({ type: 'session', id: ev.thread_id }); break;
        case 'item.started': case 'item.updated': case 'item.completed': item(ev.item, ev.type); break;
        case 'turn.completed': {
          const u = ev.usage || {};
          emit({ type: 'usage', input: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)), output: (u.output_tokens || 0), cacheRead: u.cached_input_tokens || 0, cacheWrite: u.cache_write_input_tokens || 0, cost: 0, reasoning: u.reasoning_output_tokens || 0 });
          break;
        }
        case 'turn.failed': errorMsg = ev.error?.message || tr('턴 실패'); break;
        case 'error': errorMsg = ev.message || tr('오류'); break;
        default: break;
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { errorMsg = e.message; });
    child.on('close', (code) => {
      try {
        const lim = readCodexLimits(threadId, codexHome(), id);
        if (lim) emit({ type: 'limits', ...lim });
      } catch { /* 한도 기록을 못 읽어도 결과는 돌려준다 */ }
      const tail = stderr.split('\n').filter((l) => l.trim() && !/Reading additional input|rmcp::|WARN/.test(l)).slice(-3).join(' ');
      const err = stopped ? null : (errorMsg || (code !== 0 ? (tail || tr('종료 코드 {code}', { code })) : null));
      h.resolve({ text, providerSessionId: threadId, error: err, stopped });
    });
    return { done: h.done, stop: () => { stopped = true; killTree(child); } };
  },
  };
}

export default makeCodex();
