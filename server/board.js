// 칸반 보드: 할 일 카드를 팀(또는 에이전트 한 명)에게 맡기면 세션 상태에 따라 칸이 저절로 옮겨 간다.
// 칸: 할 일(아직 안 맡김) → 진행 중(일하는 중) → 확인 필요(승인·오류·끝난 결과) → 완료(사람이 완료를 눌렀을 때만)
import fs from 'node:fs';
import path from 'node:path';
import { unsafeWorkdir } from './config.js';
import { newId } from './store.js';
import { tr } from './i18n.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const ACTIVE = new Set(['running', 'pending', 'queued']);

export function cleanTask(x = {}, { store, appHome } = {}, prev = null) {
  const title = String(x.title || '').trim().slice(0, 120);
  if (!title) throw bad(tr('카드 제목을 적어줘.'));
  const teamId = x.teamId ? String(x.teamId) : null;
  const agentId = !teamId && x.agentId ? String(x.agentId) : null;
  if (!teamId && !agentId) throw bad(tr('맡길 팀이나 에이전트를 골라줘.'));
  if (store && teamId && !store.get('teams', teamId)) throw bad(tr('없는 팀이야.'));
  if (store && agentId && !store.get('agents', agentId)) throw bad(tr('없는 에이전트야.'));
  const cwd = String(x.cwd || '').trim();
  if (cwd && !(path.isAbsolute(cwd) && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) throw bad(tr('그 폴더가 없어.'));
  if (cwd && unsafeWorkdir(cwd, appHome)) throw bad(tr('이 폴더는 작업 폴더로 쓸 수 없어. 드라이브 맨 위, 홈 폴더 전체, 앱 데이터 폴더는 에이전트에게 맡기기 위험해. 프로젝트 폴더를 골라줘.'));
  return {
    id: prev?.id || newId('task'), title, detail: String(x.detail || '').slice(0, 20000), teamId, agentId, cwd,
    // 실행 기록은 클라이언트가 보낸 값이 아니라 저장된 값을 이어 쓴다
    sessionId: prev?.sessionId || null, closedAt: prev?.closedAt || null, createdAt: prev?.createdAt || Date.now(),
  };
}

export class Board {
  constructor({ store, orch, bus, appHome }) {
    Object.assign(this, { store, orch, bus, appHome });
    this.timer = null;
    // 맡긴 세션의 상태가 바뀌면 칸도 바뀌니 화면에 알린다
    bus.on((type, d) => {
      const id = type === 'run' ? d.sessionId : type === 'sessionDeleted' ? d.id : null;
      if (id && this.store.all('tasks').some((t) => t.sessionId === id)) this.#changed();
    });
  }

  #changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.bus.emit('tasks', this.list()), 80);
    this.timer.unref?.();
  }

  columnOf(t) {
    if (t.closedAt) return 'done';
    const s = t.sessionId ? this.store.getSession(t.sessionId) : null;
    if (!s) return 'todo';
    if (this.orch.ctx.has(s.id)) {
      const st = s.runs.at(-1)?.status;
      return st === 'waiting' || st === 'paused' ? 'check' : 'doing';
    }
    const last = s.runs.at(-1);
    return last && ACTIVE.has(last.status) ? 'doing' : 'check';
  }

  list() {
    return this.store.all('tasks').map((t) => ({
      ...t, column: this.columnOf(t), sessionId: t.sessionId && this.store.getSession(t.sessionId) ? t.sessionId : null,
      working: !!t.sessionId && this.orch.ctx.has(t.sessionId), // 승인을 기다리는 동안도 실행은 안 끝났다
    })).sort((a, b) => a.createdAt - b.createdAt);
  }

  #get(id) {
    const t = this.store.get('tasks', id);
    if (!t) throw bad(tr('카드가 없어.'), 404);
    return t;
  }

  save(body, id = null) {
    const prev = id ? this.#get(id) : null;
    const t = cleanTask(body, { store: this.store, appHome: this.appHome }, prev);
    this.store.upsert('tasks', t);
    this.#changed();
    return t;
  }

  remove(id) {
    this.#get(id);
    this.store.remove('tasks', id);
    this.#changed();
    return { ok: true };
  }

  setClosed(id, closed) {
    const t = this.#get(id);
    if (closed && t.sessionId && this.orch.ctx.has(t.sessionId)) throw bad(tr('아직 일하는 중이야. 끝나거나 멈춘 뒤에 완료해줘.'), 409);
    this.store.upsert('tasks', { id, closedAt: closed ? Date.now() : null });
    this.#changed();
    return this.#get(id);
  }

  // 맡기기: 새 세션을 만들어 카드 내용을 지시로 보낸다(실제 AI 가 일한다)
  start(id) {
    const t = this.#get(id);
    if (t.sessionId && this.orch.ctx.has(t.sessionId)) throw bad(tr('이 카드는 이미 일하는 중이야.'), 409);
    if (t.teamId && !this.store.get('teams', t.teamId)) throw bad(tr('카드에 고른 팀이 없어졌어.'));
    if (t.agentId && !this.store.get('agents', t.agentId)) throw bad(tr('카드에 고른 에이전트가 없어졌어.'));
    if (t.cwd && !fs.existsSync(t.cwd)) throw bad(tr('그 폴더가 없어.'));
    const sess = this.store.createSession({ title: `📋 ${t.title}`.slice(0, 120), teamId: t.teamId, agentId: t.agentId, cwd: t.cwd });
    sess.taskId = t.id;
    this.store.saveSessionNow(sess);
    this.bus.emit('session', this.store.sessionMeta(sess));
    this.store.upsert('tasks', { id, sessionId: sess.id, closedAt: null });
    this.orch.send(sess.id, { text: t.detail.trim() ? `${t.title}\n\n${t.detail}` : t.title });
    this.#changed();
    return { sessionId: sess.id };
  }
}
