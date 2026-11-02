// 자동 이어받기: 한도 초과 판별, 쉬는 시간, 한도 임박, 이어받을 AI 선택
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isQuotaError, nearLimit, avoidUntil, Cooldown, availableCatalog, pickFallback, continuationPrompt, resetTime, handoffFacts } from '../server/failover.js';

const providers = [
  { id: 'claude', loggedIn: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'codex', loggedIn: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'local', loggedIn: true, efforts: [] },
];
const models = {
  claude: [{ id: 'opus', tier: 'top' }, { id: 'sonnet', tier: 'balanced' }],
  codex: [{ id: 'gpt-6-astra', tier: 'top' }, { id: 'gpt-6.1-sol', tier: 'balanced' }],
  local: [{ id: 'qwen3:8b', tier: 'local' }],
};

test('한도 초과 문구는 잡고 일반 오류는 안 잡는다', () => {
  for (const s of ['Claude AI usage limit reached|1793523600', "You've hit your usage limit. Upgrade to Pro", 'Error 429: Too Many Requests', 'RESOURCE_EXHAUSTED: Quota exceeded for quota metric', 'insufficient_quota', 'rate_limit_error']) {
    assert.ok(isQuotaError(s), s);
  }
  for (const s of ['ENOENT: claude 명령을 찾을 수 없어', 'SyntaxError: Unexpected token', 'permission denied']) assert.ok(!isQuotaError(s), s);
});

test('한도 임박: 95% 이상이거나 거절 상태면 임박', () => {
  const later = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(nearLimit({ windows: { five_hour: { pct: 96, resetsAt: later } } }), true);
  assert.equal(nearLimit({ windows: { five_hour: { pct: 40, resetsAt: later } } }), false);
  assert.equal(nearLimit({ status: 'rejected', windows: { five_hour: { pct: 10 } } }), true);
  assert.equal(nearLimit({ windows: { seven_day: { pct: 99, resetsAt: Math.floor(Date.now() / 1000) - 10 } } }), false, '이미 초기화된 창은 무시');
  assert.equal(resetTime({ windows: { a: { resetsAt: later } } }), 0, '다 찬 창이 없으면 0(쉬는 시간 기본 30분)');
  assert.equal(resetTime({ windows: { a: { pct: 100, resetsAt: later } } }), later * 1000);
});

test('쉬는 시간: 기록 → 활성 → 만료', () => {
  const c = new Cooldown();
  c.mark('claude', { until: Date.now() + 50, reason: 'limit' });
  assert.ok(c.active('claude'));
  assert.deepEqual(Object.keys(c.list()), ['claude']);
  c.map.get('claude').until = Date.now() - 1;
  assert.equal(c.active('claude'), null);
  const d = c.mark('codex'); // 초기화 시각을 모르면 30분
  assert.ok(d.until - Date.now() > 29 * 60 * 1000);
});

test('Claude 가 막히면 같은 역할로 다른 AI(Codex)가 이어받는다', () => {
  const cooldown = new Cooldown();
  cooldown.mark('claude', { reason: 'usage limit' });
  const r = pickFallback({ role: '빌드', provider: 'claude', routingProfile: 'balanced' }, { providers, models }, { cooldown });
  assert.equal(r.provider, 'codex');
  assert.equal(r.model, 'gpt-6-astra');
  const cat = availableCatalog({ providers, models }, { cooldown, limits: { codex: { windows: { seven_day: { pct: 99, resetsAt: Math.floor(Date.now() / 1000) + 99 } } } } });
  assert.deepEqual(cat.blocked.sort(), ['claude', 'codex']);
  const r2 = pickFallback({ role: '빌드', provider: 'claude' }, { providers, models }, { cooldown, limits: { codex: { windows: { seven_day: { pct: 99, resetsAt: Math.floor(Date.now() / 1000) + 99 } } } } });
  assert.equal(r2.provider, 'local', 'Codex 도 한도 임박이면 다음 후보(내 PC 모델)');
});

