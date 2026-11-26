# Decisions

Short records of decisions that shape Office Crew and why they were made. Add one when a change touches a shared boundary (license, runtime dependencies, supported CLIs, data format, security model). Copy `0000-template.md`, take the next number and add a line below.

Keep a record under about 100 lines. When a decision changes, add a dated "Revision" section at the top of its record; after three revisions, write a new record that replaces it and mark the old one "Replaced by NNNN".

| No. | Decision | Status |
|---|---|---|
| [0001](0001-no-runtime-dependencies.md) | No runtime dependencies | Accepted |
| [0002](0002-no-antigravity-cli.md) | Google Antigravity CLI isn't supported | Accepted |
| [0003](0003-dual-license.md) | AGPL-3.0 or a commercial license | Accepted |
| [0004](0004-project-memory-on-disk.md) | Project memory is verbatim text on disk with a rebuildable keyword index | Accepted (revised by 0030) |
| [0005](0005-meeting-stage.md) | A team stage can be a meeting with fixed rounds and a chair | Accepted (its flow from round 2 is replaced by 0010; revised by 0023) |
| [0006](0006-hire-proposal-in-chat.md) | A hire request in the chat becomes a proposal the user approves | Accepted |
| [0007](0007-local-only-user-messages.md) | What you type to a local model stays away from cloud AIs | Accepted |
| [0008](0008-handoff-to-another-ai.md) | Another AI that takes over a session gets the earlier conversation three ways | Accepted |
| [0009](0009-agents-ask-with-a-marked-block.md) | An agent asks the user by writing a marked block in its answer | Accepted |
| [0010](0010-meetings-take-turns.md) | Meetings take turns, and the chair judges after each round (replaces the flow part of 0005) | Accepted |
| [0011](0011-meetings-pause-for-research.md) | A meeting turn can ask a question, and the team's researcher looks it up once | Accepted |
| [0012](0012-claude-usage-counts-the-whole-tree.md) | Claude usage counts sub-agents and is not counted twice in a continued conversation | Accepted |
| [0013](0013-agents-keep-role-notes.md) | Agents keep short role notes, and only what the user accepts goes into their work | Accepted (revised by 0023) |
| [0014](0014-goal-mode-confirmed-goal-card.md) | Goal mode turns a request into a goal card the user confirms, and only the confirmed values become instructions | Accepted |
| [0015](0015-goal-mode-fresh-review.md) | Goal mode checks each confirmed criterion with a fresh reviewer, returns the work once, then asks | Accepted (revised by 0026) |
| [0016](0016-goal-mode-continue-a-cut-goal.md) | A goal cut off by closing the app continues from where it stopped, only when the user asks | Accepted |
| [0017](0017-goal-mode-research-and-meeting-first.md) | Goal mode researches and holds a meeting before the work, every turn in a new conversation | Accepted (revised by 0026) |
| [0018](0018-goal-mode-task-cards.md) | Goal mode can split the work into task cards the lead plans and the code orders | Accepted |
| [0019](0019-goal-mode-call-estimate-and-limit-wait.md) | Goal mode shows a rough call estimate before confirming, and waits for a usage-limit reset when no other AI can take over | Accepted (revised by 0026 and 0030) |
| [0020](0020-flow-stage-default-picture.md) | The split view shows a flow stage above the chat; the village stays in the Large office view | Accepted |
| [0021](0021-no-demo-team.md) | No demo team; the simulated AI stays for tests and is hidden from the screens | Accepted |
| [0022](0022-goal-mode-records-and-block-allow-list.md) | Goal mode keeps one table of the blocks each step takes, records who actually ran and why, and names failures only by facts the code knows | Accepted (revised by 0027 and 0030) |
| [0023](0023-prompt-assembly-for-cache-and-fresh-meeting-turns.md) | An agent's system instructions stay the same on every call; per-call lines go at the front of the prompt, meeting turns send only what is new, and long sessions hold meetings in new conversations | Accepted |
| [0024](0024-team-proposal-from-a-document.md) | A document attached in the chat becomes a team proposal the user approves | Accepted (revised by 0027) |
| [0025](0025-goal-report-and-evidence.md) | A goal ends with a report the code puts together, and agents' claims are checked against facts where the code can check them | Accepted (revised by 0030) |
| [0026](0026-usage-breakdown-limit-cap-and-lean-profile.md) | Usage is shown split and weighted, a goal asks before new work when a subscription window is over a cap, and a lean profile hands on less | Accepted |
| [0027](0027-ask-before-raising-a-stuck-card.md) | Goal mode asks before handing a stuck task card to a higher-tier agent; it never raises one by itself | Accepted (revised by 0030) |
| [0028](0028-stalled-meetings-and-asking-the-user.md) | Code notices a stalled meeting and a return that makes no progress, and a meeting can ask the user | Accepted |
| [0029](0029-browser-tool-as-a-built-in-connector.md) | The "Use a web browser" switch is a built-in Playwright MCP connector, and the browser tab shows the screenshots from its output folder | Accepted |
| [0030](0030-goal-run-records-retry-and-flow-map.md) | Goal mode remembers repeated failures, retries a temporary outage once, exports a run as one file and draws a read-only flow map | Accepted |
