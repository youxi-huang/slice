# DSH and OpenCode retrieval previews

These packages, `slice-opencode` and `slice-dsh`, add one `context_history` tool to each host.
They search or read original stored text in the current session, with bounded
results and continuation cursors. They do not generate Slice checkpoints,
replace native compaction, or protect subsequent model requests. Neither
package is a `Checked` or `Gated` compaction adapter.

The scope and writing prerequisites are in
[the adapter design](dsh-opencode-adapter-design.md). This implementation stops
at its explicit DSH persistence gate; it contains no dormant writer or second
transaction engine. OpenCode V2 is not included.

Native compaction settings for a given route, such as 200k with a 32k output
cap, and the three-cycle pressure fixtures for both hosts are in
[capacity profiles](context-pressure.md). They leave both adapters
retrieval-only.

## Build, publish and load

From a source checkout, run:

```sh
node scripts/context-memory-ops.mjs deps
node scripts/context-memory-adapters-check.mjs
```

The builder emits `.artifacts/host-adapters/dsh` and
`.artifacts/host-adapters/opencode`, or the same two directories under
`node scripts/context-memory-adapters-build.mjs --output-dir <dir>`, and packs
each as npm publishes it: `slice-dsh-<version>.tgz` and
`slice-opencode-<version>.tgz`, with their SHA-256 in
`adapters-package-report.json`. Each bundles only its adapter and the private
core, declares its runtime dependencies, and includes a source fingerprint.
Keep one copy of the tool installed; do not register another
`context_history` beside it.

