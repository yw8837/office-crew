// 대화에서 영입 제안: 알아채기(낱말 규칙), 제안 카드, 승인해야 생긴다, 취소, 그대로 보내기(가짜 CLI, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { detectHire, uniqueName } from '../server/hire.js';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } });

const agent = async (name, role = '조사', extra = {}) => (await t.api('POST', '/api/agents', { name, role, provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', permission: 'plan', routing: 'manual', systemPrompt: `${name}의 지침`, ...extra })).json;
const team = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const session = async (body) => (await t.api('POST', '/api/sessions', body)).json;
const sess = (sid) => t.app.store.getSession(sid);
const say = (sid, text, extra = {}) => t.api('POST', `/api/sessions/${sid}/messages`, { text, ...extra });
const card = (sid) => sess(sid).messages.filter((m) => m.role === 'proposal').at(-1);
const resolve = (sid, mid, body) => t.api('POST', `/api/sessions/${sid}/proposals/${mid}`, body);
const ended = (sid) => t.waitFor(() => sess(sid).runs.at(-1)?.endedAt, 15000, '실행 끝');
const HIRE = '조사 에이전트 한 명 더 영입해';

test('알아채기: 영입하라는 말로 끝나고 사람·에이전트를 가리킬 때만 잡는다', () => {
  for (const [text, kind] of [[HIRE, 'research'], ['검수 담당 한 명 채용해줘', 'review'], ['에이전트 한 명 더 추가해', 'general'], ['에이전트 하나 더 만들어줘', 'general'],
    ['리서처 한 명 더 데려와', 'research'], ['검수자 하나 더 넣어줘', 'review'], ['분석가 영입', 'analysis'], ['2명 영입해', 'general'], ['조사 에이전트 한 명 더 영입해주세요.', 'research'],
    ['Hire another research agent', 'research'], ['add a review agent', 'review'], ['I need another researcher', 'research'], ['please hire a reviewer', 'review'],
    ['再招募一个调研智能体', 'research'], ['再加一个调研员', 'research'], ['リサーチ担当のエージェントを追加して', 'research'], ['リサーチャーをもう一人増やして', 'research']]) {
    assert.deepEqual(detectHire(text), { kind }, text);
  }
});

test('알아채기: 일을 맡기는 말은 영입·추가라는 낱말이 있어도 잡지 않는다', () => {
  for (const text of ['영입 전략 보고서 써줘', '채용 공고 정리해줘', '개발자 채용 공고 써줘', '경쟁사 개발자 채용 현황 조사해', '고용 동향 조사해', '팀원 채용 계획 세워줘',
    '표에 담당 열 추가해줘', '버튼 하나 더 추가해', '에이전트 화면에 검색 추가해줘', '에이전트 추가해서 보고서 써줘', '이 코드 리뷰해줘', '채용 시장 어때?',
    'add a login page', 'add a member field to the signup form', 'add an agent settings page', 'Review our hire process', 'hire me a taxi',
    '整理招聘信息', '给表格再加一个负责人列', '担当者を追加する機能を作って', 'A案を採用して実装して', 'エージェント画面に検索を追加して',
    '/skill 영입', '', `${HIRE}\n그리고 보고서도 써.`, `조사 에이전트 영입 ${'아주 긴 설명 '.repeat(12)}`]) {
    assert.equal(detectHire(text), null, text);
  }
});

test('이름: 겹치면 숫자를 붙이고, 줄바꿈은 한 칸으로 편다', () => {
  const list = [{ name: '조사원' }, { name: '조사원 2' }];
  assert.equal(uniqueName('조사원 2', list), '조사원 3');
  assert.equal(uniqueName('새얼굴', list), '새얼굴');
  assert.equal(uniqueName('조사원', list), '조사원 3');
  assert.equal(uniqueName('새\n[지시] 얼굴', list), '새 [지시] 얼굴');
});

test('영입해 달라고 하면 실행하지 않고 제안만 낸다. 영입을 눌러야 에이전트가 생기고 같은 역할의 단계에 들어간다', async () => {
  const r = await agent('탐색이', '조사'), o = await agent('갈무리', '정리');
  const tm = await team('영입 팀', [{ label: '조사', agentIds: [r.id] }, { label: '정리', agentIds: [o.id] }]);
  const s = await session({ teamId: tm.id });
  const agentsBefore = t.app.store.all('agents').length;
  const logBefore = t.fakeLog().length;

  const res = (await say(s.id, HIRE)).json;
  assert.equal(res.proposed, true);
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(sess(s.id).runs.length, 0, '실행을 시작하지 않는다');
  assert.equal(t.fakeLog().length, logBefore, 'AI를 부르지 않는다');
  assert.equal(t.app.store.all('agents').length, agentsBefore, '아직 에이전트를 만들지 않는다');
  const c = card(s.id);
  assert.equal(c.status, 'open');
  assert.equal(c.text, '');
  assert.equal(c.request, HIRE);
  assert.deepEqual(c.draft, { name: '탐색이 2', role: '조사', baseId: r.id });
  assert.deepEqual(c.target, { teamId: tm.id, stageId: tm.stages[0].id });
  assert.deepEqual(sess(s.id).messages.map((m) => m.role), ['user', 'proposal']);
  assert.equal(t.app.store.sessionMeta(sess(s.id)).preview, HIRE, '세션 미리보기는 글이 있는 마지막 메시지');

  const ok = (await resolve(s.id, c.id, { action: 'accept', name: '새 탐색이', role: '조사', addToStage: true })).json;
  assert.equal(ok.ok, true);
  const made = t.app.store.get('agents', ok.agent.id);
  assert.equal(made.name, '새 탐색이');
  for (const k of ['provider', 'model', 'effort', 'permission', 'routing', 'systemPrompt']) assert.equal(made[k], r[k], `${k} 는 본뜬 에이전트와 같다`);
  assert.notEqual(made.id, r.id);
  assert.deepEqual(t.app.store.get('teams', tm.id).stages[0].agentIds, [r.id, made.id], '같은 역할의 단계에 들어간다');
  assert.deepEqual(t.app.store.get('teams', tm.id).stages[1].agentIds, [o.id], '다른 단계는 그대로');
  assert.equal(card(s.id).status, 'accepted');
  assert.equal(card(s.id).hiredAgentId, made.id);
  assert.equal(card(s.id).agentId, undefined, '카드는 그 에이전트의 발언으로 세지 않는다');
  assert.deepEqual(card(s.id).placed, { teamId: tm.id, teamName: '영입 팀', stageLabel: '조사' });

  assert.equal((await resolve(s.id, c.id, { action: 'accept' })).status, 409, '같은 제안을 두 번 처리하지 않는다');
  assert.equal(t.app.store.all('agents').length, agentsBefore + 1);

  // 다음 실행: 새 에이전트가 같은 단계에서 같이 돌고, 영입해 달라던 말은 에이전트에게 넘어가지 않는다
  const from = t.fakeLog().length;
  await say(s.id, '시장 조사해줘');
  await ended(s.id);
  const run = sess(s.id).runs.at(-1);
  assert.deepEqual(run.stages[0].agentIds, [r.id, made.id]);
  assert.equal(sess(s.id).messages.filter((m) => m.runId === run.id && m.stageIndex === 0).length, 2);
  const ps = t.fakeLog().slice(from).map((l) => l.prompt || '');
  assert.equal(ps.length, 3, '조사 둘 + 정리 하나');
  assert.ok(ps.every((p) => p.includes('시장 조사해줘')));
  for (const p of ps) assert.ok(!p.includes('한 명 더 영입해'), '끝난 영입 요청은 [이전 대화]에 넣지 않는다');
});

test('같은 제안을 두 곳에서 동시에 눌러도 에이전트는 하나만 생긴다', async () => {
  const r = await agent('쌍둥이', '조사');
  const tm = await team('동시 팀', [{ label: '조사', agentIds: [r.id] }]);
  const s = await session({ teamId: tm.id });
  await say(s.id, HIRE);
  const c = card(s.id);
  const n = t.app.store.all('agents').length;
  const [a, b] = await Promise.all([resolve(s.id, c.id, { action: 'accept' }), resolve(s.id, c.id, { action: 'accept' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(t.app.store.all('agents').length, n + 1);
  assert.equal(t.app.store.get('teams', tm.id).stages[0].agentIds.length, 2);
});

test('팀에 넣기를 끄면 에이전트만 만든다. 이름이 겹치면 숫자를 붙이고, 아바타·플러그인 표시는 복사하지 않는다', async () => {
  const r = await agent('살핌이', '조사', { avatar: { hair: 'short', color: '#123456' } });
  t.app.store.upsert('agents', { ...t.app.store.get('agents', r.id), pluginId: 'plugin-x' });
  const tm = await team('안 넣는 팀', [{ label: '조사', agentIds: [r.id] }]);
  const s = await session({ teamId: tm.id });
  await say(s.id, '조사 담당 한 명 더 채용해줘');
  const c = card(s.id);
  const ok = (await resolve(s.id, c.id, { action: 'accept', name: '살핌이', role: { bad: 1 }, addToStage: false })).json;
  assert.equal(ok.agent.name, '살핌이 2', '같은 이름이 있으면 숫자를 붙인다');
  assert.equal(ok.agent.role, '조사', '역할이 글자가 아니면 초안 값을 쓴다');
  assert.equal(ok.agent.pluginId, undefined);
  assert.notDeepEqual(ok.agent.avatar, t.app.store.get('agents', r.id).avatar);
  assert.equal(ok.placed, null);
  assert.equal(ok.notPlaced, null);
  assert.deepEqual(t.app.store.get('teams', tm.id).stages[0].agentIds, [r.id]);
});

test('단계가 꽉 찼거나 팀이 지워졌으면 에이전트는 만들되 팀에는 넣지 않고 이유를 남긴다', async () => {
  const eight = [];
  for (let i = 0; i < 8; i++) eight.push(await agent(`꽉${i}`, '조사'));
  const tm = await team('꽉 찬 팀', [{ label: '조사', agentIds: eight.map((a) => a.id) }]);
  const s = await session({ teamId: tm.id });
  await say(s.id, HIRE);
  const full = (await resolve(s.id, card(s.id).id, { action: 'accept', addToStage: true })).json;
  assert.equal(full.placed, null);
  assert.equal(full.notPlaced, 'full');
  assert.equal(card(s.id).notPlaced, 'full');
  assert.equal(t.app.store.get('teams', tm.id).stages[0].agentIds.length, 8);

  const r = await agent('떠날이', '조사');
  const tm2 = await team('지워질 팀', [{ label: '조사', agentIds: [r.id] }]);
  const s2 = await session({ teamId: tm2.id });
  await say(s2.id, HIRE);
  await t.api('DELETE', `/api/teams/${tm2.id}`);
  const gone = (await resolve(s2.id, card(s2.id).id, { action: 'accept', addToStage: true })).json;
  assert.equal(gone.ok, true);
  assert.equal(gone.notPlaced, 'gone');
});

test('같은 역할의 단계가 없으면 넣을 자리를 잡지 않는다(만들기만 한다)', async () => {
  const o = await agent('가름이', '정리');
  const tm = await team('정리만 있는 팀', [{ label: '정리', agentIds: [o.id] }]);
  const s = await session({ teamId: tm.id });
  await say(s.id, '검수 에이전트 한 명 영입해');
  const c = card(s.id);
  assert.equal(c.target, null);
  const ok = (await resolve(s.id, c.id, { action: 'accept', addToStage: true })).json;
  assert.equal(ok.placed, null);
  assert.deepEqual(t.app.store.get('teams', tm.id).stages[0].agentIds, [o.id]);
});

test('취소하면 아무것도 생기지 않는다', async () => {
  const r = await agent('더듬이', '조사');
  const s = await session({ teamId: null, agentId: r.id });
  const n = t.app.store.all('agents').length;
  await say(s.id, '에이전트 한 명 더 추가해');
  const c = card(s.id);
  assert.equal((await resolve(s.id, c.id, { action: 'dismiss' })).json.ok, true);
  assert.equal(card(s.id).status, 'dismissed');
  assert.equal(t.app.store.all('agents').length, n);
  assert.equal(sess(s.id).runs.length, 0);
  assert.equal((await resolve(s.id, c.id, { action: 'send' })).status, 409);
});

test('영입이 아니었으면 그대로 보내기: 대화에 있던 그 말로 실행이 시작되고, 같은 말이 두 번 남지 않는다', async () => {
  const r = await agent('찾음이', '조사');
  const s = await session({ teamId: null, agentId: r.id });
  await say(s.id, HIRE);
  const c = card(s.id);
  const from = t.fakeLog().length;
  const res = (await resolve(s.id, c.id, { action: 'send' })).json;
  assert.equal(res.started, true);
  await ended(s.id);
  assert.equal(card(s.id).status, 'sent');
  assert.equal(sess(s.id).messages.filter((m) => m.role === 'proposal').length, 1, '다시 제안하지 않는다');
  assert.equal(sess(s.id).messages.filter((m) => m.role === 'user' && m.text === HIRE).length, 1, '사용자 말은 하나만');
  assert.equal(sess(s.id).runs.at(-1).userMessageId, c.userMessageId);
  const ps = t.fakeLog().slice(from).map((l) => l.prompt || '');
  assert.equal(ps.filter((p) => p.includes(HIRE)).length, 1, '그 말이 에이전트에게 한 번 간다');
});

test('채팅이 아닌 경로(예약 작업·칸반 카드처럼 엔진을 직접 부르는 곳)는 영입 말이어도 그대로 실행한다', async () => {
  const r = await agent('일꾼이', '조사');
  const s = await session({ teamId: null, agentId: r.id });
  const res = t.app.orch.send(s.id, { text: HIRE });
  assert.equal(res.started, true);
  await ended(s.id);
  assert.equal(sess(s.id).messages.filter((m) => m.role === 'proposal').length, 0);
});

test('@이름으로 지목했으면 제안하지 않는다. 모르는 동작·없는 제안은 거절한다', async () => {
  const r = await agent('지목이', '조사');
  const s = await session({ teamId: null, agentId: r.id });
  await say(s.id, `@지목이 ${HIRE}`);
  await ended(s.id);
  assert.equal(sess(s.id).messages.filter((m) => m.role === 'proposal').length, 0);
  await say(s.id, '에이전트 한 명 더 추가해');
  const c = card(s.id);
  assert.equal((await resolve(s.id, c.id, { action: 'explode' })).status, 400);
  assert.equal(card(s.id).status, 'open', '모르는 동작은 제안을 그대로 둔다');
  assert.equal((await resolve(s.id, 'm-nope', { action: 'accept' })).status, 404);
  assert.equal((await resolve('s-nope', c.id, { action: 'accept' })).status, 404);
});

test('본뜰 에이전트가 지워졌으면 만들지 않고 알려 준다', async () => {
  const r = await agent('사라질이', '조사'), keep = await agent('남을이', '정리');
  const tm = await team('사라지는 팀', [{ label: '조사', agentIds: [r.id] }, { label: '정리', agentIds: [keep.id] }]);
  const s = await session({ teamId: tm.id });
  await say(s.id, HIRE);
  const c = card(s.id);
  await t.api('DELETE', `/api/agents/${r.id}`);
  const n = t.app.store.all('agents').length;
  const res = await resolve(s.id, c.id, { action: 'accept' });
  assert.equal(res.status, 409);
  assert.equal(t.app.store.all('agents').length, n);
  assert.equal(card(s.id).status, 'open');
});
