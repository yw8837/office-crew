// 회의 중 조사: 차례 답 끝의 ```oc-check 질문 블록 → 팀의 조사 역할이 한 번 찾아 옴 → 다음 차례부터 표시로 감싼 참고 자료로.
// 질문 블록 읽기·조사 담당 고르기·화면에서 블록 감추기(순수 함수)와 회의 흐름(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startTestApp, freePort } from './helpers.js';
import { createApp } from '../server/index.js';
import { meetingSpend } from '../server/orchestrator.js';
import { CHECK_MAX, parseCheck, checkBlock, pickResearcher } from '../server/meeting.js';
import { hideCheck } from '../public/js/chat-tools.js';
import { bindLang } from '../server/i18n.js';

const blk = (j) => '```oc-check\n' + j + '\n```';

test('질문 블록: 글 맨 끝의 블록만 읽고, 질문은 앞뒤 공백을 뺀 1~300자', () => {
  assert.equal(CHECK_MAX, 3);
  assert.equal(parseCheck('그냥 글'), null);
  assert.equal(parseCheck(''), null);
  const head = '내 말은 이래.\n\n';
  const block = blk('{"question":"  작년 매출이 얼마야?  "}');
  const text = `${head}${block}\n`;
  const c = parseCheck(text);
  assert.equal(c.question, '작년 매출이 얼마야?');
  assert.equal(c.from, head.length);
  assert.equal(text.slice(c.from, c.to), block, 'from/to 가 블록을 정확히 가리킨다');
  assert.equal(parseCheck(`${blk('{"question":"뭐야?"}')}\n뒤에 글`), null, '뒤에 글이 있으면 질문이 아니다');
  assert.equal(parseCheck('```oc-check\n{"question":"닫지 않음"}'), null, '닫지 않은 블록');
  assert.ok(parseCheck(blk('{"question":"   "}')).error, '빈 질문');
  assert.ok(parseCheck(blk('{}')).error, '질문이 없음');
  assert.ok(parseCheck(blk('{"question":3}')).error, '글이 아닌 질문');
  assert.ok(parseCheck(blk(JSON.stringify({ question: '가'.repeat(301) }))).error, '301자');
  assert.equal(parseCheck(blk(JSON.stringify({ question: '가'.repeat(300) }))).question.length, 300, '300자까지는 된다');
  assert.equal(parseCheck(blk(JSON.stringify({ question: '😀'.repeat(300) }))).question, '😀'.repeat(300), '글자 단위로 센다(이모지 300개는 300자)');
  assert.ok(parseCheck(blk(JSON.stringify({ question: '😀'.repeat(301) }))).error, '이모지 301개');
  const bad = parseCheck(`앞\n${blk('{깨짐')}`);
  assert.ok(bad.error, 'JSON 이 깨짐');
  assert.deepEqual([bad.from, bad.to], [2, 2 + blk('{깨짐').length], '형식이 틀려도 블록 자리는 알려 준다(한 말에서 블록을 빼려고)');
  const two = `${blk('{"question":"예시"}')}\n설명\n\n${blk('{"question":"진짜"}')}`;
  assert.equal(parseCheck(two).question, '진짜', '앞에 예로 든 블록이 있어도 맨 끝의 블록만');
});

test('질문 블록 예시: 설명 글은 설정 언어로, 그대로 읽으면 질문이 된다', () => {
  try {
    bindLang(() => 'ko');
    assert.match(checkBlock(), /^```oc-check\n\{"question":"[^"]+"\}\n```$/);
    assert.ok(parseCheck(checkBlock()).question);
    bindLang(() => 'en');
    assert.doesNotMatch(checkBlock(), /[가-힣]/);
    assert.ok(parseCheck(checkBlock()).question);
  } finally { bindLang(() => 'ko'); }
});

