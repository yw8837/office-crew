// 진짜 AI CLI 차단 가드(OFFICE_CREW_FAKE_ONLY): 테스트 앱(startTestApp)에선 가짜 CLI 폴더 밖의 실행 파일을 띄우지 않는다.
// 과거 실수 재현: 새 데이터 폴더의 기본 팀(claude·codex 에이전트)으로 목표를 돌리면 PATH 의 진짜 CLI가 뜰 수 있었다.
// 진짜 CLI 대신 "PATH 에 있는 진짜 CLI 흉내"(실행되면 표시 파일만 남기는 node 스크립트)를 써서, 가드가 그걸 막는지 본다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { runQuick, clearResolveCache, fakeOnlyError, resolveCommand } from '../server/providers/util.js';
import { PROVIDERS } from '../server/providers/index.js';

let t = null;
const app = async () => (t ||= await startTestApp());
const decoyDirs = [];
after(async () => {
  if (t) { try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ } }
  for (const d of decoyDirs) fs.rmSync(d, { recursive: true, force: true });
});

const GUARD = /가짜 CLI만 허용된 실행\(OFFICE_CREW_FAKE_ONLY\)이라 진짜 (claude|codex) 명령을 띄우지 않았어/;

// 테스트 폴더 밖에 claude·codex 흉내를 만들고 PATH 맨 앞에 둔다(진짜 CLI가 PATH 에 있는 PC 와 같은 상황). 실행되면 ran-<이름>.txt 를 남긴다
function decoysFirstInPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-crew-decoy-'));
  decoyDirs.push(dir);
  for (const name of ['claude', 'codex']) {
    const script = `decoy-${name}.cjs`;
    fs.writeFileSync(path.join(dir, script), `require('fs').writeFileSync(require('path').join(__dirname, 'ran-${name}.txt'), 'ran');\n`);
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\nnode "%~dp0\\${script}" %*\r\n`);
    else { fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec node "$(dirname "$0")/${script}" "$@"\n`); fs.chmodSync(path.join(dir, name), 0o755); }
  }
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  clearResolveCache();
  const ran = () => ['claude', 'codex'].filter((n) => fs.existsSync(path.join(dir, `ran-${n}.txt`)));
  const restore = () => { process.env.PATH = before; clearResolveCache(); };
  return { dir, ran, restore };
}

// 가드를 잠깐 끈다(끝나면 원래 값으로)
async function guardOff(fn) {
  const saved = process.env.OFFICE_CREW_FAKE_ONLY;
  delete process.env.OFFICE_CREW_FAKE_ONLY;
  try { return await fn(); } finally { process.env.OFFICE_CREW_FAKE_ONLY = saved; }
}

