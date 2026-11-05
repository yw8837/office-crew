// 경로·포트 등 전역 설정
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.1.0';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.OFFICE_CREW_PORT || process.env.PORT || 4317);

export function homeDir() {
  return process.env.OFFICE_CREW_HOME || path.join(os.homedir(), '.office-crew');
}

export function dataDirs(home = homeDir()) {
  return {
    home,
    sessions: path.join(home, 'sessions'),
    uploads: path.join(home, 'uploads'),
    workspaces: path.join(home, 'workspaces'),
    skills: path.join(home, 'skills'),
    tmp: path.join(home, 'tmp'),
  };
}

// 에이전트에게 맡기면 위험한 작업 폴더인지: 드라이브 맨 위, 홈 폴더 자체나 그 위, 앱 데이터 폴더(계정 로그인 폴더가 들어 있다) 안이나 그걸 품는 폴더.
// 앱이 세션마다 만드는 작업 폴더(workspaces)는 괜찮다
export function unsafeWorkdir(dir, appHome = homeDir()) {
  const norm = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* 없는 폴더는 그대로 비교 */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const within = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  const d = norm(dir);
  const app = norm(appHome);
  if (d === path.parse(d).root) return true;
  if (within(norm(os.homedir()), d)) return true;
  if (within(d, norm(path.join(appHome, 'workspaces')))) return false;
  return within(d, app) || within(app, d);
}

export function ensureDirs(dirs) {
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
}
