# Preview evaluation set (0.5.0)

This directory measures the independent preview, the package that runs on official Pi. It is separate from the
frozen F1 to F3 fixtures in `eval/fixtures`, which evaluate the resident runtime pinned in `eval/runtime.ts`; nothing
here changes those fixtures, their scorer or the pin. See the [0.5.0 plan](../../docs/context-memory/v0.5.0-plan.md),
work packages W0 and W3. P4 and the token-overhead report belong to the
[0.6.0 plan](../../docs/context-memory/v0.6.0-plan.md), work package WP1.

## Fixtures

`generate.ts` writes five invented fixtures. Each is first a branch of host-neutral records,
`fixtures/<ID>/records.jsonl` in the format `0.7-host-neutral-records.1` that `records.ts` defines: a header with the
session's ID, start time and working directory, then one record per line in the specification's record model, with
the field names of `packages/compaction-core/src/records.ts`. The Pi converter, `pi-session.ts`, renders from those
bytes the Pi version-3 session `fixtures/<ID>/session.jsonl`; beside it the generator writes the gold file. Pi's
message timestamp and the assistant's provider envelope are not record fields, so the converter derives them: the
timestamp from the record's, the envelope as the fixtures' synthetic provenance. P1 to P3 stamp every Pi message with
a fixed timestamp of 1 instead, which no record field gives, so their records carry it as Pi's native payload,
`"native":{"pi":{"message":{"timestamp":1}}}`. The 0.7.0 conformance vectors use the same record model.

`--check` regenerates every file in memory and fails on any byte difference. Each fixtures version has its own
manifest, which pins its sessions and gold files by SHA-256: `fixtures/manifest.json` pins P1 to P3 under
`0.5-preview-fixtures.1`, `fixtures/manifest-0.6.json` P4 under `0.6-preview-fixtures.1` and
`fixtures/manifest-long.json` P5 under `0.7-preview-fixtures-long.1`; the records format did not move a pinned
byte (decision H6 of the [0.7.0 plan](../../docs/context-memory/v0.7.0-plan.md)). The converter byte-identity check
converts the committed records files and compares each result with its manifest's pin; `eval/check.mjs` runs it
beside `--check`, and `records.test.ts` covers it:

```sh
node --experimental-strip-types eval/preview/generate.ts --check
node --experimental-strip-types eval/preview/pi-session.ts --check
```

| Fixture | Source tokens | Checkpoints | What it stresses |
| --- | ---: | ---: | --- |
| P1 | about 70,000 | 3 | A timeout revised three times and reverted; a withdrawn subtask; a failed approach the user forbids retrying; a user ruling echoed verbatim by the assistant and inside a tool output; a deploy instruction that only a log line gives |
| P2 | about 51,000 | 2 | Decisions and errors among long tool outputs; a corrected threshold and due date; a file the user forbids creating |
| P3 | about 44,000 | 3 | Answers a note cannot hold: exact values among 400 endpoint latencies, 200 audited packages and 900 log lines; twelve edit and write calls and four failed tool calls to count and tell apart; a timeout raised for every service and then restored for one |
| P4 | about 70,000 | 3 | Answers in the entries a deterministic reduction would replace: a configuration, a source file and a runbook read again after they changed, and long test, log, search and load outputs that later turns consumed; user rulings and a failed command as controls; prompts naming request and merchant IDs that only tool outputs hold |
| P5 | about 377,000 | 5 | Several compactions of one long session on two routes: checkpoints 1, 3 and 5 at about 150,000 tokens of context each on a 200k route, 2 and 4 at about 204,000 on a 272k route; early facts every later round must carry through the notes before it; a batch size changed after the first and second compactions and a window moved and moved back |

P1 and P2 test what a note keeps; with no tools, the notes alone answered nearly all their probes in the first
provider run. P3 tests retrieval: most of its answers are exact values or inventories that only `context_history`
can recover, so the gap between the two probe conditions and the calls per question are its measures. P4 tests
reductions and excerpts: at least 17 of its answers live only in tool results that a later result of the same
tool on the same target superseded, or after which two turns completed, and every other answer stays in view
through a user ruling, assistant text, a failed command's output or a file's latest read; `preview.test.ts` checks
both. Its records advance a clock, 15 seconds apart with one gap of 95 minutes before a user message, so an
idle-gap rule can be measured; P1 to P3 carry one fixed time.

