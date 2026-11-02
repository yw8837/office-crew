# Changelog

All notable changes to Office Crew are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Waiting on you: the top of the sidebar collects sessions that need you (approvals, decisions after an error, paused runs, failures and results you haven't opened yet). Opening a session clears it from the list.
- Handoff note: when another AI takes over after a usage limit, it also gets a note the server recorded from the tool log: tools used (with failed and unfinished counts), files changed (relative to the work folder) and the last three commands with secrets masked, plus an instruction to check the current state before continuing.
- Evidence-based review: review agents are told to judge only by evidence they checked themselves and to list anything they couldn't check. A review done by the same AI that built the result, including one that took the review over after a usage limit, is flagged as weaker than a cross-check.

### Changed
- When there is no usage-window data, an AI that hit its limit now rests until the reset time stated in the error message (`Retry-After`, "try again in …", "try again at …", "resets 3pm", an epoch suffix) instead of a flat 30 minutes.
- Connector environment variables: fewer non-secret names are masked. Names whose last word is a setting, such as `LOGIN`, `LABEL`, `GUARD`, `MODEL`, `PKCE` or `ONLY`, are shown as normal values.

### Fixed
- ACP file requests that used a Windows short (8.3) path for a file inside the work folder were refused.

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

[Unreleased]: https://github.com/yw8837/office-crew/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/yw8837/office-crew/releases/tag/v1.0.0
