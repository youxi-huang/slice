# Source-linked context compaction: core specification

Status: accepted for the 0.7.0 release, work package WP0 of the
[v0.7.0 plan](../../../docs/context-memory/v0.7.0-plan.md); maintainer review
completed 2026-10-22. The closed set enters this specification as
`PROJECT_CODES` stands at that date; admitting the adapter-local preparation
and recovery families is deferred, a candidate decision for 0.8.0 when
preparation becomes load-bearing. This document states the method without naming a
host: a host supplies records, extension points and transport, and the core
owns the formats, the checks and the refusal classes. The
[roadmap](../../../docs/context-memory/roadmap.md#architectural-direction)'s
0.7.0 entry is the binding authority for its scope.

Three conventions hold throughout:

- **Checks are cited as code.** Every guarantee in this specification names the
  function that enforces it, cited as module and export. A bare module name is
  this package's `src/`, where the 0.7.0 lifts landed it (the classification
  table of the v0.7.0 plan maps each module's origin). A check that is host
  work by construction — the controller's projection and payload guards
  (`controller.ts` `PreviewMemoryController`), the durable failure store
  (`failure-store.ts`), writer transport resolution (`preview/writer.ts`
  `resolveWriterModel`) — is cited from the reference adapter under
  `context-memory/preview/`. A guarantee without an existing check is not
  stated as guaranteed.
- **Refusals are classes, never text.** Every violation this specification
  names raises an error class from the closed set `PROJECT_CODES` in
  `events.ts`. The `CONTEXT_` and `HISTORY_` codes of that set are stable
  identifiers of this specification (decision H7): conformance matches on
  them, message wording may change freely, and no future project rename
  changes them. Renaming a code is a breaking specification change.
- **Examples are invented.** No conformance vector, example or fixture derived
  from this specification may carry a session log, a credential, real note
  content or a local file path (rule K12).

## The record model

The durable facts of a session are its records. They live in the host's own
storage; the core keeps no copy of history, and every view the core computes
is derived on demand and disposable (rule K5). The core never invents a record
ID and cites only the host's own IDs. A compatible native record satisfies
the structural model below (`records.ts`) directly. Otherwise the adapter
supplies a deterministic, disposable view and keeps an exact lookup to the
unchanged native payload (rule K4). This view is never a second stored transcript.

A **branch** is a finite, ordered sequence of records: the ancestor chain from
the session's first record to one leaf. All validation, retrieval and
reduction in this specification is computed over one branch given as an
argument, never over host state read behind the caller's back.

### Record

Every record carries:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | nonempty string | The host's own identifier. Only IDs of at most 64 characters are citable (the note schema's bound) or readable by ID (`history-view.ts` `readTokens` prices longer IDs at zero, and the query schema rejects them). IDs should be unique on a branch; where a host permits duplicates, coverage resolves to the first occurrence and citation text to the latest occurrence preceding the consumer, exactly as `notes.ts` `validateMemoryCheckpoints` resolves them. |
| `parentId` | string or null | The preceding record's ID; null on the first record. A linear branch satisfies `record[i].parentId === record[i-1].id` (checked by `preparation-candidate.ts` `freezePreparationInput`). |
| `kind` | string | The record's type discriminator. The values below are frozen identifiers of this model; a kind the core does not recognize passes through opaque, normalizes to empty text, and is therefore not citable. |
| `timestamp` | string | The record's stored creation time, parseable to milliseconds. Time-dependent rules (the reduction's idle trigger) read gaps between consecutive records' timestamps, never a clock. |

When the native record already satisfies the model, its extra fields travel
unchanged. A codec for a different native format must put every evidence field
into structural fields or opaque payloads covered by canonical hashing; placing
it only on an extra top-level property does not cover it. Native message or part
IDs remain citations; a codec may not manufacture IDs to split embedded tools.
Native append order and the host's current model-visible order are distinct.
The core never rewrites either. The compatibility serialization hashes the
complete supplied record; the canonical form hashes structural fields and their
opaque payloads (see "The source hash"). Existing Pi bytes remain unchanged.

### Kinds

The core distinguishes six kinds. Their discriminator strings are stored
identifiers and do not change.

- **`message`** — one conversation message. Carries a `message` object with a
  `role` string. Recognized roles and their fields:
  - `user` — `content`: a string, or an array of content blocks.
  - `assistant` — `content`: an array of blocks; `stopReason`: one of `stop`,
    `length`, `toolUse`, `error`, `aborted`; optional `errorMessage`. An
    assistant record with `stopReason === "stop"` is the completed-turn
    boundary every turn-sensitive rule in this specification uses
    (`notes.ts` `inProgressRequests`, `reduction.ts` `reduceRecords`).
  - `toolResult` — `toolCallId`: the paired call's ID; `toolName`; `isError`:
    boolean; `content`: an array of blocks.
  - `bashExecution` — `command`, `output`: strings; `exitCode`: number;
    optional `fullOutputPath`; optional `excludeFromContext` (a result the
    user kept out of context is never excerpted).
  - Any other role is allowed; it normalizes through its `content` field when
    one exists.

  Content blocks the core recognizes: `{type: "text", text}` and
  `{type: "toolCall", id, name, arguments}`. Any other block type is retained
  opaque and normalizes to a fixed placeholder line.