test('모두 막히면 null, 이어받기 지시에 지금까지 쓴 내용이 들어간다', () => {
  const cooldown = new Cooldown();
  for (const p of ['claude', 'codex', 'local']) cooldown.mark(p);
  assert.equal(pickFallback({ role: '분석', provider: 'claude' }, { providers, models }, { cooldown }), null);
  const p = continuationPrompt('[사용자 요청]\n보고서', '## 1장\n앞부분', 'Claude');
  assert.match(p, /Claude이\(가\) 사용량 한도/);
  assert.match(p, /\[사용자 요청\]/);
  assert.match(p, /앞부분/);
});

test('#6 크기 한도·스택 줄번호·일시 과부하는 사용량 한도가 아니다 / #11 다 찬 창의 가장 늦은 초기화 시각까지 쉰다', () => {
  for (const s of ['context window limit reached', 'max_tokens limit reached', 'at foo (foo.js:429:12)', 'overloaded_error: Overloaded', '파일 크기 한도를 넘었어', 'prompt is too long: rate limit of context']) {
    assert.ok(!isQuotaError(s), s);
  }
  for (const s of ['HTTP 429 Too Many Requests', 'Session limit reached', '사용량 한도에 도달했어']) assert.ok(isQuotaError(s), s);
  const now = Math.floor(Date.now() / 1000);
  const both = { windows: { five_hour: { pct: 100, resetsAt: now + 3600 }, seven_day: { pct: 100, resetsAt: now + 5 * 86400 } } };
  assert.equal(resetTime(both), (now + 5 * 86400) * 1000, '주간도 다 찼으면 주간 초기화까지');
  const five = { windows: { five_hour: { pct: 100, resetsAt: now + 3600 }, seven_day: { pct: 40, resetsAt: now + 5 * 86400 } } };
  assert.equal(resetTime(five), (now + 3600) * 1000);
  assert.equal(nearLimit({ status: 'rejected', windows: { five_hour: { pct: 100, resetsAt: now - 5 } }, observedAt: Date.now() - 7200e3 }), false, '지난 거절은 풀림');
  assert.equal(nearLimit({ status: 'rejected', windows: { five_hour: { pct: 100, resetsAt: now + 99 } }, observedAt: 1, releasedAt: 2 }), false, '사용자가 풀었으면 무시');
});

test('재검증 N1 거절 기록은 다 찬 창 기준으로 피하고 / N6 분당 토큰 한도·한국어 "한도 초과"도 한도로 본다', () => {
  const now = Math.floor(Date.now() / 1000);
  const old = Date.now() - 2 * 3600e3;
  const passed = { status: 'rejected', observedAt: old, windows: { five_hour: { pct: 100, resetsAt: now - 60 }, seven_day: { pct: 40, resetsAt: now + 5 * 86400 } } };
  assert.equal(avoidUntil(passed), 0, '다 찬 5시간 창이 풀렸으면 주간 창이 남아도 피하지 않음');
  const weekly = { status: 'rejected', observedAt: old, windows: { five_hour: { pct: 30, resetsAt: now + 3600 }, seven_day: { pct: 100, resetsAt: now + 5 * 86400 } } };
  assert.equal(avoidUntil(weekly), (now + 5 * 86400) * 1000, '다 찬 주간 창이면 주간 초기화까지');
  assert.ok(isQuotaError('Quota exceeded: token limit per minute reached'));
  assert.ok(isQuotaError('rate limit exceeded: token limit 1000000/min'));
  assert.ok(isQuotaError('요청 한도 초과'));
  assert.ok(isQuotaError('한도 초과로 중단됨'));
  assert.ok(!isQuotaError('maximum context length exceeded'));
});

