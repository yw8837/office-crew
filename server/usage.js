// 사용량 집계(토큰·비용)와 계정 한도(5시간·주간 %) 관리
import { readCodexLimits } from './providers/codex.js';
import { noteWeekly, dayBudget } from './budget.js';

const day = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE'); // YYYY-MM-DD(로컬)
const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 });

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
