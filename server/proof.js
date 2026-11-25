// 만들기·글 카드의 "바꾼 파일" 대조(결정 0025): 카드 담당이 끝의 두 칸(결정 0018)에 적은 바꾼 파일을, 그 카드 단계가 도는 동안
// 작업 폴더에서 실제로 바뀐 파일과 대조한다. git 저장소일 때만(카드 단계 앞·뒤의 git 상태 차이와, 그 사이 커밋이 생겼으면 그 커밋의 파일).
// 경고만 한다: git 이 무시하는 파일·작업 폴더 밖 경로처럼 틀리게 볼 수 있어서 카드를 실패로 만들거나 다시 돌리지 않는다.
// git 호출은 하나마다 시간 상한(PROOF_TIMEOUT)이 있고, 넘으면 오케스트레이터가 그 실행에서는 대조를 끈다(느린 저장소에서 단계마다 기다리지 않게)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveCommand } from './providers/util.js';

export { tailFiles } from './mission.js'; // 꼬리의 "바꾼 파일" 칸 읽기(꼬리를 읽는 다른 함수와 같은 곳에 있다)

export const PROOF_TIMEOUT = 3000; // git 호출 하나의 시간 상한(ms)
export const PROOF_KINDS = ['build', 'write']; // 대조하는 카드 종류(만들기·글. 조사·확인 카드는 파일을 바꾸지 않아도 된다)
const STAT_MAX = 2000; // 수정 시각·크기를 볼 파일 수 상한(넘는 파일은 git 상태 글자만 본다)

// git 하나 부르기: 작업 폴더의 저장소 설정이 명령을 띄우지 못하게(core.fsmonitor) 끄고, 잠금 파일을 만들지 않고(--no-optional-locks), 경로는 따옴표 없이.
// git 은 PATH 에서 찾은 실행 파일의 전체 경로로(검수 자료의 바뀐 파일 목록과 같다). → { out } | { slow: true }(시간 상한을 넘음) | null(git 이 없거나 실패)
function git(cwd, args, timeout) {
  return new Promise((resolve) => {
    try {
      const g = resolveCommand('git');
      if (!g || g.shell || !path.isAbsolute(g.file)) return resolve(null);
      execFile(g.file, [...g.prefixArgs, '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'diff.relative=false', ...args],
        { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
          if (err) return resolve(err.killed || err.signal ? { slow: true } : null);
          resolve({ out: String(out ?? '') });
        });
    } catch { resolve(null); }
  });
}

// git status --porcelain -z 의 항목: [{ code(앞 두 글자), path(저장소 뿌리 기준) }]. 이름 바꾸기(R·C)는 뒤에 오는 원래 경로를 건너뛴다
function entries(out) {
  const parts = String(out || '').split('\0');
  const list = [];
  for (let k = 0; k < parts.length; k++) {
    const e = parts[k];
    if (e.length < 4) continue;
    list.push({ code: e.slice(0, 2), path: e.slice(3) });
    if (/^[RC]/.test(e) || /^.[RC]/.test(e)) k++;
  }
  return list;
}

// 작업 폴더의 git 상태 한 장: { prefix(작업 폴더의 저장소 안 위치, 'sub/' 꼴), root, head(커밋 id, 없으면 ''), files: Map(경로 → 상태 글자|수정 시각|크기), at(찍기 시작한 시각) }.
// git 이 아니거나 실패하면 null, 시간 상한을 넘으면 { slow: true }
export async function gitState(cwd, { timeout = PROOF_TIMEOUT } = {}) {
  const at = Date.now();
  const top = await git(cwd, ['rev-parse', '--show-prefix'], timeout);
  if (!top || top.slow) return top;
  const head = await git(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], timeout);
  if (head?.slow) return head;
  const st = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'], timeout);
  if (!st || st.slow) return st;
  const prefix = top.out.trim();
  const root = path.resolve(cwd, ...prefix.split('/').filter(Boolean).map(() => '..'));
  const files = new Map();
  entries(st.out).forEach((e, k) => {
    let sig = e.code;
    if (k < STAT_MAX) { try { const s = fs.statSync(path.join(root, e.path)); sig += `|${Math.round(s.mtimeMs)}|${s.size}`; } catch { sig += '|-'; } }
    files.set(e.path, sig);
  });
  return { prefix, root, head: head?.out.trim() || '', files, at };
}

