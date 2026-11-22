// 회의 단계: 각자 의견(서로 못 봄) → 한 명씩 차례 발언(반대편이 맨 앞) → 바퀴마다 진행자 판정 → 진행자 결론.
// 바퀴·사용량 상한, 회의 끝내기, 다음 단계에는 결론만(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { PROVIDERS } from '../server/providers/index.js';
import { normMeeting, meetingSpend } from '../server/orchestrator.js';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const agent = async (name, role = '조사') => (await t.api('POST', '/api/agents', { name, role, provider: 'codex', model: 'gpt-6.1-sol', permission: 'plan', routing: 'manual' })).json;
// 가짜 claude 는 판정 차례에 판정 블록을 낸다(AGREEFAST → 합의, BADVERDICT → 틀린 형식, 그 밖 → 계속)
const cagent = async (name, role = '분석') => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'sonnet', permission: 'plan', routing: 'manual' })).json;
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
    { label: '둘', agentIds: [a.id, b.id], meeting: { rounds: 9, chairId: 'nobody', tokenCap: -5, opposeId: 'nobody' } },
    { label: '기본값', agentIds: [a.id, b.id], meeting: true },
    { label: '보통', agentIds: [a.id, b.id] },
    { label: '진행자가 반대편', agentIds: [a.id, b.id], meeting: { chairId: b.id, opposeId: b.id } },
    { label: '반대편 지정', agentIds: [a.id, b.id], meeting: { chairId: a.id, opposeId: b.id } },
  ]);
  assert.equal(tm.stages[0].meeting, null, '한 명이면 회의가 아니다');
  assert.deepEqual(tm.stages[1].meeting, { rounds: 3, chairId: a.id, tokenCap: 0, opposeId: null }, '참석자가 아닌 반대편은 비운다');
  assert.deepEqual(tm.stages[2].meeting, { rounds: 2, chairId: a.id, tokenCap: 1000000, opposeId: null }, '설정이 없던 회의는 반대편 자동');
  assert.equal(tm.stages[3].meeting, null);
  assert.equal(tm.stages[4].meeting.opposeId, null, '진행자는 반대편이 못 된다');
  assert.equal(tm.stages[5].meeting.opposeId, b.id, '참석자인 반대편은 그대로');
});

