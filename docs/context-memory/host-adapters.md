# DSH and OpenCode retrieval previews

These packages, `slice-opencode` and `slice-dsh`, add one `context_history` tool to each host.
Their default entries search or read original stored text in the current session,
with bounded results and continuation cursors. `slice-opencode` remains
retrieval-only. `slice-dsh/compaction` is a separate opt-in manual writing preview:
it validates and reads back Slice checkpoints and gates later requests after a
failed or unconfirmed attempt.

The scope and writing prerequisites are in
[the adapter design](dsh-opencode-adapter-design.md). The default installation is
retrieval-only; DSH writing is enabled as described under [DSH writing](#dsh-writing). OpenCode
V2, released as `@opencode/cli` 2.x, is not included.

Native compaction settings for a given route, such as 200k with a 32k output
cap, and the three-cycle pressure fixtures for both hosts are in
[capacity profiles](context-pressure.md). They leave both adapters
retrieval-only unless the DSH writing entry is explicitly enabled.

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
compactions and asks `context_history` for an earlier detail. Each session runs in a temporary directory outside any Node project, as a
user's does, so this repository's `.npmrc`, whose `min-release-age=2` holds back
a version published that minute, cannot reach the host's installer. A run passes
when the host fetched the exact archive, the session finished without a stop and
the tool returned original entries. CI runs it on every pull request, and
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

## DSH writing

The pinned [Session README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/core/session/README.md#write-experimental-plugin-records)
restricts `appendPluginRecord` to DSH's own experimental packages and excludes
external plugins, and its best-effort, ignorable records cannot carry Slice's
required checkpoint semantics. A TypeScript `SessionEventMap` merge does not
update the installed persistence event catalog: the official
`validateStoredEvents` rejects an unknown required `slice/checkpoint` event.
The adapter regression reproduces that refusal against the installed release.
None of this changed through 0.2.1-rc.5 or 0.2.2-alpha.3.

A review on 2026-11-03 found that the rest of a Gated adapter needs no such
record. A plugin may replace `compaction-basic` with its own
`CompactionEngine`. An `agent/pre-step` listener may return `reject`, which
ends the turn before any request is sent. Continuing a turn after a failed
summary is `compaction-basic`'s own policy, not the host's. What remains is a
place for the structured checkpoint that survives reopen, and among the native
events only `compaction/summary` offers one. That event is log-only: the model
reads the replacement `user/message` that follows it, which carries the
rendered note alone.

By the maintainer's decision of 2026-11-03, U11 of the
[v0.8.0 plan](v0.8.0-plan.md), a DSH writing preview stores the structured
checkpoint in that event, says in its status output and README that it relies
on a field DSH owns, and runs a reopen test on every listed DSH version. A
declared backend field on `compaction/summary` is requested from DSH at the
same time, and the adapter moves to it once DSH ships one. Do not mutate
`KNOWN_SESSION_EVENT_TYPES`, copy the private compaction engine, or put
checkpoint JSON in the replacement message the model reads. The preview's
design, which puts the checkpoint in `rawOutput`, is in
[DSH writing preview](dsh-writing.md). The default entry remains retrieval-only.

Stage 1 adds `slice-dsh/compaction` as a separate entry. After installing the
package, opt in with these profile patch rows:

```yaml
- id: compaction-basic
  disabled: true
- insert:
    - id: slice-compaction
      name: slice-dsh/compaction
```

`/compact` uses the session's routed model and reasoning setting, writes the
native four-event transaction and validates the durable readback with JCS.
`/compaction-status` shows the gate state and the reliance on DSH's `rawOutput`.
A failed attempt blocks the next request; DSH discards that rejected input, so
the notice asks the user to run `/compact` successfully and resend it. A failure
after the clean end writes no further event: that process remains blocked, and
a cold process confirms or rejects the checkpoint by reading the log again.

There is no automatic compaction in stage 1. A session that outgrows its window
fails at the provider until `/compact` is run. Seeded sessions, forks, logs with
another engine's compactions and region compaction are refused. Removing the
opt-in rows restores `compaction-basic`, which can open and compact a session
Slice wrote. The package's bundle patch continues to insert only `slice-history`.

The existing installation acceptance runner runs the native lifecycle probes
and the writing regressions against the official DSH components it installs,
then installs the built archive by name. On the newest DSH release in its matrix
it runs P5 through two manual Slice compactions, a forced writer failure and
blocked step, recovery, CLI reopen and original-history retrieval. It also
checks the two-engine conflict and removal of the opt-in patch. These are
loopback checks, not evidence of writer quality on a real provider.
