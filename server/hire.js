// 대화에서 "에이전트 한 명 더 영입해" 같은 말을 알아채고 영입 초안을 만든다.
// AI를 쓰지 않는다(낱말 규칙). 알아챈 것은 제안일 뿐이고, 사용자가 카드에서 영입을 눌러야 에이전트가 생긴다.
//
// 일을 맡기는 말("채용 공고 정리해줘", "표에 담당 열 추가해줘")을 잡지 않으려고 좁게 본다:
//  - 문장이 영입하라는 말로 끝나야 하고(영어는 그 말로 시작해서 사람·에이전트 낱말로 끝나야 하고)
//  - 사람·에이전트를 가리키는 낱말이나 "한 명" 같은 사람 수가 있어야 한다.
//  - "추가·만들어·add" 같은 약한 말은 에이전트 낱말이나 사람 수가 그 바로 앞에 있을 때만 본다.
import { roleKind } from './routing.js';
import { tr } from './i18n.js';

const MAX_LEN = 80; // 긴 글은 일을 맡기는 말로 본다

// 한국어
const KO_PERSON = '에이전트|리서처|조사원|분석가|검수자|리뷰어|개발자|빌더|작가|기획자|담당|직원|팀원';
const KO_COUNT = '(?:\\d+|한|두|세|네)\\s*명';
const KO_END = '[.!~\\s]*$';
// 영입·채용 뒤에는 해줘·하자 같은 끝말만 올 수 있다("채용 공고 써줘"는 일을 맡기는 말)
const KO_STRONG = new RegExp(`(?:영입|채용|고용|스카우트)\\s*(?:해\\s*줘|해\\s*주세요|해\\s*줄래|해라|하자|합시다|해요|해|좀|부탁해)?${KO_END}`);
const KO_TAIL = `[가-힣]{0,4}(?:\\s*(?:줘|주세요|줄래))?${KO_END}`; // 만들어줘·데려와·추가해 줘
const KO_WHO = new RegExp(`${KO_PERSON}|${KO_COUNT}`);
const KO_WEAK = new RegExp(`(${KO_PERSON})(?:를|을|도|는|이|가)?\\s*(${KO_COUNT}|하나)?\\s*(?:더\\s*)?(?:추가|만들|넣|데려|뽑|늘려|불러)${KO_TAIL}`);

// 영어: 영입하는 말로 시작해서 사람·에이전트 낱말로 끝난다
const EN = /^(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:i\s+need|we\s+need|hire|recruit|onboard|add|bring\s+in|get)\s+(?:me\s+|us\s+)?(?:an?|another|one\s+more|a\s+new|a\s+second|\d+|two|three)\s+(?:[\w-]+\s+){0,2}(?:agent|researcher|reviewer|developer|builder|writer|analyst|tester|planner|organizer)s?(?:\s+(?:to|for|on)\s+(?:the|this|my|our)\s+team)?(?:\s*,?\s*please)?\s*[.!]?$/i;

// 중국어: 동사 … (수량) … 사람·에이전트 낱말로 끝난다
const ZH = /(招募|招聘|聘用|雇用|录用|再招|添加|增加|再加|再来|加)\s*(一个|一名|一位|两个|两名|两位|\d+\s*[个名位])?[^，。,.\n]{0,8}?(智能体|助手|调研员|研究员|审查员|分析师|开发者|写手)[。！!]?$/;
const ZH_STRONG = /招募|招聘|聘用|雇用|录用|再招/;

// 일본어
const JA_PERSON = 'エージェント|リサーチャー|レビュアー|開発者|アナリスト|ライター|担当|メンバー';
const JA_COUNT = '(?:もう)?(?:一人|1人|ひとり|二人|2人)';
const JA_TAIL = '[ぁ-ん]{0,7}[。！!]?$'; // して・してください・しよう
const JA_STRONG = new RegExp(`(?:採用|雇[っうい]|スカウト)${JA_TAIL}`);
const JA_WHO = new RegExp(`${JA_PERSON}|${JA_COUNT}`);
const JA_WEAK = new RegExp(`(${JA_PERSON})(?:を|も|の)?\\s*(${JA_COUNT})?\\s*(?:を)?(?:追加|増や|入れ)${JA_TAIL}`);

