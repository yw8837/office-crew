// 프로바이더 목록과 탐지 결과 캐시
import claude from './claude.js';
import codex from './codex.js';
import gemini from './gemini.js';
import hermes from './hermes.js';
import openai from './openai.js';
import local from './local.js';
import acp from './acp.js';
import mock from './mock.js';
import { tr } from '../i18n.js';

export const PROVIDERS = { claude, codex, gemini, hermes, openai, local, acp, mock };

export function providerInfo(p, detected) {
  return {
    id: p.id, label: p.label, sub: p.sub, kind: p.kind, color: p.color,
    efforts: p.efforts, caps: p.caps, login: p.login && { ...p.login, hint: tr(p.login.hint) }, ...(detected || {}),
  };
}

const MODEL_TTL = 10 * 60 * 1000;

export class ProviderRegistry {
  constructor(store) {
    this.store = store;
    this.detected = {};
    this.at = 0;
    this.pending = null;
    this.modelCache = {}; // id → { at, version, list }
    this.timer = null;
  }

  list() { return Object.values(PROVIDERS).map((p) => providerInfo(p, this.detected[p.id] || { checking: true })); }

  get(id) { return PROVIDERS[id] || null; }

  async refresh(only) {
    if (this.pending && !only) return this.pending;
    const ids = only ? [only] : Object.keys(PROVIDERS);
    const job = Promise.all(ids.map(async (id) => {
      const before = this.detected[id]?.version;
      try { this.detected[id] = await PROVIDERS[id].detect(this.store.settings); }
      catch (e) { this.detected[id] = { installed: false, note: tr('탐지 실패: {msg}', { msg: e.message }) }; }
      // CLI 가 업데이트되면(버전 변경) 모델 목록을 바로 다시 읽게 캐시를 비운다
      const after = this.detected[id]?.version;
      if (before && after && before !== after) { this.detected[id].updatedFrom = before; delete this.modelCache[id]; }
    })).then(() => { this.at = Date.now(); return this.list(); });
    if (!only) this.pending = job.finally(() => { this.pending = null; });
    return job;
  }

  async models(id, { force = false, query = {} } = {}) {
    const p = PROVIDERS[id];
    if (!p) return [];
    const c = this.modelCache[id];
    const version = this.detected[id]?.version || '';
    if (!force && !query.profile && c && Date.now() - c.at < MODEL_TTL && c.version === version) return c.list;
    let list = [];
    try { list = await p.models(this.store.settings, query); } catch { list = c?.list || []; }
    if (!query.profile) this.modelCache[id] = { at: Date.now(), version, list };
    return list;
  }

  // 자동 라우팅에 쓰는 전체 카탈로그(로그인된 프로바이더만)
  async catalog({ force = false } = {}) {
    const providers = this.list().filter((p) => p.id !== 'mock');
    const ready = providers.filter((p) => p.loggedIn);
    const models = {};
    await Promise.all(ready.map(async (p) => { models[p.id] = await this.models(p.id, { force }); }));
    return { providers, models };
  }

  // 30분마다 설치·로그인·버전을 다시 확인(업데이트 자동 반영)
  startAutoRefresh(onChange, ms = 30 * 60 * 1000) {
    clearInterval(this.timer);
    this.timer = setInterval(() => { this.refresh().then(onChange).catch(() => {}); }, ms);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }
}
