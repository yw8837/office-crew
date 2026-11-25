# 0020: The split view shows a flow stage above the chat; the village stays in the Large office view

- Status: Accepted
- Date: 2026-11-25
- Related: [0009](0009-agents-ask-with-a-marked-block.md) (agent questions), [0010](0010-meetings-take-turns.md) and [0011](0011-meetings-pause-for-research.md) (meeting turns and research), [0014](0014-goal-mode-confirmed-goal-card.md) to [0019](0019-goal-mode-call-estimate-and-limit-wait.md) (goal mode: the card, the criteria check and returns, cut goals, task cards, the call cap and the usage-limit wait), `public/js/stage-model.js` (`stageModel`, `openQuestions`, `requestOf`, `meetLabel`, `goalWait`), `public/js/views/stage.js` (`FlowStage`, `StageStrip`), `public/css/stage.css`, `public/js/views/session.js` (`OfficePanel`, `VillagePanel`, `RunBar`, `SessionView`), `test/stage-model.test.js`

## Context

The picture above the chat was the village (or an office skin) in every view. It showed where each agent was, but not the order of the stages, how far the run had got, or where it waited for the user; that was in the stage strip of the bar below the chat, a long way from the picture. Much of what a run actually does had no place in the picture: a return after a failed criterion, the criteria verdicts, the call count, a goal card waiting to be confirmed, a goal cut off by closing the app, an automatic continue after a usage limit. And at the default height of the split view the characters were small.

## Options

1. Keep the village and tidy its labels, motion and colors. A small change, but the order of the stages stays out of the picture.
2. A flow stage: the stages as stations from left to right, the work card next to whoever holds it, a gate on the line where the run waits for the user, and the bar's stage strip moved into it. A larger change; the village's story is lost in the split view.
3. A thin strip only. The most room for the chat, but meetings and parallel work shrink to small marks.

## Decision

Option 2 for the split view, the folded shape of option 3 for the chat-only view, and the village kept as it is in the Large office view.

- **Views.** Split: the flow stage, 156 px by default; the handle resizes it from 120 to 240 px, and under 140 px it takes a small shape (names and the meeting line hidden, the top line shortened). The height is kept in `ui.stageH`, apart from the village's `ui.officeH`. Chat only: a 30 px strip with a segment per stage, the current stage, the "your turn" pill and a Show button. Large office: unchanged, the village or an office skin with the stage strip in the bar below. The flow stage is not a skin; the skin setting and its default (`village`) don't change, and `watch.js` doesn't change.
- **The bar below the chat.** In the split and chat-only views it keeps pause or resume, stop and end meeting, and the memory badge and session usage it already had; the stage strip and the finished chip move to the stage or the strip. In the Large office view it is unchanged.
- **One DOM-free model** (`stageModel`) built from the session's latest run, the live agent states, the goal, the open questions and the team, and nothing else:
  - Stations are the run's stages (so research, the pre-work meeting, the plan, task card steps and the criteria check appear as stations when the run has them). With no run, the team's stages as to-do; with no team, one station for the session's agent; while a goal card waits to be confirmed, the team's stages as to-do, since nothing has started.
  - A station's state comes from the stage status (to do, working, done, waiting, error, skipped, stopped); a stage waiting at a goal's verdict or usage limit shows as waiting (as the bar's stage strip did), and the stopped stage of a cut goal as cut.
  - People's states are drawn only on the current station and on the station a wait refers to, so the state of an earlier run doesn't linger. The work card is held by everyone of the current station while it works or waits (the chair in a meeting), also by someone who finished first in a parallel stage until the stage ends.
  - A meeting comes from the stage's `meetingNow`: the round and phase, the chair, the opposer, who speaks (everyone in the opinion round), and an empty seat while a participant researches; the speaker's latest text is shown as text. The criteria check station shows a chip per confirmed criterion (checking while it runs). A return shows "Return n/cap" on the stage that redoes the work. A stage note from the server (such as people skipped) is the station's tag.
  - At most four people per station, then "+n"; more than six stations fold the earlier ones, keeping one before the current station.
- **Your turn.** The pill (top right, and in the strip) and a yellow gate on the line, by kind: an approval after its stage; a goal verdict, unused extra instructions, a block or a card retry limit after the check station; the call cap before the stage it stopped in front of (the run stops before starting that stage, so a gate after it would say the stage ran); an error, a usage limit and an agent's question inside the station; the goal card in front of the first station; a cut goal dashes the whole stage; a paused run is a pill only. A usage-limit wait whose automatic continue was chosen is not the user's turn: it shows an hourglass and the time instead. The gate and the pill's button scroll the chat to the box where the user answers (the approval, error or goal box in the chat, the question box above the message field, the cut notice) and focus its first choice; if that box isn't on screen a notice says so.
- **The top line**: the confirmed goal (or the request that started the run), the criteria passed and the calls used against the cap, and either the pill or the latest activity: the agent whose state changed last among those working, with the detail the server sent.
- **Motion**: only the work card flying from one station to the next when the current stage changes (backwards and red for a return), under one second, and the pulse of the your-turn marks (once every 1.6 seconds). With reduced motion (the app setting or the system) both stop; the flight is also skipped in a hidden tab. No celebration, no sound.
- **Reading it**: every state has its own shape and icon as well as a color (circle, diamond, triangle, square, dashed ring); the stage is a named group, the pill a status, people and gates are buttons with names, and the colors are mixed only from the app's theme variables, so the light and dark themes both apply. Stage names, agent names, the goal and what agents said go in as text.

No data format, server or API change.

## Consequences

- In the split view the user sees in one row how far the work has got, who holds it, and where it waits for them, and can jump from there to the answer. At the default heights the chat keeps more of the window than with the village (at least 180 px) and the bar's stage strip together.
- Not covered: only the latest run of the session is drawn; an `@name` run while a goal card is open shows that run (the card's pill stays).
- Not covered: the split view has no meeting-conclusion board, no sub-agent helpers and no row of agent chips (the people on the stage open the agent's panel instead); those stay in the Large office view.
- Not covered: the latest-activity line names one agent even when several work; the time left of a usage limit is recounted every 30 seconds; a hand-over between two people inside the same stage isn't animated.
- Not covered: the model is tested without a browser (scenes, and four runs on the fake CLI: a stage list, an approval wait, a goal card and verdict wait, a usage-limit wait); the drawing was rendered in Node into a minimal stand-in DOM to find runtime errors, which says nothing about layout or colors.
- To undo: in `session.js`, let `OfficePanel` draw `VillagePanel` for the split view too (with `full` only in the Large office view), put back the "Show the office" bar for the chat-only view, and pass `stages` to `RunBar` in every view; then remove `stage-model.js` (move `meetLabel` and `goalWait` back), `views/stage.js` and `stage.css`. No stored data depends on the stage.
- Screens checked in a real browser: [to be filled in after the browser check]
