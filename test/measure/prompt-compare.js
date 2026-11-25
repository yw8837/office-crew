// test/measure/prompt-audit.js 가 남긴 calls.jsonl(호출마다 프롬프트·시스템 지시 원문) 두 벌을 똑같은 셈으로 견준다(결정 0023의 표). 테스트 목록에는 넣지 않는다.
// 사용: node test/measure/prompt-compare.js <바꾸기 전 출력 폴더> <바꾼 뒤 출력 폴더> [표를 쓸 파일]
// - 보낸 글: Claude 는 새 대화면 시스템 지시 + 프롬프트, 이어 가면 프롬프트만(첫 요청의 시스템 지시를 그대로 쓴다).
//   Codex 는 새 대화면 "<역할 지침>" 으로 감싼 지시 + 프롬프트. 앱이 프로바이더에 지시를 다시 붙이라고 한 호출(refreshSystem: 바꾸기 전 코드의 노트 바뀜)은
//   Codex 는 "바뀌었어" 줄 + 감싼 지시를 더하고, Claude 는 바꾸기 전 코드가 붙이지 않았으니 더하지 않는다. 지금 코드는 바뀐 노트를 프롬프트에 직접 넣는다(프롬프트 글자에 든다).
// - 이어 가며 다시 읽은 앞 대화: 같은 CLI 대화에 앞서 쌓인 글(보낸 글 + 답 글)의 합.
// - 시스템 지시 변형 수: 장면·에이전트마다 새 대화가 받은 시스템 지시의 서로 다른 개수(회의 말 차례와 그 밖을 나눠서도 센다).
// - 캐시 모형(어림, 진짜 캐시 숫자 아님): Claude 새 대화의 시스템 지시가 그 장면에서 앞에 똑같이 나왔으면 "다시 읽기", 처음이면 "새로 씀".
//   프롬프트는 늘 새로 씀. 이어 간 대화의 앞 대화는 다시 읽기. 비교안 A: 스킬 본문을 시스템 지시 대신 프롬프트 앞머리에 둔 경우를 바꾼 뒤 호출에서 옮겨 다시 센다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [B, A, OUTF] = process.argv.slice(2).map((x) => x && path.resolve(x));
if (!B || !A) { console.error('사용: node test/measure/prompt-compare.js <바꾸기 전 출력 폴더> <바꾼 뒤 출력 폴더> [표를 쓸 파일]'); process.exit(2); }
const load = (d) => fs.readFileSync(path.join(d, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const WRAP = (s) => `<역할 지침>\n${s}\n</역할 지침>\n\n`;
const REFRESH = '역할 지침이 바뀌었어. 앞에서 받은 것 대신 아래를 따라.\n';
const isTalk = (p) => /\[회의 — (의견 내기|차례 발언|판정|결론 내기)/.test(p);
const SK = '\n## 스킬: ';
const h = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const group = (sc) => (sc === 'd-build' ? 'd(쌓기)' : sc === 'e-build' ? 'e(쌓기)' : sc);

function measure(calls, { moveSkills = false } = {}) {
  const convs = new Map();
  const rows = [];
  for (const c0 of calls) {
    const c = { ...c0 };
    if (moveSkills && c.system.includes(SK) && !isTalk(c.prompt)) {
      const at = c.system.indexOf(SK);
      const skills = c.system.slice(at + 1);
      c.system = c.system.slice(0, at);
      if (!c.resumeId || c.refresh) c.prompt = `${skills}\n\n${c.prompt}`;
    }
    const resumed = !!c.resumeId;
    const key = resumed ? c.resumeId : (c.sid || `new-${c.n}`);
    let conv = convs.get(key);
    if (!resumed || !conv) { conv = { accum: 0 }; convs.set(key, conv); }
    if (c.sid && c.sid !== key) convs.set(c.sid, conv);
    let sys = 0;
    if (c.provider === 'claude') sys = !resumed ? c.system.length : 0;
    else sys = !c.system ? 0 : !resumed ? WRAP(c.system).length : c.refresh ? REFRESH.length + WRAP(c.system).length : 0;
    const sent = sys + c.prompt.length;
    const ctx = resumed ? conv.accum : 0;
    conv.accum = ctx + sent + (c.out || '').length;
    rows.push({ ...c, resumed, sys, sent, ctx, talk: isTalk(c.prompt), skills: c.system.includes(SK) ? c.system.length - c.system.indexOf(SK) : 0 });
  }
  return rows;
}

function summarize(rows) {
  const by = {};
  for (const r of rows) {
    const g = group(r.scenario);
    const s = (by[g] ||= { calls: 0, fresh: 0, resumed: 0, sent: 0, sys: 0, prompt: 0, ctx: 0, skillsSent: 0, sysSeen: new Set(), write: 0, read: 0, variants: {} });
    s.calls++; s[r.resumed ? 'resumed' : 'fresh']++;
    s.sent += r.sent; s.sys += r.sys; s.prompt += r.prompt.length; s.ctx += r.ctx;
    if (!r.resumed) s.skillsSent += r.skills;
    if (r.provider === 'claude') {
      if (!r.resumed) { const k = h(r.system); if (s.sysSeen.has(k)) s.read += r.system.length; else { s.write += r.system.length; s.sysSeen.add(k); } }
      else s.write += r.sys;
      s.write += r.prompt.length;
      s.read += r.ctx;
    }
    if (!r.resumed && r.system) {
      const v = (s.variants[r.agent] ||= { all: new Set(), work: new Set(), talk: new Set(), n: 0 });
      v.n++; v.all.add(h(r.system)); v[r.talk ? 'talk' : 'work'].add(h(r.system));
    }
  }
  for (const s of Object.values(by)) {
    const vs = Object.values(s.variants);
    s.agents = vs.length;
    s.varAll = vs.reduce((n, v) => n + v.all.size, 0);
    s.multi = Object.entries(s.variants).filter(([, v]) => v.work.size > 1 || v.talk.size > 1).map(([a, v]) => `${a}(일 ${v.work.size}·회의 ${v.talk.size}, 새 대화 ${v.n})`);
    delete s.sysSeen;
  }
  return by;
}

const f = (n) => Number(n).toLocaleString('en-US');
const pct = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(Math.round(((a - b) / b) * 1000) / 10)}%` : '');
const before = summarize(measure(load(B)));
const after = summarize(measure(load(A)));
const altA = summarize(measure(load(A), { moveSkills: true }));
const out = [];
const P = (...x) => out.push(x.join(' '));
const order = ['a', 'a2', 'b', 'c', 'd(쌓기)', 'd1', 'd2', 'd3', 'e(쌓기)', 'e1', 'e2'];
P('글자 수(토큰 아님).');
P('');
P('| 장면 | 호출(새/이어감) 전→후 | 보낸 글 전 | 보낸 글 후 | 변화 | 이어 가며 다시 읽은 앞 대화 전 | 후 | 변화 | 처리한 글 합 전→후 | 시스템 지시 변형 수 전→후 (에이전트 수) |');
P('|---|---|---|---|---|---|---|---|---|---|');
for (const g of order) {
  const b = before[g], a = after[g];
  if (!b || !a) continue;
  P(`| ${g} | ${b.calls}(${b.fresh}/${b.resumed}) → ${a.calls}(${a.fresh}/${a.resumed}) | ${f(b.sent)} | ${f(a.sent)} | ${pct(a.sent, b.sent)} | ${f(b.ctx)} | ${f(a.ctx)} | ${pct(a.ctx, b.ctx)} | ${f(b.sent + b.ctx)} → ${f(a.sent + a.ctx)} (${pct(a.sent + a.ctx, b.sent + b.ctx)}) | ${b.varAll} → ${a.varAll} (${a.agents}) |`);
}
P('');
P('| 장면 | 전: 같은 종류(일/회의) 안에서 둘 이상으로 갈린 에이전트 | 후 |');
P('|---|---|---|');
for (const g of order) if (before[g] && after[g]) P(`| ${g} | ${before[g].multi.join(', ') || '없음'} | ${after[g].multi.join(', ') || '없음'} |`);
P('');
P('## 캐시 모형(Claude 호출만): 바꾼 뒤(B, 회의 말 차례용 시스템 지시를 따로 둠)와 비교안 A(스킬 본문을 프롬프트 앞머리로)');
P('| 장면 | B 새로 씀 | B 다시 읽기 | A 새로 씀 | A 다시 읽기 | 새 대화에 실린 스킬 본문 B / A |');
P('|---|---|---|---|---|---|');
for (const g of order) {
  const b = after[g], a = altA[g];
  if (!b) continue;
  P(`| ${g} | ${f(b.write)} | ${f(b.read)} | ${f(a.write)} | ${f(a.read)} | ${f(b.skillsSent)} / ${f(a.skillsSent)} |`);
}
P('');
P('## 캐시 모형 전→후');
P('| 장면 | 새로 씀 전→후 | 다시 읽기 전→후 | 새 대화에 실린 스킬 본문 전→후 |');
P('|---|---|---|---|');
for (const g of order) if (before[g] && after[g]) P(`| ${g} | ${f(before[g].write)} → ${f(after[g].write)} (${pct(after[g].write, before[g].write)}) | ${f(before[g].read)} → ${f(after[g].read)} (${pct(after[g].read, before[g].read)}) | ${f(before[g].skillsSent)} → ${f(after[g].skillsSent)} |`);
const text = out.join('\n');
if (OUTF) fs.writeFileSync(OUTF, text);
console.log(text);
