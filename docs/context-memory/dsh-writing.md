# DSH writing preview

Track T1 of the [v0.8.0 plan](v0.8.0-plan.md#track-t1-dsh-writing-parallel-and-not-a-gate).
Status: designed on 2026-11-03 for implementation by Codex cloud; nothing here
is built yet. It applies U11 as the maintainer decided it and settles the
contract questions the plan left to this step, so the implementer writes code
rather than policy. Where this document and the
[adapter design](dsh-opencode-adapter-design.md#dsh-design) differ, this one
wins.

The goal is `Gated` Slice compaction on an unmodified DSH. Slice writes and
validates the checkpoint, DSH's own log stores it, no model request leaves after
a failed or unconfirmed compaction, and `context_history` returns the originals.
Retrieval-only `slice-dsh` stays the default; writing is opt-in per profile.

## Stages

| Stage | Scope | Done when |
| --- | --- | --- |
| 1 | Manual `/compact`, the gate, readback and reopen | Stage 1 acceptance passes on rc.5 and on the newest `next` release |
| 2 | Automatic compaction at a step boundary | The same acceptance with automatic triggers, plus one provider run inside a budget the maintainer approves before its first request |
| 3 | Segments | Only after the plan's WP3 lands in the core; DSH adds dispatch and nothing else |

Each stage is its own pull request. In stage 1 `compactIfNeeded` returns `null`,
so nothing compacts on its own: a session that outgrows the window fails at the
provider until the user runs `/compact`, and the README says so. In every stage
`compactRegion` throws before it writes anything.

## What DSH offers

Checked against the `dsh-v0.2.1-rc.5` source. The public types of
`@deepseek-ai/dsh-compaction` are identical in 0.2.2-alpha.3.

- `CompactionEngine` is an abstract service with three methods. The `/compact`
  command calls only `compactNow`, and nothing outside `compaction-basic` calls
  the other two.
- A compaction is four events: `compaction/start`; the log-only
  `compaction/summary`; the replacement `user/message`, which shadows the range
  and must follow the summary directly; and `compaction/end`, which carries
  `error` when the attempt failed. The format validators admit one open
  compaction at a time and a successful end only after exactly one summary.
- `rawOutput` is an optional member of `compaction/summary` holding content
  blocks. Every format migration from v0 to v4 keeps it as content. In rc.5 the
  chat view expands only `summary`; `rawOutput` appears in the web client's
  Trajectory inspector, on a raw-output tab, and the session controller's
  attachment lookup reads it for images.
- An `agent/pre-step` listener that returns `{ kind: 'reject' }` ends the turn
  as `blocked` before any request is sent. The rejection also discards the
  messages that step had claimed (`packages/core/agent/src/consumed-work.ts`).
- A profile patch addresses bundle rows by id. `disabled: true` on
  `compaction-basic` plus one inserted row swap the engine without touching
  installed files.

## Decisions

**D1, the engine.** Slice subclasses the abstract `CompactionEngine` and ships
it as a second plugin entry, `slice-dsh/compaction`, which registers the engine,
one `agent/pre-step` listener and one `/compaction-status` command. Rejected:
subclassing `BasicCompactionEngine` and overriding `summarize()`. That hook
receives derived messages without event seqs, so citations would have to be
matched back to records by guesswork; the class picks its range by its own
retention policy; and its own pre-step listener continues the turn after a
failure. Also rejected: porting `region.ts`. The four-event sequence is DSH's
public contract and is written fresh against the public API. Basic's range
selection, pressure policy, overflow loop and image recovery are not ported.

**D2, where the checkpoint lives.** The checkpoint is the core's
`MemoryCheckpoint`, unchanged, serialized with the core's `canonicalize` into a
single text block that is the whole of `rawOutput`. `llmStreamCall` stays unset.
Rejected: a tagged block inside `summary`. DSH's chat view renders `summary` as
Markdown, and other consumers may copy it into text a model reads. `rawOutput`
stays out of the chat, shows up only in the Trajectory inspector's raw-output
tab, where a structured record is what a reader expects, survives every
migration, and is the member DSH declares for the complete output of "other
summarizers", which Slice is. `llmStreamCall: true`
would claim exactly one call through `ctx.llm.stream()`, and a repair or a
chunked note makes more. The status command and the package README say the
checkpoint relies on a field DSH owns, as U11 requires. When DSH declares a
backend field (T2), new checkpoints move there and the codec reads both.

**D3, the transaction.** `compactNow` runs inside `agent.runMaintenance`. Stage
2's automatic path calls the same function with the open turn as owner.

1. Flush, and refuse if `ctx.sessions.flush` returns false. Read the log
   through a read handle and build records with the codec. Refuse, before
   anything is written, when the session is seeded, the log holds an open
   compaction or one by another engine, an earlier Slice checkpoint fails
   `validateMemoryCheckpoints(records, undefined, "jcs")`, or no range
   qualifies under D4.
2. In one synchronous run, confirm the in-memory log has not grown since the
   read and append `compaction/start`, with `sourceCommandId` when `/compact`
   passed one.
3. Write the note with the core's `writeMemory` through the transport in D5.
4. Recheck that the selected span still has the same seqs and the same token
   meter prices.
5. Append three events with no `await` between them. `compaction/summary` holds
   the rendered note as one text block in `summary`, the checkpoint in
   `rawOutput`, `shadowedRange`, `shadowedSeqs`, a `shadowedTokenCount` summed
   from the shadowed nodes' `heuristicTokens` in `ctx.tokenMeter.measure` (DSH's
   shadow-price protocol), the writer's `provider` and `model`, and `usage`
   summed over the writer's calls. The replacement `user/message` carries the
   same text, `source: compactCheckpointSource(compactionId, sourceCommandId)`,
   `surfaceOp: { op: 'replace', startSeq, endSeq }` and
   `sourceEventSeqs: [startSeq, summarySeq, ...shadowedSeqs]`.
   `compaction/end` closes the attempt.
6. Flush, then read back as D6 describes.

Any failure after step 2 appends `compaction/end` with `error` set to the core's
code and message, flushes, and leaves the session blocked. `compactNow` then
throws `ManualCompactionError` with the matching code (`summary`, `changed`,
`commit`, `persistence` or `cancelled`), so `/compact` prints DSH's own text.

**D4, the range.** It starts at the first surface node after the system head and
ends where the core's cut leaves the retained tail, chosen with `chooseCut` as
the Pi preview chooses it, with no new setting. The end must pass
`toolPairingBalancedAfter`, and every surface node after the system head whose
seq is at or below the end must fall inside the range; otherwise nothing is
compacted and the status says why. `coveredThrough` is the end's seq, so each
checkpoint covers a prefix of the log, which is what the core's validator
expects.

**D5, the writer.** A `WriterTransport` over `ctx.llm.stream()` with role
`session`. A `handover` request is the session's current request (system head,
the request header's tools, the surface's messages in order) followed by the
core's instruction as one final user message, so the provider's cache serves
it. `chunk` and `repair` requests stand alone without tools. Tool calls are
answered with the core's `TOOL_CALL_DECLINED`. The writer is the session's
routed model at the session's reasoning setting; U5 keeps the synchronous writer
mirroring the session. The Pi preview's `preview/writer.ts` is the reference.

