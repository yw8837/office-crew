// 목표의 완주 보고와 증거(결정 0025): 코드가 모은 완주 보고 카드(AI 호출 0), 회의 결론의 구조화, 만들기·글 카드의 "바꾼 파일" 대조(git),
// 계획 뒤 호출 어림 다시 보기, 완주 보고를 프로젝트 기억에(사용자가 넣기를 눌러야 들어가고 빼면 검색에서 빠진다).
// 가짜 CLI 만 쓴다(실제 AI 사용량 0). git 대조는 임시 폴더에 만든 테스트용 저장소에서
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/index.js';
import { bindLang } from '../server/i18n.js';
import { meetingRecord, recordMeeting, planEstimate, reviewPrompt, resumePoint, MEET_VALUE_MAX, MEET_ITEMS, MEETINGS_MAX } from '../server/mission.js';
import { sumEstimate } from '../public/js/mission-numbers.js';
import { conclusionParts, cardText } from '../public/js/office/meeting.js';
import { tailFiles, proofCheck, changedSet } from '../server/proof.js';
import { buildReport, reportText, reportLocal, REPORT_EVIDENCE } from '../server/report.js';
import { stageModel, goalEndWord } from '../public/js/stage-model.js';
import { startTestApp, freePort } from './helpers.js';

bindLang(() => 'ko'); // 순수 함수의 문구(한국어 원문)를 검사한다
let t = null;
const app = async () => (t ||= await startTestApp());
const opened = [];
after(async () => {
  for (const a of opened) { try { await a.close(); } catch { /* 이미 닫힘·윈도우 파일 잠금 무시 */ } }
  if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } }
});

const S = (id) => t.app.store.getSession(id);
const mk = async (name, role, extra = {}) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual', ...extra })).json;
const mkTeam = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides, ...(c.checks ? { checks: c.checks } : {}), ...(c.keep ? { keep: c.keep } : {}) });
const idle = (sid) => !t.app.orch.ctx.has(sid);
const reports = (s) => s.messages.filter((m) => m.role === 'proposal' && m.kind === 'report');
const planCard = (s) => s.messages.findLast((m) => m.role === 'proposal' && m.kind === 'plan');
const done = (sid, get = S, isIdle = idle) => t.waitFor(() => isIdle(sid) && !['active', 'waiting'].includes(get(sid).mission.status), 60000, '목표 끝').catch((e) => {
  const s = get(sid);
  const run = s.runs.at(-1);
  throw new Error(`${e.message}: ${JSON.stringify({ status: s.mission?.status, hold: run?.hold || null, stages: run?.stages.map((x) => `${x.mission || x.label}:${x.status}`), log: (s.mission?.log || []).slice(-5).map((x) => x.text) })}`);
});
const waitHold = (sid, reason, kind = null, get = S) => t.waitFor(() => { const r = get(sid).runs.at(-1); return r?.hold?.reason === reason && (!kind || r.hold.kind === kind) && r; }, 30000, `${reason}${kind ? `/${kind}` : ''} 대기`);
const fakeLog = () => {
  let text = '';
  try { text = fs.readFileSync(process.env.FAKE_LOG, 'utf8'); } catch { return []; }
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
};
const mark = () => fakeLog().length;
const prompts = (from) => fakeLog().slice(from).filter((l) => l.cli === 'claude' && l.text !== undefined).map((l) => l.text);
let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }

