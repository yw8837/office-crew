// 프로젝트 기억: 원문을 잃지 않고, 출처를 붙여, 정해진 양만 꺼내고, 관련 없으면 비운다(AI 호출 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectMemory, MemoryStore, tokenize, split, projectKey, CHUNK_CHARS } from '../server/memory.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mem-'));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 윈도우 파일 잠금 무시 */ } };

// 서로 다른 낱말로 된 가짜 문장(검색에 걸리지 않는 배경 글)
function filler(seed, words = 120) {
  let x = seed * 2654435761 % 4294967296;
  const out = [];
  for (let i = 0; i < words; i++) { x = (x * 1664525 + 1013904223) % 4294967296; out.push(`w${(x % 5000).toString(36)}`); }
  return out.join(' ');
}

test('낱말 나누기: 영문은 낱말, 한글·한자·가나는 두 글자씩', () => {
  assert.deepEqual(tokenize('Deploy 서버를 재시작'), ['deploy', '서버', '버를', '재시', '시작']);
  assert.deepEqual(tokenize('orchestrator.js:42 수'), ['orchestrator', 'js', '42', '수']);
  assert.ok(tokenize('データベース設計').includes('デー'));
});

test('조각 나누기: 문단 경계를 쓰고, 어떤 조각도 상한을 넘지 않고, 글자를 잃지 않는다', () => {
  const text = `${'가'.repeat(700)}\n${'나'.repeat(700)}\n${'다'.repeat(2500)}`;
  const parts = split(text);
  assert.ok(parts.every((p) => p.length <= CHUNK_CHARS));
  assert.equal(parts.join('').replace(/\n/g, '').length, 3900);
});

test('심어 둔 사실을 배경 글 속에서 찾고, 원문과 출처가 그대로 돌아온다', async () => {
  const dir = tmp();
  const m = new ProjectMemory(dir);
  for (let i = 0; i < 300; i++) await m.add(filler(i), { sessionId: `s${i % 7}`, messageId: `m${i}`, role: 'agent', agentId: 'researcher', at: 1000 + i });
  const fact = '결제 서버 포트는 8443이고 배포는 매주 화요일 오전에 한다. 담당은 정리왕.';
  await m.add(fact, { sessionId: 's-pay', messageId: 'm-pay', role: 'agent', agentId: 'organizer', provider: 'codex', at: 5000, title: '결제 개편' });
  for (let i = 300; i < 600; i++) await m.add(filler(i), { sessionId: `s${i % 7}`, messageId: `m${i}`, role: 'agent', at: 6000 + i });
  await m.flush();
  const r = await m.search('결제 서버 포트가 몇 번이었지?');
  assert.ok(r.hits.length >= 1, '찾은 조각이 있어야 한다');
  const top = r.hits[0];
  assert.equal(top.text, fact, '요약이 아니라 원문 그대로');
  assert.deepEqual([top.sessionId, top.messageId, top.agentId, top.provider, top.at, top.title], ['s-pay', 'm-pay', 'organizer', 'codex', 5000, '결제 개편']);
  rm(dir);
});

test('관련된 게 없으면 빈 결과(억지로 채우지 않는다)', async () => {
  const dir = tmp();
  const m = new ProjectMemory(dir);
  for (let i = 0; i < 200; i++) await m.add(filler(i), { messageId: `m${i}` });
  await m.flush();
  assert.equal((await m.search('우주선 발사 일정과 궤도 계산')).hits.length, 0);
  assert.equal((await m.search('')).hits.length, 0);
  // 한글 배경 글이 있으면 흔한 두 글자 조각이 우연히 맞는다. 그래도 요청의 핵심 낱말이 기억에 없으면 비워야 한다
  const KO = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후기니디리미비시이지치키티피히'.split('');
  let x = 7;
  const ko = () => Array.from({ length: 100 }, () => { x = (x * 1664525 + 1013904223) % 4294967296; const a = KO[x % KO.length]; x = (x * 1664525 + 1013904223) % 4294967296; return a + KO[x % KO.length]; }).join(' ');
  for (let i = 0; i < 300; i++) await m.add(ko(), { messageId: `k${i}` });
  await m.flush();
  let empty = 0;
  for (let i = 0; i < 30; i++) if (!(await m.search(`zz${i}qq 우주선 발사 궤도 계산 일정 nope${i}`)).hits.length) empty++;
  assert.equal(empty, 30, `없는 내용을 30번 물어 ${empty}번만 비었다`);
  rm(dir);
});

