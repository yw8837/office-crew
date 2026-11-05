// 하루 예산: 주간 한도를 하루 이틀에 다 쓰지 않게, 하루에 쓸 몫을 정해 두고 속도가 빠르면 노력을 낮춘다.
// 숫자는 전부 주간 창 사용률(%포인트)이고, 주간 기록이 없는 AI는 건드리지 않는다
const DAY = 86400e3;
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const dayOf = (t) => new Date(t).toLocaleDateString('sv-SE'); // YYYY-MM-DD(로컬)

export function nextMidnight(now = Date.now()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// 오늘의 기준점: 오늘 처음 본 주간 사용률. 앱이 꺼져 있던 동안 쓴 양은 알 수 없어서 첫 기록부터 센다.
// 주간 창이 오늘 초기화됐으면 0부터, 초기화 없이 값만 내려갔으면 그 값부터 다시 센다(쓴 양이 부풀지 않게)
export function noteWeekly(base, week, now = Date.now()) {
  if (typeof week?.pct !== 'number') return base || null;
  const today = dayOf(now);
  if (!base || base.day !== today) return { day: today, pct: week.pct, resetsAt: week.resetsAt || 0 };
  const wasReset = week.resetsAt && base.resetsAt && week.resetsAt - base.resetsAt > 3600;
  if (wasReset) return { ...base, pct: 0, resetsAt: week.resetsAt };
  if (week.pct < base.pct) return { ...base, pct: week.pct, resetsAt: week.resetsAt || base.resetsAt };
  return week.resetsAt && week.resetsAt !== base.resetsAt ? { ...base, resetsAt: week.resetsAt } : base;
}

// 지금 속도: spent(오늘 쓴 %포인트), over(다 씀), steps(노력을 몇 단계 낮출지. 다 썼으면 맨 아래까지). 모르면 null
// 하루 몫의 1/4을 쓰기 전에는 낮추지 않는다(자정 직후 1%만 써도 낮아지지 않게)
export function dayBudget(base, week, percent, now = Date.now()) {
  if (typeof week?.pct !== 'number' || !base || !(percent > 0)) return null;
  const live = !week.resetsAt || week.resetsAt * 1000 > now; // 주간 창이 이미 지났으면 옛 기록이다
  const spent = live && base.day === dayOf(now) ? Math.max(0, week.pct - base.pct) : 0;
  const leftBudget = Math.max(0, percent - spent) / percent;
  const leftTime = (nextMidnight(now) - now) / DAY;
  const over = spent >= percent;
  const released = base.releasedDay === dayOf(now); // 오늘은 그만 막으라고 사용자가 풀어 줌
  if (released) return { spent, allowance: percent, over: false, steps: 0, released: true };
  const pacing = spent >= percent / 4;
  const steps = over ? LADDER.length : !pacing ? 0 : leftBudget < leftTime / 2 ? 2 : leftBudget < leftTime ? 1 : 0;
  return { spent, allowance: percent, over, steps };
}

// 노력 낮추기: 위로 올리지 않고 low 아래로 내리지 않는다. 비어 있으면(CLI 기본) medium 으로 본다
export function lowerEffort(effort, steps) {
  if (!steps) return effort;
  const i = LADDER.indexOf(effort || 'medium');
  return i < 0 ? effort : LADDER[Math.max(0, i - steps)];
}
