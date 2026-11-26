// 프롬프트 크기 실측(결정 0023의 표). 테스트 목록에는 넣지 않는다: 손으로 돌려 숫자를 다시 잴 때 쓴다.
// startTestApp(가짜 CLI, 임시 데이터 폴더, OFFICE_CREW_FAKE_ONLY)으로 앱을 띄우고, 프로바이더 run 을 감싸 호출마다 프롬프트·시스템 지시를 그대로 적는다.
// 실제 AI CLI 는 띄우지 않고(가짜 CLI 밖의 명령은 막힌다), 사용자 설정 폴더(~/.claude 등)도 쓰지 않는다. 저장소 파일은 고치지 않는다.
//
// 사용: node test/measure/prompt-audit.js <출력 폴더> [--repo <저장소 폴더>] [--pad] [--skills <스킬 폴더>] [--savings normal|lean]
//   --repo   잴 저장소(기본: 이 파일이 든 저장소). 바꾸기 전 코드를 재려면 그 커밋을 풀어 둔 폴더를 준다(예: git archive <커밋> | tar -x -C <폴더>)
//   --pad    가짜 CLI 의 답 길이를 실제 답 길이 어림으로 채운다(표의 숫자는 --pad 로 잰 것)
//   --skills 조사 역할의 기본 스킬 두 개(agent-reach, insane-search)를 <폴더>/<이름>/SKILL.md 에서 복사한다.
//            주지 않으면 같은 길이(본문 2,925자·17,719자)의 시험용 글로 만든다(숫자는 글자 수만 본다)
//   --savings 넘겨주는 글의 양 설정(결정 0026). normal(기본, 지금대로) 과 lean(절약)을 같은 장면으로 재서 prompt-compare.js 로 견준다
// 나온 calls.jsonl 두 벌을 test/measure/prompt-compare.js 로 견준다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const OUT = path.resolve(argv.find((a, i) => !a.startsWith('--') && !['--repo', '--skills', '--savings'].includes(argv[i - 1])) || 'prompt-audit-out');
const REPO = path.resolve(opt('--repo') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const PAD = argv.includes('--pad');
const SKILLS = opt('--skills');
const SAVINGS = opt('--savings') === 'lean' ? 'lean' : 'normal';
fs.mkdirSync(OUT, { recursive: true });

// 조사 역할 기본 스킬 두 개를 이 실측만의 임시 Claude 설정 폴더에 둔다
const SKILL_BODY = { 'agent-reach': 2925, 'insane-search': 17719 };
const cfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-audit-cfg-'));
process.env.CLAUDE_CONFIG_DIR = path.join(cfgRoot, 'claude');
process.env.CODEX_HOME = path.join(cfgRoot, 'codex');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const skillSizes = {};
for (const [n, len] of Object.entries(SKILL_BODY)) {
  const dst = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', n, 'SKILL.md');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const src = SKILLS ? path.join(path.resolve(SKILLS), n, 'SKILL.md') : null;
  if (src && fs.existsSync(src)) fs.copyFileSync(src, dst);
  else {
    let body = '';
    for (let k = 0; body.length < len; k++) body += `- 시험용 스킬 ${n} 줄 ${k}: 실제 스킬 본문 길이를 흉내 내려고 채운 줄이고 뜻은 없어.\n`;
    fs.writeFileSync(dst, `---\nname: ${n}\ndescription: ${n} 시험용 스킬(실측용)\n---\n${body.slice(0, len)}`);
  }
  skillSizes[n] = fs.readFileSync(dst, 'utf8').length;
}
if (PAD) process.env.AUDIT_PAD = '1'; else delete process.env.AUDIT_PAD;

const { startTestApp } = await import(pathToFileURL(path.join(REPO, 'test', 'helpers.js')).href);
const { PROVIDERS } = await import(pathToFileURL(path.join(REPO, 'server', 'providers', 'index.js')).href);

// ── 호출 잡기 ──
let scenario = '';
const calls = [];
for (const id of ['claude', 'codex']) {
  const p = PROVIDERS[id];
  const orig = p.run.bind(p);
  p.run = (opts, emit) => {
    const rec = { n: calls.length + 1, scenario, provider: id, agent: opts.agent?.name, agentId: opts.agent?.id, role: opts.agent?.role, permission: opts.agent?.permission,
      resumeId: opts.resumeId || null, refresh: !!opts.refreshSystem, prompt: opts.prompt || '', system: opts.system || '', at: Date.now() };
    calls.push(rec);
    const h = orig(opts, (ev) => { if (ev.type === 'session' && ev.id) rec.sid = ev.id; emit(ev); });
    h.done = h.done.then((r) => { rec.out = r?.text || ''; rec.sid = r?.providerSessionId || rec.sid; rec.error = r?.error || null; return r; });
    return h;
  };
}

const t = await startTestApp();
t.app.store.settings.savings = SAVINGS; // 바꾸기 전 코드(--repo)에는 이 설정이 없어 무시된다
// ── 가짜 CLI 를 이 임시 폴더 안에서만 바꾼다: 프롬프트 전체 길이를 기록, (--pad 면) 답 길이를 실제 어림으로 채움, PLAN4 신호어(카드 4장) ──
const bin = path.join(t.root, 'bin');
const FILL = `const FILLER = (n) => { const line = '가짜 답 문장 ' + process.pid + '번이야. 실제 답 길이를 흉내 내려고 채운 줄이고 내용은 없어. '; let s = ''; let k = 0; while (s.length < n) { s += line + (k++) + '\\n'; } return s.slice(0, n) + '\\n'; };\n`;
{
  let src = fs.readFileSync(path.join(REPO, 'test/fake-cli/fake-claude.js'), 'utf8');
  const rep = (a, b) => { if (!(typeof a === 'string' ? src.includes(a) : a.test(src))) throw new Error(`fake-claude 바꿀 곳 없음: ${String(a).slice(0, 40)}`); src = src.replace(a, b); };
  rep(/text: text\.slice\(0, \d+\), imgs/, 'text, len: text.length, imgs');
  rep("    if (g('PLANMANY'))", "    if (g('PLAN4')) cards = [\n      { title: '자료를 모은다', owner: roster[0] || '?', kind: 'research', needs: [], files: [], not: '코드는 건드리지 마', done: '자료 목록이 있다' },\n      { title: '보고서 초안을 쓴다', owner: roster[2] || roster[0] || '?', kind: 'write', needs: [], files: ['docs/report.md'], not: '', done: '초안이 있다' },\n      { title: '결과를 만든다', owner: roster[3] || roster[1] || '?', kind: 'build', needs: ['k1'], files: ['src/app.js'], not: '', done: '결과 파일이 있다' },\n      { title: '요약을 쓴다', owner: roster[1] || roster[0] || '?', kind: 'write', needs: ['k3'], files: ['docs/summary.md'], not: '', done: '요약이 있다' },\n    ];\n    if (g('PLANMANY'))");
  const padCode = `  const PADN = !process.env.AUDIT_PAD ? 0 : goalTurn ? 600 : reviewTurn ? 900 : scanTurn ? 1500 : qTurn ? 300 : rn ? 1200 : planTurn ? 600 : cardId ? (tailRetry ? 0 : 2500)
    : text.includes('[회의 — 의견 내기') ? 450 : text.includes('[회의 — 차례 발언') ? 350 : text.includes('[회의 — 판정') ? 150 : text.includes('[회의 — 결론 내기]') ? 1400 : research ? 700
    : text.includes('[팀 작업]') ? 3000 : 2000;
  if (PADN && chunks.length) chunks.unshift(FILLER(PADN));
  for (const ch of chunks) {`;
  rep('  for (const ch of chunks) {', padCode);
  src = src.replace("import readline from 'node:readline';", `import readline from 'node:readline';\n${FILL}`);
  fs.writeFileSync(path.join(bin, 'fake-claude.js'), src);
}
{
  let src = fs.readFileSync(path.join(REPO, 'test/fake-cli/fake-codex.js'), 'utf8');
  const rep = (a, b) => { if (!(typeof a === 'string' ? src.includes(a) : a.test(src))) throw new Error(`fake-codex 바꿀 곳 없음: ${String(a).slice(0, 40)}`); src = src.replace(a, b); };
  rep(/prompt: input\.slice\(0, \d+\)/, 'prompt: input, len: input.length');
  rep("text: '정리 결과: 파란색'", "text: (process.env.AUDIT_PAD ? FILLER(input.includes('[회의 — 의견 내기') ? 450 : input.includes('[회의 — 차례 발언') ? 350 : input.includes('[팀 작업]') ? 3000 : 2000) : '') + '정리 결과: 파란색'");
  src = src.replace("import fs from 'node:fs';", `import fs from 'node:fs';\n${FILL}`);
  fs.writeFileSync(path.join(bin, 'fake-codex.js'), src);
}

const S = (id) => t.app.store.getSession(id);
const idle = (sid) => !t.app.orch.ctx.has(sid);
const mkTmp = (name) => fs.mkdtempSync(path.join(t.root, `${name}-`));
await t.api('GET', '/api/skills?rescan=1');
const skills = (await t.api('GET', '/api/skills')).json.filter((s) => /^ext:claude:(agent-reach|insane-search)$/.test(s.id)).map((s) => s.id);
const mk = async (name, role, extra = {}) => {
  const r = await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'sonnet', permission: 'plan', routing: 'manual', ...extra });
  if (r.status !== 200) throw new Error(`에이전트 만들기 실패 ${name}: ${r.text}`);
  return r.json;
};
const mkTeam = async (name, stages) => (await t.api('POST', '/api/teams', { name, stages })).json;
const mkSession = async (body) => (await t.api('POST', '/api/sessions', body)).json;
const say = async (sid, text, extra = {}) => {
  const n = S(sid).runs.length;
  const r = await t.api('POST', `/api/sessions/${sid}/messages`, { text, ...extra });
  if (r.status !== 200) throw new Error(`보내기 실패: ${r.text}`);
  await t.waitFor(() => { const rs = S(sid).runs; return rs.length > n && idle(sid) && (rs.at(-1).endedAt || rs.at(-1).hold); }, 120000, `실행 끝: ${text.slice(0, 20)}`);
  const run = S(sid).runs.at(-1);
  if (run.hold) throw new Error(`실행이 멈춤: ${JSON.stringify(run.hold).slice(0, 300)}`);
  return run;
};

