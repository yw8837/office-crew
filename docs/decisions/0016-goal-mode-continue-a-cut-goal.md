# 0016: A goal cut off by closing the app continues from where it stopped, only when the user asks

- Status: Accepted
- Date: 2026-11-20
- Related: [0014](0014-goal-mode-confirmed-goal-card.md) (the goal card, the restart rule), [0015](0015-goal-mode-fresh-review.md) (the criteria check, returns, the waits and the call cap), [0012](0012-claude-usage-counts-the-whole-tree.md) (usage baseline), [0013](0013-agents-keep-role-notes.md) (role-note hash), `server/mission.js` (`sameStages`, `resumePoint`, `pastOutputs`, `cutMission`), `server/orchestrator.js` (`resumeMission`, `confirmMission`, `#start`, `#missionRun`, `#missionWork`, `#missionAt`, `#capCheck`, `#missionAsk`, `#reviewStage`, `#stagePrev`, `#prompt`, `recover`, `send`), `server/index.js` (`POST /api/sessions/:id/mission/resume`), `public/js/views/mission.js` (`CutBox`, `resumeFrom`), `public/js/views/session.js`, `test/mission-resume.test.js`

## Context

Office Crew starts the CLIs itself, so when the app closes while a goal runs, the run is gone. Since 0014 such a goal turns `cut` at the next start and can only be discarded: the user sends the request again, and every stage, and the calls they cost, start over even when most of the work was done. Continuing needs to know where the run was, what the earlier stages produced, and what to do with the CLI conversation that was cut in the middle of a turn.

## Options

1. Start again automatically at the next start. The user may not want it (they closed the app for a reason), and it can spend calls with nobody watching.
2. Continue from the start of the run, keeping the goal. Simple, but repeats every stage.
3. Record the point in the run as it moves, and on the user's request start a new run at that point, gathering the earlier stages' answers from the session.

## Decision

Option 3.

- **The cut point** (`mission.at = { stageIndex, phase: 'work'|'review', back, working, wait }`): the goal's work run writes it, and saves the session at once, when a stage starts (`working`: that stage's agents; for a return, the one agent who redoes a meeting stage), when a work stage ends (the next point: the next work stage, or the criteria check after the last work stage or after a return), when the criteria check starts, when a return is decided (before its pause or cap check), and when it starts waiting (`wait: { reason: 'mission', kind: 'verdict'|'notes' }` after a verdict, `{ reason: 'cap' }` at the call cap). Confirming writes the first point (stage 1, nobody working) and the team stage numbers the user kept (`mission.keep`). A restart turns the goal `cut` as before and leaves `at` as it was.
- **Only on request**: nothing starts at app start. `POST /api/sessions/:id/mission/resume { missionId }` continues; the card's cut notice, the progress tab and the box above the message field show **Continue** (main button) and **Discard**, with one line saying where it starts again.
- **When it is refused**: 409 for another goal's id, a goal that isn't `cut` (discarded, ended, already continuing), a run going in the session, a missing request message, a goal without a cut point or kept stages (cut before this record), and a team that changed: the stage list rebuilt from the current team with the kept stages (`#missionPlan`) must have the same number of stages, labels, agents in the same order, approval gates, meeting or not, and criteria check position as the cut run (the check's own label is not compared, it is named in the app language), and the same reviewer. 400 when the team check of 0014 fails now (a model on this PC mixed with cloud AIs). The goal stays `cut` after a refusal.
- **The new run** (`resumed: true`) starts at the cut point. Earlier stages don't run again; their results are gathered from this goal's earlier work runs (`pastOutputs`): for each stage and agent, the latest finished answer (for a meeting stage, the latest conclusion or the lead's lone fix on a return), without review answers, goal drafts and handoff notes. A stage with nothing found gets an empty result and the log says how many weren't found. Earlier stages show as they ended (done or skipped).
- **Where it starts**: a work stage → that stage, then the rest as usual; a return → the same return again, with the failed criteria block and the stage's previous result, without counting another return; the criteria check → the check again, counted as the same round (`round` counts finished checks); a verdict or notes question → the same question again with no AI call (the verdict is the stored one); the call cap → the same cap question before that stage with no AI call.
- **Agents cut mid-turn start fresh**: before the run starts, the agents in `working` of a work stage lose this session's `providerSessions`, `sessionProvider`, `usageBase` and `noteHashes` entries, so they start a new CLI conversation (the earlier conversation comes back as `[Previous conversation]`, as for any agent without one). Their prompt for that stage, and no later stage, begins with one code-written line: "[Continuing] This stage was cut off midway because the app closed. First check whether the work folder already has work done for it, and if so, continue from there." The reviewer of a cut criteria check is left alone: the check never reads or writes its conversation (0015). Other agents keep their conversations.
- **Carried over**: calls (`calls.used`, `cap`), `returns`, `returnCap`, `round`, criteria verdicts, and notes already used (they keep going into later stages; unused ones are asked about as before). The log gets a `resume` line ("Continued: from stage X", the return or the question), the agents who start fresh, and how many earlier results were gathered. A goal can be continued again if it is cut again.

## Consequences

- A cut goal costs only the stage that was cut (or nothing, at a question) instead of the whole run again. The session file is written a few more times per goal run (each stage start and end, each wait).
- Not covered: what a cut CLI left half done (a half-written file, a command that didn't finish) is not detected; the agent is told to look at the work folder and decide. Approval and error waits are not kept as waits: a cut there runs that stage again (fresh) instead of asking again.
- Not covered: the usage of a cut call isn't counted (the CLI never reported it), and a call started in the last fraction of a second before the cut may be missing from the call count.
- Not covered: a goal cut while the lead was drafting the card is still closed (there is no draft); the request has to be sent again. A goal cut before this change has no cut point and can only be discarded.
- Not covered: the team check compares the stage list only; a changed instruction or meeting setting is used as it is now. How real CLIs pick up the work from the folder is not measured; the tests use fake CLIs only.
- Screens checked in a real browser: [to be filled in after the browser check]
- To undo: drop the resume route and `CutBox`'s Continue button; `mission.at` and `mission.keep` are then unused and harmless.
