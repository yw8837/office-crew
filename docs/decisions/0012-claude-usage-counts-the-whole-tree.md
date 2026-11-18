# 0012: Claude usage counts sub-agents and is not counted twice in a continued conversation

- Status: Accepted
- Date: 2026-11-18
- Related: `server/usage.js` (`treeTotals`, `settleClaude`, `Usage.record`), `server/providers/claude.js` (the `result` event), `server/orchestrator.js` (`#onEvent`, `#settle`, `#runAgent`), `server/index.js` (clearing a session), `test/fake-cli/fake-claude.js` (`SUBUSE`, `CUMUL`), `public/js/views/session.js`, `test/usage-accounting.test.js`

## Context

Claude Code's result message has three usage fields that count different things (Agent SDK cost tracking documentation, read on 2026-11-18):

- `usage`: the tokens of the main agent in that turn only. Tokens used by sub-agents (the Task/Agent tool) are not in it.
- `modelUsage` (model name → `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`) and `total_cost_usd`: sub-agents included.
- When a conversation is continued (`--resume`), `modelUsage` and `total_cost_usd` are the totals of the whole conversation so far (from Claude Code 2.1.277; earlier versions report only that call).

Office Crew added `usage` and `total_cost_usd` to each message as they came. So the tokens missed what sub-agents used, and the cost of a continued conversation was counted again on every call. The meeting usage limit, the session and agent totals and today's totals all read these numbers.

## Options

1. Keep `usage` only. Simple, but sub-agent work stays invisible, and the meeting limit undercounts an agent that delegates.
2. Use `modelUsage` and `total_cost_usd` as they come. Sub-agents are counted, but a continued conversation is counted again on every call, more each time.
3. Use `modelUsage` and `total_cost_usd`, and subtract the totals of the same CLI conversation's previous result (a baseline kept next to the conversation id). When the numbers can't be trusted, fall back to `usage` and mark the count as partial.

## Decision

Option 3.

- `claude.js` passes `modelUsage` and `total_cost_usd` along with `usage` in the usage event (`tree`); it does not compute anything. Other providers are unchanged.
- `settleClaude` (a pure function) decides the amount of one result:
  1. No `modelUsage`: `usage` as it is, the cost is `total_cost_usd` minus the baseline's cost (or all of it when there is no baseline or the difference is negative), and the count is partial.
  2. With a baseline: each item is the total minus the baseline.
  3. No baseline: the total itself (the first call of a conversation). But when this call continued a conversation and there is no baseline (an imported conversation, a session from before this change), earlier usage may be in the total: `usage` is used, no cost is added, and the count is partial.
  4. When the difference is smaller than `usage` (or negative), the CLI reports one call and not a total (an older version, or a reset): the total itself is used, or `usage` if that is smaller still; the cost is then `total_cost_usd` too. A negative cost difference also uses `total_cost_usd`.
  5. No item is smaller than `usage`. `sub` = the result's tokens minus `usage`'s tokens (what sub-agents seem to have used, never below 0).
- The orchestrator keeps the baseline per session and agent in `session.usageBase[agentId] = { id, input, output, cacheRead, cacheWrite, cost }`, next to `providerSessions`. `id` is the CLI conversation id that a later call would continue. A call uses the baseline only when it continues exactly that id; a new conversation, another AI, a loop restart or an import therefore never uses it. Within one call, each further result (an extra instruction sent to the same process) is settled against the previous result of that call. A result without `modelUsage` removes the baseline. Clearing a session removes all of them.
- The settled amount is what goes into `message.usage` (with `partial: true` and `sub` when they apply) and into the usage records by provider, day and agent, so the meeting usage limit, the session, agent and today totals all count the same thing.
- On screen, the token count under a message and on an agent's card in the right panel gets a `*` when the count is partial, and the tooltip says that sub-agent usage may be missing, or how many sub-agent tokens are included.

## Consequences

- An agent that delegates to sub-agents now shows and spends more of the meeting usage limit, which is the point.
- Not covered: sub-agent usage of Codex, Gemini CLI and the other providers may still be missing. Messages and records saved before this change are not corrected. The cost is the CLI's own estimate. The first call that continues an imported conversation or a session from before this change counts only the main agent and adds no cost. If the same conversation was continued outside the app, that usage is counted once in the next call. Whether `usage` is never larger than the growth of `modelUsage` in a real CLI was not checked; if it is, rule 4 would count the whole conversation again. This was checked with fake CLIs only, not reproduced with a real Claude Code.
- To undo: settle Claude results with `usage` and `total_cost_usd` again in `#onEvent`. The `usageBase`, `partial` and `sub` fields can stay; older code ignores them.
