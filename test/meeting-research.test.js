// 회의 중 조사: 차례 답 끝의 ```oc-check 질문 블록 → 팀의 조사 역할이 한 번 찾아 옴 → 다음 차례부터 표시로 감싼 참고 자료로.
// 질문 블록 읽기·조사 담당 고르기·화면에서 블록 감추기(순수 함수)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_MAX, parseCheck, checkBlock, pickResearcher } from '../server/meeting.js';
import { hideCheck } from '../public/js/chat-tools.js';
import { bindLang } from '../server/i18n.js';

const blk = (j) => '```oc-check\n' + j + '\n```';

test('질문 블록: 글 맨 끝의 블록만 읽고, 질문은 앞뒤 공백을 뺀 1~300자', () => {
  assert.equal(CHECK_MAX, 3);
  assert.equal(parseCheck('그냥 글'), null);
  assert.equal(parseCheck(''), null);
  const head = '내 말은 이래.\n\n';
  const block = blk('{"question":"  작년 매출이 얼마야?  "}');
  const text = `${head}${block}\n`;
  const c = parseCheck(text);
  assert.equal(c.question, '작년 매출이 얼마야?');
  assert.equal(c.from, head.length);
  assert.equal(text.slice(c.from, c.to), block, 'from/to 가 블록을 정확히 가리킨다');
  assert.equal(parseCheck(`${blk('{"question":"뭐야?"}')}\n뒤에 글`), null, '뒤에 글이 있으면 질문이 아니다');
  assert.equal(parseCheck('```oc-check\n{"question":"닫지 않음"}'), null, '닫지 않은 블록');
  assert.ok(parseCheck(blk('{"question":"   "}')).error, '빈 질문');
  assert.ok(parseCheck(blk('{}')).error, '질문이 없음');
  assert.ok(parseCheck(blk('{"question":3}')).error, '글이 아닌 질문');
  assert.ok(parseCheck(blk(JSON.stringify({ question: '가'.repeat(301) }))).error, '301자');
  assert.equal(parseCheck(blk(JSON.stringify({ question: '가'.repeat(300) }))).question.length, 300, '300자까지는 된다');
  const bad = parseCheck(`앞\n${blk('{깨짐')}`);
  assert.ok(bad.error, 'JSON 이 깨짐');
  assert.deepEqual([bad.from, bad.to], [2, 2 + blk('{깨짐').length], '형식이 틀려도 블록 자리는 알려 준다(한 말에서 블록을 빼려고)');
  const two = `${blk('{"question":"예시"}')}\n설명\n\n${blk('{"question":"진짜"}')}`;
  assert.equal(parseCheck(two).question, '진짜', '앞에 예로 든 블록이 있어도 맨 끝의 블록만');
});

test('질문 블록 예시: 설명 글은 설정 언어로, 그대로 읽으면 질문이 된다', () => {
  try {
    bindLang(() => 'ko');
    assert.match(checkBlock(), /^```oc-check\n\{"question":"[^"]+"\}\n```$/);
    assert.ok(parseCheck(checkBlock()).question);
    bindLang(() => 'en');
    assert.doesNotMatch(checkBlock(), /[가-힣]/);
    assert.ok(parseCheck(checkBlock()).question);
  } finally { bindLang(() => 'ko'); }
});

test('조사 담당 고르기: 단계 순서·단계 안 순서대로 첫 조사 역할, 진행자는 빼고, 없으면 null', () => {
  const ag = { a: { role: '분석' }, b: { role: '조사' }, c: { role: 'Research' }, d: { role: '빌드' } };
  assert.equal(pickResearcher({ stages: [{ agentIds: ['a', 'd'] }, { agentIds: ['c', 'b'] }] }, ag, 'a'), 'c', '앞 단계부터, 단계 안에서는 적힌 순서대로');
  assert.equal(pickResearcher({ stages: [{ agentIds: ['b'] }, { agentIds: ['c'] }] }, ag, 'x'), 'b');
  assert.equal(pickResearcher({ stages: [{ agentIds: ['a', 'b', 'c'] }] }, ag, 'b'), 'c', '진행자는 고르지 않는다');
  assert.equal(pickResearcher({ stages: [{ agentIds: ['a', 'd'] }] }, ag, 'a'), null, '조사 역할이 없으면 null');
  assert.equal(pickResearcher({ stages: [{ agentIds: ['zz', 'b'] }] }, ag, null), 'b', '지워진 에이전트는 건너뛴다');
  assert.equal(pickResearcher({ stages: [] }, ag, 'a'), null);
});

test('화면: 받은 질문 블록은 감추고, 쓰는 중이면 끝에 오는 블록도 감춘다', () => {
  const text = `내 말.\n\n${blk('{"question":"뭐야?"}')}`;
  const c = parseCheck(text);
  assert.equal(hideCheck(text, { ...c, status: 'asked' }).trim(), '내 말.');
  assert.equal(hideCheck('쓰는 중\n\n```oc-check\n{"quest', null, true).trim(), '쓰는 중');
  assert.equal(hideCheck(text, null, false), text, '서버가 받지 않은 블록(형식 오류)은 글로 보인다');
  assert.equal(hideCheck(text, { from: 999, to: 1000 }), text, '자리가 글과 맞지 않으면 그대로');
  assert.equal(hideCheck('', null), '');
});
