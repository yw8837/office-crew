// 스킬·커넥터(MCP)·플러그인(묶음) 관리. 각 CLI에 이미 설치된 스킬·커넥터도 찾아서 보여준다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from './store.js';
import { runQuick } from './providers/util.js';
import { tr } from './i18n.js';
import { cleanAvatar, cleanSkin } from './media.js';

const home = os.homedir();
// 각 CLI 의 설정 폴더(CLAUDE_CONFIG_DIR·CODEX_HOME 을 바꿨으면 그쪽). 한도·대화 기록과 같은 곳을 본다
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const codexDir = () => process.env.CODEX_HOME || path.join(home, '.codex');
const externalSkillDirs = () => [
  ['claude', path.join(claudeDir(), 'skills')],
  ['codex', path.join(codexDir(), 'skills')],
  ['agents', path.join(home, '.agents', 'skills')],
  ['gemini', path.join(home, '.gemini', 'skills')],
];

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return { meta, body: m ? text.slice(m[0].length) : text };
}

export const safeKey = (s) => String(s || 'mcp').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mcp';

export class Catalog {
  constructor(store, dirs) {
    this.store = store;
    this.dirs = dirs;
    this.extSkills = null;
  }

  // ── 스킬 ──
  scanExternalSkills() {
    const out = [];
    for (const [source, dir] of externalSkillDirs()) {
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
      for (const n of names) {
        const file = path.join(dir, n, 'SKILL.md');
        try {
          const fd = fs.openSync(file, 'r');
          const buf = Buffer.alloc(4096);
          const len = fs.readSync(fd, buf, 0, 4096, 0);
          fs.closeSync(fd);
          const { meta } = parseFrontmatter(buf.toString('utf8', 0, len));
          out.push({ id: `ext:${source}:${n}`, name: meta.name || n, description: (meta.description || '').slice(0, 300), source, path: file, readOnly: true });
        } catch { /* SKILL.md 없음 */ }
      }
    }
    this.extSkills = out;
    return out;
  }

  skills() {
    const app = this.store.all('skills').map((s) => ({ ...s, source: s.pluginId ? 'plugin' : 'app', readOnly: false }));
    return [...app, ...(this.extSkills || this.scanExternalSkills())];
  }

  skillContent(id) {
    if (id.startsWith('ext:')) {
      const s = (this.extSkills || this.scanExternalSkills()).find((x) => x.id === id);
      if (!s) return null;
      try { return { ...s, content: parseFrontmatter(fs.readFileSync(s.path, 'utf8')).body }; } catch { return null; }
    }
    const s = this.store.get('skills', id);
    if (!s) return null;
    let content = '';
    try { content = fs.readFileSync(path.join(this.dirs.skills, id, 'SKILL.md'), 'utf8'); } catch { /* 비었음 */ }
    return { ...s, content: parseFrontmatter(content).body };
  }