Each release from 0.7.5 publishes both archives on npm beside the Pi package,
`slice-pi`, and tags each in Git as `opencode-v<version>` and
`dsh-v<version>`, the package alone at the root. Users install from npm as the
[README](../../README.md#dsh-and-opencode) shows; a build loads as the table
shows.

| Package | Hosts | Load |
| --- | --- | --- |
| `slice-dsh` | DSH from `0.2.1-rc.3` through later 0.2.x releases, Cordis `~4.0.5`; installed on rc.3 and rc.5 | From npm, `dsh plugin --profile <profile> add slice-dsh@<version>`; from a build, `add file:<dir>/dsh`. Either way DSH runs pnpm from `PATH`, and the package's own bundle patch inserts `{ id: slice-history, name: slice-dsh }`, so the profile needs no hand edit. A profile without hot reload, such as `headless`, loads it at its next start. Profiles built on `dsh-base` provide the sessions, persistence and tools it injects. It exports `name`, `inject`, `apply`. |
| `slice-opencode` | OpenCode 1.x plugin contract and SDK `1.19.4`; `engines.opencode` admits `>=1.19.4 <2.0.0`; installed on 1.19.4 and 1.19.5 | From npm, add `slice-opencode@<version>` to `plugin` in `opencode.json`, and OpenCode installs it with its two dependencies at start. From a build, `npm install --prefix <dir>/opencode --omit=dev`, then add the absolute `file://` URL of `<dir>/opencode/dist/index.js`. It exports only `SliceHistory`. |

DSH admits a plugin by its peers on DSH packages, checked before a registry
install downloads anything. The published ranges admit every release from rc.3
because nothing this adapter uses changed between rc.3 and rc.5. pnpm 11 waits
a day before it installs a newly published version under a bare name; a named
version installs at once. A profile that carries a hand-added `slice-history`
row from a build before 0.7.5 must drop it: the tool refuses to register twice.


DSH requires an owning persistence backend and a successful session flush; a
session with no persistence listener is refused. The tool opens a **read**
handle and always closes it. It does not acquire the host's write handle.
DSH rejects an existing `context_history` registration before installing.

OpenCode uses the plugin-supplied SDK, current directory, session ID and
calling message ID. It asks the host's `context_history` permission before
reading. Configure that permission through OpenCode's ordinary allow/ask/deny
policy. The tool has no session selector or parent grant. The current in-flight
assistant message is excluded because its parts can still change. The pinned
1.x [messages handler](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)
returns complete stored messages when `limit` is omitted; output
pagination belongs to the existing core, not a second host-side index.

The OpenCode entry returns the public hook/tool object directly; the official
`tool()` helper is an identity function. It uses Zod 4.6.7 without importing
the full plugin package or its unused V2 dependency graph. The SDK is used for
development typing and acceptance only; the running host supplies its client.
DSH `0.2.1-rc.3` pins Zod 4.4.3, which GHSA-mrhx-c7xc-m3w5 affects, so the
repository's root override lifts its development graph to 4.6.7. This does not
modify an installed host or its dependencies.

To uninstall, remove the plugin entry from `opencode.json`, or run
`dsh plugin --profile <profile> remove slice-dsh`, which also deselects its
bundle. These plugins create no sidecar
history, recovery markers or custom checkpoint records to clean up. Native
tool calls/results remain part of the host's ordinary session history.

## Evidence and boundaries

- DSH citations use native event sequence numbers as strings, scoped by
  session. Retrieval follows the append log, even when surface replacement
  seqs are non-monotonic. It does not expand a numeric `shadowedRange`. A
  tool result takes its tool's name from the matching `tool/call` event.
- OpenCode citations use native **part** IDs. Message envelopes retain native
  message IDs as opaque records. Tool output is attributed to `toolResult`,
  synthetic summaries to `context`; ignored text and reasoning/media remain
  opaque. There are no manufactured `message:index` IDs.
- Codecs build disposable views. Native payloads enter hashed structural
  fields, so edits under unchanged IDs invalidate evidence. The cursor uses
  the existing `hashEntries` contract; a future non-Pi checkpoint must use
  `hashCanonicalRecords`. These are different identities by design.
- Native forks/seeded sessions are refused until lineage authorization is
  supported. API failures and cancellation propagate. There is no fallback to
  another session, a current-window cache, or a private database.
- Search skips the results of `context_history` itself, which copy other
  records; a read by ID still returns them. Each hit's excerpt opens where the
  most query terms meet, so a query for one line of a long log lands on that
  line.
- Only readable text is searchable. Original payloads remain in host storage;
  these tools do not download file attachments or reveal reasoning as text.
  A host that has deleted original content cannot be repaired by this adapter.
- Each query reads the current native history, with no persistent index. This
  is intentionally simple but costs O(history size) host I/O and transient
  memory; only the response is token-bounded (core maximum 4,000 estimated tokens).

`node scripts/context-memory-adapters-check.mjs` runs synthetic regressions
through both codecs and the real core validators, the supplied OpenCode SDK,
and official DSH Session/JSONL components. It covers two native DSH replacement
cycles and a cold storage reopen, ID and role mapping, source mutation, cursor
scope, missing durability and cancellation. It also builds both independent
packages. This is not a live-provider run or full interactive-host acceptance.

The built DSH package has also run inside the official `dsh` 0.2.1-rc.3 CLI,
installed from npm into an isolated `DSH_HOME`: added to the `headless` profile
from its build directory with a hand-added row, as builds before 0.7.5 needed,
it was offered to the model, and a loopback
Messages-API stand-in that called it received the session's original user
message under its native event ID. No real model was called, and the run did
not cover interactive UI, native compaction or reopen in the CLI. See the
[validation record](validation.md).

Installation by name has its own acceptance:

```sh
node scripts/context-memory-adapters-build.mjs
node --experimental-strip-types scripts/context-memory-adapters-acceptance.mjs --hosts-root <dir>
```

It installs official OpenCode 1.19.4 and 1.19.5 and DSH 0.2.1-rc.3 and rc.5
from npm into `<dir>`, with pnpm 11.28.5 for DSH, and serves each built archive
by name from a loopback npm registry that sends every other package to npm. On
each host `context-memory-host-run.mjs --install registry --provider loopback`
installs the package as a user would, runs fixture P5 through two native
compactions and asks `context_history` for an earlier detail. A run passes when
the host fetched the exact archive, the session finished without a stop and the
tool returned original entries. CI runs it on every pull request, and
publication runs it again on the release tag before anything reaches npm. The
model is a loopback stand-in; no provider is called.

For the separate **Linux x64 OpenCode 1.19.4** installed-package acceptance:

```sh
npm install --prefix .artifacts/opencode-stock --save-exact --ignore-scripts --no-audit --no-fund opencode-ai@1.19.4
node scripts/context-memory-opencode-acceptance.mjs \
  --stock-root .artifacts/opencode-stock \
  --package-dir .artifacts/host-adapters/opencode
```

It checks npm provenance, copies the built adapter outside the workspace,
starts an unmodified official binary with an isolated profile and a loopback
synthetic provider, and exercises two native compactions, process restart,
original-part retrieval, cursor continuation after appended turns, and plugin
removal. It checks the binary and adapter bytes afterward and deletes synthetic
sessions. The run has a 240-second deadline and a 50-call synthetic-provider
ceiling; it inherits no provider credentials. Interactive UI, real providers,
other OpenCode versions and other operating systems remain untested. This
optional binary fixture is separate from the ordinary `verify` gate.

## Why DSH writing is deferred

The pinned [Session README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/core/session/README.md#write-experimental-plugin-records)
restricts `appendPluginRecord` to its own experimental packages and explicitly
excludes external plugins. Its best-effort, ignorable records also cannot carry
Slice's required checkpoint semantics. A TypeScript `SessionEventMap` merge
does not update the installed persistence event catalog: the official
`validateStoredEvents` rejects an unknown required `slice/checkpoint` event.
The adapter regression reproduces that refusal against the installed release.

The minimum prerequisite is a public external log-record registration contract
that survives flush, reopen and removal with defined required-record semantics.
Once available, implement the design's manual transaction and separately prove
request admission, durable blocking and recovery. Do not mutate
`KNOWN_SESSION_EVENT_TYPES`, copy the private compaction engine, encode
checkpoint JSON in summary text, or treat `rawOutput` as plugin state.
