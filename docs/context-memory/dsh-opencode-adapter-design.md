# DSH and OpenCode adapter design

Status: accepted implementation direction, based on source inspection and core-only probes on 2026-10-25 (America/Los_Angeles). Slice baseline: `3932a11daa8746e28961476801b91f3a6ba348ef`, v0.7.1. The first implementation is documented in [host-adapters.md](host-adapters.md): both hosts receive current-session retrieval; DSH writing stops at the public persistence gate below. This design does not certify a complete compaction adapter.

Build one source-linked compaction method and keep the host integrations small. Start with a manual DSH transaction and current-session retrieval. For OpenCode, separate the released 1.x plugin API from the V2 development API: the former is a useful retrieval target; the latter is a candidate for supplying Slice checkpoints, subject to missing history and recovery guarantees.

This design preserves the [roadmap](roadmap.md): v0.7.2 remains repository-source migration; v0.8.0 remains shared preparation. It does not assign adapter work a release number, replace the v0.9.0 host selection, or change Pi's package, commands, checkpoints or stored identifiers.

## Evidence and useful precedents

Versions below identify inspected sources, not a supported-version matrix.

| Source | Inspected baseline | What to reuse conceptually |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Latest listed prerelease `dsh-v0.2.1-rc.3`; also master `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` | Public compaction service, native append-only events, surface replacement, maintenance admission and persistence handles. |
| [OpenCode stable](https://github.com/anomalyco/opencode/releases/tag/v1.19.4) | Latest non-prerelease `v1.19.4`, commit `148842ef7cb1bc34192b3fff57d0f9721ab9c801` | SDK-backed original-message retrieval and tool registration. Its compaction hook customises a prompt, not the final checkpoint. |
| [OpenCode V2 development](https://github.com/anomalyco/opencode/tree/94353780cf289dcecee2866322dbbe1f34d51641) | `dev` commit `94353780cf289dcecee2866322dbbe1f34d51641`; plugin manifest `2.1.4` | `ctx.session.hook("compaction")` and `event.result`, including summary and metadata. Do not infer a stable V2 release from this manifest. V2 has since been released as `@opencode/cli` 2.0.0 on 2026-09-11; this row records the development commit inspected before that. |
| [Better Compact](https://github.com/AshishKumar4/better-compact/tree/217ccef21e2c746dc4cd00a7ac4c65dfd3a89c19) | `217ccef21e2c746dc4cd00a7ac4c65dfd3a89c19` | Native codecs beside the host adapters and a shared internal core. Avoid importing its transcript stores, pruning ladder or fallback semantics into Slice. |
| [OpenCode DCP](https://github.com/Tarquinen/opencode-dynamic-context-pruning/tree/f8232fde1e63c2251687e4d9634bd53ce11568cb) | `f8232fde1e63c2251687e4d9634bd53ce11568cb` | Separate V2 entry point, per-session serialisation, native-message projection and keeping reporting out of model context. Its local compression state and model nudges are not needed here. |
| [dsh-asc](https://github.com/lmst2/dsh-asc) | Current README and architecture description | Recover originals from the host log; keep one compaction service. Its tiered autonomous tools are a different policy, not Slice's implementation model. |
| [dsh-blackhole](https://github.com/Asaiuta/dsh-blackhole) | Current README | Demonstrates a Pi-to-DSH adaptation around the basic summariser hook. Remote opaque state and automatic fallback would change Slice's contract. |
| [dsh-compaction-instant](https://github.com/TsFreddie/dsh-compaction-instant) | Repository archived; the former `KitDoesIt` address redirects here | Historical example of seq-linked recall. Do not use its older peer ranges or event accesses as current acceptance evidence. |

These are references, not new runtime dependencies. In particular, DCP and Better Compact are separately licensed projects; this proposal copies no implementation from them.

## Small shared boundary

Keep `packages/compaction-core` private and bundle it into each host package. Do not move the existing Pi adapter simply to make the directory tree symmetrical. Add `packages/compaction-dsh` and `packages/compaction-opencode` only when they contain working, tested integration code; do not create empty adapter packages now.

| Responsibility | Owner |
| --- | --- |
| Note schema, quote and source validation, bounded repairs, rendering, budgets, call-accounting semantics | Existing core |
| Native records, active branch or lineage, permissions, tool-call completion and persistence | Host, exposed through adapter functions |
| Native-to-core record view and reverse lookup by native identifier | Adapter codec |
| Writer dispatch, cancellation, model resolution and request-envelope reuse | Adapter transport using the shared writer contract |
| Durable pending state, native checkpoint placement, readback and request admission | Adapter lifecycle around the host's own storage |
| Background preparation and segment merging | Existing/planned shared core; outside the first host preview |

Use the existing `SessionRecord`, `PreviewCheckpoint`, validation functions and writer transport boundary wherever they fit. No new adapter registry, dependency-injection framework, universal event bus, service daemon, MCP bridge or vector database is required. A static status record stating host version, adapter version, attachment mode, supported scope and proven guarantee level is enough.

The first integration consists of a codec, a writer binding, a commit/recovery binding and one `context_history` tool. Keep status and explicit recovery in the host's normal command surface. Split files when these responsibilities need it, rather than designing a fixed module count or an arbitrary line budget.

## Core preparation required before a writing adapter

### Native records need an explicit view contract

The core has no host imports, but its structural record vocabulary still resembles Pi: `type: "message"`, `message.role`, `parentId`, `timestamp`, `stopReason`, and separate tool-result messages. A DSH `user/message` event or an OpenCode assistant entry cannot simply be cast to `SessionRecord`.

Define a deterministic, disposable adapter view while retaining a lookup to the unchanged native payload. Clarify the wording in `records.ts` and the specification that currently describes the native payload as the structural record itself. This is a contract clarification, not permission to rewrite native history or a reason to build a second intermediate representation framework.

Required codec properties:

- IDs remain native IDs. DSH uses its actual sequence number in string form, scoped by session identity. OpenCode uses native message or native part IDs only where the API supplies durable, unambiguous parts. Never manufacture a `messageID:index` citation to split a tool result.
- Source order and model-visible order are separate. In DSH, `shadowedRange.start` may be numerically greater than `end` after a replacement. Use `shadowedSeqs` in surface order, not a numeric interval.
- The branch view includes the originals and earlier Slice checkpoints needed for validation. It is not merely the current model window.
- Every field used as evidence enters the deterministic view and canonical hash. Unknown blocks retain their native payload and remain non-citable unless a documented exact-text projection exists.
- Tool-call/result pairing is checked on projected messages, where an embedded tool unit can expand transiently without acquiring new citation IDs. If exact source-role attribution cannot be represented, refuse that case until the small shared representation change is specified and tested; do not relabel tool text as a user instruction.
- A prefix checkpoint has one `coveredThrough` boundary. Non-contiguous middle-range replacement is outside the first preview.

Add golden codec fixtures only for these real host differences: repeated identical messages with different IDs, embedded tools, non-monotonic surface seqs, prior checkpoints, and same-ID changed text. They should invoke the existing validators, not a second acceptance implementation.

### Keep checkpoint hashes and cursor hashes explicit

`latestMemory` and `validateMemoryCheckpoints` already accept `serialization: "jcs"`; non-Pi checkpoints must use it under H2. Pi continues to use its existing byte-compatible hash.

`queryHistory` currently validates an appended snapshot's pinned prefix with `hashEntries`. Its `scopeHash` must therefore follow that cursor contract. Passing `hashCanonicalRecords` as `scopeHash` works on an unchanged snapshot but causes a valid continuation to fail once new records arrive. This was reproduced; it is an integration mismatch, not an existing Pi regression or a demonstrated source-integrity bypass.

The smallest first implementation keeps cursor `scopeHash` and durable checkpoint `sourceHash` distinct, using the current cursor contract on deterministic views. If canonical cursor stability is required, add one explicit serialization option to the existing retrieval path, with Pi as the default, and include the choice in cursor identity. Do not silently change existing cursors, duplicate the retrieval module, or add an unrestricted hash callback. Apply the same review to preparation hashes before enabling background preparation on another host.

### Keep one writer and one recovery contract

Use core `writeMemory` with a host transport. Preserve schema, normal-stop checks, citation and quotation checks, continuation rules, configured writer identity and the existing bounded repairs. Do not replace a failed writer with the native host summariser, a cheaper model or a deterministic text truncator.

A summarisation request must not execute tools. Transport adaptation must preserve usage from failed, cancelled and discarded calls; absent usage is unknown, not zero. Start with synchronous writing. Cache-prefix tuning and background preparation are later measured improvements, not a second writer implementation inside either adapter.

## DSH design

### What the public source establishes

The official [service interface](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/compaction/compaction/src/index.ts) defines `compactIfNeeded`, `compactNow` and `compactRegion`. The [event vocabulary](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/compaction/compaction/src/types.ts) records a start, summary, replacement user message and end; the originals remain in the host log. A summary event and its replacement must remain adjacent.

The [basic backend](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/compaction/compaction-basic/src/index.ts) exposes a protected `summarize()` hook, but its automatic pre-step handler catches some errors and continues. The hook's input contains replayed messages/tools rather than an explicit immutable source-seq manifest; its return type has no general checkpoint-metadata field. Its manual path invokes the internal region transaction directly. Consequently, overriding `summarize()` or only wrapping `compactRegion()` is insufficient evidence for Slice's complete provenance and recovery guarantees.

DSH's [persistence service](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/session/session-persistence/src/index.ts) exposes read handles. `append` and flush have different guarantees. The inspected current `ctx.sessions.flush(session)` returns whether a persistence listener participated: a resolved call with no listener is not proof of durable storage. New code should use supported asynchronous persistence reads rather than the deprecated `eventAt`/`snapshotEvents` accessors.

The released basic backend differs from inspected master, including model-switch handling. Acceptance must run against the installed prerelease itself; master is not a substitute.

### Writing preview

The writing design, decided on 2026-11-03 for track T1 of the
[v0.8.0 plan](v0.8.0-plan.md), is in [DSH writing preview](dsh-writing.md). It
replaces the bounded implementation this section used to describe. Three of
that sketch's assumptions did not survive the rc.5 review. A pending-attempt
marker is unnecessary, because DSH's own `compaction/start` and
`compaction/end` with `error` already make every attempt durable. A registered
extension record is unavailable, so the checkpoint goes into `rawOutput` of the
native `compaction/summary` under U11. Blocking needs no host change, because an
`agent/pre-step` listener may reject. What stays is the rule that the
transaction is written against the public API, never by copying the private
region engine or patching installed files.

## OpenCode design

### Stable 1.x: retrieval first

At v1.19.4, [`experimental.session.compacting`](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/plugin/src/index.ts) returns `{context, prompt?}`. The [host implementation](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/session/compaction.ts) still sends that prompt to its summariser. Returning a validated Slice note as a prompt would not make the host's subsequent answer a validated Slice checkpoint.

The first 1.x adapter should therefore expose current-session `context_history` through the supplied public SDK and report `Traceable`. Prove original-message retrieval after native compaction and restart, including pagination and permissions, before declaring that level. It does not take over compression. Read existing original records on demand; never scrape or rewrite OpenCode's SQLite database and never archive a duplicate transcript.

Do not turn this into a second compression system using request-transform hooks, custom providers or manufactured assistant messages. Those routes may be technically possible, but they are not necessary for this bounded integration and would add a separate commit/recovery mechanism to maintain.

### V2: a separate experimental binding

The inspected [`SessionCompaction`](https://github.com/anomalyco/opencode/blob/94353780cf289dcecee2866322dbbe1f34d51641/packages/plugin/src/promise/session.ts) supports `event.result = {summary, metadata, tokens}`. The [compaction implementation](https://github.com/anomalyco/opencode/blob/94353780cf289dcecee2866322dbbe1f34d51641/packages/core/src/session/compaction.ts) uses that result instead of its model call and publishes the supplied metadata. This is a suitable prospective insertion point; leave `native` absent so an opaque provider window cannot replace the source-linked note.

Three constraints still prevent claiming a complete adapter:

| Constraint | Source finding | Required resolution |
| --- | --- | --- |
| Historical originals | `ctx.session.context()` delegates to [`SessionStore.context`](https://github.com/anomalyco/opencode/blob/94353780cf289dcecee2866322dbbe1f34d51641/packages/core/src/session/store.ts), which loads history bounded by the latest completed compaction. The public SDK has broader operations, but `Plugin.Context.session` does not expose `messages` or `export`. | A supported way for the plugin to read original native records after multiple compactions and restart. Prefer a small public plugin API addition; an explicitly configured public SDK connection is another possible binding. Do not discover a private database path or guess a server endpoint. |
| Commit acknowledgement | Assigning `event.result` occurs before the host publishes and persists the result. A completion notification is not by itself independent storage readback. | Correlate the stored checkpoint to the attempt and read back its metadata, rendering and sources before claiming confirmation. |
| Failure blocking | The session hooks have no typed failure channel in [`PluginHooks`](https://github.com/anomalyco/opencode/blob/94353780cf289dcecee2866322dbbe1f34d51641/packages/core/src/plugin/hooks.ts); rejected Promise callbacks become Effect defects. This does not establish durable protection across subsequent requests or restart. | A supported admission guard, or a tested and explicitly bounded failure mechanism. Do not equate `throw` with a durable request block. |

If these prerequisites are met, write one compaction-hook binding: obtain the complete scoped native snapshot, call the shared writer, validate, return the rendered note plus namespaced checkpoint metadata, and confirm the host's stored result. Persist host/adapter/codec identity and canonical source hash alongside the structured checkpoint. Keep the host's `keepID`/recent-tail semantics aligned with core coverage; after each boundary every original is either covered by a validated checkpoint or still retained.

The first V2 preview keeps native background precomputation off: the hook currently does not expose a clear source boundary for a background-held prefix. Slice's later shared preparation must supply explicit coverage; fetching the current session while an older prefix is being summarised is not sufficient.

Do not automatically call an incomplete V2 implementation `Checked`. That level still requires reliable scoped original retrieval and validated-note insertion. With those proven but no request blocker, `Checked` is accurate; with all recovery guarantees proven, `Gated` is possible. Until then it is an unsupported experimental binding. Keep V1 and V2 entry points separate so installing one does not import the other's SDK.

## Acceptance and work order

| Step | Deliverable | Completion bar |
| --- | --- | --- |
| 1. Core boundary | Native-view clarification, explicit hash contracts, host codec fixtures | Existing Pi bytes and error classes unchanged; canonical source edits detected; cursor continuation behaviour deliberate and tested. |
| 2. DSH manual preview | Installable thin service, one history tool, status and recovery | Install, compact, retrieve originals, reopen, retry failure and remove independently on an official pinned host. |
| 3. OpenCode 1.x retrieval | Small independent entry point using its public SDK | Retrieve pre-compaction originals after two compactions and a restart, with current-session scope and bounded output. |
| 4. OpenCode V2 preview | Compaction hook binding only after history/readback prerequisites | Separate exact-version acceptance; no inferred parity with 1.x or DSH. |
| 5. Automatic behaviour | Existing commit path plus shared preparation | Coverage invariant, bounded cost and measured pause; no second per-host preparation engine. |

Use the current conformance vectors through real codecs, plus focused lifecycle tests:

- Correct citations and exact quotations; absent sources, wrong quotation and changed content under an unchanged native ID refuse with the core's existing classes.
- A repeated message does not cause its quotation to bind to a different ID. A tool call and its result cannot be split at the cut; unknown media is retained or refused within the supported scope.
- Corrupt or lost pending state, write failure and crash at each durable boundary do not resume a protected session. Flush without a persistence listener is not success.
- A second compactor or hook cannot replace a checked result unnoticed. A conflicting native compaction invalidates the attempt; detection is a release prerequisite, not a silent last-writer-wins policy.
- Retrieval cannot cross sessions or sibling branches. A copied/forked checkpoint is refused until its lineage mapping is supported. A source mutation invalidates a cursor, while an allowed append preserves its pinned prefix.
- Two compactions followed by restart preserve originals and coverage. A bounded repeated-cycle fixture checks that the active context contains one current checkpoint, no repeated schema/instruction injection and no accumulating old-summary chain. Report active-note size and retrieval cost, separately from the host's necessary growth in durable evidence.
- Install/update/remove does not change host executables or unrelated settings. Test duplicate provider installation, disabling and compatible rollback explicitly.

Start with deterministic transports and isolated official hosts. A real-provider run is a separate, bounded acceptance exercise with its own request and cost budget; passing mocks does not certify model quality. Core changes must pass the repository's required checks and existing stock-Pi acceptance before a new host ships.

## Probe results from this design review

An isolated copy of the unchanged core ran under Node 24.22.1 with the repository's pinned TypeBox 1.3.27. Calling `runCoreVector` returned the expected outcome for all 34 published vectors under the Pi selector. A supplementary JCS pass returned the expected outcome for 32 applicable vectors; two continuation vectors have only Pi source hashes and were not applicable to that pass. These are direct outcome probes, not the complete test suite or an official-host acceptance run.

The same synthetic history was read in pages before and after appending one record:

| Cursor snapshot hash | Unchanged snapshot | Appended record, original prefix unchanged |
| --- | --- | --- |
| Existing `hashEntries` contract | Continued | Continued |
| `hashCanonicalRecords` passed directly as `scopeHash` | Continued | `HISTORY_CURSOR_INVALID` |

The mismatch occurs in `history.ts` when the cursor's old prefix is compared with `hashEntries(pinned)`. The first implementation can avoid it by using the existing explicit cursor contract; canonical checkpoint hashing remains mandatory for non-Pi checkpoints.

The probes above describe the design review before implementation. No production files were changed during that review; implementation and its separate acceptance boundaries are recorded in [host-adapters.md](host-adapters.md).
