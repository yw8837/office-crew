// 고정 프롬프트 크기 지키기(결정 0025): 목표 모드가 호출마다 붙이는 고정 지시를 실제로 조립하는 함수의 결과로 잰다(사전의 키가 아니라. 옛 키가 사전에 남아 있어도 옛 문구를 재지 않게).
// 값이 들어가는 자리(목표·기준 글, 참석자의 말, 결과)는 비우거나 빼고, 항목마다 한국어·영어 글자 수가 test/prompt-baseline.json 의 값 + 여유를 넘으면 실패한다
// (호출 수 × 크기로 몰래 불어나지 않게). 의도한 증가면 기준값 파일의 그 항목을 올린다(hygiene-baseline.json 과 같은 방식).
// - mission.js·meeting.js 가 내보내는 조각과 조립 함수(계획·검수·조사 질문·조사·훑어보기·일 카드 프롬프트)는 빈 입력으로 바로 부른다.
// - 오케스트레이터 안에서만 조립하는 것(목표 잡기, 확정 목표 블록, 회의 차례 의견·판정·차례 발언·결론)은 가짜 CLI 로 실제 실행을 돌려 보낸 프롬프트에서 그 부분을 떼어 잰다.
//   가짜 CLI 는 한국어 표시만 알아보므로 영어는 한국어로 목표를 확정한 뒤 화면 언어를 영어로 바꿔 회의 단계를 돌린다(목표 잡기는 영어 요청 하나를 보내고 첫 호출만 잰다).
// - "[이어서]" 한 줄은 끊긴 실행을 이어야 나와서 실행으로 재지 않고, 그 문구가 서버 코드에 그대로 있는지 확인한 뒤 번역으로 잰다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tr } from '../server/i18n.js';
import en from '../public/js/i18n/en.js';
import { blockedRule, outsideRule, resumeSent, tailRule, ASSUME, goalBlock, researchBlock, planBlock, reviewBlock, planPrompt, reviewPrompt, researchPrompt, questionsPrompt, scanPrompt, cardPrompt, failuresPrompt, transientSent } from '../server/mission.js';
import { verdictBlock, checkBlock } from '../server/meeting.js';
import { startTestApp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(here, 'prompt-baseline.json');
const RESUME = '[이어서] 이 단계는 앱이 꺼져서 중간에 끊겼어. 작업 폴더에 이미 해 둔 것이 있는지 먼저 확인하고, 있으면 거기서 이어서 해.';
const len = (s) => [...String(s)].length;
const M8 = '0'.repeat(8);

// mission.js·meeting.js 의 조각과 조립 함수(빈 입력)
const pure = () => ({
  blockedRule: blockedRule(), outsideAsk: outsideRule(true), outsideNoAsk: outsideRule(false), resumeSent: resumeSent(), tailRule: tailRule(), assume: ASSUME(),
  goalBlock: goalBlock(), researchBlock: researchBlock(), planBlock: planBlock(), reviewBlock: reviewBlock('0'.repeat(16)), verdictBlock: verdictBlock(), checkBlock: checkBlock(),
  planPrompt: planPrompt({ mark: M8 }), reviewPrompt: reviewPrompt({ nonce: '0'.repeat(16), mark: M8 }), researchPrompt: researchPrompt({ mark: M8 }),
  questionsPrompt: questionsPrompt({ mark: M8 }), scanPrompt: scanPrompt({}), cardPrompt: cardPrompt({ card: { id: 'k1', title: '', kind: 'build', files: [], done: '', not: '' }, mark: M8 }),
  resumeHead: tr(RESUME),
  // 반복 실패 줄(결정 0030): 되풀이된 실패가 있을 때만 일 단계에 붙는 블록. 줄 하나(글 없이 "- (목표 n개에서 m번)" 틀만)로 잰다
  failuresPrompt: failuresPrompt([{ key: 'x', line: '', n: 0, goals: [] }], M8),
  // 일시 장애로 자동으로 다시 도는 사람의 맨 앞 한 줄(결정 0030): 다시 도는 그 차례에만
  transientHead: transientSent(),
});

// 실행 기록에서 뗀 프롬프트 부분: 무작위 표식(8자리) 사이의 글(참석자의 말·질문)은 빼고 표식은 고정 값으로
const MARK = /^---\s(?:.*\s)?([0-9a-f]{8})(?:\s.*)?\s---$/;
function blank(seg) {
  const out = [];
  let open = null;
  for (const l of seg.split('\n')) {
    const m = l.match(MARK);
    if (m) { open = open === m[1] ? null : open || m[1]; out.push(l.replace(m[1], M8)); continue; }
    if (!open) out.push(l);
  }
  return out.join('\n');
}
// 변수가 든 머리말의 앞부분(언어마다): "[회의 — 판정 ({r}/{n}바퀴)]" → "[회의 — 판정"
const headOf = (key) => tr(key, { r: '\u0001', n: '\u0001' }).split('\u0001')[0].replace(/\s*[(（]$/, '');
// 한 프롬프트에서 head 로 시작하는 줄부터 끝까지(회의 차례·목표 잡기는 프롬프트의 마지막 부분이다)
const tailFrom = (text, head) => { const at = text.lastIndexOf(`\n${head}`); return at < 0 ? (text.startsWith(head) ? text : '') : text.slice(at + 1); };

let t = null;
// 서버의 tr 은 앱 설정 언어에 묶여 있다(같은 프로세스). 그래서 재는 언어도 앱 설정으로 바꾼다
const inLang = (lang, fn) => { const was = t.app.store.settings.lang; t.app.store.settings.lang = lang; try { return fn(); } finally { t.app.store.settings.lang = was; } };
after(async () => { if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } } });

