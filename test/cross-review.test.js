// 교차 검수(결정 0032): 목표 카드에서 켜는 선택. 검증 검수자와 레드팀 검수자가 서로의 글을 보지 않고(각자 새 대화, 읽기 전용) 판정하고,
// 코드가 기준마다 합친다(둘 다 합격 = 합격, 확인할 수 있는 근거가 있는 불합격 = 불합격, 한쪽만 근거 없이 불합격 = 엇갈림 → 판정 카드).
// 가짜 CLI 로만(실제 AI 사용량 0). 신호어는 test/fake-cli/fake-claude.js 의 REDFAILEV·REDFAILNOEV·REDOMIT·REDBAD·REDERR·REDEXTRA·REDLEAD·REDQUOTA·
// CHECKBROKEN·CHECKFAILNOEV·CHECKUNK·CHECKEXTRA·CHECKERR·SECRETS, fake-codex.js 의 CODEXREVIEW
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { bindLang } from '../server/i18n.js';
import { hasEvidence, crossPlan, mergeReviews, applyPicks, cleanPicks, reviewPrompt, returnItems, returnPrompt, applyReview, estimateCalls, estimateParts, planEstimate, newMission, cutMission, RETURN_CAP } from '../server/mission.js';
import { sumEstimate } from '../public/js/mission-numbers.js';
import { answerKind } from '../public/js/usage-numbers.js';
import { buildReport, exportRun, reportText } from '../server/report.js';
import { flowModel } from '../public/js/flow-graph.js';
import { crossWords, answerRows } from '../public/js/report-lines.js';
import { attentionOf } from '../server/store.js';
import { startTestApp, promptBody } from './helpers.js';

bindLang(() => 'ko'); // 순수 함수의 문구(한국어 원문)를 검사한다
let t = null;
// 둘째 검수자는 로그인된 AI 의 팀원만 고른다(테스트는 탐지를 안 하므로 Claude·Codex 를 로그인된 것으로 둔다)
const login = (on = { claude: true, codex: true }) => { t.app.providers.detected = { ...(t.app.providers.detected || {}), ...Object.fromEntries(Object.entries(on).map(([k, v]) => [k, { installed: true, loggedIn: v }])) }; };
const app = async () => { if (!t) { t = await startTestApp(); login(); } return t; };
after(async () => { if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } } });

const S = (id) => t.app.store.getSession(id);
const mk = async (name, role, extra = {}) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual', ...extra })).json;
const mkTeam = async (name, stages, extra = {}) => (await t.api('POST', '/api/teams', { name, stages, ...extra })).json;
const mkSession = async (teamId) => {
  const s = (await t.api('POST', '/api/sessions', { teamId })).json;
  assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
  return s.id;
};
const say = (sid, text) => t.api('POST', `/api/sessions/${sid}/messages`, { text });
const ctl = (sid, action, extra = {}) => t.api('POST', `/api/sessions/${sid}/control`, { action, ...extra });
const idle = (sid) => !t.app.orch.ctx.has(sid);
const waitDraft = (sid) => t.waitFor(() => S(sid).mission?.status === 'draft' && idle(sid), 20000, '목표 카드');
const waitEnd = (sid) => t.waitFor(() => S(sid).runs.length >= 2 && S(sid).runs.at(-1).endedAt && idle(sid), 40000, '목표 실행 끝');
const waitHold = (sid, reason, kind = null) => t.waitFor(() => { const r = S(sid).runs.at(-1); return r?.hold?.reason === reason && (!kind || r.hold.kind === kind) && r; }, 40000, `${reason}/${kind} 대기`);
const cardOf = (sid) => S(sid).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
const shown = (c) => ({ goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides });
const confirm = (sid, body) => t.api('POST', `/api/sessions/${sid}/mission/confirm`, body);
const reviewMsgs = (sid) => S(sid).messages.filter((m) => m.role === 'agent' && m.review);
// 가짜 claude 기록: 같은 프로세스(pid)의 인자·차례 글을 묶는다(두 검수자가 동시에 돌아도 가릴 수 있게)
const procs = (from) => {
  const by = new Map();
  for (const l of t.fakeLog().slice(from)) {
    if (l.cli !== 'claude' || !l.pid) continue;
    const p = by.get(l.pid) || { pid: l.pid, args: null, texts: [] };
    if (l.args) p.args = l.args;
    if (l.text !== undefined) p.texts.push(l.text);
    by.set(l.pid, p);
  }
  return [...by.values()];
};
const reviewProcs = (from) => procs(from).filter((p) => p.texts.some((x) => x.includes('[기준 판정 — ')));