// (a) 보통 팀 실행 3단계 + 같은 세션에서 두 번째 요청
scenario = 'a';
{
  const r = await mk('가조사', '조사'); // 조사 역할: 기본 스킬(agent-reach, insane-search)이 붙는다
  const an = await mk('가분석', '분석');
  const or = await mk('가정리', '정리');
  const tm = await mkTeam('보고서 팀', [{ label: '조사', agentIds: [r.id] }, { label: '분석', agentIds: [an.id] }, { label: '정리', agentIds: [or.id] }]);
  const s = await mkSession({ teamId: tm.id, cwd: mkTmp('cwd-a') });
  await say(s.id, '우리 동네 카페 창업 시장 보고서를 만들어 줘. 경쟁 가게와 임대료를 같이 봐 줘.');
  scenario = 'a2';
  await say(s.id, '보고서에 배달 앱 수수료 비교를 더해 줘.');
}

// (b) 회의 단계: 참석자 3(Claude 2 + Codex 1), 3바퀴, 다음에 정리 1
scenario = 'b';
let meetTeam;
{
  const ca = await mk('나진행', '분석');
  const cb = await mk('나기획', '기획');
  const cx = await mk('나조사', '조사', { provider: 'codex', model: 'gpt-6.1-sol' });
  const cd = await mk('나정리', '정리');
  meetTeam = await mkTeam('회의 팀', [{ label: '방향 회의', agentIds: [ca.id, cb.id, cx.id], meeting: { rounds: 3, chairId: ca.id } }, { label: '정리', agentIds: [cd.id] }]);
  const s = await mkSession({ teamId: meetTeam.id, cwd: mkTmp('cwd-b') });
  await say(s.id, '새 서비스 이름과 첫 달 홍보 방향을 정하자.');
}

