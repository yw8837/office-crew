// 목표 모드(결정 0019): 시작 전 호출 어림(범위), 끝난 뒤 실제 호출 수, 받은 구독 한도 기록의 % 줄, 한도에 걸려 멈췄을 때의 한도 대기(초기화 뒤 이어서).
// 가짜 CLI 만 쓴다(실제 AI 사용량 0). 한도가 풀린 것은 가짜 CLI 기록 옆의 ".lift" 파일로 흉내 낸다(test/fake-cli/fake-claude.js 의 WORKQUOTA·REVIEWQUOTA).
// 자동 이어서의 기다림은 OFFICE_CREW_QUOTA_RESUME_MS 로 줄인다(초기화 시각은 그대로 보인다)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { bindLang } from '../server/i18n.js';
import { estimateParts, estimateCalls, reviewPlan, resumePoint, MISSION_CALL_CAP, RETURN_CAP, CARD_COUNT, QUOTA_AUTO } from '../server/mission.js';
import { sumEstimate, limitRows } from '../public/js/mission-numbers.js';
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
  assert.deepEqual([m.at.wait.reason, m.at.wait.until, m.at.wait.failed.map((f) => f.agentId)], ['quota', h.until, [a.id]], '끊긴 자리');
  const line = m.log.findLast((x) => x.kind === 'quota');
  assert.equal(line.fail, 'outside');
  assert.ok(!S(sid).runs.at(-1).hold || S(sid).runs.at(-1).hold.reason !== 'error', '보통 오류 대기가 아니다');
  assert.equal((await ctl(sid, 'skip')).json.ok, false, '건너뛰기는 받지 않는다');
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
  assert.deepEqual(S(sc).mission.cards.map((x) => [x.id, x.status, x.starts]), [['k1', 'done', 1], ['k2', 'done', 2]]);
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
