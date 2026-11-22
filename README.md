# dsh-familiar

**English** | [简体中文](README.zh-CN.md)

Cross-session long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai). A small always-on profile, silent on-demand recall over your real conversation history, and a memory store you can read and edit by hand.

Everything stays on your machine: two Markdown/JSONL files under your DSH memory directory, no database, no server, no network calls of its own.

> Published to npm as **`dsh-familiar-memory`**. The bare name `dsh-familiar` is held by an unrelated empty placeholder package, so install by repository or by the full package name.

---

## Why

Most agent memory systems solve a harder problem than most setups actually have: they build a vector index, a graph, a consolidation pipeline, and then hide the result in an opaque store. For a single-user harness whose history is already searchable, that is a lot of machinery for a small payoff.

`dsh-remember` takes the narrow path:

- **Nothing large is injected up front.** What is always in the prompt is one static policy section and a ~300-character profile.
- **Recall is silent and rare.** When the current request touches something remembered, a collapsed notice is appended. When it does not, nothing is appended at all.
- **Details come from the original text**, not from summaries. Evidence is fetched through the host's own session index, and `memory_expand` can pull the surrounding original turns back out.

## How it works

Three layers, cheapest first.

```
① always-on     profile.md            ~300 chars, injected once per session
② on demand     facts.jsonl           keyword match + decayed scoring
                session index         FTS over real history → original snippets
③ on demand     memory_expand         re-opens the original context window
```

### ① Profile

A short Markdown file, capped by `profileMaxChars` (default 500). Injected as a system-prompt section with the current occupancy in the heading:

```
## User profile [62% — 310/500 chars]
```

The profile is **frozen per session**: hand edits are written to disk but only reload when a new session starts. This keeps the prompt prefix cache intact — a mid-session edit to a system-prompt section invalidates everything after it. Explicit writes through `memory_remember` refresh it immediately, because that is a deliberate action rather than background drift.

### ② Silent recall

On each step, the plugin decides locally whether the request touches anything remembered. The decision is cheap — tokenized keyword scoring over fact and session-card indexes, no model call, no database query. No hit means no injection.

When something does hit, one collapsed notice is appended carrying:

- matched facts (with their record dates),
- snippets pulled from the real conversation history.

The total is hard-capped by `injectBudgetChars` (default 1100).

### ③ Original text

`memory_recall` is for explicit lookups; `memory_expand` re-opens the surrounding turns of a specific message. Neither returns model-written summaries.

## Consolidation

Newly extracted facts do not go straight into the file. They pass through a merge pass first, because a growing flat list degrades into near-duplicates faster than anyone expects.

| `effect` | meaning | write action |
|---|---|---|
| `unrelated` | nothing to do with existing facts | append a new record |
| `repeats` | an existing fact already says this | no new record, `proofCount += 1` |
| `changes` | a new value for the same attribute | rewrite text, push the old value into `history`, keep `createdAt` |
| `ends` | something finished or stopped being true | rewrite in past tense, record `endedAt` |

Two rules do the actual work:

- **Similarity is not identity.** Token overlap, shared topic, or the same category only means a fact is worth a look — it is never evidence that two facts are the same memory. Candidate generation is mechanical; the judgement is the model's.
- **Before rewriting an existing fact, account for everything in it.** If the old text carries an independent fact that would be lost, it becomes its own record rather than being silently overwritten.

Date comparison happens in code, not in the prompt: new facts are by definition later, so the model never does arithmetic on "how many days ago".

With no candidates, no model call is made at all. If the model is unavailable or its output cannot be parsed, the pass degrades to exact-string dedup — a candidate is never dropped.

## Budget-aware injection

Facts do not get "top N, then truncate". They get **tiered**:

1. every candidate enters at the short tier (56 chars),
2. the top-scoring ones are upgraded to the full tier (200 chars) while budget remains,
3. when budget runs out, entries stay at their current tier — a sentence is never cut in half.

Facts may take at most half of the injection budget; the remainder goes to history snippets.

## Fact metadata

