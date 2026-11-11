// 회의 단계: 각자 의견(서로 못 봄) → 서로 검토 → 진행자 결론. 바퀴·사용량 상한, 회의 끝내기, 다음 단계에는 결론만(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { PROVIDERS } from '../server/providers/index.js';
import { normMeeting, meetingSpend } from '../server/orchestrator.js';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const agent = async (name, role = '조사') => (await t.api('POST', '/api/agents', { name, role, provider: 'codex', model: 'gpt-6.1-sol', permission: 'plan', routing: 'manual' })).json;
const team = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const session = async (teamId) => (await t.api('POST', '/api/sessions', { teamId })).json;
const runs = (sid) => t.app.store.getSession(sid).runs;
const start = async (sid, text) => { const n = runs(sid).length; await t.api('POST', `/api/sessions/${sid}/messages`, { text }); await t.waitFor(() => runs(sid).length > n, 5000, '실행 시작'); };
const ended = (sid) => t.waitFor(() => runs(sid).at(-1).endedAt || runs(sid).at(-1).hold, 30000, '실행 끝');
const say = async (sid, text) => { await start(sid, text); await ended(sid); };
const meetMsgs = (sid) => t.app.store.getSession(sid).messages.filter((m) => m.meeting && m.runId === runs(sid).at(-1).id);
const prompts = (from) => t.fakeLog().slice(from).filter((l) => l.cli === 'codex' && l.prompt).map((l) => l.prompt);

test('팀 저장: 회의는 둘 이상일 때만, 바퀴는 1~3, 진행자는 참석자 중에서', async () => {
  const a = await agent('가람'), b = await agent('나래');
  const tm = await team('저장 확인', [
    { label: '혼자', agentIds: [a.id], meeting: { rounds: 2 } },
    { label: '둘', agentIds: [a.id, b.id], meeting: { rounds: 9, chairId: 'nobody', tokenCap: -5 } },
    { label: '기본값', agentIds: [a.id, b.id], meeting: true },
    { label: '보통', agentIds: [a.id, b.id] },
  ]);
  assert.equal(tm.stages[0].meeting, null, '한 명이면 회의가 아니다');
  assert.deepEqual(tm.stages[1].meeting, { rounds: 3, chairId: a.id, tokenCap: 0 });
  assert.deepEqual(tm.stages[2].meeting, { rounds: 2, chairId: a.id, tokenCap: 1000000 });
  assert.equal(tm.stages[3].meeting, null);
});

