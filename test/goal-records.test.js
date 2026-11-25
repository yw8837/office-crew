// 목표 모드의 구멍과 기록(결정 0022): 대목마다 받는 블록 표, 에이전트마다의 배정 기록(요청한 AI·실제로 돈 AI·이유),
// 한도가 줄면 부가 일부터 멈추기(회의 중 조사), 실패를 종류로 적기(막힘 블록의 종류·넘겨받음·보통 오류), 화면의 도움 함수, 묻고 할 일 지시 한 줄.
// 가짜 CLI 만 쓴다(실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bindLang } from '../server/i18n.js';
import {
  BLOCK_ACCEPTS, BLOCK_NAMES, blocksIn, foreignBlocks, blockPart, parseBlocked, blockedRule, BLOCKED_KINDS, outsideRule, resumeSent,
  goalBlock, questionsPrompt, scanPrompt, researchPrompt, planPrompt, reviewPrompt,
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

// 요청 → 카드 → 확인. prep: 고른 체크(지정하지 않으면 조사·회의 없이). work: 'stages'|'cards'. signal: 목표 문장을 신호어가 든 것으로 고쳐서 확인
async function goal(teamId, signal = '', { prep = { research: false, meeting: false }, work = 'stages', request = '정리해 줘' } = {}) {
  const s = (await t.api('POST', '/api/sessions', { teamId })).json;
  assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: request });
  await t.waitFor(() => S(s.id).mission?.status === 'draft' && idle(s.id), 20000, '목표 카드');
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
  assert.deepEqual(Object.keys(BLOCK_ACCEPTS).sort(), ['cards', 'goal', 'meeting', 'plan', 'questions', 'research', 'review', 'scan', 'work']);
  assert.deepEqual([...BLOCK_NAMES].sort(), ['oc-ask', 'oc-blocked', 'oc-cards', 'oc-check', 'oc-goal', 'oc-research', 'oc-review', 'oc-verdict']);
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
  fits('cards', `${blockedRule()}\n${askNote()}`);
  fits('review', reviewPrompt({ goal: 'g', criteria: [{ id: 'c1', text: '기준' }], nonce: 'n' }));
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

test('3. 배정 기록: 답마다 요청한 AI·실제로 돈 AI·이유 코드(자동 라우팅·한도 임박·하루 몫·이어받기·기다림), 이유는 코드가 아는 것만', async () => {
  clean();
  const runOnce = async (agent, text) => {
    const a = (await t.api('POST', '/api/agents', agent)).json;
    const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
    await t.waitFor(() => S(s.id).runs.at(-1)?.endedAt && idle(s.id), 15000, '실행 종료');
    return agentMsgs(S(s.id)).at(-1);
  };
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
  t.app.store.usage.limits = { claude: { windows: { five_hour: { pct: 97, resetsAt: (Date.now() + 1500) / 1000 } }, observedAt: Date.now() } }; // failover-app 의 resetIn(1500)과 같은 모양
  const waited = await runOnce({ name: '배정기다림', role: '분석', provider: 'claude', model: 'opus', effort: 'high' }, '분석해줘');
  assert.deepEqual([waited.route.ran.provider, waited.route.why], ['claude', ['wait-reset']]);
  clean();
  // 하루 몫: 노력을 낮춘다(저장된 에이전트는 그대로)
  const budget = t.app.orch.usage.budget;
  t.app.orch.usage.budget = (p) => (p === 'claude' ? { spent: 5, allowance: 13, over: false, steps: 1 } : null);
  try {
    const paced = await runOnce({ name: '배정하루', role: '분석', provider: 'claude', model: 'opus', effort: 'high' }, '분석해줘');
    assert.deepEqual([paced.route.asked.effort, paced.route.ran.effort, paced.route.why], ['high', 'medium', ['daily-pace']]);
  } finally { t.app.orch.usage.budget = budget; }
});

test('4. 배정 기록(목표): 요청한 AI와 실제로 돈 AI가 다르면 진행 기록에 한 줄(같으면 줄 없음)', async () => {
  clean();
  const { b, tm } = await teamStages('배정목표', { routing: 'auto', routingProfile: 'balanced' });
  const sid = await goal(tm.id);
  await done(sid);
  const s = S(sid);
  const lines = s.mission.log.filter((x) => x.kind === 'route');
  const bm = agentMsgs(s, (m) => m.agentId === b.id && !m.goalDraft).at(-1);
  assert.deepEqual(bm.route.why, ['auto']);
  assert.ok(lines.some((x) => x.msgId === bm.id && x.text.includes('자동 라우팅')), JSON.stringify(s.mission.log.map((x) => x.text)));
  assert.ok(lines.every((x) => agentMsgs(s, (m) => m.id === x.msgId)[0]?.agentId === b.id), '요청대로 돈 에이전트는 줄이 없다');
});

test('5. 한도가 줄면 부가 일부터: 조사 담당 AI의 구독 한도가 임박이면 목표 회의 중 조사를 끄고(호출 없음) 진행 기록에 한 줄', async () => {
  clean();
  t.app.store.settings.failover = false; // 다른 AI 로 넘기지 않게(한도 임박 판단은 이어받기 설정과 상관없다)
  try {
    const { tm } = await teamStages('한도조사');
    const from = mark();
    const sid = await goal(tm.id, 'NEARLIMIT', { prep: { research: true, meeting: true }, request: 'CHECKME 정리해 줘' });
    await done(sid);
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
  assert.ok(ps.filter((p) => /^\[조사 (전 훑어보기|질문 뽑기|— 질문)/.test(p) || p.includes('[회의 — ') || p.includes('[기준 판정 — ')).every((p) => !has(p)), '조사·회의·검수에는 없다');
  // 일 카드: 카드마다, 계획에는 없다
  const c = await teamCards('묻고카드');
  const from2 = mark();
  const s2 = await goal(c.tm.id, '', { work: 'cards' });
  await done(s2);
  const ps2 = prompts(from2);
  const cards = ps2.filter((p) => /^\[일 카드 k\d\]$/m.test(p));
  assert.ok(cards.length >= 2 && cards.every(has), '카드마다');
  assert.ok(ps2.filter((p) => /^\[일 계획\]$/m.test(p)).every((p) => !has(p)), '계획에는 없다');
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
