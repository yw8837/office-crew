// 사용량 집계(토큰·비용)와 계정 한도(5시간·주간 %) 관리
import { readCodexLimits } from './providers/codex.js';

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
    if (announce) this.#changed();
    else this.store.saveUsage();
  }

  // 사용자가 "지금 다시 쓰기"를 누르면 지금까지의 한도 기록으로는 피하지 않는다(새 기록이 오면 다시 따름)
  release(provider) {
    const l = this.store.usage.limits?.[provider];
    if (!l) return;
    l.releasedAt = Date.now();
    this.#changed();
  }

  snapshot() {
    const u = this.store.usage;
    return { byProvider: u.byProvider, byAgent: u.byAgent, today: u.byDay[day()] || {}, limits: u.limits };
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
