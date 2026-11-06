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
  const map = { claude: 'fake-claude.js', codex: 'fake-codex.js', 'fake-acp': 'fake-acp.js' };
  for (const [name, script] of Object.entries(map)) {
    fs.copyFileSync(path.join(here, 'fake-cli', script), path.join(dir, script));
    if (process.platform === 'win32') fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\nnode "%~dp0\\${script}" %*\r\n`);
    else { fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec node "$(dirname "$0")/${script}" "$@"\n`); fs.chmodSync(path.join(dir, name), 0o755); }
  }
  // 가짜 스크립트가 ESM 으로 읽히게
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
}

export async function startTestApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-crew-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  installFakeClis(bin);
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
      const v = pred();
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