// 요청 → 목표 카드 → 확인. work: 'cards'(기본)|'stages'. signal: 목표 문장에 넣을 신호어. prep: 고른 조사·회의(기본은 둘 다 끔).
// before(sid, card): 카드가 나온 뒤 확인하기 바로 전에 부른다. h: 다시 띄운 앱(끊김 흉내)
async function goal(teamId, signal = '', { work = 'cards', prep = { research: false, meeting: false }, request = '정리해 줘', before = null, h = null, cwd = '' } = {}) {
  const api = h ? h.api : t.api;
  const get = h ? h.S : S;
  const s = (await api('POST', '/api/sessions', { teamId, ...(cwd ? { cwd } : {}) })).json;
  assert.equal((await api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  await api('POST', `/api/sessions/${s.id}/messages`, { text: request });
  await t.waitFor(() => get(s.id).mission?.status === 'draft' && (h ? h.idle(s.id) : idle(s.id)), 20000, '목표 카드');
  const c = get(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  if (before) await before(s.id, c);
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const body = { missionId: get(s.id).mission.id, expected: shown(c), review, work,
    prep: { research: !!prep.research && c.prep.research.can, meeting: !!prep.meeting && c.prep.meeting.can, lead: c.prep.lead.id, researchers: c.prep.research.who.map((w) => w.id), attendees: c.prep.meeting.who.map((w) => w.id) } };
  if (signal) body.edited = { ...shown(c), goal: `${signal} 목표` };
  const r = await api('POST', `/api/sessions/${s.id}/mission/confirm`, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return s.id;
}
// 일 카드 팀: 조사(R, 진행자) → 빌드(B) → 검수(V, 검수자). 기본 계획은 k1(조사, R)·k2(만들기, B, src/app.js)가 한 단계에서 같이 돈다
async function team3(tag) {
  const r = await mk(`${tag}조사`, '조사');
  const b = await mk(`${tag}빌드`, '빌드');
  const v = await mk(`${tag}검수`, '검수');
  const tm = await mkTeam(`${tag}팀`, [{ label: '조사', agentIds: [r.id] }, { label: '빌드', agentIds: [b.id] }, { label: '검수', agentIds: [v.id] }]);
  return { r, b, v, tm };
}
// 다시 띄운 앱(끊김 흉내. mission-cards 와 같은 방식): 같은 데이터 폴더로 새 앱
async function reopen() {
  const a = createApp({ home: path.join(t.root, 'home'), port: 0, detect: false });
  a.store.settings.lang = 'ko';
  a.store.settings.mockSpeed = 0.05;
  const port = await a.listen(await freePort());
  opened.push(a);
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Office-Token': a.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 비JSON */ }
    return { status: r.status, json };
  };
  return { app: a, api, S: (id) => a.store.getSession(id), idle: (id) => !a.orch.ctx.has(id), resume: (sid, missionId) => api('POST', `/api/sessions/${sid}/mission/resume`, { missionId }) };
}
async function crash(h, sid) {
  const index = path.join(h.app.store.dirs.sessions, 'index.json');
  const file = path.join(h.app.store.dirs.sessions, `${sid}.json`);
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const key = (m) => JSON.stringify([m?.at, m?.calls?.used, m?.calls?.cap, (m?.cards || []).map((c) => c.status)]);
  await t.waitFor(() => read(index)?.[sid]?.running === true, 5000, '목록에 실행 중');
  await t.waitFor(() => { const disk = read(file)?.mission; return !!disk && key(disk) === key(h.S(sid).mission); }, 5000, '디스크에 끊긴 자리');
  h.app.store.closed = true;
  const snap = read(file);
  h.app.store.close = () => {};
  await h.app.close();
  return { h2: await reopen(), snap };
}
// 테스트용 git 저장소(임시 폴더). git 이 없으면 null
function repo(name) {
  const dir = path.join(t.root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!hasGit) return null;
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  return dir;
}

test('1. 회의 결론 읽기(순수 함수): 네 언어의 다섯 머리말, 굵은 글씨·여러 줄 목록, "없음"은 빈 목록, 못 읽으면 지어내지 않고 비운다', () => {
  const ko = [
    '## 회의 결론', '',
    '- **결정**: 합침. 작은 범위로 먼저 만든다.',
    '- **근거**:', '  - 자료가 같은 방향이야', '  - 되돌리기 쉬워',
    '- **남은 이견**: 범위를 어디까지 줄일지',
    '- **버린 안**: 없음',
    '- **다음 할 일**: 빌드가 첫 화면을 만든다',
    '', '다음 단계 담당은 이 결론만 보고 일해.',
  ].join('\n');
  assert.deepEqual(conclusionParts(ko), {
    decision: '합침. 작은 범위로 먼저 만든다.', reasons: ['자료가 같은 방향이야', '되돌리기 쉬워'], dissent: ['범위를 어디까지 줄일지'], dropped: [], next: ['빌드가 첫 화면을 만든다'],
  });
  const en = '## Meeting conclusion\n- Decision: pick A\n- Why: cheaper\n- Remaining disagreement: none\n- Dropped options: B, because it is slow\n- Next steps: Bob builds it';
  assert.deepEqual(conclusionParts(en), { decision: 'pick A', reasons: ['cheaper'], dissent: [], dropped: ['B, because it is slow'], next: ['Bob builds it'] });
  const ja = '- 決定: A案\n- 根拠: 安い\n- 残った異論: なし\n- 捨てた案: B案\n- 次にやること: 作る';
  assert.deepEqual(conclusionParts(ja), { decision: 'A案', reasons: ['安い'], dissent: [], dropped: ['B案'], next: ['作る'] });
  const zh = '1. 决定：A 方案\n2. 依据：便宜\n3. 剩余分歧：无\n4. 放弃的方案：B\n5. 接下来要做的事：开发';
  assert.deepEqual(conclusionParts(zh), { decision: 'A 方案', reasons: ['便宜'], dissent: [], dropped: ['B'], next: ['开发'] });
  // 형식을 따르지 않은 결론: 지어내지 않고 빈 구조
  assert.deepEqual(conclusionParts('그냥 이렇게 하자고 했어.\n다들 좋대.'), { decision: '', reasons: [], dissent: [], dropped: [], next: [] });
  // 게시판 카드 글(마을 그림)은 그대로
  assert.equal(cardText(ko), '합침. 작은 범위로 먼저 만든다.');
  // 저장 값: 한 줄, 하나에 MEET_VALUE_MAX 자, 목록은 MEET_ITEMS 개까지
  const long = `- 결정: ${'가'.repeat(MEET_VALUE_MAX + 50)}\n- 근거:\n${Array.from({ length: MEET_ITEMS + 3 }, (_, k) => `  - 근거 ${k}\n    이어진 줄`).join('\n')}`;
  const rec = meetingRecord(long);
  assert.equal([...rec.decision].length, MEET_VALUE_MAX);
  assert.equal(rec.reasons.length, MEET_ITEMS);
  assert.ok(rec.reasons.every((x) => !x.includes('\n')));
  // 목표에 적기: 회의마다 하나(같은 답은 한 번), MEETINGS_MAX 개까지
  const m = {};
  recordMeeting(m, { msgId: 'a', prep: true, text: ko });
  recordMeeting(m, { msgId: 'a', prep: true, text: ko });
  recordMeeting(m, { msgId: 'b', stageIndex: 2, text: '자유 글' });
  assert.deepEqual(m.meetings.map((x) => [x.prep || false, x.stageIndex ?? null, x.msgId, x.decision]), [[true, null, 'a', '합침. 작은 범위로 먼저 만든다.'], [false, 2, 'b', '']]);
  for (let k = 0; k < MEETINGS_MAX + 5; k++) recordMeeting(m, { msgId: `x${k}`, stageIndex: 1, text: ko });
  assert.equal(m.meetings.length, MEETINGS_MAX);
});

test('2. 바꾼 파일 대조(순수 함수): 꼬리의 파일 목록 읽기, 실제로 바뀐 파일과 대조, 폴더 밖·다른 카드 몫·"없음"은 판단하지 않는다', () => {
  assert.deepEqual(tailFiles('바꾼 파일: src/a.js, `src/b.js`\n다음 카드가 알아야 할 것: x'), ['src/a.js', 'src/b.js']);
  assert.deepEqual(tailFiles('바꾼 파일:\n- src/a.js (새로 만듦)\n- docs\\b.md\n다음 카드가 알아야 할 것: x'), ['src/a.js', 'docs\\b.md']);
  assert.deepEqual(tailFiles('Changed files: none\nFor the next card: x'), []);
  assert.deepEqual(tailFiles('바꾼 파일: 없음\n다음 카드가 알아야 할 것: 없음'), []);
  assert.deepEqual(tailFiles(''), []);
  const cwd = path.resolve('/w/proj');
  const changed = new Set(['src/a.js', 'docs/b.md']);
  const own = ['src'];
  assert.equal(proofCheck({ claimed: ['src/a.js'], changed, cwd, own }), 'ok');
  assert.equal(proofCheck({ claimed: ['./SRC/A.js'], changed, cwd, own }), 'ok', '대소문자·앞의 ./ 는 가리지 않는다');
  assert.equal(proofCheck({ claimed: ['src/zzz.js'], changed, cwd, own }), 'missing');
  assert.equal(proofCheck({ claimed: ['src/'], changed, cwd, own }), 'ok', '폴더를 적었으면 그 안이 바뀌었는지');
  assert.equal(proofCheck({ claimed: [], changed, cwd, own }), 'skip', '적은 게 없으면 판단하지 않는다');
  assert.equal(proofCheck({ claimed: [path.join(path.resolve('/elsewhere'), 'x.js')], changed, cwd, own }), 'skip', '폴더 밖 경로는 판단하지 않는다');
  assert.equal(proofCheck({ claimed: [path.join(cwd, 'src', 'a.js')], changed, cwd, own }), 'ok', '작업 폴더 안의 절대 경로는 상대 경로로 본다');
  assert.equal(proofCheck({ claimed: ['docs/b.md'], changed, cwd, own, others: [['docs']] }), 'skip', '같은 단계의 다른 카드 몫으로 바뀐 파일은 누가 바꿨는지 가를 수 없다');
  assert.equal(proofCheck({ claimed: ['lib/x.js'], changed, cwd, own, prefix: 'sub/' }), 'missing');
  assert.equal(proofCheck({ claimed: ['a.js'], changed: new Set(['sub/a.js']), cwd, own: [], prefix: 'sub/' }), 'ok', '작업 폴더가 저장소의 하위 폴더면 접두를 붙여 본다');
  assert.equal(proofCheck({ claimed: ['gone.js'], changed: new Set(), cwd, own: [], touched: (p) => p.endsWith('gone.js') }), 'ok', 'git 이 무시하는 파일이라도 그 사이에 고친 흔적(수정 시각)이 있으면 바뀐 것');
  // 상태 차이: 새로 생김·없어짐·같은 파일이 다시 바뀜(수정 시각·크기)·커밋으로 넘어간 파일
  const before = { files: new Map([['a.js', ' M|1|10'], ['b.js', '??|1|3']]) };
  const after2 = { files: new Map([['a.js', ' M|2|12'], ['c.js', '??|5|1']]) };
  assert.deepEqual([...changedSet(before, after2, ['d.js'])].sort(), ['a.js', 'b.js', 'c.js', 'd.js']);
  assert.deepEqual([...changedSet(before, { files: new Map(before.files) })], []);
});

test('3. 계획 뒤 어림(순수 함수): 카드 수·물결로 남은 호출을 다시 센다(화면과 같은 sumEstimate), 끊긴 자리는 그 질문을 기억한다', () => {
  const card = (id, ownerId, kind, needs = [], files = ['x']) => ({ id, ownerId, kind, needs, files });
  const m = { cards: [card('k1', 'r', 'research', [], []), card('k2', 'b', 'build', [], ['src/app.js'])], reviewerId: 'v', returns: 0, returnCap: 1 };
  const e = planEstimate(m);
  assert.deepEqual([e.min, e.max, e.returns, e.cards], [3, 6, 1, 2], '카드 2장 + 판정 1, 되돌림 한 번 = 마지막 단계 2 + 판정 1');
  // 같은 sumEstimate 로 더한 값과 같다(서버와 화면이 같은 함수)
  assert.deepEqual([e.min, e.max], (({ min, max }) => [min, max])(sumEstimate({ spent: 0, cap: 40, review: 1, returns: 1, cards: null, stages: [{ index: 0, min: 2, max: 2, review: false, drop: false, last: 2 }] }, { work: 'stages' })));
  const two = planEstimate({ ...m, cards: [card('k1', 'r', 'build'), card('k2', 'b', 'build', ['k1'])] });
  assert.deepEqual([two.min, two.max], [3, 5], '마지막 단계에 카드 1장이면 되돌림은 1 + 판정 1');
  const none = planEstimate({ ...m, reviewerId: null });
  assert.deepEqual([none.min, none.max, none.returns], [2, 2, 0], '검수자가 없으면 판정·되돌림 없음');
  assert.deepEqual(planEstimate({ ...m, returns: 1, returnCap: 1 }).returns, 0, '남은 되돌림만 센다');
  // 끊긴 자리: 계획 뒤 어림 질문(cap, kind plan)을 그대로 읽는다(이어서 하면 같은 질문을 다시 묻게)
  const stages = [{ mission: 'plan', agentIds: ['r'] }, { mission: 'cards', agentIds: ['r', 'b'], cardIds: ['k1', 'k2'] }, { mission: 'review', agentIds: ['v'] }];
  assert.deepEqual(resumePoint({ stageIndex: 1, phase: 'work', back: false, working: [], finished: [], wait: { reason: 'cap', kind: 'plan' } }, stages).wait, { reason: 'cap', kind: 'plan' });
});

test('4. 완주 보고 만들기(순수 함수): 코드가 아는 사실 먼저(끝 상태·시간·호출·종류별 답·기준·사용자가 고른 것·확인 못 한 것·실패 종류·배정), 에이전트 글은 표시·상한, 글 판에는 회의 결론을 넣지 않는다', () => {
  const ev = '근'.repeat(REPORT_EVIDENCE + 40);
  const m = {
    id: 'ms-abcdef12', status: 'accepted', goal: '가짜 목표', createdAt: 1000, confirmedAt: 60000,
    calls: { used: 9, cap: 40 }, estimate: { min: 7, max: 12 },
    criteria: [{ id: 'c1', text: '기준 1', status: 'pass', evidence: '파일을 열어 봤어' }, { id: 'c2', text: '기준 2', status: 'unknown', evidence: ev }, { id: 'c3', text: '기준 3', status: 'open', evidence: '' }],
    research: { questions: [{ id: 'q1', status: 'done' }, { id: 'q2', status: 'empty' }, { id: 'q3', status: 'failed' }] },
    cards: [{ id: 'k1', status: 'done' }, { id: 'k2', status: 'hole', by: 'quota' }, { id: 'k3', status: 'blocked' }, { id: 'k4', status: 'done', proof: { files: ['src/a.js'] } }],
    meetings: [{ prep: true, msgId: 'mc1', decision: '옛 결정', dissent: [] }, { prep: true, msgId: 'mc2', decision: 'A안으로', dissent: ['범위'], reasons: ['싸다'] }, { stageIndex: 3, msgId: 'mc3', decision: '', dissent: [] }],
    log: [
      { kind: 'skip', n: 4, text: '앞 4줄 생략' },
      { kind: 'confirm', text: '사용자가 목표를 확인했어(기준 3개).', at: 1 },
      { kind: 'note', text: '추가 지시: 표도 넣어', msgId: 'u2', at: 2 },
      { kind: 'note', text: '남은 호출이 상한의 4분의 1 아래라서', at: 3 },
      { kind: 'review', text: '검수 1회차', fail: 'review', at: 4 },
      { kind: 'error', text: '오류', fail: 'unknown', at: 5 },
      { kind: 'quota', text: '한도', fail: 'outside', at: 6 },
      { kind: 'route', text: '배정', at: 7 },
      { kind: 'answer', text: '받아들이기를 골랐어.', at: 8 },
      { kind: 'resume', text: '이어서: "빌드" 단계부터.', msgId: 'card', at: 9 },
      { kind: 'resume', text: '앞 단계 1개의 결과를 다시 모았어.', at: 10 },
    ],
  };
  const runs = [{ id: 'g', mission: 'goal', missionId: m.id, stages: [] }, { id: 'w', mission: 'work', missionId: m.id, stages: [{ label: '조사', status: 'done' }, { label: '빌드', status: 'skipped' }, { label: '회의', status: 'done', meeting: { rounds: 2 } }, { label: '팀 회의', status: 'done' }] }, { id: 'other', mission: 'work', missionId: 'ms-old', stages: [] }];
  const A = (runId, extra) => ({ role: 'agent', runId, status: 'done', text: 'x', ...extra });
  const messages = [A('g', { goalDraft: true }), A('w', { prep: { kind: 'scan' } }), A('w', { prep: { kind: 'research', qid: 'q1' } }), A('w', { meeting: { phase: 'opinion' } }), A('w', { meeting: { phase: 'research' }, checkOf: 'x' }),
    A('w', { prep: { kind: 'plan' } }), A('w', { card: { id: 'k1' } }), A('w', {}), A('w', { review: { round: 1 } }), A('other', { goalDraft: true }), { role: 'user', text: 'x' }];
  const r = buildReport({ m, messages, runs, now: 60000 + 125000 });
  assert.equal(r.end, 'accepted');
  assert.deepEqual([r.from, r.to], [60000, 185000], '확인부터 끝까지');
  assert.deepEqual(r.calls, { used: 9, cap: 40 });
  assert.deepEqual(r.estimate, { min: 7, max: 12 });
  assert.deepEqual(r.answers, { goal: 1, research: 3, meeting: 1, plan: 1, cards: 1, work: 1, review: 1 }, '다른 목표의 실행은 세지 않는다');
  assert.deepEqual(r.criteria.map((c) => [c.id, c.status]), [['c1', 'pass'], ['c2', 'unknown'], ['c3', 'open']]);
  assert.equal([...r.criteria[1].evidence].length, REPORT_EVIDENCE, '에이전트가 쓴 근거는 상한까지');
  assert.deepEqual(r.user.map((x) => x.text), ['사용자가 목표를 확인했어(기준 3개).', '추가 지시: 표도 넣어', '받아들이기를 골랐어.', '이어서: "빌드" 단계부터.'], '사용자가 누른 것만(코드가 쓴 줄은 빼고)');
  assert.deepEqual(r.unverified.unknown, ['c2']);
  assert.deepEqual(r.unverified.open, ['c3']);
  assert.deepEqual(r.unverified.research, { total: 3, missing: 2 });
  assert.deepEqual(r.unverified.cards, [{ id: 'k2', status: 'hole', by: 'quota' }, { id: 'k3', status: 'blocked' }]);
  assert.deepEqual(r.unverified.proof, [{ id: 'k4', files: ['src/a.js'] }]);
  assert.deepEqual(r.unverified.skipped, ['빌드']);
  assert.equal(r.unverified.quota, 1);
  assert.deepEqual(r.fails, { review: 1, unknown: 1, outside: 1 });
  assert.equal(r.routes, 1);
  assert.equal(r.logCut, 4);
  assert.deepEqual(r.meetings.map((x) => [x.prep || false, x.msgId, x.decision, x.dissent]), [[true, 'mc2', 'A안으로', ['범위']], [false, 'mc3', '', []]], '회의마다 가장 최근 결론, 결정·남은 이견만');
  assert.equal(r.meetings[1].label, '팀 회의', '회의 단계 이름은 그 목표의 마지막 일 실행에서');
  // 글 판(기억에 넣는 것): 출처·확정하지 않음 표시, 사실과 기준별 결과, 에이전트 근거 표시. 회의 결론은 넣지 않는다
  const text = reportText(r, { missionId: m.id });
  assert.ok(text.startsWith('[완주 보고'), text.slice(0, 80));
  assert.ok(text.includes('ms-abcdef12') && text.includes('사용자가 확정하지 않은 기록'));
  assert.ok(text.includes('c2') && text.includes('에이전트가 씀'));
  assert.ok(!text.includes('A안으로') && !text.includes('범위'), '회의 결론은 기억에 넣지 않는다');
  // 내 PC 모델만 받은 목표인가(결정 0007): 그 목표의 실행에서 내 PC 모델이 답했거나 요청이 내 PC 전용 표시
  assert.equal(reportLocal({ messages: [A('w', { provider: 'local' })], runs, m }), true);
  assert.equal(reportLocal({ messages: [A('w', { provider: 'claude' })], runs, m }), false);
  assert.equal(reportLocal({ messages: [A('w', { provider: 'claude' }), { role: 'user', id: 'q', local: true }], runs, m: { ...m, requestMsgId: 'q' } }), true);
  // 끝 깃발과 같은 말(흐름 무대와 모순되지 않게)
  for (const st of ['done', 'accepted', 'stopped']) {
    const sm = stageModel({ run: { id: 'w', missionId: m.id, status: 'done', endedAt: 1, stages: [] }, mission: { ...m, status: st } });
    assert.equal(sm.end.text, goalEndWord(st), st);
  }
});

test('5. 통과로 끝: 완주 보고 카드 하나(AI 호출 0), 실제 호출·어림·종류별 답·기준, 같은 목표에 두 번 만들지 않는다. 계획 카드에 남은 호출 어림 줄', async () => {
  await app();
  const { tm } = await team3('보고');
  const sid = await goal(tm.id);
  await done(sid);
  const s = S(sid);
  assert.equal(s.mission.status, 'done');
  const callsAtEnd = s.mission.calls.used;
  const [r] = reports(s);
  assert.ok(r, '보고 카드');
  assert.equal(reports(s).length, 1);
  assert.equal(s.mission.reportMsgId, r.id);
  assert.deepEqual([r.end, r.status, r.text, r.missionId], ['done', 'done', '', s.mission.id]);
  assert.deepEqual(r.calls, { used: callsAtEnd, cap: 40 });
  assert.deepEqual(r.estimate, { min: s.mission.estimate.min, max: s.mission.estimate.max });
  assert.deepEqual(r.answers, { goal: 1, research: 0, meeting: 0, plan: 1, cards: 2, work: 0, review: 1 });
  assert.deepEqual(r.criteria.map((c) => c.status), ['pass', 'pass']);
  assert.ok(r.user.some((x) => x.text.startsWith('사용자가 목표를 확인했어')));
  await t.waitFor(() => reports(S(sid))[0].filesState !== 'pending', 10000, '바뀐 파일 채우기');
  assert.equal(reports(S(sid))[0].filesState, 'none', 'git 저장소가 아닌 작업 폴더');
  assert.equal(S(sid).mission.calls.used, callsAtEnd, '보고는 AI 를 부르지 않는다');
  // 계획 카드의 남은 호출 어림(카드 2장 + 판정 1, 되돌림 최대 1번)
  const pc = planCard(s);
  assert.deepEqual([pc.estimate.min, pc.estimate.max, pc.estimate.returns, pc.estimate.cap], [3, 6, 1, 40]);
  assert.ok(pc.estimate.used >= 2);
  assert.ok(!s.runs.some((x) => x.hold?.kind === 'plan'), '어림이 상한 안이면 묻지 않는다');
});

test('6. 받아들임·중지로 끝난 보고: 끝 상태, 사용자가 고른 것, 실패 종류(검수에서 걸림), 기준의 근거는 에이전트가 쓴 글로', async () => {
  await app();
  const { tm } = await team3('받음');
  const sid = await goal(tm.id, 'REVIEWFAIL2');
  await waitHold(sid, 'mission', 'verdict');
  assert.equal(reports(S(sid)).length, 0, '묻는 동안(살아 있는 목표)은 보고가 없다');
  await t.api('POST', `/api/sessions/${sid}/control`, { action: 'accept' });
  await done(sid);
  const [r] = reports(S(sid));
  assert.equal(r.end, 'accepted');
  assert.ok(r.user.some((x) => x.text === '받아들이기를 골랐어.'), JSON.stringify(r.user));
  assert.equal(r.fails.review, 2, '두 회차 다 c1 불합격');
  assert.equal(r.criteria[0].status, 'fail');
  assert.equal(r.criteria[0].evidence, '가짜 불합격 사유 2회차');
  // 그만
  const s2 = await goal(tm.id, 'REVIEWFAIL2');
  await waitHold(s2, 'mission', 'verdict');
  await t.api('POST', `/api/sessions/${s2}/control`, { action: 'stop' });
  await done(s2);
  const [r2] = reports(S(s2));
  assert.equal(S(s2).mission.status, 'stopped');
  assert.equal(r2.end, 'stopped');
  assert.equal(reports(S(s2)).length, 1);
});

test('7. 회의 결론 구조화: 준비 회의와 목표의 팀 회의 단계 결론을 mission.meetings 에, 일 단계에 넘기는 결론은 지금처럼 전문, 못 읽으면 빈 구조. 보고에는 결정·남은 이견만', async () => {
  await app();
  const r = await mk('회의조사', '조사');
  const a = await mk('회의분석', '분석');
  const b = await mk('회의빌드', '빌드');
  const tm = await mkTeam('회의팀', [{ label: '조사', agentIds: [r.id] }, { label: '분석', agentIds: [a.id] }, { label: '빌드', agentIds: [b.id] }]);
  const from = mark();
  const sid = await goal(tm.id, 'CONCLUDEFMT', { work: 'stages', prep: { meeting: true } });
  await done(sid);
  const s = S(sid);
  const conc = s.messages.find((x) => x.role === 'agent' && x.meeting?.phase === 'conclude');
  assert.deepEqual(s.mission.meetings, [{ prep: true, msgId: conc.id, decision: '가짜 결정: A안으로 간다', reasons: ['가짜 근거 1', '가짜 근거 2'], dissent: ['가짜 이견: 범위'], dropped: [], next: ['가짜 다음: 빌드가 만든다'] }]);
  assert.equal(s.mission.meetingMsgId, conc.id);
  // 다음 대목에는 지금처럼 결론 전문이 표식 안의 참고 자료로 간다(동작 변화 없음)
  const work = prompts(from).find((p) => p.includes('[회의 결론 — 참고 자료]') && p.includes('"빌드"'));
  assert.ok(work && work.includes('- **남은 이견**: 가짜 이견: 범위'), '결론 전문');
  const [rep] = reports(s);
  assert.deepEqual(rep.meetings.map((x) => [x.prep, x.decision, x.dissent]), [[true, '가짜 결정: A안으로 간다', ['가짜 이견: 범위']]]);
  // 목표의 팀 회의 단계(일 카드를 못 쓰는 팀), 형식 없는 결론 → 빈 구조(지어내지 않는다)
  const tm2 = await mkTeam('회의단계팀', [{ label: '조사', agentIds: [r.id] }, { label: '논의', agentIds: [a.id, r.id], meeting: { rounds: 1 } }, { label: '빌드', agentIds: [b.id] }]);
  const s2 = await goal(tm2.id, '', { work: 'stages' });
  await done(s2);
  const m2 = S(s2).mission;
  assert.equal(m2.meetings.length, 1);
  assert.deepEqual([m2.meetings[0].stageIndex, m2.meetings[0].prep, m2.meetings[0].decision, m2.meetings[0].reasons], [1, undefined, '', []]);
});

test('8. 만들기 카드의 바꾼 파일 대조(git): 적은 파일이 실제로 바뀌었으면 조용히, 안 바뀌었으면 진행 기록 경고·보고의 확인 못 한 것·검수 자료에 코드의 한 줄. 카드는 실패로 만들지 않는다. git 이 아니면 건너뛴다', async () => {
  await app();
  const { tm } = await team3('증거');
  // git 저장소가 아니면 조용히 건너뛴다(git 이 없는 PC 에서도 이것만은 본다)
  const plain = path.join(t.root, 'proof-plain');
  fs.mkdirSync(plain, { recursive: true });
  const s0 = await goal(tm.id, 'CARDWRITE NOWRITEK2', { cwd: plain });
  await done(s0);
  assert.equal(S(s0).mission.log.filter((x) => x.kind === 'proof').length, 0);
  assert.ok(!S(s0).mission.cards.some((c) => c.proof));
  if (!hasGit) return; // 아래는 git 이 있어야 볼 수 있다(mission-cards 의 git 시험과 같은 방식)
  // k2(만들기)가 src/k2.js 를 바꿨다고 적고 실제로도 바꾼다
  const ok = repo('proof-ok');
  const s1 = await goal(tm.id, 'CARDWRITE', { cwd: ok });
  await done(s1);
  assert.ok(fs.existsSync(path.join(ok, 'src', 'k2.js')));
  assert.equal(S(s1).mission.log.filter((x) => x.kind === 'proof').length, 0, JSON.stringify(S(s1).mission.log.map((x) => x.text)));
  assert.ok(!S(s1).mission.cards.some((c) => c.proof));
  // k2 가 적기만 하고 바꾸지 않는다
  const bad = repo('proof-bad');
  const from = mark();
  const s2 = await goal(tm.id, 'CARDWRITE NOWRITEK2', { cwd: bad });
  await done(s2);
  const m2 = S(s2).mission;
  assert.equal(m2.status, 'done', '경고만 하고 카드를 실패로 만들거나 다시 돌리지 않는다');
  const lines = m2.log.filter((x) => x.kind === 'proof');
  assert.equal(lines.length, 1, JSON.stringify(m2.log.map((x) => x.text)));
  assert.ok(lines[0].text.includes('k2') && lines[0].text.includes('src/k2.js'));
  assert.deepEqual(m2.cards.find((c) => c.id === 'k2').proof.files, ['src/k2.js']);
  assert.equal(m2.cards.find((c) => c.id === 'k2').status, 'done');
  assert.ok(!m2.cards.find((c) => c.id === 'k1').proof, '조사 카드는 대조하지 않는다');
  const rp = prompts(from).find((p) => p.includes('[기준 판정 — 1번째 검수]'));
  assert.equal((rp.match(/이 카드는 바꿨다고 적은 파일이 실제로는 안 바뀌었어/g) || []).length, 1, '검수 자료에 코드의 한 줄(k2 에만)');
  await t.waitFor(() => reports(S(s2))[0]?.filesState === 'done', 10000, '바뀐 파일');
  const rep = reports(S(s2))[0];
  assert.deepEqual(rep.unverified.proof, [{ id: 'k2', files: ['src/k2.js'] }]);
  assert.ok(rep.files.list.includes('src/k1.js'), JSON.stringify(rep.files));
});

test('9. 계획 뒤 어림 다시 보기: 남은 호출 어림이 남은 상한을 넘으면 첫 카드 단계 앞에서 "20번 더"로 묻는다(카드는 아직 안 돈다). 더 → 이어서, 그만 → 중지와 보고', async () => {
  await app();
  const { tm } = await team3('어림');
  const lower = (sid) => { S(sid).mission.calls.cap = 6; };
  const from = mark();
  const sid = await goal(tm.id, '', { before: lower });
  const run = await waitHold(sid, 'cap', 'plan');
  const first = run.stages.findIndex((x) => x.mission === 'cards');
  assert.equal(run.hold.stageIndex, first);
  assert.deepEqual([run.hold.min, run.hold.max, run.hold.cap, run.hold.step], [3, 6, 6, 20]);
  assert.ok(!prompts(from).some((p) => /^\[일 카드 k\d\]$/m.test(p)), '카드는 아직 안 돌았다');
  assert.ok(S(sid).mission.log.some((x) => x.kind === 'cap' && x.text.includes('계획 뒤 어림')), JSON.stringify(S(sid).mission.log.map((x) => x.text)));
  assert.deepEqual(S(sid).mission.at.wait, { reason: 'cap', kind: 'plan' });
  await t.api('POST', `/api/sessions/${sid}/control`, { action: 'more' });
  await done(sid);
  assert.equal(S(sid).mission.status, 'done');
  assert.equal(S(sid).mission.calls.cap, 26);
  // 그만
  const s2 = await goal(tm.id, '', { before: lower });
  await waitHold(s2, 'cap', 'plan');
  await t.api('POST', `/api/sessions/${s2}/control`, { action: 'stop' });
  await done(s2);
  assert.equal(S(s2).mission.status, 'stopped');
  assert.equal(reports(S(s2))[0].end, 'stopped');
});

test('10. 끊김: 계획 뒤 어림 질문에서 끊기면 보고는 없고, 이어서 하면 같은 질문을 AI 호출 없이 다시 묻는다. 이어서 끝나면 보고는 한 번', async () => {
  await app();
  const { tm } = await team3('어림끊김');
  const h = await reopen();
  const sid = await goal(tm.id, '', { h, before: (id) => { h.S(id).mission.calls.cap = 6; } });
  await waitHold(sid, 'cap', 'plan', h.S);
  const { h2, snap } = await crash(h, sid);
  assert.deepEqual(snap.mission.at.wait, { reason: 'cap', kind: 'plan' });
  assert.equal(h2.S(sid).mission.status, 'cut');
  assert.equal(reports(h2.S(sid)).length, 0, '끊긴 목표에는 보고가 없다');
  const used = h2.S(sid).mission.calls.used;
  const n = mark();
  assert.equal((await h2.resume(sid, h2.S(sid).mission.id)).status, 200);
  await waitHold(sid, 'cap', 'plan', h2.S);
  assert.equal(h2.S(sid).mission.calls.used, used, 'AI 호출 없이 같은 질문');
  assert.equal(prompts(n).length, 0);
  await h2.api('POST', `/api/sessions/${sid}/control`, { action: 'more' });
  await done(sid, h2.S, h2.idle);
  assert.equal(h2.S(sid).mission.status, 'done');
  assert.equal(reports(h2.S(sid)).length, 1);
});

test('11. 완주 보고를 기억에: 넣기를 눌러야 들어가고(출처·확정하지 않음 표시), 빼면 검색에서 빠지고, 다시 넣으면 같은 조각이 돌아온다. 기억이 꺼져 있으면 409', async () => {
  await app();
  const { tm } = await team3('기억');
  const sid = await goal(tm.id);
  await done(sid);
  const rep = reports(S(sid))[0];
  const url = `/api/sessions/${sid}/report/${rep.id}/memory`;
  t.app.store.settings.memory = false;
  assert.equal((await t.api('POST', url, { on: true })).status, 409, '기억이 꺼져 있으면 넣지 않는다');
  t.app.store.settings.memory = true;
  try {
    const info = (await t.api('GET', `/api/sessions/${sid}/memory`)).json;
    const find = async () => (await t.api('GET', `/api/memory/search?key=${info.key}&q=${encodeURIComponent(S(sid).mission.id.slice(3))}`)).json.hits.filter((h) => h.messageId === rep.id);
    assert.deepEqual(await find(), [], '넣기 전에는 없다');
    const r1 = await t.api('POST', url, { on: true });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r1.json.memory.on, true);
    await t.app.orch.settled();
    const hits = await find();
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].role, 'report');
    assert.ok(hits[0].text.includes('사용자가 확정하지 않은 기록') && hits[0].text.includes(S(sid).mission.id));
    const mem = await t.app.orch.memory.of(t.app.orch.memoryFolder(S(sid)));
    const chunks = mem.stats().chunks;
    assert.equal((await t.api('POST', url, { on: false })).json.memory.on, false);
    assert.deepEqual(await find(), [], '빼면 검색에서 빠진다');
    assert.equal(reports(S(sid))[0].memory.on, false);
    assert.equal((await t.api('POST', url, { on: true })).json.memory.on, true);
    assert.ok((await find()).length >= 1, '다시 넣으면 돌아온다');
    assert.equal(mem.stats().chunks, chunks, '다시 넣을 때 조각을 또 쌓지 않는다');
    // 보고가 아닌 메시지는 거절
    const other = S(sid).messages.find((x) => x.role === 'agent');
    assert.equal((await t.api('POST', `/api/sessions/${sid}/report/${other.id}/memory`, { on: true })).status, 404);
  } finally { t.app.store.settings.memory = false; }
});
