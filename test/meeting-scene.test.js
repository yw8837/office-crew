// 회의 장면(사무실 그림) 계산: 조사하러 간 사람 고르기. 그림 자체는 자동 테스트가 없어 DOM 없이 도는 계산만 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researcherOf } from '../public/js/office/meeting.js';
import { tr } from '../public/js/office/i18n.js';

// 그림 안의 새 글자(사무실 사전은 test/i18n.test.js 가 보지 않는다): 네 언어 모두 따로 있어야 한다(없으면 영어로 떨어진다)
const NEW_KEYS = ['meet.away'];

test('조사하러 간 사람: 조사 단계의 speakerId 만', () => {
  assert.equal(researcherOf({ phase: 'research', round: 2, rounds: 3, speakerId: 'r1', askedBy: 'a1', opposerId: 'a2' }), 'r1');
  assert.equal(researcherOf({ phase: 'research', round: 2, rounds: 2, speakerId: 'a1', askedBy: 'a1' }), 'a1', '자기 질문을 자기가 조사해도 그 사람');
  assert.equal(researcherOf({ phase: 'turn', round: 2, rounds: 3, speakerId: 'a1' }), null, '차례는 조사가 아니다');
  assert.equal(researcherOf({ phase: 'research', round: 2, rounds: 3 }), null, '조사하는 사람이 없으면 아무도 안 간다');
  assert.equal(researcherOf(null), null);
  assert.equal(researcherOf(undefined), null);
});

test('그림의 새 글자는 네 언어 모두 있다', () => {
  for (const k of NEW_KEYS) {
    const en = tr('en', k);
    assert.notEqual(en, k, `en ${k}`);
    for (const l of ['ko', 'zh', 'ja']) assert.notEqual(tr(l, k), en, `${l} ${k}`);
  }
});
