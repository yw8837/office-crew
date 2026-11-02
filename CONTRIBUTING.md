# Contributing to Office Crew

Thanks for helping out. Bug reports, provider adapters, office skins, translations and docs fixes are all welcome.

> 한국어 안내는 [아래](#한국어-안내)에 있습니다.

## Ways to contribute

- **Report a bug** or **suggest a feature** with the [issue templates](https://github.com/yw8837/office-crew/issues/new/choose).
- **Add a provider adapter** for another CLI or API (see [below](#adding-a-provider-adapter)).
- **Improve the office:** skins, animations, low-end performance.
- **Translate:** the README, the UI strings (`public/js/i18n/en.js`, `zh.js`, `ja.js`, keyed by the Korean source text) and the office labels (`public/js/office/i18n.js`) support Korean, English, Simplified Chinese and Japanese.

For anything larger than a small fix, please open an issue first so we can agree on the approach before you spend time on it.

## Development setup

Requirements: **Node.js 20 or newer** and Git. You don't need any AI CLI. The built-in demo provider and the test suite run without one.

```bash
git clone https://github.com/yw8837/office-crew.git
cd office-crew
npm start -- --home ./.office-crew
```

- `--home ./.office-crew` keeps development data out of your real `~/.office-crew` (the folder is already in `.gitignore`).
- `npm run serve` starts the server without opening a window.
- There is no build step. Edit a file under `public/` and reload the window. After changing anything under `server/`, restart the server.

### Project layout

```
bin/office-crew.js        launcher (server + app window)
server/                   Node.js built-ins only
  index.js                HTTP, REST, SSE, security (127.0.0.1, Host/Origin checks, token)
  orchestrator.js         run engine: stages, parallel agents, gates, steer/queue/pause/stop/skip
  routing.js              auto-routing (role × profile → provider, model, effort)
  providers/*.js          one adapter per provider
public/                   UI without a build step (Preact + htm via import map)
  js/office/              isometric office renderer (SVG, skins, i18n)
test/                     node:test suites + fake CLIs in test/fake-cli/
docs/DESIGN.md            design notes and the adapter contract (Korean)
```

## Running tests

```bash
npm test
```

The tests start the real server against a temporary data folder and put **fake CLIs** (`test/fake-cli/`) at the front of `PATH`. The fakes reproduce real CLI output formats, so the actual adapters, orchestrator and HTTP API are exercised end to end **without using any AI quota**. CI runs the same command on Windows, Linux and macOS with Node.js 20 and 22.

Please add or update a test for any behavior change. A bug fix should come with a test that fails without the fix.

## Coding style

- **No runtime dependencies.** The server uses Node.js built-ins only (`node:http`, `node:child_process`, `node:fs`, …). The UI uses only the vendored Preact and htm in `public/vendor/`. Please don't add packages to `package.json`. If you think one is unavoidable, open an issue first.
- **ES modules everywhere** (`"type": "module"`). Use `import`/`export`, and use the `node:` prefix for built-ins.
- **No build step.** Browser code must run as-is through the import map in `public/index.html`.
- **Comments in Korean or English** are both fine. Match the surrounding file.
- **Never render agent output as raw HTML.** Go through the existing markdown renderer (`public/js/markdown.js`), which escapes first.
- **Spawn CLIs without a shell.** Use `spawnCli`/`runQuick` from `server/providers/util.js`. They resolve `.cmd` wrappers on Windows and avoid shell injection.
- Keep changes focused. Unrelated refactors belong in separate PRs.

## Adding a provider adapter

Each provider is one file in `server/providers/` that default-exports an object with this shape (see also [docs/DESIGN.md](docs/DESIGN.md)):

```js
// server/providers/example.js
import { spawnCli, onLines, parseJsonLine, killTree, makeHandle, runQuick } from './util.js';

export default {
  id: 'example',                 // stored in agent.provider
  label: 'Example',              // shown in the UI
  sub: 'Example CLI · subscription sign-in',
  kind: 'cli',                   // 'cli' | 'api' | 'mock'
  color: '#888888',
  efforts: ['low', 'medium', 'high'],   // supported effort levels, [] if none
  caps: { images: false, steer: false, resume: true, tools: true, connectors: false, permissions: true },
  login: { command: 'example login', hint: 'Sign in in the terminal that opens.' }, // or null

  // Is it installed and signed in? Must not throw. Keep it fast.
  async detect(settings) {
    const v = await runQuick('example', ['--version']);
    if (v.code === -1) return { installed: false, note: 'Example CLI is not installed' };
    return { installed: true, version: v.out.trim(), loggedIn: true, account: '', note: '' };
  },

  // Model list for dropdowns and auto-routing. tier: 'fast' | 'balanced' | 'top' | 'local'
  async models(settings) {
    return [{ id: 'example-large', label: 'Example Large', tier: 'top', efforts: ['low', 'high'] }];
  },

  // opts: { agent, prompt, system, images, cwd, resumeId, settings, connectors, tmpDir, addDirs, mcpConfigPath, history, forkSession }
  run(opts, emit) {
    const h = makeHandle();
    // spawn the CLI, parse its stream and call emit(...) as events arrive, then:
    // h.resolve({ text, providerSessionId, error: null, stopped: false });
    return { done: h.done, stop() { /* killTree(child) */ } /* , steer(text) { … } if caps.steer */ };
  },
};
```

Events to `emit`:

| Event | Meaning |
|---|---|
| `{ type: 'text', text }` | A chunk of answer text (a delta, not the full text) |
| `{ type: 'thinking', text }` | Reasoning text, if the CLI exposes it |
| `{ type: 'tool', id, name, input, status, output? }` | Tool call. `status` is `running`, `done` or `error`. Tool names drive the office animation (search → Research room, read → Library, shell → Server Room) |
| `{ type: 'usage', input, output, cacheRead, cacheWrite, cost }` | Token usage for the turn |
| `{ type: 'limits', provider, windows }` | Account limit percentages and reset times |
| `{ type: 'session', id }` | The CLI's session ID, saved so the next turn can resume |
| `{ type: 'meta', model }` | The actual model that answered |
| `{ type: 'notice', text }` | A notice to show in the chat |

Checklist for a new provider:

1. Add `server/providers/<id>.js` and register it in `PROVIDERS` in `server/providers/index.js`.
2. Add a short chip label to `PROVIDER_SHORT` in `public/js/ui.js`.
3. If it should take part in auto-routing, add it to the role candidates in `server/routing.js` and cover it in `test/routing.test.js`.
4. For a CLI, add a fake to `test/fake-cli/` that prints the **real** output format you observed, and add tests. Tests must never call a real AI.
5. Add a row to the **Supported AIs** table in all four READMEs.

## Pull request checklist

- [ ] `npm test` passes locally.
- [ ] New behavior has tests; tests use fake CLIs only (zero AI usage).
- [ ] No new runtime dependencies; no build step introduced.
- [ ] Agent output is still escaped; no new network calls beyond configured APIs and local model servers.
- [ ] UI changes include a screenshot or short clip in the PR description.
- [ ] Docs updated if behavior or setup changed (README translations can follow in a later PR).
- [ ] Every commit is signed off (`git commit -s`).

## Contributor license grant (required)

Office Crew is dual-licensed under the [AGPL-3.0-only](LICENSE) and a [commercial license](COMMERCIAL-LICENSE.md). To keep that possible, every contribution is accepted under the following terms. By submitting a contribution you agree that:

1. You keep the copyright to your contribution.
2. You grant the maintainer of Office Crew a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, modify, distribute and sublicense your contribution as part of Office Crew under the **AGPL-3.0-only and under the maintainer's commercial license terms**.
3. You have the right to make this grant, and the contribution is your original work or you are otherwise allowed to submit it under these terms. This is the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

Confirm this by adding a sign-off line to every commit:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it automatically using your Git `user.name` and `user.email`. If you forgot, `git commit --amend -s` fixes the last commit, and `git rebase --signoff main` fixes the whole branch.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Please be kind and constructive.

---

## 한국어 안내

기여해 주셔서 감사합니다. 버그 제보, 프로바이더 어댑터, 사무실 스킨, 번역, 문서 수정 모두 환영합니다.

- **개발 환경:** Node.js 20 이상과 Git만 있으면 됩니다. AI CLI는 없어도 됩니다.
  ```bash
  git clone https://github.com/yw8837/office-crew.git
  cd office-crew
  npm start -- --home ./.office-crew
  ```
  `--home ./.office-crew`를 붙이면 개발용 데이터가 실제 `~/.office-crew`와 섞이지 않습니다.
- **테스트:** `npm test`. 가짜 CLI(`test/fake-cli/`)로 실제 어댑터·실행 엔진·HTTP API를 끝까지 검증하므로 AI 사용량을 쓰지 않습니다.
- **코드 스타일:** 런타임 의존성 추가 금지(Node.js 기본 모듈과 `public/vendor/`의 Preact·htm만 사용), ES 모듈, 빌드 과정 없음, 주석은 한국어나 영어 모두 괜찮습니다. 에이전트 출력은 반드시 `public/js/markdown.js`를 거쳐 이스케이프하고, CLI는 `server/providers/util.js`의 `spawnCli`로 셸 없이 실행합니다.
- **프로바이더 추가:** 위 [Adding a provider adapter](#adding-a-provider-adapter)의 계약과 체크리스트를 따라 주세요.
- **큰 변경은** 먼저 이슈를 열어 방향을 맞춘 뒤 작업해 주세요.
- **기여 라이선스(필수):** 오피스 크루는 AGPL-3.0과 상업 라이선스로 이중 배포됩니다. 기여물을 제출하면 저작권은 기여자에게 남고, 메인테이너가 그 기여물을 AGPL-3.0과 상업 라이선스 조건으로 배포할 수 있는 영구적·비독점적·무상·취소 불가능한 권리를 부여하는 데 동의하는 것으로 봅니다. 또한 [DCO 1.1](https://developercertificate.org/)에 따라 기여물을 제출할 권리가 있음을 확인합니다. 모든 커밋에 `git commit -s`로 `Signed-off-by:` 줄을 붙여 주세요.
