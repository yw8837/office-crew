# 0004: Project memory is verbatim text on disk with a rebuildable keyword index

- Status: Accepted
- Date: 2026-11-11
- Related: 0001 (no runtime dependencies), `server/memory.js`, `test/memory.test.js`

## Revision (2026-11-26, with [0030](0030-goal-run-records-retry-and-flow-map.md))

A memory folder can also hold `failures.json` ([0030](0030-goal-run-records-retry-and-flow-map.md)): repeated tool and step errors from goals' work steps, each a first line with numbers, paths and times replaced, counted per goal, at most 100 lines (oldest dropped). It is not text of the conversation and is not searched or indexed; lines seen in two goals go into the next goal's work prompts as marked reference. It is written only while memory is on, the memory page shows it with Delete per line and Delete all, and a broken file is moved to `failures.json.bad` like `hidden.json`.

## Revision (2026-11-26, with [0025](0025-goal-report-and-evidence.md))

A goal report can be added to memory by the user (role `report`), and removed again: removing writes the message id to `hidden.json` in that memory's folder and search skips its pieces; the text and the index are not changed, and adding it again takes the id off the list. Nothing else in memory can be removed. Older versions ignore `hidden.json` and find those pieces.

## Context

When a CLI can't resume a conversation, Office Crew passes on only the last 16 messages, cut to 2,000 characters each. Nothing carries over between sessions. The goal is memory that keeps growing (10 million tokens and more) without slowing a run down, without spending more tokens, and with as little made-up or lost information as possible.

Public work on agent memory points the same way on two things. Memory that an AI extracts or summarizes loses facts at the writing step, so the original text has to stay. And a small amount of relevant text gives better answers than a very large context.

## Options

1. Have an AI summarize each run and keep the summaries. Compact, but every run costs extra tokens, and a wrong or incomplete summary can't be repaired once the original is gone.
2. Embeddings in a vector store. Better at questions that share no words with the stored text, but it needs a model download or an API and a store, which conflicts with decision 0001.
3. Keep the original text in append-only files and find it with a keyword index written in plain JavaScript.

## Decision

Option 3.

- One memory per work folder, under `memory/<key>/` in the data folder. The key is a hash of the folder path, so the path isn't used as a name.
- `chunks-NNNNNN.jsonl` holds the text in pieces of at most 900 characters, each with its session, message, agent, AI and time. These files are only appended to. `loc.bin` maps a piece number to its place in those files.
- `idx/` is an inverted index split over 1,024 files by a hash of the term. It is a copy: it can be deleted and rebuilt from the text, and a memory that was cut off while writing catches up when it is next opened.
- Terms are whole words for Latin letters and digits, and overlapping two-character pieces for Hangul, Han and Kana, so no tokenizer library is needed.
- A search reads only the index files of the request's terms (at most 40), ranks with BM25-style weights, and returns pieces up to a fixed number of characters whatever the size of the memory. No AI is called.
- A piece counts as related when it matches enough of the request's weight, or a term that is rare in the whole memory, or most of the request's terms. Otherwise nothing is returned.
- Common token shapes are masked before text is stored.

AI summaries, if added later, are an optional extra on top of the stored text and never replace it.

## Consequences

- Measured with synthetic conversations and no AI calls (about 19 million characters in 36,945 messages, 38.8 MB of text): half of the searches finished within 10.8 ms and 95% within 26.2 ms (longest 46.7 ms); process memory was the same as with a tenth of the data; at most 426 characters were returned per search; 300 planted facts were each found first for three kinds of question; 100 questions about things never stored returned nothing. The planted facts had unique names, so this is an easy case.
- The index takes about 2.2 times the size of the text, so text and index together are about 3.2 times the text.
- Keyword search misses questions that share no words with the stored text. Public benchmarks put keyword-only recall well below embedding search for conversational questions; this is the cost of staying dependency-free.
- A changed fact is not overwritten: the old and the new piece both remain and are told apart by time. Nothing marks the old one as outdated yet.
- A piece that was written to a text file but not yet to `loc.bin` when the app was killed stays in the file and is not found.
- This record covers storage and search. Nothing writes to or reads from the memory during a run yet.
