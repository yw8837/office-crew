# 0021: No demo team; the simulated AI stays for tests and is hidden from the screens

- Status: Accepted
- Date: 2026-11-25
- Related: [0002](0002-no-antigravity-cli.md) (an earlier change to installed data on start), `server/seed.js`, `server/store.js` (`#dropDemo`, `DEMO_TEAM_ID`, `DEMO_AGENT_IDS`), `server/index.js` (role notes of removed agents, provider routes), `server/providers/index.js` (`HIDDEN_PROVIDERS`, `list`, `catalog`), `server/providers/mock.js`, `public/js/main.js` (start page), `test/helpers.js` (`addMockTeam`), `test/demo-removal.test.js`

## Context

The first run created a "Demo team (no usage)" (`team-demo`) with four agents on the built-in simulated AI (`mock`): `demo-researcher`, `demo-organizer`, `demo-analyst` and `demo-builder`. It was the default team for new sessions, the default agent was `demo-researcher`, and the start page's first button started a session with it. The simulated AI answers with fixed text and does no work, so a new session that didn't pick a team ran on canned answers. The simulated AI also showed as an AI in Settings → AI accounts, next to the real ones.

The tests depend on the simulated AI: it runs teams, meetings and goal mode at no usage.

The repository owner decided to remove the demo team from the product and from installed data, and to keep the simulated AI only for tests, out of the lists where people pick or see an AI.

## Options

1. Keep the demo team but stop making it the default. The seed data, start button and translations stay, and the canned answers can still be picked.
2. Stop creating it on new installs only. Existing installs keep a default team that runs canned answers.
3. Stop creating it, remove it from installed data on start, and hide the simulated AI from every list the server gives the screens; keep the provider for tests.
4. Remove the simulated AI as well. Many tests would need a real or fake CLI for every flow they now run at no usage.

## Decision

Option 3.

- **New installs:** no demo team or demo agents. The default team is `team-default` and the default agent its first agent, `researcher`. The start page's "Start with the default team" button is now the first one. It doesn't name a team: the server uses the default team from Settings, and the button says "New session" when that setting is empty or points to a deleted team. `POST /api/sessions` refuses a team id that doesn't exist (as editing a session, schedules and board cards already did), and when the default team in Settings was deleted it makes the session without a team, for the default agent.
- **Installed data**, once, on the first start after the update (`Store.#dropDemo`, after the earlier migrations). It then sets `demoDropped: true` in `settings.json` and doesn't run again, so a `team-demo` or demo agent made later through the API, or put back from a backup, is left alone. The flag is internal: `PUT /api/settings` ignores it.
  - Each of the four demo agents is deleted only while it is still a manual agent on `mock`. One switched to another AI, or to automatic routing (which picks a real AI at run time), stays.
  - `team-demo` is deleted only when every agent in its stages is one of the four demo agents and each of them is deleted now or was already gone; a changed name or stage order doesn't matter. When the user put another agent in it, or it holds a demo agent that stays, the team stays and only loses the deleted agents, like any other team (below). It keeps its name, also the seed name "Demo team (no usage)" in the language of the first run: the name is the user's data, and the team they kept may still be what they use.
  - Deleted agents leave the stages of other teams exactly as `DELETE /api/agents/:id` does: a stage left empty is dropped; a team left with no stage stays, with no stages, and the existing team rule (`cleanTeam`) asks for at least one agent before it can be saved again.
  - Their role notes are renamed to `<id>.removed.json`, as on agent deletion (done in `createApp` after the note store opens, on the start when the removal ran, for any of the four ids that no longer exists).
  - If `defaultTeamId` is `team-demo` and that team was deleted, it becomes `team-default`, else the first remaining team, else none (a kept Demo team stays the default). If `defaultAgentId` is a deleted demo agent, it becomes the first existing agent of the default team, else the first remaining agent.
  - Sessions run with the demo team stay as records, unchanged. They behave like any session whose team was deleted: they open as before, a new message goes to the default agent alone, and goal mode is refused.
  - Schedules and board cards that picked the demo team or a deleted agent are left as they are; they already report that the team or agent is gone when they run.
- **The simulated AI:** it stays in `PROVIDERS`, so an agent with `provider: 'mock'` can still be saved through the API, imported and run (the tests make theirs with `addMockTeam`). `HIDDEN_PROVIDERS` takes it out of `ProviderRegistry.list()` (the bootstrap data, `GET /api/providers`, the `providers` event, the schedule budget check) and so out of `catalog()` (the routing catalog and model lists, automatic routing, handing work to another AI). `GET /api/providers/mock/models` and `POST /api/providers/mock/refresh` answer 404. The screens' own filters on the provider list are gone; filters on agents that use `mock` stay, because such an agent can still exist. Usage records still keep `mock` (old demo runs and test agents); the Usage page leaves it out of today's list and the per-AI totals, and names an agent that no longer exists "Deleted agent" in the per-agent totals.

## Consequences

- There is no zero-usage way to try the app from the screens; trying it needs a connected AI.
- Not covered: the screens have no way to make a simulated agent, and one made through the API or a plugin still shows the "Demo" provider label on its chips. Schedules and board cards are not moved to another team. Older decision records and changelog entries keep their mentions of the demo team as history. The README pictures were not re-recorded.
- Not covered: a Demo team that stays keeps the "(no usage)" name although it now runs on a real AI; the user renames it.
- Undo: put the seed entries and the start button back. Deleted demo agents and the demo team are not restored on downgrade. They come back from a backup of `agents.json`, `teams.json` and the `notes` folder put back while the current `settings.json` stays, since it records that the removal ran. Putting back the whole data folder from before the update, `settings.json` included, runs the removal again on the next start.
