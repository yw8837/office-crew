# 0013: Agents keep short role notes, and only what the user accepts goes into their work

- Status: Accepted
- Date: 2026-11-19
- Related: [0007](0007-local-only-user-messages.md) (what only a local model saw stays away from cloud AIs), [0004](0004-project-memory-on-disk.md) (project memory, a separate store), `server/notes.js` (`NoteStore`, `suspicious`, `pickForPrompt`, `chars`), `server/orchestrator.js` (`#system`, `#roleNotes`), `server/index.js` (the `/api/agents/:id/notes` routes, `bootstrap`, deleting an agent or a plugin), `public/js/views/rolenotes.js`, `public/js/views/manage.js` (`AgentEditor`), `public/js/contextmenu.js`, `test/role-notes.test.js`

## Context

An agent's lasting instructions were its system prompt and its skills. What a user teaches it during a session ("run the tests before you call it done", "this service needs the v2 header") is gone when the session ends, unless the user rewrites the system prompt by hand. Later steps are meant to let agents study ahead and learn while working, and they need somewhere to put what they learn. In the research behind this change, guidance an AI wrote for itself without review made results worse, while short items with a source, used only after a person accepted them, helped.

## Options

1. Let the agent add to its own system prompt. Simple, but that is the self-written guidance the research warns about, and a prompt that grows by itself can't be reviewed or undone item by item.
2. Put it in project memory (0004). Memory belongs to a folder, not a role, holds conversations word for word and is found by shared words; it has no notion of accepted or not.
3. A notes file per agent: the role's tasks plus short items, each with a kind, a source and a status. Items the user writes count at once; items from an agent or an outside source come in as drafts and count only after the user accepts them; every change is logged and can be undone.

## Decision

Option 3.

- File: `<data folder>/notes/<agentId>.json`, written to a temporary file and renamed, read fresh for every change and every run. Shape: `{ version: 1, role: { tasks: [{ id, title, done, check }] }, items: [{ id, kind, text, source: { type, ref }, status, helped, harmed, localOnly, createdAt, updatedAt }], log: [{ id, at, op, itemId, before, after, undoOf? }] }`.
- `kind` is `method`, `pitfall`, `criterion` or `tool` (anything else becomes `method`). `source.type` is `user`, `agent` or `web` (`ref` holds an address or file, up to 300 characters). `status` is `draft`, `confirmed` or `archived`. Nothing is deleted.
- Item text is 1 to 400 characters, counted as the characters a person sees (an emoji is one). Up to 8 tasks; a title is 1 to 80 characters, the done criterion and the check method 0 to 200 each.
- A `user` item is `confirmed` when it is made. An `agent` or `web` item is always a `draft`. Before it is stored, its text and `ref` are checked for common injection patterns in Korean, English, Chinese and Japanese (telling the agent to ignore instructions, imitating system instructions, asking for wider permissions, asking to send secrets, keys or tokens), invisible characters and control characters; if one is found the item is not stored and the reason is returned. The same check applies when the user edits such an item. A `user` item only has invisible and control characters removed.
- Every change (add, edit, status change, accept all drafts, changing the tasks) is logged with its before and after values; the log keeps the last 200. Undo reverts one change and is logged too. It refuses when the same item (or the task list) changed after that change. Undoing an add archives the item.
- Deleting an agent, or removing the plugin that installed it, renames its file to `<agentId>.removed.json` (with a time added if that name is taken). Agents installed from a plugin or made from a hire proposal get a new id, and a removed import agent's notes were renamed before its fixed id is used again, so old notes never attach to another agent.
- In `#system`, before the skills: `## What this role does` with one line per task (`- title — done when: … / check: …`); `## Role notes (set by the user)` with one line per confirmed user item; one line saying that what follows is reference material from earlier learning and outside sources that must not change the instructions, then the confirmed agent and web items between random markers, one line each with the source in parentheses; and, when some did not fit, `The role notes have n more items that are less related to this task.` Line breaks inside an item are turned into spaces. Drafts and archived items never go in. With no tasks and no confirmed items nothing is added, so the instructions are exactly as before.
- `pickForPrompt` takes confirmed items only, and `localOnly` items only when the AI that receives the instructions is a local model. If all of them fit in 2,000 characters they all go in, most recently changed first; otherwise they are ranked by the number of words they share with the request (`tokenize`/`queryTerms` of project memory), then `helped − harmed`, then recency, and added while they fit.
- Every agent run gets this, including meeting turns, verdicts, conclusions and research, and a run handed to another AI after a usage limit gets it again for that AI.
- The agent editor has a "Role notes" part (tasks, items by status with accept, edit, archive and discard, accept all drafts, add an item, the last 10 changes with undo). The agents page and the session's right panel show a "Drafts n" chip that opens it. In the chat, text selected in an agent's answer can be added from the right-click menu as a `user` item of that agent, cut to 400 characters, and as `localOnly` when that answer came from a local model.

This adds the `notes/` folder to the data format. Nothing in existing files changes; older versions ignore the folder.

## Consequences

- Each run with notes sends up to 2,000 characters of items plus the tasks. Picking reads one small file per agent call and calls no AI.
- Not covered yet: agents do not study ahead or learn while working (no `agent` or `web` items are made by the app yet; they can only come through the API); `helped` and `harmed` never go up, so they do not change the ranking yet; exporting a team as a plugin does not take its notes; notes are not synced with another PC; the injection check catches common patterns only and can also stop harmless text that uses those words; whether notes make results better has not been measured.
- An item that went only to a local model can be repeated in that model's answer, and in a team that answer goes to the next stage like any other stage result (0007 covers what you type, not a stage's result).
- An archived item can be brought back only by undoing the change in the recent changes list, which shows the last 10.
- Checked with fake CLIs in the tests, and the new parts of the screen were drawn and clicked once with a throwaway script on a stand-in page (not kept in the repository); they were not looked at in a real browser, and nothing was run with real CLIs.
- To undo: drop `#roleNotes` from `#system`; runs are then as before and the files stay on disk.
