// 일시 장애 1번 자동 다시(결정 0030): 목표의 일 단계·카드 단계가 일시 장애로 보이는 오류(네트워크 끊김·시간 초과·5xx·과부하)로 끝나면,
// 사용자에게 묻기 전에 한 번만 저절로 다시 돌린다. 그 실행이 파일을 바꾸지 않았다고 git 으로 확인될 때만, 호출 상한·구독 한도 상한·카드 시작 상한 안에서만.
// 한도 오류는 여기에 넣지 않는다(결정 0019 의 한도 대기). 설정으로 끌 수 있다. 가짜 CLI 만 쓴다(실제 AI 사용량 0)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bindLang } from '../server/i18n.js';
import { isTransientError, isQuotaError } from '../server/failover.js';
import { buildReport } from '../server/report.js';
import { startTestApp } from './helpers.js';

bindLang(() => 'ko');
let t = null;
const app = async () => (t ||= await startTestApp());
after(async () => { if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } } });
const S = (id) => t.app.store.getSession(id);
const idle = (sid) => !t.app.orch.ctx.has(sid);
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides, ...(c.checks ? { checks: c.checks } : {}), ...(c.keep ? { keep: c.keep } : {}) });
let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
function repo(name) {
  const dir = path.join(t.root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!hasGit) return dir;
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  return dir;
}

test('1. 일시 장애 판정: 네트워크·시간 초과·5xx·과부하는 맞고, 사용량 한도·크기 한도·보통 오류는 아니다', () => {
  for (const s of ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'request to https://api.example.com failed, reason: socket hang up',
    'Error: read ECONNRESET', 'connect ETIMEDOUT 10.0.0.1:443', 'stream disconnected before completion', 'HTTP 503 Service Unavailable', 'API Error: 500 Internal server error',
    'Request timed out.', 'fetch failed', 'getaddrinfo EAI_AGAIN api.example.com', '502 Bad Gateway']) {
    assert.equal(isTransientError(s), true, s);
  }
  for (const s of ['Claude AI usage limit reached', 'rate limit exceeded (429)', 'Usage limit reached. Try again in 2 hours.', '가짜 실패', 'prompt is too long: context length exceeded',
    'TypeError: x is not a function', 'exit code 1', 'line 503: unexpected token', '', '실행 실패: spawn claude ENOENT']) {
    assert.equal(isTransientError(s), false, s);
  }
  // 한도 문구와 일시 장애 문구가 같이 있으면 한도(결정 0019 의 길)
  assert.equal(isQuotaError('503 overloaded: rate limit'), true);
  assert.equal(isTransientError('503 overloaded: rate limit'), false);
});

