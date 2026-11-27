// 목표 모드의 구멍과 기록(결정 0022): 대목마다 받는 블록 표, 에이전트마다의 배정 기록(요청한 AI·실제로 돈 AI·이유),
// 한도가 줄면 부가 일부터 멈추기(회의 중 조사), 실패를 종류로 적기(막힘 블록의 종류·넘겨받음·보통 오류), 화면의 도움 함수, 묻고 할 일 지시 한 줄.
// 가짜 CLI 만 쓴다(실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bindLang } from '../server/i18n.js';
import {
  BLOCK_ACCEPTS, BLOCK_NAMES, blocksIn, foreignBlocks, blockPart, parseBlocked, blockedRule, BLOCKED_KINDS, outsideRule, resumeSent, parseReview,
  goalBlock, questionsPrompt, scanPrompt, researchPrompt, planPrompt, reviewPrompt, forkPrompt, leadRule, leadPrompt, smallOpinionPrompt, smallConcludePrompt,
} from '../server/mission.js';
import { askNote } from '../server/ask.js';
import { verdictBlock, checkBlock } from '../server/meeting.js';
import { routeTip, agentWrote } from '../public/js/chat-tools.js';
import { startTestApp } from './helpers.js';

bindLang(() => 'ko'); // 순수 함수의 문구(한국어 원문)를 검사한다
let t = null;
before(async () => {
  t = await startTestApp();
  // 자동 라우팅·이어받기를 보려고 Claude·Codex 를 로그인된 것으로 두고 모델 목록을 고정한다(실제 탐지는 안 한다)
  const reg = t.app.providers;
  reg.detected = { claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true } };
  reg.modelCache = {
    claude: { at: Date.now(), version: '', list: [{ id: 'opus', label: 'Opus', tier: 'top' }, { id: 'sonnet', label: 'Sonnet', tier: 'balanced' }] },
    codex: { at: Date.now(), version: '', list: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'top', efforts: ['low', 'medium', 'high', 'xhigh'] }, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'balanced', efforts: ['low', 'medium', 'high'] }] },
  };
});
after(async () => { if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } } });
const clean = () => { t.app.orch.cooldown.map.clear(); t.app.store.usage.limits = {}; t.app.store.settings.failover = true; t.app.store.settings.waitForResetMin = 0; };

const S = (id) => t.app.store.getSession(id);
const mk = async (name, role, extra = {}) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual', ...extra })).json;
const mkTeam = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides });
const idle = (sid) => !t.app.orch.ctx.has(sid);
const ctl = (sid, action, extra = {}) => t.api('POST', `/api/sessions/${sid}/control`, { action, ...extra });
const done = (sid) => t.waitFor(() => idle(sid) && !['active', 'waiting'].includes(S(sid).mission.status), 60000, '목표 끝').catch((e) => {
  const s = S(sid);
  const run = s.runs.at(-1);
  throw new Error(`${e.message}: ${JSON.stringify({ status: s.mission?.status, hold: run?.hold || null, stages: run?.stages.map((x) => `${x.mission || x.label}:${x.status}`), log: (s.mission?.log || []).slice(-5).map((x) => x.text) })}`);
});
const waitHold = (sid, reason, kind = null) => t.waitFor(() => { const r = S(sid).runs.at(-1); return r?.hold?.reason === reason && (!kind || r.hold.kind === kind) && r; }, 30000, `${reason}${kind ? `/${kind}` : ''} 대기`);
// 가짜 CLI 기록(끝까지 쓴 줄만)
const fakeLog = () => {
  let text = '';
  try { text = fs.readFileSync(process.env.FAKE_LOG, 'utf8'); } catch { return []; }
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
};
const mark = () => fakeLog().length;
const prompts = (from) => fakeLog().slice(from).filter((l) => l.cli === 'claude' && l.text !== undefined).map((l) => l.text);
const agentMsgs = (s, pred = () => true) => s.messages.filter((m) => m.role === 'agent' && pred(m));

