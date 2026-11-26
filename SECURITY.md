# Security Policy

Office Crew runs AI command-line tools on your machine and serves a local web UI, so we take security reports seriously. Thank you for helping keep users safe.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting:

1. Go to <https://github.com/yw8837/office-crew/security/advisories/new>.
2. Describe the issue and how to reproduce it.

Helpful details:

- Office Crew version (`node bin/office-crew.js --help` prints it), OS and Node.js version
- Steps to reproduce, or a proof of concept
- What an attacker can achieve, and under which conditions (e.g. "a web page the user visits can …")
- Any suggested fix

The maintainer will acknowledge the report, keep you updated in the advisory, and credit you in the release notes unless you prefer to stay anonymous. Please give us reasonable time to release a fix before disclosing publicly.

## Scope

In scope: anything in this repository, especially:

| Area | Examples |
|---|---|
| **Local server** | Reaching the server from another machine or from a web page despite the `127.0.0.1` binding and `Host`/`Origin` checks (DNS rebinding, CSRF), path traversal in static files, uploads or skill IDs |
| **Token** | Leaking or bypassing the per-install API token (`.token` in the data folder, `X-Office-Token` header or `?token=`) |
| **XSS** | Agent output, file names, session titles, plugins or skins that execute script in the UI despite escaping |
| **Command execution** | Injecting arguments or shell commands through prompts, model names, settings or plugins; an agent running commands at a permission level that should forbid them |
| **Secrets** | API keys appearing unmasked in the UI, exports, plugin bundles or logs |

Out of scope:

- Vulnerabilities in the third-party CLIs or AI services themselves (Claude Code, Codex CLI, Gemini CLI, Hermes Agent, API providers). Please report those to their vendors.
- Actions an agent takes within a permission level you granted. "Allow all" (and "Auto decide" for Gemini CLI and ACP agents) lets an agent run commands without asking by design.
- Attacks that require an attacker who already controls your user account or local machine.
- Prompt injection that only leads an agent to misuse permissions you granted, unless Office Crew itself crosses a boundary it is supposed to enforce.

## Security design at a glance

- The server binds to `127.0.0.1` only and rejects requests whose `Host` or `Origin` doesn't match the app.
- Every API request needs a token generated per installation.
- Agent output is escaped before markdown rendering.
- CLIs are spawned without a shell. If a Windows `.cmd` wrapper can't be resolved to its script, a strict argument allowlist is applied before falling back to the shell.
- API keys are stored only in the local data folder (`~/.office-crew` by default) and are masked in the UI, as are connector and ACP values whose names look secret (token, key, secret, password and similar).
- "Use a web browser" ([decision 0029](docs/decisions/0029-browser-tool-as-a-built-in-connector.md)) gives a Claude or Codex agent Microsoft's Playwright MCP server, which the user's CLI downloads and starts with `npx` at a pinned version (Office Crew itself adds no dependency). It is attached only at the permissions that can change files (Allow file edits, Auto decide, Allow all), never to Read-only, Default or read-only goal turns. The browser profile is kept in memory (`--isolated`), so your own sign-ins are not used. Only a chosen list of tools is allowed, by name; the tools that run arbitrary code (`browser_run_code_unsafe`, `browser_evaluate`) and the ones that hand files from this PC to a page (`browser_file_upload`, `browser_drop`, `browser_set_storage_state`) are removed through each CLI's rules. Six allowed tools can write a file through a `filename` argument: Codex runs the server with its working directory and workspace root set to the session's output folder (`cwd` and `--ignore-roots`); for Claude, where no documented way to set the server's working directory was found, calls with that argument are denied (`(filename:*)` rules). Under Claude's "Allow all" the allow list narrows nothing and only the block list holds. The allowed-origins setting is not a security boundary (it doesn't stop redirects), as the Playwright MCP documentation says; its entries are checked strictly. Screenshots are served only when recorded in that session, only from its folder, only as images, with `nosniff`. Page addresses (including any token in their query) and screenshots stay in the session until it is deleted. Text on web pages is passed to the agent with a line saying it is material, not instructions; a page that talks an agent into misusing the browser within that permission is prompt injection, which is out of scope above unless Office Crew crosses a boundary it is supposed to enforce. None of this was checked with a real CLI.

See [docs/DESIGN.md](docs/DESIGN.md) for details.