async function team2(tag) {
  const mk = async (name, role) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  const a = await mk(`${tag}가`, '빌드');
  const b = await mk(`${tag}나`, '기록');
  const v = await mk(`${tag}다`, '검수');
  const tm = (await t.api('POST', '/api/teams', { name: `${tag}팀`, stages: [{ label: '만들기', agentIds: [a.id, b.id] }, { label: '검수', agentIds: [v.id] }] })).json;
  return { a, b, v, tm };
}
async function goal(tm, cwd, signal, work = 'stages') {
  const s = (await t.api('POST', '/api/sessions', { teamId: tm.id, cwd })).json;
  assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '정리해 줘' });
  await t.waitFor(() => S(s.id).mission?.status === 'draft' && idle(s.id), 20000, '목표 카드');
  const c = S(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  const r = await t.api('POST', `/api/sessions/${s.id}/mission/confirm`, { missionId: S(s.id).mission.id, expected: shown(c), edited: { ...shown(c), goal: `${signal} 목표` },
    review: { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) }, work,
    prep: { research: false, meeting: false, lead: c.prep.lead.id, researchers: c.prep.research.who.map((w) => w.id), attendees: c.prep.meeting.who.map((w) => w.id) } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return s.id;
}
const ended = (sid) => t.waitFor(() => idle(sid) && ['done', 'accepted', 'stopped'].includes(S(sid).mission.status), 60000, '목표 끝');
const lines = (sid, kind) => (S(sid).mission.log || []).filter((x) => x.kind === kind);
const errorAnswers = (sid, agentId) => S(sid).messages.filter((m) => m.role === 'agent' && m.agentId === agentId && m.status === 'error');

test('2. 단계표: 한 사람만 일시 장애로 끝나면 그 사람만 한 번 저절로 다시(끝낸 사람은 다시 안 돎), 진행 기록과 완주 보고의 실패 집계에 남는다', { timeout: 120000 }, async (tt) => {
  if (!hasGit) { tt.skip('git 이 없어 바뀐 파일을 확인할 수 없음(자동 다시 없음)'); return; }
  await app();
  const { a, b, tm } = await team2('일시1');
  const cwd = repo('net1');
  const sid = await goal(tm, cwd, `NETFAIL1:${b.name}`);
  await ended(sid);
  const m = S(sid).mission;
  assert.equal(m.status, 'done', JSON.stringify(m.log.slice(-6).map((x) => x.text)));
  const tl = lines(sid, 'transient');
  assert.equal(tl.length, 1);
  assert.match(tl[0].text, /일시 장애/);
  assert.equal(tl[0].fail, 'transient');
  assert.equal(errorAnswers(sid, b.id).length, 1, 'b 의 첫 답은 오류');
  const run = S(sid).runs.findLast((r) => r.mission === 'work');
  const okA = S(sid).messages.filter((x) => x.role === 'agent' && x.runId === run.id && x.agentId === a.id && x.stageIndex === 0);
  assert.equal(okA.length, 1, '끝낸 a 는 다시 안 돎');
  // 오류 대기를 묻지 않았다(질문 없이 이어 감)
  assert.equal(lines(sid, 'error').length, 0);
  const rep = S(sid).messages.find((x) => x.kind === 'report');
  assert.equal(rep.fails.transient, 1);
  // 보고를 다시 묶어도 같다(진행 기록에서 센다)
  assert.equal(buildReport({ m, messages: S(sid).messages, runs: S(sid).runs }).fails.transient, 1);
});

test('3. 두 번째도 실패하면 지금처럼 묻고, 파일을 바꿨거나 git 이 아니면 자동으로 다시 하지 않는다. 설정으로 끄면 바로 묻는다', { timeout: 180000 }, async (tt) => {
  await app();
  const { b, tm } = await team2('일시2');
  // (가) 두 번 다 실패: 자동 다시 한 번 뒤 오류 대기
  if (hasGit) {
    const sid = await goal(tm, repo('net2'), `NETFAIL2:${b.name}`);
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.equal(lines(sid, 'transient').length, 1);
    assert.equal(errorAnswers(sid, b.id).length, 2);
    // 오류 줄의 종류도 일시 장애(코드가 오류 문구로 가른 것)
    assert.equal(lines(sid, 'error').at(-1).fail, 'transient');
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'skip' });
    await ended(sid);
  } else tt.diagnostic('git 이 없어 (가) 는 건너뜀');
  // (나) 실패하기 전에 작업 폴더의 파일을 바꿈: 자동 다시 없이 묻는다(이유 한 줄)
  if (hasGit) {
    const sid = await goal(tm, repo('net3'), `NETFAILWRITE:${b.name}`);
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.equal(errorAnswers(sid, b.id).length, 1, '다시 돌지 않음');
    assert.equal(lines(sid, 'transient').filter((x) => x.fail).length, 0);
    assert.match(lines(sid, 'transient').at(-1)?.text || '', /바뀌어서|바꿨/);
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => idle(sid), 20000, '멈춤');
  }
  // (다) git 저장소가 아닌 폴더: 확인을 못 하니 자동으로 다시 하지 않는다
  {
    const plain = path.join(t.root, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    const sid = await goal(tm, plain, `NETFAIL1:${b.name}`);
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.equal(errorAnswers(sid, b.id).length, 1);
    assert.match(lines(sid, 'transient').at(-1)?.text || '', /확인하지 못해서/);
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => idle(sid), 20000, '멈춤');
  }
  // (라) 설정으로 끔: 바로 오류 대기(자동 다시 줄 없음)
  if (hasGit) {
    assert.equal((await t.api('PUT', '/api/settings', { transientRetry: false })).json.transientRetry, false);
    try {
      const sid = await goal(tm, repo('net4'), `NETFAIL1:${b.name}`);
      await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
      assert.equal(lines(sid, 'transient').length, 0);
      await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
      await t.waitFor(() => idle(sid), 20000, '멈춤');
    } finally { await t.api('PUT', '/api/settings', { transientRetry: true }); }
  }
});

