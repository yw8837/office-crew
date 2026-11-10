# Changelog

All notable changes to Office Crew are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Crew Village, the new default office skin: idle agents stay inside their own house (the windows light up), commute to the office building when work starts, and go home after they finish. Tools still send them places: reading to the library, searching to the lookout tower, running commands to the workshop, planning and long thinking to the plaza fountain. Approvals and errors are handled at the desk. The office skins (Modern, Cozy, Night) are still available.
- Agent look: besides a person, an agent can be an original creature (three shapes, any body color) or your own image. Uploaded images are shrunk to 256px on the long side and stored only on your machine; small pixel art is scaled up crisply. Only PNG, JPEG, WEBP and GIF are accepted.
- Customize village: replace the house with your own image (for example a capsule or a tent) in Settings → Display & language → Office skin.
- Several ChatGPT accounts: add more ChatGPT accounts in Settings → AI accounts. Each one signs in to its own Codex folder (your main account's `config.toml` and `AGENTS.md` are copied when you add it and its skills folder is linked; sign-in files are not copied) and works as its own AI with its own usage limits. When one account hits its limit, the next signed-in account takes over first, with the same model and effort. Auto-routing tries them right after the main Codex account, a cross-check review treats them as the same AI and picks a different one, and removing an account moves its agents back to the main Codex and clears its usage and rest records.
- Skills in Korean: in the Korean UI, skill descriptions are shown in Korean. They're saved only in your data folder (`skill-desc-ko.json`) and matched by the original text, so a changed description shows as untranslated again. "Make Korean descriptions" on the Skills page has an agent you pick translate the missing ones (it uses that AI's usage).
- Easier skill picking: an agent's skills are picked from a list with descriptions, with tabs for suggestions for its role, its own CLI's skills, the selected ones and all. A skill installed in several places is shown once. The Skills page can filter by source.
- Start without a console window on Windows: `오피스크루 실행 (창 없이).vbs`. Quit from Settings → About → Quit Office Crew; output goes to `~/.office-crew/launcher.log`.
- Phone notifications (off by default, Settings → Storage & performance): approvals, decisions, finished work and failures can be sent to an ntfy topic or a webhook address you set, such as Slack or Discord. Only the status and the team or agent name leave your PC, never the conversation or the session title (a session is named from its first message). The address is masked in the app because it can hold a secret. A failed send never affects the work, and the settings card shows the last error. A public ntfy topic can be read by anyone who knows its name, so pick a hard one to guess.
- Kanban board: write tasks as cards and hand them to a team or an agent. A card moves by itself from To do to In progress to Needs a look (approvals, errors and finished results), and only you mark it Done. Handing a card over starts a real run and asks first. Cards can be dragged to Done or back.
- Watch sessions: a new page shows the Claude Code and Codex sessions you run in a terminal, one character per session, moving by what the session is doing. It only reads their log files: no CLI is started and no AI usage is spent, and reading stops about a minute after the page closes. File paths show as names only and commands as the program name only; the end of the AI's latest answer is shown too, with common token shapes masked, so take care when sharing your screen. A session shows as idle after 90 seconds without a log line, or 30 minutes when its last line started a tool, such as a long build. The log format belongs to each CLI and can change between versions; unknown lines are skipped. Up to 12 recent sessions are shown, and the page says how many are hidden. Added ChatGPT accounts and Codex sessions started more than two days ago aren't watched.
- Daily budget (off by default, on the Routing board): keeps a weekly limit from going in a day or two. You set a daily share of the weekly window (13% by default). Once a quarter of the share is used and today is going faster than the day, a run's effort is lowered one or two steps (never raised, never below low; the saved agent doesn't change). An AI that used its share hands off to another AI until midnight; with no other AI available, or with auto-handoff turned off, work continues at low effort. A review keeps its cross-check first: it may still use an AI that's over budget, at low effort, rather than the AI that built the result. An AI taking over after a usage limit follows the same pace. Today's spend counts from the first weekly reading the app sees today (usage while the app was closed isn't counted), and only AIs that report weekly usage are affected. "Use again" on an AI that's over its share lifts it for the rest of the day. A scheduled run is stricter: if no AI within budget can take it, that time is skipped instead of running at low effort ("Run now" still runs).
- Desktop notifications (off by default, Settings → Storage & performance): when the window is in the background, a notification tells you about approvals, decisions, finished work and failures. Clicking it opens the session. Permission belongs to each browser, so the setting says when this one hasn't allowed it. Work that ends while the page is disconnected doesn't notify.
- Stalled run watch: if a CLI gives no output for 30 minutes (Settings → Defaults, 0 turns it off), it's stopped and goes to the usual error step. A stuck scheduled run ends by itself instead, so later runs aren't held up. While a tool is running it waits up to four times as long, since builds and tests can be quiet. Hermes isn't watched, because it gives its whole result at the end.
- Continuing a conversation now carries what you missed: when an agent picks its conversation back up, it also gets what was said with other agents since its last answer, limited by the recent-conversation setting and marked as reference rather than instructions. A conversation with a local model isn't passed to a cloud AI this way, or when recent conversation is added to a new or handed-over run.
- Leftover CLI cleanup: running CLIs are recorded in `running-cli` in the data folder. If the app was killed or the power went out, the next start stops CLIs it left behind, only when both the start time and the name match (so a reused process ID never stops another program), and leaves the record of another running copy of the app alone.
- Schedules: on the days and at the time you pick, a team (or a single agent) gets the same instruction and starts working on its own, in a new session each time or continuing one session. Times use this PC's clock and only run while the app is open. A time missed while the app was closed is skipped by default, or run once when the app opens if you turn that on. If the previous run hasn't finished, that time is skipped. Approval steps wait for you as usual. Run now, turn on or off, and the last result are on each card.

### Changed
- Model and effort names match each CLI: Claude models show their version the way Claude Code does (Opus 5.5, Fable 5.1, Sonnet 5.5, Haiku 5.5), with "(my default)" on the model from your Claude Code settings. The version an alias resolved to in a real run is remembered across restarts. Codex lists every model in its catalog, previous generations included, named as the Codex app does (GPT-6.1 Sol). Effort levels are Low, Medium, High, Extra high, Max (and Ultra where a Codex model supports it), with "(my default)" for the level in your CLI settings and "(recommended)" or "(default)" for the model's own. "Default (follow CLI settings)" is at the top of the model list, and Max on Claude warns that it uses much more.
- Auto-routing no longer picks previous-generation Codex models.
- Read-only agents no longer run hooks, so asking an agent to only read a downloaded repository can't run that repository's commands. Claude Code runs them with `--setting-sources user` (settings from the work folder aren't loaded, and they're told to read project rule files such as `CLAUDE.md` and `AGENTS.md` themselves); Codex runs them with `features.hooks=false` (your own Codex hooks are off too in those runs). Other permission levels keep working as before.
- Claude Code runs get a permission rule that refuses reading the sign-in files of Claude Code, Codex (added accounts and a custom `CODEX_HOME` included), Hermes and Gemini CLI, plus this app's settings (where API keys live) and access token. This covers Claude's file-reading tools; an agent allowed to run commands can still reach them through the shell.
- Picking a risky work folder is refused: a drive's top level, your whole home folder (or above it) and the app's data folder (or a folder containing it). Sessions already using such a folder, such as an imported one, keep working.
- Team runs: earlier stages' results are passed inside markers that change every time, with a note not to follow anything in them that tries to widen permissions or change the request. This lowers the risk of text an earlier stage read (a web page, a repository's documents) acting as an instruction later; it doesn't remove it.
- Crew Village is now the README's demo and office screenshots, with new pictures for schedules, skills, skins and a customized village.
- `오피스크루 실행.cmd` no longer waits for a key press when Office Crew is already running; it pauses only on an error.