function isHire(t) {
  if (KO_STRONG.test(t) && KO_WHO.test(t)) return true;
  const ko = t.match(KO_WEAK);
  if (ko && (ko[1] === '에이전트' || ko[2])) return true;
  if (EN.test(t)) return true;
  const zh = t.match(ZH);
  if (zh && (ZH_STRONG.test(zh[1]) || zh[2] || zh[3] === '智能体')) return true;
  if (JA_STRONG.test(t) && JA_WHO.test(t)) return true;
  const ja = t.match(JA_WEAK);
  if (ja && (ja[1] === 'エージェント' || ja[2])) return true;
  return false;
}

// 역할: 영입하라는 문장 안의 역할 낱말(조사·검수·research…). roleKind 가 모르는 사람 이름 몇 개를 보탠다
function kindOf(t) {
  if (/리서처|调研员|研究员/.test(t)) return 'research';
  if (/작가|写手/.test(t)) return 'writing';
  if (/审查员/.test(t)) return 'review';
  return roleKind(t);
}

// 영입 요청이면 { kind }(역할 종류), 아니면 null
export function detectHire(text) {
  const t = String(text || '').trim();
  if (!t || t.length > MAX_LEN || t.includes('\n') || t.startsWith('/')) return null;
  return isHire(t) ? { kind: kindOf(t) } : null;
}

const LABEL = { research: '조사', organize: '정리', review: '검수', build: '빌드', analysis: '분석', writing: '글쓰기', general: '일반' };
export const roleLabel = (kind) => tr(LABEL[kind] || LABEL.general);

// 같은 이름이 있으면 뒤에 숫자를 붙인다(@이름으로 부를 때 헷갈리지 않게). 줄바꿈은 한 칸으로
export function uniqueName(name, agents) {
  const base = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 36) || tr('새 에이전트');
  const taken = new Set(agents.map((a) => String(a.name).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  const stem = base.replace(/\s*\d+$/, '');
  for (let n = 2; n < 1000; n++) if (!taken.has(`${stem} ${n}`.toLowerCase())) return `${stem} ${n}`;
  return `${stem} ${Date.now() % 100000}`;
}

export const STAGE_MAX = 8; // 한 단계에 넣을 수 있는 에이전트 수(팀 저장 규칙과 같다)

// 초안: 이 세션의 팀에서 같은 역할을 하는 에이전트를 본뜨고(없으면 전체에서, 그것도 없으면 이 세션의 기본 에이전트),
// 그 에이전트가 있는 단계를 넣을 자리로 잡는다. 권한·모델을 새로 고르지 않고 본뜬 것과 같게 둔다
export function draftHire(store, s, intent) {
  const agents = store.all('agents');
  const get = (id) => store.get('agents', id);
  const team = s.teamId ? store.get('teams', s.teamId) : null;
  const same = (a) => a && roleKind(a.role) === intent.kind;
  let base = null;
  let target = null;
  if (team && intent.kind !== 'general') {
    for (const st of team.stages) {
      const hit = (st.agentIds || []).map(get).find(same);
      if (hit) { base = hit; target = { teamId: team.id, stageId: st.id }; break; }
    }
  }
  if (!base && intent.kind !== 'general') base = agents.find((a) => same(a) && a.provider !== 'mock') || agents.find(same) || null;
  if (!base) {
    const first = team ? get(team.stages[0]?.agentIds?.[0]) : null;
    base = first || get(s.agentId) || get(store.settings.defaultAgentId) || agents[0] || null;
  }
  if (!base) return null;
  const role = intent.kind === 'general' ? (base.role || roleLabel('general')) : (same(base) ? base.role : roleLabel(intent.kind));
  const stem = String(base.name).replace(/\s*\d+$/, '') || base.name; // "조사원 2"를 본떠도 "조사원 2 2"가 되지 않게
  return { draft: { name: uniqueName(`${stem} 2`, agents), role, baseId: base.id }, target };
}
