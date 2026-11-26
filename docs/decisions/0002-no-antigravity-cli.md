# 0002: Google Antigravity CLI isn't supported

- Status: Accepted
- Date: 2026-11-02 (recorded 2026-11-10)
- Related: `CHANGELOG.md` 1.0.0, README "Using your accounts"

## Context

Office Crew drives official CLIs with the user's own sign-in. Using a personal subscription through a third-party tool is fine for some CLIs and not allowed for others. The personal-account terms of Google Antigravity don't allow use through third-party tools.

## Options

1. Support it like the other CLIs and leave the terms to the user.
2. Don't support it.

## Decision

Option 2. There is no Antigravity provider or ACP preset. Agents saved by pre-release builds that used it switch to auto-routing.

## Consequences

- Users of that CLI can't add it to a team.
- If its terms change to allow third-party tools, a new record can replace this one.

## Revision (2026-11-26)

Checked again on 2026-11-26 against the original pages; the decision stands. Google's announcement of 2026-05-19 says Gemini CLI stopped serving free and Google AI Pro/Ultra users on 2026-06-18 and "will remain accessible via paid Gemini and Gemini Enterprise Agent Platform API keys" (https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/). Antigravity has a headless mode, `agy -p`, with `--output-format` `text`, `json` and `stream-json` (https://antigravity.google/docs/cli/headless), and its FAQ calls it "intended for direct scripting and CI workflows" but says wrapping `agy` in third-party applications "is not supported under consumer plans" (https://antigravity.google/docs/faq/). The additional terms (undated, no revision date is shown) treat "Using third party software, tools, or services to access the Service" as a breach (https://antigravity.google/terms).
So it is technically possible to run headless, but the terms don't allow another app to wrap it on consumer plans, and the decision is kept.
