// 회의 차례 순수 함수: 반대편 고르기, 차례 순서, 판정 블록 읽기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOpposer, turnOrder, parseVerdict, verdictBlock } from '../server/meeting.js';
import { bindLang } from '../server/i18n.js';

const prov = (m) => (id) => m[id];
test('반대편 고르기: 정해 둔 사람 → 진행자와 다른 AI → 마지막 참석자', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(pickOpposer(ids, 'a', 'c', prov({ a: 'claude', b: 'codex', c: 'claude' })), 'c');
  assert.equal(pickOpposer(ids, 'a', 'a', prov({ a: 'claude', b: 'claude', c: 'codex' })), 'c', '진행자는 반대편이 못 된다');
  assert.equal(pickOpposer(ids, 'a', 'zzz', prov({ a: 'claude', b: 'claude', c: 'claude' })), 'c', '다른 AI가 없으면 마지막 참석자');
  assert.equal(pickOpposer(['a', 'b'], 'a', null, prov({ a: 'claude', b: 'claude' })), 'b');
  assert.equal(pickOpposer(['a'], 'a', null, prov({ a: 'claude' })), null);
});
test('차례: 진행자는 빠지고 반대편이 맨 앞', () => {
  assert.deepEqual(turnOrder(['a', 'b', 'c', 'd'], 'b', 'a'), ['a', 'c', 'd']);
  assert.deepEqual(turnOrder(['a', 'b'], 'a', 'b'), ['b']);
  assert.deepEqual(turnOrder(['a', 'b', 'c'], 'a', null), ['b', 'c']);
});
test('판정 블록: 맨 끝의 블록만, 두 값만', () => {
  const b = (j) => '```oc-verdict\n' + j + '\n```';
  assert.equal(parseVerdict('그냥 글'), null);
  const ok = parseVerdict(`정리하면 이래.\n\n${b('{"verdict":"agree","reason":"  셋 다  같은 안이야 "}')}\n`);
  assert.equal(ok.verdict, 'agree');
  assert.equal(ok.reason, '셋 다 같은 안이야');
  assert.equal('정리하면 이래.\n\n'.length, ok.from);
  assert.equal(parseVerdict(b('{"verdict":"continue"}')).reason, '');
  assert.deepEqual(parseVerdict(b('{깨짐')), { error: 'json' });
  assert.deepEqual(parseVerdict(b('{"verdict":"maybe"}')), { error: 'shape' });
  assert.equal(parseVerdict(b('{"verdict":"Agree"}')).verdict, 'agree', '대소문자는 맞춰 읽는다');
  assert.equal(parseVerdict(b('{"verdict":"CONTINUE"}')).verdict, 'continue');
  assert.deepEqual(parseVerdict(b('{"verdict":1}')), { error: 'shape' });
  assert.equal(parseVerdict(`${b('{"verdict":"agree"}')}\n뒤에 글`), null, '끝이 아니면 판정이 아니다');
  assert.equal(parseVerdict('```oc-verdict\n{"verdict":"agree"'), null, '닫지 않은 블록');
});
test('판정 블록 예시: 설명 글은 설정 언어로, agree / continue 는 그대로', () => {
  try {
    bindLang(() => 'ko');
    assert.equal(verdictBlock(), '```oc-verdict\n{"verdict":"agree 또는 continue","reason":"한 문장"}\n```');
    bindLang(() => 'en');
    assert.equal(verdictBlock(), '```oc-verdict\n{"verdict":"agree or continue","reason":"one sentence"}\n```');
    bindLang(() => 'ja');
    assert.match(verdictBlock(), /"verdict":"agree [^"]+ continue"/);
    assert.doesNotMatch(verdictBlock(), /또는|한 문장/);
  } finally { bindLang(() => 'ko'); }
});