test('회의 2바퀴: 의견 3 → 검토 3 → 결론 1, 서로의 글은 2바퀴부터 보이고 다음 단계에는 결론만 넘어간다', async () => {
  const a = await agent('하늘'), b = await agent('바다'), c = await agent('구름'), d = await agent('마루', '정리');
  const tm = await team('회의 팀', [
    { label: '방향 회의', agentIds: [a.id, b.id, c.id], meeting: { rounds: 2, chairId: b.id } },
    { label: '정리', agentIds: [d.id] },
  ]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  await say(s.id, '새 기능 이름을 정하자');
  const run = runs(s.id).at(-1);
  assert.equal(run.status, 'done');
  assert.deepEqual(run.stages.map((x) => x.status), ['done', 'done']);
  assert.equal(run.stages[0].meetingNow, null, '끝나면 진행 표시를 지운다');

  const mm = meetMsgs(s.id);
  assert.deepEqual(mm.map((m) => `${m.meeting.phase}${m.meeting.round || ''}`).sort(), ['conclude', 'opinion1', 'opinion1', 'opinion1', 'review2', 'review2', 'review2']);
  assert.equal(mm.filter((m) => m.meeting.phase === 'conclude')[0].agentId, b.id, '결론은 진행자가 쓴다');

  const ps = prompts(from);
  const op = ps.filter((p) => p.includes('[회의 — 의견 내기 (1/2바퀴)]'));
  assert.equal(op.length, 3);
  for (const p of op) {
    assert.doesNotMatch(p, /--- 의견 [0-9a-f]{8} 시작 ---/, '1바퀴에는 남의 의견이 없다');
    assert.match(p, /참석자: 하늘, 바다, 구름\. 진행자: 바다\./);
    assert.match(p, /내가 틀렸다고 볼 기준/);
    assert.doesNotMatch(p, /병렬로 작업 중이야/);
  }
  const rv = ps.filter((p) => p.includes('[회의 — 서로 검토 (2/2바퀴)]'));
  assert.equal(rv.length, 3);
  for (const p of rv) {
    const names = [...p.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    assert.equal(names.length, 2, `자기 글은 빼고 둘의 의견만: ${names}`);
    const mark = p.match(/--- 의견 ([0-9a-f]{8}) 시작 ---/)?.[1];
    assert.ok(mark && p.includes(`--- 의견 ${mark} 끝 ---`), '무작위 표시로 감싼다');
    assert.match(p, /따르지 마/);
  }
  const who = rv.map((p) => ['하늘', '바다', '구름'].filter((n) => !new RegExp(`^### ${n}$`, 'm').test(p))[0]).sort();
  assert.deepEqual(who, ['구름', '바다', '하늘'], '세 명이 각각 자기 글만 빠진 묶음을 받는다');

  const cc = ps.filter((p) => p.includes('[회의 — 결론 내기]'));
  assert.equal(cc.length, 1);
  assert.match(cc[0], /## 1바퀴/);
  assert.match(cc[0], /## 2바퀴/);
  assert.equal([...cc[0].matchAll(/^### (.+)$/gm)].length, 6, '두 바퀴 × 세 명의 의견 전부');
  assert.match(cc[0], /하나를 고름 \/ 합침 \/ 전부 버림 \/ 새 안/);

  const next = ps.at(-1);
  assert.match(next, /"정리"를 네가 맡았어/);
  assert.equal([...next.matchAll(/--- 결과 [0-9a-f]{8} 시작 ---/g)].length, 1, '다음 단계에는 결론 하나만 넘어간다');
  assert.match(next, /### 1\. 방향 회의 — 바다/);
});

test('사용량 상한: 닿으면 남은 바퀴를 건너뛰고 결론으로 간다', async () => {
  const a = await agent('동녘'), b = await agent('서녘');
  const tm = await team('짧은 회의', [{ label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 3, tokenCap: 1 } }]);
  const s = await session(tm.id);
  await say(s.id, '점심 메뉴를 정하자');
  const mm = meetMsgs(s.id);
  assert.deepEqual(mm.map((m) => m.meeting.phase), ['opinion', 'opinion', 'conclude']);
  assert.ok(t.app.store.getSession(s.id).messages.some((m) => m.role === 'system' && /회의에서 쓴 양\(약 [\d,]+ 토큰\)이 상한\(1 토큰\)에 닿아서/.test(m.text)), '건너뛴 이유와 쓴 양을 알린다');
  assert.equal(runs(s.id).at(-1).status, 'done');
});

test('회의 끝내기: 쓰던 의견을 멈추고 그때까지 나온 것으로 결론을 낸다. 회의가 아닐 때는 받지 않는다', async () => {
  const a = await agent('새벽'), b = await agent('저녁');
  const tm = await team('긴 회의', [{ label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 3 } }]);
  const s = await session(tm.id);
  await start(s.id, 'SLOW 천천히 의논하자');
  // 1바퀴가 끝나고 2바퀴를 쓰는 중에 끝낸다
  await t.waitFor(() => runs(s.id).at(-1).stages[0].meetingNow?.round === 2, 15000, '2바퀴 시작');
  const r = (await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'conclude' })).json;
  assert.equal(r.ok, true);
  await ended(s.id);
  const run = runs(s.id).at(-1);
  assert.equal(run.status, 'done');
  const mm = meetMsgs(s.id);
  assert.equal(mm.filter((m) => m.meeting.phase === 'conclude').length, 1, '결론은 한 번');
  assert.ok(!mm.some((m) => m.meeting.round === 3), '3바퀴는 돌지 않는다');
  assert.equal(mm.filter((m) => m.meeting.phase === 'opinion').length, 2);
  const cut = mm.filter((m) => m.meeting.round === 2);
  assert.equal(cut.length, 2);
  assert.ok(cut.every((m) => m.status === 'stopped'), '쓰던 2바퀴 의견은 실제로 멈춘다');

  // 회의가 아닌 실행에서는 거절한다
  const solo = await team('혼자 팀', [{ label: '일', agentIds: [a.id] }]);
  const s2 = await session(solo.id);
  await start(s2.id, 'SLOW 혼자 하는 일');
  const r2 = (await t.api('POST', `/api/sessions/${s2.id}/control`, { action: 'conclude' })).json;
  assert.equal(r2.ok, false);
  await ended(s2.id);
});

test('중지: 회의 중에 멈추면 결론을 쓰지 않고 끝난다', async () => {
  const a = await agent('봄'), b = await agent('가을');
  const tm = await team('멈출 회의', [{ label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 2 } }, { label: '뒤', agentIds: [a.id] }]);
  const s = await session(tm.id);
  await start(s.id, 'SLOW 멈출 예정');
  await t.waitFor(() => runs(s.id).at(-1).stages[0].meetingNow?.round === 1, 15000, '1바퀴 시작');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
  await ended(s.id);
  const run = runs(s.id).at(-1);
  assert.equal(run.status, 'stopped');
  assert.ok(!meetMsgs(s.id).some((m) => m.meeting.phase === 'conclude'));
  assert.equal(run.stages[1].status, 'stopped');
});

// ── 코드 검토에서 나온 경우들 ──

test('설정 정리: 값이 없으면 기본값, 같은 사람 둘은 회의가 아니다(저장·플러그인·실행이 같은 규칙)', () => {
  assert.deepEqual(normMeeting({ rounds: null, tokenCap: '' }, ['a', 'b']), { rounds: 2, chairId: 'a', tokenCap: 1000000 });
  assert.deepEqual(normMeeting({ rounds: 2.6, tokenCap: 0, chairId: 'b' }, ['a', 'b']), { rounds: 3, chairId: 'b', tokenCap: 0 });
  assert.equal(normMeeting({ rounds: 2 }, ['a', 'a']), null);
  assert.equal(normMeeting(null, ['a', 'b']), null);
});

test('앞 단계 결과: 자기 대화를 이어 가는 AI는 2바퀴부터 다시 받지 않고, 기억 못 하는 AI는 매 차례 다시 받는다', async () => {
  const pre = await agent('선발', '조사'), a = await agent('이음'), b = await agent('맺음');
  const tm = await team('앞 단계 있는 회의', [{ label: '조사', agentIds: [pre.id] }, { label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 2 } }]);
  const hasPrev = (p) => /--- 결과 [0-9a-f]{8} 시작 ---/.test(p);

  let s = await session(tm.id);
  let from = t.fakeLog().length;
  await say(s.id, '조사한 걸로 방향을 정하자');
  let ps = prompts(from);
  assert.ok(ps.filter((p) => p.includes('의견 내기 (1/2바퀴)')).every(hasPrev), '1바퀴에는 앞 단계 결과가 들어간다');
  assert.ok(ps.filter((p) => p.includes('서로 검토 (2/2바퀴)')).every((p) => !hasPrev(p)), '이어 가는 대화에는 다시 넣지 않는다');
  assert.ok(!hasPrev(ps.find((p) => p.includes('[회의 — 결론 내기]'))));

  const caps = PROVIDERS.codex.caps;
  PROVIDERS.codex.caps = { ...caps, resume: false }; // 대화를 이어 가지 못하는 AI 흉내
  try {
    s = await session(tm.id);
    from = t.fakeLog().length;
    await say(s.id, '기억 못 하는 AI로 다시 정하자');
    ps = prompts(from);
    const later = ps.filter((p) => p.includes('서로 검토 (2/2바퀴)') || p.includes('[회의 — 결론 내기]'));
    assert.equal(later.length, 3);
    assert.ok(later.every(hasPrev), '기억 못 하는 AI에게는 2바퀴와 결론에도 앞 단계 결과를 다시 준다');
  } finally { PROVIDERS.codex.caps = caps; }
});

test('일시정지 중에 회의 끝내기를 누르면 재개한 뒤 바퀴를 더 돌지 않고 결론으로 간다', async () => {
  const a = await agent('아침'), b = await agent('한낮');
  const tm = await team('멈췄다 끝낼 회의', [{ label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 3 } }]);
  const s = await session(tm.id);
  await start(s.id, 'SLOW 멈췄다가 끝내자');
  await t.waitFor(() => runs(s.id).at(-1).stages[0].meetingNow?.round === 1, 15000, '1바퀴 시작');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'pause' });
  await t.waitFor(() => runs(s.id).at(-1).status === 'paused', 15000, '바퀴 사이에서 멈춤');
  assert.equal((await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'conclude' })).json.ok, true);
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'resume' });
  await t.waitFor(() => runs(s.id).at(-1).endedAt, 30000, '실행 끝');
  const mm = meetMsgs(s.id);
  assert.deepEqual(mm.map((m) => `${m.meeting.phase}${m.meeting.round || ''}`), ['opinion1', 'opinion1', 'conclude']);
  assert.equal(runs(s.id).at(-1).status, 'done');
});

