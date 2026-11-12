// 테스트용 가짜 gemini: -o stream-json 이벤트 형식 흉내(실제 AI 호출 없음). 받은 인자와 프롬프트를 적어 둔다
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('0.0.0-fake\n'); process.exit(0); }
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const p = args.includes('-p') ? args[args.indexOf('-p') + 1] : '';
const finish = (input) => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: 'gemini', args: args.map((a) => (a === p ? '(prompt)' : a)), prompt: String(input || p).slice(0, 8000) })}\n`);
  out({ type: 'init', session_id: `gemini-sess-${process.pid}`, model: 'gemini-x' });
  out({ type: 'message', role: 'assistant', content: '제미나이의 답이야.' });
  out({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 5, cached: 0 } });
  process.exit(0);
};
// 긴 프롬프트는 stdin 으로 온다
if (process.stdin.isTTY === undefined || !process.stdin.isTTY) {
  let input = '';
  let done = false;
  const end = () => { if (!done) { done = true; finish(input); } };
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', end);
  setTimeout(end, 300); // stdin 이 안 붙은 경우
} else finish('');
