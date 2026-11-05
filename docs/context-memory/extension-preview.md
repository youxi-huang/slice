# SLICE for Pi: independent extension preview v0.8.0

This extension runs on unmodified official Pi **1.4.0, 1.3.0, 1.2.0 and 1.1.0** as an ordinary Pi package. v0.8.0 retains the checkpoint schema and source-hash format used by v0.4.1, so existing preview checkpoints reopen unchanged, a v0.5.0 checkpoint reopens under v0.4.3, and checkpoints v0.8.0 writes, segments included, reopen under v0.7.5.
It is published on npm as `slice-pi` and on Git through the `extension-preview`
branch and immutable `extension-v*` package tags, separately from the v0.3.0
resident source build.

**v0.8.0 supports manual `/compact` and completed-turn threshold compaction,
and with the session writer compacts earlier, at a settled turn, when one more
turn would leave the writer's handover no room.** Optional background
preparation with the configured writer (A), data-only work notes from the
session model (B) and segments are all disabled by default. B carries covered
user messages in full or asks the configured writer to compact them. Sources
are validated at trust boundaries, with incremental checks between them. The
synthetic long-session scenario requires both the 50 ms request target and the
growth bound under the strict profile; the first request after each checkpoint
still pays one full check.

With every switch at its default, v0.8.0 changes two things. When a tool batch
carries the session past Pi's trigger and leaves the session writer no room
for its handover, the same writer reads the evidence in bounded chunks instead
of failing with `CONTEXT_WRITER_CAPACITY`. On GPT-6 Luna that took 143 and
155 s, where a handover that fits takes about 20 s, and one attempt in three
was refused. The writer's rules also state the note schema's limit of 20
source IDs per item, which Luna at Pi's default thinking level had broken often
enough to block a session. Segments are new and stay off: on the 0.8.0
provider runs they did not shorten the pause. Earlier, on 2026-11-01, the
published `extension-v0.7.2` compacted two first-use sessions on Luna in 13.7
and 14.0 s, reading about 95% of the writer's input from cache. The
[changelog](../../CHANGELOG.md) and the [validation record](validation.md) give
the details.

