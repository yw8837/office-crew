// 테스트용 가짜 codex: exec --json 이벤트 형식(실측) 흉내
import fs from 'node:fs';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: 'codex', args, prompt: input.slice(0, 5000), key: (process.env.CODEX_API_KEY || '').slice(-4) })}\n`);
  const resume = args[0] === 'exec' && args[1] === 'resume' ? args[2] : null;
  out({ type: 'thread.started', thread_id: resume || `codex-thread-${process.pid}` });
  out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'skipping MCP tool hook in plugin.json: MCP invocation is not available yet' } });
  out({ type: 'turn.started' });
  // 한도 초과 흉내(실측 문구 형식). 이어받은 요청([이어받기])에는 정상 응답
  if (input.includes('CODEXQUOTA') && !input.includes('[이어받기]')) {
    out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro or try again later." } });
    process.exit(1);
  }
  // 헛도는 CLI 흉내: 출력은 계속 나오는데 같은 경고(LOOPNOW)나 같은 계획(LOOPTOOL)만 되풀이한다. LOOPFEW 는 9번만 경고하고 정상으로 끝난다
  const warn = 'Heads up: Long threads and multiple compactions can cause the model to be less accurate.';
  const loops = input.includes('LOOPNOW') || input.includes('LOOPTOOL') ? 400 : input.includes('LOOPFEW') ? 9 : 0;
  for (let k = 0; k < loops; k++) {
    if (!input.includes('LOOPTOOL')) out({ type: 'item.completed', item: { id: `warn_${k}`, type: 'error', message: warn } });
    if (!input.includes('LOOPFEW')) out({ type: 'item.completed', item: { id: `todo_${k}`, type: 'todo_list', items: [{ text: '기존 상태 확인', completed: false }, { text: '초안 작성', completed: false }] } });
    out({ type: 'item.completed', item: { id: `msg_${k}`, type: 'agent_message', text: '먼저 기존 상태를 확인하겠습니다. ' } });
    await new Promise((r) => setTimeout(r, 10));
  }
  // BROWSE: -c mcp_servers.<이름>.args 로 브라우저 MCP(--output-dir 이 든 것)를 받았으면 페이지 열기 → 화면 찍기 흉내(결정 0029).
  // 찍기가 끝나기 전에 그 출력 폴더에 작은 PNG 를 쓴다. 결과 모양(result.content)은 MCP 의 도구 결과 형식을 따른 짐작이다(실제 Codex 출력은 확인 못 함)
  const mcpArgs = args.filter((a, i) => args[i - 1] === '-c' && /^mcp_servers\.[^.]+\.args=/.test(a)).map((a) => ({ key: a.split('.')[1], list: JSON.parse(a.slice(a.indexOf('=') + 1)) }));
  const browser = mcpArgs.find((x) => x.list.includes('--output-dir'));
  if (input.includes('BROWSE') && browser) {
    const dir = browser.list[browser.list.indexOf('--output-dir') + 1];
    const page = '### Page\n- Page URL: https://example.com/\n- Page Title: Example Domain';
    const call = (id, tool, args2, status, result) => ({ id, type: 'mcp_tool_call', server: browser.key, tool, arguments: args2, status, ...(result ? { result } : {}) });
    out({ type: 'item.started', item: call('mcp_1', 'browser_navigate', { url: 'https://example.com/' }, 'in_progress') });
    out({ type: 'item.completed', item: call('mcp_1', 'browser_navigate', { url: 'https://example.com/' }, 'completed', { content: [{ type: 'text', text: `### Ran Playwright code\nawait page.goto('https://example.com/');\n${page}` }] }) });
    out({ type: 'item.started', item: call('mcp_2', 'browser_take_screenshot', {}, 'in_progress') });
    await new Promise((r) => setTimeout(r, 20));
    fs.mkdirSync(dir, { recursive: true });
    const shot = `page-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    fs.writeFileSync(`${dir}/${shot}`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    out({ type: 'item.completed', item: call('mcp_2', 'browser_take_screenshot', {}, 'completed', { content: [{ type: 'text', text: `### Result\nTook the viewport screenshot and saved it as ${shot}\n${page}` }] }) });
  }
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } });
  if (input.includes('HANGNOW')) await new Promise((r) => setTimeout(r, 120000)); // 출력 없이 멈춘 CLI 흉내
  await new Promise((r) => setTimeout(r, input.includes('SLOW') ? 1500 : 30));
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt\n', exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: '정리 결과: 파란색' } });
  out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 7, reasoning_output_tokens: 0 } });
  process.exit(0);
});