test('조사 담당 고르기: 단계 순서·단계 안 순서대로 첫 조사 역할, 진행자는 빼고, 없으면 null', () => {
  const ag = { a: { role: '분석' }, b: { role: '조사' }, c: { role: 'Research' }, d: { role: '빌드' } };
  assert.equal(pickResearcher({ stages: [{ agentIds: ['a', 'd'] }, { agentIds: ['c', 'b'] }] }, ag, 'a'), 'c', '앞 단계부터, 단계 안에서는 적힌 순서대로');
  assert.equal(pickResearcher({ stages: [{ agentIds: ['b'] }, { agentIds: ['c'] }] }, ag, 'x'), 'b');
  assert.equal(pickResearcher({ stages: [{ agentIds: ['a', 'b', 'c'] }] }, ag, 'b'), 'c', '진행자는 고르지 않는다');
  assert.equal(pickResearcher({ stages: [{ agentIds: ['a', 'd'] }] }, ag, 'a'), null, '조사 역할이 없으면 null');
  assert.equal(pickResearcher({ stages: [{ agentIds: ['zz', 'b'] }] }, ag, null), 'b', '지워진 에이전트는 건너뛴다');
  assert.equal(pickResearcher({ stages: [] }, ag, 'a'), null);
});

test('화면: 받은 질문 블록은 감추고, 쓰는 중이면 끝에 오는 블록도 감춘다', () => {
  const text = `내 말.\n\n${blk('{"question":"뭐야?"}')}`;
  const c = parseCheck(text);
  assert.equal(hideCheck(text, { ...c, status: 'asked' }).trim(), '내 말.');
  assert.equal(hideCheck('쓰는 중\n\n```oc-check\n{"quest', null, true).trim(), '쓰는 중');
  assert.equal(hideCheck(text, null, false), text, '서버가 받지 않은 블록(형식 오류)은 글로 보인다');
  assert.equal(hideCheck(text, { from: 999, to: 1000 }), text, '자리가 글과 맞지 않으면 그대로');
  const moved = `앞에 더 쓴 글.\n${text}`;
  assert.equal(hideCheck(moved, { ...c, status: 'asked' }), moved, '그 자리가 질문 블록으로 시작하지 않으면 감추지 않는다');
  assert.equal(hideCheck('', null), '');
});

// ── 회의 흐름 ──

let t;
before(async () => { t = await startTestApp(); });
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

// 가짜 claude 는 신호어로 질문 블록을 붙인다(CHECKME → 질문, CHECKBAD → 깨진 블록). 조사 차례에는 출처가 붙은 두 줄로 답한다
const mk = async (name, role, provider) => (await t.api('POST', '/api/agents', { name, role, provider, model: provider === 'claude' ? 'sonnet' : 'gpt-6.1-sol', permission: 'plan', routing: 'manual' })).json;
const team = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const session = async (teamId) => (await t.api('POST', '/api/sessions', { teamId })).json;
const runs = (sid) => t.app.store.getSession(sid).runs;
const start = async (sid, text) => { const n = runs(sid).length; await t.api('POST', `/api/sessions/${sid}/messages`, { text }); await t.waitFor(() => runs(sid).length > n, 5000, '실행 시작'); };
const ended = (sid) => t.waitFor(() => runs(sid).at(-1).endedAt || runs(sid).at(-1).hold, 30000, '실행 끝');
const say = async (sid, text) => { await start(sid, text); await ended(sid); };
const meetMsgs = (sid) => t.app.store.getSession(sid).messages.filter((m) => m.meeting && m.runId === runs(sid).at(-1).id);
const shape = (mm) => mm.map((m) => `${m.meeting.phase}${m.meeting.round || ''}`);
// 가짜 CLI 가 받은 요청(codex 는 프롬프트, claude 는 받은 글). 한 줄이 AI 호출 한 번이다
const sent = (from) => t.fakeLog().slice(from).filter((l) => (l.cli === 'codex' && typeof l.prompt === 'string') || (l.cli === 'claude' && typeof l.text === 'string')).map((l) => l.prompt ?? l.text);
const Q = '가짜 질문: 비용이 얼마야?';
const research = (p, who, body) => {
  const m = p.match(new RegExp(`### 조사 결과${who ? ` — ${who}` : ''}\\n--- 의견 ([0-9a-f]{8}) 시작 ---\\n질문: ${Q.replace(/[?]/g, '\\?')}\\n\\n([\\s\\S]*?)\\n--- 의견 \\1 끝 ---`));
  return m && m[2].includes(body);
};

