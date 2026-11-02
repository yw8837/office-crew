// 경로·포트 등 전역 설정
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';
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

export function ensureDirs(dirs) {
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
}
