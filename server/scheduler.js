// 예약 작업: 정해 둔 요일·시각에 팀(또는 에이전트 한 명)에게 같은 지시를 보내 새 세션(또는 같은 세션)으로 실행한다
//   시각은 이 PC의 현지 시각. 앱이 꺼져 있어 놓친 실행은 기본으로 건너뛰고(켜지자마자 사용량을 쓰지 않게), catchUp 이면 켜질 때 한 번만 실행
//   지난 실행이 아직 안 끝났으면 이번 회차는 건너뛴다(같은 일이 겹쳐 쌓이지 않게)
import fs from 'node:fs';
import path from 'node:path';
import { unsafeWorkdir } from './config.js';
import { tr } from './i18n.js';

export const GRACE_MS = 10 * 60 * 1000; // 예정 시각에서 이만큼 늦은 것까지는 제때 실행으로 본다(절전 해제·잠깐 꺼짐)
const TICK_MS = 20 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// store 를 주면 고른 팀·에이전트가 실제로 있는지도 본다
export function cleanSchedule(x, prev = null, store = null) {
  const name = String(x.name || '').trim().slice(0, 40);
  if (!name) throw Object.assign(new Error(tr('예약 이름이 필요해.')), { status: 400 });
  const prompt = String(x.prompt || '').trim().slice(0, 8000);
  if (!prompt) throw Object.assign(new Error(tr('예약할 지시 내용이 필요해.')), { status: 400 });
  const time = String(x.time || '');
  if (!TIME_RE.test(time)) throw Object.assign(new Error(tr('시각은 00:00~23:59 형식으로 넣어줘.')), { status: 400 });
  const days = [...new Set((Array.isArray(x.days) ? x.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!days.length) throw Object.assign(new Error(tr('요일을 하나 이상 골라줘.')), { status: 400 });
  const teamId = x.teamId ? String(x.teamId) : null;
  const agentId = !teamId && x.agentId ? String(x.agentId) : null;
  if (!teamId && !agentId) throw bad(tr('맡길 팀이나 에이전트를 골라줘.'));
  if (store && teamId && !store.get('teams', teamId)) throw bad(tr('없는 팀이야.'));
  if (store && agentId && !store.get('agents', agentId)) throw bad(tr('없는 에이전트야.'));
  const cwd = String(x.cwd || '').trim();
  if (cwd && !(path.isAbsolute(cwd) && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) throw bad(tr('그 폴더가 없어.'));
  const session = x.session === 'same' ? 'same' : 'new';
  // 이어 쓸 세션은 맡길 대상·폴더가 그대로일 때만 유지(바꿨는데 예전 팀이 계속 일하지 않게)
  const keepSession = prev?.sessionId && session === 'same' && prev.session === 'same' && prev.teamId === teamId && prev.agentId === agentId && (prev.cwd || '') === cwd;
  return {
    id: x.id, name, prompt, time, days, teamId, agentId, cwd,
    enabled: x.enabled === undefined ? true : x.enabled === true, session, catchUp: x.catchUp === true,
    // 기존 실행 기록은 클라이언트가 보낸 값이 아니라 저장된 값을 이어 쓴다
    lastRun: prev?.lastRun || null, resultSessionId: prev?.resultSessionId || null, sessionId: keepSession ? prev.sessionId : null,
  };
}

// base 날짜에서 dayOffset 일 뒤의 예약 시각(현지 시각, 서머타임은 Date 가 맞춘다)
const at = (base, dayOffset, s) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, Number(s.time.slice(0, 2)), Number(s.time.slice(3, 5))).getTime();

// now 이하인 가장 최근 예정 시각(최근 8일 안에서), 없으면 null
export function lastOccurrence(s, now) {
  const base = new Date(now);
  for (let d = 0; d <= 7; d++) {
    const t = at(base, -d, s);
    if (t <= now && s.days.includes(new Date(t).getDay())) return t;
  }
  return null;
}

// now 보다 뒤인 다음 예정 시각
export function nextOccurrence(s, now) {
  const base = new Date(now);
  for (let d = 0; d <= 7; d++) {
    const t = at(base, d, s);
    if (t > now && s.days.includes(new Date(t).getDay())) return t;
  }
  return null;
}

export class Scheduler {
  constructor({ store, orch, bus, now = () => Date.now() }) {
    Object.assign(this, { store, orch, bus, now });
    this.timer = null;
    this.bootTimer = null;
    this.lockFile = null;
  }

  list() {
    const now = this.now();
    return this.store.all('schedules').map((s) => ({ ...s, nextAt: s.enabled ? nextOccurrence(s, now) : null }));
  }

  emit() { this.bus.emit('schedules', this.list()); }

  // 만들거나 고친 순간 이전 회차는 이미 지나간 걸로 친다(고치자마자 놓친 실행이 돌지 않게)
  save(obj) {
    const s = this.store.upsert('schedules', { ...obj, handledAt: this.now() }, 'sched');
    this.emit();
    return { ...s, nextAt: s.enabled ? nextOccurrence(s, this.now()) : null };
  }

  // home 폴더 하나에 시계는 하나만: 같은 데이터 폴더로 앱을 두 개 띄워도 회차가 두 번 돌지 않게
  start() {
    this.stop();
    const file = path.join(this.store.dirs.home, 'scheduler.lock');
    if (!acquireLock(file)) { console.warn(tr('같은 데이터 폴더를 쓰는 다른 오피스 크루가 예약 작업을 맡고 있어서, 여기서는 예약을 돌리지 않아.')); return false; }
    this.lockFile = file;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    // 켜질 때 한 번: 꺼져 있던 동안 놓친 회차를 정리(catchUp 이면 실행)
    this.bootTimer = setTimeout(() => this.tick(), 3000);
    this.bootTimer.unref?.();
    return true;
  }

  stop() {
    clearInterval(this.timer); clearTimeout(this.bootTimer);
    this.timer = null; this.bootTimer = null;
    if (this.lockFile) { releaseLock(this.lockFile); this.lockFile = null; }
  }

  tick(now = this.now()) {
    let changed = false;
    for (const s of this.store.all('schedules')) {
      if (!s.enabled) continue;
      let handled = s.handledAt || s.createdAt || 0;
      // PC 시계가 미래로 튀었다 돌아왔으면 그 시각에 묶여 영영 안 돌지 않게 지금으로 당긴다(지난 회차는 다시 돌지 않음)
      if (handled > now + 60_000) { handled = now; this.store.upsert('schedules', { id: s.id, handledAt: now }); }
      const occ = lastOccurrence(s, now);
      if (occ == null || occ <= handled) continue;
      const late = now - occ;
      this.store.upsert('schedules', { id: s.id, handledAt: now });
      if (late <= GRACE_MS || s.catchUp) this.fire(s, { late: late > GRACE_MS, now });
      else this.#record(s, { at: now, due: occ, status: 'missed', note: tr('앱이 꺼져 있었거나 PC가 잠들어 있어서 건너뛰었어.') });
      changed = true;
    }
    if (changed) this.emit();
  }

  // 회차 하나 실행. manual 은 "지금 실행" 버튼
  fire(s, { manual = false, late = false, now = this.now() } = {}) {
    const busy = (id) => id && this.orch.ctx.has(id);
    const rec = (status, extra = {}) => this.#record(s, { at: now, status, manual, late, ...extra });
    const prevId = s.resultSessionId || s.lastRun?.sessionId;
    if (busy(prevId) || (s.session === 'same' && busy(s.sessionId))) return rec('skipped', { sessionId: prevId || s.sessionId, note: tr('지난 실행이 아직 안 끝나서 이번 회차는 건너뛰었어.') });
    if (s.teamId && !this.store.get('teams', s.teamId)) return rec('error', { note: tr('예약에 고른 팀이 없어졌어.') });
    if (s.agentId && !this.store.get('agents', s.agentId)) return rec('error', { note: tr('예약에 고른 에이전트가 없어졌어.') });
    if (s.cwd && !fs.existsSync(s.cwd)) return rec('error', { note: tr('예약에 고른 작업 폴더가 없어.') });
    if (s.cwd && unsafeWorkdir(s.cwd, this.orch.dirs?.home)) return rec('error', { note: tr('예약에 고른 작업 폴더는 에이전트에게 맡기기 위험해. 프로젝트 폴더로 바꿔줘.') });
    // 사람이 안 볼 때 도는 실행은 더 엄격하게: 맡을 AI가 오늘 몫을 다 썼으면 낮은 노력으로 돌리지 않고 건너뛴다("지금 실행"은 그대로)
    if (!manual && this.#outOfBudget(s)) return rec('skipped', { note: tr('맡을 AI가 오늘 예산을 다 써서 이번 회차는 건너뛰었어.') });
    try {
      let sess = s.session === 'same' && s.sessionId ? this.store.getSession(s.sessionId) : null;
      // 이어 쓸 세션이 지금 예약과 대상·폴더가 다르면(직접 바꿨거나 옛 기록) 새 세션으로
      if (sess && !(sess.teamId === s.teamId && (sess.agentId || null) === s.agentId && (sess.cwd || '') === s.cwd)) sess = null;
      if (!sess) {
        const d = new Date(now);
        const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        sess = this.store.createSession({ title: `⏰ ${s.name}${s.session === 'same' ? '' : ` · ${stamp}`}`, teamId: s.teamId, agentId: s.agentId, cwd: s.cwd });
        sess.scheduleId = s.id;
        this.store.saveSessionNow(sess);
        this.bus.emit('session', this.store.sessionMeta(sess));
      }
      this.orch.send(sess.id, { text: s.prompt });
      this.store.upsert('schedules', { id: s.id, resultSessionId: sess.id, ...(s.session === 'same' ? { sessionId: sess.id } : {}) });
      return rec('started', { sessionId: sess.id });
    } catch (e) {
      return rec('error', { note: e.message });
    }
  }

  // 에이전트 중 하나라도 오늘 예산 안에서 맡을 AI가 없으면 true(이어받기가 켜져 있거나 자동 라우팅이면 다른 AI도 후보)
  #outOfBudget(s) {
    const over = this.store.settings.dailyBudget ? this.orch.usage?.overBudget() : null;
    if (!over?.size) return false;
    const team = s.teamId ? this.store.get('teams', s.teamId) : null;
    const ids = team ? team.stages.flatMap((st) => st.agentIds) : [s.agentId];
    const others = (this.orch.providers?.list() || []).filter((p) => p.loggedIn && p.id !== 'mock');
    const anyFree = others.some((p) => !over.has(p.id));
    return ids.map((id) => this.store.get('agents', id)).filter(Boolean).some((a) => {
      if (a.routing === 'auto') return others.length > 0 && !anyFree;
      if (!over.has(a.provider)) return false;
      return this.store.settings.failover === false || !anyFree;
    });
  }

  #record(s, lastRun) {
    const clean = Object.fromEntries(Object.entries(lastRun).filter(([, v]) => v !== false && v != null));
    this.store.upsert('schedules', { id: s.id, lastRun: clean });
    return clean;
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// 잠금 파일에 pid 를 적는다. 이미 있으면 그 프로세스가 살아 있는지 보고, 죽었으면(앱이 비정상 종료) 이어받는다
function acquireLock(file) {
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return true; } catch (e) { if (e.code !== 'EEXIST') return true; }
  const pid = Number(fs.readFileSync(file, 'utf8')) || 0;
  if (pid && pid !== process.pid && alive(pid)) return false;
  fs.writeFileSync(file, String(process.pid));
  return true;
}

function releaseLock(file) {
  try { if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.rmSync(file, { force: true }); } catch { /* 이미 없음 */ }
}