  saveSkill({ id, name, description, content, pluginId }) {
    // id 는 폴더 이름이 되므로 서버가 만든 형식만 허용(경로 조작 방지)
    if (id !== undefined && !/^[\w-]{1,60}$/.test(String(id))) throw new Error(tr('잘못된 스킬 id'));
    if (id && !this.store.get('skills', id)) throw new Error(tr('없는 스킬'));
    const s = this.store.upsert('skills', { id, name: String(name || tr('새 스킬')).slice(0, 60), description: String(description || '').slice(0, 500), ...(pluginId ? { pluginId } : {}) }, 'skill');
    const dir = path.join(this.dirs.skills, s.id);
    fs.mkdirSync(dir, { recursive: true });
    const fm = `---\nname: ${s.name.replace(/\n/g, ' ')}\ndescription: ${s.description.replace(/\n/g, ' ')}\n---\n\n`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), fm + (content || ''));
    return s;
  }

  deleteSkill(id) {
    fs.rmSync(path.join(this.dirs.skills, id), { recursive: true, force: true });
    return this.store.remove('skills', id);
  }

  findSkillByName(name) {
    const n = name.toLowerCase();
    return this.skills().find((s) => s.name.toLowerCase() === n || s.id.toLowerCase().endsWith(`:${n}`));
  }

  // ── 커넥터(MCP) ──
  saveConnector(c) {
    const clean = {
      id: c.id, name: c.name || tr('MCP 서버'), key: safeKey(c.key || c.name), type: c.type === 'http' ? 'http' : 'stdio',
      command: c.command || '', args: Array.isArray(c.args) ? c.args.map(String) : String(c.args || '').split(/\s+/).filter(Boolean),
      env: c.env && typeof c.env === 'object' ? c.env : {}, url: c.url || '', headers: c.headers && typeof c.headers === 'object' ? c.headers : {},
      enabled: c.enabled !== false, ...(c.pluginId ? { pluginId: c.pluginId } : {}),
    };
    return this.store.upsert('connectors', clean, 'mcp');
  }

  connectorsFor(agent) {
    return (agent.connectors || []).map((id) => this.store.get('connectors', id)).filter((c) => c && c.enabled !== false);
  }

  // Claude용 --mcp-config 파일
  writeClaudeMcpConfig(list) {
    if (!list.length) return null;
    const mcpServers = {};
    for (const c of list) {
      mcpServers[c.key] = c.type === 'http'
        ? { type: 'http', url: c.url, ...(Object.keys(c.headers || {}).length ? { headers: c.headers } : {}) }
        : { type: 'stdio', command: c.command, args: c.args || [], ...(Object.keys(c.env || {}).length ? { env: c.env } : {}) };
    }
    const f = path.join(this.dirs.tmp, `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
    fs.writeFileSync(f, JSON.stringify({ mcpServers }, null, 2));
    return f;
  }

  // 각 CLI에 이미 등록된 커넥터(읽기 전용 표시)
  existingConnectors() {
    const out = [];
    try {
      const cj = JSON.parse(fs.readFileSync(process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'), 'utf8'));
      for (const [k, v] of Object.entries(cj.mcpServers || {})) out.push({ source: 'claude', name: k, type: v.type || (v.url ? 'http' : 'stdio'), target: v.url || [v.command, ...(v.args || [])].join(' ') });
    } catch { /* 없음 */ }
    try {
      const toml = fs.readFileSync(path.join(codexDir(), 'config.toml'), 'utf8');
      const re = /^\[mcp_servers\.([^\]]+)\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/gm;
      let m;
      while ((m = re.exec(toml))) {
        if (m[1].includes('.')) continue;
        const body = m[2];
        const cmd = body.match(/^command\s*=\s*"([^"]*)"/m)?.[1];
        const url = body.match(/^url\s*=\s*"([^"]*)"/m)?.[1];
        out.push({ source: 'codex', name: m[1].replace(/"/g, ''), type: url ? 'http' : 'stdio', target: url || cmd || '' });
      }
    } catch { /* 없음 */ }
    return out;
  }

  // ── 플러그인(에이전트·팀·스킬·커넥터·스킨 묶음) ──
  exportPlugin({ name, description, agentIds = [], teamIds = [], skillIds = [], connectorIds = [], skinIds = [] }) {
    const teams = teamIds.map((id) => this.store.get('teams', id)).filter(Boolean);
    const allAgentIds = new Set([...agentIds, ...teams.flatMap((t) => t.stages.flatMap((s) => s.agentIds))]);
    const agents = [...allAgentIds].map((id) => this.store.get('agents', id)).filter(Boolean);
    // 에이전트가 쓰는 앱 스킬은 자동으로 같이 넣는다(가져온 쪽에서 연결이 끊기지 않게)
    const allSkillIds = new Set([...skillIds, ...agents.flatMap((a) => (a.skills || []).filter((id) => !String(id).startsWith('ext:')))]);
    const strip = ({ createdAt, updatedAt, pluginId, ...rest }) => rest;
    return {
      format: 'office-crew-plugin', version: 1, name: name || tr('내 플러그인'), description: description || '', exportedAt: new Date().toISOString(),
      agents: agents.map(strip),
      teams: teams.map(strip),
      skills: [...allSkillIds].map((id) => this.skillContent(id)).filter(Boolean).map((s) => ({ id: s.id, name: s.name, description: s.description, content: s.content })),
      // 환경변수·헤더 값에는 키가 들어갈 수 있어서 이름만 남기고 값은 비운다
      connectors: connectorIds.map((id) => this.store.get('connectors', id)).filter(Boolean).map(strip)
        .map((c) => ({ ...c, env: Object.fromEntries(Object.keys(c.env || {}).map((k) => [k, ''])), headers: Object.fromEntries(Object.keys(c.headers || {}).map((k) => [k, ''])) })),
      skins: skinIds.map((id) => this.store.get('skins', id)).filter(Boolean).map(strip),
    };
  }

  importPlugin(bundle) {
    if (!bundle || bundle.format !== 'office-crew-plugin') throw new Error(tr('오피스 크루 플러그인 형식(.json)이 아니야.'));
    const pluginId = newId('plug');
    const items = { agents: [], teams: [], skills: [], connectors: [], skins: [] };
    const idMap = new Map();
    const conMap = new Map();
    for (const c of bundle.connectors || []) {
      const saved = this.saveConnector({ ...c, id: undefined, pluginId });
      conMap.set(c.id, saved.id);
      items.connectors.push(saved.id);
    }
    const skillMap = new Map(); // 내보낸 쪽 스킬 id → 새 id
    for (const s of bundle.skills || []) {
      const saved = this.saveSkill({ name: s.name, description: s.description, content: s.content, pluginId });
      if (s.id) skillMap.set(s.id, saved.id);
      items.skills.push(saved.id);
    }
    for (const a of bundle.agents || []) {
      const saved = this.store.upsert('agents', {
        ...a, id: undefined, pluginId, avatar: cleanAvatar(a.avatar),
        connectors: (a.connectors || []).map((id) => conMap.get(id)).filter(Boolean),
        // 외부(CLI) 스킬은 그대로, 앱 스킬은 새로 만든 스킬 id 로 바꿔 연결
        skills: (a.skills || []).map((id) => (String(id).startsWith('ext:') ? id : skillMap.get(id))).filter(Boolean),
      }, 'agent');
      idMap.set(a.id, saved.id);
      items.agents.push(saved.id);
    }
    for (const t of bundle.teams || []) {
      const saved = this.store.upsert('teams', {
        ...t, id: undefined, pluginId,
        stages: (t.stages || []).map((s) => ({ ...s, id: newId('st'), agentIds: (s.agentIds || []).map((id) => idMap.get(id)).filter(Boolean) })),
      }, 'team');
      items.teams.push(saved.id);
    }
    for (const s of bundle.skins || []) items.skins.push(this.store.upsert('skins', cleanSkin({ ...s, id: undefined, pluginId }), 'skin').id);
    return this.store.upsert('plugins', { id: pluginId, name: bundle.name || tr('플러그인'), description: bundle.description || '', version: bundle.version || 1, items, installedAt: Date.now() });
  }

  removePlugin(id) {
    const p = this.store.get('plugins', id);
    if (!p) return false;
    for (const sid of p.items?.skills || []) this.deleteSkill(sid);
    for (const col of ['agents', 'teams', 'connectors', 'skins']) for (const x of p.items?.[col] || []) this.store.remove(col, x);
    return this.store.remove('plugins', id);
  }

  // 각 CLI에 설치된 플러그인 목록(텍스트)
  async nativePlugins() {
    const jobs = [
      ['claude', ['plugin', 'list']],
      ['codex', ['plugin', 'list']],
    ];
    const out = [];
    for (const [cli, args] of jobs) {
      const r = await runQuick(cli, args, 20000);
      out.push({ cli, ok: r.ok, text: (r.out || r.err || '').trim().slice(0, 6000) });
    }
    return out;
  }
}
