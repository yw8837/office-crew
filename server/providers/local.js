// 로컬 모델 어댑터: 내 PC에서 도는 Ollama·LM Studio·llama.cpp·vLLM·Jan 서버를 자동으로 찾아 설치된 모델을 쓴다
// (모두 OpenAI 호환 /v1/chat/completions 를 지원 → openai 어댑터의 실행부를 그대로 재사용)
import openai from './openai.js';
import { tr } from '../i18n.js';

export const KNOWN_SERVERS = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', tags: 'http://127.0.0.1:11434/api/tags' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'llamacpp', name: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
  { id: 'jan', name: 'Jan', baseUrl: 'http://127.0.0.1:1337/v1' },
];

let cache = { at: 0, servers: [] };

function servers(settings) {
  const custom = (settings?.localServers || []).filter((s) => s?.baseUrl).map((s, i) => ({ id: `custom${i}`, name: s.name || s.baseUrl, baseUrl: String(s.baseUrl).replace(/\/$/, '') }));
  return [...KNOWN_SERVERS, ...custom];
}

async function probe(srv) {
  try {
    if (srv.tags) {
      const r = await fetch(srv.tags, { signal: AbortSignal.timeout(1200) });
      if (r.ok) {
        const j = await r.json();
        return (j.models || []).map((m) => ({ name: m.name || m.model, size: m.size || 0 }));
      }
    }
    const r = await fetch(`${srv.baseUrl}/models`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.data || j.models || []).map((m) => ({ name: m.id || m.name, size: 0 })).filter((m) => m.name);
  } catch { return null; }
}

// 서버들을 동시에 확인(꺼져 있으면 1.2초 안에 포기)
async function scan(settings, force = false) {
  if (!force && Date.now() - cache.at < 60_000) return cache.servers;
  const list = servers(settings);
  const found = await Promise.all(list.map(async (s) => ({ ...s, models: await probe(s) })));
  cache = { at: Date.now(), servers: found.filter((s) => s.models) };
  return cache.servers;
}

// 모델 id 형식: "<서버id>::<모델이름>"
function split(model) {
  const i = String(model || '').indexOf('::');
  return i > 0 ? [model.slice(0, i), model.slice(i + 2)] : [null, model];
}

const gb = (n) => (n ? ` · ${(n / 1e9).toFixed(1)}GB` : '');

export default {
  id: 'local', get label() { return tr('로컬 모델'); }, get sub() { return tr('내 PC 모델 · Ollama·LM Studio·llama.cpp·vLLM·Jan 자동 감지'); }, kind: 'api', color: '#16a34a',
  efforts: [],
  caps: { images: true, steer: false, resume: false, tools: false, connectors: false, permissions: false },
  login: null,

  async detect(settings) {
    const found = await scan(settings, true);
    const n = found.reduce((a, s) => a + s.models.length, 0);
    return {
      installed: found.length > 0, version: '', loggedIn: n > 0,
      account: found.length ? found.map((s) => tr('{name} {n}개', { name: s.name, n: s.models.length })).join(', ') : '',
      note: found.length ? (n ? '' : tr('서버는 켜져 있는데 설치된 모델이 없어')) : tr('Ollama·LM Studio 등을 켜면 자동으로 잡혀(설정 → API 키에서 주소 추가 가능)'),
    };
  },

  async models(settings) {
    const found = await scan(settings);
    return found.flatMap((s) => s.models.map((m) => ({ id: `${s.id}::${m.name}`, label: `${m.name} (${s.name}${gb(m.size)})`, tier: 'local' })));
  },

  run(opts, emit) {
    const [sid, name] = split(opts.agent.model);
    const srv = servers(opts.settings).find((s) => s.id === sid) || cache.servers[0] || KNOWN_SERVERS[0];
    const profile = { id: `local-${srv.id}`, name: srv.name, baseUrl: srv.baseUrl, apiKey: '', model: name };
    return openai.run({
      ...opts,
      agent: { ...opts.agent, model: name, effort: '', apiProfile: profile.id },
      settings: { ...opts.settings, apiProfiles: [profile] },
    }, emit);
  },
};
