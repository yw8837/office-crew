// 테스트 공통: 임시 데이터 폴더 + 가짜 CLI를 PATH 맨 앞에 두고 앱을 띄운다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { clearResolveCache } from '../server/providers/util.js';
import net from 'node:net';

// fetch(undici)가 막는 포트(WHATWG "bad ports")를 피해서 빈 포트를 고른다(OS 가 우연히 그런 포트를 주면 테스트가 실패함)
const BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
export async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
    });
    if (!BAD_PORTS.has(port)) return port;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function installFakeClis(dir) {
  const map = { claude: 'fake-claude.js', codex: 'fake-codex.js', gemini: 'fake-gemini.js', 'fake-acp': 'fake-acp.js' };
  for (const [name, script] of Object.entries(map)) {
    fs.copyFileSync(path.join(here, 'fake-cli', script), path.join(dir, script));
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\nnode "%~dp0\\${script}" %*\r\n`);
    else { fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec node "$(dirname "$0")/${script}" "$@"\n`); fs.chmodSync(path.join(dir, name), 0o755); }
  }
  // 가짜 스크립트가 ESM 으로 읽히게
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  // 이 프로세스에선 이 폴더 밖의 CLI를 띄우지 못하게 한다(진짜 AI CLI 차단. server/providers/util.js 의 fakeOnlyError)
  process.env.OFFICE_CREW_FAKE_ONLY = '1';
  process.env.OFFICE_CREW_FAKE_BIN = dir;
}

