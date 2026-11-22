// 저장소 위생: 반복된 실수를 글 지시 대신 검사로 막는다.
// (1) 추적 파일에 개인 정보(사용자 폴더 경로·개인 메일·로컬 드라이브 경로)와 내부 작업 흔적(.omc 경로, 내부 설계 번호, 내부 계획 문서 이름)이 없는지
// (2) 테스트의 고정 시간 잠자기 개수가 기준값(test/hygiene-baseline.json)보다 늘지 않는지(줄이는 건 환영, 기준값을 낮춘다)
// 예시 문자열은 이 파일 자체가 검사에 걸리지 않게 조각을 이어 붙여 만든다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = path.join(root, 'test', 'hygiene-baseline.json');

// 규칙: id, 정규식(g), 고치는 법, (선택) 이 규칙을 적용하지 않는 파일
const RULES = [
  // 자리 표시(<name>·%USERNAME%·…)와 누구의 것도 아닌 이름(GitHub Actions 의 RUNNER~1·runneradmin, Public, Default)은 허용
  { id: 'windows-user-folder', re: /\b[A-Za-z]:[\\/]+Users[\\/]+(?![\\/])(?![<%{$~]|…|\.\.\.|(?:RUNNER~1|runneradmin|Public|Default)(?![\w~]))[^\\/\s'"`)]+/gi, fix: '로컬 사용자 폴더 경로야. "~" 나 "<home>" 같은 자리 표시로 바꿔' },
  { id: 'mac-user-folder', re: /\/Users\/(?![<%{$~]|…|\.\.\.)[^\s/'"`)]+/g, fix: '로컬 사용자 폴더 경로야. "~" 나 "/Users/<name>" 같은 자리 표시로 바꿔' },
  { id: 'hangul-user-folder', re: /Users[\\/]+[가-힣]/g, fix: '한글 이름 사용자 폴더 경로야. 자리 표시로 바꿔' },
  // C 가 아닌 드라이브는 개인 PC 의 작업 폴더일 때가 많다. 예시용 첫 폴더 이름(proj·work·repo·src·tmp 등)은 허용
  { id: 'local-drive-path', re: /\b[D-Zd-z]:[\\/]+(?![\\/])(?!(?:proj|projects?|work|repo|src|code|tmp|temp|dev|data|example)(?![\w-]))[^\s'"`)]*/g, fix: 'C 가 아닌 드라이브의 절대 경로(개인 PC 의 작업 폴더)야. 상대 경로나 "D:/proj" 같은 예시 경로로 바꿔' },
  { id: 'personal-email', re: /[\w.+-]+@(?:gmail|googlemail|naver|daum|hanmail|kakao|nate|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail)\.[a-z]{2,}(?:\.[a-z]{2,})?\b/gi, fix: '개인 메일 주소야. noreply 주소나 example.com·example.test 예시로 바꿔' },
  { id: 'omc-path', re: /\.omc[\\/]/g, skip: (f) => f === '.gitignore', fix: '.omc 는 개인 작업 폴더라 저장소에 경로를 남기지 마. 내용이 필요하면 docs/decisions 에 결정으로 옮겨' },
  { id: 'design-number', re: /설계\s*(?:[A-Za-z]\d+|\d+-\d+)/g, fix: '내부 설계 문서 번호야. 저장소 밖에선 뜻이 없으니 결정 기록 번호(docs/decisions)나 내용으로 바꿔' },
  { id: 'plan-doc-name', re: /\b[\w.]+(?:-[\w.]+)*-(?:plan|design)(?:\.md)?\b/g, fix: '내부 계획 문서 이름이야. 결정 기록(docs/decisions)이나 CHANGELOG 를 가리켜' },
];

// 순수 함수: 글 하나에서 걸린 것을 [{ rule, line, text, fix }] 로 준다
export function findViolations(text, file = '') {
  const out = [];
  const lines = String(text).split('\n');
  for (const r of RULES) {
    if (r.skip?.(file)) continue;
    lines.forEach((l, i) => { for (const m of l.matchAll(r.re)) out.push({ rule: r.id, line: i + 1, text: m[0], fix: r.fix }); });
  }
  return out;
}

// 순수 함수: 고정 시간 잠자기 개수. await sleep(300) 같은 도우미 호출, new Promise((r) => setTimeout(r, 300)), timers/promises 의 await setTimeout(300)
const SLEEPS = [
  /\bawait\s+(?:sleep|wait|delay|pause)\(\s*[\d_]+\s*\)/g,
  /\bnew Promise\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\1\s*,\s*[\d_]+\s*\)\s*\)/g,
  /\bawait\s+setTimeout\(\s*[\d_]+/g,
];
export function countSleeps(text) {
  return SLEEPS.reduce((n, re) => n + (String(text).match(re) || []).length, 0);
}

// 추적 파일(이미지·폰트·소리·압축·vendor 제외)
function trackedTextFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
    .filter((f) => !/\.(png|jpe?g|gif|webp|ico|svg|bmp|woff2?|ttf|otf|eot|mp3|wav|ogg|mp4|zip|gz|tgz|pdf)$/i.test(f) && !/(^|\/)vendor\//.test(f));
}

test('1. 순수 함수가 과거에 실제로 나온 꼴을 잡는다(주석의 내부 설계 번호, 문서의 .omc 계획 경로)', () => {
  const D = '설' + '계';
  const pastComment = `// ${D} G4·5-2 대로 단계를 나눈다`;
  assert.deepEqual(findViolations(pastComment).map((v) => [v.rule, v.text]), [['design-number', `${D} G4`]]);
  assert.equal(findViolations(`// ${D} 11-6 참고`)[0]?.rule, 'design-number');
  const planPath = ['.omc', 'plans', ['2026-11-19-mission', 'plan.md'].join('-')].join('/');
  const pastDoc = `자세한 건 ${planPath} 참고`;
  assert.deepEqual(findViolations(pastDoc).map((v) => v.rule).sort(), ['omc-path', 'plan-doc-name']);
  assert.equal(findViolations(['completing', 'team', 'design'].join('-'))[0]?.rule, 'plan-doc-name');
  // 고치는 법이 같이 나온다
  assert.ok(findViolations(pastComment)[0].fix.includes('docs/decisions'));
});

test('2. 개인 정보 꼴은 잡고, 자리 표시·예시·noreply 는 허용한다', () => {
  const S = '\\';
  const caught = (s) => findViolations(s).map((v) => v.rule);
  assert.ok(caught(['C:', 'Users', '홍길동', 'proj'].join(S)).includes('windows-user-folder'));
  assert.ok(caught(['C:', 'Users', '홍길동', 'proj'].join(S)).includes('hangul-user-folder'));
  assert.ok(caught(['', 'Users', 'someone', 'proj'].join('/')).includes('mac-user-folder'));
  assert.ok(caught(['D:', 'AI' + '오피스', 'server'].join(S)).includes('local-drive-path'));
  assert.ok(caught(['E:', 'mywork', 'repo'].join(S)).includes('local-drive-path'));
  assert.ok(caught(['C:', 'Users', 'RUNNER~1x'].join(S)).includes('windows-user-folder'), '허용 이름과 앞부분만 같은 이름은 잡는다');
  assert.ok(caught('someone' + '@' + 'gmail.com').includes('personal-email'));
  assert.ok(caught('someone' + '@' + 'naver.com').includes('personal-email'));
  for (const ok of ['you@example.com', 'x@example.test', '12345+someone@users.noreply.github.com', 'noreply@anthropic.com',
    'C:/work-folder', '/Users/…/project', 'C:\\Users\\<name>\\proj', '/home/me/project', 'https://example.com/a:b',
    'D:\\proj\\api', 'C:\\Users\\RUNNER~1\\AppData']) {
    assert.deepEqual(findViolations(ok), [], ok);
  }
  // .gitignore 는 .omc 를 무시하라고 적는 곳이라 허용
  const omcLine = ['.omc', ''].join('/');
  assert.deepEqual(findViolations(omcLine, '.gitignore'), []);
  assert.equal(findViolations(omcLine, 'README.md')[0]?.rule, 'omc-path');
});

test('3. 지금 저장소의 추적 파일에 개인 정보·내부 작업 흔적이 없다', () => {
  const files = trackedTextFiles();
  assert.ok(files.length > 50, `추적 파일 목록: ${files.length}개`);
  const found = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; } // 지운 뒤 아직 커밋하지 않은 파일
    for (const v of findViolations(text, f)) found.push(`${f}:${v.line} [${v.rule}] "${v.text}" → ${v.fix}`);
  }
  assert.deepEqual(found, [], `고칠 곳 ${found.length}개:\n${found.join('\n')}`);
});

test('4. 잠자기 개수 세기: 실제로 쓰는 꼴을 센다', () => {
  assert.equal(countSleeps('await sleep(300);'), 1);
  assert.equal(countSleeps('await new Promise((r) => setTimeout(r, 500));'), 1);
  assert.equal(countSleeps('await new Promise((res) => setTimeout(res, 1_500));'), 1);
  assert.equal(countSleeps('await new Promise(x => setTimeout(x, 300));'), 1);
  assert.equal(countSleeps("import { setTimeout } from 'node:timers/promises'; await setTimeout(200);"), 1);
  // 조건을 보며 기다리는 것·변수 간격·잠자기 도우미 정의는 세지 않는다
  assert.equal(countSleeps('await waitFor(() => done, { timeout: 3000 });'), 0);
  assert.equal(countSleeps('await new Promise((r) => setTimeout(r, interval));'), 0);
  assert.equal(countSleeps('const sleep = (ms) => new Promise((r) => setTimeout(r, ms));'), 0);
});

// 이 파일은 세기 예시(문자열)를 담고 있어 뺀다
test('5. ratchet: 테스트의 고정 시간 잠자기가 기준값보다 늘지 않는다(waitFor 를 써)', (t) => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const dir = path.join(root, 'test');
  const per = {};
  let total = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.test.js') && x !== 'hygiene.test.js').sort()) {
    const n = countSleeps(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (n) per[f] = n;
    total += n;
  }
  assert.ok(total <= baseline.fixedSleeps,
    `고정 시간 잠자기가 ${baseline.fixedSleeps}개 → ${total}개로 늘었어. 새로 넣은 잠자기를 test/helpers.js 의 waitFor(조건, { timeout, what }) 로 바꿔.\n파일별: ${JSON.stringify(per)}`);
  if (total < baseline.fixedSleeps) t.diagnostic(`잠자기가 ${baseline.fixedSleeps}개 → ${total}개로 줄었어. test/hygiene-baseline.json 의 fixedSleeps 를 ${total} 로 낮춰 줘.`);
});
