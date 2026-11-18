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
export const tokenSum = (u) => TOKENS.reduce((n, k) => n + (u[k] || 0), 0);

// 이어 간 대화의 누적을 되살려 내기 시작한 Claude Code 버전. 그 전 버전은 이어 가도 0부터 센다
export const CUMULATIVE_FROM = '2.1.277';
const semver = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?![\w.])/.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
};
// 버전 a 가 b 이상이면 true, 아니면 false. 둘 중 하나라도 읽을 수 없으면 null
export function versionAtLeast(a, b) {
  const x = semver(a), y = semver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

// modelUsage(모델 이름 → 토큰·비용)의 모든 모델 합 { input, output, cacheRead, cacheWrite, cost }. 없거나 값이 이상하면 null(빈 칸·null 칸은 0)
export function treeTotals(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return null;
  const models = Object.values(modelUsage);
  if (!models.length) return null;
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const m of models) {
    if (!m || typeof m !== 'object') return null;
    for (const [k, f] of FIELDS) {
      if (m[f] === undefined || m[f] === null) continue;
      const v = amount(m[f]);
      if (v === null) return null;
      sum[k] += v;
    }
  }
  return sum;
}

// 이번 호출 몫. usage: 이번 결과의 주 에이전트 몫, modelUsage·totalCost: 결과 그대로, baseline: 직전 누적(없으면 null),
// resumed: 앞 대화를 이어 간 결과인지(같은 프로세스의 다음 결과 포함), sameCall: baseline 이 같은 CLI 프로세스의 앞 결과인지,
// cliVersion: CLI 버전 문자열(모르면 null). 모르는 것은 실제보다 많이 세지 않고(덜 세고) partial 로 표시한다.
// → { input, output, cacheRead, cacheWrite, cost, cumulative(이 결과의 누적, 모르면 null), partial, sub(주 에이전트 밖에서 쓴 것으로 보이는 토큰) }
export function settleClaude({ usage = {}, modelUsage = null, totalCost = null, baseline = null, resumed = false, sameCall = false, cliVersion = null } = {}) {
  const main = Object.fromEntries(TOKENS.map((k) => [k, amount(usage?.[k]) ?? 0]));
  const cum = treeTotals(modelUsage);
  const costNow = amount(totalCost) ?? cum?.cost ?? null; // 비용 누적
  // 결과가 앞 사용량까지 든 누적인가: 한 프로세스 안의 결과끼리는 버전과 상관없이 누적이고(스트림 입력),
  // 프로세스를 새로 띄워 이어 갈 때는 2.1.277부터 누적(정상 종료 때 저장한 값을 되살린다), 그 전 버전은 0부터. 모르면 null
  const carries = sameCall ? true : versionAtLeast(cliVersion, CUMULATIVE_FROM);
  const base = carries !== false && baseline && amount(baseline.cost) !== null && TOKENS.every((k) => amount(baseline[k]) !== null) ? baseline : null;
  const mixed = resumed && carries !== false; // 앞 사용량이 섞였을 수 있다(옛 버전은 이어 가도 0부터라 섞이지 않는다)
  // 비용: 누적 − 직전 누적. 음수면 0 + partial. 직전 누적이 없으면 앞 사용량이 섞였을 수 있을 때 0 + partial, 아니면 받은 값 그대로
  const costPart = () => {
    if (costNow === null) return [0, false];
    if (base) return costNow >= base.cost ? [costNow - base.cost, false] : [0, true];
    return mixed ? [0, true] : [costNow, false];
  };
  const done = (tok, [cost, costPartial], partial) => {
    const out = Object.fromEntries(TOKENS.map((k) => [k, Math.max(amount(tok[k]) ?? 0, main[k])])); // 항목마다 주 에이전트 몫보다 작아지지 않는다
    const cumulative = cum ? { ...Object.fromEntries(TOKENS.map((k) => [k, cum[k]])), cost: costNow ?? 0 } : null;
    return { ...out, cost, cumulative, partial: partial || costPartial, sub: Math.max(0, tokenSum(out) - tokenSum(main)) };
  };
  const ownOrMain = () => (cum && tokenSum(cum) >= tokenSum(main) ? cum : main); // 받은 값이 이번 호출 몫(주 에이전트 몫보다 작으면 주 에이전트 몫)
  // modelUsage 가 없으면 하위 에이전트 몫이 들었는지 모른다
  if (!cum) return done(main, costPart(), true);
  if (!base) {
    // 이어 간 대화인데 직전 누적이 없으면 앞 사용량이 섞였을 수 있다: 주 에이전트 몫만 세고, 비용은 알 수 없어 더하지 않는다
    if (mixed) return done(main, [0, true], true);
    return done(ownOrMain(), costPart(), false); // 새 대화의 첫 결과, 또는 옛 버전의 호출 몫
  }
  const delta = Object.fromEntries(TOKENS.map((k) => [k, cum[k] - base[k]]));
  if (tokenSum(delta) >= tokenSum(main)) return done(delta, costPart(), false);
  // 누적이 줄었거나 이번 주 에이전트 몫만큼도 안 늘었다(앱이 끄거나 죽어서 저장되지 않은 결과가 직전 누적에 있었다 등):
  // 누적 전체를 이번 몫으로 쓰지 않고 주 에이전트 몫만 센다. 버전을 모르고 이어 가지 않은 호출이면 받은 값이 이번 호출 몫이다
  if (mixed || carries === true) return done(main, costPart(), true);
  return done(ownOrMain(), [costNow ?? 0, false], false);
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