// 조건이 참(truthy)이 될 때까지 기다린다. 시간이 넘으면 무엇을 기다렸는지와 마지막 상태를 담아 실패한다.
// 고정 시간 잠자기(await sleep(300) 등) 대신 이걸 쓴다(test/hygiene.test.js 의 잠자기 개수 기준값)
export async function waitFor(cond, { timeout = 15000, interval = 25, what = '조건' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try { last = await cond(); } catch (e) { last = e; } // 조건이 던진 오류도 마지막 상태로 남긴다
    if (last && !(last instanceof Error)) return last;
    if (Date.now() - t0 > timeout) {
      let shown;
      try { shown = last instanceof Error ? `${last.name}: ${last.message}` : JSON.stringify(last); } catch { shown = String(last); }
      throw new Error(`${what} 대기 시간 초과(${timeout}ms). 마지막 상태: ${String(shown).slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// 새 대화의 첫 프롬프트 맨 앞에는 호출마다 달라지는 지시가 붙는다(결정 0023: 그 실행만 읽기 전용인 차례의 권한 문장, 규칙 파일 읽기, 묻기 안내, 역할 노트의 참고 블록).
// 그 덩어리는 빈 줄 없이 이어지고 빈 줄 하나로 본문과 갈린다. 본문의 모양을 보는 테스트는 이걸로 덩어리를 떼고 본다(덩어리 자체는 test/prompt-assembly.test.js 가 본다)
const HEAD_STARTS = ['권한: ', '이번 조사는 도구 없이', '작업 폴더에 CLAUDE.md', '사용자에게 묻기:', '아래 "참고 '];
export function promptBody(p) {
  const s = String(p ?? '');
  if (!HEAD_STARTS.some((h) => s.startsWith(h))) return s;
  const at = s.indexOf('\n\n');
  return at < 0 ? s : s.slice(at + 2);
}

// 가상 AI(mock, 사용량 0) 에이전트 넷과 그 팀을 API로 만든다. 첫 실행 데이터에는 이제 가상 에이전트가 없어서(결정 0021) 필요한 테스트가 직접 만든다.
// 모양은 예전 데모 팀과 같다: 조사 → 정리·분석(둘이 병렬, 끝나면 승인 대기) → 빌드. id 는 고정이라 테스트가 이름 대신 id 로 가리킨다
export const MOCK = { team: 'team-mock', researcher: 'mock-researcher', organizer: 'mock-organizer', analyst: 'mock-analyst', builder: 'mock-builder' };
export async function addMockTeam(api) {
  const agent = async (id, name, role, effort, permission = 'plan') => {
    const r = await api('POST', '/api/agents', { id, name, role, provider: 'mock', model: 'mock-fast', effort, permission, routing: 'manual', skills: [], connectors: [] });
    if (r.status !== 200 || r.json?.id !== id) throw new Error(`가상 에이전트 ${id} 를 만들지 못했어: ${r.status} ${r.text}`);
  };
  await agent(MOCK.researcher, '가상 조사봇', '조사', 'medium');
  await agent(MOCK.organizer, '가상 정리봇', '정리', 'medium');
  await agent(MOCK.analyst, '가상 분석봇', '분석', 'high');
  await agent(MOCK.builder, '가상 빌드봇', '빌드', 'xhigh', 'edit');
  const r = await api('POST', '/api/teams', {
    id: MOCK.team, name: '가상 팀 (사용량 0)',
    stages: [
      { label: '조사', agentIds: [MOCK.researcher] },
      { label: '정리·분석', agentIds: [MOCK.organizer, MOCK.analyst], approve: true },
      { label: '빌드', agentIds: [MOCK.builder] },
    ],
  });
  if (r.status !== 200 || r.json?.id !== MOCK.team) throw new Error(`가상 팀을 만들지 못했어: ${r.status} ${r.text}`);
  return MOCK;
}

export async function startTestApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-crew-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  installFakeClis(bin);
  // 가드가 허용하는 폴더를 이 테스트 전용 임시 폴더 전체로 넓힌다(테스트가 여기에 직접 만든 .cmd 같은 도우미 스크립트도 띄울 수 있게).
  // 진짜 CLI는 이 폴더에 있을 수 없으니 막는 힘은 같다
  process.env.OFFICE_CREW_FAKE_BIN = root;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_LOG = path.join(root, 'fake.log');
  clearResolveCache();
  // 실제 gemini·hermes 등 CLI 탐지는 하지 않는다(테스트 중 실제 명령 실행 0)
  // 개발 PC 의 실제 ~/.codex·~/.claude(한도·대화 기록)를 테스트가 읽지 않게 임시 폴더로(테스트가 직접 정한 임시 폴더는 그대로)
  for (const [k, d] of [['CODEX_HOME', 'codex-home'], ['CLAUDE_CONFIG_DIR', 'claude-home']]) {
    if (!process.env[k] || !path.resolve(process.env[k]).startsWith(path.resolve(os.tmpdir()))) process.env[k] = path.join(root, d);
  }
  // 첫 실행 기본 데이터는 OS 언어로 만들어지므로, 테스트(한국어 원문 검사)는 한국어로 고정한다
  process.env.LANG = 'ko_KR.UTF-8';
  const app = createApp({ home: path.join(root, 'home'), port: 0, detect: false });
  const port = await app.listen(await freePort());
  app.store.settings.mockSpeed = 0.05;
  // 테스트는 한국어 문구(원문)를 검사하므로 서버 언어를 한국어로 고정한다(OS 언어와 무관하게)
  app.store.settings.lang = 'ko';
  const events = [];
  // SSE 처럼 보낸 순간의 값을 복사해 둔다(같은 객체가 나중에 바뀌어도 기록은 그대로)
  app.bus.on((type, data) => events.push({ type, data: structuredClone(data), at: Date.now() }));
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, {
      method, headers: { 'Content-Type': 'application/json', 'X-Office-Token': app.token, ...headers },
      body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 비JSON */ }
    return { status: r.status, json, text };
  };
  const waitFor = async (pred, ms = 15000, label = '조건') => {
    const t0 = Date.now();
    for (;;) {
      const v = await pred(); // 조건이 비동기여도 그 결과를 본다(Promise 자체는 늘 참이라 기다리지 않고 지나간다)
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`${label} 대기 시간 초과`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const fakeLog = () => { try { return fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return {
    app, port, base, api, events, waitFor, fakeLog, root,
    async close() { await app.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
