// 예약 작업: 정해진 요일·시각에 데모 팀(가짜 AI)으로 실행 — 실제 AI 사용량 0
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { cleanSchedule, lastOccurrence, nextOccurrence, GRACE_MS, Scheduler } from '../server/scheduler.js';

let t;
// 데모 팀은 2단계에서 사람 승인을 기다리므로, 끝까지 도는 승인 없는 가짜 팀을 따로 쓴다
before(async () => {
  t = await startTestApp();
  base.teamId = (await t.api('POST', '/api/teams', { name: '예약 테스트 팀', stages: [{ label: '조사', agentIds: ['demo-researcher'] }] })).json.id;
});
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const ALL = [0, 1, 2, 3, 4, 5, 6];
const base = { name: '아침 조사', prompt: '오늘 할 일 정리해줘', time: '09:00', days: ALL, teamId: null };
const runEnded = (sid) => t.waitFor(() => t.events.find((e) => e.type === 'run' && e.data.sessionId === sid && e.data.run.endedAt), 20000, '실행 종료');
const create = async (extra = {}) => {
  const r = await t.api('POST', '/api/schedules', { ...base, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
};
const get = (id) => t.app.store.get('schedules', id);

test('시각 계산: 현지 시각 기준 지난 회차·다음 회차, 고른 요일만', () => {
  const s = { time: '09:30', days: [1] }; // 월요일만
  const wed = new Date(2026, 10, 4, 12, 0).getTime(); // 2026-11-04 수요일 정오
  assert.equal(lastOccurrence(s, wed), new Date(2026, 10, 2, 9, 30).getTime());
  assert.equal(nextOccurrence(s, wed), new Date(2026, 10, 9, 9, 30).getTime());
  const daily = { time: '09:30', days: ALL };
  const at930 = new Date(2026, 10, 4, 9, 30).getTime();
  assert.equal(lastOccurrence(daily, at930), at930, '정각이면 그 회차');
  assert.equal(nextOccurrence(daily, at930), new Date(2026, 10, 5, 9, 30).getTime());
});

test('입력 검사: 이름·지시·시각·요일·맡길 대상이 필요', () => {
  assert.throws(() => cleanSchedule({ ...base, name: ' ' }), /이름/);
  assert.throws(() => cleanSchedule({ ...base, prompt: '' }), /지시/);
  assert.throws(() => cleanSchedule({ ...base, time: '24:00' }), /시각/);
  assert.throws(() => cleanSchedule({ ...base, time: '9:00' }), /시각/);
  assert.throws(() => cleanSchedule({ ...base, days: [7, 'x'] }), /요일/);
  assert.throws(() => cleanSchedule({ ...base, teamId: null, agentId: null }), /팀이나 에이전트/);
  const c = cleanSchedule({ ...base, days: [3, 1, 1], session: 'x', lastRun: { status: 'started' } });
  assert.deepEqual(c.days, [1, 3]);
  assert.equal(c.session, 'new');
  assert.equal(c.lastRun, null, '실행 기록은 클라이언트 값을 믿지 않는다');
  assert.equal(c.enabled, true);
  assert.equal(c.catchUp, false);
});

test('제때: 예정 시각이 되면 새 세션을 만들어 데모 팀이 일하고, 다음 회차가 보인다', async () => {
  const s = await create();
  assert.ok(s.nextAt > Date.now());
  const boot = await t.api('GET', '/api/bootstrap');
  assert.ok(boot.json.schedules.some((x) => x.id === s.id));
  t.app.scheduler.tick(s.nextAt + 60_000);
  const lr = get(s.id).lastRun;
  assert.equal(lr.status, 'started');
  const sess = t.app.store.getSession(lr.sessionId);
  assert.match(sess.title, /^⏰ 아침 조사 · /);
  assert.equal(sess.teamId, base.teamId);
  assert.equal(sess.scheduleId, s.id);
  assert.equal(sess.messages[0].text, '오늘 할 일 정리해줘');
  const ev = await runEnded(lr.sessionId);
  assert.equal(ev.data.run.status, 'done');
  // 같은 회차를 두 번 실행하지 않는다
  t.app.scheduler.tick(s.nextAt + 120_000);
  assert.equal(get(s.id).lastRun.sessionId, lr.sessionId);
  assert.ok(t.events.some((e) => e.type === 'schedules'));
  await t.api('DELETE', `/api/schedules/${s.id}`);
});

test('놓친 회차: 앱이 꺼져 있었으면 기본은 건너뛰고, catchUp 이면 켜질 때 한 번 실행', async () => {
  const before = t.app.store.listSessions().length;
  const a = await create({ name: '놓침' });
  t.app.scheduler.tick(a.nextAt + GRACE_MS + 60_000);
  assert.equal(get(a.id).lastRun.status, 'missed');
  assert.equal(t.app.store.listSessions().length, before, '세션을 만들지 않는다');
  const b = await create({ name: '따라잡기', catchUp: true });
  t.app.scheduler.tick(b.nextAt + 3 * 3600_000);
  const lr = get(b.id).lastRun;
  assert.equal(lr.status, 'started');
  assert.equal(lr.late, true);
  await runEnded(lr.sessionId);
  // 같은 회차를 다시 tick 해도 한 번만
  t.app.scheduler.tick(b.nextAt + 3 * 3600_000 + 1000);
  assert.equal(get(b.id).lastRun.sessionId, lr.sessionId);
  for (const x of [a, b]) await t.api('DELETE', `/api/schedules/${x.id}`);
});

test('겹침 방지·같은 세션 이어하기·지금 실행', async () => {
  const s = await create({ name: '이어하기', session: 'same' });
  const r1 = (await t.api('POST', `/api/schedules/${s.id}/run`)).json;
  assert.equal(r1.status, 'started');
  assert.equal(r1.manual, true);
  // 아직 도는 중이면 이번 회차는 건너뛴다
  const r2 = (await t.api('POST', `/api/schedules/${s.id}/run`)).json;
  assert.equal(r2.status, 'skipped');
  assert.equal(r2.sessionId, r1.sessionId);
  await runEnded(r1.sessionId);
  const r3 = (await t.api('POST', `/api/schedules/${s.id}/run`)).json;
  assert.equal(r3.status, 'started');
  assert.equal(r3.sessionId, r1.sessionId, '같은 세션에 이어서');
  assert.equal(t.app.store.getSession(r1.sessionId).title, '⏰ 이어하기');
  await t.waitFor(() => t.events.filter((e) => e.type === 'run' && e.data.sessionId === r1.sessionId && e.data.run.endedAt).length >= 2, 20000, '두 번째 실행 종료');
  await t.api('DELETE', `/api/schedules/${s.id}`);
});

test('저장할 때 검사: 없는 팀·에이전트, 없는·상대 경로 폴더는 거부, 문자열 "false" 는 꺼짐', async () => {
  assert.equal((await t.api('POST', '/api/schedules', { ...base, teamId: 'team-nope' })).status, 400);
  assert.equal((await t.api('POST', '/api/schedules', { ...base, teamId: null, agentId: 'agent-nope' })).status, 400);
  assert.equal((await t.api('POST', '/api/schedules', { ...base, cwd: path.join(t.root, 'no-such-dir') })).status, 400);
  assert.equal((await t.api('POST', '/api/schedules', { ...base, cwd: 'relative/dir' })).status, 400);
  const off = await create({ name: '문자열 꺼짐', enabled: 'false', catchUp: 'yes' });
  assert.equal(off.enabled, false);
  assert.equal(off.catchUp, false);
  await t.api('DELETE', `/api/schedules/${off.id}`);
  assert.equal((await t.api('PUT', `/api/schedules/${off.id}`, base)).status, 404);
});

test('에이전트 한 명에게 맡기기, 팀·폴더가 실행 전에 없어지면 오류로 남긴다', async () => {
  const a = await create({ name: '혼자 조사', teamId: null, agentId: 'demo-researcher' });
  const r = (await t.api('POST', `/api/schedules/${a.id}/run`)).json;
  assert.equal(r.status, 'started');
  const sess = t.app.store.getSession(r.sessionId);
  assert.equal(sess.teamId, null);
  assert.equal(sess.agentId, 'demo-researcher');
  await runEnded(r.sessionId);
  const team = (await t.api('POST', '/api/teams', { name: '임시팀', stages: [{ label: '1', agentIds: ['demo-researcher'] }] })).json;
  const s = await create({ name: '사라진 팀', teamId: team.id });
  await t.api('DELETE', `/api/teams/${team.id}`);
  const e1 = (await t.api('POST', `/api/schedules/${s.id}/run`)).json;
  assert.equal(e1.status, 'error');
  assert.match(e1.note, /팀이 없어졌어/);
  const dir = path.join(t.root, 'later-gone');
  fs.mkdirSync(dir);
  const s2 = await create({ name: '사라진 폴더', cwd: dir });
  fs.rmSync(dir, { recursive: true });
  assert.equal((await t.api('POST', `/api/schedules/${s2.id}/run`)).json.status, 'error');
  for (const x of [a, s, s2]) await t.api('DELETE', `/api/schedules/${x.id}`);
});

test('수정 직후엔 이미 지난(놓친) 회차를 catchUp 이어도 실행하지 않는다', async () => {
  const s = await create({ name: '고친 예약' });
  // 사흘 동안 앱이 꺼져 있었던 것처럼 처리 시각을 과거로 돌려 둔다 → 이대로 tick 하면 catchUp 으로 실행될 상황
  t.app.store.upsert('schedules', { id: s.id, handledAt: Date.now() - 3 * 86400_000 });
  await t.api('PUT', `/api/schedules/${s.id}`, { ...base, name: '고친 예약', catchUp: true });
  t.app.scheduler.tick(Date.now() + 1000);
  assert.equal(get(s.id).lastRun, null, '수정이 지난 회차를 처리한 걸로 친다');
  // 같은 상황에서 수정이 없으면 한 번만 실행된다(여러 날 놓쳐도 한 번)
  t.app.store.upsert('schedules', { id: s.id, handledAt: Date.now() - 3 * 86400_000 });
  t.app.scheduler.tick(Date.now() + 1000);
  const lr = get(s.id).lastRun;
  assert.equal(lr.status, 'started');
  t.app.scheduler.tick(Date.now() + 2000);
  assert.equal(get(s.id).lastRun.at, lr.at, '두 번째 tick 은 실행하지 않는다');
  await runEnded(lr.sessionId);
  await t.api('DELETE', `/api/schedules/${s.id}`);
});

test('같은 세션 모드에서 맡길 대상을 바꾸면 새 세션에서 새 대상이 일한다', async () => {
  const other = (await t.api('POST', '/api/teams', { name: '두 번째 팀', stages: [{ label: '1', agentIds: ['demo-researcher'] }] })).json;
  const s = await create({ name: '대상 변경', session: 'same' });
  const r1 = (await t.api('POST', `/api/schedules/${s.id}/run`)).json;
  await runEnded(r1.sessionId);
  const upd = (await t.api('PUT', `/api/schedules/${s.id}`, { ...base, name: '대상 변경', session: 'same', teamId: other.id })).json;
  assert.equal(upd.sessionId, null, '대상이 바뀌면 이어 쓸 세션을 비운다');
  const r2 = (await t.api('POST', `/api/schedules/${s.id}/run`)).json;
  assert.notEqual(r2.sessionId, r1.sessionId);
  assert.equal(t.app.store.getSession(r2.sessionId).teamId, other.id);
  await runEnded(r2.sessionId);
  // 대상이 같으면 계속 같은 세션
  const r3 = (await t.api('POST', `/api/schedules/${s.id}/run`)).json;
  assert.equal(r3.sessionId, r2.sessionId);
  await t.waitFor(() => t.events.filter((e) => e.type === 'run' && e.data.sessionId === r2.sessionId && e.data.run.endedAt).length >= 2, 20000, '세 번째 실행 종료');
  await t.api('DELETE', `/api/schedules/${s.id}`);
  await t.api('DELETE', `/api/teams/${other.id}`);
});

test('PC 시계가 미래로 튀었다 돌아와도 다음 회차는 돈다', async () => {
  const s = await create({ name: '시계 점프' });
  const future = Date.now() + 400 * 86400_000;
  t.app.scheduler.tick(future); // 1년 넘게 앞선 시계에서 한 번(그 시각 회차는 놓침으로 처리)
  assert.equal(get(s.id).lastRun.status, 'missed');
  t.app.scheduler.tick(Date.now()); // 시계가 돌아옴 → 처리 시각을 지금으로 당긴다
  assert.ok(get(s.id).handledAt <= Date.now());
  t.app.scheduler.tick(s.nextAt + 60_000);
  const lr = get(s.id).lastRun;
  assert.equal(lr.status, 'started');
  await runEnded(lr.sessionId);
  await t.api('DELETE', `/api/schedules/${s.id}`);
});

test('시계는 데이터 폴더당 하나: 살아 있는 다른 앱이 잡고 있으면 돌리지 않고, 멈추면 시작 타이머도 지운다', async () => {
  const lock = path.join(t.app.dirs.home, 'scheduler.lock');
  const mk = () => new Scheduler({ store: t.app.store, orch: t.app.orch, bus: t.app.bus });
  fs.writeFileSync(lock, String(process.ppid)); // 살아 있는 다른 프로세스
  const a = mk();
  assert.equal(a.start(), false);
  a.stop();
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.ppid), '남의 잠금은 지우지 않는다');
  fs.writeFileSync(lock, '2147483646'); // 이미 끝난 프로세스(비정상 종료가 남긴 잠금)
  const b = mk();
  let ticks = 0;
  b.tick = () => { ticks++; };
  assert.equal(b.start(), true);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
  b.stop();
  assert.equal(fs.existsSync(lock), false, '멈추면 잠금을 푼다');
  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(ticks, 0, '멈춘 뒤 켜질 때 tick 이 돌지 않는다');
});
