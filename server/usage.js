// 사용량 집계(토큰·비용)와 계정 한도(5시간·주간 %) 관리
import { readCodexLimits } from './providers/codex.js';
import { noteWeekly, dayBudget } from './budget.js';

const day = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE'); // YYYY-MM-DD(로컬)
const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 });

// ── Claude 사용량 정산(결정 0012) ──
// 결과의 usage 는 그 차례의 주 에이전트 몫만, modelUsage·total_cost_usd 는 하위 에이전트까지 든 값이다.
// 대화를 이어 가면(resume) modelUsage·total_cost_usd 는 그 대화 전체의 누적이라, 같은 대화의 직전 누적(baseline)을 빼서 이번 몫을 구한다
const TOKENS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const FIELDS = [['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cacheReadInputTokens'], ['cacheWrite', 'cacheCreationInputTokens'], ['cost', 'costUSD']];
const amount = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const tokenSum = (u) => TOKENS.reduce((n, k) => n + (u[k] || 0), 0);

// modelUsage(모델 이름 → 토큰·비용)의 모든 모델 합 { input, output, cacheRead, cacheWrite, cost }. 없거나 값이 이상하면 null
export function treeTotals(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return null;
  const models = Object.values(modelUsage);
  if (!models.length) return null;
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const m of models) {
    if (!m || typeof m !== 'object') return null;
    for (const [k, f] of FIELDS) {
      if (m[f] === undefined) continue;
      const v = amount(m[f]);
      if (v === null) return null;
      sum[k] += v;
    }
  }
  return sum;
}

// 이번 호출 몫. usage: 이번 호출의 주 에이전트 몫, modelUsage·totalCost: 결과 그대로, baseline: 같은 CLI 대화의 직전 누적(없으면 null),
// resumed: 이어 간 대화인지. 모르는 것은 실제보다 많이 세지 않고 partial 로 표시한다.
// → { input, output, cacheRead, cacheWrite, cost, cumulative(다음 baseline, 모르면 null), partial, sub(하위 에이전트 몫으로 보이는 토큰) }
export function settleClaude({ usage = {}, modelUsage = null, totalCost = null, baseline = null, resumed = false } = {}) {
  const main = Object.fromEntries(TOKENS.map((k) => [k, amount(usage?.[k]) ?? 0]));
  const cum = treeTotals(modelUsage);
  const costNow = amount(totalCost) ?? cum?.cost ?? null; // 비용 누적
  const baseCost = amount(baseline?.cost);
  // 비용: 누적 − 직전 누적. 음수거나(초기화·옛 버전) 토큰이 호출 몫으로 보이면 이번 값 그대로
  const costOf = (perCall) => (costNow === null ? 0 : baseCost === null || perCall || costNow < baseCost ? costNow : costNow - baseCost);
  const done = (tok, cost, partial) => {
    const out = Object.fromEntries(TOKENS.map((k) => [k, Math.max(amount(tok[k]) ?? 0, main[k])])); // 항목마다 주 에이전트 몫보다 작아지지 않는다
    const cumulative = cum ? { ...Object.fromEntries(TOKENS.map((k) => [k, cum[k]])), cost: costNow } : null;
    return { ...out, cost, cumulative, partial, sub: Math.max(0, tokenSum(out) - tokenSum(main)) };
  };
  // modelUsage 가 없으면 하위 에이전트 몫이 들었는지 모른다
  if (!cum) return done(main, costOf(false), true);
  const base = baseCost !== null && TOKENS.every((k) => amount(baseline[k]) !== null) ? baseline : null;
  // 이어 간 대화인데 직전 누적이 없으면 앞 사용량이 섞였을 수 있다: 주 에이전트 몫만 세고, 비용은 알 수 없어 더하지 않는다
  if (!base && resumed) return done(main, 0, true);
  const delta = base ? Object.fromEntries(TOKENS.map((k) => [k, cum[k] - base[k]])) : cum;
  // 누적이 이번 주 에이전트 몫만큼도 안 늘었으면(옛 버전·초기화) 받은 값이 이번 호출 몫이다(그것도 주 에이전트 몫보다 작으면 주 에이전트 몫)
  if (tokenSum(delta) < tokenSum(main)) return done(tokenSum(cum) >= tokenSum(main) ? cum : main, base ? costOf(true) : costNow, false);
  return done(delta, base ? costOf(false) : costNow, false);
}