- **`compaction`** — a committed checkpoint. Carries `summary` (the stored
  rendering, a string), `details` (the checkpoint format below when the
  checkpoint is this method's), `firstKeptEntryId` and `tokensBefore`.

- **`custom`** — an extension record, discriminated by `customType` with a
  `data` payload. `customType === "context-memory-note"` (the constant
  `CONTEXT_NOTE_TYPE` in `identity.ts`) marks a work note.

- **`custom_message`** — auxiliary text shown to the model: `content` is a
  string or an array of parts, of which `{type: "text", text}` is readable.

- **`branch_summary`** — a host-written branch summary: `summary` is a string.

- **`context_edit`** — a host's retry omission: `targetId` names the omitted
  record, `replacement` is null for a pure omission.

### Normalized text and role

Two pure functions, `sourceText` and `sourceRole` in `notes.ts`, define each
record's normalized form. Every citation, quotation, search, excerpt and hash
property in this specification reads records through them.

`sourceText(record)` is:

- for a `message` record with role `bashExecution`: the JSON serialization of
  `{command, output, exitCode, fullOutputPath}`;
- for any other `message` record with a `content` field: the string itself, or
  the blocks joined by newlines — a `text` block contributes its text, a
  `toolCall` block the JSON of `{tool: name, arguments}`, and any other block
  a fixed placeholder stating that the content is retained in the original
  record and not inferred;
- for a `custom_message` record: its text parts joined by newlines, images
  replaced by a fixed placeholder;
- for a `branch_summary` record: its `summary`;
- the empty string for everything else, checkpoints included. A record whose
  normalized text is empty is **unreadable**: it cannot be cited, quoted,
  searched or excerpted, and citing it refuses with `CONTEXT_NOTE_SCOPE`.

`sourceRole(record)` is the message's `role` for a `message` record and the
record's `kind` otherwise.

### The tool unit

A tool call and its result form one unit that is never split (rule K4). The
call is a `toolCall` block inside an assistant message; the result is the
`toolResult` record whose `toolCallId` matches the block's `id`.
`guards.ts` `assertToolPairs` enforces the unit over a projected message
sequence and refuses with `CONTEXT_TOOL_BOUNDARY` when an assistant turn
begins over unresolved calls, a result matches no pending call, user input
interrupts an unfinished batch, or a batch is still open at the end. The
reduction (rule G5 below) replaces only a result's text and keeps the call
verbatim, so the unit survives every derived view.

### Projected messages

Hosts project records into the model's context. The core's view functions
consume that projection structurally as well: a projected message carries
`role`, optional `toolCallId` and `content` (`reduction.ts`
`ReducibleMessage`). `applyReduction` and `assertToolPairs` operate on this
shape; the core never builds the projection itself.

### The reduction's view of a record

`reduction.ts` `ReductionRecord` is the minimal shape the first lifted module
reads — `id`, `type` (this model's `kind`), `timestamp`, `message` (`role`,
`stopReason`, `toolCallId`, `toolName`, `isError`, `content`), `customType`,
`summary`, `details`, `data` — and is the pattern for retyping every other
module: the record model above is its closure over what the remaining
classified modules read. WP1's retyped shapes follow this section.

## The note format

A note is one JSON object with exactly seven top-level keys, defined by
`noteSchema` in `notes.ts` (`additionalProperties: false`): six fact sections
— `instructions`, `failedPaths`, `reasons`, `state`, `nextSteps`, `files` —
and `gaps`, the open questions.

Each fact section is an array of facts. A fact has:

| Field | Bound | Meaning |
| --- | --- | --- |
| `text` | string, 1–4000 characters | One fact, one line. Before commit every fact and gap is folded onto one line (`notes.ts` `oneLineNote`), so model-written text cannot open a heading or a section of the stored rendering. |
| `sources` | 1–20 unique strings, each 1–64 characters | Required on every fact: the record IDs that support it. A fact without sources fails the schema. |
| `quote` | optional string, 1–4000 characters | A verbatim quotation. At least one cited source's normalized text must contain it character for character. |
| `supersedes` | optional array of up to 20 strings, each 1–64 characters | Record IDs whose earlier facts this fact replaces. Each must name a readable record on the branch. |

Section bounds: `instructions`, `failedPaths`, `reasons` and `files` hold at
most 40 facts each; `state` holds 1–40 facts and is the only section that may
not be empty; `nextSteps` holds at most 5. `gaps` is an array of at most 20
strings of at most 1000 characters, carrying open questions without sources.

A **work note** is the in-task variant a session model records as data about
its own work (`work-notes.ts` `workNoteSchema`): the same fact shape with a
one-line pattern enforced in the schema itself, `state` required, the other
sections optional, and **no field for instructions** — a work note cannot
mint authority. `validateWorkNote` maps it into the note shape with
`instructions` empty and validates it against the branch it was written on,
under a 2000-token budget; an invalid work note is not evidence and is
ignored by later merging (`workNotes`).

### The two removable answer envelopes

A writer asked for the note object sometimes returns it wrapped in its
schema's keywords. Exactly two shapes are removed, one level deep, by
`note-envelope.ts` `removeNoteEnvelope`, and only when the seven section keys
are exactly what remains:

- **`type`**: a string `type` key beside the seven sections — the `type` key
  is dropped;
- **`schema`**: an object with exactly `type`, `properties` and `required`,
  whose `properties` holds exactly the seven sections — `properties` is
  taken.

Every other answer is passed through as it came, and **nothing else is ever
rewritten**: what envelope removal returns still passes every commit check
before it can be stored, so no unchecked text reaches a checkpoint.

## The checkpoint format

A checkpoint is a `compaction` record whose `details` carry (the
`MemoryCheckpoint` shape in `notes.ts`):

| Field | Meaning |
| --- | --- |
| `kind` | The constant discriminator `pi-context-memory` (`identity.ts` `CONTEXT_MEMORY_KIND`). A frozen stored identifier: it keeps its name through any project rename, so existing checkpoints keep opening. |
| `version` | The format version, currently `1` (`CONTEXT_MEMORY_VERSION`). An unsupported or malformed version refuses with `CONTEXT_NOTE_VERSION`. |
| `note` | The committed note, exactly the note format above. |
| `coveredThrough` | The ID of the last record the note covers. It must name a record on the branch that precedes the checkpoint record. |
| `sourceHash` | The source hash (next section) of the covered prefix: the branch's records from its start through `coveredThrough`, inclusive. |
| `snapshot` | `{sessionId, leafId, lastCheckpointId}` — the identity of the attempt that wrote the checkpoint. |
| `writerModel` | The `provider/model` that wrote the note. |
| `chunkCount` | How many writer requests produced the note. |
| `build` | The build identifier of the package that committed it. |
| `noteBudget` | Optional frozen budget policy (see Validation); absent on checkpoints written before tiered budgets, which validate under the 6000-token default (`config.ts` `storedNoteLimit`). |
| `continuation` | Optional: the IDs of the original user requests pinned for an in-task handover, in order. |

The checkpoint record also carries, outside `details`:

- `summary` — the stored rendering. It must begin with the exact rendering of
  the validated note (`notes.ts` `renderNote`) and, when `continuation` is
  present, end with the exact rendering of the pinned requests
  (`renderContinuation`); a checkpoint that lists carried user messages must
  end with their exact rendering (`work-notes.ts` `renderUserMessages`,
  checked by `assertUserMessages`). An edited rendering fails like an edited
  quote. The stored rendering's bytes are the adapter's to keep: the
  reference adapter keeps them byte for byte across versions (rule K3), and
  derived projections of the summary are the core's and recomputed, never
  stored.
- `firstKeptEntryId` — the record from which every original stays in the
  model's context verbatim, or the reserved value `context-memory:keep-none`
  (`identity.ts` `CONTEXT_KEEP_NONE`) when no original survives the
  compaction in context.
- `tokensBefore` — the estimated context size the compaction replaced.

An extended checkpoint (`contracts.ts` `PreviewCheckpoint`) may add
observational **preparation metadata** — `preparation: {version: 1, path:
"complete" | "prefix" | "notes" | "segments" | "sync", candidateId?, callIds?,
noteIds?, segmentIds?, notesFallback?, preparationFallback?,
segmentsFallback?, segmentsWaitMs?}` — linking the checkpoint to the prepared candidate or the
merged segments and the journaled calls that produced them, recording why
work notes, preparation or segments did not serve it, and how long the boundary
waited for a segment in flight; and `userMessages`, the IDs of the user
messages a notes-path checkpoint renders verbatim. Neither field extends the
checkpoint's source scope; checkpoints without them remain valid. An adapter
for a host other than the reference host additionally identifies the host and
adapter that wrote the checkpoint; the reference adapter writes no such
field, so its checkpoints keep their format and still open in earlier
versions.

**Lineage.** Earlier checkpoints on the branch are summarized for the model by
a derived projection (`notes.ts` `checkpointLineage`): per checkpoint, a
readable anchor record at or before its `coveredThrough` and up to three
opening state sentences, bounded to 600 estimated tokens by dropping middle
items first and the newest last (`shrinkLineage`). Lineage is computed from
stored checkpoints by the host's assembly, never written by the writer, and
its anchors are search targets, not citable sources.

### Coverage rules

These rules are stated so that 0.8.0's prepared segments slot in under the
same commit checks without a format change (rule K11):

1. A checkpoint covers exactly one intact prefix of its branch, ending at
   `coveredThrough`; `sourceHash` is that prefix's hash.
2. The cut releases only covered records: `firstKeptEntryId` names a record
   inside the covered prefix or the position immediately after it, and every
   record after the covered prefix stays in context verbatim, as any newer
   message does in an ordinary conversation.
3. A checkpoint covers only what its writer saw: the records of the covered
   prefix were the candidate's sources (for a prepared candidate, the frozen
   snapshot's `coverage`; for the notes path, the merged work notes and every
   covered user message; for the synchronous writer, the uncovered entries it
   was given). A prefix commit of a stale candidate is permitted only when
   the candidate's covered prefix is intact and every user message in it was
   seen (`preparation-candidate.ts` `reusablePrefix`).