test('최종검증 3·9 다 찬 창이 없는 옛 기록이면 쉬는 시간은 기본 30분, 출력 토큰·업로드 용량 한도는 사용량 한도가 아니다', () => {
  const now = Math.floor(Date.now() / 1000);
  const stale = { windows: { five_hour: { pct: 100, resetsAt: now - 60 }, seven_day: { pct: 40, resetsAt: now + 5 * 86400 } } };
  assert.equal(resetTime(stale), 0, '0 이면 Cooldown 이 기본 30분을 씀');
  const c = new Cooldown();
  const d = c.mark('codex', { until: resetTime(stale) });
  assert.ok(d.until - Date.now() <= 30 * 60 * 1000 + 1000, '며칠씩 쉬지 않음');
  for (const s of ['출력 토큰 한도 초과', '업로드 용량 한도 초과', 'upload quota exceeded for files', 'output tokens limit exceeded']) assert.ok(!isQuotaError(s), s);
  assert.ok(isQuotaError('요청 한도 초과'));
});

test('최종 재검증 3 분당 토큰 한도(OTPM·TPM)는 "출력 토큰" 말이 섞여 있어도 사용량 한도다', () => {
  for (const s of [
    'This request would exceed the rate limit for your organization (org-x) of 8,000 output tokens per minute. Please reduce the prompt length or the maximum tokens requested, or try again later.',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 8,000 output tokens per minute."}}',
    'Rate limit reached for gpt-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000.',
    'Rate limit exceeded: 8,000 output tokens per-minute for this model.',
    'rate limit: 10,000 output tokens/min',
    'rate limit: 10,000 output tokens / minute',
    'rate limit of 8,000 output tokens per 1 minute',
    '분당 출력 토큰 한도 초과',
  ]) assert.ok(isQuotaError(s), s);
  for (const s of ['출력 토큰 한도 초과', 'context window exceeded: rate limit', 'upload quota exceeded for files', 'context window exceeded; see rate limit notes in /home/min/logs']) assert.ok(!isQuotaError(s), s);
});

// R-a 인계서: 앞 담당의 말이 아니라 서버가 본 도구 기록에서 사실만 뽑아 넘긴다
const CWD = path.resolve('/work/proj');
const OUTSIDE = path.resolve('/elsewhere/notes.txt');
const tool = (id, name, input, status = 'done') => ({ id, kind: 'tool', name, input, status, output: '' });

test('R-a 인계서에 쓴 도구(횟수·실패·안 끝남), 손댄 파일(작업 폴더 기준, 중복 없이), 마지막 명령, 먼저 할 일이 들어간다', () => {
  const blocks = [
    { id: 'n1', kind: 'notice', text: '알림' },
    { id: 'h1', kind: 'thinking', text: '생각' },
    tool('t1', 'Read', { file_path: path.join(CWD, 'docs', 'spec.md') }),
    tool('t1b', 'NotebookRead', { notebook_path: path.join(CWD, 'nb.ipynb') }),
    tool('t2', 'Write', { file_path: path.join(CWD, 'src', 'app.js'), content: 'x' }),
    tool('t3', 'Edit', { file_path: path.join(CWD, 'src', 'app.js'), old_string: 'a', new_string: 'b' }),
    tool('t4', '파일 편집', { changes: [`update ${path.join(CWD, 'src', 'util.js')}`, `add ${path.join(CWD, 'README.md')}`] }),
    tool('t5', 'write_file', { file_path: OUTSIDE, content: 'y' }),
    tool('t6', 'Bash', { command: 'npm test' }, 'error'),
    tool('t7', 'Bash', { command: 'npm run build' }, 'running'),
    tool('t8', 'Run', { command: ['bash', '-lc', 'make lint'] }),
  ];
  const p = continuationPrompt('[사용자 요청]\n앱 만들어', '## 1장\n앞부분', 'Claude', undefined, handoffFacts(blocks, CWD));
  assert.ok(p.indexOf('[사용자 요청]') < p.indexOf('[인계서') && p.indexOf('[인계서') < p.indexOf('앞부분'), '원래 요청 → 인계서 → 앞 담당이 쓴 글 순서');
  assert.match(p, /Bash 2번 \(실패 1, 안 끝남 1\)/);
  assert.match(p, /Write 1번/);
  assert.match(p, /손댄 파일: src\/app\.js, src\/util\.js, README\.md, /, 'Claude·Codex 모양 모두, 같은 파일은 한 번만');
  assert.ok(p.includes(OUTSIDE), '작업 폴더 밖 파일은 경로 그대로');
  assert.ok(!p.includes('spec.md') && !p.includes('nb.ipynb'), '읽기만 한 파일은 손댄 파일이 아니다(이름에 notebook 이 있어도)');
  assert.match(p, /bash -lc make lint/, '배열로 온 명령(ACP)도 한 줄로');
  assert.match(p, /npm test \(실패\)/);
  assert.match(p, /npm run build \(안 끝남\)/);
  assert.match(p, /먼저 할 일: .*상태.*확인/);
});

