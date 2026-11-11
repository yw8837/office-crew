# 0006: A hire request in the chat becomes a proposal the user approves

- Status: Accepted
- Date: 2026-11-11
- Related: `server/hire.js`, `server/orchestrator.js` (`#propose`, `sendProposed`), `test/hire.test.js`

## Context

Typing "hire another research agent" in a session only made the running CLI start a helper of its own. That helper was not an Office Crew agent: it did not show up in the agent list, could not be configured, and was gone after the run. Making a real agent meant leaving the conversation for the Agents page and then the Teams page.

## Options

1. Let an AI decide that a message is a hire request and create the agent. Costs a call on every message, and an agent with file or command permission could appear without the user choosing it.
2. Recognize the request with word rules and create the agent at once.
3. Recognize the request with word rules and show a proposal that the user approves, edits, cancels or overrides.

## Decision

Option 3.

- Recognition uses word rules for Korean, English, Chinese and Japanese and no AI. A message counts only if it is one line of at most 80 characters, ends with a hiring phrase (in English: starts with one and ends with the person or agent word), and names a person, an agent or a head count. Weaker verbs such as "add" or "make" count only right after the agent word or a head count. It runs only for messages a person sends from the chat without an @mention or attachment. Scheduled tasks and board cards are never turned into proposals.
- A recognized message starts no run. Two messages are stored: the user's message, marked `hire: true`, and a new kind of message, `{ role: 'proposal', kind: 'hire', status, request, userMessageId, draft: { name, role, baseId }, target: { teamId, stageId } | null }`, with empty `text`.
- The draft copies an existing agent: the first agent with the same kind of role in the session's team, else any agent with that role, else the session's first agent. Model, effort, permission, instructions, skills and connectors are copied; the avatar and the plugin mark are not. The card shows the copied model and permission.
- `POST /api/sessions/:id/proposals/:mid` resolves an open proposal once: `accept` creates the agent and, if chosen, appends it to the target stage; `dismiss` does nothing else; `send` starts a run from the stored user message instead.
- Messages marked `hire` and proposal messages are left out of the conversation text passed to agents. `send` removes the mark.

This adds a message role to the session data format. Earlier versions do not know `role: 'proposal'`.

## Consequences

- Word rules miss requests phrased another way and can still catch a short sentence that fits the pattern without meaning it. The card's "Not a hire — send it as it is" covers the second case; the first is covered by the Agents page.
- One agent per request. "Hire 2" proposes one.
- While a run is in progress, a message sent with the default "interrupt now" mode goes to the working agent and is not turned into a proposal.
- Adding the agent to a stage changes that team for every session that uses it. A stage holds at most 8 agents; when it is full, or the team was deleted in the meantime, the agent is created and the card says why it was not added.
- Changing the role on the card does not change which stage is offered.
- Opening a session that contains a proposal in a version older than this one is not handled.