P5 has its own version and manifest, `manifest-long.json`, so P1 to P4 keep their pins. Its context sizes are o200k
tokens of the readable text, counted when the fixture was tuned; its source tokens run lower, because its logs hold
about 2.6 bytes per token. A run measures one route with `--cuts`: `--cuts 1,3,5` compacts three times on a 200k
route and `--cuts 2,4` twice on a 272k route, each later round with the earlier notes in place of what they replaced,
as a session continues after `/compact`. Every compaction stays below 272,000 tokens, where OpenAI's long-context
price begins. Its cuts release more than 80,000 source tokens, so it is not part of the default fixture set.
OpenCode and DSH take the same session through `scripts/context-memory-host-run.mjs`, with their native compaction
in place of the preview's ([host runs](../../docs/context-memory/openai-api.md#host-runs)).

Source tokens are `ceil(UTF-8 bytes / 3)` of the readable text, the preview's own size proxy. Each checkpoint
follows a completed assistant turn. Every tool call has exactly one result. Every cut of P1 to P4 releases fewer
than 80,000 source tokens, so all of them fall in the first v0.2.3 note-budget tier.

The 108 probes of P1 to P4 and the 49 of P5 each ask for one JSON answer: `{"status":"answer","value":...,"evidence":[...]}` or
`{"status":"unknown"}`. Values are numbers, booleans, short text with listed accepted forms, or an option letter.
Probe kinds (current and previous values, counts, constraints, forbidden retries, withdrawn work, attribution,
authority, absent answers, continuation and facts) live only in the gold files. A test keeps them out of every
prompt, and the runner passes no category to the runtime.

## Scoring

`scorer.ts` reports, with denominators, correct, incorrect, abstained, `unknown-correct`, fabricated (an answer
where the records hold none), invalid (no answer object) and blocked (no reply, for example after a refused
checkpoint). It also counts answers whose evidence cites an accepted entry, and evidence IDs that do not exist. It
reports by kind and separately for answers whose source crossed an earlier compaction.

Scorer version 2 (`0.5-preview-scorer.2`) measures what the answer says, not how it is phrased. A value that leads
with the expected answer and goes on in prose passes, such as "No. The endpoint was disabled." for `false` or "JSON
lines (JSONL), not CSV" for a format; the answer must end at a character that cannot continue a word, so "Nope" or
"2500" do not pass for "no" or 250. Such answers are counted under `prose`. Version 1 failed them: in the first
provider run, nine answers with the right value were scored incorrect. The answer contract is unchanged, so runs on
either side of the change ask the same questions.

`rescore.ts` scores the replies a bench run saved with the current scorer, so a run made under an earlier version
can be compared on equal terms:

```sh
node --experimental-strip-types eval/preview/rescore.ts "$OUTPUT_DIR/candidate-probes"
```

## Runner

`scripts/context-memory-preview-bench.mjs` loads a built preview package into an official Pi installation and runs
each unit in its own process and agent directory. It needs the package and host from the preview build:

```sh
node scripts/context-memory-ops.mjs preview   # builds .artifacts/context-memory-preview-package and installs Pi
node --experimental-strip-types scripts/context-memory-preview-bench.mjs \
  --package-dir .artifacts/context-memory-preview-package \
  --stock-root .artifacts/context-memory-preview-stock \
  --output-dir "$OUTPUT_DIR" --mode writer --attempts 2
```

