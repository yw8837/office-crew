// 칸반 보드: 할 일 카드를 팀(또는 에이전트 한 명)에게 맡기면 세션 상태에 따라 칸이 저절로 옮겨 간다.
// 칸: 할 일(아직 안 맡김) → 진행 중(일하는 중) → 확인 필요(승인·오류·끝난 결과) → 완료(사람이 완료를 눌렀을 때만)
import fs from 'node:fs';
import path from 'node:path';
import { unsafeWorkdir } from './config.js';
import { newId } from './store.js';
import { tr } from './i18n.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

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

  // 세션 파일을 읽지 않고 정한다(카드가 쌓여도 실행 이벤트마다 파일을 다시 읽지 않게)
  columnOf(t) {
    if (t.closedAt) return 'done';
    if (!t.sessionId || !this.store.hasSession(t.sessionId)) return 'todo';
    const ctx = this.orch.ctx.get(t.sessionId);
    if (!ctx) return 'check'; // 실행이 끝났다(끝남·오류·중지, 재시작으로 끊김 포함)
    return ['waiting', 'paused'].includes(ctx.run?.status) ? 'check' : 'doing';
  }

  list() {
    return this.store.all('tasks').map((t) => ({
      ...t, column: this.columnOf(t), sessionId: t.sessionId && this.store.hasSession(t.sessionId) ? t.sessionId : null,
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
    // 일하는 중에 대상·폴더를 바꾸면 카드와 실제로 도는 세션이 달라진다
    if (prev?.sessionId && this.orch.ctx.has(prev.sessionId) && (t.teamId !== prev.teamId || t.agentId !== prev.agentId || t.cwd !== prev.cwd)) {
      throw bad(tr('일하는 중에는 맡길 대상과 폴더를 못 바꿔. 끝난 뒤에 바꿔줘.'), 409);
    }
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
    try {
      this.orch.send(sess.id, { text: t.detail.trim() ? `${t.title}\n\n${t.detail}` : t.title });
    } catch (e) {
      // 시작하지 못했으면 빈 세션을 남기지 않는다
      this.store.deleteSession(sess.id);
      this.bus.emit('sessionDeleted', { id: sess.id });
      throw e;
    }
    this.store.upsert('tasks', { id, sessionId: sess.id, closedAt: null });
    this.#changed();
    return { sessionId: sess.id };
  }
}