| field | values | why it exists |
|---|---|---|
| `kind` | `fact` `correction` `preference` `project` `environment` | same-category candidate recall, guaranteed slots, panel grouping |
| `source` | `user` (stated by the user) / `inferred` (model's own summary) | keeps the two apart |
| `origin` | `auto-extract` / `memory_remember` | write path — a different question from who said it |
| `proofCount` | integer | evidence strength; drives merge and slot ordering |
| `hitCount` / `lastHitAt` | integers / timestamp | decay and archiving |
| `archivedAt` | timestamp | fully out of matching and injection, still on disk |
| `endedAt` | timestamp | hidden by default, shown when the request is about the past |

### Corrections get reserved slots

`kind: correction` facts (rules the user has corrected you on) do not need to match the current topic. Each session reserves 1–2 slots for them (`injectCorrectionSlots`, default 2).

The slots are split deliberately: **one for the strongest evidence, one for the most recently touched.** Ordering by `proofCount` alone would freeze the list — whichever correction was confirmed the most times would hold the slot forever, and a correction that appeared yesterday would never surface.

Guaranteed injections **do not count as hits.** Hits are only recorded for topic-matched injection, otherwise reserved slots would keep resetting their own decay and the mechanism below would never fire.

### Decay and archiving

Unhit facts lose weight, not existence:

- ≥90 days: score ×0.8
- ≥180 days: score ×0.6
- archived (`archivedAt`): excluded entirely

There is no time-based deletion anywhere in this plugin. Archiving requires an explicit `memory_maintain { apply: true }`.

### Ended facts are hidden by default

A fact with `endedAt` only appears when the request carries a past-time cue (上次 / 之前 / 以前 / 曾经 / 当时 / 历史 / used to …). The cue list is deliberately narrow and comes with a false-positive test: over 12 ordinary sentences the rate is 16.7%, and both triggers are sentences that genuinely refer to the past.

## Maintenance report

When the fact count passes `maintainThreshold` (default 120), a dry-run report is written to `maintenance.md`:

- suspected duplicates (literal Jaccard ≥ 0.5),
- ≥180 days with no hit,
- oversized entries (>300 chars),
- already archived.

The report changes nothing. `memory_maintain` prints the same numbers through a tool call, and `memory_maintain { apply: true }` archives the stale ones.

## Tools

| tool | purpose |
|---|---|
| `memory_recall` | search memory: fact match + full-text history, `detail` = brief / normal / deep |
| `memory_expand` | expand a specific history message into its surrounding original turns |
| `memory_remember` | write: `kind=profile` to the always-on profile, `kind=fact` to the searchable store, with `category` and `source` |
| `memory_list` | inspect what is stored, including per-kind counts and promotion suggestions |
| `memory_forget` | delete by fact id, or by a **unique** profile substring |
| `memory_maintain` | maintenance report; `apply: true` archives long-unhit facts |

### Editing the profile safely

Two rules, both learned the hard way:

1. **Unique substrings only.** `remove` / `patch` must match exactly one line. Zero matches is an error; multiple matches is an error listing the candidates. There is no whole-file replace — a wholesale rewrite silently drops every other fact sharing that line.
2. **Capacity is checked once, on the batch result.** Going over `profileMaxChars` returns how many characters short you are plus the current entries, and expects **one** `memory_remember` call that removes or shortens old entries and adds the new one together. Otherwise the model loops between "add rejected" and "how much do I delete".

## Install

```sh
git clone https://github.com/yyy2556/dsh-familiar.git dsh-familiar
dsh plugin add /path/to/dsh-familiar
```

There is no build step and no runtime dependency, so a plain checkout is installable as-is. The bundle declares `dsh.bundle` in `package.json` and ships `cordis.patch.yml`, so it installs as a normal bundle row. Once published, `dsh plugin add dsh-familiar-memory` installs the same thing.

Restart DSH after installing. The plugin never needs elevated permissions and never launches subprocesses.

The loader row id stays `remember`, so upgrading an existing install does not create a duplicate row.

## Configuration

Set under the `remember` row (profile `cordis.patch.yml` or the plugin detail page):

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `autoInject` | `true` | whether silent recall runs at all |
| `injectMode` | `auto` | `notice` forces notice form, `off` disables injection |
| `injectBudgetChars` | `1100` | hard cap per injection (~550 tokens) |
| `injectMaxFacts` | `4` | max facts per injection |
| `injectCorrectionSlots` | `2` | reserved slots for corrections (0 disables) |
| `cardScoreThreshold` | `0.30` | session-card match threshold |
| `profileMaxChars` | `500` | profile cap |
| `maintainThreshold` | `120` | fact count that triggers a maintenance report |
| `autoConsolidate` | `true` | run the merge pass before writing |
| `autoExtract` | `true` | extract facts at end of turn |
| `extractProvider` / `extractModel` | host default | model used for extraction and merging |
| `extractMaxChars` / `extractMaxFacts` | `6000` / `3` | extraction input/output caps |
| `indexLimit` / `indexTtlMs` | `400` / `300000` | session index size and refresh interval |
| `maxEvidenceSessions` / `maxSnippetsPerSession` / `snippetChars` | `2` / `3` / `200` | recall evidence shape |
| `memoryDir` | `$DSH_PROFILE_DIR/memory` | data directory |
| `debug` | `false` | write `debug.log` |

## Data files

Plain files under the memory directory. All are readable, greppable, and safe to edit by hand.

| file | content |
|---|---|
| `profile.md` | the always-on profile |
| `facts.jsonl` | one JSON fact per line |
| `sessions.json` | session-card index (derived cache, safe to delete) |
| `extract.json` | per-session extraction watermark |
| `maintenance.md` | the last dry-run maintenance report |
| `debug.log` | diagnostics, reset each start |

## Panel

A read-only **Memory** page in the sidebar shows the profile, the facts with dates and evidence counts, and the session cards. It reads `GET /remember/memory.json`, a same-origin route registered by the plugin.

## Privacy

- Memory lives in local files you control; nothing is uploaded anywhere.
- The plugin makes no network requests of its own. Its only model calls are fact extraction and the merge pass, both using the model already configured in your harness (`extractProvider` / `extractModel`, or your default).
- Extraction reads your own session history through the host's session index; there is no separate copy of conversations.
- The memory directory is included in `.gitignore` guidance — check before committing a repo, and check before sharing a `debug.log`.

## Limits

- No embeddings. Retrieval is keyword/bigram scoring over facts plus the host's full-text index. This scales fine to thousands of facts and hundreds of sessions; it is not a semantic search engine.
- Chinese-centric tokenization (CJK bigrams). Latin text is tokenized too, but the scoring was tuned on Chinese conversations.
- Extraction quality depends on the configured model; a weak model produces weak facts and weaker merge decisions.
- The panel is read-only — editing happens through tools or by hand.

## Prior art

The design leans on three open-source memory systems, and it is worth saying which idea came from where:

- **hindsight** — the `unrelated / repeats / changes / ends` merge protocol, `proofCount`, and doing date comparison in code rather than in the prompt.
- **OpenViking** — tiered budget filling (spread the budget across candidates, then upgrade by score) and the rule that similarity is never sufficient evidence of identity.
- **hermes-agent** — the capacity contract (report how far over you are, demand one batch), unique-substring `patch`/`remove`, and freezing the profile per session to keep the prompt cache warm.

None of these are dependencies. The plugin only uses the host's Cordis services (`tools`, `sessionQuery`, `systemPrompt`, `llm`, `webServer`).

## Development

```sh
node test/consolidate.test.mjs   # merge protocol, candidate recall, budget tiers
node test/profile.test.mjs       # unique-substring editing, capacity contract
node test/recall.test.mjs        # past-cue false positives, ended filtering, decay, maintenance
```

46 assertions across the three files, no test framework, no build step.

`tools/merge-now.mjs` is a one-shot helper for cleaning an existing store: `prompt` generates the merge instruction, `apply` writes the model's decisions back, `plan` applies a hand-written dedup plan. All three back up `facts.jsonl` first.

## License

MIT