**D6, the gate and readback.** One pre-step listener awaits `next()` first and
then decides, so its place among listeners does not matter. Its state is kept
per session in memory and derived from the log, never stored anywhere else.

- **Clear:** no Slice compaction yet, or the latest one ended without error and
  read back.
- **Blocked:** the latest Slice compaction is open, ended with an error or
  failed readback, or an earlier checkpoint no longer validates
  (`CONTEXT_SOURCE_CHANGED` and the core's other codes).

After a process start, the first pre-step of a session reads its log once and
derives the state; later steps use the cached value, which only a Slice
compaction changes. Readback after a commit requires a flush that returned true,
then a read handle showing the summary, the replacement directly after it with
the same `compactionId`, a clean end, and `validateMemoryCheckpoints` returning
this checkpoint. Anything else is blocked with `CONTEXT_STORAGE_UNCERTAIN`. Only
a later Slice compaction that reads back clears a block. Because DSH discards a
rejected step's claimed input, the block notice tells the user that the message
was not sent and to run `/compact` before sending it again. T2 asks DSH for a
rejection that keeps that input queued.

**D7, an interrupted compaction.** A `compaction/start` without an end, found on
the first read after a process start, keeps the session blocked until `/compact`
commits. Stage 1 must find out what rc.5 itself does with such a start on resume
(a later seed boundary may close it) and whether the session still opens once a
turn has been appended after it. The adapter closes it with
`error: "interrupted"` only where DSH's validators admit that append. If the
session cannot reopen at all, that is a stage 1 finding to report, not a reason
to patch DSH.

**D8, the codec.** A `compaction/summary` whose `rawOutput` holds a Slice
checkpoint becomes a core `compaction` record: `summary` from the event's text,
`details` from the checkpoint. Its replacement message becomes an opaque record,
so the next writer receives the previous note once, as `previous`, and never as
an original. Everything else maps as it does today, and retrieval output does
not change.

**D9, scope.** Fresh, persistent, unseeded sessions whose log holds no
compaction by another engine. In every other session writing refuses and the
status names the reason; retrieval keeps working. Forks stay refused as they are
today.

**D10, installation.** Writing is opted into through the user's profile patch:

```yaml
- id: compaction-basic
  disabled: true
- insert:
    - id: slice-compaction
      name: slice-dsh/compaction
```

The package's own bundle patch keeps inserting only `slice-history`. Acceptance
records what happens when both engine rows are enabled. If DSH loads both
without complaint, `slice-dsh/compaction` refuses to start with
`CONTEXT_COMPACTOR_CONFLICT` and names the row to disable; that is the only
load-time check.

**D11, the automatic trigger, stage 2.** The same listener, once `next()` has
returned and the state is clear, compacts when `ctx.tokenMeter` measures the
session at or above the core's `requestLimit`, with the window from
`ctx.llm.resolveModelInfo` and a reserve of 16,384 tokens (Pi's default) or the
routed request's output reservation, whichever is larger. A failure rejects the
step. A compaction inside an unfinished turn passes the turn's original requests
as `activeRequests`, as the Pi preview does. There is no configuration. If
acceptance on a listed route shows the default is wrong, one key, `reserveTokens`
as Pi names it, may be added.

## Do not add

Review sends back a pull request that contains any of these.

- **Sidecar state.** No marker files, journals, attempt stores, caches on disk
  or second history. The Pi preview keeps a failure store because stock Pi's log
  cannot hold a failed attempt; DSH's log can, so `failure-store.ts` and
  `failure-io.ts` are not ported.
- **Configuration.** None in stage 1. No feature flags, environment variables,
  debug or strict modes, writer selection, thresholds, timeouts or telemetry
  switches. Stage 2 may add the one key in D11 on evidence.
- **Checks the core or the host already make.** The core validates notes,
  quotes, budgets and hashes, and the adapter calls it once per commit and once
  per readback. Do not re-validate the note schema, recompute hashes beside the
  core, re-check seq contiguity outside the codec, or re-implement DSH's format
  rules. Use the core's `CONTEXT_*` codes and DSH's `ManualCompactionError`
  codes, not a new error hierarchy.
- **Recovery the contract forbids.** No retry loops or backoff around the
  writer beyond the core's single repair, no fallback writer, no fallback to
  `compaction-basic`, and no automatic clearing of a block.
- **Integrity theatre.** No signing, HMAC or encryption of the checkpoint. The
  source hash binds the note to its evidence, and a program that can edit the
  session file is already inside the local trust boundary
  [SECURITY.md](../../SECURITY.md) describes.
- **Generality.** No adapter framework, strategy interfaces, registries or
  hooks "for other hosts". The core is the shared layer.
- **Host surgery.** No edits to installed DSH files, no mutation of
  `KNOWN_SESSION_EVENT_TYPES`, no `appendPluginRecord`, no copy of the private
  `region.ts`.
- **Content in logs.** Status and log lines carry codes, seqs, counts and
  timings only, never note text, source text or provider payloads.
- **Weight.** No new runtime dependencies beyond the DSH peers the package
  already declares and `@deepseek-ai/dsh-compaction`. No snapshot tests and no
  tests that only check a mock was called.

## Files

| Path | Change |
| --- | --- |
| `packages/compaction-dsh/src/compaction.ts` | New: the engine, the transaction (D3), the gate (D6) and the status command. Split only if it passes about 400 lines |
| `packages/compaction-dsh/src/writer.ts` | New: the transport (D5) |
| `packages/compaction-dsh/src/codec.ts` | D8 |
| `packages/compaction-dsh/package.json` | The `./compaction` export and the `@deepseek-ai/dsh-compaction` peer |
| `scripts/context-memory-adapters-build.mjs`, `scripts/context-memory-adapters-check.mjs` | The second entry and its regressions |
| `packages/compaction-dsh/test/compaction.test.ts` | Stage 1 regressions |
| [host-adapters.md](host-adapters.md), the package README, `CHANGELOG.md` under Unreleased | What the preview does, the opt-in patch, the reliance on a DSH field |

`packages/compaction-core` is out of bounds: the mainline changes it in WP1 to
WP3. If stage 1 seems to need a core change, stop and say so in the pull
request. The Pi preview, the resident runtime, version strings and the
evaluation pin are out of bounds as `AGENTS.md` already says.

## Stage 1 acceptance

Synthetic, through `context-memory-adapters-check.mjs` with DSH's own Session
and JSONL components:

1. `/compact` on a fresh session appends the four events in order. Readback
   validates under `jcs`, the replacement carries the rendered note and no JSON,
   and `context_history` reads a shadowed original by its seq.
2. A writer failure (invalid JSON, a refusal, an abort) ends the attempt with
   `error`; the next pre-step rejects; a later `/compact` that succeeds clears
   the block.
3. A source changed during the writer call fails with `changed` and replaces
   nothing.
4. A flush that returns false refuses before `compaction/start`; a flush that
   fails after the commit leaves the session blocked.
5. A process that stops after `compaction/start` reopens blocked, and `/compact`
   recovers it (D7).
6. Two chained checkpoints: the second's `previous` is the first note, both
   validate after a cold reopen, and the surface holds one Slice replacement,
   not a chain of them.
7. A seeded session, a session holding a basic compaction, and `compactRegion`
   all refuse without writing.
8. Removing the D10 patch returns the profile to `compaction-basic`, and a
   session Slice compacted opens and compacts under it.

On the installed host, with `context-memory-adapters-acceptance.mjs` and the
loopback provider: rc.5 and the newest `next` release, installed by name, the
D10 patch applied, fixture P5 through two Slice compactions and one forced
failure, a reopen in the CLI, and `context_history`. No provider is called in
stage 1.

## Handing off

Codex cloud starts a branch from `claude/determined-carson-h13gug` at the commit
that added this document, or from `main` once
[youxi-huang/slice#114](https://github.com/youxi-huang/slice/pull/114) has
merged, and opens its own draft pull request for stage 1. Its first step is
D7's question, since a session that cannot reopen after an interrupted
compaction changes the design. A finding that contradicts this document goes
into the pull request as a question rather than into the code as a
workaround.

## Source map, DSH rc.5

| Path | What it settles |
| --- | --- |
| `packages/compaction/compaction/src/index.ts` | `CompactionEngine`, `ManualCompactionError`, `ManualCompactAgentContext.runMaintenance` |
| `packages/compaction/compaction/src/types.ts` | The four events, `rawOutput`, `llmStreamCall`, adjacency |
| `packages/compaction/compaction/src/checkpoint.ts` | `compactCheckpointSource` |
| `packages/compaction/compaction-basic/src/index.ts` | Basic's pre-step listener that continues after a failure; `/compact`'s only caller path |
| `packages/compaction/command-compact/src/index.ts` | How `/compact` maps `ManualCompactionError` codes to text |
| `packages/core/agent-loop/src/agent.ts` | `reject` ends the turn as `blocked` |
| `packages/core/agent/src/consumed-work.ts` | A rejection discards the claimed input |
| `packages/client/ui-chat/src/client/conversation-nodes/command.ts` | The chat view renders `summary` |
| `packages/client/ui-trajectory/src/client/trajectory-compaction-definition.ts` | The Trajectory inspector shows `rawOutput` |
| `packages/session/session-format-v0-to-v1/src/dispositions.ts` | `rawOutput` is an admitted member |
| `packages/session/session-format-v3-to-v4/src/content.ts` | `rawOutput` stays content through v4 |
| `packages/bundle/base/cordis.patch.yml` | The `compaction-basic` row and the patch grammar |
