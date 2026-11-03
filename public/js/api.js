// 서버 통신: 토큰 헤더, JSON, 업로드, SSE(자동 재연결)
import { t } from './i18n/index.js';

const token = document.querySelector('meta[name="office-token"]')?.content || '';

const OFFLINE = () => t('서버에 연결할 수 없어. 오피스 크루가 켜져 있는지 확인해줘.');

export async function api(method, path, body) {
  let r;
  try {
    r = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new Error(OFFLINE()); }
  if (r.status === 401) { location.reload(); throw new Error(t('토큰 만료')); }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!r.ok) throw new Error(data?.error || t('요청 실패 ({status})', { status: r.status }));
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const patch = (p, b = {}) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);

export async function upload(file) {
  let r;
  try {
    r = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'pasted.png'), 'X-Office-Token': token },
      body: file,
    });
  } catch { throw new Error(OFFLINE()); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || t('업로드 실패'));
  return data;
}

export const uploadUrl = (id) => `/api/uploads/${id}?token=${encodeURIComponent(token)}`;

export function connectEvents(onEvent, onStatus) {
  let es = null, retry = 0, closed = false;
  const types = ['hello', 'session', 'sessionDeleted', 'message', 'delta', 'block', 'messageDone', 'messageUsage', 'messageMeta',
    'agentState', 'run', 'handoff', 'usage', 'providers', 'agents', 'teams', 'skills', 'connectors', 'plugins', 'skins', 'schedules', 'settings', 'sessionsReset', 'cooldown'];
  const open = () => {
    es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.onopen = () => { retry = 0; onStatus(true); };
    es.onerror = () => {
      onStatus(false);
      es.close();
      if (!closed) setTimeout(open, Math.min(8000, 500 * 2 ** retry++));
    };
    for (const ty of types) es.addEventListener(ty, (e) => { try { onEvent(ty, JSON.parse(e.data)); } catch (err) { console.error('이벤트 처리 오류', ty, err); } });
  };
  open();
  return () => { closed = true; es?.close(); };
}