export class Usage {
  constructor(store, bus) {
    this.store = store;
    this.bus = bus;
    this.timer = null;
    const u = store.usage;
    u.byProvider ||= {};
    u.byDay ||= {};
    u.byAgent ||= {};
    u.limits ||= {};
    u.dayBase ||= {}; // 하루 예산: AI별 오늘 처음 본 주간 사용률
  }

  init() {
    const lim = readCodexLimits();
    if (lim) this.setLimits(lim, false);
  }

  record(providerId, agentId, ev) {
    const u = this.store.usage;
    const today = day();
    u.byDay[today] ||= {};
    for (const bucket of [
      (u.byProvider[providerId] ||= blank()),
      (u.byDay[today][providerId] ||= blank()),
      (u.byAgent[agentId] ||= blank()),
    ]) {
      bucket.input += ev.input || 0;
      bucket.output += ev.output || 0;
      bucket.cacheRead += ev.cacheRead || 0;
      bucket.cacheWrite += ev.cacheWrite || 0;
      bucket.cost += ev.cost || 0;
      bucket.calls += 1;
    }
    // 오래된 날짜는 60일만 보관
    const days = Object.keys(u.byDay).sort();
    while (days.length > 60) delete u.byDay[days.shift()];
    this.#changed();
  }

  setLimits({ provider, windows, plan, status, observedAt }, announce = true) {
    if (!provider || !windows || !Object.keys(windows).length) return;
    this.store.usage.limits[provider] = { windows, plan: plan || '', status: status || '', observedAt: observedAt || Date.now() };
    // 주간 창이 빠진 이벤트(5시간 창만 온 경우)가 와도 예산이 풀리지 않게 마지막 주간 값을 따로 둔다
    const week = windows.seven_day;
    if (typeof week?.pct === 'number') {
      const base = noteWeekly(this.store.usage.dayBase[provider], week);
      this.store.usage.dayBase[provider] = { ...base, week: { pct: week.pct, resetsAt: week.resetsAt || 0 } };
    }
    if (announce) this.#changed();
    else this.store.saveUsage();
  }

  // 사용자가 "지금 다시 쓰기"를 누르면 지금까지의 한도 기록으로는 피하지 않는다(새 기록이 오면 다시 따름)
  release(provider) {
    const l = this.store.usage.limits?.[provider];
    if (!l) return;
    l.releasedAt = Date.now();
    // 하루 예산으로 피하는 중이었을 때만 오늘은 더 막지 않는다(5시간 한도를 푼 걸로 예산까지 꺼지지 않게)
    if (this.budget(provider)?.over) this.store.usage.dayBase[provider].releasedDay = day();
    this.#changed();
  }

  forget(provider) {
    delete this.store.usage.limits[provider];
    delete this.store.usage.dayBase[provider];
    this.#changed();
  }

  // 하루 예산 속도(꺼져 있거나 주간 기록이 없으면 null)
  budget(provider) {
    const st = this.store.settings;
    if (!st.dailyBudget) return null;
    const base = this.store.usage.dayBase[provider];
    return dayBudget(base, base?.week, Number(st.dailyBudgetPercent) || 13);
  }

  overBudget() {
    return new Set(Object.keys(this.store.usage.dayBase).filter((p) => this.budget(p)?.over));
  }

  snapshot() {
    const u = this.store.usage;
    // 오늘 쓴 %포인트: 설정을 바꿔도 화면이 바로 계산할 수 있게 항상 보낸다
    const spent = {};
    for (const [p, base] of Object.entries(u.dayBase)) {
      const b = dayBudget(base, base.week, 100);
      if (b) spent[p] = b.spent;
    }
    return { byProvider: u.byProvider, byAgent: u.byAgent, today: u.byDay[day()] || {}, limits: u.limits, daySpent: spent, spentDay: day() };
  }

  close() { clearTimeout(this.timer); }

  #changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.store.saveUsage();
      this.bus.emit('usage', this.snapshot());
    }, 250);
  }
}
