# 0010: Meetings take turns, and the chair judges after each round

- Status: Accepted
- Date: 2026-11-17
- Related: [0005](0005-meeting-stage.md) (this record replaces its flow: what happens from round 2 and what the chair is given; 0005 is otherwise unchanged), [0009](0009-agents-ask-with-a-marked-block.md) (the verdict uses the same kind of marked block), `server/meeting.js`, `server/orchestrator.js` (`#meeting`, `#meetingPrompt`), `public/js/views/session.js`, `public/js/views/manage.js`, `test/meeting.test.js`, `test/meeting-turns.test.js`

## Context

In decision 0005, every participant reviewed the others' opinions at the same time from round 2. Nobody answered anybody: each review was written before the other reviews of that round existed, so a meeting was parallel monologues rather than a conversation. A meeting also ran all its rounds even when everyone already agreed, and nobody was given the job of looking for weaknesses.

## Options

1. Keep the simultaneous reviews of 0005. Fast (a round runs in parallel) and predictable, but there are no replies and no early end.
2. Turns and a verdict: round 1 as before; from round 2 the participants other than the chair speak one at a time, each seeing everything said so far, with one of them as the opposer; after each round of turns the chair judges whether there is agreement, and agreement skips the remaining rounds. Replies are real and a meeting can end early, but turns run one after another and each verdict is one more AI call.
3. Let a model pick the next speaker each time. Closest to a real discussion, but the order and the number of calls can't be predicted or tested, and a weak pick can bounce between two participants.

## Decision

Option 2.

- Data format: `Team.stages[].meeting` gains `opposeId` (string or `null`). It is kept only when it is a participant and not the chair; otherwise it is `null` and the opposer is picked when the run starts: the first participant (team order, chair excluded) whose AI differs from the chair's, else the last participant other than the chair. `normMeeting` applies this when a team is saved, installed or run, so teams saved earlier get `null`.
- Round 1 is unchanged: everyone writes at once without seeing the others.
- Rounds 2 to `rounds`: the participants other than the chair speak one at a time, in team order with the opposer last. Each gets everything said in this meeting so far (round-1 opinions and earlier turns, its own included), grouped by round, wrapped in random markers and labeled as reference material, and answers in about 300 characters: which point it answers, its own point, and its position in one line (with what changed it, if it changed). The opposer is also told to find the weaknesses, gaps and failure conditions of the option gaining the most support, without making things up. A turn that ends in an error, is stopped or skipped, or is empty is left out, and the next participant speaks. Stop, "End meeting", pause and the usage limit are checked before every turn and every verdict.
- Verdict: after a round of turns in which someone spoke, except the last round, the chair answers once, ending with a fenced block named `oc-verdict` that holds `{"verdict":"agree"|"continue","reason":"…"}`. It counts only as the last thing in the answer (the rule of 0009). `agree` ends the turns; `continue`, no block, an error or a stop moves on to the next round. A block that was read is removed from the text and kept as `message.verdict = { verdict, reason }`. A block that is there but can't be read counts as `continue`, stays in the text, and the message gets a notice. A round in which nobody spoke goes to the conclusion without a verdict.
- Conclusion: the chair writes it as before, from everything said, with one more line: options dropped and why.
- Messages: `message.meeting.phase` is `opinion`, `turn`, `judge` or `conclude`, and a turn by the opposer has `opposer: true`. `review` is no longer written; older messages with it still show as "Review r/n". `stage.meetingNow` has `speakerId` during a turn.
- 0005's early end "only one opinion came in" is dropped: the turns run even if round 1 produced a single opinion.

## Consequences

- AI calls for N participants: N opinions, N − 1 turns per round of turns, one verdict after each round of turns except the last, and one conclusion. Three agents and two rounds make 6 calls (7 under 0005); three rounds make 9, or 7 when the chair finds agreement after round 2.
- Turns run one after another, so a meeting takes longer than with simultaneous reviews.
- Agreement is the chair's judgment. The code reads only the verdict block; it does not compare the participants' positions.
- Participants still continue the session's CLI conversation, as in 0005, so each turn is expensive in a long session. Running meeting turns as separate short conversations is not done here.
- Research during a meeting, asking the user from a verdict, and a limit on the number of participants are not part of this change.
- When a plugin bundle installs a team, the opposer is not mapped to the new agent ids and falls back to automatic.
- Checked with fake CLIs in the tests and with the built-in demo agents; not run with real CLIs.
- To undo: bring back the 0005 flow in `#meeting`; the `opposeId` and `verdict` fields can stay, older code ignores them.
