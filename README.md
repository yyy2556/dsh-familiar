# dsh-familiar

**English** | [简体中文](README.zh-CN.md)

A cross-session long-term memory plugin for DeepSeek Harness.

The model remembers who you are, what projects you work on, and what you have corrected it on — even in a brand-new session. No need to re-explain yourself every time.

Memory is just two plain-text files on your machine. Open them in an editor, grep them, put them in git. No database, no server, and the plugin itself makes no network requests.

> The npm package is `dsh-familiar-memory`. The bare name `dsh-familiar` is held by an unrelated empty placeholder, so install from the repository or use the full package name.

## ✨ Features

- **Plain-text storage** — memory is two files (`profile.md` + `facts.jsonl`), editable, git-friendly. No database, no server, no network requests.
- **Three-layer memory** — always-on profile + fact store + recall of original session history. Matched on demand, nothing is dumped into context up front.
- **Automatic merging** — new facts pass through a merge pass before being written. Duplicates, updates, and ended facts are recognized automatically, so the store does not rot into near-duplicates.
- **Silent on-demand injection** — related memory is recalled only when the current request touches it. A hard per-injection character cap, and no sentence is ever cut in half.
- **Zero dependencies** — no build step, no subprocesses, no elevated permissions. Clone and install.

## 🚀 Install

```sh
git clone https://github.com/yyy2556/dsh-familiar.git dsh-familiar
dsh plugin add /path/to/dsh-familiar
```

Restart DSH.

> Once published, `dsh plugin add dsh-familiar-memory` installs the same thing from npm.
>
> Upgrading an existing install does not create a duplicate loader row; the row id is fixed at `remember`.

## 🛠️ Daily use

Install it and forget about it. Extraction runs at the end of each turn, quietly collecting what is worth remembering. Recall happens automatically in later sessions.

The sidebar has a **Memory** entry showing the profile, facts with their dates and how each was written, and session cards (read-only).

To manage memory explicitly:

| Tool | What it does |
|---|---|
| `memory_recall` | Search memory manually; `detail` accepts brief / normal / deep |
| `memory_expand` | Expand a history message into its surrounding original turns, instead of guessing from a summary |
| `memory_remember` | Write explicitly: `kind=profile` into the always-on profile, `kind=fact` into the fact store; `operations` batches add-and-remove in one call |
| `memory_list` | See what is stored, with per-category counts |
| `memory_forget` | Delete an entry by fact id, or by a unique profile substring (multiple matches error out with candidates — nothing is deleted blindly) |
| `memory_maintain` | Generate a maintenance report; add `{ apply: true }` to actually archive stale entries |

## 🧠 How it works

Memory comes in three layers, injected by priority:

1. **Profile (`profile.md`)** — about 300 characters of core context, carried into every session. Capped (default 500 chars), with the occupancy shown in the injected heading. Frozen per session: hand edits reload when a new session starts, so the prompt prefix cache stays intact.
2. **Fact store (`facts.jsonl`)** — accumulated preferences, corrections, and project details, each tagged with a category and a source. Recall is decided by local keyword scoring — no model call, no database. No hit, no injection.
3. **Original session history** — when facts are not enough, snippets are pulled from real conversations through DSH's full-text index. Original text, not model-written summaries.

Recalled content is injected under a hard cap (default 1100 chars) using tiered budgeting: every candidate enters as a short summary, and the top-scoring ones are upgraded to full text while budget remains. A sentence is never cut mid-way.

## ⚙️ Configuration

Set under the `remember` row in the plugin page, or in the profile's `cordis.patch.yml`. The common ones:

| Key | Default | Meaning |
|---|---|---|
| `autoInject` | `true` | silent auto-recall on/off |
| `injectBudgetChars` | `1100` | hard cap per injection |
| `profileMaxChars` | `500` | profile cap |
| `injectCorrectionSlots` | `2` | reserved slots for corrections |
| `autoExtract` | `true` | extract at end of turn |
| `memoryDir` | `$DSH_PROFILE_DIR/memory` | data directory |
| `debug` | `false` | write `debug.log` |