// (c) 목표 모드 전체: 조사·회의 켬, 일 카드 4장, 검수, 되돌림 1번(REVIEWFAIL)
scenario = 'c';
{
  const r = await mk('다조사', '조사');
  const a = await mk('다분석', '분석');
  const w = await mk('다정리', '정리');
  const b = await mk('다빌드', '빌드', { permission: 'edit' });
  const v = await mk('다검수', '검수');
  const tm = await mkTeam('목표 팀', [{ label: '조사', agentIds: [r.id] }, { label: '분석', agentIds: [a.id] }, { label: '정리', agentIds: [w.id] }, { label: '빌드', agentIds: [b.id] }, { label: '검수', agentIds: [v.id] }]);
  const s = await mkSession({ teamId: tm.id, cwd: mkTmp('cwd-c') });
  await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true });
  await t.api('POST', `/api/sessions/${s.id}/messages`, { text: `신제품 소개 보고서와 데모 페이지를 만들어 줘. STANCEB:${w.name}` });
  await t.waitFor(() => S(s.id).mission?.status === 'draft' && idle(s.id), 60000, '목표 카드');
  const c = S(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
  const shown = { goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides, ...(c.checks ? { checks: c.checks } : {}), ...(c.keep ? { keep: c.keep } : {}) };
  const review = { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) };
  const prep = { research: true, meeting: true, lead: c.prep.lead.id, researchers: c.prep.research.who.map((x) => x.id), attendees: c.prep.meeting.who.map((x) => x.id) };
  const body = { missionId: S(s.id).mission.id, expected: shown, review, prep, work: 'cards', edited: { ...shown, goal: 'PLAN4 REVIEWFAIL 목표' } };
  const res = await t.api('POST', `/api/sessions/${s.id}/mission/confirm`, body);
  if (res.status !== 200) throw new Error(`목표 확인 실패: ${res.text}`);
  await t.waitFor(() => idle(s.id) && !['active', 'waiting'].includes(S(s.id).mission.status), 180000, '목표 끝').catch((e) => { throw new Error(`${e.message} ${JSON.stringify({ st: S(s.id).mission.status, hold: S(s.id).runs.at(-1)?.hold, log: S(s.id).mission.log.slice(-6).map((x) => x.text) })}`); });
  const m = S(s.id).mission;
  fs.writeFileSync(path.join(OUT, 'c-mission.json'), JSON.stringify({ status: m.status, round: m.round, returns: m.returns, calls: m.calls, cards: (m.cards || []).map((x) => ({ id: x.id, owner: x.ownerId, status: x.status, starts: x.starts })), criteria: m.criteria, log: m.log.map((x) => x.text) }, null, 1));
}

