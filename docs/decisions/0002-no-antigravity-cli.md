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