Full table in the [appendix](#appendix-full-configuration).

## 📁 Data files

Everything lives in the local `memory` directory as readable text:

| File | Content |
|---|---|
| `profile.md` | the always-on profile |
| `facts.jsonl` | fact store, one JSON object per line |
| `sessions.json` | session-card index, derived cache, safe to delete |
| `extract.json` | per-session extraction watermark |
| `maintenance.md` | latest maintenance report |
| `debug.log` | diagnostics, reset on each start |

## 🔒 Privacy

- Memory stays in local files you control; nothing is uploaded.
- The plugin itself makes no network requests.
- The only model calls are extraction and merging, using the model already configured in your harness.
- Extraction reads your own history through the host's session index; conversations are not copied elsewhere.
- `.gitignore` already excludes memory data, but check before committing a repo or sharing a `debug.log`.

## 📌 Limitations

- Keyword + bigram scoring, no embeddings. Fine for thousands of facts and hundreds of sessions, but it is not a semantic search engine.
- Tokenization is tuned for Chinese (CJK bigrams). Latin text works too, but scoring was tuned on Chinese conversations.
- Extraction quality depends on the configured model; a weak model produces weak facts.
- The sidebar panel is read-only; edit through tools or the files directly.

## 🧑‍💻 Development

No build step; run the tests directly:

```sh
node test/consolidate.test.mjs   # merge protocol, candidate recall, budget tiers
node test/profile.test.mjs       # unique-substring editing, capacity contract
node test/recall.test.mjs        # past-cue false positives, ended filtering, decay, maintenance
```

46 assertions across three files, no test framework.

`tools/merge-now.mjs` is a one-shot helper for cleaning an existing store: `prompt` generates the merge instruction, `apply` writes the model's decisions back, `plan` applies a hand-written dedup plan. All three back up `facts.jsonl` first.

## Acknowledgments

The design borrows from three open-source memory systems:

- [hindsight](https://github.com/vectorize-io/hindsight) — the merge protocol, evidence counting, date comparison in code
- [OpenViking](https://github.com/volcengine/OpenViking) — tiered budget filling, "similarity is not identity"
- [hermes-agent](https://github.com/NousResearch/hermes-agent) — the capacity contract, unique-substring editing, per-session profile freezing

None of them are dependencies. The plugin only uses the host's Cordis services (`tools`, `sessionQuery`, `systemPrompt`, `llm`, `webServer`).

## License

MIT

---

# Appendix

For maintainers and anyone planning to change the code. Not needed for normal use.

## Appendix: Merge protocol

Newly extracted facts do not go straight into the store; they pass through a merge pass first. Without it, an append-only list fills up with near-duplicates quickly.

| effect | meaning | write action |
|---|---|---|
| `unrelated` | nothing to do with existing facts | append a new record |
| `repeats` | an existing fact already says this | no new record, `proofCount + 1` |
| `changes` | a new value for the same attribute | rewrite text, push the old value into `history`, keep `createdAt` |
| `ends` | something finished or no longer true | rewrite in past tense, record `endedAt` |

The judgement is the model's; candidates are generated mechanically: token overlap of two or more, plus the two most recently touched facts of the same category.

Two rules constrain the merge:

- Similarity is not identity. Token overlap, shared topic, or the same category only means a fact is worth a look — it is never evidence that two facts are the same memory.
- Before rewriting an existing fact, account for everything in it. If the old text carries an independent fact that would be lost, it becomes its own record.

Date comparison happens in code: new facts are later by definition, so the model never does "how many days ago" arithmetic.

No candidates, no model call. If the model is unavailable or its output cannot be parsed, the pass degrades to exact-string dedup — a candidate is never dropped.

## Appendix: Fact metadata

| Field | Values | Purpose |
|---|---|---|
| `kind` | `fact` `correction` `preference` `project` `environment` | same-category candidate recall, reserved slots, panel grouping |
| `source` | `user` / `inferred` | stated by the user, or the model's own summary |
| `origin` | `auto-extract` / `memory_remember` | write path — a different question from who said it |
| `proofCount` | integer | how many times this was confirmed; drives merging and slot ordering |
| `hitCount` / `lastHitAt` | integer / timestamp | decay and archiving |
| `archivedAt` | timestamp | excluded from matching and injection, kept on disk |
| `endedAt` | timestamp | hidden by default, shown when the request is about the past |

## Appendix: Reserved slots for corrections

`kind: correction` facts do not need to match the current topic; each session reserves 1–2 slots for them.

Slots are split in half: one for the highest `proofCount`, one for the most recent `lastHitAt`. Ordering by evidence strength alone would freeze the list — old corrections would hold the slots forever and new ones would never surface.

Guaranteed injections do not count as hits. Hits are only recorded for topic-matched injection, otherwise reserved entries would reset their own decay every turn and the mechanism below would never fire.

## Appendix: Decay and archiving

Unhit facts lose weight, not existence:

- ≥90 days: score ×0.8
- ≥180 days: score ×0.6
- archived: fully excluded

There is no time-based deletion anywhere. Archiving requires an explicit `memory_maintain { apply: true }`.

## Appendix: Ended facts

Facts with `endedAt` only appear when the request carries a past-time cue (上次, 之前, 以前, 曾经, 当时, 历史, used to). The cue list is deliberately narrow; false positives are rare and the ones that fire are genuinely about the past.

## Appendix: Maintenance report

When the fact count passes `maintainThreshold` (default 120), a dry-run report is written to `maintenance.md`: suspected duplicates (literal Jaccard ≥ 0.5), ≥180 days without a hit, oversized entries (>300 chars), archived entries.

The report changes nothing.

## Appendix: The two profile-editing guards

1. **Unique substrings only.** `remove` / `patch` must match exactly one line. Zero matches is an error; multiple matches is an error listing the candidates. No whole-file replace — a wholesale rewrite silently drops everything else sharing that line.
2. **Capacity is checked on the batch result.** Going over the cap returns how many characters short you are plus the current entries, and expects one call that removes old entries and adds the new one together. Otherwise the model loops between "add rejected" and "how much do I delete".

## Appendix: Full configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `autoInject` | `true` | silent auto-recall |
| `injectMode` | `auto` | `notice` forces notice form, `off` disables injection |
| `injectBudgetChars` | `1100` | hard cap per injection (~550 tokens) |
| `injectMaxFacts` | `4` | max facts per injection |
| `injectCorrectionSlots` | `2` | reserved correction slots, 0 disables |
| `cardScoreThreshold` | `0.30` | session-card match threshold |
| `profileMaxChars` | `500` | profile cap |
| `maintainThreshold` | `120` | fact count that triggers a maintenance report |
| `autoConsolidate` | `true` | run the merge pass before writing |
| `autoExtract` | `true` | extract at end of turn |
| `extractProvider` / `extractModel` | host default | model used for extraction and merging |
| `extractMaxChars` / `extractMaxFacts` | `6000` / `3` | extraction input/output caps |
| `indexLimit` / `indexTtlMs` | `400` / `300000` | session index size and refresh interval |
| `maxEvidenceSessions` / `maxSnippetsPerSession` / `snippetChars` | `2` / `3` / `200` | recall evidence shape |
| `memoryDir` | `$DSH_PROFILE_DIR/memory` | data directory |
| `debug` | `false` | write diagnostics log |