// 목표 모드(결정 0019): 시작 전 호출 어림(범위), 끝난 뒤 실제 호출 수, 받은 구독 한도 기록의 % 줄, 한도에 걸려 멈췄을 때의 한도 대기(초기화 뒤 이어서).
// 가짜 CLI 만 쓴다(실제 AI 사용량 0). 한도가 풀린 것은 가짜 CLI 기록 옆의 ".lift" 파일로 흉내 낸다(test/fake-cli/fake-claude.js 의 WORKQUOTA·REVIEWQUOTA).
// 자동 이어서의 기다림은 OFFICE_CREW_QUOTA_RESUME_MS 로 줄인다(초기화 시각은 그대로 보인다)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { bindLang } from '../server/i18n.js';
import { estimateParts, estimateCalls, reviewPlan, resumePoint, quotaDelay, MISSION_CALL_CAP, RETURN_CAP, CARD_COUNT, QUOTA_AUTO, QUOTA_SLACK } from '../server/mission.js';
import { limitResetAt } from '../server/failover.js';
import { sumEstimate, limitRows, recordAge } from '../public/js/mission-numbers.js';
import { attentionOf } from '../server/store.js';
import { startTestApp, freePort } from './helpers.js';

bindLang(() => 'ko'); // 순수 함수의 문구(한국어 원문)를 검사한다
let t = null;
const app = async () => (t ||= await startTestApp());
const opened = []; // 이 파일이 따로 켠 앱(끊김 흉내)
after(async () => {
  delete process.env.OFFICE_CREW_QUOTA_RESUME_MS;
  for (const a of opened) { try { await a.close(); } catch { /* 이미 닫힘·윈도우 파일 잠금 무시 */ } }
  if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } }
});