test('4. 호출 상한이 모자라면 자동으로 다시 하지 않고, 일 카드는 시작 수에 센다(상한에 닿은 카드는 자동 다시 없이 묻는다)', { timeout: 180000 }, async (tt) => {
  if (!hasGit) { tt.skip('git 이 없어 바뀐 파일을 확인할 수 없음'); return; }
  await app();
  const { b, tm } = await team2('일시3');
  // (가) 호출 상한: 일 단계 두 사람이 CLI 를 띄운 뒤(호출 3번: 목표 잡기 1 + 일 2) 실패하기 전에 남은 호출을 0으로 만든다
  // (테스트용으로 목표의 calls 를 직접 고친다. NETSLOW 는 실패를 1.5초 늦춘다)
  {
    const sid = await goal(tm, repo('net5'), `NETFAIL1:${b.name} NETSLOW`);
    await t.waitFor(() => S(sid).mission.calls.used >= 3, 20000, '일 단계 두 사람 시작');
    const m = S(sid).mission;
    m.calls.cap = m.calls.used; // 자동 다시에 쓸 호출이 없다
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.equal(errorAnswers(sid, b.id).length, 1, '상한이 모자라서 다시 안 돎');
    assert.match(lines(sid, 'transient').at(-1)?.text || '', /호출/);
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => idle(sid), 20000, '멈춤');
  }
  // (나) 일 카드: k2(담당 b)가 일시 장애 한 번 → 자동 다시, 그 카드의 시작 수는 2
  {
    const sid = await goal(tm, repo('net6'), `NETFAIL1:${b.name} PLANBUILD1`, 'cards');
    await ended(sid);
    const m = S(sid).mission;
    const k = m.cards.find((c) => c.ownerId === b.id);
    assert.equal(k.status, 'done');
    assert.equal(k.starts, 2, '자동 다시도 카드 시작 수에 센다');
    assert.equal(lines(sid, 'transient').filter((x) => x.fail === 'transient').length, 1);
  }
  // (다) 사다리 팀(실패 1번이면 묻기, 결정 0027): 카드 시작 상한이 1이라 첫 시작에서 이미 상한 → 자동 다시 없이 묻는다
  {
    const { b: b2, tm: tm2 } = await team2('일시4');
    const put = await t.api('PUT', `/api/teams/${tm2.id}`, { ...tm2, ladder: true, escalateAfter: 1 });
    assert.equal(put.json.escalateAfter, 1);
    const sid = await goal(tm2, repo('net7'), `NETFAIL1:${b2.name} PLANBUILD1`, 'cards');
    await t.waitFor(() => S(sid).runs.at(-1)?.hold?.reason === 'error', 30000, '오류 대기');
    assert.match(lines(sid, 'transient').at(-1)?.text || '', /시작한 횟수가 상한/);
    assert.equal(S(sid).mission.cards.find((c) => c.ownerId === b2.id).starts, 1);
    await t.api('POST', `/api/sessions/${sid}/control`, { action: 'stop' });
    await t.waitFor(() => idle(sid), 20000, '멈춤');
  }
});
