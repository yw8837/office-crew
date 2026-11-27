// 완주 보고(결정 0025)의 글줄: 화면(views/mission.js 의 ReportCard)과 서버(server/report.js 의 기억에 넣는 글 판)가 같은 함수로 만든다(두 곳의 말이 어긋나지 않게).
// DOM 이 없고 번역 함수(t: 화면, tr: 서버)를 받아서 쓴다. 키는 같은 사전(public/js/i18n)에 있다

// 끝 상태 이름은 흐름 무대의 끝 깃발과 같은 말(stage-model.js 의 goalEndWord)
export const verdictWord = (t, s) => ({ pass: t('통과'), fail: t('불합격'), unknown: t('확인 못 함') }[s] || t('판정 안 됨'));
export const failName = (t, k) => ({ review: t('검수에서 걸림'), outside: t('바깥 장애'), blocked: t('막힘'), hole: t('구멍'), keep: t('지킬 것 어김'), input: t('넘겨받음'), unknown: t('원인 모름'), transient: t('일시 장애') }[k] || k);
export const answerNames = (t) => ({ goal: t('목표 잡기'), research: t('조사'), meeting: t('회의'), plan: t('계획'), cards: t('일 카드'), work: t('일 단계'), review: t('검수') });
// 있을 때만 싣는 종류: 교차 검수의 둘째 검수(결정 0032), 갈래 요약·진행자 답(결정 0031). 옛 보고와 그런 답이 없는 보고는 줄이 그대로다
export const answerExtra = (t) => ({ cross: t('교차 검수(레드팀)'), fork: t('갈래 요약'), lead: t('진행자 답') });
// 종류별 답 수 줄의 항목: 늘 싣는 종류 + 그 보고에 수가 있는 추가 종류. → [[키, 이름]]
export const answerRows = (t, answers = {}) => [...Object.entries(answerNames(t)), ...Object.entries(answerExtra(t)).filter(([k]) => (answers?.[k] || 0) > 0)];

// 두 갈래(결정 0031) 한 줄씩: 회의마다 사용자가 고른 안과 버린 안(입장은 에이전트가 쓴 글), 또는 팀에 맡김
export const forkLines = (t, forks) => (forks || []).map((f) => (f.picked === 'team'
  ? t('회의 "{label}": 두 안 중에 고르지 않고 팀이 정하게 했어(진행자 결론대로)', { label: f.label || '' })
  : t('회의 "{label}": 안 {key}({chosen})를 골랐어 · 버린 안: {dropped}', { label: f.label || '', key: String(f.picked || '').toUpperCase(), chosen: f.chosen || '', dropped: (f.dropped || []).join(', ') })));

// 교차 검수 줄들(결정 0032): 검수자 둘, 회차, 한 명만 검수한 회차, 엇갈린 기준 수, 판정 카드에서 사용자가 정한 것, 보류한 기준, 한 명만 본 기준(마지막 회차). 교차 검수가 없었으면 []
export function crossWords(t, c) {
  if (!c) return [];
  const p = c.picks || {};
  return [
    t('검수자 둘: {a}(검증) · {b}(레드팀) · 교차 검수 {n}회차', { a: c.a, b: c.b, n: c.rounds || 0 }),
    ...(c.single ? [t('둘째 검수 없이 한 명이 검수한 회차: {n}', { n: c.single })] : []),
    t('두 검수자의 판정이 엇갈린 기준: {n}개', { n: c.splits || 0 }),
    ...(p.fix || p.fold || p.hold ? [t('판정 카드에서 사용자가 정한 것: 고치기 {fix} · 접기 {fold} · 보류 {hold}', { fix: p.fix || 0, fold: p.fold || 0, hold: p.hold || 0 })] : []),
    ...(c.held?.length ? [t('보류한 기준: {ids}', { ids: c.held.join(', ') })] : []),
    ...(c.one?.length ? [t('한 명만 본 기준: {ids}', { ids: c.one.join(', ') })] : []),
  ];
}

// 걸린 시간: 1분 안 · n분 · h시간 n분
export function durationWords(t, ms) {
  const min = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (min < 1) return t('1분 안');
  return min < 60 ? t('{n}분', { n: min }) : t('{h}시간 {n}분', { h: Math.floor(min / 60), n: min % 60 });
}

// "확인 못 한 것" 줄들: 확인 못 한·판정 안 된 기준, 확인 못 한 조사 질문, 구멍·막힘·건너뛴 카드(까닭), 바꿨다고 적었지만 안 바뀐 파일, 건너뛴 단계, 사용량 한도로 멈춘 횟수, 진전 없는 회차
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
  if (u.noProgress) out.push(t('한 번 더 해도 같은 기준이 같은 이유로 걸린 회차: {n}', { n: u.noProgress })); // 진전 없음(결정 0028)
  return out;
}

// 윗등급에게 넘긴 카드 한 줄(결정 0027): "윗등급에게 넘긴 카드 2장: k1 하급 → 중급 · k2 중급 → 상급"(없으면 '')
export const raisedWords = (t, raised) => (raised?.length ? t('윗등급에게 넘긴 카드 {n}장: {list}', { n: raised.length, list: raised.map((x) => `${x.id} ${(x.chain || []).join(' → ')}`).join(' · ') }) : '');

// 실패 종류 한 줄: "검수에서 걸림 2 · 원인 모름 1"(없으면 '')
export const failWords = (t, fails) => Object.entries(fails || {}).map(([k, n]) => `${failName(t, k)} ${n}`).join(' · ');
