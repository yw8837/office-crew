// Nous Research Hermes Agent 어댑터: hermes -z(한 번 실행) + --usage-file 로 사용량 집계
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnCli, killTree, makeHandle, runQuick, stripAnsi } from './util.js';
import { tr } from '../i18n.js';

let statusCache = { at: 0, model: '', provider: '' };

function pickNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return 0;
  for (const k of keys) if (typeof obj[k] === 'number') return obj[k];
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const n = pickNum(v, keys); if (n) return n; }
  }
  return 0;
}

export default {
  id: 'hermes', label: 'Hermes', get sub() { return tr('Hermes Agent CLI · Nous Portal/OAuth 로그인'); }, kind: 'cli', color: '#7c3aed',
  efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  caps: { images: true, steer: false, resume: false, tools: true, connectors: false, permissions: false },
  login: { command: 'hermes model', get hint() { return tr('열린 터미널에서 프로바이더를 고르고 로그인(재인증)해줘.'); } },

  async detect() {
    const v = await runQuick('hermes', ['--version']);
    if (v.code === -1) return { installed: false, note: tr('Hermes Agent 미설치') };
    const s = await runQuick('hermes', ['status'], 40000);
    const out = s.out;
    const model = out.match(/Model:\s*(.+)/)?.[1]?.trim() || '';
    const provider = out.match(/Provider:\s*(.+)/)?.[1]?.trim() || '';
    statusCache = { at: Date.now(), model, provider };
    const logged = [...out.matchAll(/^\s{2}(.+?)\s+✓ logged in/gm)].map((m) => m[1].trim());
    const expired = /Invalid refresh token|No access token/i.test(out);
    return {
      installed: true, version: v.out.split('\n')[0].replace('Hermes Agent', '').trim(),
      loggedIn: logged.length > 0, account: [provider, model].filter(Boolean).join(' · '),
      note: logged.length ? (expired ? tr('토큰 갱신이 필요할 수 있어(로그인 버튼 → hermes model)') : '') : tr('로그인 필요'),
    };
  },

  async models() {
    const list = [];
    if (statusCache.model) list.push({ id: statusCache.model, label: `${statusCache.model} (${tr('현재 설정')})`, tier: 'balanced' });
    list.push({ id: '', label: tr('기본 모델(Hermes 설정)'), tier: 'balanced' });
    return list;
  },

  run(opts, emit) {
    const { agent, prompt, system, images = [], cwd, tmpDir } = opts;
    let full = system ? `<${tr('역할 지침')}>\n${system}\n</${tr('역할 지침')}>\n\n${prompt}` : prompt;
    if (images.length) full += `\n\n${tr('[첨부 이미지]')}\n${images.map((p) => `- ${p}`).join('\n')}`;
    const tag = crypto.randomUUID();
    let promptFile = null;
    if (full.length > 20000) {
      // 명령줄 길이 제한(약 32K) 회피: 파일로 넘긴다
      promptFile = path.join(tmpDir, `hermes-prompt-${tag}.md`);
      fs.writeFileSync(promptFile, full);
      full = tr('다음 파일의 내용을 끝까지 읽고 그 지시대로 수행해: {file}', { file: promptFile });
    }
    const usageFile = path.join(tmpDir, `hermes-usage-${tag}.json`);
    const args = ['-z', full, '--usage-file', usageFile];
    if (agent.model) args.push('-m', agent.model);
    if (agent.effort) args.push('--reasoning', agent.effort);

    const h = makeHandle();
    emit({ type: 'notice', text: tr('Hermes는 완료 시 결과를 한 번에 보내(중간 출력 없음).'), quiet: true });
    const child = spawnCli('hermes', args, { cwd, stdin: 'ignore' });
    let out = '', stderr = '', stopped = false, errorMsg = null;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { errorMsg = e.message; });
    child.on('close', (code) => {
      const text = stripAnsi(out).trim();
      if (text) emit({ type: 'text', text });
      try {
        const u = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
        emit({
          type: 'usage',
          input: pickNum(u, ['input_tokens', 'prompt_tokens']), output: pickNum(u, ['output_tokens', 'completion_tokens']),
          cacheRead: pickNum(u, ['cache_read_tokens', 'cached_tokens']), cacheWrite: 0, cost: pickNum(u, ['estimated_cost_usd', 'estimated_cost', 'cost_usd', 'cost']),
        });
      } catch { /* 사용량 파일 없음 */ }
      fs.rmSync(usageFile, { force: true });
      if (promptFile) fs.rmSync(promptFile, { force: true });
      const errText = stripAnsi(stderr).trim().split('\n').slice(-2).join(' ');
      const err = stopped ? null : (errorMsg || (code !== 0 ? (errText || text.slice(0, 300) || tr('종료 코드 {code}', { code })) : null));
      h.resolve({ text, providerSessionId: null, error: err, stopped });
    });
    return { done: h.done, stop: () => { stopped = true; killTree(child); } };
  },
};