// 요청 → 카드 → 확인. prep: 고른 체크(지정하지 않으면 조사·회의 없이). work: 'stages'|'cards'. signal: 목표 문장을 신호어가 든 것으로 고쳐서 확인.
// before(sid): 카드가 나온 뒤 확인하기 바로 전에 부른다(목표 차례는 이미 끝났고 일 실행은 아직)
async function goal(teamId, signal = '', { prep = { research: false, meeting: false }, work = 'stages', request = '정리해 줘', before = null } = {}) {
  const s = (await t.api('POST', '/api/sessions', { teamId })).json;
  assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: request });
  await t.waitFor(() => S(s.id).mission?.status === 'draft' && idle(s.id), 20000, '목표 카드');
  if (before) await before(s.id);
  const c = S(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const body = { research: !!prep.research && c.prep.research.can, meeting: !!prep.meeting && c.prep.meeting.can, lead: c.prep.lead.id, researchers: c.prep.research.who.map((w) => w.id), attendees: c.prep.meeting.who.map((w) => w.id) };
  const r = await t.api('POST', `/api/sessions/${s.id}/mission/confirm`, { missionId: S(s.id).mission.id, expected: shown(c), review, prep: body, work, ...(signal ? { edited: { ...shown(c), goal: `${signal} 목표` } } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return s.id;
}
// 단계표 팀: 조사(R) → 분석(A, 진행자) → 빌드(B). 검수자는 R. 회의 참석자는 A + R
async function teamStages(tag, builder = {}) {
  const r = await mk(`${tag}조사`, '조사');
  const a = await mk(`${tag}분석`, '분석');
  const b = await mk(`${tag}빌드`, '빌드', builder);
  const tm = await mkTeam(`${tag}팀`, [{ label: '조사', agentIds: [r.id] }, { label: '분석', agentIds: [a.id] }, { label: '빌드', agentIds: [b.id] }]);
  return { r, a, b, tm };
}
// 일 카드 팀: 조사(R, 진행자) → 빌드(B) → 검수(V). 카드 명단은 R·B(k1 은 R, k2 는 B)
async function teamCards(tag) {
  const r = await mk(`${tag}조사`, '조사');
  const b = await mk(`${tag}빌드`, '빌드');
  const v = await mk(`${tag}검수`, '검수');
  const tm = await mkTeam(`${tag}팀`, [{ label: '조사', agentIds: [r.id] }, { label: '빌드', agentIds: [b.id] }, { label: '검수', agentIds: [v.id] }]);
  return { r, b, v, tm };
}

test('1. 대목마다 받는 블록 표(순수 함수): 실제로 쓰는 블록만, 표에 없는 블록을 찾고, 대목마다 프롬프트가 보여 주는 블록은 표 안에 있다', () => {
  assert.deepEqual(Object.keys(BLOCK_ACCEPTS).sort(), ['cards', 'fork', 'goal', 'lead', 'meet', 'meeting', 'plan', 'questions', 'research', 'review', 'scan', 'work']); // fork·lead·meet: 두 갈래 요약, 진행자 답, 작은 회의(결정 0031)
  assert.deepEqual([...BLOCK_NAMES].sort(), ['oc-ask', 'oc-blocked', 'oc-cards', 'oc-check', 'oc-goal', 'oc-lead', 'oc-meet', 'oc-research', 'oc-review', 'oc-verdict']);
  assert.ok(!BLOCK_NAMES.includes(['oc', 'plan'].join('-')), '쓰이지 않는 이름은 없다'); // 조각을 잇는다: 위생 검사의 계획 문서 이름 무늬
  assert.deepEqual(blocksIn('앞\n```oc-cards\n{}\n```\n```oc-ask\n{}\n```\n```oc-cards\n{}\n```'), ['oc-cards', 'oc-ask'], '같은 블록은 한 번');
  assert.deepEqual(foreignBlocks('review', '```oc-research\n{}\n```\n\n```oc-review\n{}\n```'), ['oc-research']);
  assert.deepEqual(foreignBlocks('work', '```oc-blocked\n{"reason":"x"}\n```'), []);
  assert.deepEqual(foreignBlocks('research', '- 사실 | 출처 | 확인함\n```oc-ask\n{}\n```'), ['oc-ask'], '한 번 실행(조사)은 묻지 못한다');
  assert.deepEqual(foreignBlocks('nope', '```oc-goal\n{}\n```'), [], '모르는 대목은 보지 않는다');
  assert.deepEqual(foreignBlocks('work', '```oc-foo\n{}\n```'), ['oc-foo'], '표에 없는 이름도 그 대목이 안 받는 블록이다');
  // 답 메시지 → 대목
  const P = (m) => blockPart({ role: 'agent', ...m });
  assert.deepEqual([P({ goalDraft: true }), P({ review: { round: 1 } }), P({ prep: { kind: 'scan' } }), P({ prep: { kind: 'questions' } }), P({ prep: { kind: 'research', qid: 'q1' } }), P({ prep: { kind: 'plan' } }),
    P({ prep: { kind: 'meeting' }, meeting: { phase: 'opinion' } }), P({ meeting: { phase: 'judge' } }), P({ meeting: { phase: 'research' }, checkOf: 'm1' }), P({ card: { id: 'k1' } }), P({})],
  ['goal', 'review', 'scan', 'questions', 'research', 'plan', 'meeting', 'meeting', 'research', 'cards', 'work']);
  // 표가 단일 근거: 대목마다 코드가 프롬프트에 보여 주는 블록 예시는 그 대목의 표 안에 있다
  const fits = (part, text) => assert.deepEqual(blocksIn(text).filter((b) => !BLOCK_ACCEPTS[part].includes(b)), [], `${part}: ${blocksIn(text).join(',')}`);
  const o = { head: '[확정된 목표]', request: '요청', cwd: '/w' };
  fits('goal', `${goalBlock()}\n${askNote()}`);
  fits('scan', scanPrompt(o));
  fits('questions', questionsPrompt(o));
  fits('research', researchPrompt({ ...o, question: '질문' }));
  fits('meeting', `${verdictBlock()}\n${checkBlock()}`);
  fits('plan', planPrompt({ ...o, roster: [{ name: '가', role: '조사' }] }));
  fits('work', `${blockedRule()}\n${askNote()}`);
  fits('cards', `${blockedRule()}\n${askNote()}\n${leadRule(2)}`); // 진행자에게 묻기(결정 0031)
  fits('lead', leadPrompt({ head: '[확정된 목표]', id: 'k1', card: { title: '제목' }, question: '질문', roster: [{ name: '가', role: '정리' }, { name: '나', role: '조사' }] }));
  fits('meet', `${smallOpinionPrompt({ topic: '주제' })}\n${smallConcludePrompt({ topic: '주제', said: [{ name: '가', text: '의견' }] })}`);
  fits('review', reviewPrompt({ goal: 'g', criteria: [{ id: 'c1', text: '기준' }], nonce: 'n' }));
  fits('fork', forkPrompt({ head: '[확정된 목표]', label: '회의', key: 'A', mine: 'A안', other: 'B안' })); // 두 갈래 요약(결정 0031): 블록 예시가 없다
});

test('2. 표에 없는 블록이 답에 섞이면 그 블록은 읽지 않고(답의 나머지는 지금처럼) 진행 기록에 한 줄', async () => {
  const { tm } = await teamStages('표밖');
  const sid = await goal(tm.id, 'WORKFOREIGN');
  await done(sid);
  const s = S(sid);
  assert.equal(s.mission.status, 'done', '일 단계는 그대로 끝나고 판정까지 간다');
  const lines = s.mission.log.filter((x) => x.kind === 'block');
  assert.ok(lines.length >= 1, JSON.stringify(s.mission.log.map((x) => x.text)));
  const work = agentMsgs(s, (m) => m.stageLabel === '빌드' && !m.review).at(-1);
  assert.ok(lines.some((x) => x.msgId === work.id && x.text.includes('oc-research') && x.text.includes('일 단계')), JSON.stringify(lines));
  assert.ok(!work.researchBlock && !work.prep, '그 블록을 조사 질문으로 읽지 않았다');
  assert.equal(s.runs.at(-1).stages.find((x) => x.label === '빌드').status, 'done');
});

test('3. 배정 기록: 답마다 요청한 AI·실제로 돈 AI·이유 코드(자동 라우팅·한도 임박·하루 예산·하루 몫·이어받기·기다림·지운 계정), 이유는 코드가 아는 것만', async () => {
  clean();
  // 에이전트와 세션을 먼저 만들고(setup: 보내기 바로 전에 부른다. 한도 기록처럼 시간이 지나면 바뀌는 값은 여기서 둔다) 요청 하나를 보낸다
  const runOnce = async (agent, text, setup = null) => {
    const a = (await t.api('POST', '/api/agents', agent)).json;
    const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
    if (setup) await setup(a, s.id);
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
    await t.waitFor(() => S(s.id).runs.at(-1)?.endedAt && idle(s.id), 15000, '실행 종료');
    return agentMsgs(S(s.id)).at(-1);
  };
  // 한도가 ms 뒤에 풀리는 기록(failover-app 의 resetIn 과 같은 모양). 보내기 바로 전에 둬서 앱이 판단하기 전에 풀리지 않게 넉넉히 준다
  const resetIn = (ms) => ({ claude: { windows: { five_hour: { pct: 97, resetsAt: (Date.now() + ms) / 1000 } }, observedAt: Date.now() } });
  // 그대로: 요청한 것과 같고 이유 없음
  const plain = await runOnce({ name: '배정그대로', role: '분석', provider: 'claude', model: 'opus', effort: 'high' }, '분석해줘');
  assert.deepEqual(plain.route, { asked: { provider: 'claude', model: 'opus', effort: 'high' }, ran: { provider: 'claude', model: 'opus', effort: 'high' }, why: [] });
  // 한도 임박: 다른 AI 가 맡는다
  t.app.store.usage.limits = { claude: { windows: { five_hour: { pct: 97, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } };
  const near = await runOnce({ name: '배정임박', role: '분석', provider: 'claude', model: 'opus', effort: 'high' }, '분석해줘');
  assert.equal(near.route.ran.provider, 'codex');
  assert.deepEqual([near.route.asked.provider, near.route.why], ['claude', ['near-limit']]);
  clean();
  // 자동 라우팅: 요청은 "자동"
  const auto = await runOnce({ name: '배정자동', role: '분석', provider: 'claude', routing: 'auto', routingProfile: 'balanced' }, '분석해줘');
  assert.deepEqual([auto.route.asked, auto.route.why], [{ provider: 'auto', model: '', effort: '' }, ['auto']]);
  assert.equal(auto.route.ran.provider, auto.provider);
  // 이어받기: 한도로 멈춘 뒤 다른 AI 가 이어 쓴다
  const take = await runOnce({ name: '배정이어', role: '빌드', provider: 'claude', model: 'opus', effort: 'high' }, 'QUOTAFAIL 보고서 써줘');
  assert.equal(take.provider, 'codex');
  assert.deepEqual([take.route.asked.provider, take.route.ran.provider, take.route.why], ['claude', 'codex', ['takeover']]);
  assert.ok(t.events.some((e) => e.type === 'messageMeta' && e.data.messageId === take.id && e.data.route?.why?.includes('takeover')), '화면에도 바뀐 기록을 보낸다');
  clean();
  // 곧 풀려서 기다림: 같은 AI 로 한다
  t.app.store.settings.waitForResetMin = 5;
  const waited = await runOnce({ name: '배정기다림', role: '분석', provider: 'claude', model: 'opus', effort: 'high' }, '분석해줘', () => { t.app.store.usage.limits = resetIn(2000); });
  assert.deepEqual([waited.route.ran.provider, waited.route.why], ['claude', ['wait-reset']]);
  clean();
  // 하루 예산을 다 씀: 다른 AI 가 맡는다(한도 임박이 아니다)
  const over = t.app.orch.usage.overBudget;
  try {
    t.app.orch.usage.overBudget = () => new Set(['claude']);
    const spent = await runOnce({ name: '배정예산', role: '분석', provider: 'claude', model: 'opus', effort: 'high' }, '분석해줘');
    assert.deepEqual([spent.route.ran.provider, spent.route.why], ['codex', ['daily-budget']]);
    // 기다린 뒤에는 한도가 풀리고 하루 예산만 남았다: 이유는 기다린 뒤의 값으로(한도 임박이 아니라 하루 예산)
    t.app.orch.usage.overBudget = () => new Set();
    t.app.store.settings.waitForResetMin = 5;
    let off = () => {};
    try {
      const after = await runOnce({ name: '배정기다린뒤예산', role: '분석', provider: 'claude', model: 'opus', effort: 'high' }, '분석해줘', (a) => {
        // 기다리기 시작하면(그 에이전트가 '멈춤' 상태가 되면) 그때부터 하루 예산을 다 쓴 것으로
        off = t.app.bus.on((type, d) => { if (type === 'agentState' && d.agentId === a.id && d.state === 'paused') t.app.orch.usage.overBudget = () => new Set(['claude']); });
        t.app.store.usage.limits = resetIn(2000);
      });
      assert.deepEqual([after.route.ran.provider, after.route.why], ['codex', ['wait-reset', 'daily-budget']]);
    } finally { off(); }
  } finally { t.app.orch.usage.overBudget = over; clean(); }
  // 지운 Codex 계정을 가리키는 에이전트: 기본 Codex 로 돌고, 요청한 AI 는 지운 계정 그대로 적는다
  const gone = await runOnce({ name: '배정지운계정', role: '분석', provider: 'codex', model: 'gpt-6-astra', effort: 'high' }, '분석해줘', (a) => { t.app.store.get('agents', a.id).provider = 'codex-zz9'; });
  assert.deepEqual([gone.route.asked.provider, gone.route.ran.provider, gone.route.why], ['codex-zz9', 'codex', ['account-gone']]);
  // 하루 몫: 노력을 낮춘다(저장된 에이전트는 그대로)
  const budget = t.app.orch.usage.budget;
  t.app.orch.usage.budget = (p) => (p === 'claude' ? { spent: 5, allowance: 13, over: false, steps: 1 } : null);
  try {
    const paced = await runOnce({ name: '배정하루', role: '분석', provider: 'claude', model: 'opus', effort: 'high' }, '분석해줘');
    assert.deepEqual([paced.route.asked.effort, paced.route.ran.effort, paced.route.why], ['high', 'medium', ['daily-pace']]);
  } finally { t.app.orch.usage.budget = budget; }
});

test('4. 배정 기록(목표): 진행 기록의 배정 줄은 이유에 auto 말고 다른 코드가 있을 때만(자동 라우팅만으로는 답의 route 와 칩에만)', async () => {
  clean();
  const { r, a, b, tm } = await teamStages('배정목표', { routing: 'auto', routingProfile: 'balanced' });
  try {
    // 확인 직전에: 조사(R)의 Claude 한도가 2초 뒤 풀리게(기다렸다가 같은 AI 로), 분석(A)은 지운 Codex 계정을 가리키게(목표 차례는 이미 Claude 로 끝났다)
    const sid = await goal(tm.id, '', {
      before: () => {
        t.app.store.settings.waitForResetMin = 5;
        t.app.store.usage.limits = { claude: { windows: { five_hour: { pct: 97, resetsAt: (Date.now() + 2000) / 1000 } }, observedAt: Date.now() } };
        t.app.store.get('agents', a.id).provider = 'codex-zz9';
      },
    });
    await done(sid);
    const s = S(sid);
    const lines = s.mission.log.filter((x) => x.kind === 'route');
    const whose = (x) => agentMsgs(s, (m) => m.id === x.msgId)[0]?.agentId;
    const msgOf = (id) => agentMsgs(s, (m) => m.agentId === id && !m.goalDraft && !m.review)[0];
    // 자동 라우팅만: 답에는 남고 진행 기록에는 줄이 없다
    assert.deepEqual(msgOf(b.id).route.why, ['auto']);
    assert.ok(!lines.some((x) => whose(x) === b.id), JSON.stringify(lines.map((x) => x.text)));
    // 기다렸다가 같은 AI 로: "그대로" 줄
    assert.deepEqual(msgOf(r.id).route.why, ['wait-reset']);
    const rl = lines.filter((x) => whose(x) === r.id);
    assert.equal(rl.length, 1, JSON.stringify(lines.map((x) => x.text)));
    assert.ok(rl[0].text.includes('그대로') && rl[0].text.includes('한도 풀림 기다림'), rl[0].text);
    // 지운 계정: 요청한 AI 와 돈 AI 가 다르다는 줄
    assert.deepEqual(msgOf(a.id).route.why, ['account-gone']);
    const al = lines.filter((x) => whose(x) === a.id);
    assert.equal(al.length, 1);
    assert.ok(al[0].text.includes('codex-zz9') && al[0].text.includes('인데') && al[0].text.includes('지운 계정'), al[0].text);
    assert.equal(lines.length, 2, '그 밖(요청대로 돈 검수 등)은 줄이 없다');
  } finally { t.app.store.get('agents', a.id).provider = 'claude'; clean(); }
});

test('5. 한도가 줄면 부가 일부터: 조사 담당 AI의 구독 한도가 임박이면 목표 회의 중 조사를 끄고(호출 없음) 진행 기록에 한 줄', async () => {
  clean();
  t.app.store.settings.failover = false; // 다른 AI 로 넘기지 않게(한도 임박 판단은 이어받기 설정과 상관없다)
  try {
    const { tm } = await teamStages('한도조사');
    const from = mark();
    const sid = await goal(tm.id, 'NEARLIMIT', { prep: { research: true, meeting: true }, request: 'CHECKME 정리해 줘' });
    // 구독 한도 상한(결정 0026, 기본 90%): 97%를 알린 뒤 다음 일 앞에서 한 번 묻는다. "계속"이면 이 목표에서 그 AI 로는 다시 묻지 않고, 부가 일은 지금처럼 멈춘다
    await waitHold(sid, 'limitcap');
    assert.equal((await ctl(sid, 'accept')).json.ok, true);
    await done(sid);
    assert.equal(S(sid).mission.log.filter((x) => x.kind === 'limitcap').length, 1);
    const s = S(sid);
    const turn = agentMsgs(s, (x) => x.meeting?.phase === 'turn');
    assert.deepEqual(turn.map((x) => x.check?.status), ['near']);
    assert.equal(agentMsgs(s, (x) => x.meeting?.phase === 'research').length, 0, '회의 중 조사를 하지 않았다');
    const lines = s.mission.log.filter((x) => x.kind === 'note' && x.text.includes('회의 중 조사를 껐어'));
    assert.equal(lines.length, 1, '회의마다 한 줄');
    assert.ok(lines[0].text.includes('사용량 한도'), lines[0].text);
    const conclude = prompts(from).find((p) => p.includes('[회의 — 결론 내기]'));
    assert.ok(conclude.includes('확인 못 함: 조사 담당 AI의 사용량 한도가 거의 다 차서 회의 중 조사를 껐어.'));
    assert.equal(s.mission.status, 'done', '계획·검수는 그대로 돈다');
  } finally { clean(); }
});

test('6. 막힘 블록의 종류(순수 함수): kind 는 네 값만, 모르거나 없으면 unknown. 막힘 안내에 네 값을 한 줄로', () => {
  const blk = (o) => `해 보니 안 돼.\n\n\`\`\`oc-blocked\n${typeof o === 'string' ? o : JSON.stringify(o)}\n\`\`\``;
  assert.deepEqual(BLOCKED_KINDS, ['unclear', 'input', 'capability', 'dependency']);
  assert.equal(parseBlocked(blk({ reason: '지시가 둘로 읽혀', kind: 'unclear' })).kind, 'unclear');
  assert.equal(parseBlocked(blk({ reason: 'r', kind: ' Dependency ' })).kind, 'dependency', '대소문자·공백 무시');
  assert.equal(parseBlocked(blk({ reason: 'r', kind: 'unclear|input|capability|dependency' })).kind, 'unknown', '예시를 그대로 베끼면 모름');
  assert.equal(parseBlocked(blk({ reason: 'r', kind: '권한' })).kind, 'unknown');
  assert.equal(parseBlocked(blk({ reason: 'r' })).kind, 'unknown');
  assert.equal(parseBlocked(blk('JSON 아닌 이유')).kind, 'unknown');
  assert.equal(parseBlocked(blk({ reason: 'r', kind: 'input' })).reason, 'r', '이유는 그대로');
  const rule = blockedRule();
  for (const k of BLOCKED_KINDS) assert.ok(rule.includes(k), k);
  assert.ok(rule.includes('"kind"'), '블록 예시에 kind 칸');
});

test('7. 실패를 종류로: 보통 오류는 "원인 모름", 막힘은 에이전트가 적은 종류, 기다린 앞 카드가 결과 없이 끝났는데 뒤 카드도 실패하면 "넘겨받음"', async () => {
  clean();
  // (1) 단계표의 보통 오류(한도 아님): 진행 기록에 원인 모름(unknown) 한 줄
  const st = await teamStages('보통오류');
  const s1 = await goal(st.tm.id, `MIXFAIL:${st.b.name}`);
  await waitHold(s1, 'error');
  const err = S(s1).mission.log.filter((x) => x.fail === 'unknown');
  assert.equal(err.length, 1, JSON.stringify(S(s1).mission.log.map((x) => [x.text, x.fail])));
  assert.ok(err[0].text.includes(st.b.name) && err[0].text.includes('"빌드"'), err[0].text);
  assert.equal((await ctl(s1, 'stop')).json.ok, true);
  await done(s1);
  // (2) 일 카드: k1 이 막힘(에이전트가 적은 종류: dependency) → 받아들이기 → k1 을 기다린 k2 가 오류 → 넘겨받음(input)
  const c = await teamCards('넘겨받음');
  const s2 = await goal(c.tm.id, `PLANDEP CARDBLOCK BLOCKKIND:dependency MIXFAIL:${c.b.name}`, { work: 'cards' });
  await waitHold(s2, 'mission', 'blocked');
  const blocked = S(s2).mission.log.find((x) => x.fail === 'blocked');
  assert.equal(blocked.agentKind, 'dependency', '에이전트가 블록에 적은 종류');
  assert.equal(S(s2).runs.at(-1).hold.blocked[0].kind, 'dependency');
  assert.equal((await ctl(s2, 'accept')).json.ok, true);
  await waitHold(s2, 'error');
  const input = S(s2).mission.log.filter((x) => x.fail === 'input');
  assert.equal(input.length, 1, JSON.stringify(S(s2).mission.log.map((x) => [x.text, x.fail])));
  assert.ok(input[0].text.includes('k2') && input[0].text.includes('k1'), input[0].text);
  assert.equal(S(s2).mission.log.filter((x) => x.fail === 'unknown').length, 0, '넘겨받음으로 적었으면 원인 모름 줄은 없다');
  assert.equal((await ctl(s2, 'stop')).json.ok, true);
  await done(s2);
  // (3) 종류를 안 적은 막힘은 unknown, 뒤 카드가 구멍으로 끝나도 넘겨받음
  const s3 = await goal(c.tm.id, 'PLANDEP CARDBLOCK K2NOTAIL', { work: 'cards' });
  await waitHold(s3, 'mission', 'blocked');
  assert.equal(S(s3).mission.log.find((x) => x.fail === 'blocked').agentKind, 'unknown');
  assert.equal((await ctl(s3, 'accept')).json.ok, true);
  await done(s3);
  const in3 = S(s3).mission.log.filter((x) => x.fail === 'input');
  assert.equal(in3.length, 1, JSON.stringify(S(s3).mission.log.map((x) => [x.text, x.fail])));
  assert.ok(in3[0].text.includes('k2') && in3[0].text.includes('구멍'), in3[0].text);
  // (4) 한 단계에서 한 사람은 사용량 한도, 한 사람은 보통 오류(전부 한도가 아니라서 한도 대기가 아닌 오류 대기): 한도 쪽은 바깥 장애(outside), 다른 쪽은 원인 모름
  t.app.store.settings.failover = false; // 다른 AI 가 이어받지 않게
  try {
    const q = await mk('종류한도', '빌드');
    const f = await mk('종류오류', '빌드');
    const qr = await mk('종류조사', '조사');
    const qt = await mkTeam('종류팀', [{ label: '조사', agentIds: [qr.id] }, { label: '빌드', agentIds: [q.id, f.id] }]);
    const s4 = await goal(qt.id, `MIXQUOTA:${q.name} MIXFAIL:${f.name}`);
    await waitHold(s4, 'error');
    const errs = S(s4).mission.log.filter((x) => x.kind === 'error');
    assert.deepEqual(errs.map((x) => [x.text.includes(q.name) ? 'q' : x.text.includes(f.name) ? 'f' : '?', x.fail]).sort(), [['f', 'unknown'], ['q', 'outside']], JSON.stringify(errs.map((x) => x.text)));
    assert.equal((await ctl(s4, 'stop')).json.ok, true);
    await done(s4);
  } finally { clean(); }
});

test('8. 화면 도움 함수(순수): 모델 칩의 툴팁(요청한 것·이유), "에이전트가 씀" 표시를 붙일 답', () => {
  const T = (s, v = {}) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
  const label = (p) => ({ claude: 'Claude', codex: 'Codex' }[p] || p);
  assert.equal(routeTip(null, { t: T, label }), '');
  assert.equal(routeTip({ asked: { provider: 'claude', model: 'opus', effort: 'high' }, ran: { provider: 'claude', model: 'opus', effort: 'high' }, why: [] }, { t: T, label }), '', '요청대로 돌았으면 툴팁 없음');
  const tip = routeTip({ asked: { provider: 'claude', model: 'opus', effort: 'high' }, ran: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }, why: ['near-limit', 'takeover'] }, { t: T, label });
  assert.ok(tip.includes('Claude · opus · high') && tip.includes('한도 임박') && tip.includes('이어받기'), tip);
  assert.ok(routeTip({ asked: { provider: 'auto', model: '', effort: '' }, ran: { provider: 'codex', model: 'm', effort: '' }, why: ['auto'] }, { t: T, label }).includes('자동 라우팅'));
  assert.ok(routeTip({ asked: { provider: 'claude', model: 'opus', effort: 'high' }, ran: { provider: 'claude', model: 'opus', effort: 'high' }, why: ['wait-reset'] }, { t: T, label }).includes('한도 풀림 기다림'), '같아도 이유가 있으면 보인다');
  assert.ok(routeTip({ asked: { provider: 'claude', model: 'opus', effort: 'high' }, ran: { provider: 'codex', model: 'm', effort: 'high' }, why: ['daily-budget'] }, { t: T, label }).includes('하루 예산 다 씀'));
  assert.ok(routeTip({ asked: { provider: 'codex-zz9', model: 'm', effort: '' }, ran: { provider: 'codex', model: 'm', effort: '' }, why: ['account-gone'] }, { t: T, label }).includes('지운 계정'));
  // 출처 표시: 목표 일 실행의 일 단계·카드 답과 회의 결론만(보통 실행·조사·검수·회의 차례는 아니다)
  const work = { id: 'r1', mission: 'work' };
  const plainRun = { id: 'r2' };
  assert.equal(agentWrote({ runId: 'r1' }, work), true, '목표의 일 단계 답');
  assert.equal(agentWrote({ runId: 'r1', card: { id: 'k1' } }, null), true, '일 카드 답(실행 기록이 잘렸어도)');
  assert.equal(agentWrote({ runId: 'r1', meeting: { phase: 'conclude' }, once: true }, work), true, '목표 회의 결론');
  assert.equal(agentWrote({ runId: 'r1', meeting: { phase: 'turn' }, once: true }, work), false);
  assert.equal(agentWrote({ runId: 'r1', review: { round: 1 }, once: true }, work), false);
  assert.equal(agentWrote({ runId: 'r1', prep: { kind: 'research' }, once: true }, work), false);
  assert.equal(agentWrote({ runId: 'r2' }, plainRun), false, '보통 실행 답은 그대로');
  assert.equal(agentWrote({ runId: 'r2', meeting: { phase: 'conclude' } }, plainRun), false);
});

test('9. 묻고 할 일: 목표의 일 단계·카드 프롬프트에만 한 줄(조사·회의·계획·검수에는 없다). 물을 수 없는 차례는 하지 말라고. [이어서] 줄에 다시 하지 말 것', async () => {
  clean();
  assert.ok(outsideRule(true).includes('질문 블록'));
  assert.ok(!outsideRule(false).includes('질문 블록') && outsideRule(false).includes('하지 마'));
  for (const w of ['원격 저장소', '배포', '메일', '메시지', '게시', '결제', '작업 폴더 밖']) assert.ok(outsideRule(true).includes(w), w);
  assert.equal(resumeSent(), '이미 밖으로 보낸 것은 다시 하지 마.');
  const line = outsideRule(true);
  // 단계표(조사·회의 먼저): 일 단계 3개에만
  const { tm } = await teamStages('묻고');
  const from = mark();
  const sid = await goal(tm.id, '', { prep: { research: true, meeting: true } });
  await done(sid);
  const ps = prompts(from);
  const has = (p) => p.includes(line);
  const work = ps.filter((p) => p.includes('[팀 작업]') && !p.includes('[회의 — ') && !p.includes('[기준 판정'));
  assert.equal(work.length, 3);
  assert.ok(work.every(has), '일 단계마다');
  // 머리 줄은 줄 맨 앞에서 찾는다(새 대화의 첫 프롬프트에는 호출마다 달라지는 지시가 앞머리로 붙는다, 결정 0023)
  // 읽기 전용 대목은 종류마다 하나 이상 있었고(빈 목록이면 아래 검사가 저절로 통과한다) 어느 것에도 없다
  const ro = { scan: /^\[조사 전 훑어보기\]/m, questions: /^\[조사 질문 뽑기\]$/m, research: /^\[조사 — 질문 \d+\/\d+\]/m, meeting: /\[회의 — /, review: /\[기준 판정 — / };
  for (const [k, re] of Object.entries(ro)) {
    const got = ps.filter((p) => re.test(p));
    assert.ok(got.length >= 1, `${k} 프롬프트가 있다`);
    assert.ok(got.every((p) => !has(p)), `${k} 에는 없다`);
  }
  // 조립된 프롬프트 전체에서: 그 줄이 든 프롬프트는 일 단계 셋뿐이다(목표 차례·준비 대목·검수 어디에도 없다)
  assert.deepEqual(ps.filter(has), work, '일 단계에만');
  // 일 카드: 카드마다, 계획에는 없다
  const c = await teamCards('묻고카드');
  const from2 = mark();
  const s2 = await goal(c.tm.id, '', { work: 'cards' });
  await done(s2);
  const ps2 = prompts(from2);
  const cards = ps2.filter((p) => /^\[일 카드 k\d\]$/m.test(p));
  assert.ok(cards.length >= 2 && cards.every(has), '카드마다');
  const plans = ps2.filter((p) => /^\[일 계획\]$/m.test(p));
  assert.ok(plans.length >= 1 && plans.every((p) => !has(p)), '계획에는 없다');
  assert.deepEqual(ps2.filter(has), cards, '카드에만(계획·검수·목표 차례에는 없다)');
  // 회의 단계의 되돌림(진행자 혼자, 회의 없이 자기 권한으로 고친다): 그 차례에는 붙고(막힘 출구는 회의 단계에서 읽지 않으니 없다), 회의 차례에는 없다
  const ma = await mk('묻고회의정리', '정리');
  const mc1 = await mk('묻고회의의장', '분석');
  const mc2 = await mk('묻고회의참석', '빌드');
  const mt = await mkTeam('묻고회의팀', [{ label: '정리', agentIds: [ma.id] }, { label: '회의', agentIds: [mc1.id, mc2.id], meeting: { rounds: 1, chairId: mc1.id } }]);
  const from4 = mark();
  const s4 = await goal(mt.id, 'REVIEWFAIL');
  await done(s4);
  assert.equal(S(s4).mission.returns, 1, '한 번 되돌렸다');
  const ps4 = prompts(from4);
  const fix = ps4.filter((p) => p.includes('[지난 검수에서 걸린 것'));
  assert.equal(fix.length, 1);
  assert.ok(has(fix[0]) && !fix[0].includes('```oc-blocked'), '되돌림 차례에는 묻고 할 일만');
  const meetPs = ps4.filter((p) => p.includes('[회의 — '));
  assert.ok(meetPs.length >= 2 && meetPs.every((p) => !has(p)), '회의 차례에는 없다');
  // 사용자에게 묻기를 끈 설정이면 묻는 대신 하지 말라고
  t.app.store.settings.agentAsks = false;
  try {
    const from3 = mark();
    const s3 = await goal(tm.id);
    await done(s3);
    const w3 = prompts(from3).filter((p) => p.includes('[팀 작업]') && !p.includes('[기준 판정'));
    assert.ok(w3.length && w3.every((p) => p.includes(outsideRule(false)) && !has(p)));
  } finally { t.app.store.settings.agentAsks = true; }
});

test('10. 회의 중 조사를 끈 이유는 차례마다 다시 본다: 이유가 바뀌면(한도 임박 → 남은 호출 적음) 칩과 진행 기록이 따라가고, 다시 켜지면 그것도 한 줄', async () => {
  clean();
  t.app.store.settings.failover = false; // 쉬는 표시가 있어도 다른 AI 로 넘기지 않게
  let off = () => {};
  try {
    // 조사(R) → 회의(A 진행자, P, Q · 3바퀴). P 는 1바퀴 입장을 달리해 차례 바퀴를 하고, 차례마다 질문 블록을 붙인다
    const r = await mk('이유조사', '조사');
    const a = await mk('이유의장', '분석');
    const p = await mk('이유참석1', '기획');
    const q = await mk('이유참석2', '정리');
    const tm = await mkTeam('이유팀', [{ label: '조사', agentIds: [r.id] }, { label: '회의', agentIds: [a.id, p.id, q.id], meeting: { rounds: 3, chairId: a.id } }]);
    let sid = '';
    let cap = 0;
    const seen = []; // 조사 상태가 붙은 차례 글(차례마다 처음 한 번)
    // 차례 글에 조사 상태가 붙는 순간(같은 차례 안, 다음 차례 판단 전)에 조건을 바꾼다: 첫 차례 뒤 쉬는 표시를 풀고 상한을 낮춰(한도 임박 → 남은 호출 적음),
    // 둘째 차례 뒤 상한을 되돌린다(다시 켬). 상태가 무엇이든 차례 순서로 바꿔서, 고친 것이 깨져도 호출 상한 질문에 묶이지 않고 바로 실패한다
    off = t.app.bus.on((type, d) => {
      const tm = type === 'message' && d.sessionId === sid ? d.message : null;
      if (tm?.meeting?.phase !== 'turn' || !tm.check?.status || seen.includes(tm.id)) return;
      seen.push(tm.id);
      const m = S(sid).mission;
      if (seen.length === 1) { t.app.orch.cooldown.clear('claude'); cap = m.calls.cap; m.calls.cap = m.calls.used + 1; }
      if (seen.length === 2) m.calls.cap = cap;
    });
    sid = await goal(tm.id, '', { request: `CHECKME STANCEB:${p.name} 정리해 줘`, before: (id) => { sid = id; t.app.orch.cooldown.mark('claude', { until: Date.now() + 600000 }); } });
    await done(sid);
    const s = S(sid);
    const turns = agentMsgs(s, (x) => x.meeting?.phase === 'turn');
    assert.deepEqual(turns.map((x) => x.check?.status).slice(0, 2), ['near', 'low'], JSON.stringify(turns.map((x) => x.check?.status)));
    assert.ok(turns.slice(2).every((x) => !['near', 'low'].includes(x.check?.status)), '다시 켜진 뒤의 질문은 조사한다');
    assert.ok(agentMsgs(s, (x) => x.meeting?.phase === 'research').length >= 1, '다시 켜진 뒤 조사를 했다');
    const notes = s.mission.log.filter((x) => x.kind === 'note' && x.text.includes('회의 중 조사'));
    assert.equal(notes.length, 3, JSON.stringify(notes.map((x) => x.text)));
    assert.ok(notes[0].text.includes('사용량 한도'), notes[0].text);
    assert.ok(notes[1].text.includes('남은 호출'), notes[1].text);
    assert.ok(notes[2].text.includes('다시 켰어'), notes[2].text);
  } finally { off(); clean(); }
});

test('11. 블록 여는 줄(순수 함수): 줄 맨 앞 백틱 세 개 + 이름 + 줄 끝·공백만 블록이다. 판정 답의 근거 글에 인용한 예시·글 가운데 적은 이름·더 긴 이름은 섞인 블록이 아니다', () => {
  // 대목마다 받는 블록 표 쪽
  assert.deepEqual(blocksIn('글 가운데 ```oc-ask 라고 적었어\n```oc-cards\n{}\n```'), ['oc-cards'], '글 가운데 적은 이름은 블록이 아니다');
  assert.deepEqual(blocksIn('```oc-research-x\n{}\n```\n```oc-ask {"a":1}\n```'), ['oc-research-x', 'oc-ask'], '이름은 끝까지 읽고, 이름 뒤 공백은 된다');
  assert.deepEqual(blocksIn('````oc-ask\n{}\n````\n  ```oc-cards\n{}\n```'), [], '백틱 네 개·줄 앞 공백은 블록이 아니다');
  assert.deepEqual(blocksIn('```oc-ask\r\n{}\r\n```'), ['oc-ask'], 'CRLF 줄 끝');
  assert.deepEqual(foreignBlocks('review', '```oc-research-x\n{}\n```\n```oc-review\n{}\n```'), ['oc-research-x'], '더 긴 이름은 그 이름 그대로(표에 없으니 받지 않는 블록)');
  // 판정 답 쪽
  const ids = ['c1'];
  const verdict = (evidence) => '```oc-review\n' + JSON.stringify({ nonce: 'n0', results: [{ id: 'c1', verdict: 'pass', evidence }] }) + '\n```';
  const err = (text) => parseReview(text, { nonce: 'n0', ids }).error;
  assert.equal(err(`판정했어.\n\n${verdict('답 끝의 ```oc-ask\n{"questions":[]}\n``` 블록을 열어 봤어')}`), undefined, '근거 글에 인용한 블록 예시는 섞인 블록이 아니다');
  assert.equal(err(`답에 \`\`\`oc-ask 블록은 없었어.\n\n${verdict('파일:1 확인')}`), undefined, '글 가운데 적은 이름은 섞인 블록이 아니다');
  assert.equal(err(`앞 글\n\`\`\`oc-research-x\n{}\n\`\`\`\n\n${verdict('파일:1 확인')}`), undefined, '더 긴 이름은 표의 블록이 아니다');
  assert.equal(err(`앞 글\n\`\`\`oc-research\n{}\n\`\`\`\n\n${verdict('파일:1 확인')}`), 'mixed', '판정 블록 밖에 따로 연 표의 블록은 그대로 거른다');
  assert.equal(err(`앞 글\n\`\`\`oc-ask {"questions":[]}\n\`\`\`\n\n${verdict('파일:1 확인')}`), 'mixed', '이름 뒤 공백');
});