// (d) 긴 세션: 한 에이전트와 17번 주고받음(메시지 34개) → (d1) 같은 에이전트 이어서 → (d2) 처음 맡는 에이전트 → (d3) 회의 팀으로 바꿔 회의
scenario = 'd-build';
{
  const longA = await mk('라담당', '분석');
  const newB = await mk('라신입', '분석');
  const s = await mkSession({ agentId: longA.id, cwd: mkTmp('cwd-d') });
  for (let k = 1; k <= 17; k++) await say(s.id, `${k}번째 요청: 카페 메뉴 가격표의 ${k}번째 항목을 다듬어 줘. 원가와 경쟁 가게 가격을 같이 봐.`);
  scenario = 'd1';
  await say(s.id, '지금까지 정한 가격표를 한 표로 정리해 줘.');
  scenario = 'd2';
  await say(s.id, '가격표를 손님용 메뉴판 문구로 바꿔 줘.', { mention: newB.id });
  scenario = 'd3';
  await t.api('PATCH', `/api/sessions/${s.id}`, { teamId: meetTeam.id });
  await say(s.id, '메뉴판 디자인 방향을 회의로 정하자.');
}

// (e) 스킬 2개 + 역할 노트 + 프로젝트 기억을 켠 에이전트
scenario = 'e-build';
{
  await t.api('PUT', '/api/settings', { memory: true });
  const cwd = mkTmp('cwd-e');
  const filler = await mk('마기록', '정리');
  const s0 = await mkSession({ agentId: filler.id, cwd });
  const SUP = [['한빛원두', 23000, '월', 5], ['새벽로스터리', 26000, '수', 3], ['푸른언덕커피', 21000, '금', 10], ['달빛빈스', 28000, '화', 2], ['솔숲로스팅', 24000, '목', 4], ['바람결원두', 22000, '토', 8]];
  for (const [nm, won, day, kg] of SUP) await say(s0.id, `납품처 ${nm} 조건: 원두 1kg 단가 ${won}원, 배송은 매주 ${day}요일, 최소 주문 ${kg}kg. 이 조건을 표로 정리해 줘.`);
  await t.app.orch.settled?.();
  fs.writeFileSync(path.join(OUT, 'e-memory.json'), JSON.stringify({ memoryOn: t.app.store.settings.memory, chunks: (await t.app.memory.of(cwd)).stats() }));
  const e = await mk('마분석', '분석', { skills });
  for (const [text, source] of [
    ['보고서는 항상 표로 먼저 요약하고 그 뒤에 근거를 적어.', { type: 'user' }],
    ['가격은 부가세 포함 여부를 꼭 밝혀.', { type: 'user' }],
    ['경쟁 가게 이름은 실명 대신 A, B로 적어.', { type: 'user' }],
    ['숫자에는 출처와 날짜를 붙여.', { type: 'user' }],
    ['카페 원두 납품 단가는 보통 kg당 2만~3만 원이라는 자료가 있어.', { type: 'web', ref: 'https://example.com/coffee-price' }],
    ['지난번 보고서에서 배송 요일을 빼먹어 다시 썼어.', { type: 'agent' }],
  ]) {
    const r = await t.api('POST', `/api/agents/${e.id}/notes/items`, { text, source });
    if (r.status !== 200) throw new Error(`노트 실패: ${r.text}`);
  }
  await t.api('POST', `/api/agents/${e.id}/notes/accept-all`, {});
  const s = await mkSession({ agentId: e.id, cwd });
  scenario = 'e1';
  await say(s.id, '한빛원두와 새벽로스터리 중 어디와 계약할지 단가와 배송 요일로 추천해 줘.');
  scenario = 'e2';
  await say(s.id, '배송 요일까지 고려하면 추천이 바뀌어?');
}