test('질문 하나 → 조사 1번 → 다음 차례부터 조사 결과가 표시 안에 들어간다. 참석자 3명 2바퀴에 질문 1번이면 AI 호출 7번', async () => {
  const ch = await mk('은하', '분석', 'codex'), q = await mk('별빛', '분석', 'claude'), r = await mk('혜성', '조사', 'codex');
  const tm = await team('조사하는 회의', [{ label: '회의', agentIds: [ch.id, q.id, r.id], meeting: { rounds: 2, chairId: ch.id, opposeId: q.id } }]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  const ev = t.events.length;
  await say(s.id, 'CHECKME 출시 시기를 정하자');
  const run = runs(s.id).at(-1);
  assert.equal(run.status, 'done');
  assert.equal(run.stages[0].meetingNow, null);
  const mm = meetMsgs(s.id);
  assert.deepEqual(shape(mm), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'research2', 'turn2', 'conclude']);
  const ps = sent(from);
  assert.equal(ps.length, 7, '의견 3 + 차례 2 + 조사 1 + 결론 1');

  const asked = mm.find((m) => m.meeting.phase === 'turn');
  assert.equal(asked.agentId, q.id);
  assert.equal(asked.check.question, Q);
  assert.equal(asked.check.status, 'answered');
  assert.equal(asked.text.slice(asked.check.from, asked.check.to), blk(JSON.stringify({ question: Q })), '블록은 글에 남기고 자리를 적는다(화면이 그 자리를 감춘다)');
  const rm = mm.find((m) => m.meeting.phase === 'research');
  assert.equal(rm.agentId, r.id, '팀의 조사 역할이 찾아 온다');
  assert.equal(rm.checkOf, asked.id);
  assert.deepEqual(rm.meeting, { phase: 'research', round: 2, rounds: 2 });
  assert.equal(rm.check, undefined);

  // 진행 표시: 조사 중에는 조사하러 간 사람과 질문한 사람, 모든 표시에 반대편
  const nows = t.events.slice(ev).filter((e) => e.type === 'run' && e.data.sessionId === s.id).map((e) => e.data.run.stages[0].meetingNow).filter(Boolean);
  assert.deepEqual(nows.find((n) => n.phase === 'research'), { phase: 'research', round: 2, rounds: 2, speakerId: r.id, askedBy: q.id, opposerId: q.id });
  assert.deepEqual([...new Set(nows.map((n) => n.phase))], ['opinion', 'turn', 'research', 'conclude']);
  assert.ok(nows.every((n) => n.opposerId === q.id), '모든 차례 표시에 반대편이 들어간다');
  // 조사가 끝나면 다음 차례 전에 말하는 사람 없는 차례 표시로 돌린다(그 사이 일시정지에 걸려도 "조사 중"이 남지 않게)
  const seq = nows.filter((n, k) => k === 0 || JSON.stringify(n) !== JSON.stringify(nows[k - 1]));
  assert.deepEqual(seq[seq.findIndex((n) => n.phase === 'research') + 1], { phase: 'turn', round: 2, rounds: 2, opposerId: q.id });

  // 조사 차례 프롬프트: 질문은 표시로 감싼 참고 자료, 도구로 찾아 출처를 붙이라고 한다. "글로만 답해"는 없다
  const rp = ps.filter((p) => p.includes('[회의 — 조사 (2/2바퀴)]'));
  assert.equal(rp.length, 1);
  const qm = rp[0].match(/--- 질문 ([0-9a-f]{8}) 시작 ---\n([^\n]*)\n--- 질문 \1 끝 ---/);
  assert.ok(qm, '질문은 무작위 표시로 감싼다');
  assert.equal(qm[2], Q);
  assert.match(rp[0], /표시 사이의 글은 다른 참석자가 쓴 질문이야/);
  assert.match(rp[0], /도구로 찾아서 답해/);
  assert.match(rp[0], /출처/);
  assert.match(rp[0], /찾는 데 필요한 읽기와 검색만 해\. 파일을 고치거나, 무엇을 설치·삭제하거나, 상태를 바꾸는 명령을 실행하지 마\./);
  assert.doesNotMatch(rp[0], /글로만 답해/, '조사 차례에는 "글로만 답해"를 붙이지 않는다');
  assert.doesNotMatch(rp[0], /oc-check/, '조사 차례에는 질문 블록 안내가 없다');

  // 차례 프롬프트: 2바퀴 차례에만 질문 안내와 남은 조사 수. 의견·결론에는 없다
  const turns = ps.filter((p) => p.includes('[회의 — 차례 발언 (2/2바퀴)]'));
  assert.equal(turns.length, 2);
  assert.match(turns[0], /이번 회의에서 남은 조사: 3번\./);
  assert.ok(turns[0].includes(checkBlock()), '예시 블록');
  assert.match(turns[1], /이번 회의에서 남은 조사: 2번\./);
  assert.ok(ps.filter((p) => p.includes('[회의 — 의견 내기')).every((p) => !p.includes('oc-check')));
  // 다음 차례: 조사 결과와 질문이 다른 발언과 같은 표시 안에. 질문한 사람의 글에서는 블록을 뺐다
  assert.ok(research(turns[1], '혜성', '정리 결과: 파란색'), '조사 결과가 표시 안에 들어간다');
  assert.ok(!turns[1].includes(`"question":"${Q}"`), '질문한 차례의 블록은 넘기지 않는다');
  assert.equal([...turns[1].matchAll(/### 별빛\n--- 의견 [0-9a-f]{8} 시작 ---\n안녕하세요 turn1\n--- 의견/g)].length, 2, '질문한 사람의 의견과 차례 답(블록을 뺀 글)');
  // 결론: 조사 결과가 들어가고, 출처와 함께 근거에 적으라는 한 줄
  const cc = ps.find((p) => p.includes('[회의 — 결론 내기]'));
  assert.ok(research(cc, '혜성', '정리 결과: 파란색'));
  assert.match(cc, /조사 결과에서 온 사실은 출처와 함께 근거에 적어\./);
  assert.ok(!cc.includes('oc-check'));
});

test('조사 역할이 없는 팀: 질문 안내를 넣지 않고, 그래도 온 질문은 호출 없이 "조사할 사람 없음", 다음 차례는 "확인 못 함"을 본다', async () => {
  const ch = await mk('한강', '분석', 'codex'), q = await mk('낙동', '분석', 'claude'), o = await mk('금강', '정리', 'codex');
  const tm = await team('조사 담당 없는 회의', [{ label: '회의', agentIds: [ch.id, q.id, o.id], meeting: { rounds: 2, chairId: ch.id, opposeId: q.id } }]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  await say(s.id, 'CHECKME 장소를 정하자');
  assert.equal(runs(s.id).at(-1).status, 'done');
  const mm = meetMsgs(s.id);
  assert.deepEqual(shape(mm), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'turn2', 'conclude']);
  const ps = sent(from);
  assert.equal(ps.length, 6, '조사 호출 없음');
  const asked = mm.find((m) => m.meeting.phase === 'turn');
  assert.equal(asked.check.status, 'no-researcher');
  const turns = ps.filter((p) => p.includes('[회의 — 차례 발언 (2/2바퀴)]'));
  assert.equal(turns.length, 2);
  assert.ok(turns.every((p) => !p.includes('oc-check') && !p.includes('이번 회의에서 남은 조사')), '조사할 사람이 없으면 질문 블록 안내가 없다');
  assert.ok(research(turns.at(-1), '', '확인 못 함: 이 팀에는 조사를 맡을 사람이 없어(진행자는 조사하러 가지 않아).'));
  const cc = ps.find((p) => p.includes('[회의 — 결론 내기]'));
  assert.doesNotMatch(cc, /조사 결과에서 온 사실은/, '답해 온 조사가 없으면 근거 줄을 붙이지 않는다');
});

test('조사는 회의 한 번에 3번까지: 네 번째 질문은 "조사 상한"이고 호출이 늘지 않는다. 남은 조사가 없으면 안내도 없다', async () => {
  const ch = await mk('태백', '분석', 'codex'), p1 = await mk('소백', '조사', 'claude'), p2 = await mk('지리', '분석', 'claude');
  const tm = await team('많이 묻는 회의', [{ label: '회의', agentIds: [ch.id, p1.id, p2.id], meeting: { rounds: 3, chairId: ch.id } }]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  await say(s.id, 'CHECKME 일정을 정하자');
  assert.equal(runs(s.id).at(-1).status, 'done');
  const mm = meetMsgs(s.id);
  assert.deepEqual(shape(mm), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'research2', 'turn2', 'research2', 'judge2', 'turn3', 'research3', 'turn3', 'conclude']);
  assert.equal(sent(from).length, 12, '네 번째 질문에는 조사 호출이 없다');
  const turns = mm.filter((m) => m.meeting.phase === 'turn');
  assert.deepEqual(turns.map((m) => m.check?.status), ['answered', 'answered', 'answered', 'over']);
  assert.ok(mm.filter((m) => m.meeting.phase === 'research').every((m) => m.agentId === p1.id), '조사 역할인 참석자가 자기 질문도 조사한다');
  const left = sent(from).filter((p) => p.includes('[회의 — 차례 발언')).map((p) => p.match(/이번 회의에서 남은 조사: (\d)번\./)?.[1] || null);
  assert.deepEqual(left, ['3', '2', '1', null], '남은 조사가 0이면 안내를 넣지 않는다');
  assert.ok(!sent(from).filter((p) => p.includes('[회의 — 차례 발언 (3/3바퀴)]')).at(-1).includes('oc-check'));
  // 상한을 넘은 질문은 조사하지 않고 "확인 못 함"과 질문을 다음 차례(여기서는 결론)에 넘긴다
  const cc = sent(from).find((p) => p.includes('[회의 — 결론 내기]'));
  assert.ok(research(cc, '', '확인 못 함: 이번 회의의 조사 횟수를 다 썼어.'), '상한을 넘은 질문');
});

test('깨진 질문 블록: 조사하지 않고 알림을 남기며, 블록을 뺀 글만 다음 차례에 넘기고 회의를 이어 간다', async () => {
  const ch = await mk('가야', '분석', 'codex'), q = await mk('신라', '분석', 'claude'), r = await mk('백제', '조사', 'codex');
  const tm = await team('깨진 블록 회의', [{ label: '회의', agentIds: [ch.id, q.id, r.id], meeting: { rounds: 2, chairId: ch.id, opposeId: q.id } }]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  await say(s.id, 'CHECKBAD 이름을 정하자');
  assert.equal(runs(s.id).at(-1).status, 'done');
  const mm = meetMsgs(s.id);
  assert.deepEqual(shape(mm), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'turn2', 'conclude']);
  assert.equal(sent(from).length, 6);
  const asked = mm.find((m) => m.meeting.phase === 'turn');
  assert.equal(asked.check, undefined);
  assert.ok(asked.blocks.some((b) => b.kind === 'notice' && b.text === '질문 블록 형식이 맞지 않아서 조사하지 않았어.'), '알림을 붙인다');
  assert.match(asked.text, /```oc-check\n\{망가진 JSON/, '못 읽은 블록은 글로 남는다');
  const next = sent(from).filter((p) => p.includes('[회의 — 차례 발언 (2/2바퀴)]')).at(-1);
  assert.match(next, /형식이 틀린 블록을 붙일게\./);
  assert.doesNotMatch(next, /망가진 JSON/, '블록은 다음 차례에 넘기지 않는다');
});

test('조사가 실패해도(가짜 CLI 오류) 회의는 결론까지 간다. 다른 단계의 조사 역할이 찾으러 온다', async () => {
  const r = await mk('바람', '조사', 'claude'), ch = await mk('구들', '분석', 'codex'), q = await mk('아궁이', '분석', 'claude'), o = await mk('굴뚝', '정리', 'codex');
  const tm = await team('조사 실패 회의', [{ label: '자료', agentIds: [r.id] }, { label: '회의', agentIds: [ch.id, q.id, o.id], meeting: { rounds: 2, chairId: ch.id, opposeId: q.id } }]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  const ev = t.events.length;
  await say(s.id, 'CHECKME RESEARCHFAIL 방향을 정하자');
  const run = runs(s.id).at(-1);
  assert.equal(run.status, 'done');
  assert.deepEqual(run.stages.map((x) => x.status), ['done', 'done']);
  const mm = meetMsgs(s.id);
  assert.deepEqual(shape(mm), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'research2', 'turn2', 'conclude']);
  const rm = mm.find((m) => m.meeting.phase === 'research');
  assert.equal(rm.agentId, r.id, '회의에 없는 앞 단계의 조사 역할');
  assert.equal(rm.status, 'error');
  assert.equal(mm.find((m) => m.meeting.phase === 'turn').check.status, 'failed');
  assert.equal(mm.at(-1).status, 'done', '결론을 낸다');
  const next = sent(from).filter((p) => p.includes('[회의 — 차례 발언 (2/2바퀴)]')).at(-1);
  assert.ok(research(next, '바람', '확인 못 함: 조사를 마치지 못했어.'));
  assert.doesNotMatch(sent(from).find((p) => p.includes('[회의 — 결론 내기]')), /조사 결과에서 온 사실은/, '답해 온 조사가 없으면 근거 줄을 붙이지 않는다');
  // 실패한 조사 뒤에도 말하는 사람 없는 차례 표시로 돌린다
  const nows = t.events.slice(ev).filter((e) => e.type === 'run' && e.data.sessionId === s.id).map((e) => e.data.run.stages[1].meetingNow).filter(Boolean);
  const seq = nows.filter((n, k) => k === 0 || JSON.stringify(n) !== JSON.stringify(nows[k - 1]));
  assert.deepEqual(seq[seq.findIndex((n) => n.phase === 'research') + 1], { phase: 'turn', round: 2, rounds: 2, opposerId: q.id });
});

test('조사 중에 중지하면 회의가 멈추고, 질문은 "확인 못 함"으로 남는다', async () => {
  const ch = await mk('여름', '분석', 'codex'), q = await mk('장마', '분석', 'claude'), r = await mk('소나기', '조사', 'codex');
  const tm = await team('멈출 조사 회의', [{ label: '회의', agentIds: [ch.id, q.id, r.id], meeting: { rounds: 2, chairId: ch.id, opposeId: q.id } }, { label: '뒤', agentIds: [ch.id] }]);
  const s = await session(tm.id);
  await start(s.id, 'CHECKME SLOW 멈출 회의');
  await t.waitFor(() => runs(s.id).at(-1).stages[0].meetingNow?.phase === 'research', 20000, '조사 시작');
  await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
  await ended(s.id);
  const run = runs(s.id).at(-1);
  assert.equal(run.status, 'stopped');
  assert.equal(run.stages[0].meetingNow, null);
  assert.equal(run.stages[1].status, 'stopped');
  const mm = meetMsgs(s.id);
  assert.deepEqual(shape(mm), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'research2']);
  assert.equal(mm.at(-1).status, 'stopped');
  assert.equal(mm.find((m) => m.meeting.phase === 'turn').check.status, 'failed');
});

// 조사하는 가짜 codex 가 도구를 쓰기 시작할 때까지 기다린다(그때는 실행 손잡이가 있다)
const researching = (sid) => t.waitFor(() => meetMsgs(sid).find((m) => m.meeting.phase === 'research')?.blocks.some((b) => b.kind === 'tool'), 20000, '조사 도구 실행');

test('조사 중에 대상 없이 보낸 끼어들기 말은 조사하는 에이전트에게 넣지 않고 다음 차례에 반영한다', async () => {
  const ch = await mk('봄비', '분석', 'codex'), q = await mk('꽃샘', '분석', 'claude'), r = await mk('아지랑이', '조사', 'codex');
  const tm = await team('끼어드는 조사 회의', [{ label: '회의', agentIds: [ch.id, q.id, r.id], meeting: { rounds: 2, chairId: ch.id, opposeId: q.id } }]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  await start(s.id, 'CHECKME SLOW 끼어들 회의');
  await researching(s.id);
  const STEER = '끼어든 말: 표로 정리해';
  assert.equal((await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'steer', text: STEER })).json.mode, 'next', '다음 차례에 반영');
  await ended(s.id);
  assert.equal(runs(s.id).at(-1).status, 'done');
  const mm = meetMsgs(s.id);
  assert.deepEqual(shape(mm), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'research2', 'turn2', 'conclude']);
  assert.equal(sent(from).length, 7, '조사에 이어 붙는 호출이 없다');
  const rm = mm.find((m) => m.meeting.phase === 'research');
  assert.equal(rm.text, '정리 결과: 파란색', '조사 답에는 끼어든 말에 대한 대답이 없다');
  assert.ok(!rm.blocks.some((b) => b.kind === 'notice' && b.text.includes(STEER)));
  const next = sent(from).filter((p) => p.includes('[회의 — 차례 발언 (2/2바퀴)]')).at(-1);
  assert.ok(next.includes(`[사용자 추가 지시]\n- ${STEER}`), '다음 차례 프롬프트의 사용자 추가 지시에 들어간다');
});

test('조사 중에 "회의 끝내기"를 누르면 질문은 "확인 못 함"으로 남고 진행자가 결론을 낸다', async () => {
  const ch = await mk('가을', '분석', 'codex'), q = await mk('단풍', '분석', 'claude'), r = await mk('낙엽', '조사', 'codex');
  const tm = await team('끝낼 조사 회의', [{ label: '회의', agentIds: [ch.id, q.id, r.id], meeting: { rounds: 2, chairId: ch.id, opposeId: q.id } }]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  await start(s.id, 'CHECKME SLOW 끝낼 회의');
  await researching(s.id);
  assert.equal((await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'conclude' })).json.ok, true);
  await ended(s.id);
  assert.equal(runs(s.id).at(-1).status, 'done');
  const mm = meetMsgs(s.id);
  assert.deepEqual(shape(mm), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'research2', 'conclude']);
  assert.equal(sent(from).length, 6);
  assert.equal(mm.find((m) => m.meeting.phase === 'research').status, 'stopped');
  assert.equal(mm.find((m) => m.meeting.phase === 'turn').check.status, 'failed');
  assert.equal(mm.at(-1).status, 'done', '결론을 낸다');
  const cc = sent(from).find((p) => p.includes('[회의 — 결론 내기]'));
  assert.ok(research(cc, '낙엽', '확인 못 함: 조사를 마치지 못했어.'));
  assert.doesNotMatch(cc, /조사 결과에서 온 사실은/);
});

test('조사 직전에 사용량 상한에 닿으면 조사를 시작하지 않고(호출이 늘지 않고) "확인 못 함"으로 남긴다', async () => {
  const ch = await mk('하늘', '분석', 'claude'), q = await mk('구름', '분석', 'claude'), r = await mk('무지개', '조사', 'claude');
  // 메시지 한 건이 쓰는 양을 먼저 잰다(가짜 claude 는 매번 같은 양을 알려 준다)
  const probe = await team('재는 조사 회의', [{ label: '회의', agentIds: [ch.id, q.id], meeting: { rounds: 1, tokenCap: 0 } }]);
  const s0 = await session(probe.id);
  await say(s0.id, '한 건의 양을 재자');
  const one = meetingSpend(meetMsgs(s0.id)[0].usage);
  assert.ok(one > 0);
  // 상한 = 4건: 의견 3건 뒤에는 통과해 질문한 차례 1건, 그 뒤(4건)에는 닿아서 조사하러 가지 않고 결론으로
  const tm = await team('상한 닿는 조사 회의', [{ label: '회의', agentIds: [ch.id, q.id, r.id], meeting: { rounds: 2, chairId: ch.id, opposeId: q.id, tokenCap: one * 4 } }]);
  const s = await session(tm.id);
  const from = t.fakeLog().length;
  await say(s.id, 'CHECKME 예산을 정하자');
  assert.equal(runs(s.id).at(-1).status, 'done');
  const mm = meetMsgs(s.id);
  assert.deepEqual(shape(mm), ['opinion1', 'opinion1', 'opinion1', 'turn2', 'conclude']);
  assert.equal(sent(from).length, 5, '조사 호출이 없다');
  assert.equal(mm.find((m) => m.meeting.phase === 'turn').check.status, 'failed');
  assert.ok(t.app.store.getSession(s.id).messages.some((m) => m.role === 'system' && m.text.includes('상한')), '상한에 닿았다고 알린다');
  assert.ok(research(sent(from).find((p) => p.includes('[회의 — 결론 내기]')), '무지개', '확인 못 함: 조사를 마치지 못했어.'));
});

// 같은 데이터 폴더로 새 앱을 켜므로 맨 마지막에 둔다
test('앱이 꺼졌다 켜지면 조사 중이던 질문은 "확인 못 함"으로 바꾼다', async () => {
  const a = await mk('새싹', '분석', 'codex');
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: a.id })).json;
  // 조사하는 도중에 앱이 꺼진 모양: 실행 중인 회의, 조사 중 표시, 답을 기다리는 질문
  const live = t.app.store.getSession(s.id);
  live.runs.push({ id: 'r-cut', status: 'running', stageIndex: 0, createdAt: Date.now(),
    stages: [{ label: '회의', agentIds: [a.id], status: 'running', meetingNow: { phase: 'research', round: 2, rounds: 2, speakerId: a.id, askedBy: a.id } }] });
  live.messages.push({ id: 'm-check', role: 'agent', agentId: a.id, runId: 'r-cut', text: `말.\n\n${blk('{"question":"뭐야?"}')}`, blocks: [], status: 'done', createdAt: Date.now(),
    meeting: { phase: 'turn', round: 2, rounds: 2 }, check: { question: '뭐야?', from: 4, to: 4 + blk('{"question":"뭐야?"}').length, status: 'asked' } });
  t.app.store.saveSessionNow(live);
  await new Promise((r) => setTimeout(r, 400)); // 목록(index.json)에 "실행 중"이 저장되기를 기다린다
  const app2 = createApp({ home: path.join(t.root, 'home'), port: 0, detect: false });
  try {
    await app2.listen(await freePort());
    const s2 = app2.store.getSession(s.id);
    assert.equal(s2.messages.find((m) => m.id === 'm-check').check.status, 'failed');
    assert.equal(s2.runs.at(-1).status, 'stopped');
  } finally { try { await app2.close(); } catch { /* 무시 */ } }
});
