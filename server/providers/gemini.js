// Gemini CLI 어댑터(API 키 방식). 개인 Google 계정 로그인은 지원이 끝나서 GEMINI_API_KEY 를 쓴다
import { spawnCli, onLines, parseJsonLine, killTree, makeHandle, runQuick } from './util.js';
import { tr } from '../i18n.js';

const MODELS = [
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'top' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'fast' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', tier: 'top' },
];

function approval(p) {
  return { plan: 'plan', edit: 'auto_edit', auto: 'yolo', full: 'yolo' }[p] || 'default';
}

export default {
  id: 'gemini', label: 'Gemini CLI', get sub() { return tr('Gemini CLI · API 키'); }, kind: 'cli', color: '#8e75ff',
  efforts: [],
  caps: { images: false, steer: false, resume: false, tools: true, connectors: false, permissions: true },
  login: null,

  async detect(settings) {
    const v = await runQuick('gemini', ['--version']);
    if (v.code === -1) return { installed: false, note: tr('Gemini CLI 미설치') };
    const key = settings?.apiKeys?.gemini || process.env.GEMINI_API_KEY;
    return {
      installed: true, version: v.out.trim(), loggedIn: !!key, account: key ? tr('API 키 설정됨') : '',
      note: key ? '' : tr('개인 계정 로그인은 지원 종료 → 설정에서 Gemini API 키를 입력해줘'),
    };
  },

  async models() { return MODELS.map((m) => (m.id.endsWith('-preview') ? { ...m, label: `${m.label} (${tr('미리보기')})` } : m)); },

  run(opts, emit) {
    const { agent, prompt, system, cwd, settings, extraDirs = [] } = opts;
    const full = system ? `<${tr('역할 지침')}>\n${system}\n</${tr('역할 지침')}>\n\n${prompt}` : prompt;
    const viaStdin = full.length > 20000;
    const args = ['-o', 'stream-json', '--skip-trust', '--approval-mode', approval(agent.permission)];
    if (agent.model) args.push('-m', agent.model);
    for (const d of extraDirs) args.push('--include-directories', d); // 건네받은 대화 전체 파일 폴더
    args.push('-p', viaStdin ? tr('위 입력 내용에 답해줘.') : full);
    const key = settings?.apiKeys?.gemini || process.env.GEMINI_API_KEY || '';

    const h = makeHandle();
    const child = spawnCli('gemini', args, { cwd, env: key ? { GEMINI_API_KEY: key } : {}, stdin: viaStdin ? 'pipe' : 'ignore' });
    if (viaStdin) child.stdin.end(full);
    let text = '', sid = null, errorMsg = null, stderr = '', stopped = false;

    onLines(child.stdout, (line) => {
      const ev = parseJsonLine(line);
      if (!ev) return;
      switch (ev.type) {
        case 'init': sid = ev.session_id; emit({ type: 'session', id: sid }); if (ev.model) emit({ type: 'meta', model: ev.model }); break;
        case 'message':
          if (ev.role === 'assistant' && ev.content) { text += ev.content; emit({ type: 'text', text: ev.content }); }
          break;
        case 'tool_use': emit({ type: 'tool', id: ev.tool_id, name: ev.tool_name, input: ev.parameters, status: 'running' }); break;
        case 'tool_result': emit({ type: 'tool', id: ev.tool_id, status: ev.status === 'success' ? 'done' : 'error', output: String(ev.output ?? ev.error?.message ?? '').slice(0, 4000) }); break;
        case 'error': if (ev.severity === 'error') errorMsg = ev.message; else emit({ type: 'notice', text: ev.message, quiet: true }); break;
        case 'result': {
          const s = ev.stats || {};
          emit({ type: 'usage', input: Math.max(0, (s.input_tokens || 0) - (s.cached || 0)), output: s.output_tokens || 0, cacheRead: s.cached || 0, cacheWrite: 0, cost: 0 });
          if (ev.status && ev.status !== 'success') errorMsg = ev.error?.message || errorMsg || tr('실행 오류');
          break;
        }
        default: break;
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { errorMsg = e.message; });
    child.on('close', (code) => {
      const tail = stderr.split('\n').filter((l) => /error/i.test(l)).slice(-2).join(' ');
      const err = stopped ? null : (errorMsg || (code !== 0 ? (tail || tr('종료 코드 {code}', { code })) : null));
      h.resolve({ text, providerSessionId: sid, error: err, stopped });
    });
    return { done: h.done, stop: () => { stopped = true; killTree(child); } };
  },
};
