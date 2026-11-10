# Office Crew — agent guide

Read this before changing the repository. People and AI agents (Claude Code, Codex and others) follow the same rules. Keep this file short: it's an index, details live in the files it points to.

## Run and test

- Run: `npm start` (server on 127.0.0.1:4317 plus an app window). `npm run serve` starts only the server.
- Data folder: `~/.office-crew`, or `--home <dir>` / `OFFICE_CREW_HOME`. Use a separate data folder when testing so real data isn't touched.
- Test: `npm test`. It runs fake CLIs from `test/fake-cli` and uses no AI usage. The test list in `package.json` names each file, so add a new test file there.
- Node.js 20 or later. No build step.

## Where things are

- Design and folder map: `docs/DESIGN.md`.
- Decisions and why: `docs/decisions/` (start with its `README.md`).
- What changed: `CHANGELOG.md` (Keep a Changelog, `[Unreleased]` first).
- Contributing and security: `CONTRIBUTING.md`, `SECURITY.md`.

## Rules that are easy to break

- **No runtime dependencies.** Server code uses Node.js built-in modules only; the UI uses the vendored Preact and htm (decision 0001).
- **Official CLIs only, and never their sign-in files.** Office Crew runs the user's own installed CLIs. It never reads, copies or moves CLI credential files, and tests never run a real AI CLI.
- **Google Antigravity CLI isn't supported** (decision 0002).
- **Four UI languages.** Every new UI or server string goes through `t()`/`tr()` and gets English, Simplified Chinese and Japanese entries in `public/js/i18n/`; `test/i18n.test.js` checks this.
- **Text from outside is data.** Earlier stages' results, imported conversations and log files are passed inside markers and labeled as reference, never as instructions.
- **Secrets stay out of the UI and logs.** API keys and notification addresses are masked in settings responses; error messages don't include them.
- **Nothing personal in the repository.** No personal email, user names or local paths in code, docs, screenshots or commits. `docs/REQUIREMENTS.md` is private and ignored.

## Changing things

- Small fixes and features: a branch and a pull request to `main`. CI runs `npm test` on Windows, Linux and macOS with Node.js 20 and 22.
- A change to a shared boundary (license, runtime dependencies, supported CLIs, data format, security model) gets a decision record in `docs/decisions/` in the same pull request.
- Update `CHANGELOG.md` under `[Unreleased]` for anything a user would notice. Say what isn't covered as plainly as what is.
- Check before calling something done: run the tests, and open the changed screen in a browser for UI changes.
