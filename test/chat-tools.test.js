// 채팅 화면의 작은 계산: 번호 목록 이어 쓰기, 대화에서 찾기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueList, findInMessages } from '../public/js/chat-tools.js';

const core = (r) => r && { text: r.text, caret: r.caret };
const at = (text) => core(continueList(text, text.length));

test('번호 목록: 줄을 바꾸면 다음 번호를 이어 준다', () => {
  assert.deepEqual(at('1. 이렇게'), { text: '1. 이렇게\n2. ', caret: 10 });
  assert.equal(at('1. 이렇게\n2. 번호 매기고').text, '1. 이렇게\n2. 번호 매기고\n3. ');
  assert.equal(at('9) 아홉').text, '9) 아홉\n10) ', '괄호 번호도, 자릿수가 늘어도');
  assert.equal(at('  3. 들여쓴 것').text, '  3. 들여쓴 것\n  4. ', '들여쓰기를 지킨다');
  assert.equal(at('앞 문장\n\n1. 첫째').text, '앞 문장\n\n1. 첫째\n2. ', '글 중간에서 시작한 목록');
});

test('글머리 목록도 이어 준다', () => {
  assert.equal(at('- 하나').text, '- 하나\n- ');
  assert.equal(at('* 하나').text, '* 하나\n* ');
  assert.equal(at('• 하나').text, '• 하나\n• ');
});

test('빈 항목에서 줄을 바꾸면 목록을 끝낸다', () => {
  assert.deepEqual(at('1. 하나\n2. '), { text: '1. 하나\n', caret: 6 });
  assert.deepEqual(at('- '), { text: '', caret: 0 });
});

test('목록이 아니면 건드리지 않는다', () => {
  for (const s of ['그냥 글', '1.붙여 쓴 것', '2026. 11. 13에 한 일', 'v1.2 배포', '', '1234. 너무 큰 번호', '-붙여 쓴 것']) {
    const r = at(s);
    if (s === '2026. 11. 13에 한 일') continue; // 아래에서 따로 본다
    assert.equal(r, null, JSON.stringify(s));
  }
  assert.equal(at('2026. 11. 13에 한 일'), null, '네 자리 숫자로 시작하는 날짜는 목록이 아니다');
});

test('커서가 줄 가운데 있으면 그 자리에서 나눠 다음 항목으로 넘긴다', () => {
  const text = '1. 앞뒤';
  const r = core(continueList(text, 4)); // '앞' 뒤
  assert.deepEqual(r, { text: '1. 앞\n2. 뒤', caret: 8 });
  // 선택한 글이 있으면 그 글은 지우고 넘긴다
  assert.equal(continueList('1. 가나다', 4, 6).text, '1. 가\n2. ');
  // 화면은 insert(넣을 글)나 remove(지울 범위)로 브라우저 입력 명령을 쓴다
  assert.equal(continueList('1. 가', 4).insert, '\n2. ');
  assert.deepEqual(continueList('1. 가\n2. ', 8).remove, [5, 8]);
  // 표시 바로 뒤에 커서가 있고 그 뒤에 글이 있으면 목록을 끝내지 않는다(평소처럼 줄만 바뀐다)
  assert.equal(continueList('1. 뒤에 글', 3), null);
});

test('대화에서 찾기: 대소문자 없이, 대화 순서대로, 사용자와 에이전트 글만', () => {
  const msgs = [
    { id: 'a', role: 'user', text: '결제 모듈은 살구페이로 가자' },
    { id: 'b', role: 'agent', text: '알겠어. SalguPay 연동부터 볼게' },
    { id: 'c', role: 'system', text: '살구페이 관련 알림' },
    { id: 'd', role: 'user', text: '인수인계 메모로 정리해 줘 살구페이', handoffAsk: true },
    { id: 'e', role: 'agent', text: '' },
    { id: 'f', role: 'agent', text: '살구페이 연동 끝' },
  ];
  assert.deepEqual(findInMessages(msgs, '살구페이'), ['a', 'f']);
  assert.deepEqual(findInMessages(msgs, 'salgupay'), ['b']);
  assert.deepEqual(findInMessages(msgs, '  '), []);
  assert.deepEqual(findInMessages(msgs, '없는 말'), []);
});