Since 0.7.0 this extension is the first adapter of the host-neutral core
package (`packages/compaction-core`), and the resident runtime is frozen as of
2026-10-22: no further ports or features, maintenance only, retirement by
0.10.0 (see [the delta's freeze note](upstream-delta.md#the-resident-freeze)).
v0.7.1 is the first extension built on that core. It behaves as v0.6.0 did and
adds official Pi 1.4.0 as the primary host. v0.7.2 installs from the new
repository address and lets a second installed copy stand aside; it compacts
as v0.7.1 did. v0.7.5 compacts as v0.7.4 did and is the first release on npm,
beside packages that give OpenCode and DSH the same `context_history`. v0.8.0
adds segments as an experiment, and its DSH package an opt-in manual writing
preview.

The project is now called SLICE, Source-Linked Indexed Compaction of
Everything. Its repository moved to `youxi-huang/slice`, and GitHub redirects
the old `youxi-huang/pi-context-compaction` address. The
`/compaction-*` commands, the `pi-context-memory.json` configuration file and
stored checkpoint identifiers keep their earlier names, so nothing needs
migrating. From v0.7.5 the package itself is named `slice-pi`, on npm and on
Git; Pi identifies an installation by its source, not by that name.

## Install, update and remove

Official Pi 1.4.0, 1.3.0, 1.2.0 and 1.1.0 users can install the pinned release
from npm:

```sh
pi install npm:slice-pi@0.8.0
```

Restart Pi afterwards. A pinned version stays fixed. To follow later
compatible releases instead, install the package without a version:

```sh
pi install npm:slice-pi
```

Update only this package:

```sh
pi update --extension npm:slice-pi
```

Pi records one entry per npm name, so installing `slice-pi` with or without a
version replaces the earlier entry.

The same package is on Git, pinned by its package tag:

```sh
pi install git:github.com/youxi-huang/slice@extension-v0.8.0
```

or following the moving branch, which `pi update --extension
git:github.com/youxi-huang/slice@extension-preview` updates:

```sh
pi install git:github.com/youxi-huang/slice@extension-preview
```

Pi records one source per package address, so installing the same address
with another tag or branch replaces the recorded source.

`pi update --extensions` updates every installed package. A plain `pi update`
updates Pi itself and `pi update --all` updates Pi and all packages; the v0.8.0
preview supports Pi 1.4.0, 1.3.0, 1.2.0 and 1.1.0.

### Before updating Pi

Check that the installed preview lists the new Pi version first; v0.8.0, v0.7.5, v0.7.4, v0.7.2 and
v0.7.1 list 1.4.0, 1.3.0, 1.2.0 and 1.1.0, and v0.6.0 lists 1.3.0, 1.2.0 and 1.1.0. On a Pi version the preview does not list, sessions it never protected are left to
Pi's own compaction, but a session it protects stays blocked: requests stop and
a failure record is written, because the preview cannot check its checkpoints
on that host. To continue such a session, reopen it with a listed Pi version
and run `/compact` there, or keep the file and continue in a new session.
`/compaction-doctor` shows which case applies.

Remove the package, whichever version is installed:

```sh
pi remove npm:slice-pi
```

A Git installation is removed by its address, whichever tag or branch is
installed: `pi remove git:github.com/youxi-huang/slice`.

An installation made from Git keeps working, and one made from the old address
keeps working through GitHub's redirect; removing or updating it still names
that address. To move it to npm, exit Pi and run:

```sh
pi remove git:github.com/youxi-huang/slice &&
pi install npm:slice-pi@0.8.0
```

For an installation from the old address, remove
`git:github.com/youxi-huang/pi-context-compaction` instead. Add `-l` to both
for a project installation, then restart Pi, reopen the session and run
`/compaction-doctor`. Do not continue a protected session between the two
commands. Never install two copies, from two addresses or from Git and npm:
Pi loads every copy,
reports only that their tools conflict, and numbers their commands
(`/compaction-doctor:1`, `/compaction-doctor:2`). From v0.7.2, a copy that
finds another one loaded stands aside, so only one compacts, and it says once
which address to remove; from v0.7.5 it keeps the npm copy. Two copies of v0.7.1 or earlier still compete for the
next compaction and pause the session. In testing, neither
`/compaction-recover` nor `/compact` cleared that pause; remove one address,
restart Pi and continue in a new session.

Install the package from one scope only (global by default, or project-local
with `-l`). A compatible older preview can reopen its own checkpoint schema;
resident and native checkpoints are not migrated.

The [v0.8.0 release](https://github.com/youxi-huang/slice/releases/tag/v0.8.0)
also provides the extension `.tgz` npm serves, the OpenCode and DSH `.tgz`,
source archive, provenance, exact-package scenario evidence and SHA256
checksums. The package contains five reviewed files and no host runtime, and
npm and Git carry the same files. Updating or removing the extension preserves
Pi credentials, other package registrations and session files.

## First use

Start a new, persistent, text-only session. After Pi starts or reloads its
extensions, the preview shows `Source-linked compaction is on.` Pi's footer then
shows `compaction: on`, the number of checkpoints on the current branch,
`compaction: writing note` during a compaction, or
`compaction: paused, see /compaction-doctor`. Then run:

```text
/compaction-doctor
```

It prints a short checklist: extension loaded, host version, session support,
writer, manual `/compact` eligibility and whether requests are paused. It calls
no model, writes no failure record and does not change the session. After a failed
attempt, the manual `/compact` line says which way out applies: `retry` when a
new `/compact` replaces the failed attempt, with `/compaction-recover` named
first when Pi already saved the staged checkpoint; `blocked` only when
`/compact` cannot help in this session, as with an unsupported host or content,
an unreadable configuration or an unavailable writer. Because Pi's own
compaction settings are not visible to extensions, it reports Pi's side of
`/compact` eligibility as `unknown` instead of guessing; `Result: ready for
requests` means nothing is blocking requests, not that Pi will accept
`/compact` yet.

`/compaction-status` prints the same findings as JSON. It keeps the fields of
earlier previews and, since v0.3.3, adds `host`, `supportedHost`, `protection`,
`reason` and `manualCompaction`; a pending attempt reads `pending` rather than
`blocked`. `manualCompaction.preview` is `ready`, `retry`, `waiting-for-turn`,
`blocked` or `not-active`, and `manualCompaction.recover` says whether
`/compaction-recover` has a saved checkpoint to confirm. `lastWriter` and
`lastCompaction` describe the current session only. Since 0.5.0, `lastWriter`
also reports the first refused candidate's quotation failures by class
(`quotations`), the kind of a repair that ran (`repairKind`), what a
quotation repair changed (`quotationRepair`) and how many writer responses
called a tool instead of writing the note (`toolCallResponses`), and whether
one was declined (`toolCallDeclined`); all but the last are counts. Since
0.5.1, each call under `writerCallDetails` also names the reasoning effort it
asked for (`effort`), the reasoning settings and output cap its provider
request carried (`sent`, read from the request Pi built, without its content)
and how the response ended (`stopReason`), and `quotationRepair.droppedFrom`
counts withdrawn facts by section. Since 0.5.3, a call whose note arrived inside
a schema envelope names its shape under `envelope`, `type` or `schema`. For the first candidate refused with
`CONTEXT_NOTE_SCOPE`, `scope` counts the cited IDs that name no entry on the
branch (`missing`) and those of entries without readable text (`unreadable`,
with their kinds under `unreadableKinds`), and how many of either sit in
`supersedes`; it never names the IDs. After v0.7.2, a source of that kind is
dropped when every fact keeps a readable source and no `supersedes` ID is out
of scope, and the note is checked again; `scopeDropped` counts the IDs dropped.
After v0.8.0, a fact left with no readable source has those sources emptied
and goes to the sources repair below, as a fact written without any;
`scopeDropped` counts those IDs too. Otherwise the refusal stands. For the
first candidate refused on the note schema, `schema` counts its facts without sources by section (`uncited`)
and says whether the note fails the schema for another reason too (`other`);
it never names the facts. Pi maps a level the model does not declare to a
supported one, so `sent` can differ from `effort`. Since Pi 1.3.0, a model that
changes effort mid-conversation, such as GPT-6 Luna, receives a fixed
`reasoning.effort` of `medium` and the requested level in a
`configuration_update` input item; `sent.effort` then reports that item's level
and `sent.fixedEffort` the fixed one.

Pi decides whether there is anything to compact before calling the extension.
With default settings Pi keeps the most recent 20,000 estimated tokens
(`compaction.keepRecentTokens`) and answers `Nothing to compact (session too
small)` until older history exists. That answer is not an extension failure and
leaves no failure record. The scenario runner reaches its first checkpoint after
about 31,000 estimated tokens of history.

## Which sessions the preview handles

The preview distinguishes three kinds of session:

- **Protected:** the session has a checkpoint written by this preview, or a
  pending or failed attempt recorded by it. Every check below is strict, and a
  failure is recorded durably.
- **Eligible:** a persistent, text-only session on Pi 1.4.0, 1.3.0, 1.2.0 or 1.1.0 with no
  checkpoint from another compactor. Manual `/compact`, Pi's threshold
  compaction after a completed turn, and earlier settled-turn compaction with
  the session writer all write checked checkpoints. Overflow recovery is
  cancelled until `/compact`. The first attempt, or a cancelled overflow
  recovery, makes it protected.
- **Not protected:** a session the preview has never protected and cannot
  check: Pi outside 1.4.0, 1.3.0, 1.2.0 and 1.1.0, an in-memory session, a native or other
  compactor's checkpoint, an image or other non-text content, or an
  unsupported context edit. The preview stands aside. It writes no failure
  record, does not stop requests, leaves manual and automatic compaction and
  cache warming to Pi, and says so once per session.

Only durable claims decide protection: a preview checkpoint in the session
file or a failure record. Content alone never releases a protected session.
A protected session that later gains an image, a checkpoint from another
compactor or an unsupported host stays blocked; continue the work in a new
supported session and keep the old file. An unreadable `pi-context-memory.json` stops each request
in an eligible session without recording a durable block, so fixing the file
and restarting Pi is enough; in a protected session the block is recorded.

v0.3.2 and earlier treated every session as protected: an unsupported session
had its requests blocked, and a failure record was written wherever the session
had a file.

## Build from source

With the repository's development dependencies installed, run:

```sh
node scripts/context-memory-preview-build.mjs
```

Then install the built directory:

```sh
pi install ./.artifacts/context-memory-preview-package
```

The builder produces an extension-only directory and an npm-compatible `.tgz`
with five reviewed files. It bundles this project's code, keeps Pi and TypeBox
as host-provided peers, and records a separate source fingerprint. It does not
rebuild or replace Pi. `preview-build.json` records the package version, the
clean source commit (or `null` for a working tree with changes) and the
independent source fingerprint.

A local-path install loads that directory without copying it. Build and
verification commands in this guide run from a checkout of the development
repository with its development dependencies installed.

## Supported workflow

Use Node.js 22.19 or newer and a persistent text session. Keep one Pi
writer process per session and load this package through normal CLI/TUI/SDK
extension discovery. Finish turns until Pi has older history to compact, use
`/compact`, inspect `/compaction-status`, and continue. With
[arm B](#work-notes-arm-b) on, the model can record work notes with
`context_note`: where the work stands, decisions and their reasons, failed
approaches, files and the current plan, each fact on one line with the
original entries it rests on. A note has no field for instructions. The model
retrieves original records on the current branch with `context_history`.
The JSONL remains the only history store.

`context_history` can also list one kind of item, newest first: the
constraints, decisions, failed approaches, files, plans and state that
committed checkpoints recorded, edits read from `edit` and `write` tool calls
with their outcome, and errors from failed tool results and shell commands. A
fact restated by several checkpoints appears once; one that a later fact
supersedes is marked with what replaced it; every item names its original
entries and carries an excerpt of one. A note's `supersedes` names entries,
not facts, so a revision marks only the facts of its own section on the entry
it names, and only when they are no more than the revisions naming it. In any
other case, such as a constraint stated in the same message as a value that
was later revised, the item carries `sourceRevisedBy` instead: its source was
revised, and the excerpt says whether the item was. The list is computed from the current
branch on every call and stores nothing. It can miss what a writer left out, so
search remains the way to check.

For SDK use, select the same agent directory through `PI_CODING_AGENT_DIR`
before importing Pi and pass it consistently to the session/resource loader.
The extension uses public `getAgentDir()` for configuration and operational
state; an SDK-only alternate agent directory is outside this candidate's scope.

The default writer is the session model with its current thinking level. A
fixed writer can be explicitly configured in `pi-context-memory.json` inside
Pi's agent directory. Authentication stays with Pi's public model registry;
the package does not copy credentials or choose a substitute on failure.

Each fact and open question in a checkpoint is one line. The writer's schema
allows line breaks, so the extension folds them into spaces before a note is
committed, and a writer cannot open a heading of its own, such as a second
`## instructions`. Exact quotes are rendered as JSON strings and stay exact.
Checkpoints written by v0.4.0 keep their summaries and reopen unchanged.

Since 0.5.3 every note writer asks for the note itself rather than for an
object matching the note's schema. Before validation the extension removes the
two schema envelopes GPT-6 Luna returned around complete notes: a string `type`
beside exactly the seven sections, and `type`, `properties` and `required` with
exactly the seven sections under `properties`. It removes nothing else, and the
note then passes every check as before.

The session writer reads the conversation without entry IDs, so its handover
request also lists every uncovered user message in full beside its ID, whole
or not at all, within the note's hard allowance; the request drops this block
before it shortens anything else. When a candidate fails only on quotations,
for at most five facts, the writer gets one repair request that names those
facts, the entries they cite and the entries that do contain the quoted text,
with their roles. A replacement may change only its sources and quote, or
withdraw the fact; every other fact stays as written, and the whole note is
checked again. A failed quotation is a fault in the evidence, not a
retraction: a repair that withdraws an instruction whose quoted text a user
message contains refuses the note with `CONTEXT_NOTE_REPAIR_LOSS`, since a
misquoted rule is still a rule. Re-citing it or dropping its quote remains
possible. Since 0.5.1 the quotation repair runs without reasoning, whatever the
writer's effort: it rebinds at most five quotations, and on DeepSeek it passed
as often without reasoning as at `high`, at a quarter of the output.

Every fact in a note, next steps included, must cite at least one entry. When
a candidate's only fault against the schema is facts without sources, for at
most five facts, the writer gets one repair request, also without reasoning,
that names those facts beside the entries they may cite: the active requests
and other user messages in full, excerpts of the entries the rest of the note
cites, and the uncovered entries by their opening words. The answer may add
sources only, and the whole note is checked again. A fact cannot be withdrawn
here: most such facts are next steps, and dropping unfinished work to avoid
citing it would commit a note that lost it silently. After v0.8.0 the same
repair serves a fact whose every source names no entry or one without readable
text. On GPT-6 Luna seven of eight attempts at one compaction were refused, and
the answers read back gave one fact `1598f6dcb`, the head of one entry's ID and
the tail of another's; the repair names such a fact with its sources emptied
and never sends the invented ID back. `noteRepair` governs
this repair, the quotation repair and the size repair, and a compaction spends
at most one of them. A second failure blocks as before. The extension never
moves a quotation to another entry or supplies a source on its own: text found
only in an assistant message or a tool output is not a user ruling.

The session writer's request is the session's own system prompt, tools and
messages plus one closing message, and it sets no tool choice, just as the
session's requests do. Since 0.5.3 it also carries the session's ID, which Pi
sends with each of the session's requests: Pi's OpenAI providers key their
prompt cache on that ID, and providers that need no key ignore it. When the
transcript records the system prompt itself, as Pi 1.4.0 does, the writer sends
it where the transcript has it, mid-history included in a session begun before
1.4.0, and adds the host's prompt and tools at the head only when the transcript
records none: the session's own requests are built the same way. A provider that
caches prompt prefixes therefore serves most of the request from the cache the
session has already warmed: on DeepSeek, 95 to 97% of the writer's input over
192 compactions. The closing message tells
the model to call no tool. A tool call is never run: the first is answered as
unavailable and the same request continues once. That continuation does not
spend the compaction's one repair, so a handover makes at most three writer
calls. A second tool call, or one with `noteRepair` off, refuses the note with
`CONTEXT_WRITER_FAILED`. On DeepSeek about one writer response in twenty called
a tool.

When a tool batch carries the session past Pi's compaction trigger and into
its reserve, the full handover may not fit even with bare citation IDs. The
same session model, at the same thinking level, then reads the original
evidence in bounded chunks. The choice is made before the first writer request,
never after a failure, so a writer that fails still blocks the session. Each
chunk carries the note so far with the original IDs and offsets, and all chunks
share the frozen note budget, the checks and the one repair. The price is more
calls and no prefix cache: on GPT-6 Luna a chunked compaction took 143 and 155 s
where a handover that fits took about 20 s. A larger `compaction.reserveTokens` in
Pi's settings makes it rarer. Segment requests and the tail a segments
checkpoint keeps are unchanged.

Configuration is latched for the process; restart Pi after changing it. The
preview uses the writer, note-budget, repair and retained-text settings from
that file. `compactAt` bounds the manual checkpoint budget but does not start
automatic compaction; the resident event log and its report are not provided.
Setting `enabled: false` and restarting ends the package's protection.

This preview compacts at completed turns: on `/compact`, and when Pi's
threshold compaction runs after a turn completes. With the session writer it
also starts that compaction itself at a settled turn whose context, with one
more turn as large as Pi's default reserve or as the turn just settled, would
leave the writer's handover no room. It checks again at once after `/tree`,
whose new branch may already sit that close to the limit. On a 272,000-token
route Pi's own trigger leaves 16,384 tokens, less than a handover takes.
One-shot `print` and `json` runs, which exit when the turn settles, are left to
Pi's trigger. Both lines
read Pi's own count of the context, from the provider's reported usage, as do
the request guards. While input is queued or a
session is blocked, threshold compaction is left for a later turn and nothing is
recorded; a blocked session still needs an explicit `/compact`. `/compact`
may follow a turn that ended on a provider error, an abort or a stopped
request at once: that turn is kept whole after the checkpoint, and the
writer's handover follows the last completed turn. Overflow
recovery, unfinished tool rounds, in-memory sessions, attachments, context
edits other than validated recovery omissions, old checkpoints, parent-history
grants and other context-transforming or compaction extensions are outside its
verified scope. In the sessions it handles, unsupported compaction is cancelled
explicitly, without native summary fallback.

Ordinary Agent retries may append an omission of the latest failed assistant response in the current
checkpoint interval. Replacement content, user-message edits and failed
responses containing tool calls remain unsupported. Normal Agent retries do
not create a compaction failure marker. A previously blocked retry session
with sufficient completed source history can recover through explicit
`/compact`; the marker clears only after the new checkpoint is confirmed on
disk. Text-only context-overflow failures can use the same manual recovery,
which retains the unfinished user request. `/compaction-recover` still only
confirms an already staged checkpoint. Published v0.3.1 assets do not contain
the retry fix.

While a session is handled by the preview, it returns `stop` from Pi's public
cache-warming decision event. Background warming bypasses ordinary request
guards and can append usage records during a writer snapshot, so it is paused
without changing the user's settings. Normal provider prompt caching remains
available.

## Failure and recovery

An attempt writes a pending operational marker before calling the writer.
Invalid JSON, incorrect quotations, unreadable sources, unavailable writers,
cancellation and changed source snapshots stop the attempt. No replacement
summary is requested. Further model requests are aborted while the package
remains loaded, including after new input, reload and reopening a session
with a persisted pending or blocked marker.

Use manual `/compact` for an explicit retry. A retry only clears the block
after the returned checkpoint and its exact source prefix have been read
back from the actual session JSONL. There is no clear-failure command that
lets a prompt bypass this confirmation. `/compaction-status` shows the state
without calling a model.

If Pi saved the checkpoint but the commit confirmation was interrupted, use
`/compaction-recover`. It only confirms a current-leaf checkpoint with the exact
staged candidate hash and unchanged sources, after note and disk validation.
It cannot clear a writer failure or a checkpoint that was never staged, and a
refusal changes nothing. In v0.3.2 and earlier, running it with nothing staged,
including on a healthy session, recorded a `CONTEXT_PREVIEW_COMMIT_UNCONFIRMED`
block that only a successful `/compact` cleared.

If a blocked session ends exactly at an older successful checkpoint without a
staged attempt, stock Pi may report `Already compacted` before invoking the
extension. Pi then needs more new history than a paused session can add
before `/compact` runs again, so keep the session file and continue in a new
session.
Initialization failures before any completed source turn, unsupported session
formats and incompatible hosts require a fresh supported session after fixing
the cause. Neither recovery command forces those cases through validation.

Each failure and each blocked input produces one notice (v0.3.2 could repeat
the same notice two to four times). The first explains what happened, whether
requests are paused and what to do, with the controlled error code last.
Later inputs blocked by the same code get a short warning until a checkpoint
or recovery is confirmed. Text typed in Pi's interactive editor while paused
goes back to the editor: no request starts and nothing enters the session.
Messages queued during a failed `/compact` come back together under one
notice. After a refused `/compact`, Pi adds its own `Compaction cancelled`
below the notice. Inputs from RPC, print mode or other extensions, and inputs
with images, still reach the request guard, where Pi adds `This operation was
aborted`. The notice says why, and `/compact` is suggested only where it can
help. Pi's overflow recovery request
is reported as `CONTEXT_PREVIEW_COMPACT_REQUIRED` (earlier
`CONTEXT_PREVIEW_UNSUPPORTED`; before v0.4.0, threshold
compaction was reported the same way). After a rollback to v0.3.2, that record reads
as invalid and stays blocked until an explicit `/compact`, which recovers it;
a v0.3.2 record opened by v0.3.3 recovers the same way.

Markers contain identifiers, hashes and controlled error codes, never note
text, transcript content or credentials. Marker IO errors block the current
process. If the very first pending marker cannot write any bytes, no durable
failure record exists; that failure cannot be promised across a process
restart once the storage fault has been repaired. An already durable pending
marker remains blocking if a later stage or checkpoint write fails.

Readback is bounded to 64 MiB and 250,000 JSONL records per session. Larger
files are blocked explicitly; they are outside this first candidate's support.
Stored checkpoints and their sources are validated in full, and the session
file is read back from disk, at trust boundaries: session start or reload, a
branch change, a new checkpoint, `/compact`, `/compaction-recover` and after
any failure. Between them a request checks only the entries added since and
compares the file's identity and length with what Pi's appends should produce.
A failed or foreign append, a truncated file or a replaced file is therefore
found by the next request. A rewrite that keeps the same file and length, or an
in-place edit of entries Pi has already loaded, is found at the next boundary
instead; it cannot pass a checkpoint commit.

Pi owns checkpoint append and may expose it in memory before the extension
confirms disk state. The package checks publication before resuming requests;
it does not provide the resident build's disk-before-memory writes or leases
over all host operations. Removing, disabling or filtering out the package
ends its protection. Leave a blocked session with the package enabled and
use the explicit retry operation.

## Optional preparation experiments

v0.4.0 adds optional background preparation; the pinned v0.3.3 tag does not
contain it. To opt in, add this field alongside the ordinary settings in
`pi-context-memory.json` and restart Pi:

```json
{
  "previewPreparation": {
    "enabled": true
  }
}
```

The configured writer prepares once per checkpoint interval, after a completed
turn, when the context enters the band just below Pi's threshold compaction
point: 12.5% of it, between 8,192 and 32,768 tokens. The point is the window
minus Pi's effective `reserveTokens` for the current model, read from Pi's
settings with a `compaction.modelOverrides` entry first, so a lowered trigger
such as a [capacity profile](context-pressure.md) moves preparation with it.
Pi's defaults leave the band where it was. A run has a 120-second deadline, at
most eight provider calls and no repair. One candidate is kept in memory and is
lost on restart. Earlier experimental keys (`minSourceTokens`, `minIntervalMs`,
`deadlineMs`, `maxCallsPerAttempt`, `ledger`) are ignored; an invalid value
disables preparation without affecting requests or the formal compaction failure
contract.

At compaction, a complete, current candidate is committed without a writer
call. When turns were added after it, the candidate is still committed without
a writer call for the prefix it covers: the checkpoint records that prefix, and
every later original stays in context verbatim after it. This prefix path is
taken only when the cut drops nothing the note did not see, follows the previous
checkpoint, makes the context smaller and leaves it within 80% of the compaction
threshold. Otherwise, or with custom focus, the candidate is discarded and the
writer compacts synchronously from the originals.

Every writer call, preparation and compaction alike, is recorded in a
content-free journal under `context-memory-preview/calls/` in Pi's agent
directory. The start of a call is on disk before the request is sent and its
settlement follows, so a call interrupted by a crash stays visible as unsettled
rather than free. Optional preparation never sends an unrecorded call and pauses
while the journal cannot be read or written; a formal compaction proceeds and
reports the gap. `/compaction-status` shows `preparation`, the journal's `calls`
summary and `lastCompaction`; `lastCompaction.stageMs` ends at staging and
`pauseMs` is set after disk confirmation.

Checkpoints from the complete and synchronous paths cover the whole branch;
prefix and notes checkpoints cover what their candidate or notes saw.
Synthetic execution establishes lifecycle behavior; natural hit rates, provider
quality and cache economics still require evidence.

## Optional reduction, excerpt and rendering experiments

v0.6.0 adds three further opt-in switches beside `previewPreparation`; the
pinned v0.5.3 tag and earlier do not contain them. Each is off by default and
disabled by any invalid value without affecting requests or the compaction
failure contract:

```json
{
  "previewReduction": { "enabled": true },
  "previewExcerpts": { "enabled": true },
  "previewRendering": { "enabled": true, "candidates": ["lineage-once"] }
}
```

With `previewReduction` on, the request's projection replaces two kinds of
tool results with one line each — an earlier read of a file that was read
again later, and a consumed result after which a later turn completed — naming
the tool, its target, the first line of its result and the record ID, which
`context_history` reads back in full. The reduction is recomputed from the
records on every request and never stored: the session file is untouched, the
same records always produce the same bytes, appending turns never un-reduces
an entry, and an entry is first reduced only when little follows it on the
branch or after a long recorded idle gap, so the provider's cached prefix
stays stable. User messages, assistant text, checkpoint summaries, error
results and the sole evidence of a committed fact are never reduced, tool
calls stay paired with their results, and a failed compaction blocks exactly
as before. `/compaction-status` reports content-free counts under
`reduction`.

With `previewExcerpts` on, when the user's prompt names an identifier-shaped
term that only compacted or reduced entries hold, the request ending with
that prompt gains one short original excerpt at its end, labelled as
historical evidence with its record ID and role, never as an instruction. At
most two excerpts of at most 200 estimated tokens each are appended, a
deterministic secret filter withholds a matching record entirely and names
only its ID, nothing is written to the session, and every earlier message is
unchanged, so the cached prefix is untouched. `/compaction-status` reports
counts under `excerpts`.

With `previewRendering` on, the summary the model sees is derived from the
stored note and lineage by a pure function while the stored checkpoint bytes
never change, and the recovery guards accept and require that same
derivation, so a tampered rendering is still refused. Its candidates are
selectable one at a time: `folded-failed-paths` folds failed paths whose
sources precede the previous checkpoint to one line with their source IDs,
`lineage-once` renders guidance once and folds repeated lineage state lines
with every anchor kept, and `cited-roles` shows the roles of the records each
fact cites, computed from the records. `/compaction-status` reports the
active candidates under `rendering`.

`context_history` results now state `readTokens`, the estimated cost of a
full read, and mark hits whose entries are already in context; `read`
accepts `detail: "low"` for a bounded opening with the full cost stated, and
`full` remains the default. Synthetic regressions and scenarios establish
these mechanics; token savings and recovery on a real provider are
unmeasured, and all three switches stay off until that measurement supports
a default.

### Work notes (arm B)

Arm B has its own switch, also off by default:

```json
{
  "previewWorkNotes": {
    "enabled": true
  }
}
```

With it, a one-line tool guideline asks the session model for a work note after
a decision, a failed approach or a completed subtask. With B off, a fresh session
does not offer `context_note`. A branch with an earlier call, saved or refused,
activates it on reopen or branch navigation so the earlier calls keep their tool
declaration. This only adds the tool: an explicit activation is preserved, and
the tool stays active after moving to a branch that does not need it, until the
next session. Previously saved notes still reach the synchronous writer as
hints with B off.

At compaction with B on, the extension merges the previous checkpoint's note
with the valid notes since, in order, without a model call. A fact that
supersedes a source drops the earlier
facts citing it, and the newest plan replaces the older one. A note that lists
`gaps` replaces the open questions recorded before it, and an empty list closes
them; a note without `gaps` keeps them. Instructions from
the previous checkpoint are carried unchanged; no note can add or drop one. The
merged note covers the branch through the last work note and is committed
through the prefix path above, so everything after it stays verbatim.

The extension then appends the user's own messages up to that point, verbatim
and in order, as JSON lines after the note. No message is ever shortened. The
checkpoint records
their entry IDs, and every full validation renders them again from the
originals, so an edited message blocks the session like an edited quote.

The writer compacts synchronously instead, with the notes as hints, when those
messages do not fit in full within 5% of the compaction threshold (at most 6,000
estimated tokens), as with a long pasted log, when a note supersedes the source of a carried instruction, when a
superseded source supports more earlier facts than the note gives in their
place, when the merge exceeds the note schema or budget, when the prefix conditions fail, when
the commit would leave half the compaction threshold or more in context (the
turn of the last note stays verbatim), or with custom focus. That writer also reads the user messages an earlier notes
checkpoint carried. `details.preparation.path` is `notes` for these
checkpoints, with `noteIds` naming the merged notes; when B leaves a compaction
to the writer, `details.preparation.notesFallback` records why.

Two limits remain. `supersedes` is optional and names entries, not facts: a
correction recorded without it leaves the earlier fact in the note beside the
newer one, and the merge does not guess which is current. Facts also accumulate
until a note supersedes them or the writer rewrites the note, so a long task
reaches the schema's bounds (40 facts per section, 20 gaps) and falls back to
the writer more often. Both wait for a note schema with stable fact identities.

### Segments (0.8.0)

Segments have their own switch, off by default:

```json
{
  "previewSegments": {
    "enabled": true
  }
}
```

With it, the session model writes a segment note in the background after a
completed turn, through the session's own request so the provider's cache
serves it. The first segment of a checkpoint interval waits until the context
reaches half the compaction threshold and covers everything since the previous
checkpoint; each later one waits for 15% of the threshold, between 8,192 and
32,000 tokens, of new history. A segment cites only the turns it covers. One
runs at a time; the segments are kept in memory and lost on restart. A fixed
`writerModel` writes none.

Segments are written at the session's thinking level unless `effort` names
another, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`:

```json
{
  "previewSegments": {
    "enabled": true,
    "effort": "low"
  }
}
```

A segment only records what its own turns add, and the merge carries the rest,
so a lower level costs less where it matters least. With a level of their own,
segments stay valid when the session's level changes; without one, a changed
level discards them, since another level is another writer. An unknown level
turns segments off, and `/compaction-doctor` says so.

At compaction the extension merges the previous checkpoint's note with the
segments, in order, without a model call, the way B merges work notes, except
that a segment may add instructions found in its own turns. When the user
changes an earlier ruling, the segment's new instruction replaces the old one,
provided it cites the user's own message and names the old instruction's
sources in `supersedes`. The merged note is
committed through the prefix path, so the turns after the last segment stay
verbatim, unless they hold more than one segment range (15% of Pi's trigger,
between 8,192 and 32,000 tokens) or the result would leave half the compaction
threshold or more in context. A segment still being written is waited for at most 15 seconds when
only it would let the merge commit, and `details.preparation.segmentsWaitMs`
records the wait. `details.preparation.path` is then
`segments`, with `segmentIds` and the `callIds` that wrote them.

The writer compacts synchronously instead, as before, when no segment is ready
or valid, after an unfinished turn, with custom focus, when a segment would
retire a carried instruction without a ruling from the user in its place, when
the merge is ambiguous or exceeds the note schema or budget, when the turns
after the last segment hold more than one range (`tail`), or when the prefix
conditions fail.
`details.preparation.segmentsFallback` records why.

Segments are an experiment. On the 0.8.0 provider runs they did not shorten
the pause over a whole session, and in one case they made it worse: the turns
after the last segment then stayed verbatim up to half the threshold, and a very
large paste or tool output soon after took the next request past the window,
where the writer had no room to compact and the session blocked. The tail is
now bounded to one range. In a rerun on GPT-6 Luna no session blocked, but
segments served no compaction, and waiting for one still being written made
each pause up to 15 seconds longer. Leave segments off unless you are
measuring them. At a `max` thinking level a segment can also take longer than
its two-minute deadline. The records are in
[validation.md](validation.md#080-wp5-rerun-gpt-6-luna-with-the-bounded-tail-2026-11-04-utc).

Segments never block work themselves. They stop for the rest of a checkpoint interval
after eight calls, or once their calls have spent as many uncached tokens as
the threshold holds, a call with unknown usage spending all of it. They also
stop after three failures of one kind in a row, until the next checkpoint.
`/compaction-status` shows `segments` with how many are ready, how far they
reach and the share of history since the last checkpoint they cover, and
`calls.segmentCalls`; `/compaction-doctor` says when they are paused and why.
`segments.results` counts how this session's segments ended, without content:
linked into the chain, cancelled in flight, no longer extending the chain,
refused or failed by error code (`CONTEXT_SEGMENT_DEADLINE` for a run past its
deadline), and links dropped when a later turn classified the chain again, by
the reason it stopped. `limited` counts segments the writer kept to their own
turns: writers often restate the previous checkpoint in a segment, and a fact
that cites only earlier turns is dropped there, since the merge carries the
previous note anyway.

## Verification

Focused tests run through `scripts/context-memory-check.mjs`. The independent
acceptance runner tests the actual built artifact against an isolated official
npm Pi installation, using synthetic credentials and a loopback provider. Install
that official Pi first:

```sh
node scripts/context-memory-preview-stock-install.mjs \
  --stock-root ./.artifacts/context-memory-preview-stock --version 1.4.0
```

The installer pins all seven official runtime packages for Pi 1.4.0, 1.3.0 and 1.2.0,
or all eight for 1.1.0 and 1.0.4, which still require `chord`, to the same
release. A newer host that still depended on `chord` would fail the installer's
dependency review rather than receive it silently. npm verifies download
integrity; the installer checks registry provenance, exact versions and isolated
resolution, then starts the SDK with networking blocked. Unused manifest and
lockfile SHA-256 report fields are omitted.
Installing only `pi-coding-agent` at 1.2.0 or earlier lets its caret
dependencies select a newer Pi cohort and can fail at SDK startup. No official package source is patched.
An existing coherent installation skips npm; `--check` verifies it without
installing. The JSON report lists each runtime package's version and integrity.

Install each older supported host for the same-package and cross-version
checks:

```sh
for host in 1.3.0 1.2.0 1.1.0; do
  node scripts/context-memory-preview-stock-install.mjs \
    --stock-root ./.artifacts/context-memory-preview-stock-$host --version $host
done
```

Then run acceptance on every host. The first command also writes a checkpoint,
compacts it on each older host in turn and reopens it on 1.4.0 after each:

```sh
node scripts/context-memory-preview-acceptance.mjs \
  --package-dir ./.artifacts/context-memory-preview-package \
  --stock-root ./.artifacts/context-memory-preview-stock \
  --compatible-stock-root ./.artifacts/context-memory-preview-stock-1.3.0 \
  --compatible-stock-root ./.artifacts/context-memory-preview-stock-1.2.0 \
  --compatible-stock-root ./.artifacts/context-memory-preview-stock-1.1.0 \
  --output-dir ./.artifacts/context-memory-preview-acceptance
```

```sh
for host in 1.3.0 1.2.0 1.1.0; do
  node scripts/context-memory-preview-acceptance.mjs \
    --package-dir ./.artifacts/context-memory-preview-package \
    --stock-root ./.artifacts/context-memory-preview-stock-$host \
    --output-dir ./.artifacts/context-memory-preview-acceptance-$host
done
```

CI and publication take this host list from the candidate's own
`preview-build.json`, printed by
`node scripts/context-memory-preview-release-checks.mjs --plan ./.artifacts/context-memory-preview-package`,
and `node scripts/context-memory-ops.mjs preview` runs the same sequence. Adding
a host to `compatibility.ts` therefore adds it to every check, and a host
without a reviewed installation cohort stops the plan.

This is deterministic protocol and lifecycle verification. It does not measure
real-provider compatibility, semantic recovery quality, compaction latency or
Windows behavior. No official Pi source, real account, existing user settings
or session is modified by these isolated checks.

Acceptance copies the package to a temporary directory outside
any Node project and runs every case there, keeping only `report.json` and
per-case results in `--output-dir`. Inside this repository, once
`npm run build:offline` has run, a package's Pi imports resolve to the
repository's patched workspace build instead of the host under test; acceptance
runs before v0.3.3 were exposed to that. The runner stops if
its temporary directory sits inside a Node project.

The scenario runner checks the same artifact under default Pi and extension
settings, each case beside a control run without the extension. The unsupported
1.0.4 installation only serves the other-version case:

```sh
node scripts/context-memory-preview-stock-install.mjs \
  --stock-root ./.artifacts/context-memory-preview-stock-1.0.4 --version 1.0.4
```

```sh
node scripts/context-memory-preview-scenarios.mjs \
  --package-dir ./.artifacts/context-memory-preview-package \
  --stock-root ./.artifacts/context-memory-preview-stock \
  --other-stock-root ./.artifacts/context-memory-preview-stock-1.0.4 \
  --output-dir ./.artifacts/context-memory-preview-scenarios
```

Every scenario check states intended behavior. Checks in the script's
`KNOWN_GAPS` list describe behavior the preview does not provide yet; they are
reported without failing the run. A listed check that starts passing fails the
run until it is removed from the list, so each fix becomes a required
regression. The runner also loads a copy of the package from a temporary
directory outside the repository. The long-session case uses 20 checkpoints by
default; `--perf-checkpoints 60` runs the full measurement, which takes several
minutes.

## Maintainer publication

For each full release, update the extension package version and pinned install commands with the source version, then verify the matching `v<version>` and `extension-v<version>` tags and all release assets together; a source-only tag is not a completed extension release.

Merge the reviewed source through a PR and confirm `verify` and all three
CodeQL checks on the final main commit. Push a new immutable `v<version>`
source tag to that commit. The **Publish extension preview** workflow verifies
those checks, rebuilds and tests the package on official Pi, creates the matching
`extension-v<version>` package tag, updates `extension-preview` without a force
push, and publishes a pre-release after all assets are uploaded. Every release
since v0.4.0 also reruns the complete strict scenario suite and binds its content-free evidence
to the final artifact; the earlier A-preview exception applies only to
v0.4.0-preview.1. Existing public
assets and tags are never overwritten. The resident runtime keeps release
version v0.3.0; v0.4.1 changes its build fingerprint for the one-line note fold,
with the frozen evaluator pinned to that source.

A source tag whose version differs from the extension package it builds is a
source release, as v0.7.0 was for the host-neutral core. When that package
version is already published, the workflow ends after the build with a notice
and publishes nothing; when it is not, the run fails before any official Pi is
installed. An extension release therefore sets its new version in
`scripts/context-memory-version.mjs` before the tag is pushed: a
forgotten bump is reported as a source release, not as a failure. Every
package a release builds reads its version there.

From v0.7.5 the same run publishes on npm. Before anything is published it
builds `slice-opencode` and `slice-dsh` from the tag and installs each by name
on official OpenCode and DSH, as the [host adapter guide](host-adapters.md)
describes. After the extension's Git refs it tags `opencode-v<version>` and
`dsh-v<version>`, publishes `slice-pi`, `slice-opencode` and `slice-dsh` with
npm provenance, and only then makes the release public. npm never accepts a
version twice: a retry skips a package npm already holds with the same bytes,
and different bytes stop the run.

The workflow authenticates through npm's trusted publishing with the run's own
OIDC token. `slice-pi`, `slice-opencode` and `slice-dsh` have had a trusted
publisher since v0.7.5 (GitHub Actions, repository `youxi-huang/slice`, workflow
`context-memory-preview-release.yml`), so a release needs no token or secret.

npm sets up trusted publishing only for a package that already exists. A new
package's first publication therefore needs a token, as v0.7.5 did:

1. Create a granular access token that can publish new packages without an
   interactive two-factor prompt, for example with
   `npm token create --name <name> --packages-all --packages-and-scopes-permission read-write --bypass-2fa --expires 7`,
   and store it as the repository secret `NPM_TOKEN`.
2. Publish the release as usual.
3. Add the trusted publisher, for example with
   `npm trust github <package> --repository youxi-huang/slice --file context-memory-preview-release.yml --allow-publish`.
4. Delete the `NPM_TOKEN` secret and revoke the token.

npm 11.21.1 warns that such tokens stop publishing directly in January 2027. A
package added after that needs another route to its first version.

If publication tooling needs a fix after a source tag was created, merge the
fix through the normal PR checks. Retry **Publish extension preview** from that
main commit using its `source_tag` workflow input, or push that commit to
`release/publish-v<version>`. The job uses the reviewed tooling while rebuilding
and testing the immutable source tag; provenance records both commits. No tag
or existing public asset is replaced, and uploaded assets are not downloaded
again for verification. A run that fails after uploading leaves a draft
release. The retry keeps the draft's archives, which must match its rebuild
byte for byte, and replaces only the evidence the failed run wrote about
itself: `release-provenance.json`, `preview-acceptance-profile.json` and
`SHA256SUMS`.
