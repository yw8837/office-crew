// 회의 장면(사무실 그림) 계산: 조사하러 간 사람 고르기. 그림 자체는 자동 테스트가 없어 DOM 없이 도는 계산만 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researcherOf, meetingView, isTalking } from '../public/js/office/meeting.js';
import { tr } from '../public/js/office/i18n.js';

// 그림 안의 새 글자(사무실 사전은 test/i18n.test.js 가 보지 않는다): 네 언어 모두 따로 있어야 한다(없으면 영어로 떨어진다)
const NEW_KEYS = ['meet.away', 'meet.opposer', 'meet.progress', 'meet.phase.opinion', 'meet.phase.turn', 'meet.phase.research', 'meet.phase.judge', 'meet.phase.conclude'];

test('그림에 넘길 회의 상태: 판정·결론은 진행자가 말하고, 의견·조사는 한 사람을 고르지 않는다', () => {
  assert.deepEqual(meetingView({ phase: 'turn', round: 2, rounds: 3, speakerId: 'a2', opposerId: 'a3' }, 'a1'),
    { phase: 'turn', round: 2, rounds: 3, speakerId: 'a2', opposerId: 'a3' });
  assert.equal(meetingView({ phase: 'judge', round: 2, rounds: 3 }, 'a1').speakerId, 'a1');
  assert.equal(meetingView({ phase: 'conclude', round: 3, rounds: 3, opposerId: 'a3' }, 'a1').speakerId, 'a1');
  assert.equal(meetingView({ phase: 'opinion', round: 1, rounds: 2 }, 'a1').speakerId, null, '의견은 모두가 동시에');
  assert.equal(meetingView({ phase: 'research', round: 2, rounds: 2, speakerId: 'r', askedBy: 'a2' }, 'a1').speakerId, null, '조사하는 사람은 모임 자리에서 말하지 않는다');
  assert.equal(meetingView({ phase: 'turn', round: 2, rounds: 2, speakerId: 'a2' }, 'a1').opposerId, null);
  assert.equal(meetingView(null, 'a1'), null);
  assert.equal(meetingView({ phase: 'review', round: 2, rounds: 2 }, 'a1'), null, '모르는 단계(옛 review)는 표시하지 않는다');
});

test('말풍선을 띄울 사람: 의견은 참석자 모두, 차례는 그 사람, 판정·결론은 진행자, 조사는 아무도', () => {
  const v = (now) => meetingView(now, 'chair');
  assert.equal(isTalking(v({ phase: 'opinion', round: 1, rounds: 2 }), 'x', true), true);
  assert.equal(isTalking(v({ phase: 'opinion', round: 1, rounds: 2 }), 'x', false), false, '참석자가 아니면 아니다');
  assert.equal(isTalking(v({ phase: 'turn', round: 2, rounds: 2, speakerId: 'a2' }), 'a2', true), true);
  assert.equal(isTalking(v({ phase: 'turn', round: 2, rounds: 2, speakerId: 'a2' }), 'a3', true), false);
  assert.equal(isTalking(v({ phase: 'judge', round: 2, rounds: 3 }), 'chair', true), true);
  assert.equal(isTalking(v({ phase: 'conclude', round: 2, rounds: 3 }), 'a2', true), false);
  assert.equal(isTalking(v({ phase: 'research', round: 2, rounds: 2, speakerId: 'a2' }), 'a2', true), false);
  assert.equal(isTalking(null, 'a2', true), false);
});

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
