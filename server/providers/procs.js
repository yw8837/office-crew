// 앱이 비정상으로 꺼져도(강제 종료·전원) 띄워 둔 CLI가 남아 사용량을 쓰지 않게, 실행 중인 CLI를 파일에 적어 두고 다음 시작 때 정리한다.
// 파일은 앱 프로세스마다 하나(<pid>.json). 다른 앱이 아직 살아 있으면 그 파일은 건드리지 않는다
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';
const SAME_START_MS = 15000; // 적어 둔 시작 시각과 이만큼 다르면 PID 만 재사용된 다른 프로그램으로 본다

let dir = null;
const live = new Map();

function save() {
  if (!dir) return;
  const file = path.join(dir, `${process.pid}.json`);
  try {
    if (live.size) fs.writeFileSync(file, JSON.stringify([...live.values()]));
    else fs.rmSync(file, { force: true });
  } catch { /* 기록 실패가 실행을 막지는 않는다 */ }
}

export function initProcTracker(d) {
  dir = d;
  fs.mkdirSync(d, { recursive: true });
}

export function trackChild(child, name) {
  if (!dir || !child?.pid) return;
  const { pid } = child;
  live.set(pid, { pid, name: String(name), at: Date.now() });
  save();
  child.once('exit', () => { live.delete(pid); save(); });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// CLI 를 돌리고 있는 다른 앱이 살아 있는지(이 데이터 폴더를 함께 쓰는 경우)
export function otherAppRunning(d) {
  try {
    return fs.readdirSync(d).some((f) => /^\d+\.json$/.test(f) && Number(f.slice(0, -5)) !== process.pid && isAlive(Number(f.slice(0, -5))));
  } catch { return false; }
}

// { startedAt(ms), cmd } | null. 살아 있는 프로세스의 시작 시각과 명령줄
export function procInfo(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  if (isWin) {
    const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${n}"; if($p){$p.CreationDate.ToUniversalTime().ToString('o'); $p.CommandLine}`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const [when, ...rest] = String(r.stdout || '').split(/\r?\n/);
    const startedAt = Date.parse(when);
    return Number.isNaN(startedAt) ? null : { startedAt, cmd: rest.join(' ') };
  }
  const r = spawnSync('ps', ['-o', 'lstart=,args=', '-p', String(n)], { encoding: 'utf8', timeout: 5000 });
  const line = String(r.stdout || '').trim();
  const startedAt = Date.parse(line.slice(0, 24));
  return !line || Number.isNaN(startedAt) ? null : { startedAt, cmd: line.slice(24) };
}

function killPid(pid) {
  try {
    if (isWin) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    else { try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); } }
  } catch { /* 이미 끝남 */ }
}

// 죽은 앱이 남긴 기록을 보고, 아직 도는 CLI를 끈다. 시작 시각과 이름이 둘 다 맞을 때만 끈다(PID 재사용으로 남의 프로그램을 끄지 않게). 끈 개수를 돌려준다
export function reapLeftovers(d, { info = procInfo, kill = killPid } = {}) {
  let files = [];
  try { files = fs.readdirSync(d).filter((f) => /^\d+\.json$/.test(f)); } catch { return 0; }
  let killed = 0;
  for (const f of files) {
    const owner = Number(f.slice(0, -5));
    if (owner === process.pid || isAlive(owner)) continue;
    const file = path.join(d, f);
    let list = [];
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 깨진 기록은 지운다 */ }
    for (const p of Array.isArray(list) ? list : []) {
      if (!Number.isInteger(p?.pid) || !isAlive(p.pid)) continue;
      const cur = info(p.pid);
      if (!cur || Math.abs(cur.startedAt - p.at) > SAME_START_MS) continue;
      if (!String(cur.cmd).toLowerCase().includes(String(p.name).toLowerCase())) continue;
      kill(p.pid);
      killed++;
    }
    fs.rmSync(file, { force: true });
  }
  return killed;
}
