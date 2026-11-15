// 에이전트가 사용자에게 묻기: 답 끝의 oc-ask 블록 → 선택 카드 → 답을 받아 같은 답 안에서 이어 가기(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { parseAsk, cleanAnswers, answered, stripAsks } from '../server/ask.js';
import { hideAsks } from '../public/js/chat-tools.js';

let t, agent;
before(async () => {
  t = await startTestApp();
  agent = (await t.api('POST', '/api/agents', { name: '묻는담당', role: '정리', provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
});
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const open = async (text) => {
  const s = (await t.api('POST', '/api/sessions', { teamId: null, agentId: agent.id })).json;
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text });
  return s.id;
};
const sess = (id) => t.app.store.getSession(id);
const reply = (id) => sess(id).messages.findLast((m) => m.role === 'agent');
const run = (id) => sess(id).runs.at(-1);
const asking = (id) => t.waitFor(() => reply(id)?.asks?.find((a) => a.status === 'open'), 15000, '질문');
const ended = (id) => t.waitFor(() => run(id)?.endedAt, 15000, '실행 끝');
const ctl = (id, body) => t.api('POST', `/api/sessions/${id}/control`, body);
const block = '```oc-ask\n';

test('블록 읽기: 맞는 형식만 질문으로 받고, 개수는 상한까지만', () => {
  assert.equal(parseAsk('그냥 답'), null);
  assert.deepEqual(parseAsk(`${block}{깨진 글}\n\`\`\``), { error: 'json' });
  assert.deepEqual(parseAsk(`${block}{"questions":[]}\n\`\`\``), { error: 'empty' });
  assert.deepEqual(parseAsk(`${block}{"questions":[{"question":"?","options":["하나"]}]}\n\`\`\``), { error: 'shape' });
  const many = { questions: Array.from({ length: 6 }, (_, i) => ({ question: `질문${i}`, options: Array.from({ length: 9 }, (__, k) => `보기${k}`) })) };
  const got = parseAsk(`앞 글\n${block}${JSON.stringify(many)}\n\`\`\``).ask;
  assert.equal(got.questions.length, 4);
  assert.equal(got.questions[0].options.length, 6);
  assert.deepEqual(got.questions[0].options[0], { label: '보기0', description: '' });
  // 글의 맨 끝에 있는 블록만 질문이다: 예로 든 블록, 뒤에 글이 이어진 블록, 닫지 않은 블록은 아니다
  const one = `${block}{"questions":[{"question":"진짜?","options":["가","나"]}]}\n\`\`\``;
  assert.equal(parseAsk(`${one}\n뒤에 글을 더 썼어`), null);
  assert.equal(parseAsk(`${block}{"questions":[`), null);
  const two = `형식은 이래:\n${block}{"questions":[{"question":"예시","options":["a","b"]}]}\n\`\`\`\n이제 물을게.\r\n${one}\n`;
  const last = parseAsk(two);
  assert.equal(last.ask.questions[0].question, '진짜?');
  assert.equal(two.slice(last.from, last.to), one);
  // 화면: 서버가 받은 자리만 빼고, 예로 든 블록은 글로 남긴다. 쓰는 중에는 아직 안 받은 뒤쪽 블록과 쓰다 만 블록도 감춘다
  const shown = hideAsks(two, [{ from: last.from, to: last.to }]);
  assert.ok(shown.includes('"예시"') && !shown.includes('진짜?'));
  assert.equal(hideAsks(two, [], false), two);
  assert.ok(!hideAsks(two, [{ from: last.from, to: last.to }], true).includes('진짜?'));
  assert.equal(hideAsks(`글\n${block}{"questi`, [], true), '글\n');
  assert.equal(hideAsks('글', [{ from: 5, to: 9 }]), '글', '자리가 글 밖이면 무시한다');
  assert.ok(!stripAsks(two).includes('oc-ask'));
  // 답 다듬기: 없는 번호는 버리고, 하나만 고르는 질문은 하나만
  const a = cleanAnswers(got, [{ picked: [2, 2, 99, 1] }, { other: '  직접\n쓴 답 ' }]);
  assert.deepEqual(a[0], { picked: [2], other: '' });
  assert.deepEqual(a[1], { picked: [], other: '직접 쓴 답' });
  assert.equal(answered(a), false, '답 안 한 질문이 남았다');
});

test('물으면 멈춰서 기다리고, 답하면 같은 답 안에서 이어 쓴다', async () => {
  const id = await open('ASKME 보고서 써 줘');
  const ask = await asking(id);
  assert.equal(ask.questions.length, 2);
  assert.equal(ask.questions[0].options[0].label, '전부 (추천)');
  assert.equal(ask.questions[1].multi, true);
  assert.equal(run(id).status, 'running');
  assert.equal(run(id).asks.length, 1);
  assert.match(JSON.stringify(t.app.store.sessionMeta(sess(id))), /"kind":"ask"/, '사이드바 "기다리는 일"에 뜬다');
  assert.equal(t.app.orch.liveStates(id)[agent.id].state, 'waiting');
  // 답을 다 안 하면 받지 않는다
  assert.equal((await ctl(id, { action: 'answer', askId: ask.id, answers: [{ picked: [0] }] })).status, 400);
  assert.equal(reply(id).asks[0].status, 'open');
  const ok = await ctl(id, { action: 'answer', askId: ask.id, answers: [{ picked: [0] }, { picked: [0, 2], other: '각주도' }] });
  assert.equal(ok.json.ok, true);
  await ended(id);
  const m = reply(id);
  assert.equal(run(id).status, 'done');
  assert.equal(m.status, 'done');
  assert.equal(m.asks[0].status, 'answered');
  assert.deepEqual(run(id).asks, []);
  assert.match(m.text, /먼저 확인할게[\s\S]*❓ \[범위\] 어디까지 할까\?\n> 🙋 \*\*전부 \(추천\)\*\*[\s\S]*❓ 무엇을 넣을까\?\n> 🙋 \*\*표, 요약, 직접 입력: 각주도\*\*[\s\S]*답 받았어. 이어서 진행했어/);
  assert.equal(m.text.slice(m.asks[0].from, m.asks[0].to).startsWith('```oc-ask'), true, '블록의 자리를 기억한다');
  assert.equal(hideAsks(m.text, m.asks).includes('oc-ask'), false, '화면에서는 그 자리를 뺀다');
  assert.equal(sess(id).messages.filter((x) => x.role === 'agent').length, 1, '답 하나로 이어진다');
  const log = t.fakeLog();
  assert.ok(log.some((l) => l.system?.includes('oc-ask')), '지침에 묻는 방법이 들어간다');
  const turn = log.findLast((l) => l.text?.includes('[사용자 답변]'));
  assert.match(turn.text, /1\. 어디까지 할까\?\n {3}→ 전부 \(추천\)\n2\. 무엇을 넣을까\?\n {3}→ 표, 요약, 직접 입력: 각주도/);
  assert.ok(!turn.text.includes('[사용자 요청]'), '같은 CLI 대화를 이어 가서 요청을 다시 보내지 않는다');
  assert.equal(t.app.orch.ctx.size, 0, '끝난 실행은 남지 않는다');
});

test('넘기기: 답 없이 가정을 정해 진행하게 한다', async () => {
  const id = await open('ASKME 요약해 줘');
  const ask = await asking(id);
  assert.equal((await ctl(id, { action: 'answer', askId: ask.id, skip: true })).json.ok, true);
  assert.equal((await ctl(id, { action: 'answer', askId: ask.id, skip: true })).json.ok, false, '이미 닫힌 질문');
  await ended(id);
  assert.equal(reply(id).asks[0].status, 'skipped');
  assert.match(reply(id).text, /❓ \[범위\] 어디까지 할까\?[\s\S]*질문을 넘겼어[\s\S]*답 받았어/);
  assert.match(t.fakeLog().findLast((l) => l.text?.includes('[사용자 답변]')).text, /답하지 않고 넘겼어/);
});

test('기다리는 중에 중지하면 질문을 닫고 실행을 끝낸다', async () => {
  const id = await open('ASKME 정리해 줘');
  await asking(id);
  await ctl(id, { action: 'stop' });
  await ended(id);
  assert.equal(run(id).status, 'stopped');
  assert.equal(reply(id).status, 'stopped');
  assert.equal(reply(id).asks[0].status, 'cancelled');
  assert.equal(t.app.store.sessionMeta(sess(id)).attention ?? null, null);
});

test('기다리는 에이전트를 건너뛰면 질문을 닫는다', async () => {
  const id = await open('ASKME 건너뛸 일');
  await asking(id);
  assert.equal((await ctl(id, { action: 'skip', agentId: agent.id })).json.ok, true);
  await ended(id);
  assert.equal(reply(id).asks[0].status, 'cancelled');
  assert.equal(reply(id).status, 'stopped');
});

test('계속 묻는 에이전트는 3번까지만 선택창을 띄운다', async () => {
  const id = await open('ASKMORE 끝없이 묻기');
  for (let i = 0; i < 3; i++) {
    const ask = await asking(id);
    await ctl(id, { action: 'answer', askId: ask.id, answers: [{ picked: [1] }, { picked: [0] }] });
    await t.waitFor(() => reply(id).asks[i].status === 'answered');
  }
  await ended(id);
  const m = reply(id);
  assert.equal(m.asks.length, 3);
  assert.equal(run(id).status, 'done');
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && /횟수\(3번\)를 넘어서/.test(b.text)));
});