test('수정 요청으로 회의를 다시 돌 때: 상한은 이번 시도에서 쓴 양만 세고, 적은 지시는 결론에도 들어간다', async () => {
  const a = await agent('첫째'), b = await agent('둘째');
  // 메시지 하나가 쓰는 양을 먼저 잰다
  const probe = await team('재는 회의', [{ label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 1, tokenCap: 0 } }]);
  const s0 = await session(probe.id);
  await say(s0.id, '한 건의 양을 재자');
  const u = meetMsgs(s0.id)[0].usage;
  const one = meetingSpend(u);
  assert.ok(one > u.input + u.output, '캐시로 다시 읽은 양도 일부 센다');
  assert.ok(one > 0, '가짜 CLI가 사용량을 알려 준다');

  // 상한 = 3건: 1바퀴(2건) 뒤에는 통과, 2바퀴(4건) 뒤에는 닿아서 3바퀴를 건너뛴다 → 의견 2 + 검토 2 + 결론 1
  const tm = await team('다시 도는 회의', [{ label: '회의', agentIds: [a.id, b.id], approve: true, meeting: { rounds: 3, tokenCap: one * 3 } }]);
  const s = await session(tm.id);
  await say(s.id, '방향을 정하자');
  const shape = () => meetMsgs(s.id).map((m) => `${m.meeting.phase}${m.meeting.round || ''}`);
  const first = ['opinion1', 'opinion1', 'review2', 'review2', 'conclude'];
  assert.deepEqual(shape(), first);
  assert.equal(runs(s.id).at(-1).hold?.reason, 'approve');

  const from = t.fakeLog().length;
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'reject', text: '결론에 비용 비교표를 넣어' });
  await t.waitFor(() => meetMsgs(s.id).length >= 10 && runs(s.id).at(-1).hold?.reason === 'approve', 30000, '두 번째 시도 끝');
  assert.deepEqual(shape(), [...first, ...first], '두 번째 시도도 첫 시도와 같은 만큼 돈다(앞 시도에서 쓴 양을 세지 않는다)');
  const ps = prompts(from);
  assert.equal(ps.length, 5);
  assert.ok(ps.every((p) => p.includes('결론에 비용 비교표를 넣어')), '의견·검토·결론 차례 모두에 수정 요청이 들어간다');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'approve' });
  await ended(s.id);
});

