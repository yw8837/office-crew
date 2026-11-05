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
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } });
  if (input.includes('HANGNOW')) await new Promise((r) => setTimeout(r, 120000)); // 출력 없이 멈춘 CLI 흉내
  await new Promise((r) => setTimeout(r, input.includes('SLOW') ? 1500 : 30));
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt\n', exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: '정리 결과: 파란색' } });
  out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 7, reasoning_output_tokens: 0 } });
  process.exit(0);
});
