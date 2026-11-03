# Core conformance vectors

`0.8-conformance.1` adds WP1's segment contract to the vectors half of 0.7.0's
WP3 from [the specification](../spec/specification.md). Every record and sentence
is invented. These vectors exercise the core directly. The Pi adapter path
(`eval/preview/conformance-adapter.test.ts`) replays `vectors.json` through the
fixture converter and the workspace host's session manager: 31 of its 34 agree
by error class there, and the three zero-record vectors stay core-only, since
the converter rightly rejects an empty records file. `segments.json` stays
core-only: no adapter uses segments yet.

`manifest.json` maps each data filename to SHA-256 of its exact UTF-8 file bytes,
including the final newline, like the preview fixture manifest. The test rejects
missing, extra or changed JSON files. Change the version when changing a published
vector contract; do not regenerate hashes merely to clear a failure.

Each object in `vectors.json` has a unique `id`, `stage`, ordered `records` using
the exact fields of `src/records.ts` (`type`, not `kind`), a `candidate` JSON note
or writer envelope, and `expected`: `{"outcome":"commit"}` or
`{"outcome":"refusal","code":"CONTEXT_..."}`. Only `PROJECT_CODES` may occur;
message text is never compared. A commit means these deterministic checks passed,
not that the runner wrote storage or called a model.

Additional inputs are stage-specific:

- `note`: envelope removal then note validation. Optional `diagnosis` pins the
  schema counts, scope counts or quotation class, so equal refusal codes cannot
  hide the wrong planted fault. `budget` freezes `threshold`, `sourceTokens` and
  `previousTokens`, with the expected tier, base and hard limit. To avoid pages of
  repeated filler, `candidateBytes` expands the candidate with ASCII `x` in state
  facts (each at most 4,000 characters), preserving its source IDs, to that exact
  serialized UTF-8 byte count. `materializeCandidate` defines this expansion.
- `sources-repair` / `quote-repair`: `response` is the single scripted repair.
  Eligibility and splicing use the core functions; the repaired note passes full
  validation. No other repair or retry is attempted.
- `tool-pairs`: message records project to their `message` objects and pass
  `assertToolPairs` from `src/guards.ts` before the candidate passes note
  validation. This is the core's tool-pairing guard, the same function the
  preview uses, so the vectors exercise the shipped pending-call rules.
- `checkpoint`: `checkpoint` supplies pinned `sourceHashes` for `pi` and/or `jcs`,
  optional `continuation` IDs and whether its exact rendering is included.
  `runCoreVector` builds the stored rendering and metadata, then calls
  `validateMemoryCheckpoints`. For changed-content vectors, `originalRecords`
  must first reopen successfully with the very same pinned hash and note; only
  then are the changed `records` checked. The quote still matches after the edit.

The set includes the required faults and deliberate boundary pairs: absent/empty
sources, missing/unreadable IDs in both citation fields, three quotation classes,
each envelope and its extra-key near miss, exact hard-limit/one-byte-over notes
on both sides of every source-tier transition, protected repair loss, a complete/
unpaired tool batch, a present/missing continuation rendering, and changed cited
content under both source serializations. No vector combines independent faults.

Each object in `segments.json` also has a unique `id`, `stage` and ordered
`records`. Its 24 vectors pin the settled 0.8.0 contract with three stages:

- `segment`: `link` names `firstId`, `lastId` and its `note`.
  `freezeSegmentInput` freezes its input and `finalizeSegment` checks its note.
  `expected` is the same commit or project-code refusal as above. A citation
  outside the range refuses even when it is readable in the dispatch prefix;
  `supersedes` may name an earlier record.
- `segment-chain`: `links` are frozen and finalized in order, then
  `classifyChain` checks them at the boundary. `expected.links` is the number
  of valid links; `coveredThrough` is absent when none is valid, and `stop`
  is either the first rejected link's zero-based `{index, reason}` or absent.
  The vectors cover every `ChainStop`, retention of the prefix before a fault,
  a chain starting after a base checkpoint's coverage (including the checkpoint
  record when it is next), and a last link written before later turns arrived.
- `segment-merge`: optional `previous` is the previous note. Each link must
  finalize and the whole chain must classify before `mergeChain` merges it.
  `expected` is `{"note": ...}` or `{"refusal": ...}` with a `MergeRefusal`.
  The vectors cover all three refusals, carried and added instructions, an
  unambiguous correction, the newest nonempty plan and the newest nonempty
  gaps; empty segment gaps keep earlier ones. The schema refusal adds one fact
  to a valid previous note with 40 state facts. Neither input is invalid alone.

Each link is dispatched on the vector's `records` through its own `lastId`.
Its writer has seen every user record through that ID, and its chain hash is
`chainHash` of the links before it. Only the fault vectors override
`processedUserEntryIds` or `chainHash`. Dispatch uses `synthetic-session`,
epoch 1, the fixed `synthetic/segment` writer at `low`, and
`selectNoteBudget({}, 64_000, 100)`; the remaining synthetic writer identity
and provenance fields are in `runner.ts`. No note or expected result is generated.

The chain and merge stages submit against the full vector's `records` with the
same session, epoch, writer and budget by default. Optional `boundary.records`
replaces that branch; `session`, `epoch` and `customInstructions` override
those submission fields, while `writer` and `noteBudget` override only their
listed fields. The budget vector lowers the boundary allowance to 500 tokens
for a note that passed its frozen allowance. Each fault is isolated from the
others, and no error message text is compared.

`src/canonical.ts` implements RFC 8785 over JSON values. The normalized record
contains every structural field from `records.ts`; host-only record/message keys
are excluded, while opaque blocks, arguments, details, data and replacements
remain whole. Optional structural fields absent or `undefined` are omitted; JSON
payloads must be valid JSON. Keys sort by raw UTF-16 units; strings are never
Unicode-normalized. Each JCS record is followed by LF before SHA-256. Pi keeps its
existing native `JSON.stringify` framing; checkpoint readers select JCS explicitly
(`latestMemory`'s second argument, `validateMemoryCheckpoints`' third argument).

Run `node scripts/context-memory-core-check.mjs` from the repository root for the
import gate, in-place vectors, isolated build and isolated vectors. The required
repository acceptance is `node scripts/context-memory-ops.mjs verify`.