### Fixed
- Skills: descriptions written over several lines in `SKILL.md` (`description: >` or `|`) were read as a single `>` or `|`, and a long header could leave the description empty. Multi-line and quoted values are now read in full.
- The page is marked as not to be translated, so browser translation extensions no longer add translations next to model names and labels (for example "Gemini" turned into a word meaning "twins").
- Settings → AI accounts: when Hermes is not signed in, the provider from its config (for example Nous Portal) no longer shows as a signed-in account. The card says "Login required" and names the configured provider in the note instead.

## [1.1.0] - 2026-11-03

### Added
- Needs you: the top of the sidebar collects sessions that need you (approvals, decisions after an error, paused runs, failures and results you haven't opened yet). Results and failures leave the list once you open them; approvals, decisions and paused runs stay until they're handled.
- Handoff note: when another AI takes over after a usage limit, it also gets a note the server pulled from the tool log: tools used (with failed and unfinished counts), files changed (relative to the work folder) and the last three commands, plus an instruction to check the current state before continuing. Commands keep only the program, well-known subcommands and plain file names (`npm test`, `git commit …`); the other arguments, where tokens and passwords usually sit, are left out. Names, paths and commands are quoted and marked as values, not instructions.
- Evidence-based review: review agents are told to judge only by evidence they checked themselves and to list anything they couldn't check. A review done by the same AI that built the result, including one that took the review over after a usage limit, is flagged as weaker than a cross-check. The same AI means the same CLI (Claude Code, Codex, Gemini CLI, Hermes), or the same API profile and model, ACP agent or local model.

### Changed
- Claude Code, Codex, Gemini CLI and Hermes now rest until the reset time stated in the limit error when their usage data has no full window, instead of a flat 30 minutes. Recognized forms: `Retry-After`, "try again in …", "try again at …", "resets 3pm" and an epoch suffix; a time zone after the time (UTC, an offset such as UTC+9, or a name such as `(America/Los_Angeles)`) is honored. A time that passed less than two hours ago falls back to 30 minutes, and waits shorter than a minute become a minute.
- Auto-routed review agents avoid the AIs that built the result (every earlier build stage, or the previous stage when there was no build). Before, only the nearest stage with output was avoided.
- Environment variables and headers of connectors, and environment variables of ACP agents: names that contain `AUTH` or `COOKIE` but end in a setting word, such as `LOGIN`, `LABEL`, `GUARD`, `MODEL`, `PKCE` or `ONLY`, are shown as normal values instead of being masked.

### Fixed
- ACP file requests that used a Windows short (8.3) path for a file inside the work folder were refused. Other paths outside the work folder are still refused before the file system is touched, except on Windows when the path or the work folder contains `~` (a possible short name) and the path is on the same drive; those are resolved first and then refused if they really are outside.

## [1.0.0] - 2026-11-02

First public release.

### Added

#### Providers
- Runs your own installed and signed-in official CLIs: Claude Code, OpenAI Codex CLI, Gemini CLI (API key) and Nous Hermes Agent.
- Billing per AI for Claude Code and Codex: subscription sign-in or an official API key (`ANTHROPIC_API_KEY` / `CODEX_API_KEY`). Subscription mode strips those variables from the CLI environment so a stray key never bills you by surprise.
- ACP (Agent Client Protocol) agents: presets for Gemini CLI `--acp`, Hermes `acp`, OpenCode, Goose and Qwen Code, or any custom ACP command. Permission requests follow the agent's permission level; file reads and writes the agent asks Office Crew to do stay inside the work folder (reads also cover attachments).
- OpenAI-compatible APIs: OpenAI, OpenRouter, Nous Portal, xAI and the Gemini API.
- Local models detected automatically: Ollama, LM Studio, llama.cpp, vLLM and Jan, plus custom server URLs.
- Built-in demo provider with zero usage, for trying the app and for tests.
- Settings → AI accounts: install status, version, signed-in account and supported effort levels per CLI, with a sign-in button that opens the CLI's login in a terminal.

#### Agents and routing
- Per-agent provider, model, effort (low to max, xhigh where supported), permission (read-only to full access), system prompt, skills, MCP connectors and avatar.
- Model dropdowns fed by each CLI's own model catalog, refreshed automatically every 30 minutes and when a CLI update is detected.
- Auto-routing, the default for new agents: picks a model and effort at run time from the AIs you're signed in to, by role (research, organize, analysis, build, review, writing) and profile (economy, balanced, best). Review is cross-checked by a different AI than the builder whenever possible.
- Routing board to edit every agent's routing in one table.
- Automatic handoff: when an AI hits its usage limit, another AI with headroom takes the same role and finishes from where it stopped. AIs that are resting or above a usage threshold (95% by default) are avoided before a run. Toggle, threshold and manual release on the Routing board.

#### Teams and runs
- Team pipelines: stages run in order, agents within a stage run in parallel, and previous outputs are handed off automatically.
- Approval gates (approve, or request changes to rerun the stage with feedback) and an error gate (retry, skip or stop).
- Live intervention: steer a running agent (injected into the running process for Claude), queue messages, pause/resume, stop, and skip a single agent.
- Real-time usage per message, agent and session: estimated tokens while streaming, real counts at turn end, cost where the CLI reports it, and account limits (Claude 5-hour and weekly %, Codex weekly %).

#### Live office
- Isometric SVG office with no game engine. Characters walk to the Research room, Library, Server Room or Meeting Room by tool type, raise a hand for approvals, sweat on errors, carry documents on handoff, and spawn sub-agent helpers.
- Skins: Modern, Cozy and Night, plus custom image skins with a desk and spot editor.
- Quality levels `full`, `lite` and `static` for low-end PCs.

#### Desktop-app experience
- Sessions with search and pinning, image paste (Ctrl+V), drag and drop, `@agent` mentions and `/skill` commands.
- Markdown with copy buttons, resend and edit, export a chat to `.md`, and dark mode.
- Skills discovered automatically from Claude and Codex skill folders, MCP connectors injected per agent, and plugins that bundle agents, teams, skills, connectors and skins into one JSON file (import/export).
- Import and continue Claude Code and Codex sessions without losing context. Claude continues on a fork (`--fork-session`) so the original history is untouched; if resuming fails, the recent conversation is passed along instead.
- UI languages: Korean, English, Simplified Chinese and Japanese.

#### Platform and security
- Zero runtime dependencies (Node.js built-ins only), no build step, UI built with vendored Preact and htm (about 16 KB).
- Launcher opens an Edge/Chrome app window, with `--browser`, `--port`, `--home` and `--no-open` options; Windows launcher script `오피스크루 실행.cmd`.
- Server bound to `127.0.0.1` with `Host`/`Origin` checks and a per-install token; agent output escaped before markdown rendering; API keys masked in the UI.
- Test suite with fake CLIs (zero AI usage) and CI on Windows, Linux and macOS with Node.js 20 and 22.

#### Documentation
- "Using your accounts" guidance in the README (four languages) and in the app: official CLIs only, no access to CLI sign-in tokens, API keys for products, teams and unattended runs.
- Google Antigravity CLI is intentionally not supported, because its personal-account terms don't allow use through third-party tools. Agents saved by pre-release builds that used it switch to auto-routing.

### Licensing
- Dual license: AGPL-3.0-only, or a commercial license (see `COMMERCIAL-LICENSE.md`).

[Unreleased]: https://github.com/yw8837/office-crew/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/yw8837/office-crew/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/yw8837/office-crew/releases/tag/v1.0.0
