# 0009: An agent asks the user by writing a marked block in its answer

- Status: Accepted
- Date: 2026-11-15
- Related: `server/ask.js`, `server/orchestrator.js` (`#ask`, the ask loop in `#runAgent`, `control` action `answer`), `server/store.js` (`attentionOf`), `public/js/views/session.js` (`AskPanel`), `public/js/chat-tools.js` (`hideAsks`), `test/agent-asks.test.js`

## Revision 2026-11-26: a meeting's chair can ask through the same box

([0028](0028-stalled-meetings-and-asking-the-user.md)) Meeting turns still don't get the "how to ask" lines and an `oc-ask` block in a meeting is still not read. The chair can ask instead with `verdict: "ask"` and one question with 2 to 4 choices inside its `oc-verdict` block, in a verdict or instead of its conclusion (then the conclusion is written once more after the answer); the code checks it with the cleaning of `parseAsk` and shows it in this box (numbered choices, typed answer, skip) on the chair's verdict message, at most 2 times per meeting, under the conditions above (the setting, no scheduled run, no handoff note, no session override). The answer is stored as a decision the user made, not sent back to the chair's conversation. A goal cut while such a question waits asks it again when continued.

## Context

A run could wait for a person in three cases only: a pause, an error, and a stage that needs approval. An agent that could not decide something by itself had two choices: guess, or write a question as plain text and end. The user then had to notice the question in a long answer and type a reply as a new request. Every CLI the app runs has its own way to ask (a question tool, a permission prompt), and those differ between CLIs and between versions.

## Options

1. Catch each CLI's own question tool (for Claude Code, a permission prompt tool over its control protocol). The agent keeps its context while it waits. It works for one CLI only, needs the process kept open with a different run mode, and has to follow each CLI's changes.
2. Give agents a question tool through an MCP server the app runs. The agent keeps its context. The process has to stay alive until the user answers, tool calls have time limits that differ by CLI, and CLIs without MCP get nothing.
3. Agree on a text format: the agent writes one marked block at the end of its answer and stops; the app shows it as a card, and sends the user's answer as the next turn of the same CLI conversation. It works with every CLI and with the app's run-once model. Each question costs one more AI call, and a model can get the format wrong.

## Decision

Option 3.

- The system prompt tells the agent when it may ask (only what the user alone can decide and it cannot find in the files or the conversation) and the format: a fenced block named `oc-ask` holding JSON, `{"questions":[{"header","question","options":[{"label","description"}],"multi"}]}`, as the last thing in the answer.
- `parseAsk` reads such a block only when it is the last thing in the text written since the previous question, so a block quoted as an example or followed by more text is not a question. Its position in the message is stored with the question (`from`, `to`), and the screen hides exactly that span. It keeps at most 4 questions and 6 choices per question and cuts long text. A block that is not JSON, has no question, or has a question with fewer than 2 choices is not a question: it stays in the answer as text, with a notice.
- A valid question is stored on the message (`asks`: id, questions, status `open`, `answered`, `skipped` or `cancelled`) and on the run (`asks`) while it waits. The run stays `running`, so other agents of the same stage keep working. The session's waiting kind is `ask`.
- `POST /api/sessions/:id/control` with `action: "answer"`, `askId`, and `answers` (`[{ picked: [choice numbers], other: "typed text" }]`) or `skip: true` ends the wait. Every question needs a pick or typed text. A second answer to the same question is refused.
- The question and the answer are added to the message as quoted lines, so exports, project memory and other agents see the question with its answer. The agent then gets the answer as the next turn: by resuming its CLI conversation when the CLI can, otherwise with the request and its own answer so far.
- At most 3 cards each time an agent runs (a retry or a later stage counts again from 0). While a question waits, the finished process's handle is replaced with an empty one, so stopping hours later does not act on a process id that may have been reused; an extra instruction sent meanwhile is kept and handled after the answer. Agents are not told how to ask, and blocks are not turned into cards, in scheduled runs, meeting turns, handoff notes, the criteria check of a goal ([0015](0015-goal-mode-fresh-review.md); an `oc-ask` block there makes the verdict unreadable instead), sessions the app runs by itself (skill description translation), or when the `agentAsks` setting is off.
- Stopping the run or skipping the agent cancels its open question. A question that is open when the app closes is cancelled at the next start, because the run it belonged to is stopped.

## Consequences

- The question is shown in a box above the message box, not inside the reply: one question at a time, numbered choices that answer with one click or a number key, a line for a typed answer, skip, and collapse. Number keys are ignored while the user types in a text field or another dialog is open.
- No CLI's question tool or permission prompt is touched, and nothing about how CLIs are started changes.
- The choices and the question text come from the agent, so they are shown as text only. The text the user types goes to the agent as the user's own words.
- An agent could write a block that looks like a question to make the run wait. That is limited to 3 per task, the user can skip or stop, and scheduled runs never wait.
- What the user types as an answer becomes part of the agent's reply. For a local-model agent in a team, that reply (with the typed answer) goes to the next stage like any stage result; decision 0007 keeps the user's own messages away from cloud AIs and does not cover stage results.
- After an answer, the continued run retries once in a new conversation if the CLI conversation is gone, but does not hand over to another AI on a usage limit.
- Not covered: phone notifications and the board do not know about a waiting question; tool approval ("allow once / always / deny") is a different thing and still follows each agent's permission setting; a message sent while a question waits is queued and does not answer it; how reliably real CLIs follow the format is not measured.
