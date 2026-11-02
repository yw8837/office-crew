// OpenAI 호환 API 어댑터: OpenAI·OpenRouter(Hermes·Grok 등)·Nous Portal·xAI·Gemini API·Ollama·LM Studio
import fs from 'node:fs';
import { makeHandle, mimeOf, guessTier } from './util.js';
import { tr } from '../i18n.js';

const isLocal = (url = '') => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url);

function profileOf(settings, agent) {
  const list = settings?.apiProfiles || [];
  return list.find((p) => p.id === agent.apiProfile) || list.find((p) => p.apiKey || isLocal(p.baseUrl)) || list[0] || null;
}

function headers(p) {
  const h = { 'Content-Type': 'application/json' };
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
  if (/openrouter\.ai/.test(p.baseUrl)) { h['HTTP-Referer'] = 'http://127.0.0.1'; h['X-Title'] = 'Office Crew'; }
  return h;
}

export default {
  id: 'openai', get label() { return tr('API 키 모델'); }, get sub() { return tr('OpenAI 호환 API (OpenAI·OpenRouter·Hermes·Grok·Gemini API·Ollama)'); }, kind: 'api', color: '#0ea5e9',
  efforts: ['low', 'medium', 'high'],
  caps: { images: true, steer: false, resume: false, tools: false, connectors: false, permissions: false, profiles: true },
  login: null,

  async detect(settings) {
    const ready = (settings?.apiProfiles || []).filter((p) => p.apiKey || isLocal(p.baseUrl));
    const keyed = ready.filter((p) => p.apiKey).map((p) => p.name);
    return { installed: true, version: '', loggedIn: keyed.length > 0, account: keyed.length ? keyed.join(', ') : '', note: keyed.length ? '' : tr('설정 → API 키에서 키를 넣으면 사용 가능(로컬 Ollama 등은 키 없이)') };
  },

  async models(settings, query = {}) {
    const p = (settings?.apiProfiles || []).find((x) => x.id === query.profile) || profileOf(settings, {});
    if (!p) return [];
    try {
      const r = await fetch(`${p.baseUrl.replace(/\/$/, '')}/models`, { headers: headers(p), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const list = (j.data || j.models || []).map((m) => ({ id: m.id || m.name, label: m.name || m.id, tier: guessTier(m.id || m.name) })).filter((m) => m.id);
      return list.slice(0, 500);
    } catch {
      return p.model ? [{ id: p.model, label: `${p.model} (${tr('프로필 기본')})`, tier: guessTier(p.model) }] : [];
    }
  },

  run(opts, emit) {
    const { agent, prompt, system, images = [], history = [], settings } = opts;
    const h = makeHandle();
    const p = profileOf(settings, agent);
    const ctrl = new AbortController();
    let stopped = false;
    if (!p) { h.resolve({ text: '', error: tr('API 프로필이 없어. 설정 → API 키에서 추가해줘.') }); return { done: h.done, stop() {} }; }
    if (!p.apiKey && !isLocal(p.baseUrl)) { h.resolve({ text: '', error: tr('{name} API 키가 비어 있어. 설정 → API 키에서 입력해줘.', { name: p.name }) }); return { done: h.done, stop() {} }; }

    const userContent = images.length
      ? [{ type: 'text', text: prompt }, ...images.map((f) => ({ type: 'image_url', image_url: { url: `data:${mimeOf(f)};base64,${fs.readFileSync(f).toString('base64')}` } }))]
      : prompt;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const m of history) messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
    messages.push({ role: 'user', content: userContent });
    const body = { model: agent.model || p.model, messages, stream: true, stream_options: { include_usage: true } };
    if (agent.effort && ['openai', 'gemini-api'].includes(p.id)) body.reasoning_effort = agent.effort;
    if (agent.effort && p.id === 'openrouter') body.reasoning = { effort: agent.effort };
    emit({ type: 'session', id: null });
    emit({ type: 'meta', model: body.model });

    (async () => {
      let text = '';
      try {
        const r = await fetch(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: headers(p), body: JSON.stringify(body), signal: ctrl.signal });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          throw new Error(tr('{name} 응답 {status}: {body}', { name: p.name, status: r.status, body: t.slice(0, 300) }));
        }
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let j;
            try { j = JSON.parse(data); } catch { continue; }
            const d = j.choices?.[0]?.delta || {};
            const think = d.reasoning_content || d.reasoning;
            if (typeof think === 'string' && think) emit({ type: 'thinking', text: think });
            if (d.content) { text += d.content; emit({ type: 'text', text: d.content }); }
            if (j.usage) {
              const u = j.usage;
              const cached = u.prompt_tokens_details?.cached_tokens || 0;
              emit({ type: 'usage', input: Math.max(0, (u.prompt_tokens || 0) - cached), output: u.completion_tokens || 0, cacheRead: cached, cacheWrite: 0, cost: typeof u.cost === 'number' ? u.cost : 0 });
            }
          }
        }
        h.resolve({ text, providerSessionId: null, error: null, stopped });
      } catch (e) {
        h.resolve({ text, providerSessionId: null, error: stopped ? null : (e.message || String(e)), stopped });
      }
    })();
    return { done: h.done, stop: () => { stopped = true; ctrl.abort(); } };
  },
};
