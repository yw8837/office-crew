// 완주 보고(결정 0025)의 글줄: 화면(views/mission.js 의 ReportCard)과 서버(server/report.js 의 기억에 넣는 글 판)가 같은 함수로 만든다(두 곳의 말이 어긋나지 않게).
// DOM 이 없고 번역 함수(t: 화면, tr: 서버)를 받아서 쓴다. 키는 같은 사전(public/js/i18n)에 있다

// 끝 상태 이름은 흐름 무대의 끝 깃발과 같은 말(stage-model.js 의 goalEndWord)
export const verdictWord = (t, s) => ({ pass: t('통과'), fail: t('불합격'), unknown: t('확인 못 함') }[s] || t('판정 안 됨'));
export const failName = (t, k) => ({ review: t('검수에서 걸림'), outside: t('바깥 장애'), blocked: t('막힘'), hole: t('구멍'), keep: t('지킬 것 어김'), input: t('넘겨받음'), unknown: t('원인 모름') }[k] || k);
export const answerNames = (t) => ({ goal: t('목표 잡기'), research: t('조사'), meeting: t('회의'), plan: t('계획'), cards: t('일 카드'), work: t('일 단계'), review: t('검수') });

// 걸린 시간: 1분 안 · n분 · h시간 n분
export function durationWords(t, ms) {
  const min = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (min < 1) return t('1분 안');
  return min < 60 ? t('{n}분', { n: min }) : t('{h}시간 {n}분', { h: Math.floor(min / 60), n: min % 60 });
}

// "확인 못 한 것" 줄들: 확인 못 한·판정 안 된 기준, 확인 못 한 조사 질문, 구멍·막힘·건너뛴 카드(까닭), 바꿨다고 적었지만 안 바뀐 파일, 건너뛴 단계, 사용량 한도로 멈춘 횟수
export function unverifiedLines(t, r) {
  const u = r?.unverified || {};
  const card = { hole: t('구멍'), blocked: t('막힘'), skipped: t('건너뜀') };
  const by = { quota: t('사용량 한도'), blocked: t('막힘을 받아들임') };
  const out = [];
  if (u.unknown?.length) out.push(t('확인 못 한 기준: {ids}', { ids: u.unknown.join(', ') }));
  if (u.open?.length) out.push(t('판정 안 된 기준: {ids}', { ids: u.open.join(', ') }));
  if (u.research?.missing) out.push(t('조사 질문 {n}개 중 {m}개는 확인 못 함(빈 답·오류·건너뜀)', { n: u.research.total, m: u.research.missing }));
  for (const c of u.cards || []) out.push(t('카드 {id}: {status}', { id: c.id, status: `${card[c.status] || c.status}${c.by ? ` (${by[c.by] || c.by})` : ''}` }));
  // 경로는 카드 담당(에이전트)이 꼬리에 적은 글이라 그렇다고 표시한다
  for (const p of u.proof || []) out.push(t('카드 {id}: 바꿨다고 적은 파일이 실제로는 안 바뀌었어(에이전트가 적은 경로: {files})', { id: p.id, files: (p.files || []).join(', ') }));
  if (u.skipped?.length) out.push(t('건너뛴 단계: {labels}', { labels: u.skipped.join(', ') }));
  if (u.quota) out.push(t('사용량 한도에 걸려 멈춘 횟수: {n}', { n: u.quota }));
  return out;
}

// 실패 종류 한 줄: "검수에서 걸림 2 · 원인 모름 1"(없으면 '')
export const failWords = (t, fails) => Object.entries(fails || {}).map(([k, n]) => `${failName(t, k)} ${n}`).join(' · ');
