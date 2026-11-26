// 실행 기록 내보내기(결정 0030): 목표 하나의 실행을 JSON 파일 하나로. 목표·기준, 카드와 상태, 진행 기록, 회의 결론·확정한 것, 호출별(누가·어느 AI·모델·종류·시작/끝·사용량·배정·실패 종류),
// 완주 보고의 사실. API 키·알림 주소·토큰은 가리고, 작업 폴더 안의 절대 경로는 상대 경로로, 프롬프트·답 전문은 "본문 포함"을 켰을 때만. 형식 버전 번호.
// 기존 /api 인증을 그대로 받는다. 가짜 CLI 만 쓴다(실제 AI 사용량 0)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindLang } from '../server/i18n.js';
import { EXPORT_FORMAT, EXPORT_VERSION, exportCleaner, SECRET_MASK } from '../server/report.js';
import { startTestApp } from './helpers.js';

bindLang(() => 'ko');
let t = null;
const app = async () => (t ||= await startTestApp());
after(async () => { if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } } });
const S = (id) => t.app.store.getSession(id);
const idle = (sid) => !t.app.orch.ctx.has(sid);
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides, ...(c.checks ? { checks: c.checks } : {}), ...(c.keep ? { keep: c.keep } : {}) });

// 알려진 토큰 꼴(sk- 등)이 아닌 값: 기억의 redact 로는 안 잡히고 설정의 비밀 값 목록으로만 가려진다(그 가리기를 지우면 이 시험이 떨어진다)
const KEY = 'zzapikey-NOT-A-KNOWN-SHAPE-7f3a9c';
const NOTE = '추가 지시 비밀 문장 QQZQ';
const PHONE = 'https://ntfy.sh/private-topic-zz91';

async function runGoal(work, request, note = '') {
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
  // 목표가 도는 동안 보낸 말은 추가 지시(진행 기록의 사용자 줄)
  if (note) assert.equal((await t.api('POST', `/api/sessions/${s.id}/messages`, { text: note })).json?.noted, true);
  await t.waitFor(() => idle(s.id) && ['done', 'accepted', 'stopped'].includes(S(s.id).mission.status), 60000, '목표 끝');
  return { sid: s.id, cwd, a, b, v };
}

