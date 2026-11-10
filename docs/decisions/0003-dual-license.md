# 0003: AGPL-3.0 or a commercial license

- Status: Accepted
- Date: 2026-11-02 (recorded 2026-11-10)
- Related: `LICENSE`, `COMMERCIAL-LICENSE.md`

## Context

Office Crew is open source, and the author wants changes made by anyone who runs it as a service to stay open, while still allowing companies that can't accept the AGPL to use it.

## Options

1. A permissive license (MIT or Apache-2.0). Easiest to adopt, but modified hosted versions can stay closed.
2. AGPL-3.0 only.
3. AGPL-3.0, or a commercial license on request.

## Decision

Option 3. The code is licensed under AGPL-3.0-only (`LICENSE`), and a commercial license is available (`COMMERCIAL-LICENSE.md`).

## Consequences

- Taking outside contributions has to keep offering both licenses possible; check this before merging code you didn't write.
- Code can't be copied into this repository from projects whose license doesn't allow relicensing.
