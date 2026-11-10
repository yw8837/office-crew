# 0001: No runtime dependencies

- Status: Accepted
- Date: 2026-11-02 (recorded 2026-11-10)
- Related: `docs/DESIGN.md`, `THIRD-PARTY-NOTICES.md`

## Context

Office Crew runs on the user's own PC next to CLIs that hold their subscriptions. Every installed package is code that runs with the user's permissions and a supply-chain risk, and an install step is a reason not to try the app.

## Options

1. Use common packages (a web framework, a database, a bundler). Faster to write, but adds install size and supply-chain exposure.
2. Use only Node.js built-in modules on the server and vendor a tiny UI library. More code to write and test, nothing to install.

## Decision

Option 2. `package.json` has no `dependencies`. The server uses Node.js built-in modules only. The UI is plain JavaScript modules with vendored Preact and htm (about 16 KB) and no build step. Data is JSON files in the data folder.

## Consequences

- `npm start` works right after cloning, and the release is the source.
- Features a package would give for free (full-text search, image processing, a database) need small hand-written code or are left out.
- Adding a runtime dependency means replacing this record.