// 가짜 CLI 로 목표 하나를 돌려 오케스트레이터가 조립한 프롬프트를 모은다. lang: 회의 단계를 돌 언어
async function captured() {
  t ||= await startTestApp();
  const log = () => { let s = ''; try { s = fs.readFileSync(process.env.FAKE_LOG, 'utf8'); } catch { return []; } return s.slice(0, s.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }); };
  const prompts = (from) => log().slice(from).filter((l) => l.cli === 'claude' && typeof l.text === 'string').map((l) => l.text);
  const mk = async (name, role) => (await t.api('POST', '/api/agents', { name, role, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual' })).json;
  const a = await mk('가', '기획');
  const b = await mk('나', '개발');
  const v = await mk('다', '검수');
  const tm = (await t.api('POST', '/api/teams', { name: '크기팀', stages: [{ label: '논의', agentIds: [a.id, b.id], meeting: { rounds: 3 } }, { label: '검수', agentIds: [v.id] }] })).json;
  const S = (id) => t.app.store.getSession(id);
  const idle = (id) => !t.app.orch.ctx.has(id);
  const out = {};
  // 목표 하나: 한국어로 목표 카드까지, 회의 단계는 lang 으로. 두 참석자의 입장이 갈리게(STANCEB) 해서 차례 발언까지 돈다
  const one = async (lang) => {
    t.app.store.settings.lang = 'ko';
    const s = (await t.api('POST', '/api/sessions', { teamId: tm.id })).json;
    await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true });
    const from = log().length;
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text: `STANCEB:${b.name} 정리해 줘` });
    await t.waitFor(() => S(s.id).mission?.status === 'draft' && idle(s.id), 20000, '목표 카드');
    if (lang === 'ko') out.ko = { goalPrompt: prompts(from)[0] };
    const c = S(s.id).messages.findLast((m) => m.role === 'proposal' && m.kind === 'goal');
    t.app.store.settings.lang = lang;
    const work = log().length;
    const r = await t.api('POST', `/api/sessions/${s.id}/mission/confirm`, { missionId: S(s.id).mission.id, expected: { goal: c.goal, criteria: c.criteria, outOfScope: c.outOfScope, userDecides: c.userDecides, ...(c.checks ? { checks: c.checks } : {}), ...(c.keep ? { keep: c.keep } : {}) },
      review: { reviewerId: c.review.reviewerId, droppable: c.review.droppable, drop: c.review.droppable.map((d) => d.index) }, work: 'stages' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const conclude = headOf('[회의 — 결론 내기]');
    await t.waitFor(() => prompts(work).some((p) => p.includes(conclude)), 30000, `${lang} 회의 결론 차례`);
    await t.api('POST', `/api/sessions/${s.id}/control`, { action: 'stop' });
    await t.waitFor(() => idle(s.id), 20000, '멈춤');
    const ps = prompts(work);
    assert.ok(ps.every((p) => len(p) < 5000), '가짜 CLI 기록은 앞 5000자만 남긴다: 잘린 프롬프트로 재지 않게');
    inLang(lang, () => {
      const m = S(s.id).mission;
      const phase = (key) => Math.max(0, ...ps.map((p) => len(blank(tailFrom(p, headOf(key))))));
      // 확정 목표 블록: 머리말부터 마지막 문장까지에서 목표·기준 글(사용자가 확인한 값)을 뺀다
      const headKey = '[확정된 목표와 합격 기준 (사용자가 확인함. 바꾸지 마)]';
      const endLine = tr('이 목표와 기준을 채우는 쪽으로 네 단계를 해. 기준을 바꾸거나 범위 밖의 일을 하지 마.');
      const p0 = ps.find((p) => p.includes(tr(headKey)));
      let block = p0.slice(p0.indexOf(tr(headKey)), p0.indexOf(endLine) + endLine.length);
      for (const x of [m.goal, ...m.criteria.flatMap((k) => [k.text, k.check || '']), ...(m.outOfScope || []), ...(m.mustKeep || [])].filter(Boolean)) block = block.replace(x, '');
      Object.assign(out[lang] ||= {}, {
        goalHead: len(block),
        meetOpinion: phase('[회의 — 의견 내기 ({r}/{n}바퀴)]'), meetJudge: phase('[회의 — 판정 ({r}/{n}바퀴)]'),
        meetTurn: phase('[회의 — 차례 발언 ({r}/{n}바퀴)]'), meetConclude: phase('[회의 — 결론 내기]'),
      });
    });
    t.app.store.settings.lang = 'ko';
  };
  await one('ko');
  await one('en');
  // 영어 목표 잡기: 영어로 요청 하나(가짜 CLI 가 카드를 못 내도 첫 호출의 프롬프트는 남는다)
  t.app.store.settings.lang = 'en';
  try {
    const s = (await t.api('POST', '/api/sessions', { teamId: tm.id })).json;
    await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true });
    const from = log().length;
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text: 'sum it up' });
    await t.waitFor(() => prompts(from).length >= 1 && idle(s.id), 20000, '영어 목표 잡기');
    out.en.goalPrompt = prompts(from)[0];
  } finally { t.app.store.settings.lang = 'ko'; }
  for (const lang of ['ko', 'en']) out[lang].goalPrompt = inLang(lang, () => len(tailFrom(out[lang].goalPrompt, tr('[목표 잡기]'))));
  return out;
}

