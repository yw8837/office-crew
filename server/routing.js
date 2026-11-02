// 자동 라우팅: 역할 + 프로필(경제·균형·최고)에 맞춰, 지금 쓸 수 있는 AI 중에서 모델·노력을 고른다
// 모델 등급(tier): fast(빠르고 저렴) · balanced(일반) · top(최상) · local(내 PC)

export const PROFILES = ['economy', 'balanced', 'best'];
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// 역할 이름 → 역할 종류
export function roleKind(role = '') {
  const r = String(role).toLowerCase();
  if (/조사|검색|리서치|research|search|调研|调查|検索|調査|リサーチ/.test(r)) return 'research';
  if (/정리|요약|organize|summar|整理|总结|要約/.test(r)) return 'organize';
  if (/검수|리뷰|테스트|검토|review|test|qa|审查|测试|レビュー|テスト/.test(r)) return 'review';
  if (/빌드|구현|개발|코딩|build|implement|code|dev|构建|开发|実装|開発|ビルド/.test(r)) return 'build';
  if (/분석|계획|기획|설계|analy|plan|design|分析|计划|設計|計画/.test(r)) return 'analysis';
  if (/글|작성|번역|write|writ|translat|写作|翻译|執筆|翻訳/.test(r)) return 'writing';
  return 'general';
}

// 역할별 후보: [프로바이더, 등급, 프로필별 노력]. 앞에서부터, 로그인된 것 중 첫 번째를 쓴다
const E = (economy, balanced, best) => ({ economy, balanced, best });
const CANDIDATES = {
  research: [['claude', 'balanced', E('low', 'medium', 'high')], ['codex', 'balanced', E('low', 'medium', 'high')], ['gemini', 'balanced', E('low', 'medium', 'high')], ['openai', 'balanced', E('low', 'medium', 'high')], ['local', 'local', E('low', 'medium', 'high')]],
  organize: [['codex', 'balanced', E('low', 'low', 'medium')], ['claude', 'balanced', E('low', 'low', 'medium')], ['openai', 'balanced', E('low', 'low', 'medium')], ['local', 'local', E('low', 'low', 'medium')]],
  analysis: [['claude', 'top', E('low', 'high', 'xhigh')], ['codex', 'top', E('low', 'high', 'xhigh')], ['openai', 'top', E('low', 'high', 'high')], ['local', 'local', E('low', 'high', 'high')]],
  // 사용자 기준 예시(분석=오푸스 하이, 빌드=오푸스 X하이)에 맞춘 균형값
  build: [['claude', 'top', E('low', 'xhigh', 'max')], ['codex', 'top', E('low', 'xhigh', 'max')], ['local', 'local', E('low', 'medium', 'high')]],
  review: [['codex', 'top', E('low', 'medium', 'high')], ['claude', 'top', E('low', 'medium', 'high')], ['local', 'local', E('low', 'medium', 'high')]],
  writing: [['claude', 'balanced', E('low', 'medium', 'high')], ['codex', 'balanced', E('low', 'medium', 'high')], ['openai', 'balanced', E('low', 'medium', 'high')], ['local', 'local', E('low', 'medium', 'high')]],
  general: [['claude', 'balanced', E('low', 'medium', 'high')], ['codex', 'balanced', E('low', 'medium', 'high')], ['openai', 'balanced', E('low', 'medium', 'high')], ['local', 'local', E('low', 'medium', 'high')]],
};

// 경제 프로필은 등급을 한 단계 낮추고, 최고 프로필은 한 단계 올린다
function wantedTier(tier, profile) {
  if (tier === 'local') return 'local';
  if (profile === 'economy') return tier === 'top' ? 'balanced' : 'fast';
  if (profile === 'best') return 'top';
  return tier;
}

// 원하는 노력이 모델에서 안 되면 가장 가까운 지원 단계로
export function clampEffort(want, supported) {
  if (!supported?.length) return '';
  if (supported.includes(want)) return want;
  const wi = EFFORT_ORDER.indexOf(want);
  return [...supported].sort((a, b) => Math.abs(EFFORT_ORDER.indexOf(a) - wi) - Math.abs(EFFORT_ORDER.indexOf(b) - wi))[0];
}

// 프로바이더마다 "자기 계열" 모델을 먼저 고른다(여러 회사 모델을 파는 경로에서 그 회사 모델 우선)
const NATIVE = { gemini: /gemini/i, codex: /gpt|codex|\bo\d/i, claude: /./ };

// 모델 목록에서 등급에 맞는 모델 고르기(자기 계열 우선 → 없으면 가까운 등급)
export function pickModel(models, tier, providerId = '') {
  const usable = (models || []).filter((m) => !m.hidden && !m.legacy && m.id);
  const order = { fast: ['fast', 'balanced', 'top'], balanced: ['balanced', 'top', 'fast'], top: ['top', 'balanced', 'fast'], local: ['local', 'balanced', 'top', 'fast'] }[tier] || ['balanced'];
  const native = NATIVE[providerId];
  const pools = native ? [usable.filter((m) => native.test(m.id)), usable] : [usable];
  for (const pool of pools) {
    for (const t of order) {
      const m = pool.find((x) => (x.tier || 'balanced') === t);
      if (m) return m;
    }
  }
  return usable[0] || null;
}

/**
 * 자동 라우팅 계산
 * @param agent { role, routingProfile }
 * @param ctx { providers: [{id, loggedIn, efforts}], models: { [providerId]: [{id,label,tier,efforts,hidden,legacy}] }, avoid?: providerId }
 * @returns { provider, model, modelLabel, effort, reason } | null
 */
export function resolveRoute(agent, ctx) {
  const profile = PROFILES.includes(agent.routingProfile) ? agent.routingProfile : 'balanced';
  const kind = roleKind(agent.role);
  const ready = new Set((ctx.providers || []).filter((p) => p.loggedIn).map((p) => p.id));
  const list = CANDIDATES[kind] || CANDIDATES.general;
  // 검수는 가능하면 빌드와 다른 AI로(교차 검증)
  const ordered = ctx.avoid ? [...list.filter((c) => c[0] !== ctx.avoid), ...list.filter((c) => c[0] === ctx.avoid)] : list;
  for (const [pid, tier, efforts] of ordered) {
    if (!ready.has(pid)) continue;
    const m = pickModel(ctx.models?.[pid], wantedTier(tier, profile), pid);
    if (!m) continue;
    const prov = (ctx.providers || []).find((p) => p.id === pid);
    const supported = m.efforts?.length ? m.efforts : (prov?.efforts || []);
    return {
      provider: pid, model: m.id, modelLabel: m.label || m.id,
      effort: clampEffort(efforts[profile], supported),
      reason: `${kind}·${profile} → ${pid}/${m.label || m.id}`,
    };
  }
  return null;
}