test('R-a 도구를 안 썼으면 인계서 없이 예전처럼 원래 요청과 쓴 글만 넘긴다', () => {
  assert.equal(handoffFacts([{ id: 'n1', kind: 'notice', text: '알림' }, { id: 'h1', kind: 'thinking', text: '생각' }], CWD), null);
  const p = continuationPrompt('[사용자 요청]\n보고서', '앞부분', 'Claude', undefined, handoffFacts([], CWD));
  assert.ok(!p.includes('[인계서'));
  assert.match(p, /\[사용자 요청\]\n보고서\n\n\[앞 담당이 지금까지 쓴 내용/);
});

test('R-a 인계서의 명령에 섞인 비밀값은 가리고, 평범한 인자는 그대로 둔다', () => {
  // [명령, 가려야 할 값, 남아야 할 부분] — 명령마다 따로 넘겨서 "안 보여서 통과"를 막는다
  const cases = [
    ['curl -H "Authorization: Bearer abc123def456ghi" https://api.example.com/v1', 'abc123def456ghi', 'https://api.example.com/v1'],
    ['git clone https://me:hunter2pass@github.com/x/y.git', 'hunter2pass', 'github.com/x/y.git'],
    ['API_KEY=sk-live-1234567890abcdef node app.js --verbose', '1234567890abcdef', 'node app.js --verbose'],
    ['mytool --password s3cr3tvalue --dry-run', 's3cr3tvalue', 'mytool --password'],
    ['gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'gh auth login --with-token'],
    ['curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA==" https://x.example', 'dXNlcjpwYXNzd29yZA', 'https://x.example'],
  ];
  for (const [cmd, secret, keep] of cases) {
    const p = continuationPrompt('요청', '', 'Claude', undefined, handoffFacts([tool('c', 'Bash', { command: cmd })], CWD));
    assert.ok(!p.includes(secret), `가려야 함: ${cmd}`);
    assert.ok(p.includes(keep), `남아야 함: ${keep}`);
  }
  // 비밀값이 없는 평범한 명령은 한 글자도 안 바뀐다
  const plain = 'npm test -- --grep "token refresh" && git log --oneline -3';
  assert.ok(continuationPrompt('요청', '', 'Claude', undefined, handoffFacts([tool('c', 'Bash', { command: plain })], CWD)).includes(plain));
});

test('R-a 인계서는 짧게: 파일은 20개까지(외 N개), 명령은 마지막 3개, 여러 줄 명령은 한 줄로', () => {
  const blocks = [];
  for (let i = 0; i < 25; i++) blocks.push(tool(`w${i}`, 'Write', { file_path: path.join(CWD, `f${i}.txt`) }));
  for (let i = 1; i <= 5; i++) blocks.push(tool(`b${i}`, 'Bash', { command: i === 5 ? "cat <<'EOF' > a.txt\nline1\nEOF" : `step${i}` }));
  const p = continuationPrompt('요청', '', 'Claude', undefined, handoffFacts(blocks, CWD));
  assert.ok(p.includes('f19.txt') && !p.includes('f20.txt'), '파일 20개까지');
  assert.match(p, /외 5개/);
  assert.ok(!p.includes('step1') && !p.includes('step2') && p.includes('step3') && p.includes('step4'), '마지막 명령 3개만');
  assert.match(p, /cat <<'EOF' > a\.txt line1 EOF/, '줄바꿈은 공백으로');
});
