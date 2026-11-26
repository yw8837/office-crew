// 실행 기록 내보내기(결정 0030): 목표 하나의 실행을 JSON 파일 하나로. 목표·기준, 카드와 상태, 진행 기록, 회의 결론·확정한 것, 호출별(누가·어느 AI·모델·종류·시작/끝·사용량·배정·실패 종류),
// 완주 보고의 사실. API 키·알림 주소·토큰은 가리고, 작업 폴더 안의 절대 경로는 상대 경로로, 프롬프트·답 전문은 "본문 포함"을 켰을 때만. 형식 버전 번호.
// 기존 /api 인증을 그대로 받는다. 가짜 CLI 만 쓴다(실제 AI 사용량 0)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindLang } from '../server/i18n.js';
import { EXPORT_FORMAT, EXPORT_VERSION } from '../server/report.js';
import { startTestApp } from './helpers.js';

bindLang(() => 'ko');
let t = null;
const app = async () => (t ||= await startTestApp());
after(async () => { if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } } });
const S = (id) => t.app.store.getSession(id);
const idle = (sid) => !t.app.orch.ctx.has(sid);
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides, ...(c.checks ? { checks: c.checks } : {}), ...(c.keep ? { keep: c.keep } : {}) });

const KEY = 'sk-ant-api03-SECRETKEYVALUE1234567890abcd';
const PHONE = 'https://ntfy.sh/private-topic-zz91';