test('1. startTestApp 이 가드를 켠다: 가짜 폴더 밖 실행 파일(node)은 거부, 가짜 claude 는 통과, 가드를 끄면 통과', async () => {
  await app();
  assert.equal(process.env.OFFICE_CREW_FAKE_ONLY, '1');
  assert.equal(process.env.OFFICE_CREW_FAKE_BIN, t.root);
  const node = await runQuick(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.equal(node.code, -1, '가드가 켜지면 node 를 띄우지 않는다');
  assert.match(node.err, /가짜 CLI만 허용된 실행/);
  const fake = await runQuick('claude', ['--version']);
  assert.equal(fake.code, 0, `가짜 claude 는 통과: ${fake.err}`);
  const off = await guardOff(() => runQuick(process.execPath, ['-e', 'process.stdout.write("hi")']));
  assert.deepEqual([off.code, off.out], [0, 'hi'], '가드가 꺼지면 그대로 실행');
});

test('2. 가드 값의 경계: 1 인데 폴더를 모르면 전부 막고, 폴더 경로를 값으로 줘도 되고, 0·빈 값은 꺼짐', async () => {
  await app();
  const saved = { only: process.env.OFFICE_CREW_FAKE_ONLY, bin: process.env.OFFICE_CREW_FAKE_BIN };
  const fakeClaude = resolveCommand('claude');
  try {
    delete process.env.OFFICE_CREW_FAKE_BIN;
    assert.ok(fakeOnlyError('claude', fakeClaude), '폴더를 모르면 가짜도 막는다(닫힌 쪽으로)');
    process.env.OFFICE_CREW_FAKE_ONLY = t.root;
    assert.equal(fakeOnlyError('claude', fakeClaude), null, '값이 폴더 경로면 그 폴더 안은 통과');
    assert.ok(fakeOnlyError('node', resolveCommand(process.execPath)), '그 폴더 밖은 거부');
    assert.ok(fakeOnlyError('claude', null), '찾지 못한 명령(로그인 터미널)도 거부');
    for (const v of ['0', '']) {
      process.env.OFFICE_CREW_FAKE_ONLY = v;
      assert.equal(fakeOnlyError('node', resolveCommand(process.execPath)), null, `값 "${v}" 은 꺼짐`);
    }
  } finally {
    process.env.OFFICE_CREW_FAKE_ONLY = saved.only;
    process.env.OFFICE_CREW_FAKE_BIN = saved.bin;
  }
});

test('3. CLI 감지(detect)도 같은 길이라 막힌다: PATH 의 진짜 claude·codex 흉내를 띄우지 않고 미설치로 본다', async () => {
  await app();
  const d = decoysFirstInPath();
  try {
    const claude = await PROVIDERS.claude.detect(t.app.store.settings);
    const codex = await PROVIDERS.codex.detect(t.app.store.settings);
    assert.deepEqual([claude.installed, codex.installed], [false, false]);
    assert.deepEqual(d.ran(), [], '흉내 CLI가 한 번도 실행되지 않음');
  } finally { d.restore(); }
});

test('4. 과거 실수 재현: 새 데이터 폴더의 기본 팀으로 목표를 돌려도 PATH 의 진짜 CLI가 뜨지 않고 가드 오류로 끝난다(가드를 끄면 뜬다)', async () => {
  await app();
  const team = t.app.store.get('teams', 'team-default');
  assert.ok(team, '새 데이터 폴더의 기본 팀');
  const providers = new Set(team.stages.flatMap((s) => s.agentIds).map((id) => t.app.store.get('agents', id)?.provider));
  assert.ok(providers.has('claude') && providers.has('codex'), '기본 팀은 진짜 claude·codex 에이전트');
  const d = decoysFirstInPath();
  const logBefore = t.fakeLog().length;
  const runGoal = async () => {
    const s = (await t.api('POST', '/api/sessions', { teamId: 'team-default' })).json;
    assert.equal((await t.api('PATCH', `/api/sessions/${s.id}`, { goalMode: true })).status, 200);
    await t.api('POST', `/api/sessions/${s.id}/messages`, { text: '이번 주 할 일을 정리해 줘' });
    const S = () => t.app.store.getSession(s.id);
    const agentMsgs = () => S().messages.filter((m) => m.role === 'agent');
    await t.waitFor(() => agentMsgs().length && agentMsgs().every((m) => m.status !== 'streaming') && !t.app.orch.ctx.has(s.id), 20000, '목표 실행 끝');
    return S().messages.filter((m) => m.role === 'agent');
  };
  try {
    const msgs = await runGoal();
    const errs = msgs.map((m) => m.error || '').filter(Boolean);
    assert.ok(errs.length && errs.every((e) => GUARD.test(e)), `가드 오류로 끝남: ${JSON.stringify(errs)}`);
    assert.deepEqual(d.ran(), [], 'PATH 맨 앞의 claude·codex 흉내가 한 번도 실행되지 않음');
    assert.equal(t.fakeLog().length, logBefore, '가짜 CLI도 뜨지 않음(가드가 띄우기 전에 막음)');
    // 대조: 같은 상황에서 가드를 끄면 PATH 의 CLI(여기선 흉내)가 실제로 뜬다 → 위 단정이 가드 덕분이라는 증거
    await guardOff(runGoal);
    assert.ok(d.ran().length > 0, `가드를 끄면 PATH 의 CLI가 뜸: ${JSON.stringify(d.ran())}`);
  } finally { d.restore(); }
});
