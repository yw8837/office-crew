// 테스트용 가짜 claude: 실측한 stream-json 형식을 그대로 흉내 낸다(실제 AI 호출 없음)
import fs from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: 'claude', args, key: (process.env.ANTHROPIC_API_KEY || '').slice(-4), tok: (process.env.ANTHROPIC_AUTH_TOKEN || '').slice(-4) })}\n`);
// 받은 지침 파일 내용도 남긴다(실행이 끝나면 서버가 지우므로 여기서 읽음)
const sysFile = val('--append-system-prompt-file');
if (process.env.FAKE_LOG && sysFile) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: 'claude', system: fs.readFileSync(sysFile, 'utf8') })}\n`);

const settingsFile = val('--settings');
if (process.env.FAKE_LOG && settingsFile) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: 'claude', settings: JSON.parse(fs.readFileSync(settingsFile, 'utf8')) })}\n`);

// stdin 을 읽기 전에 바로 죽는 CLI 흉내(서버가 EPIPE 로 죽지 않는지 확인용)
if (process.env.FAKE_EXIT_NOW === '1') process.exit(3);
const resume = val('--resume');
if (resume && resume.startsWith('dead')) { process.stderr.write(`No conversation found with session ID: ${resume}\n`); process.exit(1); }
const sid = resume && !args.includes('--fork-session') ? resume : `claude-sess-${randomUUID()}`; // 새 대화·갈래(fork)면 새 id(프로세스 번호와 상관없이)
out({ type: 'system', subtype: 'init', session_id: sid, model: val('--model') || 'claude-x', tools: [], mcp_servers: [] });

const queue = [];
let busy = false, closed = false, turn = 0;

// 결과의 모델별 사용량. SUBUSE: 하위 에이전트(작은 모델)도 일한 것처럼 두 모델을 싣는다(합이 usage 보다 크다).
// CUMUL: 누적을 내는 Claude Code(2.1.277부터) 흉내. 결과마다 이 프로세스에서 쓴 양의 합을 내고, 이어 가거나 갈래를 냈으면
// 원래 대화가 저장해 둔 누적부터 센다. 누적은 정상 종료할 때만 대화 id별로 FAKE_LOG 옆 파일에 적는다(중간에 죽으면 안 적힌다).
// 저장된 누적이 있는 대화는 이어 갈 때 신호어가 없어도 누적으로 낸다. 둘 다 아니면 싣지 않는다(지금 형식)
const cumulFile = process.env.FAKE_LOG ? `${process.env.FAKE_LOG}.cumul.json` : null;
const savedCumul = () => { try { return cumulFile ? JSON.parse(fs.readFileSync(cumulFile, 'utf8')) : {}; } catch { return {}; } };
let running = resume ? savedCumul()[resume] || null : null; // 이어 간(갈래 포함) 대화가 정상 종료 때 저장한 누적
let cumulOn = !!running;
const modelUsageOf = (now) => Object.fromEntries(Object.entries(now).map(([k, [i, o, cr, cw, c]]) => [k, { inputTokens: i, outputTokens: o, cacheReadInputTokens: cr, cacheCreationInputTokens: cw, costUSD: c }]));
function treeUsage(req) {
  if (req.includes('CUMUL') && cumulFile) cumulOn = true;
  if (!req.includes('SUBUSE') && !cumulOn) return {};
  let now = { 'claude-x': [10, 5, 100, 50, 0.01] };
  if (req.includes('SUBUSE')) now['claude-haiku-x'] = [200, 40, 0, 0, 0.002];
  if (cumulOn) {
    for (const [k, v] of Object.entries(running || {})) now[k] = (now[k] || [0, 0, 0, 0, 0]).map((x, i) => x + v[i]);
    running = now;
    now = { ...now };
  }
  const tree = { modelUsage: modelUsageOf(now), total_cost_usd: Object.values(now).reduce((n, v) => n + v[4], 0) };
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: 'claude', result: tree })}\n`);
  return tree;
}
// 정상 종료: 누적을 저장하고 끝낸다(앱이 프로세스를 끄면 여기를 지나지 않는다)
function exitNormally() {
  if (cumulOn && running && cumulFile) fs.writeFileSync(cumulFile, JSON.stringify({ ...savedCumul(), [sid]: running }));
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { if (line.trim()) { queue.push(JSON.parse(line)); pump(); } });
rl.on('close', () => { closed = true; if (!busy && !queue.length) exitNormally(); });

