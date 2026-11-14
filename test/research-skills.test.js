// 조사 역할 에이전트에 조사 스킬(agent-reach, insane-search)을 기본으로 켠다(가짜 스킬 폴더, 실제 AI 사용량 0)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rskills-'));
const ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
const saved = {};
const skill = (dir, name) => {
  const d = path.join(dir, 'skills', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 설명\n---\n\n# ${name}\n본문`);
};

let t;
before(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  process.env.CODEX_HOME = path.join(root, 'codex');
  skill(process.env.CLAUDE_CONFIG_DIR, 'agent-reach');
  skill(process.env.CLAUDE_CONFIG_DIR, 'insane-search');
  skill(process.env.CLAUDE_CONFIG_DIR, 'other-skill');
  skill(process.env.CODEX_HOME, 'agent-reach'); // Codex 쪽에는 하나만 있다
  t = await startTestApp();
  await t.api('GET', '/api/skills?rescan=1');
});
after(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  try { await t.close(); } catch { /* 윈도우 파일 잠금 무시 */ }
  fs.rmSync(root, { recursive: true, force: true });
});

const defaults = async (role, provider) => (await t.api('GET', `/api/skill-defaults?role=${encodeURIComponent(role)}&provider=${provider}`)).json;
const make = async (extra) => (await t.api('POST', '/api/agents', { name: `에이전트${Math.random().toString(36).slice(2, 7)}`, provider: 'claude', model: 'claude-sonnet-5-5', permission: 'plan', routing: 'manual', ...extra })).json;

test('조사 역할이면 설치된 조사 스킬을 돌려준다: 그 에이전트의 CLI 쪽 것을 먼저', async () => {
  assert.deepEqual(await defaults('조사', 'claude'), { kind: 'research', skills: ['ext:claude:agent-reach', 'ext:claude:insane-search'] });
  // Codex 에는 agent-reach 만 있으니 그건 Codex 것, 없는 건 다른 곳(Claude) 것
  // (공용 폴더 ~/.agents 는 이 PC의 진짜 폴더라, 거기에 같은 이름이 있으면 그쪽 것이 먼저다)
  const codex = (await defaults('research', 'codex-ab12')).skills; // 추가 계정도 Codex 로 본다
  assert.equal(codex[0], 'ext:codex:agent-reach');
  assert.match(codex[1], /^ext:(agents|claude):insane-search$/);
  for (const role of ['리서치 담당', '검색', '调研', '調査']) assert.equal((await defaults(role, 'claude')).skills.length, 2, role);
});

test('조사 역할이 아니면 아무것도 켜지 않는다', async () => {
  for (const role of ['정리', '검수', '빌드', '분석', '', '글쓰기']) assert.deepEqual(await defaults(role, 'claude'), { kind: '', skills: [] }, role);
});

test('에이전트 만들기: 스킬을 안 보냈을 때만 조사 역할에 기본으로 넣는다', async () => {
  assert.deepEqual((await make({ role: '조사' })).skills, ['ext:claude:agent-reach', 'ext:claude:insane-search'], '안 보내면 기본으로');
  assert.deepEqual((await make({ role: '조사', skills: [] })).skills, [], '빈 목록을 보냈으면(화면에서 다 껐으면) 그대로');
  assert.deepEqual((await make({ role: '조사', skills: ['ext:claude:other-skill'] })).skills, ['ext:claude:other-skill'], '고른 게 있으면 그대로');
  assert.deepEqual((await make({ role: '정리' })).skills, [], '다른 역할은 그대로');
  // 이미 있는 에이전트를 고칠 때는 넣지 않는다
  const a = await make({ role: '정리' });
  const put = await t.api('PUT', `/api/agents/${a.id}`, { ...a, role: '조사' });
  assert.deepEqual(put.json.skills, [], '역할을 조사로 바꿔도 기존 에이전트는 건드리지 않는다');
});

test('그 이름의 스킬이 설치돼 있지 않으면 아무것도 켜지 않는다', async () => {
  fs.rmSync(path.join(root, 'claude', 'skills', 'insane-search'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'claude', 'skills', 'agent-reach'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'codex', 'skills', 'agent-reach'), { recursive: true, force: true });
  await t.api('GET', '/api/skills?rescan=1');
  // 공용 스킬 폴더(~/.agents)와 Gemini 폴더는 이 PC의 진짜 폴더라 테스트가 못 바꾼다. 거기 것이 남을 수는 있어도, 지운 Claude·Codex 쪽 것은 나오면 안 된다
  const mine = (ids) => ids.filter((id) => /^ext:(claude|codex):/.test(id));
  assert.deepEqual(mine((await defaults('조사', 'claude')).skills), []);
  assert.deepEqual(mine((await make({ role: '조사' })).skills), []);
});
