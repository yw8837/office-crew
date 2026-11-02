// 다국어 누락 방지: 소스의 t('…')/tr('…') 원문 키가 en·zh·ja 사전에 모두 있고, {변수}가 원문과 같은지 검사한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../public/js/i18n/en.js';
import zh from '../public/js/i18n/zh.js';
import ja from '../public/js/i18n/ja.js';
import { t, setLang } from '../public/js/i18n/index.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DICTS = { en, zh, ja };

// 화면(public/js, 사무실 모듈·사전 제외)과 서버(server) 소스 전부
function sources() {
  const out = [];
  const walk = (dir, skip) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.includes(e.name)) walk(p, skip); } else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(path.join(root, 'public', 'js'), ['office', 'i18n']);
  walk(path.join(root, 'server'), []);
  return out;
}

const unescape = (s) => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));

function collectKeys() {
  const keys = new Map(); // 키 → 처음 나온 위치
  const res = [
    /\btr?\(\s*'((?:[^'\\\n]|\\.)*)'/g,
    /\btr?\(\s*"((?:[^"\\\n]|\\.)*)"/g,
    /\btr?\(\s*`([^`]*)`/g,
  ];
  for (const file of sources()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of res) {
      for (const m of src.matchAll(re)) {
        if (re.source.includes('`') && m[1].includes('${')) continue; // 변수 끼운 템플릿은 키가 아님
        const key = unescape(m[1]);
        if (!key.trim()) continue;
        if (!keys.has(key)) keys.set(key, `${path.relative(root, file)}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  return keys;
}

const varsOf = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

const KEYS = collectKeys();

test('번역 키를 소스에서 충분히 모았다', () => {
  assert.ok(KEYS.size > 300, `키가 ${KEYS.size}개뿐 — 정규식이 깨졌을 수 있음`);
});

for (const [lang, dict] of Object.entries(DICTS)) {
  test(`${lang} 사전에 모든 키가 있다`, () => {
    const missing = [...KEYS].filter(([k]) => typeof dict[k] !== 'string' || !dict[k].trim()).map(([k, at]) => `${at}  ${JSON.stringify(k)}`);
    assert.equal(missing.length, 0, `${lang} 누락 ${missing.length}개:\n${missing.join('\n')}`);
  });

  test(`${lang} 사전 값의 {변수}가 원문과 같다`, () => {
    const bad = Object.entries(dict).filter(([k, v]) => varsOf(k) !== varsOf(v)).map(([k, v]) => `${JSON.stringify(k)} → ${JSON.stringify(v)}`);
    assert.equal(bad.length, 0, `${lang} 변수 불일치:\n${bad.join('\n')}`);
  });

  test(`${lang} 사전 값에 한글이 남지 않았다`, () => {
    const bad = Object.entries(dict).filter(([, v]) => /[가-힣]/.test(v)).map(([k, v]) => `${JSON.stringify(k)} → ${JSON.stringify(v)}`);
    assert.equal(bad.length, 0, `${lang} 번역 안 된 값:\n${bad.join('\n')}`);
  });
}

test('t()가 언어를 바꾸고 변수를 끼운다', () => {
  try {
    setLang('en');
    assert.equal(t('새 세션'), en['새 세션']);
    assert.match(t('{n}분 전', { n: 5 }), /5/);
    setLang('ko');
    assert.equal(t('{n}분 전', { n: 5 }), '5분 전');
    assert.equal(t('사전에 없는 문장'), '사전에 없는 문장');
  } finally { setLang('ko'); }
});

test('첫 실행 기본 데이터는 OS 언어로 만들어지고, 번역된 역할도 자동 라우팅이 알아본다', async () => {
  const { createApp } = await import('../server/index.js');
  const { roleKind } = await import('../server/routing.js');
  const os = await import('node:os');
  const saved = process.env.LANG;
  for (const [lang, name, team, kind] of [['en_US.UTF-8', 'Researcher', 'Default team', 'research'], ['ja_JP.UTF-8', 'リサーチャー', '基本チーム', 'research'], ['zh_CN.UTF-8', '调研员', '默认团队', 'research']]) {
    process.env.LANG = lang;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-seed-'));
    const app = createApp({ home, port: 0, detect: false });
    try {
      const a = app.store.get('agents', 'researcher');
      assert.equal(a.name, name, lang);
      assert.equal(app.store.get('teams', 'team-default').name, team);
      assert.equal(roleKind(a.role), kind);
      assert.equal(roleKind(app.store.get('agents', 'builder').role), 'build', `${lang} 빌드 역할`);
      assert.equal(roleKind(app.store.get('agents', 'auto-review').role), 'review', `${lang} 검수 역할`);
    } finally {
      await app.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  if (saved === undefined) delete process.env.LANG; else process.env.LANG = saved;
});
