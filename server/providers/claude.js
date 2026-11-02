// Claude Code CLI 어댑터: claude -p 스트림 JSON 양방향(작업 중 지시 추가 가능)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnCli, onLines, parseJsonLine, killTree, makeHandle, mimeOf, runQuick, authEnv } from './util.js';
import { TurnFeeder } from './feeder.js';
import { tr } from '../i18n.js';

// 별칭(opus·sonnet·haiku·fable)은 Claude Code가 항상 최신 모델로 연결해 줘서 업데이트가 자동 반영된다.
// 실제로 연결된 전체 이름은 실행할 때(init 이벤트) 기록해 목록에 보여준다.
const ALIASES = [
  { id: 'opus', label: 'Opus', tier: 'top' },
  { id: 'sonnet', label: 'Sonnet', tier: 'balanced' },
  { id: 'haiku', label: 'Haiku', tier: 'fast' },
  { id: 'fable', label: 'Fable', tier: 'top', premium: true },
];
const FIXED = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'top', legacy: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'balanced', legacy: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tier: 'fast', legacy: true },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', tier: 'top', legacy: true },
];
export const observedModels = {}; // 별칭 → 실제 모델 이름(최근 실행 기준)

function permArgs(p) {
  switch (p) {
    case 'plan': return ['--permission-mode', 'plan', '--permission-prompts', 'none'];
    case 'edit': return ['--permission-mode', 'acceptEdits', '--permission-prompts', 'none'];
    case 'auto': return ['--permission-mode', 'auto', '--permission-prompts', 'none'];
    case 'full': return ['--dangerously-skip-permissions'];
    default: return ['--permission-mode', 'default', '--permission-prompts', 'none'];
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return '';
}

function encode(text, images) {
  const content = [{ type: 'text', text }];
  for (const p of images) {
    try { content.push({ type: 'image', source: { type: 'base64', media_type: mimeOf(p), data: fs.readFileSync(p).toString('base64') } }); } catch { /* 없는 파일은 건너뜀 */ }
  }
  return { type: 'user', message: { role: 'user', content } };
}

export default {
  id: 'claude', label: 'Claude', get sub() { return tr('Claude Code CLI · 구독 로그인'); }, kind: 'cli', color: '#d97757',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  caps: { images: true, steer: true, resume: true, tools: true, connectors: true, permissions: true },
  login: { command: 'claude', get hint() { return tr('열린 터미널에서 /login 을 입력해 로그인해줘.'); } },

  async detect(settings) {
    const auth = authEnv(settings, 'claude');
    const v = await runQuick('claude', ['--version']);
    if (v.code === -1) return { installed: false, note: tr('Claude Code CLI 미설치 (npm i -g @anthropic-ai/claude-code)') };
    const version = v.out.trim().split(/\s+/)[0] || '';
    if (auth.mode === 'apikey') return { installed: true, version, loggedIn: auth.hasKey, authMode: 'apikey', account: tr('API 키 · 사용한 만큼 과금'), note: auth.hasKey ? '' : tr('API 키를 입력해줘 (설정 → API 키)') };
    const a = await runQuick('claude', ['auth', 'status'], 15000, { unset: auth.unset });
    let info = {};
    try { info = JSON.parse(a.out); } catch { /* 형식이 다르면 비움 */ }
    return {
      installed: true, version, loggedIn: !!info.loggedIn, authMode: 'login',
      account: info.email ? `${info.email} · ${info.subscriptionType || info.authMethod || ''}` : '',
      note: info.loggedIn ? '' : tr('로그인 필요'),
    };
  },

  async models() {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    const aliases = ALIASES.map((m) => {
      const name = m.premium ? `${m.label} (${tr('최상위')})` : m.label;
      return { ...m, efforts, label: observedModels[m.id] ? `${name} · ${tr('최신')} → ${observedModels[m.id]}` : `${name} · ${tr('최신 자동')}` };
    });
    return [...aliases, ...FIXED.map((m) => ({ ...m, efforts, label: `${m.label} (${tr('고정')})` }))];
  },

  run(opts, emit) {
    const { agent, prompt, system, images = [], cwd, resumeId, mcpConfigPath, addDirs = [], tmpDir } = opts;
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--replay-user-messages'];
    if (agent.model) args.push('--model', agent.model);
    if (agent.effort) args.push('--effort', agent.effort);
    args.push(...permArgs(agent.permission));
    let sysFile = null;
    if (system) {
      sysFile = path.join(tmpDir, `sys-${crypto.randomUUID()}.md`);
      fs.writeFileSync(sysFile, system);
      args.push('--append-system-prompt-file', sysFile);
    }
    if (resumeId) args.push('--resume', resumeId, ...(opts.forkSession ? ['--fork-session'] : []));
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
    for (const d of addDirs) args.push('--add-dir', d);
    if (agent.light) args.push('--safe-mode');

    const h = makeHandle();
    const auth = authEnv(opts.settings, 'claude');
    const child = spawnCli('claude', args, { cwd, env: auth.env, unset: auth.unset });
    const feeder = new TurnFeeder(child, encode);
    const tools = new Map();
    let text = '', sessionId = resumeId || null, errorMsg = null, stderr = '', stopped = false, started = false;

    onLines(child.stdout, (line) => {
      const ev = parseJsonLine(line);
      if (!ev) return;
      if (ev.parent_tool_use_id) {
        // 서브에이전트 활동은 도구 블록으로만 보여준다
        const content = ev.message?.content;
        if (ev.type === 'assistant' && Array.isArray(content)) {
          for (const b of content) if (b.type === 'tool_use') { tools.set(b.id, b.name); emit({ type: 'tool', id: b.id, name: `↳ ${b.name}`, input: b.input, status: 'running', sub: true }); }
        } else if (ev.type === 'user' && Array.isArray(content)) {
          for (const b of content) if (b.type === 'tool_result') emit({ type: 'tool', id: b.tool_use_id, name: `↳ ${tools.get(b.tool_use_id) || 'tool'}`, status: b.is_error ? 'error' : 'done', output: resultText(b.content).slice(0, 4000), sub: true });
        }
        return;
      }
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init') {
            sessionId = ev.session_id;
            emit({ type: 'session', id: ev.session_id });
            emit({ type: 'meta', model: ev.model });
            if (agent.model && ev.model && agent.model !== ev.model) observedModels[agent.model] = ev.model;
          } else if (ev.subtype === 'api_retry') emit({ type: 'notice', text: tr('API 재시도 중… ({n}/{max})', { n: ev.attempt ?? '', max: ev.max_retries ?? '' }) });
          break;
        case 'stream_event': {
          const e = ev.event;
          if (e?.type === 'content_block_delta') {
            if (e.delta?.type === 'text_delta') { text += e.delta.text; emit({ type: 'text', text: e.delta.text }); }
            else if (e.delta?.type === 'thinking_delta') emit({ type: 'thinking', text: e.delta.thinking });
          } else if (e?.type === 'message_start' && started && text && !text.endsWith('\n')) {
            text += '\n\n'; emit({ type: 'text', text: '\n\n' });
          } else if (e?.type === 'message_start') started = true;
          break;
        }
        case 'assistant':
          for (const b of ev.message?.content || []) {
            if (b.type === 'tool_use' && !tools.has(b.id)) { tools.set(b.id, b.name); emit({ type: 'tool', id: b.id, name: b.name, input: b.input, status: 'running' }); }
          }
          break;
        case 'user': {
          const content = ev.message?.content;
          const isToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result');
          if (isToolResult) {
            for (const b of content) if (b.type === 'tool_result') emit({ type: 'tool', id: b.tool_use_id, name: tools.get(b.tool_use_id), status: b.is_error ? 'error' : 'done', output: resultText(b.content).slice(0, 4000) });
          } else feeder.ack(); // --replay-user-messages: 보낸 메시지가 소비됨
          break;
        }
        case 'rate_limit_event': {
          const info = ev.rate_limit_info || {};
          const windows = {};
          for (const [k, v] of Object.entries(info.unifiedWindows || {})) windows[k] = { pct: Math.round((v.utilization ?? 0) * 100), resetsAt: v.resetsAt };
          if (!Object.keys(windows).length && info.rateLimitType) windows[info.rateLimitType] = { pct: null, resetsAt: info.resetsAt };
          emit({ type: 'limits', provider: 'claude', windows, status: info.status });
          break;
        }
        case 'result': {
          const u = ev.usage || {};
          emit({ type: 'usage', input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cost: ev.total_cost_usd || 0 });
          if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) errorMsg = (typeof ev.result === 'string' && ev.result) || ev.subtype || tr('실행 오류');
          else errorMsg = null;
          feeder.result();
          break;
        }
        default: break;
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { errorMsg = e.message; });
    child.on('close', (code) => {
      feeder.close();
      if (sysFile) fs.rmSync(sysFile, { force: true });
      const err = stopped ? null : (errorMsg || (code !== 0 ? (stderr.trim().split('\n').slice(-3).join(' ') || tr('종료 코드 {code}', { code })) : null));
      h.resolve({ text, providerSessionId: sessionId, error: err, stopped });
    });

    feeder.send(prompt, images);
    return {
      done: h.done,
      steer: (t) => feeder.send(t),
      stop: () => { stopped = true; feeder.close(); killTree(child); },
    };
  },
};
