# Decisions

Short records of decisions that shape Office Crew and why they were made. Add one when a change touches a shared boundary (license, runtime dependencies, supported CLIs, data format, security model). Copy `0000-template.md`, take the next number and add a line below.

Keep a record under about 100 lines. When a decision changes, add a dated "Revision" section at the top of its record; after three revisions, write a new record that replaces it and mark the old one "Replaced by NNNN".

| No. | Decision | Status |
|---|---|---|
| [0001](0001-no-runtime-dependencies.md) | No runtime dependencies | Accepted |
| [0002](0002-no-antigravity-cli.md) | Google Antigravity CLI isn't supported | Accepted |
| [0003](0003-dual-license.md) | AGPL-3.0 or a commercial license | Accepted |
| [0004](0004-project-memory-on-disk.md) | Project memory is verbatim text on disk with a rebuildable keyword index | Accepted |
| [0005](0005-meeting-stage.md) | A team stage can be a meeting with fixed rounds and a chair | Accepted (its flow from round 2 is replaced by 0010) |
| [0006](0006-hire-proposal-in-chat.md) | A hire request in the chat becomes a proposal the user approves | Accepted |
| [0007](0007-local-only-user-messages.md) | What you type to a local model stays away from cloud AIs | Accepted |
| [0008](0008-handoff-to-another-ai.md) | Another AI that takes over a session gets the earlier conversation three ways | Accepted |
| [0009](0009-agents-ask-with-a-marked-block.md) | An agent asks the user by writing a marked block in its answer | Accepted |
| [0010](0010-meetings-take-turns.md) | Meetings take turns, and the chair judges after each round (replaces the flow part of 0005) | Accepted |
| [0011](0011-meetings-pause-for-research.md) | A meeting turn can ask a question, and the team's researcher looks it up once | Accepted |
| [0012](0012-claude-usage-counts-the-whole-tree.md) | Claude usage counts sub-agents and is not counted twice in a continued conversation | Accepted |
| [0013](0013-agents-keep-role-notes.md) | Agents keep short role notes, and only what the user accepts goes into their work | Accepted |
| [0014](0014-goal-mode-confirmed-goal-card.md) | Goal mode turns a request into a goal card the user confirms, and only the confirmed values become instructions | Accepted |
| [0015](0015-goal-mode-fresh-review.md) | Goal mode checks each confirmed criterion with a fresh reviewer, returns the work once, then asks | Accepted |
| [0016](0016-goal-mode-continue-a-cut-goal.md) | A goal cut off by closing the app continues from where it stopped, only when the user asks | Accepted |
| [0017](0017-goal-mode-research-and-meeting-first.md) | Goal mode researches and holds a meeting before the work, every turn in a new conversation | Accepted |
| [0018](0018-goal-mode-task-cards.md) | Goal mode can split the work into task cards the lead plans and the code orders | Accepted |
| [0019](0019-goal-mode-call-estimate-and-limit-wait.md) | Goal mode shows a rough call estimate before confirming, and waits for a usage-limit reset when no other AI can take over | Accepted |
