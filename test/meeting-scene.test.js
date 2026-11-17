// 회의 장면(사무실 그림) 계산: 조사하러 간 사람 고르기. 그림 자체는 자동 테스트가 없어 DOM 없이 도는 계산만 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researcherOf, meetingView, isTalking, cardText, boardCards, sayText } from '../public/js/office/meeting.js';
import { tr } from '../public/js/office/i18n.js';

// 그림 안의 새 글자(사무실 사전은 test/i18n.test.js 가 보지 않는다): 네 언어 모두 따로 있어야 한다(없으면 영어로 떨어진다)
const NEW_KEYS = ['meet.away', 'meet.opposer', 'meet.progress', 'meet.phase.opinion', 'meet.phase.turn', 'meet.phase.research', 'meet.phase.judge', 'meet.phase.conclude', 'board.title', 'board.open'];

test('결론 카드 글: "결정" 줄의 글을 30자 안팎으로(네 언어, 굵은 글씨·전각 콜론)', () => {
  // 데모 결론(server/providers/mock.js)과 같은 모양
  const demo = '## 회의 결론\n\n- **결정**: 합침. 수요가 확인된 안을, 가장 작은 범위로 먼저 만든다.\n- **근거**: 자료가 같은 방향이야.';
  assert.equal(cardText(demo), '합침. 수요가 확인된 안을, 가장 작은 범위로 먼저 만…');
  // 진행자가 프롬프트 형식대로 쓴 결론(server/orchestrator.js)
  assert.equal(cardText('## Meeting conclusion\n- Decision: pick option B\n- Grounds: cheaper'), 'pick option B');
  assert.equal(cardText('## 会议结论\n- **决定**：合并两个方案\n- 依据：…'), '合并两个方案');
  assert.equal(cardText('## 会議の結論\n- 決定: 案Aを選ぶ\n- 根拠: 安い'), '案Aを選ぶ');
  assert.equal(cardText('**결정:** 새 안으로 간다'), '새 안으로 간다', '콜론이 굵은 글씨 안에 있어도');
  assert.equal(cardText('1. 결정 : `A안`을 [문서](https://example.com/a) 대로'), 'A안을 문서 대로', '마크다운 표시는 뺀다');
  assert.equal(cardText('- 결정적인 근거: 없음\n- 결정: 보류'), '보류', '"결정"으로 시작하는 다른 낱말은 결정 줄이 아니다');
});

test('결론 카드 글: "결정" 줄이 없으면 첫 글줄(제목 줄은 다른 글이 없을 때만), 길이는 글자 단위', () => {
  assert.equal(cardText('## 회의 결론\n\n오늘은 결론을 못 냈어.\n- 다음에 다시'), '오늘은 결론을 못 냈어.');
  assert.equal(cardText('## 회의 결론'), '회의 결론');
  assert.equal(cardText('- 결정:\n- 근거: 없음'), '결정:', '결정 줄이 비어 있으면 첫 글줄');
  assert.equal(cardText(''), '');
  assert.equal(cardText('   \n\n'), '');
  assert.equal(cardText(null), '');
  const thirty = '가'.repeat(29) + '🙂';
  assert.equal(cardText(`결정: ${thirty}`), thirty, '30자는 자르지 않고, 그림 글자도 한 글자');
  assert.equal(cardText(`결정: ${thirty}끝`), `${thirty}…`);
});

test('결론 카드: 이 세션의 회의 결론 최근 3개, 새것부터. 쓰는 중이거나 글이 없는 결론은 뺀다', () => {
  const c = (id, text, status = 'done') => ({ id, role: 'agent', status, text, meeting: { phase: 'conclude', round: 2, rounds: 2 } });
  const msgs = [
    c('k1', '결정: 하나'), { id: 't1', role: 'agent', status: 'done', text: '결정: 차례 글', meeting: { phase: 'turn', round: 2, rounds: 2 } },
    c('k2', '결정: 둘'), { id: 'u1', role: 'user', text: '결정: 사용자 말' }, c('k3', '결정: 셋'), c('k0', '', 'error'),
    c('k4', '결정: 넷'), c('k5', '결정: 쓰는 중', 'streaming'),
  ];
  assert.deepEqual(boardCards(msgs), [{ id: 'k4', text: '넷' }, { id: 'k3', text: '셋' }, { id: 'k2', text: '둘' }]);
  assert.deepEqual(boardCards([]), []);
  assert.deepEqual(boardCards(undefined), []);
});

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

test('말풍선 글: 약속한 블록과 마크다운 기호는 빼고 끝부분만 보여 준다', () => {
  assert.equal(sayText('## 회의 결론\n\n- **결정**: 합침. 작게 먼저 만든다.', 40), '회의 결론 결정: 합침. 작게 먼저 만든다.');
  assert.equal(sayText('남은 이견에 적을게.\n\n```oc-verdict\n{"verdict":"ag', 40), '남은 이견에 적을게.', '쓰는 중인 블록은 통째로 뺀다');
  assert.equal(sayText('…은 이견에 적을게. ``', 40), '…은 이견에 적을게.', '블록이 열리는 중인 따옴표도 뺀다');
  assert.equal(sayText('…"verdict":"agree","reason":"같은 안"}', 40), '…', '앞이 잘려 블록 안쪽만 남은 글은 점으로');
  assert.equal(sayText('`A안`으로 가자', 40), 'A안으로 가자');
  assert.equal(sayText('가'.repeat(50), 10), '…' + '가'.repeat(10));
  assert.equal(sayText('', 40), '');
});