4. Checkpoints nest: a later checkpoint's covered prefix contains every
   earlier checkpoint on the branch, and each validates against its own
   prefix, oldest first (`notes.ts` `validateMemoryCheckpoints`).
5. A future boundary that merges validated segments must produce a checkpoint
   satisfying rules 1–4 under the full commit checks; nothing in this format
   changes for it. [Segments](#segments) states the chain such a boundary
   merges.

### Segments

A segment (`segments.ts`) is a preparation candidate over a closed range of
the branch. Beyond the candidate's snapshot it names the first record of its
range, `coveredThrough` being the last, and the hash of the validated segments
before it. Its note cites only records inside the range; `supersedes` may name
earlier ones. A note that cites outside the range is refused with
`CONTEXT_NOTE_SCOPE`.

A chain starts at the record after the base checkpoint's `coveredThrough`, or
at the branch's first record when there is no checkpoint. Each link starts at
the record after the previous link's last and names the chain before it. The
boundary merges the longest prefix of valid links. A link ends the chain when
it is not contiguous, names another chain, no longer classifies as a valid
candidate, or was written by a writer that missed a user message in its range;
no link after it is merged out of order. A base checkpoint without a
`coveredThrough` starts no chain.

The core chooses each range (`segments.ts` `nextSegmentRange`). A range ends at
the branch's last record: a stopped assistant message or the last result of a
complete tool batch. Every tool call in the range must have its result; a
partial parallel batch defers without advancing the chain. The first link of
an interval starts after one range of new history, or at half the trigger when
carried context reaches it first, and covers everything uncovered. Each later
link waits for `segmentRangeTokens` of new history, 15 % of the trigger between
8,192 and 32,000 tokens, measured as compacted sources are. Earlier starts can
pay for segments even when a session never approaches its trigger.
These are starting values that 0.8.0's evaluation measures.

The segment writer is the session writer (`writer.ts` `WriteMemoryOptions`
`segment`): the session's request through the range's last record, closed by
one instruction that names the range, attaches the current merged note as
`previousNote` and asks for what the range adds or changes, citing only the
range. A fixed writer writes no segment. Writers often restate the previous
note, so before the range check the writer keeps a segment note to its range
(`scope-diagnostics.ts` `withinSegmentRange`): a fact that cites only earlier
records is dropped, since the merge carries the previous note; a fact that also
cites the range keeps those sources alone; a plan with a step that rests only
on earlier records is dropped whole, so the previous plan stands; `supersedes`
stays as written. Nothing is added, and the note is validated again, so a
segment left without a state fact of its own is still refused.

The merge (`work-notes.ts` `mergeNotes`) adds each note's instructions and facts
in order, drops earlier items whose sources a later item supersedes, and keeps
the newest nonempty plan and the newest listed gaps; a segment lists gaps only
when it names some. A carried instruction is retired only by a ruling: a later
instruction that supersedes its source and cites a user message in the note's
own range, since only the user changes a ruling. A work note has no
instructions and so retires none. The merge refuses, and the synchronous
writer compacts instead, when a superseded source supports more carried
instructions than rulings replace (`instruction-superseded`), when it supports
more earlier items in all than the note gives in their place
(`ambiguous-supersede`), or when the result exceeds the note schema (`schema`).
A merged note is committed under the full commit checks, as rule 5 requires.
The reference adapter commits it for its prefix only when the originals that
would stay verbatim after the chain hold at most `segmentRangeTokens` of the
trigger; a longer tail is history the chain did not cover, and the synchronous
writer compacts instead (`tail`).

At a boundary that needs more coverage, U8 allows a wait of at most 15 seconds
for the active segment call. The most recent completed writer or segment call
in the current session supplies its duration estimate. Subtract the active
call's time since dispatch; wait only if the estimate fits the remaining wait.
With no completed call, retain the existing wait. A skipped wait falls back as
`in-flight` and records no `segmentsWaitMs`. The estimate remains in memory
across checkpoints and is never persisted or reconstructed from a journal.
Skipping a wait does not abort the segment or relax any commit check.

**Coverage invariant.** After every boundary, each original after the base
checkpoint's coverage is covered by a committed checkpoint, by a merged
segment, or is still in context verbatim, and never by none of them.

## The source hash, by its properties

The source hash binds a checkpoint to the bytes of the records it covers.
Citations alone do not detect changed content under an unchanged record ID;
the hash exists for exactly that case. Its required properties:

1. **Deterministic.** The same record sequence always produces the same hash,
   across processes, reopens and platforms.
2. **Content-sensitive.** Changing any covered record's stored content —
   under the same ID included — changes the hash.
3. **Prefix-composable.** The hash of a prefix of length `n` is computed over
   exactly the same per-record bytes as the whole-sequence hash: hashing
   records one at a time and reading the digest at each requested boundary
   yields every prefix hash in one pass (`identity.ts` `hashEntryPrefixes`
   shares the serialization and framing of `hashEntries` byte for byte).

Validation compares, never recomputes around: a stored `sourceHash` that does
not equal the hash of the current covered prefix refuses with
`CONTEXT_SOURCE_CHANGED`. An invalid prefix boundary, by contrast, is a caller
fault, not a refusal: `hashEntryPrefixes` raises an internal invariant error
(`CONTEXT_SOURCE_PREFIX`) outside the closed set, and no conformance vector
matches on it.

**The Pi adapter** satisfies the properties with `identity.ts` `hashEntries`
over the native entries: SHA-256 over the sequence of
`JSON.stringify(entry)` + one newline byte (`0x0A`) per entry, hex-encoded.
This is byte-compatible with every stored checkpoint, and keeping it is a
compatibility requirement of the adapter (rule K3). Its known limit is
recorded rather than hidden: it hashes the host's serialization, so
reordering a record's stored fields without changing their values also
changes the hash. Migrating Pi's stored checkpoints off this form is the
roadmap's unassigned source-hash follow-up with its own compatibility plan,
not part of this specification.

**Every other host** uses the canonical serialization from its first release
(decision H2): RFC 8785 (JCS) canonical JSON of each record's normalized form
— the structural fields the record model defines — framed per record with the
same newline byte `hashEntries` uses, SHA-256 over the sequence, hex-encoded.
It is implemented in `canonical.ts` (`hashCanonicalRecords`), and a host opts
in through the `serialization` parameter of `latestMemory` and
`validateMemoryCheckpoints`.
Property 3 holds by the same one-pass construction. Under this form,
reordering fields does not change the hash; changing any modeled field does.

Conformance vectors include cited content changed under an unchanged record
ID, and the change must be caught under both serializations.

## Validation and the commit gate

No model decides a commit. Commit checks are deterministic functions of the
candidate and the branch; a model may judge support offline, on samples,
during evaluation, but never decides a commit. **The host locates and the
writer decides**: when a quotation fails, the host reports where the text
actually is and leaves the choice to the writer — no adapter rebinds a
quotation to another record, not even a unique match, because text found only
in an assistant message or a tool output would silently become a cited user
ruling (rule K7; rule R1 of the v0.5.0 plan and the roadmap's adapter rules,
which this section carries verbatim in substance).

### The pipeline

A candidate answer passes these stages in order; the first failure refuses
with its class, and no stage ever rewrites content other than the three listed
mechanical steps (envelope removal, citation pruning and line folding):

1. **Parse.** The answer must be one JSON value, after stripping an optional
   Markdown code fence. A response that did not stop normally or that
   carries a tool call fails with `CONTEXT_WRITER_FAILED`; text that is not
   JSON fails with `CONTEXT_NOTE_INVALID` (`writer.ts` `writeMemory`). No
   safe repair exists for a non-JSON answer.
2. **Envelope removal.** The two shapes of `note-envelope.ts`
   `removeNoteEnvelope`, nothing else.
3. **Schema.** The value must satisfy `noteSchema` exactly; otherwise
   `CONTEXT_NOTE_INVALID` (`notes.ts` `validateNoteContent`).
   `schema-diagnostics.ts` `diagnoseSchema` classifies the failure —
   content-free counts of facts without sources, per section — for status
   and repair eligibility; acceptance stays with the validator.
4. **Citation scope.** Every ID in every fact's `sources` and `supersedes`
   must name a readable record on the branch; otherwise `CONTEXT_NOTE_SCOPE`
   (`validateNoteContent`). `scope-diagnostics.ts` `diagnoseScope`
   distinguishes, as counts only, IDs that name no record from records with
   no readable text. Before refusing, `withoutOutOfScope` prunes such IDs from
   `sources` when every fact keeps at least one readable source and no
   `supersedes` ID is out of scope, and the pruned candidate passes the
   pipeline again (`writer.ts` `writeMemory`); it adds nothing and changes no
   text, quote, `supersedes` or remaining source. Otherwise the refusal
   stands. Status counts the pruned IDs as `scopeDropped`.
5. **Quotation.** Every fact's `quote` must occur character for character in
   at least one cited source's normalized text; otherwise
   `CONTEXT_NOTE_QUOTE` (`validateNoteContent`). `quote-diagnostics.ts`
   `diagnoseQuotes` classifies each failure as `elsewhere` (exact text in
   another record), `format` (matching only after spacing and punctuation
   normalization, `normalizeQuote` — used only to classify, never to
   accept) or `absent`, with the records that do contain it and their roles.
6. **Budget.** The note's serialized size, `Buffer.byteLength(JSON.stringify
   (note), "utf8")` (`notes.ts` `noteBytes`), must not exceed three bytes per
   budgeted token; otherwise `CONTEXT_NOTE_BUDGET` (`notes.ts`
   `validateNote`, raising `NoteBudgetError`). Estimated tokens are
   `ceil(bytes / 3)` (`config.ts` `textTokens`).
7. **Continuation.** A compaction inside an unfinished turn must carry at
   least one nonempty next step, and the stored checkpoint must carry the
   pinned user requests and end with their exact rendering; otherwise
   `CONTEXT_CONTINUATION_MISSING` (`writer.ts` `writeMemory` at generation;
   `notes.ts` `validateMemoryCheckpoints` at every reopen).

### The budget

The budget is frozen before the writer is invoked and never enlarged in
response to a candidate (`config.ts` `selectNoteBudget`; invalid
measurements refuse with `CONTEXT_CONFIG`). Fixed mode uses the configured
limit as both preferred and hard ceiling (tier 0). Tiered mode selects by the
compaction's source size, in estimated tokens:

| Tier | Source tokens | Base (preferred) | Hard limit |
| --- | --- | --- | --- |
| 1 | ≤ 80,000 | 3,000 | 4,000 |
| 2 | ≤ 200,000 | 4,000 | 5,000 |
| 3 | ≤ 400,000 | 5,000 | 6,000 |
| 4 | above | 6,000 | 8,000 |

In tiered mode the base is raised to 90% of the previous note's tokens and
the hard limit to the previous note's tokens, so a grown note never shrinks below
what it already validated at; both are capped by
`max(500, min(8000, floor(threshold × 0.15)))`. The storage safety bound is
8,000 tokens (`config.ts` `MAX_NOTE_TOKENS`) regardless of configuration. A
stored checkpoint revalidates under its own frozen `noteBudget`; malformed
stored budget metadata refuses with `CONTEXT_NOTE_VERSION` (`storedNoteLimit`),
and a checkpoint without the field validates under 6,000 tokens.

### The bounded repairs

At most **one** repair runs per compaction, of exactly one kind, chosen by
the first refusal in pipeline order; a repaired candidate passes the whole
unchanged pipeline again, and a second failure blocks. There is no substitute
writer and no unchecked summary. The repair request runs without reasoning,
within a bounded window (at most the writer's window, capped at 64,000
tokens); a repair that cannot fit leaves the refusal as it was.

- **Sources repair** (`sources-repair.ts`): eligible only when facts without
  sources are the candidate's *sole* schema fault and at most 5 facts are
  affected (`sourcesRepairEligible`, `SOURCES_REPAIR_MAX_FACTS`). The request
  names only those facts beside the evidence they may cite; the answer
  returns IDs only, exactly one repair per named fact. `applySourcesRepair`
  splices the IDs in and changes nothing else — text, quote and supersedes
  stay byte for byte; an answer off its schema or not answering each fact
  exactly once refuses with `CONTEXT_NOTE_INVALID`. No withdrawal is
  offered.
- **Quotation repair** (`quote-repair.ts`): eligible only when the candidate
  is schema-valid, no cited ID is unreadable, and at most 5 quotations fail
  (`quoteRepairEligible`, `QUOTE_REPAIR_MAX_FACTS`). The request names each
  failing fact, the records it cites and the records that do contain the
  text, with their roles and bounded excerpts; a replacement may change only
  `sources` and `quote`, or withdraw the fact. `applyQuoteRepair` splices
  replacements in; it refuses with `CONTEXT_NOTE_REPAIR_LOSS` when a
  replacement changes a fact's text or supersedes, or when it withdraws an
  instruction whose quoted text a user message contains — the user said it,
  and a misquoted rule is still a rule. Malformed answers refuse with
  `CONTEXT_NOTE_INVALID`.
- **Size repair** (`writer.ts` `writeMemory`): runs only after schema,
  citations and quotations have passed and the note exceeds its hard budget.
  The same writer shortens its own validated candidate. The result passes
  the whole pipeline again and additionally must preserve every source ID,
  supersedes ID and exact quotation somewhere in the result and keep every
  occupied section nonempty; any loss refuses with
  `CONTEXT_NOTE_REPAIR_LOSS`.

A session writer that answers with a tool call has the call declined once —
it is never run — and the same request continues once; this does not spend
the repair, and a second tool call refuses with `CONTEXT_WRITER_FAILED`.

### Writer preconditions

Before any request: the writer must be resolvable and authenticated, else
`CONTEXT_WRITER_UNAVAILABLE` (`preview/writer.ts` `resolveWriterModel`,
transport work); there must
be uncovered original evidence, else `CONTEXT_NO_NEW_SOURCE` (`writeMemory`);
the request, its evidence and its output reservation must fit the writer's
window, else `CONTEXT_WRITER_CAPACITY` (`writeMemory`); budget arguments must
be valid integer counts, else `CONTEXT_CONFIG`. The cut that selects what
leaves context must land on a turn start that follows the previous
checkpoint, else `CONTEXT_NO_CUT` (`cuts.ts` `chooseCut`); a prefix
commit uses the latest projected user-message turn start inside the covered
prefix (`cuts.ts` `prefixCut`). Only the segments path may instead cut just
after a covered complete tool batch, at the next projected assistant message,
within the ordinary cut and after the previous checkpoint. Both sides must
retain complete tool pairs (`cuts.ts` `segmentPrefixCut`). The notes path and
arm A retain the user-message rule. Segments remain off by default (U13).

## Commit and failure states

A compaction attempt moves through four states, recorded durably so that a
crash at any point leaves evidence rather than ambiguity:

- **Pending.** An attempt has begun: a durable marker exists carrying the
  attempt's identity — `{attemptId, sessionId, leafId, lastCheckpointId,
  sourceHash}` (`contracts.ts` `PreviewAttempt`) — before any writer call.
  Beginning an attempt verifies that the records on disk hash to the
  attempt's `sourceHash` (`failure-store.ts` `PreviewFailureStore.begin`;
  mismatch refuses with `CONTEXT_SOURCE_CHANGED`).
- **Staged.** A validated candidate exists: the marker gains the candidate's
  hash, after the candidate's coverage, identity and source hash are checked
  against the records read back from disk (`PreviewFailureStore.stage`;
  `CONTEXT_SOURCE_CHANGED` on any mismatch).
- **Committed.** The stored checkpoint was read back from disk, matched the
  staged candidate hash for hash, its covered prefix rehashed to the
  attempt's `sourceHash`, and its coverage rules held; only then is the
  marker removed (`PreviewFailureStore.commit`).
- **Blocked.** Any failure: the marker records state `blocked` and the error
  class. A blocked session stops the next request.

Durable markers carry identifiers, hashes and classes — never transcript,
note content, queries or free-form error text.

**A failed compaction blocks the next request by design.** At the Gated
guarantee level the request guard refuses every request of a blocked or
pending session with the recorded class, or `CONTEXT_BLOCKED` when none is
recorded (`PreviewFailureStore.assertReady`). Only an explicit retry may
replace a failure marker with a new pending attempt, and explicit recovery
confirms an already-staged, validated checkpoint on disk — matched by
candidate hash and source hash, without a model call — before requests
resume (`PreviewFailureStore.recover`). **No adapter falls back silently**:
an adapter whose host cannot stop requests says so (the Checked level below)
rather than presenting the host's own fallback as protected. No second
history database exists, and no substitute writer is ever used.

On every request of a ready session the guard also re-verifies the stored
state: a full disk readback at each trust boundary (session start,
compaction, recovery, any failure), then an exact file-growth check between
boundaries; divergence refuses with `CONTEXT_SOURCE_CHANGED`. The projected
context must carry the validated checkpoint's summary — a missing or
tampered rendering refuses with `CONTEXT_RECOVERY_MISSING`
(`controller.ts` `PreviewMemoryController.context` and `.beforeRequest`) —
and requests beyond the usable window refuse with `CONTEXT_INPUT_TOO_LARGE`
(the guard, with the limit from `guards.ts` `requestLimit`) or
`CONTEXT_PAYLOAD_TOO_LARGE` (the payload check in `.beforeRequest`). Both
measure the context as the host's own compaction trigger does: by the
provider's reported usage once a response has reported it (`controller.ts`
`measuredContextTokens`), by a character estimate before. A host whose
session writer continues the session's context also starts compaction at a
settled turn before the handover stops fitting (`.makeRoom`, sized by
`writer.ts` `sessionHandoverTokens`). The
reference store additionally uses adapter-local classes (prefixed
`CONTEXT_PREVIEW_`) for faults of its own marker and readback machinery;
those are adapter identifiers outside this specification's closed set, and
conformance never matches on them.

The guarantee levels an adapter may declare enter this specification from the
roadmap unchanged:

| Guarantee level | The host lets the adapter | What holds |
| --- | --- | --- |
| Gated | Supply the compaction result, stop requests after a failed or unconfirmed checkpoint, read the committed checkpoint back and offer retrieval | Every guarantee, including failure blocking |
| Checked | Put a validated note into the model's context and offer retrieval, without stopping requests or the host's own compaction | Commit checks and retrieval; failures are reported, not enforced |
| Traceable | Read records and offer retrieval or offline verification | Retrieval within the branch and verification of stored checkpoints |

## Retrieval

Retrieval runs over a **frozen snapshot** of the current branch —
`{sessionId, leafId, scopeHash, entries}` — taken by the host at the trust
boundary; the snapshot is an argument, computed views are disposable, and
nothing retrieval returns is stored (rule K5). Results are original excerpts
from the snapshot's records, so a hit never widens branch or grant access.

**Search and read** (`history.ts` `queryHistory`):

- `search` requires at least one literal term (`HISTORY_QUERY_REQUIRED`
  otherwise); terms are lowercased identifier-like tokens plus two-character
  Chinese bigrams, at most 64. Ranking is deterministic: more matched terms
  first, then conversation turns before tool output, then newest first.
  Results of the retrieval tool itself, `toolResult` records whose
  `toolName` is `context_history`, are not searched: they copy other records;
  a read by ID still returns them. Each hit is an excerpt of up to 1,400
  characters that opens 120 characters before the earliest 400-character
  window holding the most distinct terms, so a single term keeps its first
  occurrence and a multi-term query lands where its terms meet. The ranking
  version is 3.
- `read` requires a record ID (`HISTORY_ENTRY_REQUIRED`); a record outside
  the snapshot or without readable text refuses with
  `HISTORY_SCOPE_DENIED`. Reads page the full normalized text from its
  start.
- A page is bounded by a token budget clamped to [512, 4000] minus a fixed
  overhead; a cursor continues the identical request. Cursors are bound to
  the snapshot, the operation, the query and the ranking version; a cursor
  that does not match, or whose pinned prefix is no longer on the branch,
  refuses with `HISTORY_CURSOR_INVALID`. A request off the query schema
  refuses with `HISTORY_QUERY_INVALID`.

**The typed list** (`history-view.ts` `listHistory`) serves one kind per
request: the six note sections as committed checkpoints recorded them, plus
`edits` and `errors` read from tool records. Facts appear once in their
latest wording with superseded and revised sources marked; items are ordered
newest first; invalid stored values are skipped, never trusted. Every item
and search hit is priced: `readTokens`, the estimated tokens a full read of
its records returns (`readTokens`), and `inContext`, set when the records'
full text is already in the model's context and not reduced
(`inContextEntries`). A low-detail read (`readLowDetail`) returns the start
of one record bounded to 200 estimated tokens (`LOW_DETAIL_TOKENS`) with the
full read's cost stated, and has no continuation. The list and cursor rules
share the search's classes.

Cross-session access exists only under an explicit, host-issued, revocable
grant whose scope is a frozen subset of a parent branch, verified record by
record by hash on every read; grant issuance and reading are the host's
(`history.ts` `issueHistoryGrant`, `grantedHistory`), refuse with the
`HISTORY_` classes, and are not required at any guarantee level below Gated.

**Reductions** are derived, deterministic views that shrink the projected
context without touching storage. The rules of the v0.6.0 plan are core
obligations here:

- G1 — a reduction is a pure, deterministic function of the records and the
  model's declared cache lifetime: recomputed on every call, never stored;
  the same records always produce the same bytes (`reduction.ts`
  `reduceRecords`).
- G2 — eligibility is monotone in the records: appending records never
  un-reduces an entry; the idle trigger reads gaps between record
  timestamps, never a clock.
- G3 — nothing in the session file is rewritten; a reduced record reads back
  in full through retrieval, and deleting the reduction restores the full
  view.
- G4 — one function, two call sites: the same view applies to the model's
  context and to the writer's input (`applyReduction`).
- G5 — a reduction never separates a tool call from its result: the call
  stays verbatim, only the result's text becomes its one line, and
  `assertToolPairs` holds on the reduced view.
- G6 — user messages, assistant text, checkpoint summaries and note records
  are never reduced; only all-text, non-error tool results are candidates,
  and a record that is some fact's only cited source stays full.
- G7 — stored formats stay as they are; no reduction adds a field anywhere.
- G8 — measurement precedes mechanism; a reduction candidate ships behind
  its own switch with a recorded baseline.
- G9 — paging reduced or compacted content back in counts as retrieval usage
  against the claimed saving, excerpts included.
- G10 — no rendered text changes with the time of rendering.

The replacement is one byte-stable line naming the tool, its target, the
first line of its result and the record ID (`reductionLine`; targets and
heads bounded to 120 characters), for example — invented —
`[reduced tool result] read_file docs/example.md => # Overview | entry
rec-0042; context_history reads this entry back in full`. An entry first
reduces only when the estimated tokens that follow it do not exceed the
tokens removed (`REDUCTION_SUFFIX_RATIO` = 1) or the branch was idle past
the declared cache lifetime (default one hour where none is declared), so a
reduction never writes more cache than it saves.

**Excerpts** (`excerpts.ts` `selectExcerpts`) are the bounded exception that
brings evidence to the model unasked: when the latest user prompt names an
exact identifier that nothing else in the request shows, the newest
out-of-context record containing it exactly contributes one labelled JSON
line at the end of the request — at most 2 records per prompt, at most 200
estimated tokens each, from at most 8 identifiers considered. The line is
appended for that request only and enters no record. A record matching any
secret pattern (`secretPattern`) is withheld whole and named by ID only.
Excerpt tokens are retrieval usage, and excerpts no answer cited are
reported (`unusedExcerpts`).

## Call accounting

Every model call the method makes is accounted for; **a call without a usage
report is unknown, never free**, and unknown is reported as unknown rather
than folded into zero.

- **Usage fields** (`call-journal.ts` `CallUsage`; `events.ts`
  `UsageSummary` adds optional `reasoning`): `input`, `output`, `cacheRead`,
  `cacheWrite`, `totalTokens` and `cost` in USD. Usage across a compaction's
  calls is summed field by field (`writer.ts` `sumMemoryUsage`), and a
  provider that reports all-zero usage counts as having reported none.
- **Phases** (`events.ts` `WriterCallRecord`): `generate` or `repair` —
  which step of one compaction a call served.
- **Purposes** (`call-journal.ts` `CallPurpose`): `compaction` (the
  synchronous writer at the boundary), `preparation` (optional background
  work) or `segment` (a segment's calls). The separation is load-bearing:
  0.8.0's interval caps and breaker read it.

The journal contract (`call-journal.ts` `CallJournal`): one append-only,
content-free record per call — identity, purpose, interval, model, effort,
phase, outcome, elapsed time and usage; never request or response text. The
start line is durable before the request is sent and the settlement follows,
so after a crash a start without a settlement stays visible as unknown
usage. Optional preparation never sends an unrecorded request and stops at 8
calls per attempt (`PREPARATION_CALLS_PER_ATTEMPT`). Segments stop at 8 calls
per checkpoint interval, repairs included (`SEGMENT_CALLS_PER_INTERVAL`),
counted from the journal so a restart does not reset them, and at a spending
cap (`segmentBudgetLeft`): the interval's segment calls may spend as many
uncached tokens (input, cache writes and output) as the trigger holds, and a
dispatched call with unknown usage spends all of it. A formal compaction
proceeds if its record cannot be written, and the gap is shown in status. A
journal summary (`CallSummary`) reports calls by purpose, unsettled calls,
calls with unknown usage and calls with only partial usage, beside the sum.

`writer.ts` `writerContractHashes` binds a journal to the contract that
produced its calls: `promptHash` over the writer's rules text and the
package's artifact identifier, `schemaHash` over the note schema. A prepared
candidate records the writer identity it was frozen for — role, resolved
model, effort and these hashes (`preparation-candidate.ts`
`PreparationWriterIdentity`) — and provenance linking each paid dispatch to
its journal records, so a changed contract invalidates the candidate rather
than committing under an identity that no longer exists.

## The guarantee table

Each guarantee below names the deterministic check that enforces it, cited as
module and export, and the class its violation raises from the closed set. A
guarantee without an existing check is not in this table.

| Guarantee | Enforcing check | Class |
| --- | --- | --- |
| A candidate is a complete note: exactly the seven sections within their bounds, every fact with 1–20 sources | `notes.ts` `validateNoteContent` | `CONTEXT_NOTE_INVALID` |
| Citation scope: every `sources` and `supersedes` ID names a readable record on the branch | `notes.ts` `validateNoteContent` | `CONTEXT_NOTE_SCOPE` |
| Quotation integrity: every `quote` occurs character for character in a cited source's text | `notes.ts` `validateNoteContent` | `CONTEXT_NOTE_QUOTE` |
| Note budget: the serialized note fits its frozen hard limit, never above 8,000 estimated tokens | `notes.ts` `validateNote` (`NoteBudgetError`) | `CONTEXT_NOTE_BUDGET` |
| Stored checkpoints are well-formed: supported version, valid frozen budget metadata | `notes.ts` `validateMemoryCheckpoints`; `config.ts` `storedNoteLimit` | `CONTEXT_NOTE_VERSION` |
| Unchanged sources at reopen: every checkpoint's covered prefix rehashes to its `sourceHash`, oldest first, and its summary is the exact rendering of its validated note | `notes.ts` `validateMemoryCheckpoints`, `latestMemory` | `CONTEXT_SOURCE_CHANGED` |
| Unchanged sources at commit: attempt, staged candidate and committed checkpoint are checked against the records read back from disk | `failure-store.ts` `PreviewFailureStore.begin`, `.stage`, `.commit` | `CONTEXT_SOURCE_CHANGED` |
| Continuation preserved: an in-task handover carries a nonempty next step and its pinned user requests, re-verified at every reopen | `writer.ts` `writeMemory`; `notes.ts` `validateMemoryCheckpoints` | `CONTEXT_CONTINUATION_MISSING` |
| A repair never loses evidence: a quotation repair changes only `sources` and `quote` and cannot withdraw a user-quoted instruction; a size repair keeps every source ID, supersedes ID, quotation and occupied section | `quote-repair.ts` `applyQuoteRepair`; `writer.ts` `writeMemory` | `CONTEXT_NOTE_REPAIR_LOSS` |
| A repair answer matches its schema and answers each named fact exactly once, nothing else spliced | `sources-repair.ts` `applySourcesRepair`; `quote-repair.ts` `applyQuoteRepair` | `CONTEXT_NOTE_INVALID` |
| A tool call and its result are one unit, never split by a cut, a view or a request | `guards.ts` `assertToolPairs` | `CONTEXT_TOOL_BOUNDARY` |
| User messages carried on a notes checkpoint are verbatim, in order, within coverage, and the summary ends with their exact rendering | `work-notes.ts` `assertUserMessages` | `CONTEXT_NOTE_QUOTE` |
| A work note carries data only — no instructions field — and passes the full note checks on its own branch | `work-notes.ts` `validateWorkNote` | `CONTEXT_NOTE_INVALID` |
| A failed or unconfirmed compaction blocks the next request until explicit retry or recovery | `failure-store.ts` `PreviewFailureStore.assertReady` | `CONTEXT_BLOCKED` (or the recorded class) |
| The validated checkpoint's rendering is present and untampered in the model's context and the provider payload | `controller.ts` `PreviewMemoryController.context`, `.beforeRequest` | `CONTEXT_RECOVERY_MISSING` |
| A cut lands on a turn start after the previous checkpoint, keeping complete recent turns | `cuts.ts` `chooseCut` | `CONTEXT_NO_CUT` |
| A checkpoint condenses new original evidence; summaries are never re-summarized alone | `writer.ts` `writeMemory` | `CONTEXT_NO_NEW_SOURCE` |
| The writer is resolvable and authenticated before any attempt | `preview/writer.ts` `resolveWriterModel` | `CONTEXT_WRITER_UNAVAILABLE` |
| Every writer request fits its bounded window, evidence and output reservation included | `writer.ts` `writeMemory` | `CONTEXT_WRITER_CAPACITY` |
| A writer answer is settled: normal stop, no executed tool call; at most one declined call per compaction | `writer.ts` `writeMemory` | `CONTEXT_WRITER_FAILED` |
| The model's window leaves a usable input allowance after the output reserve | `config.ts` `memoryBudget`; `guards.ts` `requestLimit` | `CONTEXT_CAPACITY` |
| Requests beyond the usable allowance are stopped before dispatch; payloads beyond the window are stopped at the provider boundary | `controller.ts` `PreviewMemoryController.context` (limit from `requestLimit`), `.beforeRequest` | `CONTEXT_INPUT_TOO_LARGE`; `CONTEXT_PAYLOAD_TOO_LARGE` |
| Budget inputs and writer budget arguments are valid integer counts | `config.ts` `selectNoteBudget`; `writer.ts` `writeMemory` | `CONTEXT_CONFIG` |
| Retrieval is confined to the frozen branch snapshot; unreadable or out-of-scope records are refused | `history.ts` `queryHistory`; `history-view.ts` `readLowDetail` | `HISTORY_SCOPE_DENIED` |
| A cursor continues only its own snapshot, operation and query, or a still-intact pinned prefix | `history.ts` `queryHistory`; `history-view.ts` `listHistory` | `HISTORY_CURSOR_INVALID` |
| A retrieval request matches its schema, with search terms or a record ID as the operation requires | `history.ts` `queryHistory` | `HISTORY_QUERY_INVALID`; `HISTORY_QUERY_REQUIRED`; `HISTORY_ENTRY_REQUIRED` |

Obligations of this specification that are structural rather than
refusal-checked — the core imports nothing from a host (rule K1, enforced by
the build's import gate), the core keeps no copy of history (K5), reductions
are deterministic and monotone (G1, G2), stored records are never rewritten
(G3), no silent fallback, no second history store, no substitute writer —
are verified by the release's isolation and equivalence gates and by focused
regressions, not by a runtime class, and are binding all the same.

The conformance vectors of WP3 are this table's mechanical form: records plus
a candidate, expected outcome commit or refusal with one class, matched by
class and never by message text, all content invented (rule K12).
