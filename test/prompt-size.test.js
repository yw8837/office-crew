// 고정 프롬프트 크기 지키기(결정 0025): 목표 모드가 매 호출에 붙이는 고정 지시 조각(확정 목표 블록 머리, 막힘 안내, 묻고 할 일 줄, 이어서 줄,
// 끝의 두 칸 안내, 가정 적기, 블록 예시, 회의 형식 줄)의 한국어·영어 글자 수 합이 기준값 + 여유를 넘으면 실패한다(호출 수 × 크기로 몰래 불어나지 않게).
// 의도한 증가면 test/prompt-baseline.json 의 chars 를 올린다(hygiene-baseline.json 과 같은 방식). 값이 담긴 부분(목표·기준 글, 결과)은 세지 않는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindLang, tr } from '../server/i18n.js';
import en from '../public/js/i18n/en.js';
import { blockedRule, outsideRule, resumeSent, tailRule, ASSUME, goalBlock, researchBlock, planBlock, reviewBlock } from '../server/mission.js';
import { verdictBlock, checkBlock } from '../server/meeting.js';

const BASELINE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompt-baseline.json');

// 오케스트레이터 안(확정 목표 블록 #goalCardPrompt, 이어서 줄, 회의 프롬프트 #meetingPrompt)의 고정 문구는 번역 키로 잰다
const KEYS = [
  '[확정된 목표와 합격 기준 (사용자가 확인함. 바꾸지 마)]',
  '이 목표와 기준을 채우는 쪽으로 네 단계를 해. 기준을 바꾸거나 범위 밖의 일을 하지 마.',
  '[이어서] 이 단계는 앱이 꺼져서 중간에 끊겼어. 작업 폴더에 이미 해 둔 것이 있는지 먼저 확인하고, 있으면 거기서 이어서 해.',
  // 회의 결론 형식 줄
  '아래 형식으로 써. 의견이 갈리면 억지로 합치지 말고 갈린 채로 적어.',
  '회의 결론',
  '결정: 하나를 고름 / 합침 / 전부 버림 / 새 안 중 무엇인지와 그 내용',
  '근거: 어느 의견의 어떤 점 때문인지',
  '남은 이견: 없으면 "없음"',
  '버린 안: 무엇을 왜 버렸는지(없으면 "없음")',
  '다음 할 일: 누가 무엇을',
  // 목표 회의의 형식 줄(결정 0017)
  '입장: 지금 미는 안 한 줄(맨 끝 줄로)',
  '동의하지 못하는 점이 있으면 숨기지 말고 먼저 적어. 입장을 바꾸면 무엇을 보고 바꿨는지 한 줄로 적어.',
  '너는 이번 회의에서 반대편이야. 지금 나온 주장 가운데 가장 강한 것을 골라 근거를 들어 반박해. 말투로 반대하지 말고, 근거 없이 꾸며 내지도 마. 반박할 게 정말 없으면 무엇을 확인했는지 적어.',
  '[네가 앞에서 한 말]',
  '아래는 네가 이 회의에서 앞서 한 말이야(같은 표시 안). 다른 사람 말과 섞지 말고, 바꿀 게 있으면 바꾼 이유를 적어.',
];
// mission.js·meeting.js 가 만드는 고정 조각
const pieces = () => [blockedRule(), outsideRule(true), outsideRule(false), resumeSent(), tailRule(), ASSUME(), goalBlock(), researchBlock(), planBlock(), reviewBlock('0'.repeat(16)), verdictBlock(), checkBlock(), ...KEYS.map((k) => tr(k))];
const chars = (lang) => {
  bindLang(() => lang);
  try { return pieces().reduce((n, s) => n + [...String(s)].length, 0); } finally { bindLang(() => 'ko'); }
};

test('1. 잴 문구가 영어 사전에 모두 있다(없으면 영어가 한국어 그대로 세어져 값이 틀린다)', () => {
  const missing = KEYS.filter((k) => typeof en[k] !== 'string');
  assert.deepEqual(missing, []);
});

test('2. 목표 모드의 고정 지시 조각(한국어 + 영어 글자 수)이 기준값 + 여유를 넘지 않는다', (t) => {
  const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const ko = chars('ko');
  const enN = chars('en');
  const total = ko + enN;
  const limit = Math.floor(base.chars * (1 + base.slack));
  assert.ok(total <= limit, `목표 모드의 고정 지시 조각이 ${base.chars}자 → ${total}자(한국어 ${ko} + 영어 ${enN})로 여유 ${Math.round(base.slack * 100)}%를 넘게 늘었어. 매 호출에 붙는 글이라 호출 수만큼 커져. 의도한 증가면 test/prompt-baseline.json 의 chars 를 ${total} 로 올려.`);
  if (total < base.chars) t.diagnostic(`고정 지시 조각이 ${base.chars}자 → ${total}자로 줄었어. test/prompt-baseline.json 의 chars 를 ${total} 로 낮춰 줘.`);
});
