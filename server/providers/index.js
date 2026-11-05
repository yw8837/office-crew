// 프로바이더 목록과 탐지 결과 캐시
import claude, { observedModels, setObserveHook } from './claude.js';
import codex, { makeCodex } from './codex.js';
import path from 'node:path';
import gemini from './gemini.js';
import hermes from './hermes.js';
import openai from './openai.js';
import local from './local.js';
import acp from './acp.js';
import mock from './mock.js';
import { tr } from '../i18n.js';

export const PROVIDERS = { claude, codex, gemini, hermes, openai, local, acp, mock };

// 추가 계정 id 규칙(폴더 이름·프로바이더 id 에 들어가므로 영문·숫자만)
export const ACCOUNT_ID = /^[a-z0-9]{4,16}$/;
export const accountProviderId = (accId) => `codex-${accId}`;
export const codexAccountHome = (dataHome, accId) => path.join(dataHome, 'accounts', `codex-${accId}`);

// 설정의 codexAccounts 와 PROVIDERS 를 맞춘다(없어진 계정은 뺀다). 기본 프로바이더 뒤, 다른 AI 앞에 오게 순서를 다시 짠다
export function syncCodexAccounts(accounts = [], dataHome) {
  const want = new Map();
  for (const a of accounts) if (ACCOUNT_ID.test(a?.id || '')) want.set(accountProviderId(a.id), a);
  const rest = Object.entries(PROVIDERS).filter(([id]) => !id.startsWith('codex-'));
  for (const k of Object.keys(PROVIDERS)) delete PROVIDERS[k];
  for (const [id, p] of rest) {
    PROVIDERS[id] = p;
    if (id === 'codex') for (const [pid, a] of want) PROVIDERS[pid] = makeCodex({ id: pid, name: String(a.name || a.id).slice(0, 30), home: codexAccountHome(dataHome, a.id) });
  }
  return [...want.keys()];
}

export function providerInfo(p, detected) {
  return {
    id: p.id, label: p.label, sub: p.sub, kind: p.kind, color: p.color, base: p.base || p.id, accountName: p.account || '',
    efforts: p.efforts, caps: p.caps, login: p.login && { ...p.login, hint: tr(p.login.hint) }, ...(detected || {}),
    // 추가 계정 이름(탐지 결과의 account = 로그인 표시와 섞이지 않게 따로)
    ...(p.account ? { accountName: p.account } : {}),
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
    syncCodexAccounts(store.settings?.codexAccounts || [], store.dirs?.home || '');
    // Claude 별칭이 실제로 연결된 모델(예: opus → claude-opus-5-5)을 재시작해도 기억한다
    Object.assign(observedModels, store.settings?.claudeSeen || {});
    setObserveHook((alias, model) => {
      if (!/^[a-z]+$/.test(alias) || !/^[\w.[\]-]{1,80}$/.test(model)) return;
      store.settings.claudeSeen = { ...(store.settings.claudeSeen || {}), [alias]: model };
      try { store.saveSettings(); } catch { /* 저장 실패해도 이번 실행엔 반영됨 */ }
      delete this.modelCache.claude;
    });
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