async function pump() {
  if (busy) return;
  const m = queue.shift();
  if (!m) { if (closed) exitNormally(); return; }
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
  // 신호어는 이번 요청 부분에서만 본다([이전 대화]에 남은 옛 신호어는 무시)
  const req = text.includes('[사용자 요청]') ? text.slice(text.lastIndexOf('[사용자 요청]')) : text;
  // EMPTYANSWER: 도구만 쓰고 글 없이 끝남(실측#1 흉내). 재요청을 받으면 그때 답한다
  // 스킬 설명 한글화 요청([{"i":0,"d":...}] 목록)이면 ```json 블록으로 번역을 돌려준다
  const koReq = text.match(/\[\{"i":0,"d":[\s\S]*\}\]/);
  const koItems = koReq ? (() => { try { return JSON.parse(koReq[0]); } catch { return null; } })() : null;
  // 회의 중 조사 차례(조사 지시 문장이 있음). RESEARCHFAIL 이면 조사 차례만 오류로 끝난다
  const research = text.includes('회의에서 나온 질문 하나를 도구로 찾아서 답해');
  const chunks = koItems ? ['```json\n', JSON.stringify(Object.fromEntries(koItems.map((x) => [String(x.i), `가짜 한글 설명 ${x.i}`]))), '\n```']
    // 회의 판정 차례: 판정 블록으로 답한다. AGREEFAST 는 합의, BADVERDICT 는 틀린 형식, 그 밖은 계속
    : text.includes('[회의 — 판정') ? ['판정할게.\n\n', req.includes('BADVERDICT') ? '```oc-verdict\n{"verdict":"글쎄"}\n```' : '```oc-verdict\n{"verdict":"' + (req.includes('AGREEFAST') ? 'agree' : 'continue') + '","reason":"가짜 판정"}\n```']
    : research ? ['가짜 조사: 비용은 한 달 10만 원이야 (출처: https://example.com/price)\n', '가짜 조사: 작년에도 같았어 (출처: docs/budget.md)']
    // 회의 차례: CHECKME 는 답 끝에 질문 블록을 붙이고, CHECKBAD 는 깨진 블록을 붙인다
    : text.includes('[회의 — 차례 발언') && req.includes('CHECKBAD') ? ['형식이 틀린 블록을 붙일게.\n\n', '```oc-check\n{망가진 JSON\n```']
    : text.includes('[회의 — 차례 발언') && req.includes('CHECKME') ? ['안녕', '하세요 ', `turn${turn}`, '\n\n```oc-check\n{"question":"가짜 질문: 비용이 얼마야?"}\n```']
    // ASKME: 사용자에게 선택지를 묻고 멈춘다. 답을 받으면 이어서 쓴다. ASKMORE 는 답을 받아도 계속 묻고, ASKBAD 는 형식을 틀린다
    : text.includes('[사용자 답변]') && !text.includes('ASKMORE') ? ['답 받았어. ', '이어서 진행했어']
    : /ASKME|ASKMORE/.test(text) ? ['먼저 확인할게.\n\n', '```oc-ask\n{"questions":[{"header":"범위","question":"' + (text.includes('ASKMORE') ? 'ASKMORE ' : '') + '어디까지 할까?","options":[{"label":"전부 (추천)","description":"처음부터 끝까지"},{"label":"일부만","description":"앞부분만"}],"multi":false},{"question":"무엇을 넣을까?","options":["표","그림","요약"],"multi":true}]}\n```']
    : text.includes('ASKBAD') ? ['```oc-ask\n{"questions":[{"question":"보기가 하나뿐","options":["하나"]}]}\n```']
    : text.includes('도구를 더 쓰지 말고') ? ['조사 결과 ', '정리했어'] : text.includes('EMPTYANSWER') ? [] : ['안녕', '하세요 ', `turn${turn}`];
  for (const ch of chunks) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } } });
    await sleep(20);
  }
  // READTALK: 건네받은 대화 전체 파일을 Read 도구로 여는 흉내
  const talkFile = text.match(/^.*conversation\.md$/m)?.[0];
  if (req.includes('READTALK') && talkFile) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tr${turn}`, name: 'Read', input: { file_path: talkFile } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tr${turn}`, content: req.includes('READFAIL') ? '읽지 못했어' : '읽었어', is_error: req.includes('READFAIL') }] } });
  }
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
  } else if (req.includes('FAILME') || (research && req.includes('RESEARCHFAIL'))) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '가짜 실패', session_id: sid, usage: {} });
  } else if (req.includes('ZEROCRASH')) {
    // 충돌 흉내: 값이 모두 0인 오류 결과를 내고 누적을 저장하지 않은 채 끝난다
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '가짜 충돌', session_id: sid, total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: { 'claude-x': zero } })}\n`, () => process.exit(1));
    return;
  } else if (req.includes('LOOPTOOL')) {
    // 헛도는 CLI 흉내: 같은 도구를 같은 입력으로 되풀이한다(앱이 끌 때까지)
    for (let k = 0; k < 400; k++) {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `lt${turn}_${k}`, name: 'Read', input: { file_path: 'same.txt' } }] } });
      await sleep(5);
    }
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }, ...treeUsage(req) });
  } else {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1793523600 }, seven_day: { utilization: 0.5, resetsAt: 1793685600 } } } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }, ...treeUsage(req) });
  }
  busy = false;
  pump();
}
