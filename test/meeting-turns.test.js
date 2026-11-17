// 회의 차례 순수 함수: 반대편 고르기, 차례 순서, 판정 블록 읽기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOpposer, turnOrder, parseVerdict } from '../server/meeting.js';

const prov = (m) => (id) => m[id];
test('반대편 고르기: 정해 둔 사람 → 진행자와 다른 AI → 마지막 참석자', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(pickOpposer(ids, 'a', 'c', prov({ a: 'claude', b: 'codex', c: 'claude' })), 'c');
  assert.equal(pickOpposer(ids, 'a', 'a', prov({ a: 'claude', b: 'claude', c: 'codex' })), 'c', '진행자는 반대편이 못 된다');
  assert.equal(pickOpposer(ids, 'a', 'zzz', prov({ a: 'claude', b: 'claude', c: 'claude' })), 'c', '다른 AI가 없으면 마지막 참석자');
  assert.equal(pickOpposer(['a', 'b'], 'a', null, prov({ a: 'claude', b: 'claude' })), 'b');
  assert.equal(pickOpposer(['a'], 'a', null, prov({ a: 'claude' })), null);
});
test('차례: 진행자는 빠지고 반대편이 마지막', () => {
  assert.deepEqual(turnOrder(['a', 'b', 'c', 'd'], 'b', 'a'), ['c', 'd', 'a']);
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
  assert.equal(parseVerdict(`${b('{"verdict":"agree"}')}\n뒤에 글`), null, '끝이 아니면 판정이 아니다');
  assert.equal(parseVerdict('```oc-verdict\n{"verdict":"agree"'), null, '닫지 않은 블록');
});