// 두 커밋 사이에 바뀐 파일(저장소 뿌리 기준). 카드가 돈 사이에 커밋을 했으면 git 상태만으로는 안 보이는 변경. → { names } | { slow: true } | null
export async function gitDiffNames(cwd, a, b, { timeout = PROOF_TIMEOUT } = {}) {
  const r = await git(cwd, ['diff', '--name-only', '-z', a, b], timeout);
  if (!r || r.slow) return r;
  return { names: r.out.split('\0').filter(Boolean) };
}

// 두 상태 사이에 바뀐 파일: 새로 생기거나 없어졌거나, 상태 글자·수정 시각·크기가 달라진 파일(원래 고쳐져 있던 파일을 또 고친 것도), 그리고 extra(커밋으로 넘어간 파일)
export function changedSet(before, after, extra = []) {
  const out = new Set(extra);
  for (const [p, sig] of after.files) if (before.files.get(p) !== sig) out.add(p);
  for (const p of before.files.keys()) if (!after.files.has(p)) out.add(p);
  return out;
}

// 카드 하나 대조: claimed(꼬리에 적은 경로, 적은 그대로), changed(바뀐 파일, 저장소 뿌리 기준), cwd(작업 폴더), prefix(작업 폴더의 저장소 안 위치),
// own(이 카드가 맡은 파일·폴더, 계획의 files), others(같은 단계의 다른 카드들이 맡은 files), touched(절대 경로 → 그 사이에 고친 흔적이 있나: git 이 무시하는 파일을 위해).
// → 'ok'(적은 파일 가운데 이 카드 몫으로 바뀐 게 있다) | 'missing'(적은 파일이 하나도 안 바뀌었다) | 'skip'(판단하지 않는다: 적은 게 없음, 작업 폴더 밖 경로가 섞임,
// 바뀐 파일이 같은 단계의 다른 카드 몫이라 누가 바꿨는지 가를 수 없음)
export function proofCheck({ claimed = [], changed = new Set(), cwd = '', prefix = '', own = [], others = [], touched = null } = {}) {
  const norm = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '').toLowerCase();
  const done = [...changed].map(norm);
  const under = (p, scope) => { const s = norm(scope); return !s || s === '.' || p === s || p.startsWith(`${s}/`); };
  let inside = 0;
  let hit = 0;
  let unsure = false;
  for (const c of claimed) {
    let rel = String(c).replace(/\\/g, '/');
    if (path.isAbsolute(String(c)) || /^[A-Za-z]:/.test(rel)) {
      const r = path.relative(cwd, path.resolve(String(c)));
      if (!r || r.startsWith('..') || path.isAbsolute(r)) { unsure = true; continue; } // 작업 폴더 밖
      rel = r.replace(/\\/g, '/');
    } else if (rel.startsWith('../')) { unsure = true; continue; }
    inside++;
    const mine = norm(rel);
    const p = norm(prefix + mine);
    const was = done.some((x) => x === p || x.startsWith(`${p}/`)) || (!!touched && touched(path.join(cwd, mine)));
    if (!was) continue;
    // 바뀐 곳이 같은 단계의 다른 카드가 맡은 곳이고 이 카드가 맡은 곳이 아니면 누가 바꿨는지 가를 수 없다
    if (others.some((fs2) => (fs2 || []).some((f) => under(mine, f))) && !own.some((f) => under(mine, f))) unsure = true;
    else hit++;
  }
  if (!inside) return 'skip';
  if (hit) return 'ok';
  return unsure ? 'skip' : 'missing';
}