async function runGoal(work, request) {
  const mk = async (name, role) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  const tag = work === 'cards' ? '내카' : '내단';
  const a = await mk(`${tag}가`, '빌드');
  const b = await mk(`${tag}나`, '기록');
  const v = await mk(`${tag}다`, '검수');
  const tm = (await t.api('POST', '/api/teams', { name: `${tag}팀`, stages: [{ label: '만들기', agentIds: [a.id, b.id] }, { label: '검수', agentIds: [v.id] }] })).json;
  const cwd = fs.mkdtempSync(path.join(t.root, 'exp-'));
  const s = (await t.api('POST', '/api/sessions', { teamId: tm.id, cwd })).json;
  await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true });
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: request(cwd) });
  await t.waitFor(() => S(s.id).mission?.status === 'draft' && idle(s.id), 20000, '목표 카드');
  const c = S(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  const r = await t.api('POST', `/api/sessions/${s.id}/mission/confirm`, { missionId: S(s.id).mission.id, expected: shown(c), edited: { ...shown(c), goal: `CONCLUDEFMT 목표 ${path.join(cwd, 'src', 'a.js')}` },
    review: { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) }, work,
    prep: { research: false, meeting: false, lead: c.prep.lead.id, researchers: c.prep.research.who.map((w) => w.id), attendees: c.prep.meeting.who.map((w) => w.id) } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await t.waitFor(() => idle(s.id) && ['done', 'accepted', 'stopped'].includes(S(s.id).mission.status), 60000, '목표 끝');
  return { sid: s.id, cwd, a, b, v };
}

test('1. 내보내기: 형식 버전, 목표·기준·카드·진행 기록·호출별 기록·보고 사실이 들어가고, 비밀은 가리고, 작업 폴더 경로는 상대 경로, 본문은 고를 때만', { timeout: 180000 }, async () => {
  await app();
  await t.api('PUT', '/api/settings', { apiKeys: { anthropic: KEY }, phoneUrl: PHONE });
  const home = os.homedir();
  const { sid, cwd, a, b } = await runGoal('cards', (dir) => `정리해 줘. 키 ${KEY} 알림 ${PHONE} 토큰 ${t.app.token} 폴더 ${path.join(dir, 'docs', 'brief.md')} 집 ${path.join(home, 'x.txt')}`);
  const m = S(sid).mission;
  const r = await t.api('GET', `/api/sessions/${sid}/mission/${m.id}/export`);
  assert.equal(r.status, 200, r.text);
  const x = r.json;
  assert.equal(x.format, EXPORT_FORMAT);
  assert.equal(x.version, EXPORT_VERSION);
  assert.equal(x.body, false);
  assert.equal(x.goal.id, m.id);
  assert.equal(x.goal.status, m.status);
  assert.equal(x.goal.criteria.length, m.criteria.length);
  assert.ok(x.goal.criteria.every((c) => c.id && c.text && c.status));
  // 카드와 상태(담당 이름 포함)
  assert.equal(x.cards.length, m.cards.length);
  assert.ok(x.cards.every((c) => c.id && c.status && c.owner?.id && c.owner?.name));
  assert.ok(x.cards.some((c) => c.owner.id === a.id) && x.cards.some((c) => c.owner.id === b.id));
  // 진행 기록 줄
  assert.equal(x.log.length, m.log.length);
  assert.ok(x.log.every((l) => typeof l.at === 'number' && l.kind && typeof l.text === 'string'));
  // 호출별: 누가·어느 AI·모델·종류·시작/끝·사용량·배정·실패 종류
  const answers = S(sid).messages.filter((x2) => x2.role === 'agent' && x2.missionId === m.id);
  assert.equal(x.calls.length, answers.length);
  for (const c of x.calls) {
    assert.ok(c.agent?.id && c.agent?.name && c.provider === 'claude' && c.model && c.kind && c.status, JSON.stringify(c));
    assert.ok(typeof c.start === 'number' && typeof c.end === 'number' && c.end >= c.start);
    assert.ok(c.usage && typeof c.usage.input === 'number' && typeof c.usage.weighted === 'number');
    assert.ok(c.route && c.route.ran?.provider === 'claude');
    assert.ok(!('text' in c), '본문은 기본으로 빼');
  }
  assert.deepEqual([...new Set(x.calls.map((c) => c.kind))].sort(), ['cards', 'goal', 'plan', 'review'].sort());
  // 완주 보고의 사실(기억 표시·기억 폴더는 빼고)
  assert.equal(x.report.end, m.status);
  assert.ok(x.report.answers && x.report.calls);
  assert.ok(!('memFolder' in x.report) && !('memory' in x.report));
  // 요청 글은 본문이라 기본으로 빠진다
  assert.ok(!('request' in x.goal));
  // 비밀·경로: 파일 전체 글에 키·알림 주소·토큰·작업 폴더 절대 경로·사용자 홈이 없다
  // 경로는 JSON 글 안에서 역슬래시가 두 개로 적히니 세 꼴(그대로·슬래시·JSON 이스케이프)을 다 본다
  const forms = (p) => [p, p.replace(/\\/g, '/'), JSON.stringify(p).slice(1, -1)];
  const all = JSON.stringify(x);
  for (const bad of [KEY, PHONE, t.app.token, ...forms(cwd), ...forms(home)]) assert.ok(!all.includes(bad), `들어가면 안 됨: ${bad.slice(0, 20)}…`);
  // 목표 글의 작업 폴더 안 경로는 작업 폴더 기준 상대 경로로
  assert.ok(x.goal.goal.includes(['src', 'a.js'].join(path.sep === '\\' ? '\\' : '/')) || x.goal.goal.includes('src/a.js'), x.goal.goal);
  // 본문 포함: 답 글과 요청 글이 들어가되 같은 가리기를 거친다
  const rb = await t.api('GET', `/api/sessions/${sid}/mission/${m.id}/export?body=1`);
  assert.equal(rb.status, 200);
  assert.equal(rb.json.body, true);
  assert.ok(rb.json.calls.some((c) => typeof c.text === 'string' && c.text.length > 0));
  assert.ok(typeof rb.json.goal.request === 'string' && rb.json.goal.request.length > 0);
  const allB = JSON.stringify(rb.json);
  for (const bad of [KEY, PHONE, t.app.token, ...forms(cwd), ...forms(home)]) assert.ok(!allB.includes(bad), `본문 포함에도 들어가면 안 됨: ${bad.slice(0, 20)}…`);
  assert.ok(rb.json.goal.request.includes('docs'), '작업 폴더 안 경로는 상대 경로로 남는다');
  // 프롬프트 전문은 앱이 저장하지 않아서 넣지 못한다고 파일에 적는다
  assert.equal(rb.json.notes.prompts, 'not-stored');
  // 다른 목표 id·없는 세션은 404, 토큰 없이는 401(기존 /api 인증)
  assert.equal((await t.api('GET', `/api/sessions/${sid}/mission/nope/export`)).status, 404);
  assert.equal((await t.api('GET', `/api/sessions/nope/mission/${m.id}/export`)).status, 404);
  const anon = await fetch(`${t.base}/api/sessions/${sid}/mission/${m.id}/export`);
  assert.equal(anon.status, 401);
});

test('2. 단계표 목표의 회의 결론·사용자가 정한 것·실행 단계, 오류로 끝난 호출의 실패 종류', { timeout: 120000 }, async () => {
  await app();
  const { sid } = await runGoal('stages', () => '정리해 줘');
  const m = S(sid).mission;
  m.decided = [{ stageIndex: 0, question: '어느 안?', answer: 'A안', at: 1 }];
  m.meetings = [{ stageIndex: 0, msgId: 'x', decision: '가짜 결정', reasons: [], dissent: ['가짜 이견'], dropped: [], next: [] }];
  const x = (await t.api('GET', `/api/sessions/${sid}/mission/${m.id}/export`)).json;
  assert.deepEqual(x.decided.map((d) => d.answer), ['A안']);
  assert.equal(x.meetings[0].decision, '가짜 결정');
  assert.deepEqual(x.cards, []);
  assert.ok(x.runs.length >= 1 && x.runs.every((r) => Array.isArray(r.stages)));
  // 오류로 끝난 호출: 실패 종류는 코드가 오류 문구로 가른 것(한도 outside · 일시 장애 transient · 그 밖 unknown)과 오류 첫 줄
  const ans = S(sid).messages.find((y) => y.role === 'agent' && y.missionId === m.id);
  const keep = { status: ans.status, error: ans.error };
  try {
    for (const [error, fail] of [['Claude AI usage limit reached', 'outside'], ['API Error: 529 overloaded\n둘째 줄', 'transient'], ['가짜 실패', 'unknown']]) {
      Object.assign(ans, { status: 'error', error });
      const c = (await t.api('GET', `/api/sessions/${sid}/mission/${m.id}/export`)).json.calls.find((y) => y.msgId === ans.id);
      assert.equal(c.fail, fail, error);
      assert.equal(c.error, error.split('\n')[0]);
    }
  } finally { Object.assign(ans, keep); }
});