const measure = async () => {
  const run = await captured();
  const out = {};
  for (const lang of ['ko', 'en']) out[lang] = { ...inLang(lang, () => Object.fromEntries(Object.entries(pure()).map(([k, v]) => [k, len(v)]))), ...run[lang] };
  return out;
};

test('1. "[이어서]" 줄은 서버 코드에 그대로 있고 영어 사전에도 있다(없으면 옛 문구나 한국어를 재게 된다)', () => {
  const src = fs.readdirSync(path.join(here, '..', 'server')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(here, '..', 'server', f), 'utf8')).join('\n');
  assert.ok(src.includes(`tr('${RESUME}')`), '코드의 문구가 바뀌었으면 이 테스트의 RESUME 도 같이 바꿔');
  assert.equal(typeof en[RESUME], 'string');
});

test('2. 목표 모드의 고정 지시(실제 조립 결과, 한국어·영어 항목마다)가 기준값 + 여유를 넘지 않는다', { timeout: 180000 }, async (tt) => {
  const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const now = await measure();
  for (const lang of ['ko', 'en']) for (const [k, n] of Object.entries(now[lang])) assert.ok(n > 0, `${lang}.${k} 를 재지 못했어(0자)`);
  const over = [];
  const fewer = [];
  const missing = [];
  for (const lang of ['ko', 'en']) {
    for (const [k, n] of Object.entries(now[lang])) {
      const b = base.items?.[lang]?.[k];
      if (typeof b !== 'number') { missing.push(`${lang}.${k}=${n}`); continue; }
      if (n > Math.floor(b * (1 + base.slack))) over.push(`${lang}.${k}: ${b} → ${n}`);
      else if (n < b) fewer.push(`${lang}.${k}: ${b} → ${n}`);
    }
    for (const k of Object.keys(base.items?.[lang] || {})) if (!(k in now[lang])) missing.push(`${lang}.${k}(기준값에만 있음)`);
  }
  assert.deepEqual(missing, [], `기준값 파일과 재는 항목이 달라. test/prompt-baseline.json 의 items 를 맞춰 줘: ${missing.join(', ')}`);
  assert.deepEqual(over, [], `고정 지시가 여유 ${Math.round(base.slack * 100)}%를 넘게 늘었어. 호출마다 붙는 글이라 호출 수만큼 커져. 의도한 증가면 test/prompt-baseline.json 의 그 항목을 새 값으로 올려: ${over.join(', ')}`);
  if (fewer.length) tt.diagnostic(`줄어든 항목이 있어. test/prompt-baseline.json 의 값을 낮춰 줘: ${fewer.join(', ')}`);
});
