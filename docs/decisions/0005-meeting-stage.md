# 0005: A team stage can be a meeting with fixed rounds and a chair

- Status: Accepted
- Date: 2026-11-11
- Related: `server/orchestrator.js` (`#meeting`), `test/meeting.test.js`

## Revision 2026-11-11: what the usage limit counts

The first real run (three agents on Claude and Codex, two rounds, in a session with a long conversation) showed the limit was counting the wrong thing. It added up input and output tokens only. Claude reports newly read text mostly as cache writes, so an Opus turn that read 177,613 new tokens counted as 1,082, while a Codex turn, which reports the whole resumed conversation as input, counted as 241,992.

- The limit now counts input + cache writes + output, plus one tenth of cache reads (`meetingSpend`). It puts the CLIs on one scale; it is not the price list.
- By that count the real meeting used about 817,000 tokens (468,565 in round 1), so the default limit is raised from 300,000 to 1,000,000. Teams saved earlier keep the number they were saved with.
- The notice shown when rounds are skipped now says how much was used.
- The meeting itself worked with real AIs: three opinions, three reviews in which positions changed, one conclusion that kept the remaining disagreement, and the next stage worked from the conclusion. One run is not a measurement of quality.

## Context

A team stage could hold several agents, but they only worked side by side: each saw the request and the earlier stages, never each other. There was no way for agents to disagree, check each other, and settle on one answer before the next stage started. The request was for agents that discuss and then keep the work moving on their own.

Open-ended agent-to-agent chat is hard to stop and hard to budget. Public multi-agent projects that report stable results keep the exchange in fixed steps: independent proposals first, then criticism, then one party writes the result.

## Options

1. Free discussion: any agent may call any other when it wants. Natural, but there is no clear end, and usage can't be predicted.
2. A meeting as a kind of stage, with a set number of rounds and one chair who writes the conclusion.
3. Leave stages as they are and ask users to add a separate "summarize" stage by hand.

## Decision

Option 2. The stage data format gains one optional field.

- `Team.stages[].meeting` is `null` or `{ rounds, chairId, tokenCap }`. It is kept only when the stage has two or more agents. `rounds` is 1 to 3 (default 2), `chairId` is one of the stage's agents (default the first), `tokenCap` is in tokens (default 1,000,000, see the revision above; 0 means no limit). A missing or non-numeric value gets the default. One function (`normMeeting`) applies these rules when a team is saved, when a plugin bundle installs a team, and when a run starts. Teams saved before this change have no field and run as before.
- Round 1: every participant writes at the same time without seeing the others (claim, reasons, what would prove it wrong, confidence).
- Round 2 and later: every participant gets the others' previous-round text (at most 1,500 characters each; text that was cut off mid-writing is marked as cut off), wrapped in random markers and labeled as reference material, and writes a review (most convincing point, weakest assumption, what to change in their own view, their position now).
- Then the chair gets every round and writes the conclusion: pick one, combine, drop all, or a new proposal; why; remaining disagreement; next steps.
- Only the conclusion is passed to the next stage.
- The meeting ends early when the usage limit is reached (checked before each round after the first), when only one opinion came in, or when the user presses "End meeting" (also while paused between rounds); in each case the chair concludes from what exists. If no opinion came in at all, the stage shows the usual error choices instead of a conclusion. Stop ends the run without a conclusion.
- Results of earlier stages go into round 1. A participant whose CLI conversation carries on from its own earlier turn in this meeting does not get them again; one that can't carry on (an AI without resume, a takeover by another AI, a failed resume) gets them again on every turn.
- A change request or retry text is put into every turn of the next attempt, the conclusion included.
- Participants are told not to edit files or run commands during a meeting. This is an instruction, not an enforced limit: each agent keeps its own permission setting.

## Consequences

- A meeting of N agents with R rounds normally makes N × R + 1 AI calls. Three agents and two rounds is seven calls for one stage. An empty answer that is asked again, a takeover after a usage limit, or an added instruction adds calls.
- The usage limit counts what the CLI reported for the messages of the current attempt (see the revision above for what is counted). It is checked between rounds, so one round can go over it, and the conclusion always runs on top of it.
- If the chair's conclusion fails, the stage shows the usual error choices, and "retry" runs the whole meeting again.
- Differences of opinion are settled by the chair's write-up, not by a vote.
- Checked with fake CLIs in the tests, with the built-in mock provider in the app, and with one real run on Claude and Codex. The quality of real discussions is not measured.
- Not handled yet: "End meeting" doesn't interrupt a participant that is still being routed or prepared; an instruction queued for a turn that was cut off can run after the conclusion; on a retry, an AI that resumes its conversation still remembers what it read in the previous attempt, so round 1 is not blind for it.
- In the office picture, participants gather at the meeting spot (the plaza in the village skins, the meeting room in the office skin) while the meeting runs; they leave it while the stage waits for approval.
