# 0007: What you type to a local model stays away from cloud AIs

- Status: Accepted
- Date: 2026-11-12
- Related: `server/orchestrator.js` (`localOnly`, `#premark`, `#received`, `#titleMark`, `#remember`, `recover`), `server/store.js` (`#fixStale`, `takeStale`), `test/local-only.test.js`, `test/memory-run.test.js`

## Context

A reply from a local model (provider `local`) was already left out of everything Office Crew hands to a cloud AI: earlier conversation, missed conversation and project memory. The user's own message in that conversation was not. It has no provider, so every filter let it through, and it could reach a cloud AI later in the same session or, with project memory on, in another session of the same folder. The session title is made from the first message and is printed in the source line of each memory piece, so it could carry the same words.

## Options

1. Decide from the plan when the message is sent. Simple, but an agent with automatic routing can end up on a cloud AI or on a local model, so the plan can be wrong in both directions.
2. Decide from the AIs that really received the message. Correct, but known only after the run has started, and nothing is known for a message that is still queued or whose run was cut off.
3. Both: mark from the plan when sending, then correct from what really happened.

## Decision

Option 3.

- A user message gets `local: true` when it is sent if every agent in its plan uses provider `local`. When an agent starts, the mark is set if only local models have received the message so far and removed as soon as a cloud AI receives it. A change is saved at once.
- `localOnly(m)` is true for a local model's reply and for a marked user message. Earlier conversation, missed conversation and the history given to API agents leave such messages out unless the receiver is a local model. Project memory stores a marked user message with provider `local`, which the existing rule already keeps from cloud AIs.
- The user's message is stored in project memory when its run ends, because the mark is only final then. If the app closes during the run it is stored at that moment, and after a crash it is stored at the next start. `remembered: true` on the message keeps it from being stored twice.
- A session remembers which message its title came from (`titleFrom`). If that message is marked, `titleLocal` is set and memory pieces of that session are stored with an empty title. Renaming the session clears both.
- At start, sessions that were running when the app stopped are settled once, after the server has its port (so a second copy of the app does not rewrite the session files of a running one). Settling only adds the mark, never removes it: an agent message that failed before anything was sent still names a cloud AI.

This adds fields to the session data format: `local`, `remembered` and `cut` on messages, `cut` on runs, `titleFrom` and `titleLocal` on sessions. Earlier versions ignore them.

## Consequences

- A message that a local model and a cloud AI both received in one run is not held back. It went to the cloud AI anyway.
- Messages sent before this change carry no mark, and memory pieces stored before it keep their title.
- A title the user typed is always shown.
- When in doubt the message is held back: a message planned for local models that no AI received stays marked.
- A message is not stored in project memory if memory is turned off during its run, if it was still queued when its session was deleted, or if the app was killed within a moment of the run starting.