// 교차 검수를 할 수 있는 팀: 분석(진행자) → 개발 → 검수 단계(검증·레드팀 둘 다 검수 역할, 기준 판정으로 대신해 빠진다). 검수자는 edit 권한으로 만든다(그 실행만 읽기 전용인지 보려고)
async function crossTeam(tag, { red = {}, perm = 'edit' } = {}) {
  const lead = await mk(`${tag}분석`, '분석');
  const dev = await mk(`${tag}개발`, '개발');
  const check = await mk(`${tag}검증`, '검수', { permission: perm });
  const rt = await mk(`${tag}레드`, '검수', { permission: perm, ...red });
  const tm = await mkTeam(`${tag}팀`, [{ label: '분석', agentIds: [lead.id] }, { label: '개발', agentIds: [dev.id] }, { label: '검수', agentIds: [check.id, rt.id] }]);
  return { lead, dev, check, red: rt, tm };
}
// 요청 → 카드 → (목표를 신호어가 든 것으로 고쳐서) 확인. cross: 카드의 교차 검수 스위치(카드에 그 칸이 있을 때만 보낸다. 값을 undefined 로 주면 옛 화면처럼 안 보낸다. 안 주면 켬)
async function goal(teamId, signal = '', opts = {}) {
  const { before = null, extra = {} } = opts;
  const cross = 'cross' in opts ? opts.cross : true;
  const sid = await mkSession(teamId);
  await say(sid, '정리해 줘');
  await waitDraft(sid);
  const c = cardOf(sid);
  if (before) await before(sid, c);
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const body = { missionId: S(sid).mission.id, expected: shown(c), review, ...(cross !== undefined && c.cross ? { cross: { on: cross, secondId: c.cross.secondId } } : {}), ...(signal ? { edited: { ...shown(c), goal: `${signal} 목표` } } : {}), ...extra };
  const r = await confirm(sid, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return sid;
}

// ── 순수 함수 ──
test('1. 근거 판정(hasEvidence) 표: 파일 위치(유니코드 이름도)·http 주소·명령 같은 백틱·긴 인용·종료 코드의 꼴만 근거다. 판정 낱말·짧은 인용·문장 사이 점은 아니다', () => {
  // [글, 근거인가, 까닭]
  const rows = [
    ['src/app.js:3 에서 빈 입력이면 깨져', true, '폴더/파일:줄'], ['app.js:12', true, '파일:줄'], ['main.c:3', true, '한 글자 확장자도 이름이 길면'], ['docs/a.md#L4 의 표', true, '파일#L줄'],
    ['파일.js:7 에서', true, '한글 파일 이름:줄'], ['폴더/파일.js 를 열어 봄', true, '한글 경로'], ['C:\\작업\\app.js 를 열어 봄', true, '역슬래시 한글 경로'], ['server/mission.js 를 열어 봄', true, '폴더/파일'],
    ['README.MD:3', true, '대문자 확장자'], ['https://example.com/x 에 없음', true, 'https 주소'], ['`npm test` 가 실패', true, '공백 든 명령'], ['`foo()` 가 없음', true, '괄호 든 코드'],
    ['exit code 1', true, '종료 코드'], ['종료 코드 2 로 끝남', true, '한국어 종료 코드'], ['"Expected 200 but got 500" 이 나옴', true, '열두 글자 넘는 인용'], ['「入力が空ならエラーを返さない」', true, '긴 낫표 인용'],
    ['`ok`', false, '판정 낱말 백틱'], ['`c1`', false, '기준 id 백틱'], ['`a` and `b`', false, '백틱 두 개 사이 글'], ['`c1 fail`', false, 'id 와 판정 낱말뿐'], ['`abc`', false, '명령 꼴 글자 없음'],
    ['"fail"', false, '판정 낱말 인용'], ['the "Save" button', false, '짧은 인용'], ['"c1 pass ok yes no true"', false, '판정 낱말만 든 긴 인용'], ['「테스트 실패」라고 나옴', false, '짧은 낫표 인용'],
    ['출력 "1 failing" 이 나왔어', false, '열두 글자 아래 인용'], ['e.g:1', false, '낱말 줄임 뒤 쌍점'], ['input/output.Then', false, '문장 사이 점'], ['Node.js/npm.It', false, '문장 사이 점'],
    ['www.example.com', false, 'http 로 시작하지 않는 주소'], ['왠지 기준에 안 맞아 보여', false, '설명뿐'], ['app.js 를 봤어', false, '파일 이름만'], ['v1.2 가 맞아', false, '판 번호'], ['i.e. 별로야', false, '낱말 줄임'],
    ['', false, '빈 글'], ['   ', false, '공백'], [null, false, '없음'], [undefined, false, '없음'],
  ];
  for (const [s, want, why] of rows) assert.equal(hasEvidence(s), want, `${String(s)} — ${why}`);
});

test('2. 합치기(mergeReviews): 둘 다 합격 = 합격, 근거 있는 불합격 = 불합격, 근거 없는 불합격 = 엇갈림, 빼먹음·깨짐 = 다른 쪽 + 한 명만 봄', () => {
  const E = '깨지는 경우 src/app.js:3';
  const N = '왠지 안 맞아';
  const r = (verdict, evidence = '') => ({ id: 'c1', verdict, evidence });
  const side = (x) => (x === null ? null : x === 'omit' ? { results: [{ id: 'c1', verdict: 'unknown', evidence: '' }], omitted: ['c1'] } : { results: [x], omitted: [] });
  const one = (a, b) => { const [m] = mergeReviews(['c1'], side(a), side(b)); return [m.verdict, m.evidence, !!m.split, m.one || '']; };
  assert.deepEqual(one(r('pass', 'a 근거'), r('pass', 'b 근거')), ['pass', 'a 근거', false, '']);
  assert.deepEqual(one(r('fail', E), r('pass', 'b')), ['fail', E, false, '']);
  assert.deepEqual(one(r('pass', 'a'), r('fail', E)), ['fail', E, false, ''], '레드팀의 근거 있는 불합격');
  assert.deepEqual(one(r('fail', E), r('fail', N)), ['fail', E, false, '']);
  assert.deepEqual(one(r('fail', N), r('fail', E)), ['fail', E, false, '']);
  assert.deepEqual(one(r('pass', 'a'), r('fail', N)), ['unknown', N, true, ''], '한쪽만 근거 없는 불합격 = 엇갈림');
  assert.deepEqual(one(r('fail', N), r('pass', 'b')), ['unknown', N, true, '']);
  assert.deepEqual(one(r('fail', N), r('fail', N)), ['unknown', N, true, ''], '둘 다 근거 없는 불합격도 사람에게');
  assert.deepEqual(one(r('unknown', 'u'), r('fail', N)), ['unknown', N, true, '']);
  assert.deepEqual(one(r('pass', 'a'), r('unknown', '못 봄')), ['unknown', '못 봄', false, ''], '둘 다 합격이 아니면 합격이 아니다');
  assert.deepEqual(one(r('unknown', ''), r('pass', 'b')), ['unknown', 'b', false, '']);
  assert.deepEqual(one(r('unknown', ''), r('unknown', '')), ['unknown', '', false, '']);
  // 한쪽이 빼먹음·블록이 깨짐: 다른 쪽 판정 그대로(근거 없는 불합격도 불합격, 한 명 검수와 같다) + 한 명만 봄
  assert.deepEqual(one('omit', r('fail', N)), ['fail', N, false, 'b']);
  assert.deepEqual(one(r('pass', 'a'), 'omit'), ['pass', 'a', false, 'a']);
  assert.deepEqual(one(r('pass', 'a'), null), ['pass', 'a', false, 'a']);
  assert.deepEqual(one(null, r('unknown', 'x')), ['unknown', 'x', false, 'b']);
  assert.deepEqual(one('omit', 'omit'), ['unknown', '', false, '']);
  // 두 검수자의 판정이 기준마다 그대로 남는다(판정 카드에 나란히)
  const [m] = mergeReviews(['c1'], side(r('pass', 'a')), side(r('fail', N)));
  assert.deepEqual([m.a, m.b], [{ verdict: 'pass', evidence: 'a' }, { verdict: 'fail', evidence: N }]);
  // 엇갈린 모양(판정 카드의 설명 줄): 한쪽 합격 · 둘 다 근거 없는 불합격 · 다른 쪽 확인 못 함
  const why = (a, b) => mergeReviews(['c1'], side(a), side(b))[0].splitWhy;
  assert.deepEqual([why(r('pass', 'a'), r('fail', N)), why(r('fail', N), r('pass', 'b')), why(r('fail', N), r('fail', N)), why(r('unknown', 'u'), r('fail', N)), why(r('fail', N), r('unknown', ''))], ['pass', 'pass', 'both', 'unknown', 'unknown']);
  assert.equal(why(r('pass', 'a'), r('fail', E)), undefined, '엇갈림이 아니면 없다');
});

test('3. 둘째 검수자 고르기(crossPlan): 진행자·첫째가 아닌 로그인된 팀원. 일을 안 하는(검수 역할) 사람 먼저, 그다음 다른 회사 AI', () => {
  const A = [{ id: 'l', role: '분석', provider: 'claude' }, { id: 'd', role: '개발', provider: 'claude' }, { id: 'r', role: '검수', provider: 'claude' }, { id: 'r2', role: '검수', provider: 'claude' },
    { id: 'x', role: '개발', provider: 'codex' }, { id: 'q', role: '검수', provider: 'codex' }, { id: 'au', role: '검수', routing: 'auto' }];
  const T = (...stages) => ({ stages: stages.map((x) => ({ agentIds: x })) });
  const o = { leadId: 'l', reviewerId: 'r' };
  assert.deepEqual(crossPlan(T(['l'], ['d'], ['r', 'r2']), A, o), { secondId: 'r2', why: '', sameAi: true, worked: false });
  assert.deepEqual(crossPlan(T(['l'], ['d'], ['r', 'r2', 'q']), A, o), { secondId: 'q', why: '', sameAi: false, worked: false }, '같은 검수 역할이면 다른 회사 AI');
  assert.equal(crossPlan(T(['l'], ['d', 'x'], ['r']), A, o).secondId, 'x', '둘 다 일한 사람이면 다른 회사 AI');
  assert.equal(crossPlan(T(['l'], ['x'], ['r', 'r2']), A, o).secondId, 'r2', '일을 안 한 사람이 다른 회사 AI 보다 먼저');
  assert.deepEqual(crossPlan(T(['l'], ['d'], ['r']), A, o), { secondId: 'd', why: '', sameAi: true, worked: true }, '한 명뿐이면 일한 사람이라도(그렇다고 알린다)');
  assert.equal(crossPlan(T(['l'], ['d', 'r2'], ['r', 'r2']), A, o).worked, true, '검수 역할이어도 일 단계에 같이 있으면 일한 사람');
  assert.equal(crossPlan(T(['l'], ['au', 'q'], ['r']), A, o).secondId, 'q', '자동 라우팅은 회사를 몰라서 같은 회사로 친다');
  assert.deepEqual(crossPlan(T(['l'], ['r']), A, o), { secondId: null, why: 'few', sameAi: false, worked: false }, '진행자·첫째 말고 없음');
  assert.deepEqual(crossPlan(T(['l'], ['d'], ['r']), A, { ...o, usable: () => false }), { secondId: null, why: 'signin', sameAi: false, worked: false });
  assert.equal(crossPlan(T(['l'], ['d', 'q'], ['r']), A, { ...o, usable: (a) => a.provider === 'claude' }).secondId, 'd', '로그인 안 된 AI 는 빼고');
  assert.deepEqual(crossPlan(T(['l']), A, { leadId: 'l', reviewerId: null }), { secondId: null, why: 'none', sameAi: false, worked: false });
  assert.equal(crossPlan(T(['l'], ['gone'], ['r']), A, o).why, 'few', '지워진 에이전트는 없는 것으로');
});

test('4. 어림: 교차 검수를 켜면 검수마다 +1(자동 되돌림의 다시 검수 포함), 끄면 그대로', () => {
  const A = [{ id: 'l', role: '분석' }, { id: 'd', role: '개발' }, { id: 'r', role: '검수' }];
  const T = { stages: [{ agentIds: ['l'] }, { agentIds: ['d'] }, { agentIds: ['r'] }] };
  const parts = estimateParts(T, A, { lead: 'l', spent: 1 });
  assert.equal(parts.cross, 1, '검수자가 있으면 둘째 검수 몫 1');
  assert.equal(estimateParts({ stages: [{ agentIds: ['l'] }] }, A, { lead: 'l' }).cross, 0);
  const off = estimateCalls(T, A, { lead: 'l', spent: 1 });
  const on = estimateCalls(T, A, { lead: 'l', spent: 1, cross: true });
  assert.deepEqual([on.min - off.min, on.max - off.max], [1, 1 + RETURN_CAP]);
  assert.deepEqual(sumEstimate(parts, { cross: false }), sumEstimate(parts, {}), '끄면 지금과 같다');
  assert.deepEqual(sumEstimate(parts, { cross: true }), on);
  const m = { reviewerId: 'r', returns: 0, returnCap: 1, cards: [{ id: 'k1', ownerId: 'd', kind: 'build', needs: [], files: ['a.js'] }] };
  const p0 = planEstimate(m);
  const p1 = planEstimate({ ...m, cross: { on: true, secondId: 'l' } });
  assert.deepEqual([p1.min - p0.min, p1.max - p0.max], [1, 2]);
});

test('5. 판정 카드 값(cleanPicks·applyPicks), 보류는 되돌림에서 빠지고, 사용자 사유는 되돌림 프롬프트에 표식 밖 사용자 글로', () => {
  assert.deepEqual(cleanPicks({ c1: { pick: 'fix', note: ' 꼭\n고쳐 ' }, c2: 'fold' }, ['c1', 'c2']), { picks: { c1: { pick: 'fix', note: '꼭 고쳐' }, c2: { pick: 'fold' } } });
  assert.equal(cleanPicks({ c1: 'fix' }, ['c1', 'c2']).error, 'missing');
  assert.equal(cleanPicks({ c1: 'yes' }, ['c1']).error, 'missing');
  assert.equal(cleanPicks({ c1: 'fix', c9: 'fold' }, ['c1']).error, 'unknown');
  assert.equal(cleanPicks(null, ['c1']).error, 'shape');
  assert.equal(cleanPicks(['fix'], ['c1']).error, 'shape');
  assert.equal(cleanPicks({ c1: { pick: 'hold', note: '가'.repeat(300) } }, ['c1']).picks.c1.note.length, 200);
  const items = mergeReviews(['c1', 'c2', 'c3'], { results: [{ id: 'c1', verdict: 'pass', evidence: 'a1' }, { id: 'c2', verdict: 'fail', evidence: '왠지' }, { id: 'c3', verdict: 'pass', evidence: 'a3' }], omitted: [] },
    { results: [{ id: 'c1', verdict: 'fail', evidence: '느낌상' }, { id: 'c2', verdict: 'pass', evidence: 'b2' }, { id: 'c3', verdict: 'fail', evidence: '모르겠어' }], omitted: [] });
  assert.deepEqual(items.map((x) => !!x.split), [true, true, true]);
  const done = applyPicks(items, { c1: { pick: 'fix', note: '<b>꼭</b>' }, c2: { pick: 'fold' }, c3: { pick: 'hold' } });
  assert.deepEqual(done.map((x) => [x.verdict, x.evidence, x.user]), [['fail', '느낌상', { pick: 'fix', note: '<b>꼭</b>' }], ['pass', 'b2', { pick: 'fold' }], ['unknown', '모르겠어', { pick: 'hold' }]]);
  const m = { ...newMission({}), criteria: [{ id: 'c1', text: 'A', status: 'open', evidence: '' }, { id: 'c2', text: 'B', status: 'open', evidence: '' }, { id: 'c3', text: 'C', status: 'open', evidence: '' }] };
  applyReview(m, done);
  assert.deepEqual(m.criteria.map((c) => [c.status, c.user?.pick || '']), [['fail', 'fix'], ['pass', 'fold'], ['unknown', 'hold']]);
  assert.deepEqual(returnItems(m), [{ id: 'c1', text: 'A', status: 'fail', evidence: '느낌상', note: '<b>꼭</b>' }], '보류는 이번엔 넘긴다');
  const p = returnPrompt(returnItems(m), 'MK');
  const end = p.indexOf('--- 검수 MK 끝 ---');
  assert.ok(end > 0 && p.indexOf('사용자의 사유') > end, '사유는 표식 밖');
  assert.ok(p.includes('[판정 카드에서 사용자가 정한 것 — 사용자 글]\n- c1 사용자의 사유: ＜b＞꼭＜/b＞'), p);
  assert.ok(!p.slice(0, end).includes('꼭'), '사용자 글은 검수자 글(표식 안)과 섞이지 않는다');
  // 다음 회차 판정은 표시를 지운다
  applyReview(m, [{ id: 'c1', verdict: 'pass', evidence: 'x', one: 'a' }]);
  assert.deepEqual(m.criteria.map((c) => [c.status, c.user || null, c.one || '']), [['pass', null, 'a'], ['unknown', null, ''], ['unknown', null, '']]);
});

test('6. 검수 프롬프트: 레드팀은 레드팀 문장 하나만 다르고, 검증(그리고 교차 검수를 끈 한 명 검수)은 지금 그대로', () => {
  const o = { goal: 'g', criteria: [{ id: 'c1', text: 'A' }], cwd: '/w', round: 1, works: [], readOnly: true, nonce: 'n'.repeat(16), mark: 'MARK' };
  const base = reviewPrompt(o);
  const red = reviewPrompt({ ...o, role: 'red' });
  assert.equal(reviewPrompt({ ...o, role: '' }), base);
  assert.ok(!base.includes('레드팀'));
  assert.ok(red.includes('너는 이 목표의 레드팀 검수자야.') && !red.includes('너는 이 목표의 검수자야.'), red.slice(0, 200));
  assert.equal(red.replace(/너는 이 목표의 레드팀 검수자야\.[^\n]*/, 'X'), base.replace(/너는 이 목표의 검수자야\.[^\n]*/, 'X'), '나머지(판정 규칙·블록 형식)는 같다');
});

// ── 실제 실행(가짜 CLI) ──
test('7. 둘 다 합격: 두 검수자가 동시에 한 번 실행·읽기 전용(edit 에이전트도 plan)으로 돌고 서로의 글을 못 본다 → done. 호출·종류·보고·내보내기·흐름도', async () => {
  await app();
  const x = await crossTeam('합격');
  const sid0 = await mkSession(x.tm.id);
  await say(sid0, '정리해 줘');
  await waitDraft(sid0);
  const c = cardOf(sid0);
  assert.deepEqual(c.cross, { can: true, on: false, secondId: x.red.id, secondName: x.red.name, ai: 'Claude · claude-sonnet-5-5', sameAi: true, worked: false, why: '' }, '팀 기본값이 없으면 꺼짐');
  await ctl(sid0, 'stop');
  const from = t.fakeLog().length;
  const sid = await goal(x.tm.id, 'SLOW SECRETS');
  await waitEnd(sid);
  const s = S(sid);
  const m = s.mission;
  assert.deepEqual([m.status, m.round, m.calls.used, m.cross], ['done', 1, 5, { on: true, secondId: x.red.id }], '목표 1 + 일 2 + 검수 2');
  assert.deepEqual(s.runs.at(-1).stages.map((st) => [st.label, st.agentIds]), [['분석', [x.lead.id]], ['개발', [x.dev.id]], ['기준 판정', [x.check.id, x.red.id]]]);
  const [a, b] = ['check', 'red'].map((role) => reviewMsgs(sid).find((r) => r.review.role === role));
  assert.ok(a && b && a.agentId === x.check.id && b.agentId === x.red.id);
  assert.ok(Math.abs(a.createdAt - b.createdAt) < 1000 && a.usage.durationMs >= 1400 && b.usage.durationMs >= 1400, '동시에 돈다(각자 1.5초 걸림)');
  assert.deepEqual([answerKind(a), answerKind(b)], ['review', 'cross']);
  assert.deepEqual(m.criteria.map((cr) => [cr.status, cr.one || '']), [['pass', ''], ['pass', '']]);
  // 읽기 전용: 저장된 권한은 edit 인데 두 검수 CLI 모두 plan 으로 떴고, 프롬프트 앞머리와 검수 프롬프트가 읽기 전용이라고 말한다
  const rp = reviewProcs(from);
  assert.equal(rp.length, 2);
  for (const p of rp) {
    assert.deepEqual(p.args.slice(p.args.indexOf('--permission-mode'), p.args.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan'], JSON.stringify(p.args));
    assert.ok(!p.args.includes('--resume'), '새 대화');
    assert.ok(p.texts[0].startsWith('권한: 이번 차례는 읽기 전용이야.'), p.texts[0].slice(0, 80));
    assert.ok(promptBody(p.texts[0]).includes('권한: 읽기 전용이라 명령은 못 돌려.'));
  }
  assert.equal(x.check.permission, 'edit');
  assert.equal(t.app.store.get('agents', x.red.id).permission, 'edit', '저장된 권한은 그대로');
  const redText = rp.map((p) => p.texts[0]).filter((p) => p.includes('레드팀 검수자'));
  assert.equal(redText.length, 1, '레드팀 문장은 레드팀에게만');
  for (const p of rp) assert.ok(!/(?:CHECK|RED)SECRET/.test(p.texts.join('\n')), '서로의 답을 프롬프트에서 못 본다');
  // 진행 기록: 검수자별 판정 수와 합친 결과
  assert.ok(m.log.some((l) => l.kind === 'cross' && l.text.startsWith('교차 검수 1회차:') && l.text.includes('합친 결과 통과 2')), JSON.stringify(m.log.map((l) => l.text)));
  assert.ok(m.log.some((l) => l.kind === 'confirm' && l.text.includes('교차 검수') && l.by === 'user'));
  // 완주 보고·내보내기·흐름도
  const rep = s.messages.find((x2) => x2.kind === 'report');
  assert.deepEqual([rep.answers.review, rep.answers.cross], [1, 1]);
  assert.deepEqual(rep.cross, { a: x.check.name, b: x.red.name, rounds: 1, single: 0, splits: 0, picks: { fix: 0, fold: 0, hold: 0 }, held: [], one: [] });
  assert.ok(crossWords((k, v) => k.replace(/\{(\w+)\}/g, (_, n) => v?.[n]), rep.cross).length > 0);
  const out = exportRun({ s, m, nameOf: (id) => t.app.store.get('agents', id)?.name || id });
  assert.deepEqual(out.goal.reviewer2, { id: x.red.id, name: x.red.name });
  assert.deepEqual(out.calls.filter((k) => k.kind === 'cross').length, 1);
  assert.equal(out.crossLog.length, 1);
  const fm = flowModel({ mission: m, runs: s.runs, messages: s.messages, nameOf: (id) => t.app.store.get('agents', id)?.name || id });
  const red = fm.nodes.find((n) => n.id === 'review:red');
  assert.ok(red && red.who === x.red.name && red.state === 'done' && red.msgId === b.id, JSON.stringify(red));
  assert.ok(fm.edges.some((e) => e.from === 'review' && e.to === 'review:red'));
  assert.ok(!fm.nodes.some((n) => n.id === 'split'), '판정 카드가 없었다');
});

test('8. 근거 있는 불합격: 레드팀이 확인할 수 있는 근거로 불합격 → 카드 없이 자동 되돌림 → 다시 둘이 검수 → done', async () => {
  await app();
  const x = await crossTeam('근거');
  const from = t.fakeLog().length;
  const sid = await goal(x.tm.id, 'REDFAILEV1');
  await waitEnd(sid);
  const m = S(sid).mission;
  assert.deepEqual([m.status, m.round, m.returns, m.calls.used], ['done', 2, 1, 8], '목표 1 + 일 2 + 검수 2 + 되돌림 1 + 검수 2');
  assert.ok(!S(sid).runs.at(-1).hold && !m.log.some((l) => l.kind === 'ask'), '묻지 않았다');
  const back = procs(from).flatMap((p) => p.texts).find((p) => p.includes('[지난 검수에서 걸린 것'));
  assert.ok(back.includes('- c1 (불합격): 가짜 기준 1\n  판정 근거: 가짜: 빈 입력이면 깨져 src/app.js:3'), back.slice(back.indexOf('[지난 검수'), back.indexOf('[지난 검수') + 400));
  assert.equal(m.crossLog.length, 2);
  assert.deepEqual(m.crossLog[0].splits, []);
});

test('9. 엇갈림 → 판정 카드: 다른 대기의 제어·틀린 값은 거절, 같은 확정 두 번은 한 번만, 고치기(사유는 사용자 글) → 되돌림 → 다시 엇갈림 → 접기 → done', async () => {
  await app();
  const x = await crossTeam('엇갈');
  const from = t.fakeLog().length;
  const sid = await goal(x.tm.id, 'REDFAILNOEV SECRETS');
  const run = await waitHold(sid, 'mission', 'split');
  const h = run.hold;
  assert.equal(h.round, 1);
  assert.deepEqual(h.names, { a: x.check.name, b: x.red.name });
  assert.deepEqual(h.items.map((i) => [i.id, !!i.split, i.a.verdict, i.b.verdict, i.splitWhy]), [['c1', true, 'pass', 'fail', 'pass'], ['c2', false, 'pass', 'pass', undefined]], '엇갈린 모양(카드의 설명 줄)');
  assert.equal(h.items[1].verdict, 'pass');
  const m = S(sid).mission;
  assert.deepEqual([m.status, m.at.wait, m.split?.round], ['waiting', { reason: 'mission', kind: 'split' }, 1]);
  assert.equal(attentionOf(run).kind, 'verdict', '사이드바·알림은 목표 판정');
  // 이 대기가 받지 않는 제어
  for (const a of ['accept', 'more', 'later', 'retry', 'skip', 'approve']) assert.equal((await ctl(sid, a)).json.ok, false, a);
  assert.equal((await ctl(sid, 'raise', { to: x.dev.id })).json.ok, false);
  // 틀린 값: 엇갈린 기준을 다 정하지 않음·모르는 값·모르는 기준·틀린 회차
  assert.equal((await ctl(sid, 'judge', { round: 1, picks: {} })).status, 400);
  assert.equal((await ctl(sid, 'judge', { round: 1, picks: { c1: 'yes' } })).status, 400);
  assert.equal((await ctl(sid, 'judge', { round: 1, picks: { c1: 'fix', c2: 'fold' } })).status, 400, '엇갈리지 않은 기준은 정하지 않는다');
  assert.equal((await ctl(sid, 'judge', { round: 2, picks: { c1: 'fix' } })).json.ok, false, '다른 회차의 카드');
  assert.equal((await ctl(sid, 'judge', { picks: { c1: 'fix' } })).json.ok, false, '회차 없음');
  assert.equal(S(sid).runs.at(-1).hold?.kind, 'split', '거절한 동안 카드는 그대로');
  // 같은 확정을 두 번(동시에): 한 번만 반영
  const body = { round: 1, picks: { c1: { pick: 'fix', note: '빈 입력 <b>꼭</b> 봐' } } };
  const two = await Promise.all([ctl(sid, 'judge', body), ctl(sid, 'judge', body)]);
  assert.deepEqual(two.map((r) => r.json.ok).sort(), [false, true]);
  // 고치기 → c1 불합격 → 자동 되돌림(사유는 표식 밖) → 2회차 다시 엇갈림 → 카드
  const run2 = await t.waitFor(() => { const r = S(sid).runs.at(-1); return r?.hold?.kind === 'split' && r.hold.round === 2 && r; }, 40000, '2회차 카드');
  assert.equal(S(sid).mission.log.filter((l) => l.kind === 'answer' && l.text.startsWith('판정 카드에서 정했어')).length, 1, '한 번만 반영');
  const back = procs(from).flatMap((p) => p.texts).find((p) => p.includes('[지난 검수에서 걸린 것'));
  const mk = back.match(/--- 검수 ([0-9a-f]{8}) 끝 ---/)[1];
  assert.ok(back.includes(`--- 검수 ${mk} 시작 ---\n- c1 (불합격): 가짜 기준 1\n  판정 근거: 가짜: 왠지 기준에 안 맞아 보여\n--- 검수 ${mk} 끝 ---\n[판정 카드에서 사용자가 정한 것 — 사용자 글]\n- c1 사용자의 사유: 빈 입력 ＜b＞꼭＜/b＞ 봐`), back.slice(back.indexOf('[지난 검수'), back.indexOf('[지난 검수') + 600));
  // 2회차 검수자들도 1회차 검수 답(서로의 것·자기 것)을 프롬프트에서 못 본다
  const round2 = reviewProcs(from).filter((p) => p.texts.some((q) => q.includes('[기준 판정 — 2번째 검수]')));
  assert.equal(round2.length, 2);
  for (const p of round2) assert.ok(!/(?:CHECK|RED)SECRET/.test(p.texts.join('\n')));
  assert.equal(run2.hold.items[0].split, true);
  assert.equal((await ctl(sid, 'judge', { round: 2, picks: { c1: 'fold' } })).json.ok, true);
  await waitEnd(sid);
  const m2 = S(sid).mission;
  assert.deepEqual([m2.status, m2.round, m2.returns, m2.calls.used, m2.criteria[0].status, m2.criteria[0].user], ['done', 2, 1, 8, 'pass', { pick: 'fold' }]);
  assert.ok(m2.criteria[0].evidence.startsWith('가짜 확인'), '접기는 합격 쪽 근거');
  assert.equal(m2.split, undefined, '카드 값은 반영 뒤 지운다');
  // 고른 것과 사용자가 쓴 사유는 줄을 나눈다(사유 줄은 typed: 본문을 뺀 내보내기에서 글을 뺀다)
  assert.deepEqual(m2.log.filter((l) => l.kind === 'answer' && l.by === 'user' && l.text.startsWith('판정 카드')).map((l) => [l.text, !!l.typed]),
    [['판정 카드에서 정했어: c1 불합격으로 고치기', false], ['판정 카드에 쓴 사유: c1 — 빈 입력 <b>꼭</b> 봐', true], ['판정 카드에서 정했어: c1 합격으로 접기', false]]);
  // 본문을 뺀 내보내기(결정 0030): 사유 줄은 글 없이 종류만, 완주 보고의 "사용자가 확정한 것"에서도 뺀다. 본문을 넣으면 그대로
  const noBody = exportRun({ s: S(sid), m: m2 });
  assert.ok(!JSON.stringify(noBody).includes('빈 입력'), '사유 글이 나가지 않는다');
  assert.ok(noBody.log.some((l) => l.kind === 'answer' && l.textOmitted && l.by === 'user'));
  assert.ok(noBody.log.some((l) => l.text === '판정 카드에서 정했어: c1 불합격으로 고치기'), '고른 것(사용자가 정한 사실)은 그대로');
  assert.ok(noBody.report.user.some((u) => u.textOmitted) && !noBody.report.user.some((u) => String(u.text || '').includes('빈 입력')));
  assert.ok(noBody.notes.omitted.includes('judgment card reasons'));
  assert.ok(JSON.stringify(exportRun({ s: S(sid), m: m2, body: true })).includes('빈 입력'), '본문을 넣으면 사유도');
  const rep = S(sid).messages.find((y) => y.kind === 'report');
  assert.deepEqual([rep.cross.splits, rep.cross.picks], [2, { fix: 1, fold: 1, hold: 0 }]);
  const fm = flowModel({ mission: m2, runs: S(sid).runs, messages: S(sid).messages });
  assert.equal(fm.nodes.find((n) => n.id === 'split')?.state, 'done');
});

test('10. 보류: 그 기준은 이번엔 넘기고(되돌리지 않고) 판정 뒤 묻기로 → 받아들이기 → accepted, 보고에 보류. 판정 대기에 판정 카드 제어는 거절', async () => {
  await app();
  const x = await crossTeam('보류');
  const sid = await goal(x.tm.id, 'REDFAILNOEV');
  await waitHold(sid, 'mission', 'split');
  assert.equal((await ctl(sid, 'judge', { round: 1, picks: { c1: { pick: 'hold', note: '다음에' } } })).json.ok, true);
  const run = await waitHold(sid, 'mission', 'verdict');
  assert.deepEqual(run.hold.left.map((c) => [c.id, c.user]), [['c1', { pick: 'hold', note: '다음에' }]], '남은 기준 줄에 사용자가 정한 것');
  assert.equal(S(sid).mission.split, undefined, '판정 카드 값은 반영하면서 지운다(목표가 끝나기 전에)');
  // 되돌릴 기준이 없다(보류만 남음): "한 번 더"를 내지 않는다(받아들이기·그만만). 눌러도 안 듣는다
  assert.deepEqual([run.hold.more, run.hold.noReturn], [false, true]);
  assert.equal((await ctl(sid, 'more')).json.ok, false, '한 번 더는 안 듣는다');
  assert.equal((await ctl(sid, 'judge', { round: 1, picks: { c1: 'fix' } })).json.ok, false, '판정 뒤 묻기에는 판정 카드 제어가 안 듣는다');
  assert.equal((await ctl(sid, 'accept')).json.ok, true);
  await waitEnd(sid);
  const m = S(sid).mission;
  assert.deepEqual([m.status, m.returns, m.calls.used, m.criteria[0].status, m.criteria[0].user], ['accepted', 0, 5, 'unknown', { pick: 'hold', note: '다음에' }]);
  const rep = S(sid).messages.find((y) => y.kind === 'report');
  assert.deepEqual([rep.cross.held, rep.cross.picks.hold], [['c1'], 1]);
});

test('11. 한쪽만 판정: 레드팀 블록이 두 번 다 깨짐(그 기준은 검증 판정 + 한 명만 봄), 레드팀이 기준을 빼먹음, 레드팀 오류', async () => {
  await app();
  const x = await crossTeam('한쪽');
  const sid = await goal(x.tm.id, 'REDBAD');
  await waitEnd(sid);
  let m = S(sid).mission;
  assert.deepEqual([m.status, m.calls.used, m.criteria.map((c) => [c.status, c.one])], ['done', 6, [['pass', 'a'], ['pass', 'a']]], '레드팀은 형식을 한 번 더 받았다');
  assert.ok(m.log.some((l) => l.kind === 'cross' && l.fail === 'hole' && l.text.includes(x.red.name) && l.text.includes('판정 블록을 받지 못했어')), JSON.stringify(m.log.filter((l) => l.kind === 'cross')));
  assert.deepEqual(S(sid).messages.find((y) => y.kind === 'report').cross.one, ['c1', 'c2']);
  const o = await goal(x.tm.id, 'REDOMIT');
  await waitEnd(o);
  m = S(o).mission;
  assert.deepEqual(m.criteria.map((c) => [c.status, c.one || '']), [['pass', ''], ['pass', 'a']]);
  assert.ok(m.log.some((l) => l.kind === 'cross' && l.text === '한 명만 본 기준: c2'));
  const e = await goal(x.tm.id, 'REDERR');
  await waitEnd(e);
  m = S(e).mission;
  assert.deepEqual([m.status, m.criteria.map((c) => c.one)], ['done', ['a', 'a']]);
  assert.ok(m.log.some((l) => l.kind === 'cross' && l.fail === 'unknown'));
});

test('12. 둘 다 깨짐: 지금의 검수 실패 처리 그대로(판정 없음·구멍) → 판정 없이 묻기', async () => {
  await app();
  const x = await crossTeam('둘깨');
  const sid = await goal(x.tm.id, 'CHECKBROKEN REDBAD');
  const run = await waitHold(sid, 'mission', 'verdict');
  const m = S(sid).mission;
  assert.deepEqual([m.round, m.calls.used, m.criteria.map((c) => c.status)], [1, 7, ['unknown', 'unknown']]);
  assert.ok(m.log.some((l) => l.kind === 'review' && l.fail === 'hole' && l.text === '검수 1회차: 판정 블록을 받지 못해서 판정 없이 끝남'));
  assert.equal(run.hold.left.length, 2);
  await ctl(sid, 'stop');
  await waitEnd(sid);
});

test('13. 둘째 검수자 없음: 카드에서 못 켬(까닭), 그래도 켜서 보내면 409 와 지금 값. 로그인이 풀리면 한 명 검수로 가고 진행 기록에 까닭', async () => {
  await app();
  const lead = await mk('없음분석', '분석');
  const dev = await mk('없음개발', '개발');
  const chk = await mk('없음검수', '검수');
  const tm = await mkTeam('없음팀', [{ label: '분석', agentIds: [lead.id] }, { label: '검수', agentIds: [chk.id] }]);
  const sid = await mkSession(tm.id);
  await say(sid, '정리해 줘');
  await waitDraft(sid);
  const c = cardOf(sid);
  assert.deepEqual([c.cross.can, c.cross.why, c.cross.secondId], [false, 'few', null]);
  const body = { missionId: S(sid).mission.id, expected: shown(c), review: { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) } };
  const bad = await confirm(sid, { ...body, cross: { on: true, secondId: dev.id } });
  assert.equal(bad.status, 409);
  assert.deepEqual(Object.keys(bad.json).sort(), ['cross', 'error', 'estimate']);
  assert.equal(bad.json.cross.can, false);
  assert.equal((await confirm(sid, { ...body, cross: { on: false, secondId: null } })).status, 200);
  await waitEnd(sid);
  assert.deepEqual([S(sid).mission.status, S(sid).mission.cross, S(sid).mission.calls.used], ['done', undefined, 3]);
  // 로그인 안 됨: 둘째 후보(Codex)가 로그인돼 있지 않으면 카드에서 못 켠다
  const cx = await crossTeam('로그', { red: { provider: 'codex', model: 'gpt-6.1-sol' } });
  login({ codex: false });
  try {
    const s2 = await mkSession(cx.tm.id);
    await say(s2, '정리해 줘');
    await waitDraft(s2);
    assert.deepEqual([cardOf(s2).cross.can, cardOf(s2).cross.why], [true, ''], '같은 팀의 개발 담당(Claude)이 남는다');
    assert.equal(cardOf(s2).cross.secondId, cx.dev.id);
  } finally { login(); }
  // 실행 중에 둘째의 로그인이 풀림: 그 회차는 한 명 검수, 진행 기록에 까닭
  const s3 = await goal(cx.tm.id, 'SLOW');
  assert.equal(S(s3).mission.cross.secondId, cx.red.id);
  login({ codex: false });
  try {
    await waitEnd(s3);
  } finally { login(); }
  const m = S(s3).mission;
  assert.deepEqual([m.status, m.calls.used, reviewMsgs(s3).length], ['done', 4, 1]);
  assert.ok(m.log.some((l) => l.kind === 'cross' && l.text.includes('로그인돼 있지 않아')), JSON.stringify(m.log.map((l) => l.text)));
  assert.equal(S(s3).messages.find((y) => y.kind === 'report').cross.single, 1);
});

test('14. 돈: 둘째 검수 앞에서 호출 상한·구독 한도 상한을 보고, 넘으면 묻지 않고 한 명 검수로(진행 기록 한 줄)', async () => {
  await app();
  const x = await crossTeam('상한');
  // 호출: 검수 앞에서 남은 호출이 1번(첫째 몫만)
  const from = t.fakeLog().length;
  const sid = await goal(x.tm.id, '', { before: (id) => { S(id).mission.calls.cap = 4; } });
  await waitEnd(sid);
  let m = S(sid).mission;
  assert.deepEqual([m.status, m.calls.used, m.calls.cap, reviewMsgs(sid).length], ['done', 4, 4, 1]);
  assert.ok(m.log.some((l) => l.kind === 'cross' && l.text.includes('호출 상한')), JSON.stringify(m.log.map((l) => l.text)));
  assert.ok(!m.log.some((l) => l.kind === 'cap'), '상한 질문을 띄우지 않았다');
  // 교차 검수를 켠 목표의 한 명 검수 회차도 카드·기록이 말한 대로 그 실행만 읽기 전용(검수자의 저장된 권한은 edit)
  const [one] = reviewProcs(from);
  assert.deepEqual(one.args.slice(one.args.indexOf('--permission-mode'), one.args.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan']);
  assert.ok(!reviewMsgs(sid)[0].review.role, '한 명 검수 표(역할 표시 없음)');
  // 최악(두 검수자가 형식을 한 번씩 다시 받음 = 4번)보다 남은 호출이 적으면 한 명 검수: 남은 3번이어도
  const s6 = await goal(x.tm.id, '', { before: (id) => { S(id).mission.calls.cap = 6; } });
  await waitEnd(s6);
  assert.deepEqual([S(s6).mission.calls.used, reviewMsgs(s6).length], [4, 1]);
  assert.ok(S(s6).mission.log.some((l) => l.kind === 'cross' && l.text.includes('남은 호출이 3번') && l.text.includes('(4번)')), JSON.stringify(S(s6).mission.log.map((l) => l.text)));
  // 남은 4번이면 둘이 검수
  const s7 = await goal(x.tm.id, '', { before: (id) => { S(id).mission.calls.cap = 7; } });
  await waitEnd(s7);
  assert.deepEqual([S(s7).mission.calls.used, reviewMsgs(s7).length], [5, 2]);
  // 구독 한도 상한: 둘째의 AI(Codex) 창이 상한 이상
  const cx = await crossTeam('한도', { red: { provider: 'codex', model: 'gpt-6.1-sol' } });
  // 92%: 상한(90%) 이상이지만 이어받기 기준(95%) 아래(다른 AI 로 넘기지 않고 그 AI 로 돌 차례)
  const lim = { windows: { five_hour: { pct: 92, resetsAt: Math.floor(Date.now() / 1000) + 3600 } }, observedAt: Date.now() };
  const keep = t.app.store.usage.limits;
  t.app.store.usage.limits = { ...(keep || {}), codex: lim };
  try {
    const s2 = await goal(cx.tm.id);
    await waitEnd(s2);
    m = S(s2).mission;
    assert.deepEqual([m.status, reviewMsgs(s2).length], ['done', 1]);
    assert.ok(m.log.some((l) => l.kind === 'cross' && l.text.includes('구독 한도 상한')), JSON.stringify(m.log.map((l) => l.text)));
    assert.ok(!m.log.some((l) => l.kind === 'limitcap'), '상한 질문을 띄우지 않았다');
  } finally { t.app.store.usage.limits = keep; }
});

test('15. 회귀: 교차 검수를 끄면(스위치 끔·옛 화면) 단계표·호출 수·프롬프트·권한·기록이 지금 그대로', async () => {
  await app();
  const x = await crossTeam('회귀');
  for (const cross of [false, undefined]) {
    const from = t.fakeLog().length;
    const sid = await goal(x.tm.id, '', { cross });
    await waitEnd(sid);
    const s = S(sid);
    const m = s.mission;
    assert.deepEqual([m.status, m.calls.used, m.cross, m.crossLog, m.split], ['done', 4, undefined, undefined, undefined], String(cross));
    assert.deepEqual(s.runs.at(-1).stages.at(-1).agentIds, [x.check.id]);
    const [rv] = reviewMsgs(sid);
    assert.equal(reviewMsgs(sid).length, 1);
    assert.deepEqual(Object.keys(rv.review).sort(), ['missing', 'results', 'round'], '역할 표시 없음');
    const [p] = reviewProcs(from);
    assert.deepEqual(p.args.slice(p.args.indexOf('--permission-mode'), p.args.indexOf('--permission-mode') + 2), ['--permission-mode', 'acceptEdits'], '검수자 자기 권한 그대로');
    const body = promptBody(p.texts[0]);
    assert.ok(body.startsWith('[기준 판정 — 1번째 검수]') && body.includes('필요하면 명령·테스트를 돌려서 확인해도 돼. 파일은 고치지 마.') && !body.includes('레드팀'));
    assert.ok(!m.log.some((l) => l.kind === 'cross' || l.text.includes('교차 검수')), JSON.stringify(m.log.map((l) => l.text)));
    const c = cardOf(sid);
    assert.deepEqual(m.estimate, estimateCalls(t.app.store.get('teams', x.tm.id), t.app.store.all('agents'), { lead: c.leadId, spent: 1 }));
    assert.equal(c.crossChosen, cross === false ? false : undefined);
    const rep = s.messages.find((y) => y.kind === 'report');
    assert.equal(rep.cross, null);
    assert.equal(rep.answers.cross, undefined);
    assert.equal(exportRun({ s, m }).goal.reviewer2, null);
    assert.ok(!flowModel({ mission: m, runs: s.runs, messages: s.messages }).nodes.some((n) => n.id === 'review:red'));
  }
});

test('16. 판정 카드가 뜬 채 끊김 → 이어서: 같은 카드를 AI 호출 없이 다시 띄우고, 고르면 이어 간다', async () => {
  await app();
  const x = await crossTeam('끊김');
  const sid = await goal(x.tm.id, 'REDFAILNOEV');
  const first = (await waitHold(sid, 'mission', 'split')).hold;
  t.app.orch.stopAll();
  await t.waitFor(() => idle(sid), 20000, '실행 정리');
  t.app.orch.closing = false; // 앱을 실제로 닫지는 않았으니 끄는 중 표시를 되돌린다
  assert.equal(S(sid).mission.status, 'waiting', '끄는 중에는 목표 상태를 바꾸지 않는다');
  cutMission(S(sid)); // 다시 켤 때 하는 일(#fixStale)
  assert.equal(S(sid).mission.status, 'cut');
  // 내보내기(결정 0030): 열린 판정 카드(splitOpen. 근거는 에이전트가 쓴 글), 흐름도의 판정 카드는 대기 중
  const ex = exportRun({ s: S(sid), m: S(sid).mission });
  assert.deepEqual([ex.splitOpen?.round, ex.splitOpen?.items.map((i) => [i.id, i.split, i.b?.verdict])], [1, [['c1', true, 'fail'], ['c2', false, 'pass']]]);
  assert.equal(flowModel({ mission: S(sid).mission, runs: S(sid).runs, messages: S(sid).messages }).nodes.find((n) => n.id === 'split')?.state, 'wait');
  const calls = S(sid).mission.calls.used;
  const n = t.fakeLog().length;
  const r = await t.api('POST', `/api/sessions/${sid}/mission/resume`, { missionId: S(sid).mission.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const again = (await waitHold(sid, 'mission', 'split')).hold;
  assert.deepEqual([again.round, again.items, again.names], [first.round, first.items, first.names], '같은 카드');
  assert.deepEqual([t.fakeLog().length, S(sid).mission.calls.used], [n, calls], 'AI 호출 없음');
  assert.ok(S(sid).mission.log.some((l) => l.kind === 'resume' && l.text === '이어서: 끊기기 전에 묻던 질문을 다시 띄워(AI 호출 없음).'));
  assert.equal((await ctl(sid, 'judge', { round: 1, picks: { c1: 'fold' } })).json.ok, true);
  await waitEnd(sid);
  assert.deepEqual([S(sid).mission.status, S(sid).mission.calls.used, S(sid).mission.round], ['done', calls, 1]);
});

test('17. 어림 숫자: 카드의 교차 검수 스위치가 검수 몫을 늘리고, 확인 때 화면 값과 대조한다. 팀 기본값은 카드의 기본 켜짐', async () => {
  await app();
  const x = await crossTeam('어림');
  await t.api('PUT', `/api/teams/${x.tm.id}`, { ...x.tm, crossReview: true });
  assert.equal(t.app.store.get('teams', x.tm.id).crossReview, true, '팀 기본값 저장');
  const sid = await mkSession(x.tm.id);
  await say(sid, '정리해 줘');
  await waitDraft(sid);
  const c = cardOf(sid);
  assert.equal(c.cross.on, true, '팀 기본값이 켜짐이면 카드도 켜짐');
  const pick = { work: 'stages', research: false, meeting: false, kept: [] };
  const off = sumEstimate(c.estimate, pick);
  const on = sumEstimate(c.estimate, { ...pick, cross: true });
  assert.deepEqual([on.min - off.min, on.max - off.max], [1, 1 + RETURN_CAP]);
  const body = { missionId: S(sid).mission.id, expected: shown(c), review: { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) }, work: 'stages' };
  // 꺼짐 값의 어림으로 켜서 보내면 409
  const bad = await confirm(sid, { ...body, cross: { on: true, secondId: c.cross.secondId }, estimate: { min: off.min, max: off.max } });
  assert.equal(bad.status, 409);
  assert.equal((await confirm(sid, { ...body, cross: { on: true, secondId: c.cross.secondId }, estimate: { min: on.min, max: on.max } })).status, 200);
  assert.deepEqual(S(sid).mission.estimate, on);
  await waitEnd(sid);
  assert.ok(S(sid).mission.calls.used >= on.min && S(sid).mission.calls.used <= on.max);
  // 옛 화면(교차 검수 값을 안 보냄)의 확인은 팀 기본값이 켜짐이어도 켜지 않는다(한 명 검수, 지금 그대로)
  const old = await goal(x.tm.id, '', { cross: undefined });
  await waitEnd(old);
  assert.deepEqual([S(old).mission.cross, S(old).runs.at(-1).stages.at(-1).agentIds, reviewMsgs(old).length, cardOf(old).crossChosen], [undefined, [x.check.id], 1, undefined]);
  await t.api('PUT', `/api/teams/${x.tm.id}`, { ...x.tm, crossReview: false });
  assert.equal(t.app.store.get('teams', x.tm.id).crossReview, undefined, '끄면 저장하지 않는다');
});

test('18. 다른 회사 AI 의 레드팀(Codex): 같은 판정 블록으로 판정하고 읽기 전용 샌드박스로 돈다', async () => {
  await app();
  const x = await crossTeam('코덱', { red: { provider: 'codex', model: 'gpt-6.1-sol' } });
  const sid0 = await mkSession(x.tm.id);
  await say(sid0, '정리해 줘');
  await waitDraft(sid0);
  assert.deepEqual([cardOf(sid0).cross.secondId, cardOf(sid0).cross.sameAi], [x.red.id, false]);
  const from = t.fakeLog().length;
  const sid = await goal(x.tm.id, 'CODEXREVIEW REDFAILEV1');
  await waitEnd(sid);
  const m = S(sid).mission;
  assert.deepEqual([m.status, m.round, m.returns], ['done', 2, 1]);
  const cx = t.fakeLog().slice(from).filter((l) => l.cli === 'codex' && l.prompt?.includes('[기준 판정 — '));
  assert.equal(cx.length, 2);
  for (const l of cx) assert.ok(l.args.some((a) => /read-only/.test(a)), JSON.stringify(l.args));
  assert.ok(m.crossLog[0].b === x.red.id);
});

// ── 검토 반영(결정 0032) ──
// 일 단계(개발)가 도는 중에 앱이 꺼진 것처럼 끊는다(SLOW 로 한 차례가 1.5초)
async function cutAtWork(sid) {
  await t.waitFor(() => S(sid).runs.at(-1)?.stages?.[1]?.status === 'running', 30000, '개발 단계 시작');
  t.app.orch.stopAll();
  await t.waitFor(() => idle(sid), 20000, '실행 정리');
  t.app.orch.closing = false;
  cutMission(S(sid));
  assert.equal(S(sid).mission.status, 'cut');
}
const resume = (sid) => t.api('POST', `/api/sessions/${sid}/mission/resume`, { missionId: S(sid).mission.id });
const cutAtCard = async (sid) => {
  await waitHold(sid, 'mission', 'split');
  t.app.orch.stopAll();
  await t.waitFor(() => idle(sid), 20000, '실행 정리');
  t.app.orch.closing = false;
  cutMission(S(sid));
};

test('19. 확인 대조: 카드의 둘째 검수자 id 가 지금 계산과 다르면 409 와 지금 값(반영하지 않음). 둘째가 팀의 일 단계에도 있으면 카드가 알린다', async () => {
  await app();
  const x = await crossTeam('대조');
  const sid = await mkSession(x.tm.id);
  await say(sid, '정리해 줘');
  await waitDraft(sid);
  const c = cardOf(sid);
  assert.deepEqual([c.cross.secondId, c.cross.worked], [x.red.id, false]);
  const body = { missionId: S(sid).mission.id, expected: shown(c), review: { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) } };
  const bad = await confirm(sid, { ...body, cross: { on: true, secondId: x.dev.id } });
  assert.equal(bad.status, 409);
  assert.deepEqual([bad.json.cross.secondId, bad.json.cross.can, typeof bad.json.estimate?.review], [x.red.id, true, 'number']);
  assert.deepEqual([S(sid).mission.status, S(sid).mission.cross], ['draft', undefined], '반영하지 않았다');
  assert.equal((await confirm(sid, { ...body, cross: { on: true, secondId: x.red.id } })).status, 200);
  await waitEnd(sid);
  assert.equal(S(sid).mission.cross.secondId, x.red.id);
  // 후보가 개발 담당뿐: 자기 일을 검수할 수 있다고 카드가 알린다(worked)
  const lead = await mk('일함분석', '분석');
  const dev = await mk('일함개발', '개발');
  const chk = await mk('일함검수', '검수');
  const tm = await mkTeam('일함팀', [{ label: '분석', agentIds: [lead.id] }, { label: '개발', agentIds: [dev.id] }, { label: '검수', agentIds: [chk.id] }]);
  const s2 = await mkSession(tm.id);
  await say(s2, '정리해 줘');
  await waitDraft(s2);
  assert.deepEqual([cardOf(s2).cross.secondId, cardOf(s2).cross.worked], [dev.id, true]);
});

test('20. 이번 회차에 둘째를 못 쓰는 까닭: 첫째와 같은 사람·팀에서 빠짐·끊긴 사이 지워짐 → 이어서가 막히지 않고 한 명 검수 + 진행 기록 한 줄', async () => {
  await app();
  const cases = [
    ['같음', (x, sid) => { S(sid).mission.cross.secondId = x.check.id; S(sid).runs.at(-1).stages.at(-1).agentIds = [x.check.id, x.check.id]; }, '첫째 검수자와 같은 사람이야'],
    ['빠짐', async (x) => { await t.api('PUT', `/api/teams/${x.tm.id}`, { ...x.tm, stages: x.tm.stages.map((st) => ({ ...st, agentIds: st.agentIds.filter((id) => id !== x.red.id) })) }); }, '팀에 없어'],
    ['지움', async (x) => { assert.equal((await t.api('DELETE', `/api/agents/${x.red.id}`)).status, 200); }, '찾을 수 없어(지워진 에이전트)'],
  ];
  for (const [tag, change, why] of cases) {
    const x = await crossTeam(`못씀${tag}`);
    const sid = await goal(x.tm.id, 'SLOW');
    await cutAtWork(sid);
    await change(x, sid);
    const r = await resume(sid);
    assert.equal(r.status, 200, `${tag}: ${JSON.stringify(r.json)}`);
    await waitEnd(sid);
    const m = S(sid).mission;
    assert.deepEqual([m.status, reviewMsgs(sid).filter((y) => y.review.round === 1).length], ['done', 1], tag);
    assert.ok(m.log.some((l) => l.kind === 'cross' && l.text.includes(why) && l.text.endsWith('그래서 이번 회차는 한 명이 검수해.')), `${tag}: ${JSON.stringify(m.log.map((l) => l.text))}`);
    assert.equal(m.crossLog.at(-1).single, true, tag);
  }
});

test('21. 판정 카드 값 지우기: 카드에서 그만 → 목표 끝에 지움. 끊긴 목표를 버리면 지움(흐름도·내보내기에 대기로 안 남음). 카드 값이 없는 자리에서 이어서 하면 검수부터 다시', async () => {
  await app();
  const x = await crossTeam('카드값');
  const a = await goal(x.tm.id, 'REDFAILNOEV');
  await waitHold(a, 'mission', 'split');
  assert.equal((await ctl(a, 'stop')).json.ok, true);
  await waitEnd(a);
  assert.deepEqual([S(a).mission.status, S(a).mission.split], ['stopped', undefined]);
  assert.notEqual(flowModel({ mission: S(a).mission, runs: S(a).runs, messages: S(a).messages }).nodes.find((n) => n.id === 'split')?.state, 'wait');
  // 끊긴 목표 버리기
  const b = await goal(x.tm.id, 'REDFAILNOEV');
  await cutAtCard(b);
  assert.ok(S(b).mission.split);
  assert.equal((await t.api('POST', `/api/sessions/${b}/mission/discard`, { missionId: S(b).mission.id })).status, 200);
  assert.deepEqual([S(b).mission.status, S(b).mission.split], ['cancelled', undefined]);
  assert.equal(exportRun({ s: S(b), m: S(b).mission }).splitOpen, undefined);
  assert.notEqual(flowModel({ mission: S(b).mission, runs: S(b).runs, messages: S(b).messages }).nodes.find((n) => n.id === 'split')?.state, 'wait');
  // 카드 값이 없는 자리(옛 판 등): 같은 회차 검수를 다시 해서 카드를 다시 띄운다
  const c = await goal(x.tm.id, 'REDFAILNOEV');
  await cutAtCard(c);
  delete S(c).mission.split;
  const before = reviewMsgs(c).length;
  assert.equal((await resume(c)).status, 200);
  const h = (await waitHold(c, 'mission', 'split')).hold;
  assert.deepEqual([h.round, reviewMsgs(c).length - before], [1, 2], '두 검수자가 다시 판정');
  await ctl(c, 'stop');
  await waitEnd(c);
});

test('22. 판정 카드에서 고르면 목표는 다시 도는 중(active): 고치기 뒤 되돌림이 도는 동안', async () => {
  await app();
  const x = await crossTeam('상태');
  const sid = await goal(x.tm.id, 'SLOW REDFAILNOEV');
  await waitHold(sid, 'mission', 'split');
  assert.equal(S(sid).mission.status, 'waiting');
  assert.equal((await ctl(sid, 'judge', { round: 1, picks: { c1: 'fix' } })).json.ok, true);
  await t.waitFor(() => S(sid).mission.status === 'active' && S(sid).runs.at(-1).status === 'running', 10000, '고른 뒤 active');
  await t.waitFor(() => S(sid).runs.at(-1)?.hold?.kind === 'split' && S(sid).runs.at(-1).hold.round === 2, 40000, '2회차 카드');
  await ctl(sid, 'stop');
  await waitEnd(sid);
});

test('23. 남은 일·지키기로 한 것을 어김은 두 검수자 것의 합집합. 되돌릴 기준이 없으면 "한 번 더"를 내지 않는다', async () => {
  await app();
  const x = await crossTeam('합집');
  const sid = await goal(x.tm.id, 'CHECKEXTRA REDEXTRA');
  const run = await waitHold(sid, 'mission', 'verdict');
  const m = S(sid).mission;
  assert.deepEqual(m.extras, ['가짜 검증 남은 일: 로그가 길어', '가짜 레드팀 남은 일: 도움말 빠짐']);
  assert.deepEqual(m.keepBroken, ['가짜 검증: API 이름이 바뀜 (src/app.js:3)', '가짜 레드팀: 설정 이름이 바뀜 (src/cfg.js:1)']);
  assert.deepEqual([run.hold.extras.length, run.hold.keepBroken.length, run.hold.more, run.hold.noReturn], [2, 2, false, true]);
  await ctl(sid, 'stop');
  await waitEnd(sid);
});

test('24. 둘 다 판정 없음 + 사용량 한도: 한도 대기(결정 0019)를 띄우고 쪽마다 까닭을 남긴다(검증은 오류·레드팀은 한도여도)', async () => {
  await app();
  const keep = t.app.store.settings.failover;
  t.app.store.settings.failover = false; // 다른 AI 로 이어받지 않게(이어받을 AI 가 없는 경우)
  try {
    const x = await crossTeam('한도둘');
    for (const sig of ['REVIEWQUOTA', 'CHECKERR REDQUOTA']) {
      const sid = await goal(x.tm.id, sig);
      const run = await waitHold(sid, 'quota');
      assert.equal(run.hold.phase, 'review', sig);
      const m = S(sid).mission;
      const lines = m.log.filter((l) => l.kind === 'cross' && l.text.startsWith('교차 검수 1회차: ')).map((l) => l.text);
      assert.ok(lines.some((l) => l.includes(x.red.name) && l.includes('사용량 한도에 걸렸어')), `${sig}: ${JSON.stringify(lines)}`);
      assert.ok(lines.some((l) => l.includes(x.check.name) && l.includes(sig === 'REVIEWQUOTA' ? '사용량 한도에 걸렸어' : '검수가 오류로 끝났어')), `${sig}: ${JSON.stringify(lines)}`);
      assert.ok(run.hold.who.some((w) => w.agentId === (sig === 'REVIEWQUOTA' ? x.check.id : x.red.id)), JSON.stringify(run.hold.who));
      await ctl(sid, 'stop');
      await waitEnd(sid);
      t.app.orch.cooldown.map.clear(); // 가짜 한도 오류가 남긴 쉬는 표시·한도 기록은 다음 차례·뒤 테스트에 남기지 않는다
      t.app.store.usage.limits = {};
    }
  } finally { t.app.store.settings.failover = keep; t.app.orch.cooldown.map.clear(); t.app.store.usage.limits = {}; }
});

test('25. 둘째의 AI 한도가 이미 다 참: 묻지 않고 한 명 검수(진행 기록 한 줄)', async () => {
  await app();
  const x = await crossTeam('다참', { red: { provider: 'codex', model: 'gpt-6.1-sol' } });
  const keepLim = t.app.store.usage.limits;
  const keepFo = t.app.store.settings.failover;
  t.app.store.usage.limits = { ...(keepLim || {}), codex: { windows: { five_hour: { pct: 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 } }, observedAt: Date.now() } };
  t.app.store.settings.failover = false;
  try {
    const sid = await goal(x.tm.id);
    await waitEnd(sid);
    const m = S(sid).mission;
    assert.deepEqual([m.status, reviewMsgs(sid).length], ['done', 1]);
    assert.ok(m.log.some((l) => l.kind === 'cross' && l.text.includes('한도가 이미 다 찼어')), JSON.stringify(m.log.map((l) => l.text)));
  } finally { t.app.store.usage.limits = keepLim; t.app.store.settings.failover = keepFo; }
});

test('26. 형식을 다시 요청해 받은 판정은 구멍이 아니다(한 명 검수·교차 검수). 검수자가 진행자 질문 블록(oc-lead)을 쓰면 판정이 아니고, 진행자에게 묻지도 않는다', async () => {
  await app();
  const x = await crossTeam('구멍');
  const one = await goal(x.tm.id, 'REVIEWBAD1', { cross: false });
  await waitEnd(one);
  assert.equal(S(one).mission.status, 'done');
  assert.ok(!S(one).mission.log.some((l) => l.fail === 'hole'), JSON.stringify(S(one).mission.log.filter((l) => l.fail)));
  const sid = await goal(x.tm.id, 'REDLEAD');
  await waitEnd(sid);
  const m = S(sid).mission;
  assert.deepEqual([m.status, m.calls.used], ['done', 6], '레드팀은 형식을 한 번 더 받았다');
  const reds = reviewMsgs(sid).filter((y) => y.review.role === 'red');
  assert.deepEqual(reds.map((y) => [y.review.missing, !!y.review.retried]), [[true, false], [false, true]]);
  assert.ok(!m.log.some((l) => l.fail), JSON.stringify(m.log.filter((l) => l.fail)));
  assert.ok(!m.log.some((l) => l.kind === 'lead') && !reds.some((y) => y.leadAsks?.length), '진행자에게 묻지 않았다');
  assert.deepEqual(m.criteria.map((c) => [c.status, c.one || '']), [['pass', ''], ['pass', '']]);
});

test('27. 결정 0031 과 맞물림: 두 갈래에서 사용자가 고른 것이 두 검수자 프롬프트에 다 가고, 답 종류·보고·내보내기·흐름도에 양쪽 칸이 다 나온다', async () => {
  await app();
  assert.deepEqual(['fork', 'lead', 'meet'].map((kind) => answerKind({ role: 'agent', prep: { kind } })), ['fork', 'lead', 'meeting']);
  assert.deepEqual([answerKind({ review: { round: 1, role: 'red' } }), answerKind({ review: { round: 1, role: 'check' } }), answerKind({ review: { round: 1 } })], ['cross', 'review', 'review']);
  assert.deepEqual(answerRows((k) => k, { review: 2, cross: 1, fork: 2, lead: 1 }).map(([k]) => k).slice(-4), ['review', 'cross', 'fork', 'lead']);
  const x = await crossTeam('맞물');
  const from = t.fakeLog().length;
  const sid = await goal(x.tm.id, 'SLOW');
  S(sid).mission.decided = [{ question: '어느 안으로 갈까?', answer: '안 A', about: '안 A 의 요약', fork: true, stageIndex: 1, at: Date.now() }];
  await waitEnd(sid);
  const rp = reviewProcs(from);
  assert.equal(rp.length, 2);
  for (const p of rp) assert.ok(p.texts[0].includes('[사용자가 정한 것 — 회의가 두 안으로 갈려 사용자가 하나를 고름. 이 안대로 해]'), p.texts[0].slice(0, 120));
  const s = S(sid);
  const m = s.mission;
  m.forks = [{ label: '회의', picked: 'a', chosen: '안 A', dropped: ['안 B'], msgId: null }];
  const rep = buildReport({ m, messages: s.messages, runs: s.runs, nameOf: (id) => t.app.store.get('agents', id)?.name || id });
  assert.ok(rep.forks?.length === 1 && rep.cross?.rounds === 1);
  const text = reportText(rep, { missionId: m.id });
  assert.ok(text.includes('두 갈래(입장은 에이전트가 씀):') && text.includes('교차 검수:') && text.includes('교차 검수(레드팀) 1'), text);
  const out = exportRun({ s, m });
  assert.ok(out.crossLog.length === 1 && out.decided.some((d) => d.fork) && out.calls.some((k) => k.kind === 'cross'));
  assert.ok(flowModel({ mission: m, runs: s.runs, messages: s.messages }).nodes.some((n) => n.id === 'review:red'));
});

test('28. 회귀: 교차 검수를 끈 목표는 지키기로 한 것을 어겨 되돌릴 기준이 없어도 "한 번 더"를 낸다(지금 그대로)', async () => {
  await app();
  const x = await crossTeam('끈목표');
  const sid = await goal(x.tm.id, 'REVIEWKEEP', { cross: false });
  const run = await waitHold(sid, 'mission', 'verdict');
  assert.deepEqual([run.hold.more, run.hold.noReturn, run.hold.left.length], [undefined, undefined, 0]);
  assert.equal((await ctl(sid, 'more')).json.ok, true);
  await waitHold(sid, 'mission', 'verdict');
  await ctl(sid, 'stop');
  await waitEnd(sid);
});