await t.app.orch.settled?.();
// 같은 에이전트의 새 대화끼리 시스템 지시가 같은가(캐시 접두사가 맞을 수 있는가). 무작위 표식은 지운 글로도 센다
const norm = (s) => String(s).replace(/[0-9a-f]{8}(?= (?:시작|끝) ---)/g, 'MARK').replace(/(?<=")[0-9a-f]{16}(?=")/g, 'NONCE').replace(/(?<=(?:참고|기억|대화|결과|의견|발췌|메모|조사|결론|질문|카드|직전|검수|파일|이름|훑어보기|앞 카드) )[0-9a-f]{8}/g, 'MARK');
const sysVariants = {};
for (const c of calls) {
  if (c.resumeId) continue;
  const v = (sysVariants[`${c.scenario.replace(/\d$|-build$/, '')}:${c.agent}`] ||= { raw: new Set(), norm: new Set(), n: 0 });
  v.n++; v.raw.add(crypto.createHash('sha1').update(c.system).digest('hex').slice(0, 8)); v.norm.add(crypto.createHash('sha1').update(norm(c.system)).digest('hex').slice(0, 8));
}
const variants = Object.fromEntries(Object.entries(sysVariants).map(([k, v]) => [k, { newConvs: v.n, rawVariants: v.raw.size, normVariants: v.norm.size }]));
fs.writeFileSync(path.join(OUT, 'calls.jsonl'), calls.map((c) => JSON.stringify(c)).join('\n'));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ pad: PAD, savings: SAVINGS, skillSizes, sysVariants: variants }, null, 1));
// 가짜 CLI 기록과 대조: 가짜 CLI 가 받은 글 길이 = 잡은 프롬프트 길이인가
const flog = t.fakeLog();
const fakeTexts = flog.filter((l) => l.cli === 'claude' && l.text !== undefined).map((l) => l.text.length);
const fakeSys = flog.filter((l) => l.cli === 'claude' && l.system !== undefined).map((l) => l.system.length);
const fakeCodex = flog.filter((l) => l.cli === 'codex' && l.prompt !== undefined).map((l) => l.prompt.length);
const mine = calls.filter((c) => c.provider === 'claude').map((c) => c.prompt.length);
const mineSys = calls.filter((c) => c.provider === 'claude' && c.system).map((c) => c.system.length);
const check = { claudePrompts: { fake: fakeTexts.length, captured: mine.length, sameMultiset: JSON.stringify([...fakeTexts].sort()) === JSON.stringify([...mine].sort()) },
  claudeSystem: { fake: fakeSys.length, captured: mineSys.length, sameMultiset: JSON.stringify([...fakeSys].sort()) === JSON.stringify([...mineSys].sort()) },
  codexPrompts: { fake: fakeCodex.length, captured: calls.filter((c) => c.provider === 'codex').length } };
fs.writeFileSync(path.join(OUT, 'fake-log-check.json'), JSON.stringify(check, null, 1));
console.log(JSON.stringify({ pad: PAD, savings: SAVINGS, calls: calls.length, errors: calls.filter((c) => c.error).map((c) => [c.n, c.scenario, c.error]), check }, null, 1));
await t.close().catch(() => {});
fs.rmSync(cfgRoot, { recursive: true, force: true });
process.exit(0);
