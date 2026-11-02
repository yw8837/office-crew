// 테스트용 가짜 claude: 실측한 stream-json 형식을 그대로 흉내 낸다(실제 AI 호출 없음)
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: 'claude', args, key: (process.env.ANTHROPIC_API_KEY || '').slice(-4), tok: (process.env.ANTHROPIC_AUTH_TOKEN || '').slice(-4) })}\n`);
// 받은 지침 파일 내용도 남긴다(실행이 끝나면 서버가 지우므로 여기서 읽음)
const sysFile = val('--append-system-prompt-file');
if (process.env.FAKE_LOG && sysFile) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: 'claude', system: fs.readFileSync(sysFile, 'utf8') })}\n`);

// stdin 을 읽기 전에 바로 죽는 CLI 흉내(서버가 EPIPE 로 죽지 않는지 확인용)
if (process.env.FAKE_EXIT_NOW === '1') process.exit(3);
const resume = val('--resume');
if (resume && resume.startsWith('dead')) { process.stderr.write(`No conversation found with session ID: ${resume}\n`); process.exit(1); }
const sid = resume && !args.includes('--fork-session') ? resume : `claude-sess-${process.pid}`; // 갈래(fork)면 새 id
out({ type: 'system', subtype: 'init', session_id: sid, model: val('--model') || 'claude-x', tools: [], mcp_servers: [] });

const queue = [];
let busy = false, closed = false, turn = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { if (line.trim()) { queue.push(JSON.parse(line)); pump(); } });
rl.on('close', () => { closed = true; if (!busy && !queue.length) process.exit(0); });

async function pump() {
  if (busy) return;
  const m = queue.shift();
  if (!m) { if (closed) process.exit(0); return; }
  busy = true;
  turn++;
  out({ type: 'user', message: m.message, isReplay: true });
  const content = m.message.content;
  const text = content.find((c) => c.type === 'text')?.text || '';
  const imgs = content.filter((c) => c.type === 'image').length;
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: 'claude', turn, text: text.slice(0, 5000), imgs })}\n`);
  out({ type: 'stream_event', event: { type: 'message_start' } });
  if (turn === 1) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu${turn}`, name: 'WebSearch', input: { query: '검색어' } }] } });
    await sleep(30);
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu${turn}`, content: '검색 결과' }] } });
    out({ type: 'stream_event', event: { type: 'message_start' } });
  }
  // EMPTYANSWER: 도구만 쓰고 글 없이 끝남(실측#1 흉내). 재요청을 받으면 그때 답한다
  const chunks = text.includes('도구를 더 쓰지 말고') ? ['조사 결과 ', '정리했어'] : text.includes('EMPTYANSWER') ? [] : ['안녕', '하세요 ', `turn${turn}`];
  for (const ch of chunks) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } } });
    await sleep(20);
  }
  // 신호어는 이번 요청 부분에서만 본다([이전 대화]에 남은 옛 신호어는 무시)
  const req = text.includes('[사용자 요청]') ? text.slice(text.lastIndexOf('[사용자 요청]')) : text;
  if (req.includes('SLOW')) await sleep(1500);
  if (req.includes('SESSIONLIMIT') && !text.includes('[이어받기]')) {
    // "session" 이 들어간 한도 문구(이어하기 실패로 오판하면 안 됨)
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Session limit reached', session_id: sid, usage: {} });
  } else if (text.includes('QUOTAFAIL') && !text.includes('[이어받기]')) {
    // 실측 형식: 한도 초과 시 rate_limit_event(rejected) 뒤 오류 결과
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached', session_id: sid, usage: {} });
  } else if (req.includes('QUOTATOOLS') && !text.includes('[이어받기]')) {
    // 도구를 쓰다가 한도에 걸림: 파일을 쓰고, 명령 하나는 실패, 마지막 명령은 끝나기 전에 멈춤
    const use = (id, name, input) => out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    const result = (id, content, isError = false) => out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
    use('tw1', 'Write', { file_path: 'src/app.js', content: 'x' });
    result('tw1', '썼어');
    use('tb1', 'Bash', { command: 'npm test' });
    result('tb1', '테스트 1개 실패', true);
    use('tb2', 'Bash', { command: 'npm run build' });
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached', session_id: sid, usage: {} });
  } else if (req.includes('QUOTAIN') && !text.includes('[이어받기]')) {
    // 사용량 창 정보(rate_limit_event) 없이 오류 문구에만 초기화 시각이 있는 경우(2시간 뒤)
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Usage limit reached. Try again in 2 hours.', session_id: sid, usage: {} });
  } else if (text.includes('QUOTANOPCT') && !text.includes('[이어받기]')) {
    // 사용률 없이 한도 종류와 초기화 시각(4시간 뒤)만 오는 거절 이벤트
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 4 * 3600 } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached', session_id: sid, usage: {} });
  } else if (req.includes('LIMITSPAM')) {
    // 초기화 시각 없는 거절 이벤트가 연달아 온 뒤 정상 종료(쉬는 목록 알림이 매번 나가면 안 됨)
    for (let k = 0; k < 5; k++) { out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }); await sleep(5); }
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, usage: { input_tokens: 1, output_tokens: 1 } });
  } else if (req.includes('FAILME')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '가짜 실패', session_id: sid, usage: {} });
  } else {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1793523600 }, seven_day: { utilization: 0.5, resetsAt: 1793685600 } } } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } });
  }
  busy = false;
  pump();
}
