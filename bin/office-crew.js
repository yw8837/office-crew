#!/usr/bin/env node
// 오피스 크루 실행기: 서버를 켜고 앱 창(Edge/Chrome --app)을 연다
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../server/index.js';
import { PORT, homeDir, VERSION } from '../server/config.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (flag('help') || flag('h')) {
  console.log(`오피스 크루 ${VERSION}
사용법: office-crew [--port 4317] [--home 폴더] [--no-open] [--browser]
  --port     서버 포트(기본 ${PORT})
  --home     데이터 폴더(기본 ~/.office-crew)
  --no-open  창을 열지 않음
  --browser  앱 창 대신 기본 브라우저 탭으로 열기`);
  process.exit(0);
}

const port = Number(opt('port', PORT));
const home = opt('home', homeDir());

function findAppBrowser() {
  if (process.platform === 'win32') {
    const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    const cands = [];
    for (const b of pf) {
      cands.push(path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      cands.push(path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    return cands.find((f) => fs.existsSync(f)) || null;
  }
  if (process.platform === 'darwin') {
    const c = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    return c.find((f) => fs.existsSync(f)) || null;
  }
  for (const b of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    for (const d of (process.env.PATH || '').split(':')) if (fs.existsSync(path.join(d, b))) return path.join(d, b);
  }
  return null;
}

function openWindow(url) {
  const app = !flag('browser') && findAppBrowser();
  if (app) {
    spawn(app, [`--app=${url}`, '--window-size=1480,920', '--new-window'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const cmd = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
}

// 예상 못 한 예외가 나도 실행 중인 다른 작업까지 같이 죽지 않게: 기록만 남기고 계속 돈다
process.on('uncaughtException', (e) => console.error('[예외]', e?.stack || e));
process.on('unhandledRejection', (e) => console.error('[처리 안 된 Promise]', e?.stack || e));

const app = createApp({ home, port });
try {
  const p = await app.listen(port);
  const url = `http://127.0.0.1:${p}/`;
  console.log(`\n  🏢 오피스 크루 ${VERSION} 실행 중 → ${url}\n  데이터 폴더: ${home}\n  끄려면 이 창에서 Ctrl+C\n`);
  if (!flag('no-open')) openWindow(url);
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.log(`포트 ${port}가 이미 쓰이고 있어 → 이미 켜진 오피스 크루 창을 열게.`);
    if (!flag('no-open')) openWindow(`http://127.0.0.1:${port}/`);
    process.exit(0);
  }
  console.error('시작 실패:', e.message);
  process.exit(1);
}

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  console.log('\n종료 중…');
  await app.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