test('1. 내보내기: 형식 버전, 목표·기준·카드·진행 기록·호출별 기록·보고 사실이 들어가고, 비밀은 가리고, 작업 폴더 경로는 상대 경로, 본문은 고를 때만', { timeout: 180000 }, async () => {
  await app();
  await t.api('PUT', '/api/settings', { apiKeys: { anthropic: KEY }, phoneUrl: PHONE });
  const home = os.homedir();
  const { sid, cwd, a, b } = await runGoal('cards', (dir) => `정리해 줘. 키 ${KEY} 알림 ${PHONE} 토큰 ${t.app.token} 폴더 ${path.join(dir, 'docs', 'brief.md')} 집 ${path.join(home, 'x.txt')}`, NOTE);
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
  assert.ok(x.log.every((l) => typeof l.at === 'number' && l.kind && (typeof l.text === 'string' || l.textOmitted === true)));
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
  // 본문을 빼면 사용자가 쓴 글도 빠진다: 세션 제목(첫 요청 앞부분), 추가 지시 줄(글 없이 종류만), 완주 보고의 같은 줄
  assert.equal(x.session.title, '');
  assert.ok(!all.includes('QQZQ') && !all.includes('정리해 줘. 키'), '추가 지시·요청 글이 없다');
  const noteLine = x.log.find((l) => l.kind === 'note' && l.by === 'user');
  assert.ok(noteLine && noteLine.textOmitted === true && !('text' in noteLine), JSON.stringify(noteLine));
  assert.ok(x.report.user.some((u) => u.textOmitted === true));
  assert.ok(x.notes.omitted.includes('session title') && x.notes.omitted.includes('extra instruction text'));
  // 본문 포함: 답 글과 요청 글이 들어가되 같은 가리기를 거친다
  const rb = await t.api('GET', `/api/sessions/${sid}/mission/${m.id}/export?body=1`);
  assert.equal(rb.status, 200);
  assert.equal(rb.json.body, true);
  assert.ok(rb.json.calls.some((c) => typeof c.text === 'string' && c.text.length > 0));
  assert.ok(typeof rb.json.goal.request === 'string' && rb.json.goal.request.length > 0);
  const allB = JSON.stringify(rb.json);
  for (const bad of [KEY, PHONE, t.app.token, ...forms(cwd), ...forms(home)]) assert.ok(!allB.includes(bad), `본문 포함에도 들어가면 안 됨: ${bad.slice(0, 20)}…`);
  assert.ok(rb.json.goal.request.includes('docs'), '작업 폴더 안 경로는 상대 경로로 남는다');
  assert.ok(rb.json.session.title.length > 0 && allB.includes('QQZQ'), '본문 포함이면 제목·추가 지시 글도');
  assert.ok(allB.includes(SECRET_MASK), '비밀 값은 가린 표시로');
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

test('3. 가리기 표: 뿌리 경로 뒤가 구분자·글 끝·따옴표·공백일 때만 바꾸고(이름이 이어지는 다른 폴더는 그대로), Git Bash·WSL·슬래시 섞임·드라이브 대소문자도, 이름_KEY=값 꼴과 메일·Bearer 도 가린다', () => {
  const B = String.fromCharCode(92); // 역슬래시
  const win = (...p) => p.join(B);
  const c = exportCleaner({ roots: [win('D:', 'proj')], home: win('C:', 'Users', 'kim'), dataDir: win('C:', 'Users', 'kim', '.office-crew'), secrets: ['zz-secret-value-1'] });
  const TABLE = [
    [win('D:', 'project2', 'x.js'), win('D:', 'project2', 'x.js')], // 이름이 이어지는 다른 폴더: 그대로
    [win('D:', 'proj', 'x.js'), win('.', 'x.js')],
    ['d:/proj/x.js', './x.js'], // 드라이브 소문자·슬래시
    ['/d/proj/x.js', './x.js'], // Git Bash
    ['/mnt/d/proj/x.js', './x.js'], // WSL
    [['D:', 'proj', 'x.js'].join(B + B), ['.', 'x.js'].join(B + B)], // JSON 이스케이프의 두 겹 역슬래시
    [`D:/proj${B}x.js`, `.${B}x.js`], // 슬래시 섞임
    [`"${win('D:', 'proj')}"`, '"."'], // 따옴표
    [`at ${win('D:', 'proj')} now`, 'at . now'], // 공백
    [`X${win('D:', 'proj', 'a')}`, `X${win('D:', 'proj', 'a')}`], // 다른 글의 한가운데: 그대로
    [win('C:', 'Users', 'kimberly', 'a'), win('C:', 'Users', 'kimberly', 'a')], // 홈과 이름만 이어지는 다른 사람: 그대로
    [win('C:', 'Users', 'kim', 'a'), win('~', 'a')],
    [win('C:', 'Users', 'kim'), '~'],
    [win('c:', 'users', 'KIM', 'a'), win('~', 'a')], // 대소문자 무시(Windows)
    [['', 'c', 'Users', 'kim', '.office-crew', 'uploads', '1.png'].join('/'), '<data>/uploads/1.png'], // 데이터 폴더가 홈보다 먼저(긴 것부터)
    [`https://x.example.com${['', 'c', 'Users', 'kim', 'a'].join('/')}`, `https://x.example.com${['', 'c', 'Users', 'kim', 'a'].join('/')}`], // 주소 안: 그대로
    ['API_KEY=abc123 github_token: "xyz" max_tokens: 100 DB_PASSWORD=hunter2', `API_KEY=${SECRET_MASK} github_token: ${SECRET_MASK} max_tokens: 100 DB_PASSWORD=${SECRET_MASK}`],
    ['key zz-secret-value-1 here', `key ${SECRET_MASK} here`],
  ];
  for (const [input, want] of TABLE) assert.equal(c(input), want, input);
  const mail = c('mail someone@example.com with Authorization: Bearer abcdefgh12345678');
  assert.ok(!mail.includes('someone@example.com') && !mail.includes('abcdefgh12345678'), mail);
  // POSIX 경로: 대소문자 구분, 이름이 이어지는 폴더는 그대로
  const p = exportCleaner({ roots: ['/home/me/proj'], home: '/home/me' });
  for (const [input, want] of [['/home/me/proj/a.js', './a.js'], ['/home/me/project/a.js', '~/project/a.js'], ['/home/meg/a', '/home/meg/a'], ['/HOME/me/a', '/HOME/me/a'], ['/data/home/me/a', '/data/home/me/a']]) {
    assert.equal(p(input), want, input);
  }
});