test('꺼내는 양은 기억이 커져도 상한을 넘지 않는다', async () => {
  const dir = tmp();
  const m = new ProjectMemory(dir);
  for (let i = 0; i < 400; i++) await m.add(`배포 절차 ${i}번: 서버를 재시작하고 로그를 확인한다. ${filler(i, 60)}`, { messageId: `m${i}` });
  await m.flush();
  for (const budget of [500, 1500, 3000]) {
    const r = await m.search('배포 절차와 서버 재시작', { budget, limit: 50 });
    assert.ok(r.hits.length >= 1);
    assert.ok(r.chars <= budget, `${budget}자 상한인데 ${r.chars}자`);
  }
  rm(dir);
});

test('고쳐진 사실은 둘 다 남고 시각으로 구별된다(덮어쓰지 않는다)', async () => {
  const dir = tmp();
  const m = new ProjectMemory(dir);
  await m.add('관리자 화면 주소는 admin.example.test/v1 이다.', { messageId: 'old', at: 1000 });
  for (let i = 0; i < 100; i++) await m.add(filler(i), { messageId: `m${i}`, at: 2000 + i });
  await m.add('관리자 화면 주소가 admin.example.test/v2 로 바뀌었다.', { messageId: 'new', at: 9000 });
  await m.flush();
  const r = await m.search('관리자 화면 주소', { limit: 5 });
  const ids = r.hits.map((h) => h.messageId);
  assert.ok(ids.includes('old') && ids.includes('new'), `둘 다 있어야 한다: ${ids}`);
  assert.ok(r.hits.find((h) => h.messageId === 'new').at > r.hits.find((h) => h.messageId === 'old').at);
  rm(dir);
});

test('흔한 토큰 모양은 저장 전에 가린다', async () => {
  const dir = tmp();
  const m = new ProjectMemory(dir);
  await m.add('배포 키는 sk-abcdefgh12345678 이고 주소는 https://x.test/?token=zzzsecret 이야', { messageId: 'k' });
  await m.flush();
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.ok(!all.includes('abcdefgh12345678') && !all.includes('zzzsecret'), '원문 파일에 비밀이 남으면 안 된다');
  rm(dir);
});

test('쓰다가 꺼져도: 다시 열면 색인이 뒤처진 만큼 채워지고, 이어서 쓴 조각도 제자리에서 읽힌다', async () => {
  const dir = tmp();
  const a = new ProjectMemory(dir);
  for (let i = 0; i < 20; i++) await a.add(filler(i), { messageId: `m${i}` });
  await a.add('백업은 매일 새벽 세 시에 돈다.', { messageId: 'backup' });
  // flush 없이 버린다 = 색인과 meta 가 디스크에 없는 상태로 꺼진 것
  const b = new ProjectMemory(dir);
  await b.open();
  assert.equal(b.stats().chunks, a.stats().chunks);
  assert.equal((await b.search('백업 새벽')).hits[0]?.messageId, 'backup');
  await b.add('복구 연습은 분기마다 한 번 한다.', { messageId: 'restore' });
  await b.flush();
  assert.equal((await b.search('복구 연습 분기')).hits[0]?.text, '복구 연습은 분기마다 한 번 한다.');
  // 색인을 통째로 지워도 원문에서 다시 만든다
  fs.rmSync(path.join(dir, 'idx'), { recursive: true, force: true });
  const c = new ProjectMemory(dir);
  await c.rebuild();
  assert.equal((await c.search('백업 새벽')).hits[0]?.messageId, 'backup');
  rm(dir);
});

test('뺄 조각 고르기(예: 로컬 모델 대화는 클라우드 AI에게 안 준다)', async () => {
  const dir = tmp();
  const m = new ProjectMemory(dir);
  await m.add('사내 급여 테이블 구조는 pay_grade 와 pay_step 이다.', { messageId: 'local', provider: 'local' });
  await m.add('급여 테이블 화면은 다음 주에 손본다.', { messageId: 'cloud', provider: 'claude' });
  await m.flush();
  const r = await m.search('급여 테이블 구조', { exclude: (c) => c.provider === 'local' });
  assert.deepEqual(r.hits.map((h) => h.messageId), ['cloud']);
  rm(dir);
});

test('작업 폴더마다 기억이 따로다', async () => {
  const root = tmp();
  const store = new MemoryStore(root);
  const a = await store.of('/work/shop'), b = await store.of('/work/blog');
  await a.add('상점 프로젝트는 결제 모듈을 먼저 만든다.', { messageId: 'a' });
  await b.add('블로그 프로젝트는 글 목록을 먼저 만든다.', { messageId: 'b' });
  assert.deepEqual((await a.search('프로젝트 먼저 만든다')).hits.map((h) => h.messageId), ['a']);
  assert.equal(await store.of('/work/shop/'), a, '끝의 / 는 같은 폴더');
  assert.notEqual(projectKey('/work/shop'), projectKey('/work/blog'));
  assert.ok(!fs.readdirSync(root).some((n) => n.includes('shop')), '폴더 이름에 경로를 쓰지 않는다');
  await store.close();
  rm(root);
});
