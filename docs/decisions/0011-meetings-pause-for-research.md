# 0011: A meeting turn can ask a question, and the team's researcher looks it up once

- Status: Accepted
- Date: 2026-11-17
- Related: [0010](0010-meetings-take-turns.md) (the turns and verdicts this adds a step to; 0010 is otherwise unchanged), [0009](0009-agents-ask-with-a-marked-block.md) (the question uses the same kind of marked block), `server/meeting.js` (`CHECK_MAX`, `parseCheck`, `checkBlock`, `pickResearcher`), `server/orchestrator.js` (`#meeting`, `#meetingPrompt`, `#runAgent`, `recover`), `server/providers/mock.js`, `public/js/chat-tools.js` (`hideCheck`), `public/js/views/session.js`, `test/meeting-research.test.js`

## Revision 2026-11-25: research in a long session's meeting runs once

([0023](0023-prompt-assembly-for-cache-and-fresh-meeting-turns.md)) Outside goal mode, when the meeting runs its turns in new conversations because the session is long, the research turn does too: it gets the question, the request, the earlier stage results and the picked earlier messages, and doesn't continue or change the researcher's session conversation. Research keeps the skill bodies in its system instructions. In a shorter session the researcher still continues its conversation.

## Revision 2026-11-20: fewer research turns when a goal is low on calls

In a goal's work run ([0017](0017-goal-mode-research-and-meeting-first.md)) the research turn runs once in a new conversation like the meeting's other turns, with the research agent's permission set to read-only for that call only (since 2026-11-22; its result also gets the research note's two counts and AI marks, and the following turns see it with a warning when it has an instruction-like line), and when fewer than a quarter of the goal's call cap is left, research during the meeting is turned off: a question is answered "not checked" without a call (`check.status: 'low'`), with one line in the goal's progress log.

## Context

In a meeting (0010) the participants answer from what they know and what has been said. Nobody looks anything up: a turn that depends on a fact nobody in the meeting has (a price, what a file says, whether a source agrees) is answered with a guess, and the chair concludes on it. Many teams have a research agent, but it works only in its own stage.

## Options

1. Let participants use their tools during a turn. Facts could be checked where they are needed, but every turn becomes a long and expensive run, the meeting rule "answer in text only" goes away, and nobody can tell from outside when a turn was research and when it was talk.
2. A participant asks with a marked block at the end of its turn; the team's research agent looks the question up once, and the result goes to the following turns as reference material. Research happens only when someone asks, each question costs one AI call, and the team needs a research agent.
3. Ask the user, as in 0009. The user may not know either, and the meeting waits for a person.

## Decision

Option 2.

- From round 2, a turn prompt tells the participant, only while research is left in this meeting and the team has someone to research, that if it does not know a fact that could change the conclusion it should not guess but end its answer with one fenced block named `oc-check` holding `{"question":"…"}`, and how many researches are left. Opinions, verdicts and the conclusion do not get this.
- `parseCheck` reads the block only when it is the last thing in the turn (the rule of 0009). The question is trimmed and must be text of 1 to 300 characters. The block stays in the message text and its place is kept as `message.check = { question, from, to, status }`; the screen hides that span and shows the question with its status under the turn. What the participant said, without the block, goes to the next turns.
- Researcher: looking at the team's stages in order and at the agents of each stage in order, the first agent whose role is a research role (`roleKind`). The chair is never picked. It can be a participant, the one who asked included, or an agent of another stage.
- The researcher is picked once when the meeting starts. When there is nobody (no research-role agent other than the chair), the turn prompts get no question guidance, as when no research is left; a question that comes anyway is `no-researcher`, and the following turns get "Not checked: this team has nobody to do the research (the chair does not go to research)." with the question instead of a result.
- At most `CHECK_MAX` = 3 researches per meeting; a retry of the stage counts from 3 again. A question after that is `over` and not researched (no AI call), and the following turns get "Not checked: this meeting has no research left." with the question instead of a result.
- A research is one AI call. Stop, pause, "End meeting" and the usage limit are checked first, as before a turn. The researcher is told to look the question up with its tools, give a source (an address or a file) for each fact, write "not checked" for what it could not find, stay within 8 lines and give no opinion or conclusion. The question goes inside random markers, labeled as another participant's text. It is told to only read and search what it needs to find the answer, and not to edit files, install or delete anything, or run commands that change state; it is not told the meeting's "answer in text only", because it needs its tools. A message the user sends while research runs, without picking an agent, is not given to the researcher: it goes to the following turns, as a message sent between turns does. A message sent to the researcher by picking it still goes to it.
- The message is `meeting = { phase: 'research', round, rounds }` with `checkOf` = the id of the turn that asked. While it runs, `stage.meetingNow` is `{ phase: 'research', round, rounds, speakerId: researcher, askedBy, opposerId }`, and every `meetingNow` now carries `opposerId` when there is an opposer. When the research ends, answered or not, `meetingNow` goes back to `{ phase: 'turn', round, rounds, opposerId }` with no speaker before the next turn, so a pause there does not leave "researching" showing.
- Status: `asked`, then `answered`; or `failed` when the research ends in an error, is stopped or skipped, is empty, or cannot start because the meeting ended or the limit was reached. A research that failed, was skipped or was stopped with "End meeting" puts "Not checked: the research did not finish." in its place and the meeting goes on; stopping the run stops the meeting too. A question still `asked` when the app starts again becomes `failed`.
- The result goes into "everything said so far" of the following turns, verdicts and the conclusion, under `### Research results — name`, inside the same markers as other speech with `Question: …` as its first line, cut at the same length. When at least one research answered, the conclusion prompt asks for facts from research results to be listed under the grounds with their sources.
- A block that is there but can't be read (not JSON, no question, too long) is not researched: the block stays in the message as text, the message gets a notice, and what the participant said without the block still goes to the next turns.
- Demo agents (the built-in mock provider): the opposer ends its round-2 turn with one question, and the demo research answers with two facts, "Source: demo data" and one "not checked" line.

## Consequences

- Each researched question is one more AI call: three participants, two rounds and one question make 7 calls (6 under 0010). Questions that are `over`, `no-researcher` or unreadable add no call.
- Only a team with a research-role agent other than the chair can research. The researcher continues the session's CLI conversation like a participant, so research in a long session is expensive.
- The block stays in the message text, so exports and, with project memory on, memory keep it too.
- The researcher's permission level is not lowered. For an agent with edit or run permission, nothing but the instruction in the prompt stops it from changing files or running commands during research.
- The app checks only that the research answer is not empty. Whether the sources exist or say what the answer claims is not checked.
- A research result that holds an `oc-check` or `oc-verdict` block is not read as a question or a verdict: only turn messages are read for questions and only verdict messages for verdicts.
- Checked with fake CLIs in the tests and with the built-in demo agents; not run with real CLIs.
- To undo: drop the guidance from the turn prompt and the research step in `#meeting`. The `check` and `checkOf` fields can stay; older code ignores them and an older screen shows the block as text.
