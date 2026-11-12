// 저장공간: 데이터 폴더 용량 보기 + 확인 후 정리(안 쓰는 첨부, 주인 없는 작업 폴더, 오래된 세션)
import fs from 'node:fs';
import path from 'node:path';
import { tr } from './i18n.js';

async function dirSize(dir) {
  let bytes = 0, count = 0;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return { bytes, count }; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = await dirSize(p); bytes += r.bytes; count += r.count; }
    else { try { bytes += (await fs.promises.stat(p)).size; count++; } catch { /* 사라짐 */ } }
  }
  return { bytes, count };
}

// 세션 파일 안에서 참조되는 첨부 id 모으기(본문을 메모리에 올리지 않고 문자열 검색)
async function referencedUploads(dirs) {
  const ids = new Set();
  for (const f of await fs.promises.readdir(dirs.sessions)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const text = await fs.promises.readFile(path.join(dirs.sessions, f), 'utf8');
      for (const m of text.matchAll(/"id":"(up-[a-z0-9]+)"/g)) ids.add(m[1]);
    } catch { /* 깨진 파일 무시 */ }
  }
  return ids;
}

async function unusedUploads(dirs) {
  const used = await referencedUploads(dirs);
  const out = [];
  for (const f of await fs.promises.readdir(dirs.uploads)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if (used.has(id)) continue;
    let meta = {};
    try { meta = JSON.parse(await fs.promises.readFile(path.join(dirs.uploads, f), 'utf8')); } catch { /* 메타 깨짐 */ }
    const file = path.join(dirs.uploads, path.basename(String(meta.path || '')));
    let size = 0;
    try { size = (await fs.promises.stat(file)).size; } catch { /* 원본 없음 */ }
    // 방금 올리고 아직 안 보낸 첨부는 남긴다(1시간)
    if (Date.now() - (meta.createdAt || 0) < 3600_000) continue;
    out.push({ id, files: [path.join(dirs.uploads, f), file], bytes: size });
  }
  return out;
}

async function orphanWorkspaces(dirs, store) {
  const out = [];
  let names = [];
  try { names = await fs.promises.readdir(dirs.workspaces); } catch { return out; }
  for (const n of names) {
    if (store.hasSession(n)) continue;
    const p = path.join(dirs.workspaces, n);
    out.push({ id: n, dir: p, bytes: (await dirSize(p)).bytes });
  }
  return out;
}

function oldSessions(store, days) {
  const cut = Date.now() - days * 86400_000;
  return store.listSessions().filter((m) => !m.pinned && !m.running && m.updatedAt < cut);
}

export async function storageReport(dirs, store) {
  const [sessions, uploads, workspaces, tmp, handoff] = await Promise.all([dirSize(dirs.sessions), dirSize(dirs.uploads), dirSize(dirs.workspaces), dirSize(dirs.tmp), dirSize(dirs.handoff)]);
  const unused = await unusedUploads(dirs);
  const orphans = await orphanWorkspaces(dirs, store);
  return {
    home: dirs.home,
    total: sessions.bytes + uploads.bytes + workspaces.bytes + tmp.bytes + handoff.bytes,
    handoff, // 다른 AI에게 건네려고 적어 둔 대화(세션을 지우면 같이 지워진다)
    sessions: { ...sessions, count: store.listSessions().length, old90: oldSessions(store, 90).length },
    uploads: { ...uploads, count: Math.round(uploads.count / 2), unused: { count: unused.length, bytes: unused.reduce((a, x) => a + x.bytes, 0) } },
    workspaces: { ...workspaces, orphan: { count: orphans.length, bytes: orphans.reduce((a, x) => a + x.bytes, 0) } },
    tmp,
    memory: { rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed, cachedSessions: store.sessions.size },
  };
}

export async function cleanup(dirs, store, { target, days = 90 }) {
  let freed = 0, removed = 0;
  if (target === 'uploads-unused') {
    for (const u of await unusedUploads(dirs)) { for (const f of u.files) fs.rmSync(f, { force: true }); freed += u.bytes; removed++; }
  } else if (target === 'workspaces-orphan') {
    for (const w of await orphanWorkspaces(dirs, store)) { fs.rmSync(w.dir, { recursive: true, force: true }); freed += w.bytes; removed++; }
  } else if (target === 'sessions-older') {
    const d = Math.max(1, Number(days) || 90);
    for (const m of oldSessions(store, d)) {
      try { freed += fs.statSync(path.join(dirs.sessions, `${m.id}.json`)).size; } catch { /* 없음 */ }
      store.deleteSession(m.id);
      removed++;
    }
  } else if (target === 'tmp') {
    for (const f of fs.readdirSync(dirs.tmp)) { freed += (await dirSize(path.join(dirs.tmp, f))).bytes; fs.rmSync(path.join(dirs.tmp, f), { recursive: true, force: true }); removed++; }
  } else throw new Error(tr('모르는 정리 대상'));
  return { freed, removed };
}
