// 휴대폰 알림: 승인·결정 대기와 작업 끝·실패를 사용자가 정한 주소로 보낸다(기본 꺼짐).
// 밖으로 나가는 알림이라 상태와 팀·에이전트 이름만 보낸다. 세션 제목은 첫 메시지로 자동으로 지어져 대화 내용이 들어 있을 수 있어 보내지 않는다
import { tr } from './i18n.js';

const TIMEOUT_MS = 10000;
const NAME_MAX = 80;

export function checkPhoneUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return '';
  let u;
  try { u = new URL(url); } catch { throw Object.assign(new Error(tr('알림 주소 형식이 맞지 않아.')), { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error(tr('알림 주소는 http 또는 https 만 돼.')), { status: 400 });
  return url;
}

// 보낼 요청 만들기. ntfy 는 한글 제목이 헤더에서 깨지니 JSON 으로 보낸다.
// 웹훅은 흔한 서비스(Slack 의 text, Discord 의 content)가 바로 읽게 같은 글을 함께 넣는다
export function buildRequest(type, url, { title, message, status = '' }) {
  if (type === 'ntfy') {
    // 주제는 주소의 맨 끝. 직접 올린 서버의 하위 경로와 ?auth= 같은 값은 그대로 둔다
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const topic = parts.pop();
    if (!topic) throw new Error(tr('ntfy 주소에 주제 이름이 있어야 해. 예: https://ntfy.sh/내주제'));
    return { url: `${u.origin}/${parts.map((p) => `${p}/`).join('')}${u.search}`, body: { topic, title, message } };
  }
  return { url, body: { title, message, status, text: `${title}\n${message}`, content: `${title}\n${message}` } };
}

export class PhoneNotify {
  constructor({ store, bus, fetchFn = (...a) => fetch(...a), onError = () => {} }) {
    Object.assign(this, { store, bus, fetchFn, onError });
    this.sent = new Set();
    this.lastError = '';
    bus.on((type, d) => { if (type === 'run') this.#onRun(d.sessionId, d.run); });
  }

  #onRun(sessionId, run) {
    const st = this.store.settings;
    if (!st.phoneNotify || !st.phoneUrl) return;
    const title = {
      waiting: run.hold?.reason === 'approve' ? tr('승인이 필요해') : tr('결정이 필요해'),
      done: tr('작업이 끝났어'),
      error: tr('작업이 실패했어'),
    }[run.status];
    if (!title) return;
    const key = `${run.id}:${run.status}:${run.hold?.at ?? ''}`;
    if (this.sent.has(key)) return;
    this.sent.add(key);
    if (this.sent.size > 500) this.sent.clear();
    const s = this.store.getSession(sessionId);
    const who = (s?.teamId && this.store.get('teams', s.teamId)?.name) || (s?.agentId && this.store.get('agents', s.agentId)?.name) || tr('오피스 크루');
    this.send({ title, message: String(who).slice(0, NAME_MAX), status: run.status }).catch(() => {});
  }

  // 실패해도 작업에는 영향을 주지 않는다. 주소에 비밀이 들 수 있어 오류 글에 주소를 넣지 않는다
  async send(msg) {
    const st = this.store.settings;
    const fail = (text) => { const changed = this.lastError !== text; this.lastError = text; if (changed) this.onError(); throw new Error(text); };
    let req;
    try { req = buildRequest(st.phoneType === 'webhook' ? 'webhook' : 'ntfy', st.phoneUrl, msg); } catch (e) { fail(e.message); }
    let r;
    try {
      r = await this.fetchFn(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch { fail(tr('알림을 보내지 못했어. 주소와 인터넷 연결을 확인해줘.')); }
    if (!r.ok) fail(tr('알림 서비스가 {code} 오류로 답했어.', { code: r.status }));
    if (this.lastError) { this.lastError = ''; this.onError(); }
  }
}
