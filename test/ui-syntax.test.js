// 화면 JS 파일이 브라우저에서 모듈로 읽히는지(문법 오류 하나면 앱 전체가 "준비 중"에서 멈춘다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('every UI script parses as a module', () => {
  const files = jsFiles(root);
  assert.ok(files.length > 10, `found ${files.length} UI scripts`);
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(f), encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${path.relative(root, f)}: ${String(r.stderr).split('\n').slice(0, 4).join(' ')}`);
  }
  assert.deepEqual(bad, []);
});
