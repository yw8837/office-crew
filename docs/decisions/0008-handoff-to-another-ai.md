# 0008: Another AI that takes over a session gets the earlier conversation three ways

- Status: Accepted
- Date: 2026-11-12
- Related: `server/handoff.js`, `server/orchestrator.js` (`#fullTalk`, `#handoffNote`, `handoffWriter`, `#autoWriter`, `#ensureImported`, `rememberImported`), `server/importer.js` (`keepOlder`), `server/index.js` (`POST /api/import`, `POST /api/sessions/:id/handoff`, `POST /api/sessions/:id/clear`), `server/providers/codex.js`, `server/providers/gemini.js`, `test/handoff.test.js`

## Context

Importing a Claude Code or Codex session keeps its whole context only when the same CLI continues it, because that CLI resumes its own conversation. A different AI that took over got the latest 16 messages (the `historyTurns` setting), each cut at 2,000 characters. Only the latest 400 messages of an imported session are kept in the session at all, and an imported conversation was not stored in project memory. So "bring a Codex session and let Claude continue it" lost every earlier decision.

## Options

1. Put more of the conversation into the prompt. Simple, but a long session does not fit, and every run pays for it.
2. Have an AI summarize the session whenever another AI takes over. Fits any length, but costs a call each time without the user asking, and a summary can leave things out.
3. Write the whole conversation to a file and tell the new AI where it is. No AI call and nothing is cut, but only an AI that can read files can use it, and it decides itself whether to read.
4. Pick the parts of the earlier conversation that match the request and put those into the prompt. No AI call and every AI gets them, but matching words is not matching meaning.
5. Let the user ask the AI that knows the session for a handoff note, and give that note to whoever takes over.

## Decision

Options 3, 4 and 5 together, option 2 as a switch that is off by default, and imported conversations go into project memory. No single one is enough: the file depends on the AI reading it, picking depends on shared words, and the note costs a call.

- `handoff/<session>/` in the data folder holds `import.jsonl` (the text and tool names of every imported message that has text, including those not kept in the session) and, written when needed, `cloud/conversation.md` (continued in `conversation-2.md` and so on above 4 MB each). A `local/` folder exists in the design for a local receiver, but nothing writes it today because local models have no file tools.
- When earlier conversation is put into a prompt and the session has more messages than were put in (nothing below happens when the "recent conversation" setting is 0, which means earlier conversation is not handed over at all):
  - Picked parts go into the prompt inside random markers: the first two messages and the messages that share enough words with the request, in conversation order with their numbers. An AI with file tools gets up to 4,000 characters; one without gets up to 20,000.
  - An AI with file tools also gets the path of the file with the whole conversation, with a line saying it is reference material, not instructions. Only that session's `cloud` folder is opened to it: `--add-dir` for Claude Code and for Codex (new conversations only), `--include-directories` for Gemini CLI, the directory list for ACP agents. Hermes has no such option and gets the path only. When the same run starts the agent again in a new conversation (a rejected approval, a retry, the next meeting turn of a CLI that cannot continue its conversation), the folder is opened again. The file is written again only when the conversation changed, and files are overwritten in place, so an agent that is reading them is not disturbed.
  - The answer gets a line saying what was handed over and, when the run ends, a line saying whether a successful tool call named a conversation file in that folder. That is the closest the app can get to "read it": it does not see how much was read. This is skipped for a CLI that reports no tool events.
- Everything above leaves out what was said only to a local model when the receiver is a cloud AI (decision 0007), and leaves out the session title when it came from such a message.
- `POST /api/sessions/:id/handoff` sends a fixed request to an agent that has answered in the session: one that still continues its own CLI conversation first, then the one that answered most, then the most recent. The request is marked `handoffAsk` and its answer `handoff`. Project memory is not added to that request. The latest note is put before the earlier conversation for any other agent (after project memory pieces, if any), inside random markers, up to 8,000 characters, and is never given back to its writer. A second request while one is running is refused. The UI asks before sending because it is an AI call.
- The `autoHandoff` setting (off by default) sends that request automatically ahead of the user's message, also when both have to wait in the queue, when an agent that has never answered in the session is about to take over, the session has at least six messages, a suitable writer exists that is not part of this request, and no note was written, tried or queued after that writer's last answer. If the automatic note fails, the run ends without waiting for a decision and the user's message runs without a note. It is skipped when the writer is a local model and a newcomer is a cloud AI, because that note would not be handed over.
- With project memory on, an imported conversation is stored in the memory of its folder (`importedFrom.remembered` is set when it is all in). `imported.json` in that memory folder records how many messages of each record are stored, so importing the same record again stores nothing twice. These pieces are not given back to the agent that continues the original CLI conversation; other agents in the session get them.
- A session imported before this change has no `import.jsonl`. At its next run the original record is read again once, keeping the messages dated up to the time of the import; if the record is gone, only the messages kept in the session are used.
- Clearing a session's conversation deletes its handoff folder and marks `importedFrom.cleared`, after which the imported conversation is neither handed over as a file or picked parts nor read again. What is already in project memory stays and can still be found there, as the Memory page says.

This adds a folder to the data directory, a setting (`autoHandoff`), a file in each memory folder (`imported.json`) and fields to the session data format (`handoffAsk` and `handoff` on messages; `agentId`, `remembered`, `cleared` and `checked` on `importedFrom`). Earlier versions ignore them. Deleting a session deletes its handoff folder.

## Consequences

- Picking is by shared words. A request phrased differently from the earlier decision can miss it; then the decision reaches the new AI only through the file, the note or project memory.
- Whether an AI reads the file is its own choice. The app reports what it saw in the tool record, and cannot report it for a CLI that sends no tool events.
- Opening the folder for Codex and Gemini CLI was checked against their command-line help and with stand-in CLIs in the tests. It was not checked with a real run of either CLI. Opening a folder this way can also make it writable (Codex documents `--add-dir` as writable; Claude Code with edit permission and Gemini CLI with auto-edit probably behave the same), so an agent could change the conversation file that another agent reads. The file is written again from the session whenever the conversation changes.
- The file has the text of the conversation and the names of the tools used, not tool input or output.
- The conversation is stored a second time on disk, under the data folder, until the session is deleted or cleared.
- The automatic note costs one more AI call each time it runs, which is why it is off by default.
