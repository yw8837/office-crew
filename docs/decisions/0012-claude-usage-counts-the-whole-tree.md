# 0012: Claude usage counts sub-agents and is not counted twice in a continued conversation

- Status: Accepted
- Date: 2026-11-18
- Related: `server/usage.js` (`treeTotals`, `versionAtLeast`, `settleClaude`, `Usage.record`), `server/providers/claude.js` (the `result` event, `detect()` reads the version), `server/orchestrator.js` (`#onEvent`, `#settle`, `#runAgent`), `server/index.js` (clearing a session), `test/fake-cli/fake-claude.js` (`SUBUSE`, `CUMUL`, `ZEROCRASH`), `public/js/views/session.js`, `test/usage-accounting.test.js`

## Context

Claude Code's result message has three usage fields that count different things (Agent SDK cost tracking documentation, read on 2026-11-18):

- `usage`: the tokens of the main agent in that turn only. Tokens used by sub-agents (the Task/Agent tool) are not in it.
- `modelUsage` (model name → `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`) and `total_cost_usd`: sub-agents included.
- These two are running totals. Office Crew sends the turns of one CLI process over standard input, and each result carries the total of that process so far. Claude Code saves a conversation's totals to its transcript only when the process exits normally, and restores them when a later process continues (`--resume`) or forks that conversation, so that process's results include the earlier spend too (from Claude Code 2.1.277; before that, a continued conversation started from zero). A process that is killed saves nothing, and the final result of a crash may carry zeros.

Office Crew added `usage` and `total_cost_usd` to each message as they came. So the tokens missed what sub-agents used, and the cost of a continued conversation was counted again on every call. The meeting usage limit, the session and agent totals and today's totals all read these numbers.

## Options

1. Keep `usage` only. Simple, but sub-agent work stays invisible, and the meeting limit undercounts an agent that delegates.
2. Use `modelUsage` and `total_cost_usd` as they come. Sub-agents are counted, but a continued conversation is counted again on every call, more each time.
3. Use `modelUsage` and `total_cost_usd`, and subtract the totals of the same CLI conversation's previous result (a baseline kept next to the conversation id). When the numbers can't be trusted, count less, not more: fall back to `usage` and mark the count as partial.

## Decision

Option 3.

- `claude.js` passes `modelUsage` and `total_cost_usd` along with `usage` in the usage event (`tree`); it does not compute anything. Other providers are unchanged.
- `settleClaude` (a pure function) decides the amount of one result. Besides the result, it gets the baseline (or none), whether the call continued a conversation, and the Claude Code version that `detect()` read from `claude --version` (or none):
  1. Whether the totals carry earlier spend: a later result of the same process always does; the first result of a process that continued a conversation does from 2.1.277 and does not before (`versionAtLeast`, a pure comparison); with an unknown version the app can't tell.
  2. Older than 2.1.277, first result of a process: the baseline is not used. The totals are that call's own amount (or `usage`, if that is larger).
  3. With a baseline: each item is the total minus the baseline. If the totals went down or grew by less than `usage`, a result the CLI never saved is in the baseline (the app stopped the process, or it crashed): only `usage` is counted and the count is partial; the whole conversation is never counted again. Only when the version is unknown and the call did not continue a conversation are the totals taken as that call's own amount.
  4. Without a baseline: a call that continued a conversation (an imported conversation, a session from before this change, or after the app dropped the baseline) may carry earlier spend, so `usage` is counted, no cost is added, and the count is partial. A new conversation counts its totals.
  5. The cost is the total cost minus the baseline's; when that is negative, 0 and partial. Without `modelUsage`, `usage` is counted as it is, the count is partial, and the cost follows the same rules.
  6. No item is smaller than `usage`. `sub` = the result's tokens minus `usage`'s tokens: what was used outside the main agent (sub-agents, and anything else the totals grew by), never below 0.
- The orchestrator keeps the baseline per session and agent in `session.usageBase[agentId] = { id, input, output, cacheRead, cacheWrite, cost }`, next to `providerSessions`. `id` is the CLI conversation id that a later call would continue. A call uses the baseline only when it continues exactly that id; a new conversation, another AI, a loop restart or an import therefore never uses it. Within one call, each further result (an extra instruction sent to the same process) is settled against the previous result of that call.
- A baseline that can't be trusted is dropped or not stored: when the app stops a process that had already produced a result (stop, skip, "End meeting", the stall and loop checks, quitting the app), because Claude Code may not have saved that result, and a result that arrives after the stop is not stored either; when a result has no `modelUsage`; when the totals are smaller than the baseline. Totals of zero (a crash) are not stored, and the previous baseline stays. Clearing a session removes all of them.
- The settled amount is what goes into `message.usage` (with `partial: true` and `sub` when they apply) and into the usage records by provider, day and agent, so the meeting usage limit, the session, agent and today totals all count the same thing.
- On screen, the token count under a message and on an agent's card in the right panel gets a `*` when the count is partial. The tooltip says that sub-agent usage may be missing, or how many tokens were used outside the main agent; the `*` carries the same text as its accessible name for screen readers.

## Consequences

- An agent that delegates to sub-agents now shows and spends more of the meeting usage limit, which is the point.
- Not covered: sub-agent usage of Codex, Gemini CLI and the other providers may still be missing. Messages and records saved before this change are not corrected. The cost is the CLI's own estimate. When the version could not be read, the app guesses by the rules above. The first call that continues an imported conversation or a session from before this change, and the first call after the app stopped a call that had already answered, count only the main agent, without sub-agents, add no cost and are marked partial. What background sub-agents used after a result was reported may be counted in the next call. If the same conversation was continued outside the app, that usage is counted once in the next call. This was checked with fake CLIs only, not reproduced with a real Claude Code.
- To undo: settle Claude results with `usage` and `total_cost_usd` again in `#onEvent`. The `usageBase`, `partial` and `sub` fields can stay; older code ignores them.