const S = (id) => t.app.store.getSession(id);
const mk = async (name, role, extra = {}) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual', ...extra })).json;
const mkTeam = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const ctl = (sid, action, extra = {}) => t.api('POST', `/api/sessions/${sid}/control`, { action, ...extra });
const idle = (sid) => !t.app.orch.ctx.has(sid);
const cardOf = (sid) => S(sid).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides });
const waitEnd = (sid) => t.waitFor(() => S(sid).runs.length >= 2 && S(sid).runs.at(-1).endedAt && idle(sid), 30000, '목표 실행 끝');
const holdOf = (sid, pred = () => true) => t.waitFor(() => { const h = S(sid).runs.at(-1)?.hold; return h?.reason === 'quota' && pred(h) && h; }, 30000, '한도 대기');
const lift = (on) => { const f = `${process.env.FAKE_LOG}.lift`; if (on) fs.writeFileSync(f, ''); else fs.rmSync(f, { force: true }); };
// 한도 기록·쉬는 표시·풀림 표시를 지운다(앞 테스트의 가짜 한도 오류가 뒤 테스트의 초기화 시각에 섞이지 않게)
const clean = () => { lift(false); t.app.orch.cooldown.map.clear(); t.app.store.usage.limits = {}; };
const prompts = (from) => t.fakeLog().slice(from).filter((l) => l.cli === 'claude' && l.text !== undefined).map((l) => l.text);
// 요청 → 카드. 확인은 따로(어림 조각을 먼저 본다)
async function draft(teamId, request = '정리해 줘') {
  const s = (await t.api('POST', '/api/sessions', { teamId })).json;
  assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: request });
  await t.waitFor(() => S(s.id).mission?.status === 'draft' && idle(s.id), 20000, '목표 카드');
  return s.id;
}
// 카드가 보여 주던 값으로 확인(목표 문장에 신호어). work·prep 을 고를 수 있다(없으면 카드 기본값, 조사·회의는 끔)
async function confirm(sid, signal = '', { work = null, prep = { research: false, meeting: false } } = {}) {
  const c = cardOf(sid);
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const body = { missionId: S(sid).mission.id, expected: shown(c), review, work: work || c.work.on,
    prep: { ...prep, lead: c.prep.lead.id, researchers: c.prep.research.who.map((w) => w.id), attendees: c.prep.meeting.who.map((w) => w.id) },
    ...(signal ? { edited: { ...shown(c), goal: `${signal} 목표` } } : {}) };
  const r = await t.api('POST', `/api/sessions/${sid}/mission/confirm`, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
const goal = async (teamId, signal, opts) => { const sid = await draft(teamId); await confirm(sid, signal, opts); return sid; };

// ── 순수 함수: 어림 ──
const A = [
  { id: 'l', role: '분석' }, { id: 's', role: '조사' }, { id: 'b', role: '빌드' }, { id: 'w', role: '작성' }, { id: 'r', role: '검수' }, { id: 'r2', role: '테스트' }, { id: 'r3', role: '검수' },
];
const T = (...stages) => ({ stages: stages.map((x) => (Array.isArray(x) ? { agentIds: x } : x)) });
const subsets = (xs) => xs.reduce((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

test('1. 어림 순수 함수: 단계표·일 카드 방식, 조사·회의 조합, 남기기, 되돌림(최소 0 / 최대 RETURN_CAP 번)', () => {
  // 조사 → 분석(진행자) → 빌드 → 검수(기준 판정으로 대신해 빠질 수 있다). 목표 잡기에 1번 썼다
  const t1 = T(['l'], ['s'], ['b'], ['r']);
  const e = (o) => estimateCalls(t1, A, { lead: 'l', spent: 1, ...o });
  const pick = (min, max) => ({ min, max, returns: RETURN_CAP, cap: MISSION_CALL_CAP, spent: 1 });
  // 단계표: 1(목표) + 3(남은 일 단계) + 1(판정) = 5, 최대 + 되돌림 1번 × (마지막 일 단계 1 + 판정 1)
  assert.deepEqual(e({ work: 'stages' }), pick(5, 7));
  // 조사 3~8(훑어보기 1 + 질문 뽑기 1 + 질문 1~6), 회의(참석자 2명·2바퀴 = 4, 회의 중 조사 최대 3)
  assert.deepEqual(e({ work: 'stages', prep: { research: true } }), pick(8, 15));
  assert.deepEqual(e({ work: 'stages', prep: { meeting: true } }), pick(9, 14));
  assert.deepEqual(e({ work: 'stages', prep: { research: true, meeting: true } }), pick(12, 22));
  // 남긴 검수 단계는 한 단계로 돈다(되돌릴 곳은 그대로 빌드)
  assert.deepEqual(e({ work: 'stages', keep: [3] }), pick(6, 8));
  // 일 카드: 계획 1 + 카드 1~CARD_COUNT, 되돌림은 마지막 카드 단계(한 단계에 한 사람 한 장 → 최대 명단 수 3) + 판정
  assert.deepEqual(e({ work: 'cards' }), pick(1 + 2 + 1, 1 + 1 + CARD_COUNT + 1 + (3 + 1)));
  assert.deepEqual(e({ work: 'cards', prep: { research: true, meeting: true } }), pick(4 + 3 + 4, 13 + 8 + 7));
  // 회의 단계(참석자 3명 = 1바퀴 합의면 5, 아니면 7) + 승인 관문이 있는 검수 단계(빠지지 않는다). 일 카드는 못 쓴다(관문·회의)
  const t2 = T({ agentIds: ['l', 's', 'w'], meeting: { chairId: 'l', rounds: 2 } }, ['b', 'w'], { agentIds: ['r'], approve: true });
  const p2 = estimateParts(t2, A, { lead: 'l', spent: 1 });
  assert.equal(p2.cards, null);
  assert.deepEqual(p2.stages.map((x) => [x.index, x.min, x.max, x.review, x.drop, x.last]), [[0, 5, 7, false, false, 1], [1, 2, 2, false, false, 2], [2, 1, 1, true, false, 1]]);
  // 1 + 회의 5~7 + 2 + 1 + 판정 1 = 10~12, 되돌림은 마지막 일 단계(빌드·작성 2명) + 판정 = 3
  assert.deepEqual(estimateCalls(t2, A, { lead: 'l', spent: 1, work: 'cards' }), pick(10, 12 + 3), '일 카드를 못 쓰는 팀은 단계표로 센다');
  // 검수 단계뿐인 팀: 남기기에 따라 되돌릴 곳이 바뀐다(남은 마지막 단계)
  const t3 = T({ agentIds: ['r'], approve: true }, ['r2', 'r3']);
  assert.deepEqual(estimateCalls(t3, A, { lead: 'r', spent: 1 }), pick(3, 5));
  assert.deepEqual(estimateCalls(t3, A, { lead: 'r', spent: 1, keep: [1] }), pick(5, 8));
  // 검수자가 없으면 판정도 자동 되돌림도 없다
  assert.deepEqual(estimateCalls(T(['l']), A, { lead: 'l', spent: 2 }), { min: 3, max: 3, returns: 0, cap: MISSION_CALL_CAP, spent: 2 });
  // 화면의 더하기(sumEstimate)가 고르는 되돌릴 단계는 서버의 reviewPlan 과 같다(남기기 조합마다)
  for (const [team, lead] of [[t1, 'l'], [t2, 'l'], [t3, 'r']]) {
    const parts = estimateParts(team, A, { lead });
    for (const kept of subsets(reviewPlan(team, A, lead).droppable)) {
      const rp = reviewPlan(team, A, lead, kept);
      const left = parts.stages.filter((x) => !x.drop || kept.includes(x.index));
      const back = left.filter((x) => !x.review).at(-1) || left.at(-1);
      const idx = (team.stages.map((st, index) => ({ st, index })).filter(({ index }) => !rp.dropped.includes(index)))[rp.returnStage].index;
      assert.equal(back.index, idx, JSON.stringify(kept));
    }
  }
  // 옛 카드(조각 없음)도 깨지지 않는다
  assert.deepEqual(sumEstimate(undefined), { min: 0, max: 0, returns: 0, cap: 0, spent: 0 });
});

test('2. 구독 한도 % 줄: 받은 기록 중 유효한 창만(지난 창·사용률 없는 창은 빼고, 보일 창이 없으면 줄이 없다), 몇 분 전 기록인지', () => {
  const now = Date.UTC(2026, 10, 25, 3, 0);
  const sec = (ms) => Math.floor(ms / 1000);
  const limits = {
    claude: { windows: { seven_day: { pct: 50, resetsAt: sec(now) + 86400 }, five_hour: { pct: 25, resetsAt: sec(now) + 3600 }, extra: { pct: null, resetsAt: sec(now) + 60 } }, observedAt: now - 12 * 60000 },
    codex: { windows: { five_hour: { pct: 90, resetsAt: sec(now) - 60 } }, observedAt: now - 60000 }, // 지난 창뿐
    gemini: { windows: { primary: { pct: 10 } }, observedAt: 0 }, // 초기화 시각이 없는 창은 유효, 관측 시각을 모르면 ago null
  };
  assert.deepEqual(limitRows(limits, ['claude', 'codex', 'gemini', 'hermes'], now), [
    { provider: 'claude', windows: [{ key: 'five_hour', pct: 25, resetsAt: sec(now) + 3600 }, { key: 'seven_day', pct: 50, resetsAt: sec(now) + 86400 }], observedAt: now - 12 * 60000, ago: 12 },
    { provider: 'gemini', windows: [{ key: 'primary', pct: 10, resetsAt: 0 }], observedAt: 0, ago: null },
  ]);
  assert.deepEqual(limitRows(limits, ['codex'], now), [], '지난 창뿐이면 줄이 없다');
  assert.deepEqual(limitRows({}, ['claude'], now), [], '기록이 없으면 줄이 없다');
  assert.deepEqual(limitRows(undefined, undefined, now), []);
});

test('3. 서버·화면 값 일치: 카드의 어림 조각을 화면처럼 더한 값 = 서버의 estimateCalls(모든 조합), 확인한 값이 mission.estimate, 끝난 뒤 실제 호출 수가 어림 안', async () => {
  await app();
  const s = await mk('어림조사', '조사');
  const l = await mk('어림분석', '분석');
  const b = await mk('어림빌드', '빌드');
  const r = await mk('어림검수', '검수');
  const tm = await mkTeam('어림팀', [{ label: '조사', agentIds: [s.id] }, { label: '분석', agentIds: [l.id] }, { label: '빌드', agentIds: [b.id] }, { label: '검수', agentIds: [r.id] }]);
  const sid = await draft(tm.id);
  const c = cardOf(sid);
  const team = t.app.store.get('teams', tm.id);
  const agents = t.app.store.all('agents');
  assert.ok(c.estimate && c.estimate.spent === S(sid).mission.calls.used && c.estimate.spent >= 1, JSON.stringify(c.estimate));
  assert.deepEqual(c.providers, ['claude'], '구독 한도 줄에 보일 프로바이더(팀원이 정한 AI)');
  const droppable = c.review.droppable.map((d) => d.index);
  assert.deepEqual([c.estimate.spent, droppable], [1, [3]]);
  // 화면이 더한 값을 손으로 센 값과 대조(목표 1 · 조사 3~8 · 회의 참석자 2명 4~7 · 남은 일 단계 3 · 판정 1 · 되돌림 1번 × (빌드 1 + 판정 1) · 일 카드 2~7, 되돌림 때 명단 3명)
  const S2 = (min, max) => ({ min, max, returns: 1, cap: MISSION_CALL_CAP, spent: 1 });
  for (const [pick, want] of [
    [{ work: 'stages' }, S2(5, 7)], [{ work: 'stages', research: true, meeting: true }, S2(12, 22)], [{ work: 'stages', kept: [3] }, S2(6, 8)],
    [{ work: 'cards' }, S2(4, 13)], [{ work: 'cards', research: true, meeting: true }, S2(11, 28)], [{ work: 'stages', research: true }, S2(8, 15)],
  ]) assert.deepEqual(sumEstimate(c.estimate, pick), want, JSON.stringify(pick));
  for (const work of ['stages', 'cards']) {
    for (const research of [false, true]) {
      for (const meeting of [false, true]) {
        for (const kept of subsets(droppable)) {
          const screen = sumEstimate(c.estimate, { work, research, meeting, kept });
          const server = estimateCalls(team, agents, { work, prep: { research, meeting }, keep: kept, lead: c.leadId, spent: c.estimate.spent });
          assert.deepEqual(screen, server, JSON.stringify({ work, research, meeting, kept }));
        }
      }
    }
  }
  await confirm(sid, '', { work: 'stages' });
  const m = S(sid).mission;
  assert.deepEqual(m.estimate, sumEstimate(c.estimate, { work: 'stages', research: false, meeting: false, kept: [] }), '확인 시점 값을 그대로 저장');
  await waitEnd(sid);
  assert.equal(S(sid).mission.status, 'done');
  const used = S(sid).mission.calls.used;
  assert.ok(used >= m.estimate.min && used <= m.estimate.max, `실제 ${used}번, 어림 ${m.estimate.min}~${m.estimate.max}`);
});

// 한도 대기 테스트 공통 팀: 정리 → 빌드 → 검수(기준 판정). 이어받을 AI 는 없다(테스트는 다른 AI 를 탐지하지 않는다)
let qt = null;
async function quotaTeam() {
  if (qt) return qt;
  await app();
  const a = await mk('한도정리', '정리');
  const b = await mk('한도빌드', '빌드');
  const r = await mk('한도검수', '검수');
  qt = { a, b, r, tm: await mkTeam('한도팀', [{ label: '정리', agentIds: [a.id] }, { label: '빌드', agentIds: [b.id] }, { label: '검수', agentIds: [r.id] }]) };
  return qt;
}

test('4. 한도 대기(시각 앎): 일 단계가 한도로 멈추면 보통 오류 대기 대신 한도 대기. 끊긴 자리에 적고, "지금 다시"는 한도에 걸린 사람만 다시 돈다. 옛 목표(어림·자동 횟수 없음)도 된다', async () => {
  const { tm, a, b } = await quotaTeam();
  clean();
  const sid = await draft(tm.id);
  // 옛 목표 흉내: 어림·자동 횟수 칸이 없어도 한도 대기가 돈다
  await confirm(sid, 'WORKQUOTA', { work: 'stages' });
  delete S(sid).mission.estimate;
  delete S(sid).mission.quota;
  const h = await holdOf(sid);
  const m = S(sid).mission;
  assert.equal(m.status, 'waiting');
  assert.ok(h.until > Date.now() + 50 * 60000 && h.until <= Date.now() + 3600e3 + 5000, `초기화 시각 ${h.until}`);
  assert.deepEqual([h.canAuto, h.autos, h.autoMax, h.phase, h.who.map((w) => w.name)], [true, 0, QUOTA_AUTO, 'work', [a.name]]);
  assert.match(h.who[0].error, /usage limit/, '오류 문구는 화면에만(대기 정보)');
  assert.equal(attentionOf(S(sid).runs.at(-1)).kind, 'quota');
  assert.deepEqual([m.at.wait.reason, m.at.wait.until, m.at.wait.failed.map((f) => [f.agentId, f.provider])], ['quota', h.until, [[a.id, 'claude']]], '끊긴 자리(한도에 걸린 AI 까지)');
  assert.equal(h.out, 'skip', '일 단계의 출구는 건너뛰기');
  const line = m.log.findLast((x) => x.kind === 'quota');
  assert.equal(line.fail, 'outside');
  assert.ok(!S(sid).runs.at(-1).hold || S(sid).runs.at(-1).hold.reason !== 'error', '보통 오류 대기가 아니다');
  assert.equal((await ctl(sid, 'accept')).json.ok, false, '일 단계 한도 대기에는 받아들이기가 없다(건너뛰기가 있다)');
  // 한도가 풀림 → 지금 다시: 정리 단계가 다시 돌고, 그 뒤로 이어 간다
  lift(true);
  const from = t.fakeLog().length;
  assert.equal((await ctl(sid, 'retry')).json.ok, true);
  await waitEnd(sid);
  lift(false);
  assert.equal(S(sid).mission.status, 'done');
  assert.ok(S(sid).mission.log.some((x) => x.kind === 'answer' && x.text === '한도 대기에서 "지금 다시"를 골랐어.'));
  assert.equal(S(sid).mission.quota.autos, 0);
  assert.equal(prompts(from).filter((p) => p.includes('단계 "정리"를 네가 맡았어')).length, 1, '정리 단계가 한 번 다시 돌았다');
  // 일 카드: k1 은 끝내고 k2 만 한도 → 지금 다시는 k2 만
  clean();
  const sc = await goal(tm.id, 'WORKQUOTAK2', { work: 'cards' });
  const hc = await holdOf(sc);
  assert.deepEqual(hc.who.map((w) => w.agentId), [b.id]);
  lift(true);
  const from2 = t.fakeLog().length;
  await ctl(sc, 'retry');
  await waitEnd(sc);
  lift(false);
  const cards = prompts(from2).filter((p) => /^\[일 카드 k\d\]$/m.test(p));
  assert.deepEqual(cards.map((p) => p.match(/^\[일 카드 (k\d)\]$/m)[1]), ['k2'], '끝낸 카드는 다시 돌지 않는다');
  assert.equal(S(sc).mission.status, 'done');
  // 한도로 다시 돌린 카드는 카드 시작 수·시간당 시작 수에 세지 않는다
  assert.deepEqual(S(sc).mission.cards.map((x) => [x.id, x.status, x.starts]), [['k1', 'done', 1], ['k2', 'done', 1]]);
  assert.equal(S(sc).mission.rate.starts.length, 2);
});

test('5. 한도 대기(시각 모름·오류 문구의 시각): 모르면 자동 이어서를 받지 않고 "지금 다시"·"그만"만. 그만이면 목표가 멈춘다', async () => {
  const { tm } = await quotaTeam();
  clean();
  const sid = await goal(tm.id, 'WORKQUOTANT', { work: 'stages' });
  const h = await holdOf(sid);
  assert.deepEqual([h.until, h.canAuto], [0, false]);
  assert.ok(S(sid).mission.log.some((x) => x.kind === 'quota' && x.text.includes('초기화 시각은 몰라')));
  assert.equal((await ctl(sid, 'later')).json.ok, false, '시각을 모르면 자동 이어서는 없다');
  assert.equal((await ctl(sid, 'stop')).json.ok, true);
  await waitEnd(sid);
  assert.equal(S(sid).mission.status, 'stopped');
  assert.ok(S(sid).mission.log.some((x) => x.text === '한도 대기에서 그만을 골랐어.'));
  // 오류 문구에만 시각("2시간 뒤")이 있어도 아는 시각이다
  clean();
  const s2 = await goal(tm.id, 'WORKQUOTAIN', { work: 'stages' });
  const h2 = await holdOf(s2);
  assert.ok(h2.canAuto && Math.abs(h2.until - (Date.now() + 2 * 3600e3)) < 60000, `${h2.until}`);
  await ctl(s2, 'stop');
  await waitEnd(s2);
});

test('6. 자동 이어서: 고르면 그 시각에(테스트는 짧게) 같은 단계를 다시 시작하고, 기다리는 동안 지금 다시·그만을 누를 수 있다. 목표 하나에 3번까지', async () => {
  const { tm } = await quotaTeam();
  clean();
  process.env.OFFICE_CREW_QUOTA_RESUME_MS = '60000';
  try {
    // 기다리는 중에 "지금 다시": 자동 횟수는 세지 않는다
    const s0 = await goal(tm.id, 'WORKQUOTA', { work: 'stages' });
    const h0 = await holdOf(s0);
    assert.equal((await ctl(s0, 'later')).json.ok, true);
    const w0 = await holdOf(s0, (x) => x.autoAt > 0);
    assert.equal(w0.at, h0.at, '같은 대기로 다시 띄운다(알림을 다시 보내지 않게)');
    assert.equal((await ctl(s0, 'later')).json.ok, false, '이미 골랐다');
    assert.ok(S(s0).mission.log.some((x) => x.kind === 'answer' && x.text.includes('자동으로 이어서 해')));
    lift(true);
    assert.equal((await ctl(s0, 'retry')).json.ok, true);
    await waitEnd(s0);
    lift(false);
    assert.deepEqual([S(s0).mission.status, S(s0).mission.quota.autos], ['done', 0]);
    // 자동으로 이어서 끝까지
    clean();
    process.env.OFFICE_CREW_QUOTA_RESUME_MS = '50';
    const s1 = await goal(tm.id, 'WORKQUOTA', { work: 'stages' });
    await holdOf(s1);
    lift(true);
    assert.equal((await ctl(s1, 'later')).json.ok, true);
    await waitEnd(s1);
    lift(false);
    assert.deepEqual([S(s1).mission.status, S(s1).mission.quota.autos], ['done', 1]);
    assert.ok(S(s1).mission.log.some((x) => x.text === `초기화 시각이 지나서 자동으로 이어서 해(1/${QUOTA_AUTO}번째).`));
    // 한도가 안 풀린 채로 자동 3번 → 4번째는 묻기만(자동 보기 없음) → 그만
    clean();
    const s2 = await goal(tm.id, 'WORKQUOTA', { work: 'stages' });
    for (let k = 0; k < QUOTA_AUTO; k++) {
      await holdOf(s2, (x) => x.autos === k && !x.autoAt && x.canAuto);
      assert.equal((await ctl(s2, 'later')).json.ok, true, `${k + 1}번째 자동`);
    }
    const last = await holdOf(s2, (x) => x.autos === QUOTA_AUTO);
    assert.equal(last.canAuto, false);
    assert.equal((await ctl(s2, 'later')).json.ok, false, '자동 이어서는 3번까지');
    await ctl(s2, 'stop');
    await waitEnd(s2);
    assert.deepEqual([S(s2).mission.status, S(s2).mission.quota.autos], ['stopped', QUOTA_AUTO]);
  } finally { delete process.env.OFFICE_CREW_QUOTA_RESUME_MS; lift(false); }
});

test('7. 기준 판정의 한도 대기: 판정 없이 넘어가지 않고 묻는다. 지금 다시면 같은 회차를 다시 판정한다', async () => {
  const { tm, r } = await quotaTeam();
  clean();
  t.app.store.settings.failover = false; // 이어받기를 꺼 둔 경우도 이어받을 AI 가 없는 것과 같다
  try {
    const sid = await goal(tm.id, 'REVIEWQUOTA', { work: 'stages' });
    const h = await holdOf(sid);
    assert.deepEqual([h.phase, h.who.map((w) => w.agentId), S(sid).mission.at.phase, S(sid).mission.round], ['review', [r.id], 'review', 0]);
    lift(true);
    await ctl(sid, 'retry');
    await waitEnd(sid);
    assert.deepEqual([S(sid).mission.status, S(sid).mission.round], ['done', 1], '같은 회차(1회차)로 판정');
    const rv = S(sid).messages.filter((x) => x.role === 'agent' && x.review);
    assert.deepEqual(rv.map((x) => [x.review.round, !!x.review.quota, x.review.results.length > 0]), [[1, true, false], [1, false, true]], '한도로 중단된 앞 답은 따로 표시');
  } finally { t.app.store.settings.failover = true; lift(false); }
});

test('8. 한도 대기 중 앱을 끄면 끊긴 목표가 되고(타이머는 사라진다), 이어서 하면 호출 없이 같은 한도 대기를 다시 띄운다', async () => {
  await app();
  clean();
  const home = path.join(t.root, 'home-quota');
  const open = async () => {
    const a = createApp({ home, port: 0, detect: false });
    a.store.settings.lang = 'ko';
    a.store.settings.mockSpeed = 0.05;
    const port = await a.listen(await freePort());
    opened.push(a);
    const api = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Office-Token': a.token }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    return { a, api, S: (id) => a.store.getSession(id), idle: (id) => !a.orch.ctx.has(id) };
  };
  const h = await open();
  const ag = async (name, role) => (await h.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  const x = await ag('끊김정리', '정리');
  const y = await ag('끊김검수', '검수');
  const tm = (await h.api('POST', '/api/teams', { name: '끊김팀', stages: [{ label: '정리', agentIds: [x.id] }, { label: '검수', agentIds: [y.id] }] })).json;
  const sid = (await h.api('POST', '/api/sessions', { teamId: tm.id })).json.id;
  await h.api('PATCH', `/api/sessions/${sid}`, { goalMode: true });
  await h.api('POST', `/api/sessions/${sid}/messages`, { text: '정리해 줘' });
  await t.waitFor(() => h.S(sid).mission?.status === 'draft' && h.idle(sid), 20000, '목표 카드');
  const c = h.S(sid).messages.findLast((mm) => mm.role === 'proposal' && mm.kind === 'goal');
  const r = await h.api('POST', `/api/sessions/${sid}/mission/confirm`, { missionId: h.S(sid).mission.id, expected: shown(c), edited: { ...shown(c), goal: 'WORKQUOTA 목표' },
    review: { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) }, work: 'stages' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const hold = await t.waitFor(() => h.S(sid).runs.at(-1)?.hold?.reason === 'quota' && h.S(sid).runs.at(-1).hold, 30000, '한도 대기');
  process.env.OFFICE_CREW_QUOTA_RESUME_MS = '60000';
  try { assert.equal((await h.api('POST', `/api/sessions/${sid}/control`, { action: 'later' })).json.ok, true); } finally { delete process.env.OFFICE_CREW_QUOTA_RESUME_MS; }
  await h.a.close(); // 앱 끄기(정상 종료): 목표는 그대로 두고 다시 켤 때 끊김
  const h2 = await open();
  const s2 = h2.S(sid);
  assert.equal(s2.mission.status, 'cut');
  assert.deepEqual([s2.mission.at.wait.reason, s2.mission.at.wait.until, s2.mission.at.phase], ['quota', hold.until, 'work'], '끊긴 자리에 초기화 시각');
  assert.deepEqual(resumePoint(s2.mission.at, s2.runs.at(-1).stages)?.wait, { reason: 'quota', until: hold.until, failed: s2.mission.at.wait.failed });
  assert.equal(h2.a.orch.ctx.size, 0, '저절로 다시 돌지 않는다');
  const before = t.fakeLog().length;
  assert.equal((await h2.api('POST', `/api/sessions/${sid}/mission/resume`, { missionId: s2.mission.id })).status, 200);
  const again = await t.waitFor(() => h2.S(sid).runs.at(-1)?.hold?.reason === 'quota' && h2.S(sid).runs.at(-1).hold, 30000, '다시 띄운 한도 대기');
  assert.equal(t.fakeLog().length, before, 'CLI 를 띄우지 않았다');
  assert.deepEqual([again.until, again.canAuto], [hold.until, true]);
  assert.ok(h2.S(sid).mission.log.some((l) => l.kind === 'resume' && l.text.includes('AI 호출 없음')));
  lift(true);
  try {
    assert.equal((await h2.api('POST', `/api/sessions/${sid}/control`, { action: 'retry' })).json.ok, true);
    await t.waitFor(() => h2.idle(sid) && h2.S(sid).mission.status === 'done', 30000, '목표 끝');
  } finally { lift(false); }
});

// ── 검토 뒤 고친 것(결정 0019) ──
test('9. 순수 함수: 한도 대기의 초기화 시각은 실제로 다 찬 창만(100% 이상·거절 기록), 자동 이어서 기다림은 가짜 CLI 테스트에서만 줄인다, 기록 나이 단위', () => {
  const now = Date.UTC(2026, 10, 25, 3, 0);
  const sec = (ms) => Math.floor(ms / 1000);
  // 5시간 100%·주간 96%: 이어받기 기준(95%)이면 주간 시각이지만, 한도 대기는 5시간 시각
  assert.equal(limitResetAt({ windows: { five_hour: { pct: 100, resetsAt: sec(now) + 3600 }, seven_day: { pct: 96, resetsAt: sec(now) + 5 * 86400 } }, observedAt: now }, now), (sec(now) + 3600) * 1000);
  // 거절 기록에서 사용률을 모르는 창은 다 찬 창, 사용률이 숫자이고 100 미만이면 아니다. 지난 창·풀어 준 기록은 보지 않는다
  assert.equal(limitResetAt({ status: 'rejected', windows: { five_hour: { pct: null, resetsAt: sec(now) + 600 }, seven_day: { pct: 80, resetsAt: sec(now) + 86400 } }, observedAt: now }, now), (sec(now) + 600) * 1000);
  assert.equal(limitResetAt({ windows: { five_hour: { pct: 100, resetsAt: sec(now) - 60 } } }, now), 0);
  assert.equal(limitResetAt({ windows: { five_hour: { pct: 100, resetsAt: sec(now) + 60 } }, observedAt: now - 1000, releasedAt: now }, now), 0);
  assert.equal(limitResetAt(undefined, now), 0);
  // OFFICE_CREW_QUOTA_RESUME_MS 는 OFFICE_CREW_FAKE_ONLY 가 켜졌을 때만 듣는다
  assert.equal(quotaDelay(now + 60000, now, { OFFICE_CREW_QUOTA_RESUME_MS: '50' }), 60000 + QUOTA_SLACK);
  assert.equal(quotaDelay(now + 60000, now, { OFFICE_CREW_FAKE_ONLY: '0', OFFICE_CREW_QUOTA_RESUME_MS: '50' }), 60000 + QUOTA_SLACK);
  assert.equal(quotaDelay(now + 60000, now, { OFFICE_CREW_FAKE_ONLY: '1', OFFICE_CREW_QUOTA_RESUME_MS: '50' }), 50);
  assert.equal(quotaDelay(now + 60000, now, { OFFICE_CREW_FAKE_ONLY: '1', OFFICE_CREW_QUOTA_RESUME_MS: '' }), 60000 + QUOTA_SLACK);
  assert.equal(quotaDelay(now - 1000, now, {}), QUOTA_SLACK, '지난 시각이면 여유만');
  // 기록 나이: 60분 미만은 분, 24시간 미만은 시간, 넘으면 일(오래된 기록)
  assert.deepEqual([recordAge(0), recordAge(59), recordAge(60), recordAge(1439), recordAge(1440), recordAge(3 * 1440 + 5), recordAge(null)],
    [{ n: 0, unit: 'min', old: false }, { n: 59, unit: 'min', old: false }, { n: 1, unit: 'hour', old: false }, { n: 23, unit: 'hour', old: false }, { n: 1, unit: 'day', old: true }, { n: 3, unit: 'day', old: true }, null]);
});

test('10. 한도 대기의 예전 출구: 일 단계는 건너뛰기(단계표는 그 단계를 건너뛴 채로, 일 카드는 그 카드를 구멍으로 빼고 이어 감), 판정은 받아들이기(판정 없이 받아들임으로 끝). 그만이면 사무실 표시도 정리', async () => {
  const { tm, a, b } = await quotaTeam();
  // 단계표: 정리 단계에서 한도 → 건너뛰기 → 빌드·판정까지 간다
  clean();
  const s1 = await goal(tm.id, 'WORKQUOTA', { work: 'stages' });
  const h1 = await holdOf(s1);
  assert.equal(h1.out, 'skip');
  lift(true); // 다음 단계부터는 한도가 풀린 것으로
  assert.equal((await ctl(s1, 'skip')).json.ok, true);
  await waitEnd(s1);
  lift(false);
  assert.deepEqual([S(s1).mission.status, S(s1).runs.at(-1).stages[0].status], ['done', 'skipped']);
  assert.ok(S(s1).mission.log.some((x) => x.text === '한도 대기에서 건너뛰기를 골랐어. 한도에 걸린 일은 빼고 이어 가.'));
  // 일 카드: k2 만 한도 → 건너뛰기 → k2 는 구멍(사유 한도), 검수 자료에 결과가 비었다는 코드의 줄
  clean();
  const s2 = await goal(tm.id, 'WORKQUOTAK2', { work: 'cards' });
  await holdOf(s2);
  const from = t.fakeLog().length;
  assert.equal((await ctl(s2, 'skip')).json.ok, true);
  await waitEnd(s2);
  const k2 = S(s2).mission.cards.find((x) => x.id === 'k2');
  assert.deepEqual([k2.status, k2.by, k2.starts], ['hole', 'quota', 1]);
  const review = prompts(from).find((p) => p.startsWith('[기준 판정 — 1번째 검수]'));
  assert.ok(review?.includes('이 담당은 사용량 한도에 걸려 사용자가 건너뛰어서, 이 결과는 비어 있어'), '검수 자료에 건너뛴 카드');
  assert.ok(!prompts(from).some((p) => /^\[일 카드 k2\]$/m.test(p)), 'k2 는 다시 돌지 않는다');
  // 판정: 받아들이기 → 판정 없음(기준 확인 못 함)으로 받아들임, 판정 질문은 다시 띄우지 않는다
  clean();
  t.app.store.settings.failover = false;
  try {
    const s3 = await goal(tm.id, 'REVIEWQUOTA', { work: 'stages' });
    const h3 = await holdOf(s3);
    assert.equal(h3.out, 'accept');
    assert.equal((await ctl(s3, 'skip')).json.ok, false, '판정 한도 대기에는 건너뛰기가 없다');
    assert.equal((await ctl(s3, 'accept')).json.ok, true);
    await waitEnd(s3);
    const m3 = S(s3).mission;
    assert.deepEqual([m3.status, m3.round, m3.criteria.map((x) => x.status)], ['accepted', 1, ['unknown', 'unknown']]);
    assert.deepEqual(m3.log.filter((x) => x.kind === 'review').map((x) => [x.text, x.fail]), [['검수 1회차: 검수가 오류로 끝나서 판정 없이 끝남', 'outside']]);
    assert.ok(!m3.log.some((x) => x.kind === 'ask'), '판정 질문을 다시 띄우지 않는다');
  } finally { t.app.store.settings.failover = true; }
  // 그만: 사무실 표시가 오류로 남지 않는다
  clean();
  const s4 = await goal(tm.id, 'WORKQUOTA', { work: 'stages' });
  await holdOf(s4);
  await ctl(s4, 'stop');
  await waitEnd(s4);
  assert.deepEqual([t.app.orch.liveStates(s4)[a.id]?.state, t.app.orch.liveStates(s4)[a.id]?.detail], ['idle', '중지됨']);
  assert.notEqual(t.app.orch.liveStates(s4)[b.id]?.state, 'thinking', '빌드 담당은 돌지 않았다');
});

test('11. 다시 하기 앞에 호출 상한을 본다(일 단계·자동 이어서·판정). 모자라면 "20번 더"부터. 자동 이어서 횟수는 실제로 다시 시작할 때만', async () => {
  const { tm } = await quotaTeam();
  const lowCap = (sid) => { const c = S(sid).mission.calls; c.cap = c.used; };
  // 일 단계 + 지금 다시
  clean();
  const s1 = await goal(tm.id, 'WORKQUOTA', { work: 'stages' });
  await holdOf(s1);
  lowCap(s1);
  lift(true);
  const n1 = t.fakeLog().length;
  await ctl(s1, 'retry');
  await t.waitFor(() => S(s1).runs.at(-1).hold?.reason === 'cap', 20000, '상한 대기');
  assert.equal(t.fakeLog().length, n1, '상한을 넘기 전에는 다시 돌지 않는다');
  assert.deepEqual(S(s1).mission.at.wait, { reason: 'cap' });
  await ctl(s1, 'more');
  await waitEnd(s1);
  lift(false);
  assert.equal(S(s1).mission.status, 'done');
  // 자동 이어서: 상한 대기에서 그만이면 자동 횟수는 그대로
  clean();
  process.env.OFFICE_CREW_QUOTA_RESUME_MS = '50';
  try {
    const s2 = await goal(tm.id, 'WORKQUOTA', { work: 'stages' });
    await holdOf(s2);
    lowCap(s2);
    await ctl(s2, 'later');
    await t.waitFor(() => S(s2).runs.at(-1).hold?.reason === 'cap', 20000, '상한 대기');
    assert.equal(S(s2).mission.quota.autos, 0, '아직 다시 시작하지 않았다');
    await ctl(s2, 'stop');
    await waitEnd(s2);
    assert.deepEqual([S(s2).mission.status, S(s2).mission.quota.autos], ['stopped', 0]);
  } finally { delete process.env.OFFICE_CREW_QUOTA_RESUME_MS; }
  // 판정 + 지금 다시
  clean();
  t.app.store.settings.failover = false;
  try {
    const s3 = await goal(tm.id, 'REVIEWQUOTA', { work: 'stages' });
    await holdOf(s3);
    lowCap(s3);
    lift(true);
    await ctl(s3, 'retry');
    await t.waitFor(() => S(s3).runs.at(-1).hold?.reason === 'cap', 20000, '판정 앞 상한 대기');
    await ctl(s3, 'more');
    await waitEnd(s3);
    assert.equal(S(s3).mission.status, 'done');
  } finally { t.app.store.settings.failover = true; lift(false); }
});

test('12. 자동 이어서 타이머: 울릴 때 일시정지를 눌러 뒀으면 시작하지 않고 일시정지 대기로. 그만·세션 삭제 때 타이머를 지운다', async () => {
  const { tm } = await quotaTeam();
  clean();
  process.env.OFFICE_CREW_QUOTA_RESUME_MS = '300';
  try {
    const s1 = await goal(tm.id, 'WORKQUOTA', { work: 'stages' });
    await holdOf(s1);
    await ctl(s1, 'later');
    await ctl(s1, 'pause');
    const n = t.fakeLog().length;
    await t.waitFor(() => S(s1).runs.at(-1).hold?.reason === 'pause', 20000, '일시정지 대기');
    assert.equal(t.fakeLog().length, n, '일시정지 중에는 시작하지 않는다');
    assert.equal(S(s1).mission.quota.autos, 0);
    lift(true);
    await ctl(s1, 'resume');
    await waitEnd(s1);
    lift(false);
    assert.deepEqual([S(s1).mission.status, S(s1).mission.quota.autos], ['done', 1]);
  } finally { delete process.env.OFFICE_CREW_QUOTA_RESUME_MS; lift(false); }
  // 그만 · 세션 삭제
  process.env.OFFICE_CREW_QUOTA_RESUME_MS = '600000';
  try {
    clean();
    const s2 = await goal(tm.id, 'WORKQUOTA', { work: 'stages' });
    await holdOf(s2);
    await ctl(s2, 'later');
    await holdOf(s2, (x) => x.autoAt > 0);
    assert.equal(t.app.orch.quotaTimers.size, 1);
    await ctl(s2, 'stop');
    await waitEnd(s2);
    assert.equal(t.app.orch.quotaTimers.size, 0, '그만이면 타이머를 지운다');
    clean();
    const s3 = await goal(tm.id, 'WORKQUOTA', { work: 'stages' });
    await holdOf(s3);
    await ctl(s3, 'later');
    await holdOf(s3, (x) => x.autoAt > 0);
    assert.equal(t.app.orch.quotaTimers.size, 1);
    assert.equal((await t.api('DELETE', `/api/sessions/${s3}`)).status, 200);
    await t.waitFor(() => idle(s3) && t.app.orch.quotaTimers.size === 0, 20000, '세션 삭제 뒤 타이머 정리');
  } finally { delete process.env.OFFICE_CREW_QUOTA_RESUME_MS; }
});

test('13. 일부만 한도(한 명은 한도, 한 명은 다른 오류)면 보통 오류 대기', async () => {
  await app();
  clean();
  const x = await mk('혼합갑', '정리');
  const y = await mk('혼합을', '작성');
  const r = await mk('혼합검수', '검수');
  const tm = await mkTeam('혼합팀', [{ label: '같이', agentIds: [x.id, y.id] }, { label: '검수', agentIds: [r.id] }]);
  const sid = await goal(tm.id, `MIXQUOTA:${x.name} MIXFAIL:${y.name}`, { work: 'stages' });
  const run = await t.waitFor(() => S(sid).runs.at(-1)?.hold && S(sid).runs.at(-1), 30000, '대기');
  assert.equal(run.hold.reason, 'error');
  assert.match(run.hold.message, /usage limit/);
  assert.match(run.hold.message, /가짜 실패/);
  await ctl(sid, 'stop');
  await waitEnd(sid);
});

test('14. 실제 호출 수가 어림 범위 안: 일 카드 + 조사 + 회의, 단계표 + 되돌림, 단계표 + 조사', async () => {
  await app();
  clean();
  const s = await mk('범위조사', '조사');
  const l = await mk('범위분석', '분석');
  const b = await mk('범위빌드', '빌드');
  const r = await mk('범위검수', '검수');
  const tm = await mkTeam('범위팀', [{ label: '조사', agentIds: [s.id] }, { label: '분석', agentIds: [l.id] }, { label: '빌드', agentIds: [b.id] }, { label: '검수', agentIds: [r.id] }]);
  for (const [signal, opts] of [['', { work: 'cards', prep: { research: true, meeting: true } }], ['REVIEWFAIL', { work: 'stages' }], ['', { work: 'stages', prep: { research: true, meeting: false } }]]) {
    const sid = await goal(tm.id, signal, opts);
    await waitEnd(sid);
    const m = S(sid).mission;
    const label = JSON.stringify([signal, opts]);
    assert.ok(['done', 'accepted'].includes(m.status), `${label} ${m.status}`);
    assert.ok(m.calls.used >= m.estimate.min && m.calls.used <= m.estimate.max, `${label}: 실제 ${m.calls.used}번, 어림 ${m.estimate.min}~${m.estimate.max}`);
    if (signal === 'REVIEWFAIL') assert.equal(m.returns, 1, '되돌림이 한 번 있었다');
  }
});

test('15. 팀이 바뀌어 확인이 409 면 지금 팀의 어림 조각을 같이 주고, 그 조각으로 다시 더한 값이 확인 뒤 저장값과 같다', async () => {
  await app();
  const a = await mk('바뀜정리', '정리');
  const b = await mk('바뀜빌드', '빌드');
  const r = await mk('바뀜검수', '검수');
  const r2 = await mk('바뀜검수2', '테스트');
  const tm = await mkTeam('바뀜팀', [{ label: '정리', agentIds: [a.id] }, { label: '빌드', agentIds: [b.id] }, { label: '검수', agentIds: [r.id] }]);
  const sid = await draft(tm.id);
  const c = cardOf(sid);
  // 카드를 본 뒤 팀에 검수 단계가 하나 더 생겼다
  await t.api('PUT', `/api/teams/${tm.id}`, { ...t.app.store.get('teams', tm.id), stages: [...t.app.store.get('teams', tm.id).stages, { label: '검수2', agentIds: [r2.id] }] });
  const prep = { research: false, meeting: false, lead: c.prep.lead.id, researchers: c.prep.research.who.map((w) => w.id), attendees: c.prep.meeting.who.map((w) => w.id) };
  const bad = await t.api('POST', `/api/sessions/${sid}/mission/confirm`, { missionId: S(sid).mission.id, expected: shown(c), review: { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: [] }, prep, work: 'stages' });
  assert.equal(bad.status, 409);
  const team = t.app.store.get('teams', tm.id);
  assert.deepEqual(bad.json.estimate, estimateParts(team, t.app.store.all('agents'), { lead: c.leadId, spent: c.estimate.spent }), '409 에 지금 팀의 어림 조각');
  assert.notDeepEqual(bad.json.estimate, c.estimate);
  // 화면: 새 조각으로 다시 더한다(남기기 하나) → 서버가 확인 뒤 적은 값과 같다
  const kept = [bad.json.review.droppable[0].index];
  const screen = sumEstimate(bad.json.estimate, { work: 'stages', research: false, meeting: false, kept });
  const ok = await t.api('POST', `/api/sessions/${sid}/mission/confirm`, { missionId: S(sid).mission.id, expected: shown(c), review: { reviewerId: bad.json.review.reviewerId, droppable: bad.json.review.droppable, drop: bad.json.review.droppable.map((d) => d.index).filter((i) => !kept.includes(i)) }, prep, work: 'stages' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(S(sid).mission.estimate, screen);
  await waitEnd(sid);
});

// 따로 켜는 앱(같은 데이터 폴더로 끄고 다시 켜기). 팀은 정리 → 검수
async function sideApp(name) {
  await app();
  const home = path.join(t.root, name);
  const open = async () => {
    const a = createApp({ home, port: 0, detect: false });
    a.store.settings.lang = 'ko';
    a.store.settings.mockSpeed = 0.05;
    const port = await a.listen(await freePort());
    opened.push(a);
    const api = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Office-Token': a.token }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    return { a, api, S: (id) => a.store.getSession(id), idle: (id) => !a.orch.ctx.has(id), ctl: (sid, action) => api('POST', `/api/sessions/${sid}/control`, { action }) };
  };
  const h = await open();
  const ag = async (n, role) => (await h.api('POST', '/api/agents', { name: n, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  const x = await ag(`${name}정리`, '정리');
  const y = await ag(`${name}검수`, '검수');
  const tm = (await h.api('POST', '/api/teams', { name: `${name}팀`, stages: [{ label: '정리', agentIds: [x.id] }, { label: '검수', agentIds: [y.id] }] })).json;
  const start = async (goalText) => {
    const sid = (await h.api('POST', '/api/sessions', { teamId: tm.id })).json.id;
    await h.api('PATCH', `/api/sessions/${sid}`, { goalMode: true });
    await h.api('POST', `/api/sessions/${sid}/messages`, { text: '정리해 줘' });
    await t.waitFor(() => h.S(sid).mission?.status === 'draft' && h.idle(sid), 20000, '목표 카드');
    const c = h.S(sid).messages.findLast((mm) => mm.role === 'proposal' && mm.kind === 'goal');
    const r = await h.api('POST', `/api/sessions/${sid}/mission/confirm`, { missionId: h.S(sid).mission.id, expected: shown(c), edited: { ...shown(c), goal: goalText },
      review: { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) }, work: 'stages' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return sid;
  };
  const holdIn = (hh, sid) => t.waitFor(() => hh.S(sid).runs.at(-1)?.hold?.reason === 'quota' && hh.S(sid).runs.at(-1).hold, 30000, '한도 대기');
  return { h, open, x, y, start, holdIn, home };
}

test('16. 끊김 뒤 이어서: 판정의 한도 대기, 되돌림 중 한도 대기(호출 없이 같은 대기). 저장된 초기화 시각이 지났으면 "지났어"로', async () => {
  await app();
  // 판정의 한도 대기
  clean();
  const A = await sideApp('끊김판정');
  const sa = await A.start('REVIEWQUOTA 목표');
  A.h.a.store.settings.failover = false;
  const ha = await A.holdIn(A.h, sa);
  assert.equal(ha.phase, 'review');
  await A.h.a.close();
  const A2 = await A.open();
  assert.deepEqual([A2.S(sa).mission.status, A2.S(sa).mission.at.phase, A2.S(sa).mission.at.wait.reason, A2.S(sa).mission.at.wait.failed[0].provider], ['cut', 'review', 'quota', 'claude']);
  const na = t.fakeLog().length;
  assert.equal((await A2.api('POST', `/api/sessions/${sa}/mission/resume`, { missionId: A2.S(sa).mission.id })).status, 200);
  const ha2 = await A.holdIn(A2, sa);
  assert.deepEqual([ha2.phase, ha2.until, t.fakeLog().length], ['review', ha.until, na], '호출 없이 같은 대기');
  lift(true);
  try {
    await A2.ctl(sa, 'retry');
    await t.waitFor(() => A2.idle(sa) && A2.S(sa).mission.status === 'done', 30000, '판정 끝');
    assert.equal(A2.S(sa).mission.round, 1);
  } finally { lift(false); }
  // 되돌림 중 한도 대기(1회차 불합격 → 되돌림에서 한도)
  clean();
  const B = await sideApp('끊김되돌림');
  const sb = await B.start('REVIEWFAIL BACKQUOTA 목표');
  const hb = await B.holdIn(B.h, sb);
  assert.deepEqual([hb.phase, B.h.S(sb).mission.at.back, B.h.S(sb).mission.returns], ['work', true, 1]);
  const file = path.join(B.h.a.store.dirs.sessions, `${sb}.json`);
  await B.h.a.close();
  // 저장된 초기화 시각을 지난 시각으로 고치고 한도 기록도 비운다(그사이 시간이 흐른 것처럼)
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const past = Date.now() - 60000;
  snap.mission.at.wait.until = past;
  fs.writeFileSync(file, JSON.stringify(snap));
  const B2 = await B.open();
  B2.a.store.usage.limits = {};
  const nb = t.fakeLog().length;
  assert.equal((await B2.api('POST', `/api/sessions/${sb}/mission/resume`, { missionId: B2.S(sb).mission.id })).status, 200);
  const hb2 = await B.holdIn(B2, sb);
  assert.deepEqual([hb2.phase, hb2.until, hb2.passed, hb2.canAuto, t.fakeLog().length], ['work', 0, past, false, nb], '지난 시각이면 자동 없이 "지났어"');
  assert.equal(B2.S(sb).mission.at.back, true);
  lift(true);
  try {
    await B2.ctl(sb, 'retry');
    await t.waitFor(() => B2.idle(sb) && !['active', 'waiting'].includes(B2.S(sb).mission.status), 30000, '되돌림 끝');
    assert.deepEqual([B2.S(sb).mission.status, B2.S(sb).mission.returns, B2.S(sb).mission.round], ['done', 1, 2], '되돌림 수는 다시 세지 않고 2회차에 통과');
  } finally { lift(false); }
});