| Mode | What it does |
| --- | --- |
| `smoke` | One small request over P1's opening turn, to check that the provider accepts the generated history |
| `writer` | For each checkpoint, earlier cuts are compacted by a loopback writer that builds faithful notes from the gold files; the measured writer then compacts the cut on `--attempts` fresh copies. Reports refusals by code and quotation class, repairs, writer calls, usage and pause. For each committed note it also reports its size against the bytes it condenses (the previous note and every later message) and how many gold answers it cites, split into answers first asked at this cut and answers carried from earlier cuts |
| `probes` | The measured writer compacts each fixture cut after cut; a refused cut is retried, as a user retries `/compact`, up to `--chain-attempts` attempts in all (default 4), so that recall is measured on committed notes while `writer` mode measures refusals. A cut still refused blocks its probes and every later one. Each probe runs on its own copy of the chain at its checkpoint, once with only `context_history` active and once with no tools. Reports scores per condition, `context_history` calls per question by operation, and missed-entry probes, whose answers sit in entries no checkpoint cites. `--probe-conditions history` runs only the condition a session has, and `--cuts` compacts only at the checkpoints it names |

| `repair` | For each case of `repair.ts` at each cut, the writer's first call gets the case's planted candidate and only the quotation repair reaches the measured model, `--attempts` times per case. Reports scores by template, refusals by code, and for the repair calls their stop reasons, the effort asked for and the reasoning settings each request carried, output and reasoning tokens, time and cost |