test('회의 2바퀴: 의견 3 → 차례 2 → 결론 1, 차례 발언은 앞사람 말을 보고 다음 단계에는 결론만 넘어간다', async () => {
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
  assert.deepEqual(mm.map((m) => m.meeting.phase), ['opinion', 'opinion', 'opinion', 'turn', 'turn', 'conclude'], '2바퀴가 마지막이라 판정은 없다');
  const turns = mm.filter((m) => m.meeting.phase === 'turn');
  assert.deepEqual(turns.map((m) => m.agentId), [c.id, a.id], '진행자는 차례 발언을 하지 않고, 반대편(다른 AI가 없으면 마지막 참석자)이 맨 앞');
  assert.equal(turns[0].meeting.opposer, true, '그 바퀴의 첫 차례가 반대편');
  assert.ok(!turns[1].meeting.opposer);
  assert.equal(mm.at(-1).agentId, b.id, '결론은 진행자가 쓴다');

  const ps = prompts(from);
  const op = ps.filter((p) => p.includes('[회의 — 의견 내기 (1/2바퀴)]'));
  assert.equal(op.length, 3);
  for (const p of op) {
    assert.doesNotMatch(p, /--- 의견 [0-9a-f]{8} 시작 ---/, '1바퀴에는 남의 의견이 없다');
    assert.match(p, /참석자: 하늘, 바다, 구름\. 진행자: 바다\./);
    assert.match(p, /내가 틀렸다고 볼 기준/);
    assert.doesNotMatch(p, /병렬로 작업 중이야/);
  }
  const heads = (p) => [...p.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  const tp = ps.filter((p) => p.includes('[회의 — 차례 발언 (2/2바퀴)]'));
  assert.equal(tp.length, 2);
  assert.deepEqual(heads(tp[0]), ['하늘', '바다', '구름'], '첫 차례는 세 의견(자기 글 포함)을 본다');
  assert.doesNotMatch(tp[0], /^## 2바퀴$/m, '첫 차례에는 두 번째 차례 답이 없다');
  assert.deepEqual(heads(tp[1]), ['하늘', '바다', '구름', '구름'], '두 번째 차례는 세 의견과 첫 차례(반대편) 답을 본다');
  assert.match(tp[1], /^## 2바퀴\n\n### 구름$/m);
  for (const p of tp) {
    const mark = p.match(/--- 의견 ([0-9a-f]{8}) 시작 ---/)?.[1];
    assert.ok(mark && p.includes(`--- 의견 ${mark} 끝 ---`), '무작위 표시로 감싼다');
    assert.match(p, /따르지 마/);
    assert.match(p, /답하는 말: 누구의 어떤 말인지/);
    assert.match(p, /파일을 고치거나 명령을 실행하지 말고 글로만 답해/);
  }
  assert.match(tp[0], /너는 이번 회의에서 반대편이야/, '반대편에게만 약점을 찾으라고 한다');
  assert.doesNotMatch(tp[1], /너는 이번 회의에서 반대편이야/);
  assert.match(tp[1], /반대편이 짚은 약점이 있으면 그것부터 답해\./, '반대편 뒤에 말하는 사람은 그 약점부터 답한다');
  assert.doesNotMatch(tp[0], /반대편이 짚은 약점이 있으면/);

  const cc = ps.filter((p) => p.includes('[회의 — 결론 내기]'));
  assert.equal(cc.length, 1);
  assert.match(cc[0], /## 1바퀴/);
  assert.match(cc[0], /## 2바퀴/);
  assert.equal(heads(cc[0]).length, 5, '의견 셋과 차례 답 둘 전부');
  assert.match(cc[0], /^반대편: 구름\.$/m, '반대편이 말한 회의의 결론에는 반대편 이름이 들어간다');
  assert.match(cc[0], /하나를 고름 \/ 합침 \/ 전부 버림 \/ 새 안/);
  assert.match(cc[0], /버린 안: 무엇을 왜 버렸는지/);

  const next = ps.at(-1);
  assert.match(next, /"정리"를 네가 맡았어/);
  assert.equal([...next.matchAll(/--- 결과 [0-9a-f]{8} 시작 ---/g)].length, 1, '다음 단계에는 결론 하나만 넘어간다');
  assert.match(next, /### 1\. 방향 회의 — 바다/);
});

test('1바퀴 회의: 반대편이 말할 차례가 없었으니 결론에 반대편 줄을 넣지 않는다', async () => {
  const a = await agent('한빛'), b = await agent('한결');
  const tm = await team('한 바퀴 회의', [{ label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 1 } }]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  await say(s.id, '한 바퀴로 정하자');
  assert.deepEqual(meetMsgs(s.id).map((m) => m.meeting.phase), ['opinion', 'opinion', 'conclude']);
  const cc = prompts(from).filter((p) => p.includes('[회의 — 결론 내기]'));
  assert.equal(cc.length, 1);
  assert.doesNotMatch(cc[0], /반대편: /);
});

test('3바퀴: 2바퀴 뒤 진행자가 판정하고, 합의면 3바퀴를 건너뛴다', async () => {
  const a = await agent('여울'), b = await agent('시내'), ch = await cagent('호수');
  const tm = await team('판정 회의', [{ label: '회의', agentIds: [a.id, b.id, ch.id], meeting: { rounds: 3, chairId: ch.id } }]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  await say(s.id, 'AGREEFAST 방향을 정하자');
  assert.equal(runs(s.id).at(-1).status, 'done');
  const mm = meetMsgs(s.id);
  assert.deepEqual(mm.map((m) => m.meeting.phase), ['opinion', 'opinion', 'opinion', 'turn', 'turn', 'judge', 'conclude']);
  const j = mm.find((m) => m.meeting.phase === 'judge');
  assert.equal(j.agentId, ch.id, '판정은 진행자가 한다');
  assert.equal(j.meeting.round, 2);
  assert.deepEqual(j.verdict, { verdict: 'agree', reason: '가짜 판정' });
  assert.doesNotMatch(j.text, /oc-verdict/, '읽은 판정 블록은 글에서 지운다');
  assert.match(j.text, /판정할게/);
  const jp = t.fakeLog().slice(from).filter((l) => l.cli === 'claude' && l.text?.includes('[회의 — 판정 (2/3바퀴)]'));
  assert.equal(jp.length, 1);
  assert.match(jp[0].text, /반대편을 뺀 참석자들의 "입장"이 같은 안을 가리키고, 반대편의 지적 중에 결론을 바꿀 만한 것이 답 없이 남아 있지 않으면 합의야\./);
  assert.match(jp[0].text, /```oc-verdict\n\{"verdict":"agree 또는 continue","reason":"한 문장"\}\n```/);
  assert.match(jp[0].text, /\[사용자 요청\]\nAGREEFAST/, '판정 차례에도 이번 요청 부분이 들어간다(가짜 claude 가 거기서 신호어를 본다)');
  assert.match(jp[0].text, /--- 의견 [0-9a-f]{8} 시작 ---/, '판정에 들어가는 글도 표시로 감싼다');
});

test('판정이 계속이면 다음 바퀴를 돈다. 판정 형식이 틀리면 계속으로 보고 알린다', async () => {
  const a = await agent('들녘'), b = await agent('언덕'), ch = await cagent('고개');
  const tm = await team('계속 회의', [{ label: '회의', agentIds: [a.id, b.id, ch.id], meeting: { rounds: 3, chairId: ch.id } }]);
  const shape = ['opinion', 'opinion', 'opinion', 'turn', 'turn', 'judge', 'turn', 'turn', 'conclude'];
  let s = await session(tm.id);
  await say(s.id, '계속 의논하자');
  let mm = meetMsgs(s.id);
  assert.deepEqual(mm.map((m) => m.meeting.phase), shape);
  assert.deepEqual(mm.filter((m) => m.meeting.phase === 'turn').map((m) => m.meeting.round), [2, 2, 3, 3]);
  let j = mm.find((m) => m.meeting.phase === 'judge');
  assert.equal(j.verdict?.verdict, 'continue');
  assert.doesNotMatch(j.text, /oc-verdict/);
  assert.equal(runs(s.id).at(-1).status, 'done');

  s = await session(tm.id);
  await say(s.id, 'BADVERDICT 계속 의논하자');
  mm = meetMsgs(s.id);
  assert.deepEqual(mm.map((m) => m.meeting.phase), shape, '형식이 틀린 판정은 계속으로 본다');
  j = mm.find((m) => m.meeting.phase === 'judge');
  assert.equal(j.verdict, undefined);
  assert.ok(j.blocks.some((x) => x.kind === 'notice' && x.text === '판정 형식이 맞지 않아서 "계속"으로 봤어.'), '알림을 붙인다');
  assert.match(j.text, /```oc-verdict/, '못 읽은 블록은 글로 남긴다');
});

test('참석자가 둘이면 진행자가 아닌 한 명이 반대편으로 차례 발언을 한다', async () => {
  const a = await agent('솔'), b = await agent('잣');
  const tm = await team('둘 회의', [{ label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 2 } }]);
  const s = await session(tm.id);
  await say(s.id, '둘이서 정하자');
  const mm = meetMsgs(s.id);
  assert.deepEqual(mm.map((m) => m.meeting.phase), ['opinion', 'opinion', 'turn', 'conclude']);
  const turn = mm.find((m) => m.meeting.phase === 'turn');
  assert.equal(turn.agentId, b.id, '진행자(기본 첫 참석자)가 아닌 한 명');
  assert.equal(turn.meeting.opposer, true);

  // 3바퀴: 한 명의 독백 뒤에도 판정이 돌고, 블록 없는 판정은 알림 없이 계속으로 본다
  const tm3 = await team('둘 회의 3바퀴', [{ label: '회의', agentIds: [a.id, b.id], meeting: { rounds: 3 } }]);
  const s3 = await session(tm3.id);
  await say(s3.id, '둘이서 더 정하자');
  const m3 = meetMsgs(s3.id);
  assert.deepEqual(m3.map((m) => m.meeting.phase), ['opinion', 'opinion', 'turn', 'judge', 'turn', 'conclude']);
  const j = m3.find((m) => m.meeting.phase === 'judge');
  assert.equal(j.agentId, a.id);
  assert.equal(j.verdict, undefined);
  assert.ok(!j.blocks.some((x) => x.kind === 'notice' && /판정 형식/.test(x.text)), '블록이 없을 때는 알리지 않는다');
  assert.equal(runs(s3.id).at(-1).status, 'done');
});

test('차례 중 오류·건너뛰기: 그 사람 차례만 빠지고 다음 사람이 말한다. 아무도 못 말한 바퀴는 판정 없이 결론으로 간다', async () => {
  const ch = await agent('들보'), ok = await agent('기둥'), bad = await cagent('서까래'), bad2 = await cagent('추녀');
  // 반대편을 서까래로 정해 둬서 차례가 서까래(실패) → 기둥 순서가 되게 한다
  const tm = await team('실패 섞인 회의', [{ label: '회의', agentIds: [ch.id, bad.id, ok.id], meeting: { rounds: 2, chairId: ch.id, opposeId: bad.id } }]);
  let s = await session(tm.id);
  await say(s.id, 'FAILME 정하자');
  let mm = meetMsgs(s.id);
  assert.deepEqual(mm.map((m) => m.meeting.phase), ['opinion', 'opinion', 'opinion', 'turn', 'turn', 'conclude']);
  assert.deepEqual(mm.filter((m) => m.meeting.phase === 'turn').map((m) => [m.agentId, m.status]), [[bad.id, 'error'], [ok.id, 'done']]);
  assert.ok(t.app.store.getSession(s.id).messages.some((m) => m.role === 'system' && m.text.includes('회의 2바퀴에서 서까래의 답을 받지 못했어')));
  assert.equal(runs(s.id).at(-1).status, 'done');

  // 차례 발언자가 모두 실패한 바퀴: 판정 없이 결론(3바퀴여도 다음 바퀴를 돌지 않는다)
  const all = await team('모두 실패하는 차례', [{ label: '회의', agentIds: [ch.id, bad.id, bad2.id], meeting: { rounds: 3, chairId: ch.id } }]);
  s = await session(all.id);
  await say(s.id, 'FAILME 정하자');
  mm = meetMsgs(s.id);
  assert.deepEqual(mm.map((m) => m.meeting.phase), ['opinion', 'opinion', 'opinion', 'turn', 'turn', 'conclude']);
  assert.equal(mm.at(-1).status, 'done');
  assert.equal(runs(s.id).at(-1).status, 'done');

  // 건너뛰기: 첫 차례(반대편)를 건너뛰면 다음 사람이 이어 말하고, 건너뛴 차례의 글은 다음 사람에게 가지 않는다
  const a = await agent('처마'), b = await agent('마당'), c = await agent('대문');
  const three = await team('건너뛸 회의', [{ label: '회의', agentIds: [a.id, b.id, c.id], meeting: { rounds: 2, chairId: a.id } }]);
  s = await session(three.id);
  const from = t.fakeLog().length;
  await start(s.id, 'SLOW 하나씩 정하자');
  await t.waitFor(() => runs(s.id).at(-1).stages[0].meetingNow?.speakerId === c.id, 15000, '첫 차례 시작');
  await t.waitFor(async () => (await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'skip', agentId: c.id })).json?.ok, 15000, '첫 차례 건너뛰기');
  await ended(s.id);
  mm = meetMsgs(s.id);
  assert.deepEqual(mm.map((m) => m.meeting.phase), ['opinion', 'opinion', 'opinion', 'turn', 'turn', 'conclude']);
  assert.deepEqual(mm.filter((m) => m.meeting.phase === 'turn').map((m) => [m.agentId, m.status]), [[c.id, 'stopped'], [b.id, 'done']]);
  const second = prompts(from).filter((p) => p.includes('[회의 — 차례 발언 (2/2바퀴)]')).at(-1);
  assert.doesNotMatch(second, /^## 2바퀴$/m, '건너뛴 차례의 글은 넘기지 않는다');
  assert.equal(runs(s.id).at(-1).status, 'done');
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
  assert.deepEqual(cut.map((m) => m.meeting.phase), ['turn'], '둘이면 2바퀴 차례 발언은 한 명');
  assert.ok(cut.every((m) => m.status === 'stopped'), '쓰던 차례 발언은 실제로 멈춘다');

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
  assert.deepEqual(normMeeting({ rounds: null, tokenCap: '' }, ['a', 'b']), { rounds: 2, chairId: 'a', tokenCap: 1000000, opposeId: null });
  assert.deepEqual(normMeeting({ rounds: 2.6, tokenCap: 0, chairId: 'b' }, ['a', 'b']), { rounds: 3, chairId: 'b', tokenCap: 0, opposeId: null });
  assert.equal(normMeeting({ chairId: 'b', opposeId: 'a' }, ['a', 'b']).opposeId, 'a');
  assert.equal(normMeeting({ chairId: 'b', opposeId: 'b' }, ['a', 'b']).opposeId, null, '진행자는 반대편이 못 된다');
  assert.equal(normMeeting({ opposeId: 'zzz' }, ['a', 'b']).opposeId, null, '참석자가 아니면 비운다');
  assert.equal(normMeeting(true, ['a', 'b']).opposeId, null, '설정이 없던 옛 팀');
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
  const turnPs = ps.filter((p) => p.includes('차례 발언 (2/2바퀴)'));
  assert.equal(turnPs.length, 1);
  assert.ok(turnPs.every((p) => !hasPrev(p)), '이어 가는 대화에는 다시 넣지 않는다');
  assert.ok(!hasPrev(ps.find((p) => p.includes('[회의 — 결론 내기]'))));

  const caps = PROVIDERS.codex.caps;
  PROVIDERS.codex.caps = { ...caps, resume: false }; // 대화를 이어 가지 못하는 AI 흉내
  try {
    s = await session(tm.id);
    from = t.fakeLog().length;
    await say(s.id, '기억 못 하는 AI로 다시 정하자');
    ps = prompts(from);
    const later = ps.filter((p) => p.includes('차례 발언 (2/2바퀴)') || p.includes('[회의 — 결론 내기]'));
    assert.equal(later.length, 2);
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

  // 상한 = 3건: 1바퀴(2건) 뒤에는 통과해 차례 발언 1건, 그 뒤(3건)에는 닿아서 판정과 3바퀴를 건너뛴다 → 의견 2 + 차례 1 + 결론 1
  const tm = await team('다시 도는 회의', [{ label: '회의', agentIds: [a.id, b.id], approve: true, meeting: { rounds: 3, tokenCap: one * 3 } }]);
  const s = await session(tm.id);
  await say(s.id, '방향을 정하자');
  const shape = () => meetMsgs(s.id).map((m) => `${m.meeting.phase}${m.meeting.round || ''}`);
  const first = ['opinion1', 'opinion1', 'turn2', 'conclude'];
  assert.deepEqual(shape(), first);
  assert.equal(runs(s.id).at(-1).hold?.reason, 'approve');

  const from = t.fakeLog().length;
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'reject', text: '결론에 비용 비교표를 넣어' });
  await t.waitFor(() => meetMsgs(s.id).length >= 8 && runs(s.id).at(-1).hold?.reason === 'approve', 30000, '두 번째 시도 끝');
  assert.deepEqual(shape(), [...first, ...first], '두 번째 시도도 첫 시도와 같은 만큼 돈다(앞 시도에서 쓴 양을 세지 않는다)');
  const ps = prompts(from);
  assert.equal(ps.length, 4);
  assert.ok(ps.every((p) => p.includes('결론에 비용 비교표를 넣어')), '의견·차례·결론 모두에 수정 요청이 들어간다');
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
    assert.deepEqual(mm.map((m) => m.meeting.phase), ['opinion', 'opinion', 'opinion', 'turn', 'research', 'turn', 'conclude'], '데모 반대편이 2바퀴에 질문 하나를 붙이고 조사 역할이 찾아 온다');
    const of = (phase) => mm.filter((m) => m.meeting.phase === phase);
    // 데모 조사: 반대편의 질문을 조사 역할(데모 하나)이 "- 사실 | 출처 | 확인함" 두 줄과 확인 못 함 한 줄로 답한다(출처는 열리지 않는 example.test 주소)
    const [res] = of('research');
    assert.equal(res.agentId, a.id);
    assert.equal(res.checkOf, of('turn')[0].id);
    assert.match(res.text, /\| https:\/\/example\.test\/demo\/check\/source-a \| 확인함/);
    assert.match(res.text, /\| 없음 \| 확인 못 함$/m);
    assert.equal(of('turn')[0].check?.status, 'answered');
    assert.ok(of('turn')[0].check.question.trim());
    assert.equal(of('turn')[1].check, undefined, '반대편이 아닌 차례는 묻지 않는다');
    for (const m of of('opinion')) { assert.match(m.text, /\*\*주장\*\*/); assert.match(m.text, /\*\*내가 틀렸다고 볼 기준\*\*/); assert.doesNotMatch(m.text, /조사 결과|빌드 결과/); }
    assert.equal(new Set(of('opinion').map((m) => m.text)).size, 3, '역할마다 다른 의견');
    for (const m of of('turn')) { assert.match(m.text, /\*\*답하는 말\*\*/); assert.match(m.text, /\*\*입장\*\*/); }
    assert.equal(new Set(of('turn').map((m) => m.text)).size, 2, '차례 발언도 역할마다 다르다');
    const [opp] = of('turn');
    assert.equal(opp.agentId, c.id);
    assert.equal(opp.meeting.opposer, true, '반대편이 그 바퀴에 먼저 말한다');
    assert.match(opp.text, /\*\*내 말\*\*: 그 안의 약점은/, '반대편 차례의 데모 답은 약점을 말한다');
    assert.doesNotMatch(opp.text, /\*\*내 말\*\*: 동의해/, '반대편 답은 "동의해"로 시작하지 않는다');
    for (const m of of('turn')) assert.doesNotMatch(m.text, /담당의/, '회의에 없을 수 있는 역할 이름을 인용하지 않는다');
    assert.match(of('conclude')[0].text, /^## 회의 결론/);
    assert.match(of('conclude')[0].text, /\*\*남은 이견\*\*/);
    assert.match(of('conclude')[0].text, /\*\*버린 안\*\*/);
    assert.ok(mm.every((m) => !m.blocks.some((x) => x.kind === 'tool')), '회의 중에는 도구를 쓰지 않는다');
    // 회의가 아닌 단계는 예전처럼 도구를 쓰고 역할에 맞는 글을 낸다
    const after = t.app.store.getSession(s.id).messages.filter((m) => m.runId === runs(s.id).at(-1).id && !m.meeting && m.role === 'agent');
    assert.equal(after.length, 1);
    assert.match(after[0].text, /빌드 결과/);
    assert.ok(after[0].blocks.some((x) => x.kind === 'tool'));

    // 3바퀴: 데모 진행자는 2바퀴 뒤 판정에서 바로 합의한다
    const tm3 = await team('데모 판정 팀', [{ label: '회의', agentIds: [a.id, b.id, c.id], meeting: { rounds: 3, chairId: b.id } }]);
    const s3 = await session(tm3.id);
    await say(s3.id, '새 기능 이름을 정하자');
    const m3 = meetMsgs(s3.id);
    assert.deepEqual(m3.map((m) => m.meeting.phase), ['opinion', 'opinion', 'opinion', 'turn', 'research', 'turn', 'judge', 'conclude']);
    const j = m3.find((m) => m.meeting.phase === 'judge');
    assert.equal(j.verdict?.verdict, 'agree');
    assert.doesNotMatch(j.text, /oc-verdict/);
    assert.ok(j.text.trim(), '판정 이유 한 문장은 남는다');
    assert.match(j.text, /반대편이 짚은 약점은 결론의 남은 이견에 적을게/);
    assert.doesNotMatch(j.text, /담당의|출처 문제/, '판정 답도 특정 역할·내용을 짚지 않는다');
  } finally { t.app.store.settings.mockSpeed = speed; }
});