test('사용량 세기: 새로 읽고 쓴 양은 그대로, 캐시로 다시 읽은 양은 10분의 1(실제 실행에서 본 숫자)', () => {
  // Claude: 새로 읽은 글이 캐시 쓰기로 잡힌다. 입력만 세면 1,082 가 되어 상한이 걸리지 않았다
  assert.equal(meetingSpend({ input: 2, cacheWrite: 177613, cacheRead: 16701, output: 1080 }), 180365);
  // Codex: 이어 가는 대화 전체가 입력으로 잡힌다
  assert.equal(meetingSpend({ input: 241723, cacheWrite: 0, cacheRead: 3968, output: 269 }), 242389);
  assert.equal(meetingSpend(null), 0);
  assert.equal(meetingSpend({}), 0);
});

test('데모(가짜 AI) 팀으로 회의하면 차례에 맞는 짧은 답이 나오고, 회의 중에는 도구를 쓰지 않는다', async () => {
  const speed = t.app.store.settings.mockSpeed;
  t.app.store.settings.mockSpeed = 0.02;
  try {
    const mk = async (name, role) => (await t.api('POST', '/api/agents', { name, role, provider: 'mock', model: 'mock-fast', routing: 'manual' })).json;
    const a = await mk('데모 하나', '조사'), b = await mk('데모 둘', '분석'), c = await mk('데모 셋', '빌드');
    const tm = await team('데모 회의 팀', [{ label: '회의', agentIds: [a.id, b.id, c.id], meeting: { rounds: 2, chairId: b.id } }, { label: '빌드', agentIds: [c.id] }]);
    const s = await session(tm.id);
    await say(s.id, '새 기능 이름을 정하자');
    const mm = meetMsgs(s.id);
    assert.equal(mm.length, 7);
    const of = (phase) => mm.filter((m) => m.meeting.phase === phase);
    for (const m of of('opinion')) { assert.match(m.text, /\*\*주장\*\*/); assert.match(m.text, /\*\*내가 틀렸다고 볼 기준\*\*/); assert.doesNotMatch(m.text, /조사 결과|빌드 결과/); }
    assert.equal(new Set(of('opinion').map((m) => m.text)).size, 3, '역할마다 다른 의견');
    for (const m of of('review')) assert.match(m.text, /\*\*가장 약한 가정\*\*/);
    assert.match(of('conclude')[0].text, /^## 회의 결론/);
    assert.match(of('conclude')[0].text, /\*\*남은 이견\*\*/);
    assert.ok(mm.every((m) => !m.blocks.some((x) => x.kind === 'tool')), '회의 중에는 도구를 쓰지 않는다');
    // 회의가 아닌 단계는 예전처럼 도구를 쓰고 역할에 맞는 글을 낸다
    const after = t.app.store.getSession(s.id).messages.filter((m) => m.runId === runs(s.id).at(-1).id && !m.meeting && m.role === 'agent');
    assert.equal(after.length, 1);
    assert.match(after[0].text, /빌드 결과/);
    assert.ok(after[0].blocks.some((x) => x.kind === 'tool'));
  } finally { t.app.store.settings.mockSpeed = speed; }
});