`--provider loopback`, the default, answers locally and never contacts a model service; it checks the harness.
It reports usage proportional to each request, `ceil(bytes / 3)` of the messages and tools sent and of its answer,
with no cache, and in the `context_history` condition it first reads the probe's first gold evidence entry once and
then answers unknown, as before, so every column of the token-overhead report has offline figures.
In `repair` mode, `--provider deepseek-local` loads Pi's catalog model `deepseek/deepseek-flash` with its own
compatibility settings and level map, moves only its address to the bench, and answers the repair with the case's
scripted repair: it shows what official Pi sends for each `--thinking` level without any request leaving the
machine.
`--provider deepseek` uses Pi's catalog model `deepseek/deepseek-flash` through the environment's network proxy,
which supplies the key; Pi receives only a placeholder. A provider run requires `--max-requests`, `--max-minutes` and
`--max-cost-usd` and starts no unit once any limit is reached, and `--max-input-tokens N` adds a fourth: the first
request that reports more than N input tokens, cached tokens included, stops the run as the others do. `--cache session`
runs each cut's warm-up turn on the session itself rather than on a copy, so the writer's request continues it as it
continues a session's last turn; use it with `--provider openai`, whose cache serves only such continuations
([openai-api.md](../../docs/context-memory/openai-api.md#prompt-cache)). `--compactions-only` runs a probes chain's
warm-ups and compactions without its probes; with `--concurrency N`, up to N units already running
may finish past it. Costs are Pi's catalog estimates, not invoices. `--unit-minutes`, 10 by default, stops a unit
still running after that long: it settles as crashed and counts under `timedOut`, and a probe it held is scored as
blocked, so one request that never returns cannot hold the run. The limits go to the maintainer before the first
request:

```sh
node --experimental-strip-types scripts/context-memory-preview-bench.mjs \
  --package-dir .artifacts/context-memory-preview-package \
  --stock-root .artifacts/context-memory-preview-stock \
  --output-dir "$OUTPUT_DIR" --label candidate-writer --mode writer --provider deepseek \
  --concurrency 6 --max-requests 50 --max-minutes 20 --max-cost-usd 0.5
```

`--provider openai` measures Pi's catalog model `openai/gpt-6-luna` at its own address, OpenAI's official API, in
`smoke`, `writer` and `probes` modes; `repair` answers the writer's first call in Chat Completions, and Pi's catalog
sends Luna through the Responses API. It needs the network secret that
[openai-api.md](../../docs/context-memory/openai-api.md) sets up, gives each unit the placeholder `OPENAI_API_KEY`, and
stops a unit before its first request when the catalog serves Luna from any host but `api.openai.com`. The same three
limits apply, and `summary.json` names `api.openai.com` under `endpoint`. Writer rows add `openaiResponses`: for every response, its output items, and for each message its phase and the shape of its JSON or
its length when it does not parse, never its text. The shape names each key's kind and length, and for each section the keys and kinds of its items with their counts, marking empty strings, strings over 1,000 or 4,000 characters and repeated IDs, the cases the note schema refuses. Usage and cache reads are
OpenAI's own counts, so cache share compares with other runs; costs are Pi's catalog estimates over them, not invoices.
Luna's window in Pi's catalog stops at 272,000 tokens, where OpenAI's long-context price begins.

`--provider relay --base-url https://.../v1` measures Pi's catalog model `openai/gpt-6-luna` through an
OpenAI-compatible relay, in `smoke`, `writer` and `probes` modes. Pi keeps the model's compatibility settings and level
map and speaks the Responses API, so the session writer's `prompt_cache_key` reaches the relay; only the address
moves. The environment's network proxy supplies the relay's key, and Pi receives a placeholder. The same three limits
apply, `summary.json` names the relay's host under `endpoint`, and writer rows add `relayResponses`, shaped as
`openaiResponses`. A relay may add its own instructions and reports
usage of its own: compare refusals, notes and probe scores with other runs, but not its cache share or cost, which
are catalog estimates over the relay's counts.

`--arm native` runs the same `probes` chain with no package loaded, so Pi's own compaction summarizes each cut with the
same model, thinking level and settings, and each probe then answers from Pi's summary. Without the package there is
no `context_history`, so it takes only `--mode probes --probe-conditions none`; anything else is refused before a
file is read. Pi chooses its own cut inside each span: it keeps the last entries of an unfinished turn verbatim and
summarizes the rest in a second call, which the row counts under `writerCalls`. Compaction rows carry
`nativeSummaryBytes` in place of `note`, and the summary call's usage counts toward `--max-input-tokens`. Compare a
native run with a Slice run's `history` condition on the same fixtures, model and thinking level: that pair is what a
user gets with and without the package. The default `--arm slice` is every other run.

`--replay`, in `probes` mode with `--cache session`, measures 0.8.0's segments against the synchronous writer on the
same terms. Each round of a chain runs in one unit: the round's entries join the session step by step, keeping their
IDs, and every step ends where the agent settles, with an assistant reply that calls no tool and a user message after
it. One real turn, `Reply with the single word OK.`, then runs on the session itself, as the main model's last turn
before the user speaks again: it keeps the provider's cache warm and fires the settled event at which the preview
writes a segment. Pi compacts wherever its trigger falls. P5's last step before each gold checkpoint is a short closing
turn, so a compaction Pi made at that step or the one before stands as the round's checkpoint, since a user would not
compact again at once; otherwise the round ends with `/compact` at the gold checkpoint. A failed compaction is retried
up to `--chain-attempts` times. Both arms of a
comparison replay alike and differ only in `--session-settings previewSegments=on|off`; `--segment-effort` sets the
segments' own thinking level, and probe units always run with segments off, since they answer from the committed
checkpoint. `--pace settled` lets the segment in flight settle before the next step, the best case; `--pace immediate`
goes on at once, as a user who never pauses. `--window` sets the route's context window and caps the model's output
maximum at 32,000, as a model of that class has it, since the preview reserves the larger of 16,384 and that maximum
below the window. `--reserve` sets Pi's `compaction.reserveTokens`, so Pi's trigger and the segment ranges follow the
route rather than the catalog. The session writer needs room above the context for its output and its instruction, which
Pi's default reserve does not leave at the trigger; in use the preview's room check compacts first. P5's routes
therefore run with `--window 180000 --reserve 30000` for cuts 1, 3 and 5 and `--window 240000 --reserve 30000` for cuts
2 and 4: each gold checkpoint lies just under the trigger with about 30,000 tokens of room. A window whose trigger falls
below a gold cut fails in both arms, because one of P5's steps adds a 70,000-token run at once. A round can take longer
than the default unit limit; give `--unit-minutes 30`.

A replay run writes `boundaries.jsonl`, one content-free row per compaction attempt with its trigger (`auto`, `gold` or
`retry`), path, segments fallback, U8 wait, pause, coverage at the gold checkpoint and foreground writer calls, and
`rounds.jsonl` with each round's steps, turns, requests, cost and the preview's own count of how its segments ended
(`segments.results` in `/compaction-status`). `summary.json` adds `replay`: the pause's P50, P95
and maximum over every committed boundary, over those the segments served and over the writer's, fallbacks by cause,
waits, coverage at each gold checkpoint, and the calls of segments (merged and discarded apart), writers and the
session's own turns, with cache reads and catalog costs, and those segment results summed with the rounds in which the
breaker paused segments. A round's requests are its turns and every journaled call it
dispatched, so the run's limits count segments too.

With `--replay-tools`, the loopback replay drives official Pi through each recorded tool batch. Adjacent assistant
records are coalesced into the next tool-call reply; their text, calls and arguments remain, and tools return the
recorded results and error status without executing commands. P5 has no elapsed tool times, so no delays are invented.
This mode requires `--replay --provider loopback --pace immediate --cache session`. `--latency-ms` delays writer
replies. Round rows check every tool result and report HTTP request lifetimes; the replay summary adds overlapping
segment calls, their summed input, peak rolling-minute input and rate-limit errors. These are loopback figures,
with immediate main replies and estimated input sizes, separate from provider latency, cache and rate-limit evidence.

### Token-overhead report

Writer and probes runs end `summary.json` with `overhead` (report `0.6-overhead-report.1`), which `overhead.ts`
computes from the run's own rows. Nothing in it calls a model, so a loopback run gives every column figures and
`packages/coding-agent/test/context-memory-preview-bench-report.test.ts` checks its arithmetic on scripted rows. It
holds `overall`, `byCut` (keyed `P1-cut1` and so on, with the cut's `tier` and `sourceTokens`), and `byTier`: the
four v0.2.3 note-budget tiers with their source-token bounds, the cuts that fell in each, the writer column, and
the committed notes' estimated tokens beside the base and hard allowances their checkpoints froze. Each section has:

| Column | What it counts |
| --- | --- |
| `writer` | Committed work: the calls of attempts that committed, except declined tool calls. Their `input`, `cacheRead`, `cacheWrite`, `cacheWrite1h`, `output`, `reasoning` and `totalInput` tokens, the same figures `perCheckpoint` and `perNoteByte`, and the notes' bytes and estimated tokens against the records they replace. `replacedTokens` is what each checkpoint released, the readable tokens `selectNoteBudget` receives, plus the previous note |
| `retrieval` | The probes' `context_history` calls by operation, the estimated tokens of each call and of what it returned, and the probes' own provider usage per condition. Never pooled with writer usage |
| `discarded` | Known usage of work that committed no note, each call once: `refused` attempts, `crashed` or timed-out units, `toolCallDeclined` responses inside committed attempts, and `preparation` calls whose candidate no checkpoint used. `repairNotCommitted` is the repair-phase share of the first two |
| `usageMissing` | Calls without a usage report: their `count`, by `phases` (`generate`, `repair`, `probe`) and by `purposes` (`compaction`, `preparation`, `probe`). Such a call adds nothing to any total, and each column's own `usageMissing` says how many of its calls it could not count |
| `cache` | Cache reads, writes and 1-hour writes over every call in the section. A write figure reads `not reported` when no call reported one, rather than zero, since Pi records an unreported count as 0 |
| `net` | `savedTokens`, the estimated tokens committed checkpoints removed (the records replaced less the note, once per checkpoint), less `pageBackTokens`: what retrieval read back in (`pageBack.history`) and the excerpts the preview appended (`pageBack.excerpts`, none before WP4). The difference is `netTokens` |

Tokens are the provider's as Pi records them; estimates are `ceil(UTF-8 bytes / 3)`, the preview's own. A crashed
or timed-out unit leaves no row of calls, so the bench reads each unit's call journal, content-free, before it
removes the unit's agent directory; rows keep it as `journal`. Pi's per-call record does not carry 1-hour cache
writes, so `cacheWrite1h` comes from each attempt's summed usage and stays with the attempt. In writer mode every
attempt on a cut counts, so the sums cover `--attempts` copies of each cut; compare the per-checkpoint figures.

Two runs compare on equal terms when `summary.json` records the same mode, provider, model, thinking, cache,
fixtures, attempts, concurrency and Pi version. `--session-settings name=value,...` names preview switches
(`previewReduction`, `previewExcerpts`, `previewPreparation`, `previewWorkNotes`, each `on` or `off`), writes them
into every unit's `pi-context-memory.json`, and records the label under `sessionSettings` with the written switches
under `unitSettings`; an unknown name or value stops the run before any unit starts. `--control <label>` names the
run a candidate compares with under `control`. Without the flag no settings file is written and units run on the
package's defaults. Absolute loopback token counts shift by a few tokens with the output directory's path length,
which enters Pi's system prompt, so compared runs should use labels of equal length.

### Quotation-repair cases

`repair.ts` (cases `0.5.1-repair-cases.1`) plants one to three failing quotations in a faithful note for each
fixture cut, chosen deterministically from the cut's own entries:

| Template | Planted instruction | Passes when the committed note |
| --- | --- | --- |
| `misattributed` | A user's sentence cited to another entry | Keeps it, quoted from a user entry or unquoted |
| `spacing` | A user's sentence with one space doubled | The same |
| `echoed` | A user's ruling the assistant or a tool repeated, cited to another user entry | The same; a quotation cited only to the echo fails |
| `toolOnly` | An order only a tool or the assistant wrote, cited to a user entry | Has withdrawn it |
| `paraphrase` | A user's sentence quoted in other words that no entry holds | Keeps it, quoted from a user entry or unquoted |
| `combined` | A misattribution, a spacing fault and a paraphrase in one note | Passes all three |

A case is kept only when the preview's own diagnosis classifies each planted quotation as intended; templates a cut
cannot carry are listed as skipped. P1 to P3 yield 38 cases. Scoring needs no judge: `silentLoss` counts
committed notes without a ruling a user gave, `promoted` counts instructions quoted only from assistant or tool text,
and `keptUnsupported` counts an order no user gave kept without a quotation. A refused note passes nothing and loses
nothing silently. Each case's scripted repair passes, which `repair.test.ts` checks against the preview's own repair
and validator.

The repair request carries no session prefix, so `--cache` does not affect it, but every repair request opens with
the same rules, about 70% of a typical request. The run's first unit goes alone, so that a provider that caches
prefixes holds the rules before the rest arrive concurrently; `cacheReadShare` reports the share of the repair calls'
input read from cache. The session writer's effort follows
the session's thinking level, and Pi clamps that level to the model's declared levels before the writer sees it: on
`deepseek-flash`, whose map declares no `medium`, a session at `medium` already runs at `high`.

### Prompt cache

In daily use the session's prefix stays cached: every main-model turn sends the same system prompt, tools and
history. The session writer reuses all three and sets no tool choice, as the session does, so it continues that cache.
Before `a2c62fa` it sent `tool_choice: "none"`, with which DeepSeek leaves the tools out of the prompt, and its
prefix ended after the system prompt (see the validation record). The bench reproduces a session's cache state by
default with `--cache warm`, so writer cost and pause are what a session pays. The units of a run share one working directory, and before each cut's compactions one
request with the session's own tools goes over the same history, as the session's last turn would. Each warm-up is
a cold request of its own, one per cut in both modes: budget eight more requests for a run over P1, P2 and P3.
`summary.json` reports them apart under `used.warmups` and `used.warmupCostUsd`. Runs with different labels use
different directories, so one run never warms another and builds compare on equal terms.

`--cache cold` gives every unit its own working directory. Pi's system prompt ends with it, so only the prompt's
opening is shared and the writer pays for the whole history on every attempt. It reproduces the first 0.5.0
provider run, whose writer cost and pause were measured this way. The cache does not change what the model writes,
so refusals, note sizes and probe scores compare across both settings; cost and pause do not.

The run directory holds `summary.json`, per-unit rows without note text (`writer.jsonl`, `compactions.jsonl`,
`probes.jsonl`) and `answers.jsonl` with the synthetic probe replies. Keep it outside the repository. Each writer
call in those rows names the schema envelope removed from its note (`envelope`), and the summary counts them by
shape under `envelopes`, with the attempts that then committed.