test('형식이 틀린 질문은 선택창 없이 글로 남기고 알린다', async () => {
  const id = await open('ASKBAD 틀린 형식');
  await ended(id);
  const m = reply(id);
  assert.equal(m.asks, undefined);
  assert.equal(run(id).status, 'done');
  assert.match(m.text, /oc-ask/);
  assert.ok(m.blocks.some((b) => b.kind === 'notice' && /형식이 맞지 않아서/.test(b.text)));
});

test('설정을 끄면 묻는 방법을 알려 주지 않고 선택창도 띄우지 않는다', async () => {
  await t.api('PUT', '/api/settings', { agentAsks: false });
  try {
    const before = t.fakeLog().length;
    const id = await open('ASKME 설정 끔');
    await ended(id);
    assert.equal(reply(id).asks, undefined);
    assert.equal(run(id).status, 'done');
    assert.ok(!t.fakeLog().slice(before).some((l) => l.system?.includes('oc-ask')));
  } finally {
    await t.api('PUT', '/api/settings', { agentAsks: true });
  }
});

test('기다리는 중에 온 추가 지시는 사라지지 않고 답을 받은 뒤 처리된다', async () => {
  const id = await open('ASKME 추가 지시와 섞기');
  const ask = await asking(id);
  const steer = await ctl(id, { action: 'steer', agentId: agent.id, text: '표는 세로로 그려 줘' });
  assert.equal(steer.json.mode[agent.id], 'after', '끝난 프로세스에 전달하지 않고 밀어 둔다');
  await ctl(id, { action: 'answer', askId: ask.id, answers: [{ picked: [0] }, { picked: [1] }] });
  await ended(id);
  assert.equal(run(id).status, 'done');
  const turns = t.fakeLog().filter((l) => l.text).map((l) => l.text);
  const a = turns.findLastIndex((x) => x.includes('[사용자 답변]'));
  const b = turns.findLastIndex((x) => x.includes('[추가 지시]') && x.includes('표는 세로로 그려 줘'));
  assert.ok(a >= 0 && b > a, '답을 먼저 돌려주고 그다음에 추가 지시를 보낸다');
  assert.equal(reply(id).asks.length, 1, '지나간 질문이 다시 뜨지 않는다');
});
