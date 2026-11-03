# Changelog

This file records changes to SLICE, called Pi Context Compaction before v0.7.1. The changelogs under `packages/` retain the upstream Pi package history. Project releases use their own version numbers; the initial host baseline is Pi `v0.85.1`.

Changes under **Unreleased** are not included in an existing release tag or its downloadable assets. Entries describe user-visible behavior, compatibility, security and significant maintenance changes.

## [Unreleased]

### Added

- DSH has an opt-in manual writing preview at `slice-dsh/compaction`: `/compact` writes and validates a Slice checkpoint in the native log, `/compaction-status` reports the gate, and failed or unconfirmed attempts block later requests. It uses `rawOutput`, a field DSH owns, for the structured checkpoint. The default history entry remains retrieval-only; stage 1 has no automatic compaction.

- With preparation on, a checkpoint that preparation did not serve records why in `details.preparation.preparationFallback`: nothing was prepared, a run was still in flight or had failed or been cancelled, the candidate no longer matched its sources, a stale candidate left no reusable prefix, the turn was unfinished, or the prefix did not fit. Work notes already record their own reason in `notesFallback`. Older readers ignore the field; no checkpoint format changes.

### Maintenance

- The host-neutral core gains 0.8.0's segment contract (`segments.ts`): a segment freezes and validates like a preparation candidate over a closed range and cites only inside it, a chain merges its longest contiguous valid prefix, and the merge, generalized from the work-note merge as `mergeNotes`, says why it leaves a boundary to the writer. The specification states the chain and the coverage invariant, and the conformance set, now `0.8-conformance.1`, adds 24 segment vectors in `segments.json`. Nothing calls it yet; work notes merge as before.
- 0.8.0's segments can be written but are not yet switched on or merged. The core chooses each range at a settled turn (`nextSegmentRange`), the session writer writes a segment from the session's own request with an instruction that limits citations to the range, and the call journal records segment calls under their own purpose, at most eight per checkpoint interval and within a spending cap where unknown usage spends it all. In the Pi preview, `PreviewSegments` runs one segment at a time, cancels it when the session, branch or writer changes, and stops after three failures of one kind until the next checkpoint. `/compaction-status` counts segment calls.
- The loopback A/B runner runs chains of up to eight compactions (`--cycles`), can send each input without waiting for preparation (`--pace immediate`), and reports each arm's pause at the median and the 95th percentile, the 95th percentile over boundaries that needed no foreground writer call, the count of each fallback cause, and turn time per request beyond the simulated latency. It is the measurement 0.8.0's segments will be compared against.

- npm publication takes `slice-pi`, `slice-opencode` and `slice-dsh` in a fixed order whatever order the adapter build reports them in. The first v0.7.5 run stopped on that order before publishing anything to npm.
- A publication retry can complete the draft release a failed run left behind. It keeps the draft's archives, which must match the rebuild, and replaces only the failed run's own evidence: its provenance, scenario profile and checksums. Assets on a public release are still never replaced.

## [v0.7.5] — 2026-11-02

v0.7.5 publishes SLICE on npm for all three hosts: the Pi extension as `slice-pi`, and the OpenCode and DSH history packages as `slice-opencode` and `slice-dsh`. The Pi extension compacts as v0.7.4 did; its one runtime change is which copy the duplicate notice keeps. This release changes no checkpoint format, resident build fingerprint or evaluation pin.

### Added

- From 0.7.5 each release is published on npm as well as on Git, so none of the three hosts needs a clone or a build. Pi installs the extension with `pi install npm:slice-pi`. OpenCode installs `slice-opencode` at start once it is listed under `plugin` in `opencode.json`. DSH installs `slice-dsh` with `dsh plugin --profile <profile> add slice-dsh`. The Git package and the `extension-preview` branch stay, and the OpenCode and DSH packages are also tagged `opencode-v<version>` and `dsh-v<version>` for installation without npm. Before anything is published, the release workflow installs the OpenCode and DSH packages by name from a loopback registry on official OpenCode 1.19.4 and 1.19.5 and DSH 0.2.1-rc.3 and rc.5, where a scripted session compacts natively twice and reads its history back, and installs, runs and removes the Pi package by name on every supported Pi. All three are published with npm provenance.

### Changed

- The Pi package is named `slice-pi`, its npm name, on Git as well; it was `pi-context-compaction-preview`. Pi identifies a Git package by its address, so existing installations keep loading and updating. When an npm copy and a Git copy are both loaded, the duplicate notice keeps the npm one and names the Git one to remove; a second npm copy is named without its version, `pi remove npm:slice-pi`.
- The DSH package declares a DSH bundle, so `dsh plugin add` enables it with no hand-added `slice-history` row in the profile's `cordis.patch.yml`. A profile that carries that row from an earlier build must drop it, since the tool refuses to register twice. `dsh plugin --profile <profile> remove slice-dsh` removes the package and deselects its bundle.
- The OpenCode package declares `engines.opencode` `>=1.19.4 <2.0.0`, which OpenCode checks before it loads an npm plugin. Both packages carry a README of their own.

### Fixed

- The DSH package installs on DSH 0.2.1-rc.4 and rc.5. Its peers named rc.3 alone, and DSH checks them before installing and at startup, so it refused the package on any later release. They now admit rc.3 and every later 0.2.x release; nothing the adapter uses changed between rc.3 and rc.5.

### Maintenance

- `scripts/context-memory-version.mjs` holds the release version every package reads. CI gains an `adapters` job that runs the adapter checks and the install acceptance, `scripts/context-memory-adapters-acceptance.mjs`. `context-memory-host-run.mjs --install registry` installs an adapter by package name from a loopback registry, `scripts/context-memory-loopback-registry.mjs`. The release workflow gains `id-token: write` for npm trusted publishing and a 30-minute limit. The first npm publication uses an `NPM_TOKEN` secret, deleted once each package has a trusted publisher, as the extension guide's maintainer section describes.

## [v0.7.4] — 2026-11-02

v0.7.4 brings the source and installable Pi extension to the same version, including the changes below since v0.7.2. The existing v0.7.3 tag remains a source-only release and is not moved; the matching installable package is `extension-v0.7.4`. This release preparation changes no runtime behavior, checkpoint format, resident build fingerprint or evaluation pin.

### Added

- The preview evaluation set gains P5, one long session for compactions on 200k and 272k routes: its checkpoints 1, 3 and 5 are three rounds at about 150,000 tokens of context, 2 and 4 two rounds at about 204,000, each later round compacting with the earlier notes in place. Its probes ask for early facts after two and three notes and for values that changed between rounds. P5 has its own version and manifest, so P1 to P4 keep their pins. The preview bench selects a route's rounds with `--cuts`, runs only the session's own probe condition with `--probe-conditions history`, stops a run at the first request past `--max-input-tokens`, cached tokens included, and with `--compactions-only` runs a chain without its probes. `--cache session` runs each warm-up turn on the session itself, so the writer continues it as it continues a session's last turn, which OpenAI's implicit cache needs.
- `scripts/context-memory-host-run.mjs` runs fixture P5 as a session on the official OpenCode 1.19.4 or DSH 0.2.1-rc.3, with the Slice retrieval package and a 200k or 272k route's capacity profile. A local stand-in for OpenAI's Responses API answers with `--provider loopback`; `--provider openai` sends GPT-6 Luna requests through the proxy secret. The user pastes every command's output and the host's own model replies, so native compaction runs at the profile's line; after two compactions the run asks P5's questions, then four exact log timestamps that summaries rarely keep. No request may reach 262,000 tokens by estimate, and a provider run needs request, time and cost limits, which hold inside a turn too. `report.json` records each model call's usage, the compactions and their pauses, the retrieval calls and both scores.
- The preview bench's `--arm native` runs a `probes` chain with no package loaded, so Pi's own compaction summarizes each cut with the same model, thinking level and settings, and the probes answer from Pi's summary. It takes only `--probe-conditions none`, since there is no `context_history` without the package, and its summary calls count toward `--max-input-tokens`. Paired with a Slice run's `history` condition it compares what a user gets with and without the package; the first pair, on GPT-6 Luna at `medium`, is in the validation record.
- `scripts/context-memory-pressure-profile.mjs` prints native compaction settings for Pi, OpenCode 1.19.4 and DSH 0.2.1-rc.3 from verified context, output and optional input limits. A 200k route with a 32k output cap gets a 150k trigger and 15k of recent text; `--model` scopes Pi's values to that route. Missing or contradictory limits are refused, and OpenCode without `limit.input` is reported as keeping its 168k line. The script writes nothing and changes no adapter's scope.

### Fixed

- The independent preview no longer stops a long session short of Pi's compaction trigger. Its request guards estimated four characters per token, while Pi's trigger reads the provider's reported usage; English prose and escaped code run past four characters a token, so on GPT-6 Luna at Pi's defaults the guards stopped requests about 16,000 to 18,000 tokens before the trigger and no automatic compaction ran. Both guards now read Pi's own count once a response has reported usage, and the session writer sizes its prefix by it too. Because Pi's default reserve of 16,384 tokens is less than the session writer's handover takes on a 272,000-token route, a settled turn whose context, with one more turn as large as that reserve or as the turn just settled, would leave the handover no room now starts the compaction `/compact` would, once per checkpoint interval. One-shot `print` and `json` runs, which exit when the turn settles, leave it to Pi's trigger.
- `/compact` right after a turn that ended on a provider error, an abort or a stopped request now compacts instead of pausing the session with `CONTEXT_TOOL_BOUNDARY`, which said a turn was still running when none was. That turn stays whole after the checkpoint, and the session writer's prefix now ends at the last completed turn: ending on the turn's unanswered request led GPT-6 Luna to answer it instead of writing the note, refused as `CONTEXT_NOTE_INVALID` on every retry.
- A note whose sources include an ID naming no entry, or an entry with nothing to read, is no longer refused when every fact keeps a readable source: those sources are dropped and the note is checked again, and `/compaction-status` counts them as `scopeDropped`. On GPT-6 Luna one ID a character off a real one, beside three valid citations, refused the same note on every retry. A fact that would be left without a source, or a `supersedes` ID out of scope, still refuses with `CONTEXT_NOTE_SCOPE`.
- The resident runtime's session writer no longer adds a second system prompt to a session whose first recorded prompt sits mid-history, as in a session begun before prompts were recorded. It checked only the first message, so it put the current prompt and tools at the head as well, which duplicated the instructions and could revive tools the transcript had removed; its request-size estimate counted the prompt twice. A regression covers the mid-history case beside the existing one at the head.
- The independent preview's session writer now reads the session's prompt cache in a session begun before Pi 1.4.0. Pi 1.4.0 records the system prompt in the transcript, there mid-history, and sends no leading prompt; the writer added one at the head, so its request diverged from the session's at the first item and wrote the whole context to the cache again. On GPT-6 Luna, with 150,000 tokens of context, the writer read 0 tokens before the fix and 150,145 after it, at a quarter of the cost. Over five compactions on 200k and 272k routes the writer read 95 to 97% of its input from the cache and cost 59 to 63% less; the pause, set mostly by reasoning at `max`, did not shorten consistently. The request-size estimate and the excerpt check follow the same rule.
- `context_history` search on OpenCode, DSH and the independent preview opens each excerpt where the most query terms meet, not at the first place any one of them appears, and no longer returns the tool's own earlier results. On GPT-6 Luna a query for one line of a long log opened hundreds of lines early, and each search brought back copies of the ones before; finding four exact timestamps took 15 to 28 calls on each host, and one answer was a guess from the log's cycling timestamps. After the fix the same four took four calls on each host, all right. The ranking version is 3, so a cursor from an earlier search is refused. The preview now uses the core's search; the frozen resident runtime keeps its own copy. DSH records name each tool result after its call.
- Optional Pi preparation now starts below Pi's actual trigger, read from its effective `reserveTokens` with any per-model override first. A trigger lowered to 150k used to leave preparation waiting at 160,664, after compaction had already run. Pi's defaults keep the old band; the checkpoint format, the once-per-interval call limit and failure blocking are unchanged.

### Changed

- The preview bench measures `openai/gpt-6-luna` on OpenAI's official API with `--provider openai`, which replaces `--provider codex` and the ChatGPT subscription. `summary.json` records the provider as `openai` and the endpoint as `api.openai.com`, writer rows add `openaiResponses`, and a unit stops before its first request if the catalog serves Luna from another host. Usage and cache reads are OpenAI's own, so the cache share of these runs compares with other providers' runs. `--provider relay` stays for third-party relays.
- `docs/context-memory/openai-api.md` replaces the Codex subscription guide. It sets up the key as a network secret, verifies Pi, OpenCode 1.19.4 and DSH 0.2.1-rc.3 with one request each, and records where each host puts GPT-6 Luna's window: 272,000 tokens in Pi and DSH, the line where OpenAI's long-context price begins, and 1,050,000 in OpenCode.
- The DSH and OpenCode `context_history` descriptions now say when to use the tool: summaries drop exact values, quotes and timestamps, so search before answering that an earlier detail is unknown. In one real session that had answered four such questions unknown without a search, two new ones were searched and answered right.
- The README's Get started covers all three hosts: Pi first, then the DSH and OpenCode steps, which had sat in their own section after the Pi update and recovery notes.

### Maintenance

- With the maintainer's approval in this release cycle, the resident build fingerprint changed to `1.1.0-context-memory.0.3.0+src.c1ed81ca7698d24e` for the resident fix above, and the frozen evaluator was pinned to that source, `b5b1053`; fixture and scorer locks are unchanged. Earlier records keep their own pin. The resident release version stays v0.3.0.
- CI now builds the tree and runs both acceptance checks on Node 24 and 26 as well, for every pull request and push to main that changes more than Markdown. Node 22 still runs the full pipeline and remains the only Node a release is verified on. The newer majors run in a workflow of their own, because publication requires the whole Node 22 workflow run on main to succeed, so neither can block or approve a release. The supported range, `>=22.19.0`, the dependencies and the build fingerprints are unchanged.

## [v0.7.2] — 2026-10-26

v0.7.2 moves the repository and its install source to `youxi-huang/slice`, and a second installed copy no longer pauses the session: a copy that finds another one loaded stands aside, so only one compacts. The extension otherwise compacts as v0.7.1 did, and the checkpoint schema, the source-hash format, the resident build fingerprint and the evaluation pin are unchanged. The source tree also gains retrieval-only previews for DSH and OpenCode, built from source and not published. Results are offline, on official Pi installations with loopback services, except GitHub's redirect, which was tested against the renamed repository; real-provider behavior is not part of this release.

### Added

- Source-only retrieval previews for DSH `0.2.1-rc.3` and OpenCode 1.19.4. Each adds one `context_history` tool that searches and reads the current session's original records through the host's public storage API and the shared core, citing native event and part IDs, with bounded pages, continuation cursors and source-change checks. They keep no second history database and refuse forked or seeded sessions. Neither writes SLICE checkpoints yet: DSH's pinned persistence contract cannot carry a required external checkpoint record, and OpenCode keeps its native compactor.

### Changed

- The repository moved from `youxi-huang/pi-context-compaction` to `youxi-huang/slice`, and the install source is now `git:github.com/youxi-huang/slice`. GitHub redirects the old address, so existing installations keep loading and updating, and `pi update` and `pi remove` still name the address they were installed from. Pi counts the two addresses as two packages: moving means removing the old address and installing the new one, never installing both, since Pi then loads both copies. The release script, the package's repository and homepage, and the install commands in the README and the preview guide follow the new name. The package name, the commands, the configuration file and stored checkpoints are unchanged.
- The README now shows how to build and load the DSH and OpenCode previews. Both sets of steps were run on the official hosts.

### Fixed

- Two installed copies of the extension, from two addresses or two scopes, no longer pause the session at their next compaction. Pi loads both and runs both copies' handlers, so each wrote its own checkpoint for one attempt and the commit could not be confirmed. A copy now finds the others in Pi's command list: one compacts, the first loaded unless a copy of v0.7.1 or earlier is loaded, since that one cannot stand aside, and every other copy stands aside, says once which copy compacts and names the `pi remove` command that keeps one, preferring the `youxi-huang/slice` address. `/compaction-doctor:1` and `:2`, as Pi names the commands of two copies, list both. Two copies of v0.7.1 or earlier still conflict. On official Pi 1.4.0, 1.3.0, 1.2.0 and 1.1.0 a v0.7.2 copy installed after or before v0.7.1 leaves one writer request per compaction and a committed checkpoint; the stock-Pi acceptance gains the case with two v0.7.2 copies.

### Security

- DSH `0.2.1-rc.3` pins zod 4.4.3, affected by GHSA-mrhx-c7xc-m3w5. A root override lifts the new development dependencies to 4.6.7, so `npm audit` still reports no advisories. The OpenCode adapter imports zod 4.6.7 directly rather than the plugin package, whose V2 runtime it does not use.
- Remove the unused upstream sandbox example, whose `@anthropic-ai/sandbox-runtime` dependency held zod at 3.25.76, affected by GHSA-mrhx-c7xc-m3w5. No zod 3 release carries the fix, and even the latest sandbox runtime requires zod 3. With the example gone, every remaining dependent accepts zod 4, so the root lockfile moves zod to 4.6.7 and `npm audit` reports no advisories. zod was never in the coding-agent install lock or the independent Pi extension; before the new OpenCode adapter, it arrived only through the example, as an optional peer of the provider SDKs and as a dependency of the upstream evaluation tools.

### Maintenance

- Regressions for the v0.7.2 install-source move show, on Pi's real package and settings managers over a local repository, what happens when the old address is replaced, when both addresses are installed and when either scope is changed: configuration and sessions survive, checkpoints still validate, and a pending or failed compaction stays guarded through the reinstall. The same cases run against an official Pi on request. GitHub's redirect itself was tested after the rename, on each official host.
- CI runs its full pipeline on every push to main, including a merge that changes Markdown documents alone; only such a pull request still skips it. Publication accepts a tagged commit only after its `verify` check concluded `success`, and a skipped job concludes `skipped`, so a release tagged on a documentation-only merge would have failed at its last step, after the whole stock-Pi acceptance had run. A regression runs the workflow's scope step on a documentation-only commit for a pull request, a push and a manual run.

## [v0.7.1] — 2026-10-25

v0.7.1 is the first extension built on the v0.7.0 host-neutral core, and the first release under the SLICE name. It adds official Pi 1.4.0 as the primary host beside 1.3.0, 1.2.0 and 1.1.0 and behaves as extension-v0.6.0 did: the core lifts were byte-identical on scripted inputs, and the checkpoint schema, the source-hash format, the resident build fingerprint and the evaluation pin are unchanged. The core's import gate now also refuses module loads it cannot verify. Every result is offline, on official Pi installations with loopback services; real-provider behavior is not part of this release.

### Added

- Official Pi 1.4.0 is supported and becomes the primary host, beside 1.3.0, 1.2.0 and 1.1.0. Its extension API declarations, extension runner and session storage match 1.3.0, and it installs the same seven runtime packages, without `chord`. Stock-Pi acceptance runs on all four hosts: each older host compacts a checkpoint written on 1.4.0, and 1.4.0 reopens the result. Pi 1.4.0's summary changes, the ignored `reserveTokens` and custom instructions on a split turn, concern Pi's own summarizer, which the extension does not call. Its persistent omission of a truncated attempt's tool results arrives as context edits, which the extension already validates in full before the next request.

### Changed

- The project is now called SLICE, Source-Linked Indexed Compaction of Everything, in the documentation, the release notes and the package description, and the README is rewritten for first-time readers. Its commit diagram is redrawn for the extension's checks and disk readback, and the opening illustration no longer says that checkpoints are written only on a manual `/compact`. The repository, the install source, the package name `pi-context-compaction-preview`, the `/compaction-*` commands, the `pi-context-memory.json` configuration file and stored checkpoint identifiers keep their names, so existing installations and sessions need no change.

### Fixed

- The core's import gate checked a dynamic import only when its specifier was a literal, so `import(name)` or an interpolated template passed unchecked. Such a specifier now fails the gate with its location and expression. A regression covers both forms beside the literal ones that stay allowed.
- The core's import gate never saw a module loaded by name through `node:module`'s `createRequire`, through `process.getBuiltinModule`, which needs no import at all, or through a bare `require`. `node:module` now fails the gate, and `require(x)` and `process.getBuiltinModule(x)` are checked like `import(x)`, so a specifier that is not a literal fails closed. Nothing in the core used any of these routes. A regression plants each form beside a builtin that stays allowed.

### Security

- Update undici from 8.10.2 to 8.12.3 for GHSA-qrxm-fqhp-jwvm, GHSA-2m5v-pch6-74hx, GHSA-4w7w-5xrc-9h26, GHSA-xjj6-f33q-929c, GHSA-55wc-3pg8-jfw6, GHSA-f72v-6w45-q472, GHSA-4qv8-2p9j-2685 and GHSA-9fm3-97px-rjf6, and the development-only fast-uri, which the evaluation workspace pulls in through ajv, from 3.1.8 to 3.1.9 for GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-xhq7-xmqj-769h and GHSA-333x-w4r6-6crp. The coding agent built from this tree sends its HTTP requests through undici, so the generated coding-agent install lock moves with it. The independent extension ships neither package; on official Pi it runs with the undici that Pi installs.

### Maintenance

- The **Publish extension preview** workflow recognizes a source release. A `v*` tag whose version differs from the extension package it builds, while that package version is already published, now ends after the build with a notice and publishes nothing, instead of running stock-Pi acceptance and failing at the publish step as v0.7.0 did. A tag beside an unpublished package version still fails, before any official Pi is installed.
- The stock-Pi scenarios add `tool-loadout`. With arm B off, the provider is offered `context_history` and not `context_note` in a fresh session, after a restart and after `/tree` navigation; a branch that called `context_note` while B was on is offered it again after a restart; and a session started before the extension was installed stays usable without `context_note`. Pi 1.4.0 activates an extension tool a restored branch never recorded unless the tool registers with `defaultActive: false`, which `context_note` does while B is off, so the v0.5.3 saving of about 1,209 tokens per request holds. The case passes on official Pi 1.4.0 and 1.3.0.

## [v0.7.0] — 2026-10-22

v0.7.0 is a source release. It lands the host-neutral core and publishes no extension, so `extension-v0.6.0` stays the installable package. The preview's host-independent logic moved into `packages/compaction-core` in five lift steps, each shown byte-identical on scripted inputs, and the core gains its specification, 34 conformance vectors and two mechanical gates in `verify`. The extension's behavior, the checkpoint schema, the resident build fingerprint, the frozen fixtures and the evaluation pin are unchanged. From this release on, the resident runtime receives dependency and security maintenance only.

### Added

- The host-neutral core package `packages/compaction-core`: the specification (`spec/specification.md`, reviewed 2026-10-22) stating the record model, note and checkpoint formats, the source hash by its properties, validation and the commit gate, failure states, retrieval and call accounting, with a guarantee table binding every row to an existing check and a closed-set error class; and the 0.7 conformance vectors (`conformance/`, 34 vectors pinned as `0.7-conformance.1`) run through the real validators on the core path — 31 of them also through the fixture converter on the Pi adapter path, the three zero-record vectors staying core-only — matched by error class, never message text. An RFC 8785 (JCS) canonical serialization lands beside Pi's existing source hash for hosts other than Pi; Pi checkpoints keep `hashEntries` byte-compatibly.
- `verify` gains the core's two mechanical gates: an import gate (everything reachable from the core must be relative-in-package, `node:*`, or TypeBox, type positions included, with a planted-import regression) and an isolation check that builds and tests the core in a directory where no Pi package resolves.
- The scenario runner and loopback bench take `--equivalence-out`, writing content-free per-case records (note and summary hashes, cited IDs, error classes), compared mechanically across two package builds by `scripts/context-memory-equivalence-compare.mjs`.
- The preview fixtures gain a host-neutral record format (`0.7-host-neutral-records.1`): `eval/preview/generate.ts` emits host-neutral records and the Pi converter reproduces the pinned P1–P4 session bytes hash for hash, so the frozen offline baselines and their manifests do not move.

### Changed

- The preview's host-independent logic now lives in the core package and the extension is the core's first adapter, with no change in behavior: the reduction, validation and repairs, note and work-note formats, checkpoint shapes, views and accounting, the pure cut and guard helpers, and the writer contract moved in five lift steps, each shown byte-identical on scripted inputs by the equivalence run, with the writer's transport (model resolution, dispatch, reasoning mapping, the session-ID cache key) staying with the adapter.
- The resident runtime is frozen as of 2026-10-22 under the v0.7.0 plan's H5: no further Pi ports or features, dependency and security maintenance only, retirement by 0.10.0; recorded in the upstream delta and the preview guide.

### Security

- Update the development-only Vite dependency from 8.0.16 to 8.3.5 for GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm, GHSA-9jrq-w75r-8gcw and GHSA-rq7h-c2jc-7f22, and Vitest with `@vitest/mocker` from 4.1.11 to 4.1.12 for GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp. These updates affect the development and test toolchain; the independent extension does not ship either package, and the generated coding-agent install lock is unchanged.

### Maintenance

- The offline evaluation's scripted writer no longer cites part of the run directory's random UUID as an entry ID. About one UUID in 900 holds a run such as `bff1-12345`, which the writer's prompt carries before every fixture ID; the note then cited `f1-12345` and `verify` failed with `CONTEXT_NOTE_SCOPE`. A regression covers the case.

## [v0.6.0] — 2026-10-22

v0.6.0 is the footprint milestone's offline delivery, in the independent preview only. Three opt-in mechanisms ship behind their own switches, every one off by default: deterministic reversible reductions (`previewReduction`) replace consumed and superseded tool results in the request's projection with one line each while the session file stays untouched; labelled historical excerpts (`previewExcerpts`) answer an identifier the prompt names from compacted entries without touching the cached prefix; and derived summary renderings (`previewRendering`) fold repeated lineage and old failed paths while the stored checkpoint bytes never change. The bench gains a token-overhead report with required cache-write and page-back columns, candidate wiring and the P4 fixture. On the offline loopback the reduction cut the writer's input 46.8 percent with zero of 216 probe outcomes changed, and the lineage fold cut the rendered summary 36.7 percent at 40 checkpoints; real-provider savings, recovery and cache behavior are unmeasured, each provider bench is a separately budgeted step, and the writer instruction and sources repair inherited from v0.5.3 still await their qualifying bench. The resident runtime, its build fingerprint, the checkpoint schema, the frozen fixtures and the evaluation pin are unchanged.

### Added

- When the independent preview's note writer leaves at most five facts without sources, and that is the candidate's only fault against the note schema, the writer gets one repair request that names those facts beside the entries they may cite: the active requests and other user messages in full, excerpts of the entries the rest of the note cites, and the uncovered entries by their opening words. The answer may add sources only; each fact's text, quote and supersedes stay as written, and the whole note is checked again, so an invented ID or a quote the cited entries do not contain still blocks. The extension never supplies an ID itself. This is the compaction's one repair under `noteRepair`, shared with the quotation and size repairs, and like them it runs without reasoning.
- `/compaction-status` reports the first candidate refused on the note schema under `lastWriter.schema`: facts without sources by section, and whether the note fails the schema for another reason too. A repair that ran reports `repairKind: "sources"`. Both are counts; no fact text or ID is reported.
- Behind a new `previewReduction` switch, off by default, the independent preview's request projection replaces two kinds of tool results with one line each — an earlier read of a file that was read again later, and a consumed result after which a later turn completed — naming the tool, its target, the first line of its result and the record ID, which `context_history` reads back in full. The reduction is a pure function of the session records, recomputed on every request and never stored: the session file is untouched, the same records always produce the same bytes, appending turns never un-reduces an entry, and the writer's prefix and the main model's context reduce identically, so both share one cached prefix. User messages, assistant text, checkpoint summaries, error results and the sole evidence cited by a committed fact are never reduced; tool calls stay paired; a checkpoint written over a reduced view is byte-identical to one written without it; a failed compaction blocks exactly as before. An invalid switch value disables the feature without touching requests. `/compaction-status` reports content-free counts under `reduction`.
- Behind a new `previewExcerpts` switch, off by default, when the user's prompt names an identifier-shaped term that only compacted or reduced entries hold, the request ending with that prompt gains one short original excerpt at its end, labelled as historical evidence with its record ID and role, never as an instruction. At most two excerpts of at most 200 estimated tokens each are appended within the request limit, a deterministic secret filter withholds a matching record entirely and names only its ID, nothing enters the session file, and every earlier message is reused unchanged, so the provider's cached prefix is untouched. `/compaction-status` reports counts under `excerpts`, including excerpts appended and excerpts no answer cited.
- `context_history` results state `readTokens`, the estimated cost of reading each hit in full, and mark hits whose entries are already in context (a reduced entry is unmarked, since only its one line is). `read` accepts `detail: "low"` for a bounded opening with the full cost stated; `full` remains the default and returns what it did before.
- Behind a new `previewRendering` switch, off by default, the summary the model sees is derived from the stored note and lineage by a pure function while the stored checkpoint rendering stays byte for byte; the recovery guards accept and require that same derivation, so a tampered rendering is still refused, and with the switch off behavior is byte-identical to before. Three candidates are selectable one at a time for measurement: failed paths and reasons whose sources precede the previous checkpoint fold to one line with their source IDs; repeated lineage state lines fold with guidance rendered once and every anchor kept; and each fact can show the roles of the records it cites, computed from the records, never claimed by the note. An invalid switch value disables the feature without touching requests. `/compaction-status` reports the active candidates under `rendering`.

### Changed

- The independent preview's writer instruction says that every fact in every section, next steps included, cites the entries that support it, whether or not it carries a quote, and that a next step cites the request or recorded progress it continues without claiming the step is done. The in-task handover asks the same of its continuation step. In the v0.5.3 relay bench, each refused GPT-6 Luna note examined held next steps with text alone. The resident runtime, its build fingerprint, the checkpoint schema and the evaluation pin are unchanged.

### Fixed

- `/compaction-status` reported `sent.effort: medium` for every GPT-6 Luna writer request. Since Pi 1.3.0, models that change effort mid-conversation receive a fixed `reasoning.effort` of `medium` and the requested level in a `configuration_update` input item. `sent.effort` now reports that item's level, and `sent.fixedEffort` the fixed one.

### Maintenance

- The preview bench records each attempt's schema counts and sums them per cut and overall under `schemaRefusals`, and counts sources repairs beside quotation and size repairs. The stock-Pi scenarios add `sources-repair-refused` and `sources-repair-commits`.
- The preview bench's relay can measure another catalog model under the ID the relay serves it as, with `--relay-model` and `--relay-id`, for example `deepseek/deepseek-flash` served as a self-hosted `dsv41f-xp`. The catalog's API, compatibility settings, level map and prices stay, so the limits use its prices; without the flags the relay measures `openai/gpt-6-luna` as before.
- CI skips its full pipeline for a change that touches nothing but Markdown under `docs/` or the repository root. `CHANGELOG.md` and `docs/context-memory/extension-preview.md` still run everything, because release preparation reads the first and the package README is built from the second, and the publication workflow re-verifies every release on its tag as before.
- `context-memory-ops.mjs` exits 3 instead of 1 at the fingerprint gate, so a caller can tell a held fingerprint from a failed check, and the operations runbook maps each change type to its narrowest command.
- The preview bench reports token overhead per run, cut and source-size tier in `summary.json`: writer tokens and note size against the records they replace, retrieval usage by operation, usage from refused, crashed, declined and discarded work read from the call journal, calls with missing usage reports counted under `usageMissing` rather than deflating totals, provider cache writes as a required column that reads "not reported" when no call reported any, and one net column that charges page-back reads against the saving. `--session-settings` and `--control` label a candidate run and its control; the loopback provider reports deterministic usage so every column has offline figures.
- The preview evaluation set gains the P4 fixture under its own fixtures version and manifest: sessions with repeated file reads and long consumed tool results between checkpoints, with gold answers inside entries a reduction would replace. P1 to P3, the frozen F-series and the evaluation pin are byte-identical.
- The bench's `--session-settings` now writes the named preview switches into every unit's `pi-context-memory.json` and records them under `unitSettings` beside the label; an unknown name or value stops the run before any unit starts, and without the flag units keep the package's defaults as before. Compaction and probe rows carry `/compaction-status`'s content-free `reduction` and `excerpts` counts, and probe excerpt tokens are charged as page-back in the overhead report.

## [v0.5.3] — 2026-10-21

v0.5.3 adapts the independent extension's note writer to GPT-6 Luna. The session writer sends the session's ID with its request, so Pi's Codex provider can serve it from the session's prompt cache. Writers are asked for the note itself, and the two schema envelopes Luna returned around complete notes are removed before every commit check runs. A fresh session without arm B no longer offers `context_note`, saving about 1,209 Pi-estimated tokens per request. In a writer bench beside the v0.5.2 release build on the same day, DeepSeek V4.1 Flash committed 64 of 64 notes against 62 of 64; GPT-6 Luna at `max`, through a third-party relay, committed 47 of 64 against 37 of 64 before, and the notes it still loses carry next steps without sources. The changes are in the independent preview only: the resident runtime, its build fingerprint, the checkpoint schema and the evaluation pin are unchanged.

### Changed

- The independent preview's session writer sends the session's ID with its request, as Pi does with each of the session's requests. Pi's Codex provider keys its prompt cache on that ID: without it, GPT-6 Luna's writer read 7.1% of its input from cache, against 93.6% on DeepSeek. Providers that need no key ignore it.
- The independent preview asks its note writers for the note itself rather than for an object matching the note's JSON Schema. Before validation it removes the two schema envelopes GPT-6 Luna returned around complete notes: a string `type` beside exactly the seven sections, and `type`, `properties` and `required` with exactly the seven sections under `properties`. Nothing else is rewritten, every commit check still applies, and `/compaction-status` names a removed envelope under `envelope` in `writerCallDetails`. Answers that are not JSON are refused as before.
- With arm B off, a fresh independent-preview session no longer offers `context_note`, saving about 1,209 Pi-estimated tokens per request. A branch with an earlier call, saved or refused, activates it on reopen or branch navigation; explicit activations and saved notes remain usable.

### Maintenance

- The preview bench measures `openai/gpt-6-luna` through an OpenAI-compatible relay with `--provider relay --base-url`, keeping Pi's catalog settings and the Responses API, so the session writer's cache key reaches the relay. A relay's own usage counts make its cache share and cost incomparable with other runs; refusals, notes and probe scores compare. Writer rows record each relay response's shape as they do for Codex, and both now name the keys and kinds of each section's items, which is how the relay run traced its refused notes to next steps without sources.
- The preview bench stops a unit still running after `--unit-minutes`, 10 by default, so one request that never returns cannot hold a run; the unit settles as crashed and a probe it held is scored as blocked. Writer rows and the summary also count the schema envelopes removed from notes.
- The preview bench measures `openai-codex/gpt-6-luna` on the ChatGPT subscription with `--provider codex`, in writer, probes and smoke modes, under the same request, time and cost limits. In writer mode it records the shape of every Codex response, never its text, which is how the first run traced its refused notes. In Claude Code cloud sessions the access token stays in the environment's network proxy and Pi holds an unsigned placeholder; `docs/context-memory/codex-subscription.md` covers the setup and the renewal every ten days or so.

## [v0.5.2] — 2026-10-18

v0.5.2 makes the independent extension quiet when it works and specific when it has to stop. Pi's footer now shows whether compaction is on, how many checkpoints the branch holds, when a note is being written and when requests are paused. Notices say what happened before why and end with the code, and a blocked session gets a one-line reminder instead of the whole notice on every input. Text typed while requests are paused goes back to the editor instead of into a request Pi then aborts. A session that reopens with a checkpoint shows its ready or off notice at the first input, where Pi's own status line used to overwrite it. Around a compaction the extension spends 44% less of its own time, with every check in place. The changes are in the independent preview only: the resident runtime, its build fingerprint, the checkpoint schema and the evaluation pin are unchanged. Each change was walked through in an 80-column terminal on official Pi 1.3.0, 1.2.0 and 1.1.0 with synthetic responses; no real-provider run is part of this release. The source tree also drops an unused upstream example that pulled in a vulnerable `node-forge`.

### Added

- The independent preview shows its state on Pi's footer line: on, the number of checkpoints on the current branch, writing a note, or paused with a pointer to `/compaction-doctor`. Before, a paused session showed only when an input was refused.

### Changed

- `/compaction-doctor` ends with `Result: ready for requests` instead of `Result: ready`, so it no longer reads as a promise that `/compact` will run, and its note on Pi's history threshold is shorter.
- While the independent preview is paused, text typed in Pi's interactive editor goes back to the editor, and the notice says why. No request starts, nothing is recorded in the session, and Pi no longer adds `This operation was aborted`. Commands still run, and the request guard still stops every other paused request.
- The independent preview's notices begin with `Source-linked compaction`, say what happened before why, and put the code last. A blocked session no longer repeats the whole notice on every input: later inputs blocked by the same code get one short line until a checkpoint or recovery is confirmed. `/compaction-doctor` reports a `requests` line instead of `durable block`, and every code a preview session can raise or restore has its own advice.
- The independent preview spends less of its own time around a compaction and when a long session reopens: at 40 checkpoints in a synthetic session, 311 ms instead of 558 ms around the writer and 75 ms instead of 118 ms added to a reopen. Within one synchronous step it now serializes, hashes and reads the session file once where it did so several times. Every source comparison runs at the same moments, and checkpoint hashes are byte-identical.

### Fixed

- When a session with a checkpoint reopens in Pi's interactive mode, the independent preview's ready or off notice now appears with the first input. Before, Pi's `Session compacted` status overwrote it.

### Security

- Remove the unused upstream Gondolin micro-VM example and its workspace dependency chain, which included `node-forge` affected by GHSA-86w9-cpqp-85rv. Remove its standalone lockfile and the obsolete audit exception, and update the example index and isolation guide. The documented agent maintenance commands, resident compaction runtime and independent extension do not use this example.

## [v0.5.1] — 2026-10-18

v0.5.1 makes the independent extension's quotation repair cheaper and its failures easier to diagnose. The repair now runs without reasoning, whatever the writer's effort: in v0.5.0 one repair at `high` spent its output on reasoning and returned nothing usable. `/compaction-status` names what each writer call asked for, what its request carried and how it ended, and counts the citations behind a scope refusal. A repair can no longer withdraw a ruling a user stated, and `context_history`'s list no longer marks a still-valid fact as superseded. The changes are in the independent preview only: the resident runtime, its build fingerprint, the checkpoint schema and the evaluation pin are unchanged. Two bounded runs with DeepSeek V4.1 Flash on Pi 1.3.0 are in the validation record: over 38 planted repair cases, two attempts each, the repair passed 76 of 76 without reasoning against 75 of 76 at `high`, and in writer benches beside a same-day run of the v0.5.0 release build the candidate committed 121 of 128 notes against 62 of 64. They cover one model and synthetic tasks, not a general failure rate.

### Added

- `/compaction-status` reports for each writer call the reasoning effort it asked for, the reasoning settings and output cap its provider request carried, read from the request Pi built without its content, and how the response ended; a quotation repair's withdrawn facts are also counted by section. In v0.5.0 a repair that spent its output on reasoning could not be told apart from other failed calls. On official Pi 1.1.0 to 1.3.0, a DeepSeek Flash session at thinking level `medium` already runs at `high`, because the model declares no `medium`, so its writer sends `reasoning_effort: "high"`.
- For a note refused with `CONTEXT_NOTE_SCOPE`, `/compaction-status` counts the cited IDs that name no entry on the branch and those of entries with no readable text, by entry kind, without naming them. The two call for different fixes, and the refused note itself is not stored. Four such refusals in one DeepSeek writer bench left their cause unknown.

### Changed

- The quotation repair runs without reasoning, whatever the writer's effort. In v0.5.0 one repair at `high` spent 10,720 of its 11,962 output tokens reasoning and returned nothing usable. On DeepSeek V4.1 Flash over the 38 planted repair cases, two attempts each, the repair passed 76 of 76 without reasoning against 75 of 76 at `high` and at `low`, at a median of 65 output tokens and 1.4 s against 277 and 2.4 s at `high`, and none of the three levels lost a user's ruling. The size repair keeps the writer's effort; it was not measured.
- The quotation and size repairs set no tool choice, as the session writer does. Their requests offer no tools, so the model sees the same request; they no longer send `tool_choice: "none"` without any tool to choose.

### Fixed

- `context_history`'s list no longer marks a still-valid fact as superseded because a revision names the entry it shares with a revised fact. A note's `supersedes` names entries, not facts: a constraint stated in the same message as a timeout that was later raised was listed as replaced by the new timeout. A revision now marks only the facts of its own section on that entry, and only when they are no more than the revisions naming it; other facts on a revised entry carry `sourceRevisedBy`, and the tool description says what it means.
- A quotation repair can no longer withdraw an instruction whose quoted text a user message contains. Such a repair committed a note without the rule; it now refuses the note with `CONTEXT_NOTE_REPAIR_LOSS`, and re-citing the rule or dropping its quote remains possible. Withdrawing a fact no user message supports is unchanged.

### Maintenance

- The preview writer bench has a `repair` mode over 38 deterministic quotation-repair cases planted in the P fixtures: misattributed, misspaced, echoed and paraphrased rulings, and an order only a tool wrote. Only the repair reaches the measured model, and scoring counts lost rulings and instructions quoted from assistant or tool text without a judge. `--provider deepseek-local` builds the requests from Pi's DeepSeek catalog model and answers them locally.

## [v0.5.0] — 2026-10-17

v0.5.0 makes the independent extension's notes harder to lose and its history quicker to search. The session writer sees every uncovered user message in full beside its entry ID, a note that fails only on its quotations gets one targeted repair, and `context_history` lists constraints, decisions, failed approaches, files, edits and errors directly. The writer also reuses the session's prompt cache, which cut its cost by about 70% on DeepSeek. The changes are in the independent preview only: the resident runtime, its build fingerprint, the checkpoint schema and the evaluation pin are unchanged, and a v0.5.0 checkpoint reopens under v0.4.3. Two bounded runs with DeepSeek V4.1 Flash on Pi 1.3.0 are in the validation record: on the two synthetic sessions both writers ran, v0.5.0 builds committed 37 to 40 of 40 notes against 32 for the v0.4.3 writer, and on the session built for retrieval every probe passed with fewer calls than the baseline. They cover one model and synthetic tasks, not a general failure rate.

### Added

- One quotation repair. When a candidate note fails only because quotations do not match the entries they cite, for at most five facts, the writer gets one request about those facts alone: the entries they cite and the entries that do contain the quoted text, with their roles. A replacement may change only its sources and quote, or withdraw the fact; the rest of the note is kept as written and the whole note is checked again. `noteRepair` governs this repair and the size repair, and a compaction spends at most one of them. A second failure blocks as before, and the extension never moves a quotation to another entry on its own.
- `context_history` lists one kind of item with `operation: "list"`: the constraints, decisions, failed approaches, files, plans and state that committed checkpoints recorded, plus edits and errors read from tool records, newest first, with superseded items marked and their original entries named. The list is computed on every call and stores nothing; search and read are unchanged.
- `/compaction-status` reports under `lastWriter` the first refused candidate's quotation failures by class, the kind of repair that ran, what a quotation repair changed, how many writer responses called a tool and whether one was declined.

### Changed

- The session writer's handover request lists every uncovered user message in full beside its entry ID, and says that the manifest's openings are not to be copied as quotations. Both recorded live runs lost a checkpoint to a quotation cited to the wrong entry. The list is marked as serving quotation only: on DeepSeek, without that line, the writer read it as the whole task and recorded the assistant's announced next step as unrequested.
- The session writer sets no tool choice, as the session's own requests do, so a provider that caches prompt prefixes serves its request from the session's cache. With `tool_choice: "none"`, DeepSeek left the tool definitions out of the prompt and every compaction paid for the whole history; in a check, 91 to 99.6% of the writer's input now came from cache and each call cost about a third. The request tells the model to call no tool. A tool call is never run: the first is answered as unavailable and the request continues once on the same cached prefix, without spending the size or quotation repair, so a compaction makes at most three writer calls; a second tool call refuses the note, and `noteRepair` governs the continuation too.
- A refused quotation's message counts the failures by class: text found in other entries, text that differs only in spacing or punctuation, and text found nowhere. A refused `context_note` names each failing field and the entries that contain its quoted text.

### Maintenance

- `eval/preview` adds an evaluation set for the preview, separate from the frozen fixtures: three invented sessions with revisions, withdrawn work, forbidden retries, quotation traps and, in P3, answers no note can hold, with 75 typed probes and their scorer. Scorer version 2 passes an answer that leads with the right value in prose and counts it; `rescore.ts` applies it to saved replies. `scripts/context-memory-preview-bench.mjs` runs a writer bench and the probes on official Pi, offline by default.
- The stock-Pi scenarios check quotation repair and the typed list end to end.
- The bench reaches a provider through Pi's proxy-aware dispatcher, retries a refused probe cut up to four attempts, and reports each committed note's size against the history it condenses and the gold answers it cites. By default it reproduces a session's prompt cache, warming the prefix before each cut's compactions as a session's turns do; `--cache cold` measures a cold prefix. Two bounded DeepSeek runs of the baseline and the candidate are in the validation record.

## [v0.4.3] — 2026-10-16

v0.4.3 adds official Pi 1.3.0 to the independent extension as its primary host, while retaining Pi 1.2.0, Pi 1.1.0 and existing checkpoints. `/compaction-doctor` now tells a failure that a new `/compact` can clear from one it cannot, and publication reads its host list from the candidate itself. Both optional preparation paths remain disabled by default. One bounded real-provider run on Pi 1.3.0 with DeepSeek V4.1 Flash is in the validation record: two checkpoints, the first after one refused note, and both continuation checks passed. It covers one task and is not a quality or cost comparison.

### Added

- The independent preview supports official Pi 1.3.0 alongside 1.2.0 and 1.1.0, with 1.3.0 as the primary host in `supportedHost`. The extension API declarations Pi 1.3.0 exposes to extensions are unchanged from 1.2.0; stock-Pi acceptance runs on all three hosts, and a checkpoint written on 1.3.0 is compacted on each older host and reopened on 1.3.0. On an unlisted Pi version a protected session still stays blocked, which the preview guide now explains before an update.

### Fixed

- `/compaction-doctor` no longer reports manual `/compact` as blocked when a new `/compact` is the way out. After a retryable failure it reports `retry`, names `/compaction-recover` first when Pi already saved the staged checkpoint, and keeps `blocked` for what `/compact` cannot clear in the session: an unsupported host or content, an unreadable configuration or an unavailable writer. With an unavailable writer the result line no longer suggests running `/compact` later. `/compaction-status` adds `manualCompaction.recover`, and `manualCompaction.preview` can read `retry`.
- `/compaction-status` keeps `lastWriter` and `lastCompaction` per session, like every other state in the controller. Pi's CLI starts a new extension instance for each session, so only an SDK host that reuses one loaded extension across sessions could see another session's metrics.
- The configuration guide described the preview as compacting only on request, and the roadmap still named v0.4.0 as the current preview.

### Maintenance

- Publication, CI and `context-memory-ops.mjs preview` read the supported hosts from the candidate's own `preview-build.json` through `context-memory-preview-release-checks.mjs --plan`, and run acceptance on every host with cross-version checkpoints for each older one. The publication workflow previously selected the compatible host, the scenario suite and the acceptance floor by comparing the version with `0.4.2`; a new version would have published without the strict scenario suite and with a floor of 26 checks unless every literal was updated. Every release after v0.4.0-preview.1 now requires strict scenarios without a list entry, the floor grows by two checks per older host, and a retried historical tag keeps the host contract recorded in its own metadata. The official installer adds Pi 1.3.0 and installs `chord` only for 1.1.0 and 1.0.4, which still depend on it.
- Tighten the agent instructions shared by Claude Code and Codex. `AGENTS.md` sends builds through the operations script, now states the publication triggers and the two maintainer gates, keeps one copy of each repository-wide rule, and says when to open the documents agents most often need. Two superseded design records move to `docs/context-memory/archive/`.

## [v0.4.2] — 2026-10-15

v0.4.2 adds official Pi 1.2.0 support to the independent extension while retaining Pi 1.1.0 and existing checkpoints. It removes unused installer-report hashes while preserving source integrity, dependency verification and release evidence. Both optional preparation paths remain disabled by default. The compatibility evidence uses isolated official hosts and synthetic providers; a requested GPT Luna probe was blocked by the environment's network proxy before any model response.

### Added

- Independent preview v0.4.2 supports official Pi 1.2.0 alongside 1.1.0. The same checkpoint schema reopens across both hosts; other versions remain outside the verified scope. Status retains `supportedHost` as the primary host and adds `supportedHosts` for the complete list. The resident source build remains based on Pi 1.1.0.

### Fixed

- Describe completed-turn threshold compaction in the preview's startup notice, and distinguish explicit context-overflow recovery from ordinary automatic compaction.
- Identify synthetic acceptance writer requests by their final handover instruction. After repeated checkpoints, ordinary requests can contain the note-schema field names in summaries and tool definitions; the earlier detector answered those requests with a writer note instead of exercising history retrieval.

- Stop the resident runtime's payload guard from blocking before its own threshold compaction. It counted the serialized request at UTF-8 bytes / 3 against `window − max(16,384, maxTokens)`, so in a 128,000-token window English text was stopped near 84,000 estimated tokens, before the 102,400 threshold could compact. The guard now uses Pi's estimate of four characters per token and stops only a payload beyond the window, since it also counts JSON escaping and tool definitions. The `context` guard measures the system prompt the same way and keeps its input allowance. This matches the independent preview since v0.4.0.
- Stop re-inserting `context_note` candidates at the head of every request in the resident runtime. They arrived as a user-role message with headings such as `## instructions`, although the model had written them, and each new note invalidated the provider's prompt cache for the whole context. The candidates already appear in context as the model's own tool calls and still reach the writer at compaction. The independent preview stopped this in v0.4.0.

### Maintenance

- Use seven exactly pinned official runtime packages for Pi 1.2.0 and retain `chord` for older hosts. Reusing an older isolated installation removes the obsolete direct dependency. CI and publication require the same v0.4.2 package on both supported hosts, cross-version checkpoint readback, and the full strict Pi 1.2.0 scenario suite.
- Remove unused SHA-256 values for official package manifests, the isolated installation manifest and its lockfile from installer reports. They were computed without an expected value or acceptance decision. Keep npm integrity and registry-origin checks, exact-version and nested-copy checks, network-blocked SDK startup, plugin/package fingerprints, host mutation checks and checkpoint source hashes: these protect different boundaries.

- With the maintainer's earlier approval, the resident build fingerprint changed to `1.1.0-context-memory.0.3.0+src.7b6b865a3072b3e0` for the two resident fixes above and the frozen evaluator was pinned to that source; fixture and scorer locks are unchanged. Those fixes leave the independent preview unchanged. The Pi 1.2.0 compatibility update preserves this resident fingerprint and evaluation pin; the resident release version stays v0.3.0.
- Add a handoff protocol shared by Claude Code and Codex for continuing work across sessions, local or cloud. A handoff is a `HANDOFF.md` on the work branch that references existing records instead of copying them, marks each state claim as verified, inferred or not run, and is deleted before merge. The next session checks it against the branch before acting and records what it missed, repeated or found wrong, which feeds changes to the protocol. The October 13 cloud handoff, which still described PR #40 as open, moves to the documentation archive. Runtime behavior, build fingerprints and evaluation contracts are unchanged.

## [v0.4.1] — 2026-10-14

v0.4.1 fixes three defects in how checkpoints carry notes, found in an independent review of v0.4.0 and while confirming it. A writer note can no longer open a Markdown heading of its own in a checkpoint, in the preview or the resident runtime. Arm B now closes open questions that a later note resolves, and leaves an ambiguous correction to the writer instead of dropping facts it did not replace. Checkpoints written by v0.4.0 reopen unchanged. Both arms stay off by default, and real-provider latency, cost and recovery benefits remain unproven.

### Security

- Keep every fact and open question in a checkpoint on one line. The writer's note schema allowed line breaks and the summary renders facts into Markdown as they stand, so a writer note, or tool output it copied, could open a heading of its own such as a second `## instructions`. This gave the writer nothing it could not already write in the real `instructions` section, but the section boundary depended on the model. The preview now folds line breaks into spaces in every writer note, a prepared candidate's included, and in the earlier facts a notes checkpoint carries forward. Exact quotes were already rendered as JSON strings. Rendering and stored-checkpoint validation are unchanged, so checkpoints written by v0.4.0 reopen as before. The resident runtime folds its writer notes the same way; with the maintainer's approval its build fingerprint changes to `1.1.0-context-memory.0.3.0+src.038d16089b2ce840` and the frozen evaluator is pinned to that source, while its release version stays v0.3.0. Found by an independent review of v0.4.0.

### Fixed

- Let arm B close open questions. Gaps from the previous checkpoint and earlier notes were only ever added to, so a resolved blocker such as a pending approval stayed under `Unresolved` until the writer next rewrote the note. A work note that lists `gaps` now replaces the earlier list, an empty list closes it, and a note without `gaps` keeps it; the `context_note` schema says so.
- Stop arm B from dropping facts a correction did not replace. `supersedes` names source entries, so correcting one fact dropped every earlier fact citing the same entry, such as other details from the same user message or tool output, with no writer call. When a superseded entry supports more earlier facts than the note gives in their place, the writer now merges, recorded as `notesFallback: "merge"`.

### Maintenance

- Document arm B's two remaining limits in the preview guide: a correction recorded without `supersedes` keeps the earlier fact beside the newer one, and accumulated facts reach the note schema's bounds and fall back to the writer more often on long tasks.
- Publish v0.4.1 through the same gates as v0.4.0: the full default-settings scenario suite with strict acceptance, no performance exception or known gap, bound to the exact package and source commit.
- Update `actions/setup-node` from 7.0.0 to 7.1.0 in the CI and publication workflows, still pinned by commit SHA.

## [v0.4.0] — 2026-10-13

v0.4.0 delivers completed-turn threshold compaction and two optional preparation paths in the independent extension preview for official Pi 1.1.0. A prepares with the configured writer; B merges data-only work notes and carries covered user messages in full or falls back to the writer. Both are off by default. This remains an experimental pre-release: strict synthetic acceptance is required, while real-provider latency, cost and recovery benefits remain unproven. The earlier v0.4.0-preview.1 candidate was never published.

### Added

- Handle Pi's threshold compaction after a completed turn in the independent preview, through the same path and gates as `/compact`. Until now crossing the threshold blocked the session until a manual `/compact`. While input is queued or a session is blocked, threshold compaction is left for a later turn and nothing is recorded; it never acts as an explicit retry. Overflow recovery still needs `/compact`.
- Record every preview writer call, preparation and compaction alike, in one content-free journal under `context-memory-preview/calls/`. The start of a call is fsynced before the request is sent and its settlement follows, so an interrupted call stays visible as unsettled. `/compaction-status` reports the summary as `calls`. Foreground calls with preparation disabled were previously observed only in memory.
- Commit a prepared candidate in the independent preview for the prefix it covers when turns were added after it, without a writer call. Every later original stays in context verbatim after the checkpoint, so a newer user message keeps its own words and position. The store accepts such a checkpoint only if its source hash matches the covered prefix and the cut drops no uncovered entry; the path is used only when the context shrinks and fits within 80% of the threshold, and otherwise the same writer compacts synchronously from the originals.
- Add arm B to the independent preview behind `previewWorkNotes.enabled` in `pi-context-memory.json`, off by default. At compaction the extension merges the previous checkpoint's note with the session model's work notes since, without a model call, and commits the result through the prefix path, so everything after the last note stays verbatim. The user's own messages up to that point follow the note as JSON lines the extension renders from the originals; no model restates them, and every full validation renders them again, so an edited message blocks the session like an edited quote. Earlier instructions are carried unchanged. No user message is shortened: the writer compacts synchronously, with the notes as hints, when those messages do not fit in full within their bound, as with a long pasted log, a note supersedes the source of a carried instruction, the merge exceeds the note schema or the prefix conditions fail; it also reads the user messages a notes checkpoint carried. With the switch on, a one-line tool guideline asks for a note after a decision, a failed approach or a completed subtask. A notes commit must leave the context below half of the compaction threshold; the turn of the last note stays verbatim, and a commit that would keep more goes to the writer. When B leaves a compaction to the writer, `details.preparation.notesFallback` records why.

### Changed

- Reduce optional preparation to one run and one armed candidate. It starts at most once per checkpoint interval, when the context enters the band just below Pi's default threshold, instead of after the first 2,048 new tokens. Compaction commits the candidate complete or for its prefix, or writes synchronously; the merge path, the two preparation ledgers with their reservations and policy hashes, and the earlier preparation keys are removed. Ledger files from the earlier experiment are left in place and no longer read.
- Validate sources and read the session back in full at trust boundaries instead of on every request in the independent preview. Session start, branch changes, new checkpoints, compaction, recovery and failures still run the complete checks. Requests in between check only entries added since and compare the session file's identity and length with Pi's appends, so a failed or foreign append, truncation or replacement is still found at once. Same-length rewrites and in-place edits of loaded entries are found at the next boundary. The whole-branch plain-data proof, canonical-line reuse and the request-component diagnostic that profiled them are removed. In the synthetic long-session scenario, extra median overhead per request falls from 46/84 ms to 1–4 ms at 10/20 checkpoints, and the 50 ms check becomes a required regression; the first request after each checkpoint still pays one full check.

- Make `context_note` in the independent preview take data only: `state`, with optional `reasons`, `failedPaths`, `files`, `nextSteps` and `gaps`, each fact on one line with its sources and an optional exact quote. A note with `instructions`, or with a fact that breaks across lines, is rejected, so model-written text cannot open a heading of its own in a checkpoint. Notes in the earlier shape are no longer passed to the writer.

### Fixed

- Stop the preview's request guards from blocking before Pi's own threshold compaction. The final payload guard counted UTF-8 bytes / 3 against `window − max(16,384, maxTokens)`, so for English text near 4 bytes per token it fired at about 75% of that limit: around 84k real tokens in a 128k window, before Pi's threshold at 111.6k and before preparation's band, and durably in a protected session. Both guards now use Pi's own estimate of four characters per token. The context guard stops requests above Pi's threshold, `window − 16,384`, whatever the model's output maximum; the payload guard, which also counts JSON escaping and tool schemas, stops only a payload beyond the window. The resident runtime keeps its budget until a fingerprint change is approved.
- Record a preview writer call whose provider sends no usage as unknown usage in the call journal. A successful response without a usage event kept Pi's initial zero usage and was journaled as a complete, free call; only interrupted calls were treated as unknown. Found by the new official-Pi case for arm A.
- Keep the preview's cut after the previous checkpoint. With `keepRecentTokens` above zero, a manual compaction soon after another could keep the earlier checkpoint in the retained range, where stock Pi shows it as a second summary and later requests were blocked. The default `keepRecentTokens` of zero was not affected.
- Stop re-inserting `context_note` candidates at the head of every request in the independent preview. They arrived as a user-role message headed "Instructions", although the model had written them, and each new note invalidated the provider's prompt cache for the whole context. The notes already appear in context as the model's own tool calls; they still reach the writer as candidates at compaction. The resident runtime has the same injection and keeps it until a fingerprint change is approved.

### Maintenance

- Add two official Pi 1.1.0 scenario cases for the opt-in arms. The work-notes case drives real `context_note` calls through the stock SDK: forged notes refused, a note saved between its tool call and result, a later correction, a commit with no writer request confirmed on disk, a restart, an edited user message, explicit recovery and a same-ID source edit. The prepared-candidate case covers a branch switch, a call with no reported usage, a preparation cancelled by `/compact` and the call record across a restart.
- Add `scripts/context-memory-preview-ab.mjs`, a bounded synthetic A/B runner. It runs sync, A and B on official Pi with the same scripted conversation, settings and loopback provider, and reports foreground pause, turn time, foreground writer calls, retained context, main and writer tokens with synthetic cost from the session and the call journal, discarded preparation, unknown usage and recovery probes after a restart. It contacts no model service; its prices, latency and probes measure mechanics, not provider quality or cost. Two probes look for restatement errors: changed exact numbers, and an overturned rule stated as current. With `--bridge <dir>` the writer's requests and B's note decisions are written to files and answered from outside, so a real model can stand in without a provider key. `--logs user` pastes the long logs as user messages and `--logs model` has the model show them, and the report gives B's fallback rate with its reasons.
- Note in `AGENTS.md` that the repository must not gain a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`. Claude Code reads `AGENTS.md` only when none of these files exists, so adding one would silently drop the shared agent instructions from Claude Code sessions while Codex kept following them.
- Add a light and dark introductory README illustration showing how a source-linked handover leads back to original session entries. The illustration follows the documented port example and is not a screenshot or benchmark comparison.
- Remove the S2 latency runner, which measured the removed preparation design; the current A/B runner measures the replacement paths.
- Remove the unused instruction-authority prototypes: the ownership bridge, refusal guards, bootstrap and guard drivers, and their tests. None was bundled, enabled or published. The authority design moves to `docs/context-memory/archive/`; B keeps notes as data and carries user messages verbatim instead.

- Install isolated official Pi baselines with all eight runtime components pinned to the reviewed version, verify registry integrity and start the SDK with networking blocked. Pinning only the coding-agent package allowed its caret dependencies to select a different Pi cohort; operations, CI and package acceptance now share the checked installer.
- Carry forward the authorized shared ordered prefix-hash scan and its equivalence regressions from the earlier candidate. Its source identity and separately maintained frozen evaluator pin remain distinct from preview package validation; fixture/scorer inputs and historical reports are unchanged.
- Publish v0.4.0 through immutable source and package tags with extension/source archives, SHA256 checksums, provenance and content-free exact-package scenario evidence. Final-main verification and CodeQL remain mandatory. CI and publication use the full strict scenario profile for v0.4.0, including both overhead checks, without the earlier candidate's performance exceptions or known gaps. Update installation and release documentation to the delivered A/B and threshold-compaction behavior.

## [v0.3.3] — 2026-10-12

v0.3.3 leaves sessions the independent preview never protected to Pi, reports each failure once with a next step, and adds a read-only first-use check. The maintainer selected a patch release for these corrections and the diagnostic additions that accompany them. The resident runtime, its fingerprint, the checkpoint schema and the evaluation pin are unchanged; the preview build ID changes with its sources.

### Fixed

- Installing the preview no longer blocks sessions it has never protected and cannot check: sessions on a Pi version other than 1.1.0, in-memory sessions, sessions with a native or other compactor's checkpoint, and sessions containing images, non-text extension messages or unsupported context edits. For these the preview writes no failure marker and stops no request; Pi's own manual and automatic compaction and cache warming apply, and one notice per session explains why. A session is protected once the preview has written a checkpoint for it or recorded a pending or failed attempt, and protected sessions keep every existing check: an image, a foreign checkpoint or an unsupported host still blocks them durably, and the work continues in a new supported session.
- An unreadable `pi-context-memory.json` no longer leaves durable failure markers on sessions the preview had not protected. It stops each request until the file is fixed and Pi restarts; protected sessions still record the block.
- Each failed compaction and each blocked input now produces one notice instead of two to four identical ones. Notices name the controlled error code, what happened, whether requests are paused and the next step, and suggest `/compact` only where a retry can help. No provider text, note text or local path is included.
- Cancelling Pi's automatic compaction is reported as `CONTEXT_PREVIEW_COMPACT_REQUIRED` with an instruction to run `/compact`, instead of `CONTEXT_PREVIEW_UNSUPPORTED`. After a rollback to v0.3.2, a marker with the new code reads as invalid and stays blocked until an explicit `/compact`, which recovers it; a v0.3.2 marker opened by v0.3.3 recovers the same way. Both directions were checked on official Pi 1.1.0.
- `/compaction-recover` no longer blocks a session when there is nothing staged to confirm. In v0.3.2, running it on a healthy session, or right after a successful checkpoint, recorded a `CONTEXT_PREVIEW_COMMIT_UNCONFIRMED` block that only a successful `/compact` cleared; on a blocked session it replaced the reported error code. A refusal now changes nothing, says what was checked and points to `/compact` instead of back to itself. Confirmation failures of a staged checkpoint are still recorded.
- `/compaction-status` reports a pending attempt as `pending` rather than `blocked`. The fixed-writer warning shown at session start goes to stderr outside the terminal UI, so print-mode output stays clean.

### Added

- `/compaction-doctor`, a plain-language self-check that calls no model, writes no marker and does not change the session. It separates extension loading, host version, session support, writer, manual `/compact` eligibility and durable blocks. Pi's own history gate is reported as `unknown`, because Pi's compaction settings are not visible to extensions; the check explains Pi's default `compaction.keepRecentTokens` of 20,000 estimated tokens and its `Nothing to compact (session too small)` answer.
- `/compaction-status` keeps its fields and adds `host`, `supportedHost`, `protection`, `reason` and `manualCompaction`. After Pi starts or reloads extensions, one short notice says the preview is active and that it compacts only on request.

### Changed

- Rewrite the README around one copyable install command for the fixed `extension-v0.3.3` package, with separate commands to follow the moving branch, update one package and remove it by repository. It explains that a plain `pi update` updates Pi itself, that Pi records one source per package repository, and that Pi declines `/compact` in short sessions before the extension runs. Split the configuration page into preview and resident behavior, fix its link back to the README, and update the roadmap's current status. Resident compatibility notes moved from the README to the configuration page.
- Release notes install the fixed package tag alone in their first code block and suggest `/compaction-doctor`; they no longer repeat v0.3.2's test counts and point to the validation record instead. The notes come from a tested function in the release checks, and publication refuses notes in which a copyable block holds more than one Pi command or mixes the fixed tag with the moving branch.

### Maintenance

- Stock-Pi acceptance now copies the package to a temporary directory outside any Node project, runs every case there and refuses to start if a Pi installation could shadow the host under test. Inside this repository, after `npm run build:offline`, a package's Pi imports resolved to the patched workspace build: on official Pi 1.0.4 such a package read version 1.1.0. The unchanged v0.3.2 package passes all 26 legacy acceptance checks under the isolated runner. Acceptance adds a read-only first-use check and removes the package by repository source.
- Fifteen of the 17 scenario known gaps are now required checks. New cases cover an unreadable configuration, an image in a protected session and a protected session compacted natively; the first-use journey checks the self-check, a declined one-turn `/compact`, history retrieval and reopening. The two remaining known gaps measure long-session request overhead, which profiling attributes to re-hashing checkpoint source prefixes and reading the session file back on each of three request hooks; it is unchanged by this work.
- Add 16 focused preview regressions for session classification, durable and request-only blocks, fail-closed classification errors, notice limits, recovery refusals, status compatibility and the read-only diagnostics. The first-use scenario also runs `/compaction-recover` on a healthy session.

## [v0.3.2] — 2026-10-11

v0.3.2 fixes ordinary Agent retries in the independent extension preview for official Pi 1.1.0. The resident runtime, checkpoint schema and evaluation pin remain unchanged.

### Fixed

- The independent preview accepts Pi's validated omission of a failed assistant response during ordinary retries. Transient provider errors no longer create a compaction failure marker; retries, subsequent manual compaction, reload and reopening remain usable. Sessions with sufficient completed source history can recover existing retry-related blocks and text-only context-overflow failures through an explicit validated `/compact`. Recent-turn retention follows Pi's model projection while raw evidence hashes and checkpoint commit confirmation remain enforced. Arbitrary context edits, unfinished tool-call omissions and automatic compaction remain unsupported.
- Extension publication recognizes GitHub's default CodeQL scans with a `dynamic` event. Reviewed publication tooling can retry an existing immutable source tag without replacing its contents or release assets.

### Maintenance

- Add a shared operations runbook and script that connects existing verification commands, retains CI's pinned model-data download and checksum check, and documents private vulnerability reporting. Runtime behavior, build fingerprints, and evaluation contracts are unchanged.
- Select scripted writer evidence from fixture user messages in the offline paired-plan test, avoiding accidental matches in randomized directory metadata. A deterministic directory-name collision covers both existing judge concurrency cases with every assertion retained.
- Add a default-settings scenario runner for the stock-Pi preview. Each case runs beside a control without the extension: transient provider failures, context overflow, the compaction threshold, image input, sessions with native checkpoints, in-memory sessions, another Pi version, failed-compaction notices and long-session overhead. The v0.3.1 candidate initially missed 23 checks; six are required regressions in v0.3.2 and 17 remain known gaps that do not fail CI. A gap that starts passing fails the run until it becomes a required check. The `verify` workflow runs it after acceptance. The runner loads the package from outside the repository so that its Pi imports reach the host under test rather than the repository's workspace build. Findings are in the [validation record](docs/context-memory/validation.md#default-settings-scenarios-2026-10-11-utc). The acceptance runner now disables provider retries through Pi's actual `retry.provider.maxRetries` setting. The shared `preview` and `ci` commands run the same scenarios and prepare the second official Pi installation when needed.

## [v0.3.1] — 2026-10-11

The maintainer selected a patch-version increment for this new capability, as an explicit version-policy exception. v0.3.1 delivers the first independent extension preview for official Pi 1.1.0, through a package-only Git branch and immutable package tag. It covers manual compaction of fresh persistent text sessions. The resident build keeps its v0.3.0 fingerprint and evaluation identity; its broader guarantees and historical live results are separate.

### Added

- Add an independent-extension preview for unmodified official Pi 1.1.0: manual compaction of completed persistent text turns, public-registry writers, validated source-linked checkpoints and current-branch history retrieval. A minimal extension-only package builder and isolated stock-Pi acceptance runner cover package downloads and lifecycle behavior. Distribute the five-file extension package through `extension-preview` and `extension-v0.3.1`, with GitHub Release archives, provenance and SHA256 checksums; no Pi executable or installed host file is replaced. See the [scope and recovery guide](docs/context-memory/extension-preview.md).
- Persist pending and blocked preview attempts before writer calls; abort subsequent requests across new input, reload and reopening when a marker exists. Only an explicit manual retry with a matching checkpoint confirmed in the session JSONL clears the block. If initial marker storage cannot write any bytes, the failure is sticky in the current process but cannot be promised after restart once the storage fault is repaired. Preview guarantees are separate from resident disk-before-memory writes and cooperative leases.
- Add `/compaction-recover` to confirm an already staged and saved checkpoint whose commit observation was interrupted; unmatched or unstaged failures remain blocked. Pause stock Pi background cache warming through its public decision event while the preview is enabled, because that transport bypasses agent request guards. User cache-warming settings remain intact.

### Maintenance

- Keep the recovery evaluator pinned to its existing resident runtime while excluding only the separately packaged `context-memory/preview/` directory from that runtime's file check. Shared note/history code, host files and fixture inputs remain frozen; focused Git-backed regressions verify those boundaries. The stock-Pi package has its own source fingerprint and acceptance evidence, and no historical evaluation result is relabeled as preview validation.

### Security

- Update shell-quote from 1.10.0 to 1.12.0 in the sandbox example extension's standalone lockfile for GHSA-pqg4-j6r4-53mv, matching the root workspace lock. The sandbox example is not part of the coding-agent package or its bundle; a standalone `npm ci` and `npm audit` of that example report no vulnerabilities.
- Review CodeQL #43, #44, #45 and #46, new in the v1.1.0 snapshot; none requires a runtime change. The two reflected-XSS findings are OAuth callback pages whose provider-supplied text passes through `oauthErrorHtml`, which escapes it. The existing OpenRouter regression covers the shared callback server (#43), and a new regression sends a hostile `error` parameter through the ChatGPT sign-in page, which runs its own server (#44). In the `pi mcp` logging finding (#45), validation messages name the server and the broken rule, not values such as client secrets; only a malformed `--header` or `--env` pair is echoed, to the terminal that supplied it. The password-hash finding (#46) is a test hashing a public MCP server URL into a short identifier. The host security check now runs 107, 240, 3 and 111 checks, 461 in total.

## [v0.3.0] — 2026-10-09

v0.3.0 is the measurement release: it ships the evaluation method and the bounded live record below, and moves the host baseline to Pi v1.1.0. The complete two-arm baseline remains deferred; this release does not claim continuous two-checkpoint recovery or an advantage over native Pi.

### Changed

- Move the host baseline from Pi v0.86.0 to Pi v1.1.0 (`abe508e1b89912adde45528136c3221eb69acdd7`). The six compaction host integrations are replayed onto the newer source. Pi 1.x runs ordinary `context` transforms separately from `context_with_system`; resident failures now propagate from both phases, so a failed or stale compaction still blocks the next request.
- Follow Pi's first-user persistence: a new session file is published once it holds a user or assistant message or a checkpoint, and it is still written to disk under the session lease before entries reach the in-memory tree. Three persistence regressions now expect the earlier publication point; write rollback, source-file protection and failed-fork assertions are unchanged.
- Third-party provider and extension code must target Pi v1.1.0 before it is used with this release; it is not bundled or changed here. Existing valid checkpoints are read without rewriting.

### Fixed

- Require every `supersedes` reference to resolve to readable evidence on the supplied branch, matching the existing `sources` validation. Checkpoints, metadata entries, empty text and out-of-branch IDs are rejected before note commit and when reopening persisted notes. Readable older rulings remain valid without being duplicated in the current fact's `sources`. Previously accepted notes with unreadable `supersedes` references now fail explicitly; no history is deleted or silently repaired.

### Added

- Add versioned recovery fixtures, probes and deterministic scoring with isolated Pi runners and an explicitly authorized Luna/max subscription transport. Live evaluation preserves failure evidence, cumulative budgets and separately labeled actual/estimated usage; it does not change the compaction runtime.
- Add a bounded project-only daily validation: two selected compactions and two continuation checks, at most eight requests and ten minutes, with a 600-second writer deadline limited to this entry point. The final calibration allows 32,768 total writer output tokens including reasoning while preserving note commit limits and the probe ceiling. Its targeted offline test removes temporary artifacts.

### Security

- Retain provider URL-domain checks, now including upstream's `isCerebras` path, and the linear-time overflow, LaTeX, prompt-argument, diff and package-spec hardening with their regressions on the new baseline.
- Drop the v0.2.4 tool-slot index and skill-path repairs and their regressions: Pi v1.1.0 removed the `packages/agent` harness that contained that code. The host security check now runs 99, 240, 3 and 111 checks, 453 in total.
- Stop the durable harness JSON merge from following a parsed `__proto__` key into `Object.prototype` (CodeQL #47, new in the v1.1.0 snapshot). The key is not stored; ordinary keys, including `constructor`, remain data. The merge is used by the experimental durable, session-worker and vacation paths, not the default CLI/SDK session. Three focused regressions run in the security check.
- `npm audit` reports GHSA-86w9-cpqp-85rv (node-forge 1.4.0 and earlier, no patched release yet) through the upstream Gondolin example-extension workspace. node-forge is not a dependency of the coding-agent package or its bundle.

### Maintenance

- Pin the Pi v1.1.0 source archive for model data (SHA256 `63b17b48b855e36e64c5013523acd48131ffcfa90ae48fe2f3e6fa9fe3d0da32`), stamp builds as `1.1.0-context-memory.0.3.0+src.<hash>` and type-check with TypeScript 7's `tsc`. Omit the upstream `env`, `env-daemons` and `nix` workflows added since v0.86.0, consistent with the original snapshot import, and refresh `UPSTREAM_README.md` and `UPSTREAM_AGENTS.md`. The model-data helper now replaces the extracted catalog, so files dropped upstream do not survive an upgrade in an existing clone.
- Re-pin the evaluated runtime to the v1.1.0 port. Fixture and scorer bytes and historical live results keep their original runtime identities. The live transport reads the Luna model from Pi 1.x's type-keyed model data, and the measurement contract's host-footprint baseline now names v1.1.0.
- Known limits on the new baseline: Pi 1.x virtual models without a declared context window are rejected at session start with `CONTEXT_CAPACITY`, as other unknown windows are. The new built-in MCP, codemode and tool-search extensions have not been validated alongside the resident. Upstream's full coding-agent suite is not a release gate: tests that construct sessions outside `createAgentSession` fail by design with `CONTEXT_RESIDENT_REQUIRED`.
- Record the Pi v0.99.2 isolated resident-host compatibility check: 94 adapted compact core regressions and 86 upstream compaction-related cases passed, with two provider-dependent cases skipped. Document the context-phase error propagation required during a port and the updated first-user persistence fixtures. Documentation only; runtime source, the published Pi v0.86.0 baseline and released assets are unchanged. See the [validation record](docs/context-memory/validation.md#pi-v0992-isolated-host-port-check-2026-10-01-utc) and its [documentation commit](https://github.com/youxi-huang/pi-context-compaction/commit/256dd05a68a7894b9551daffe7e676e9f4591786).
- Record the reduced 0.3 measurement scope and actual live outcomes. Retain native partial recovery, the initial project output-limit failure, and the final calibrated attempt: one project checkpoint and continuation passed, then a second note was rejected for a misattributed quotation. Continuous two-checkpoint recovery and superiority over native Pi remain unproven; the complete two-arm baseline is deferred under the evaluation budget, with 16 unstarted runs closed.
- Settle the roadmap's architectural direction: session records and committed checkpoints are the durable facts, derived summaries and indexes are rebuildable projections, and compaction moves toward increments prepared during the task with the full commit gate retained at the boundary. Add a dedicated instruction-authority milestone ahead of the session-model increment experiment, reframe 0.4 around two compared preparation arms with an explicit failure lifecycle, fairness metrics and a stop condition, bound the 0.5 typed index and 0.6 reversible reduction with fallback and eligibility rules, and list a fingerprint-bound provider acceleration payload as a post-1.0 direction. The README states the same direction briefly. Documentation only; these plans are not implemented capabilities.
- Refine the roadmap's planned evaluation to distinguish evidence support, instruction authority and task continuation, and separate deterministic CI from provider measurements. Prioritize same-writer background preparation before a separate tiered-writer experiment; keep third-party baselines optional and require preserved guarantees while reducing host changes. Distinguish the first public stock-Pi extension from the mature compatibility and recovery contract required for 1.0. Documentation only; these plans are not implemented capabilities or new benchmark results.
- Commit to a public pre-1.0 stock-Pi extension with independent installation, configuration and updates. Start implementation in the 0.3 period, treating host-dependency review as its first step; use the 0.3/0.3.1 window as the initial scheduling target and adjust release scope/numbering from engineering evidence. Define preview acceptance separately from 1.0 maturity and retain the exclusion of a separate Pi distribution. Planning only; current runtime behavior and installation support are unchanged.
- Replace the two generated README diagrams with hand-authored SVG sources and their renders, and add a third figure covering the commit gate: the three checks that precede checkpoint publication and the blocking failure path. Each figure ships a dark-mode counterpart, selected through `prefers-color-scheme`. Name the commit gate in "How it works" and state that original records stay in the session JSONL. Documentation only; no runtime behavior changes.

## [v0.2.4] — 2026-09-20

### Changed

- Port the v0.2.3 compaction behavior to Pi v0.86.0 in the v0.2.4 compatibility release. Preserve transcript-backed system instructions and tool additions/removals across compaction and reopening; reuse that transcript for the session writer without adding a duplicate legacy header.
- Preserve Pi v0.86.0 handler snapshot/unsubscribe semantics while running ordinary compaction observers before the resident and propagating failures.

### Security

- Remove overlapping whitespace matching from Cerebras bodyless-error detection so malformed provider errors do not trigger quadratic regular-expression work.
- Prevent malformed persisted tool-slot indices from selecting inherited array properties during task abort. Add regressions for hostile property names, invalid indices and ordinary numeric slots.

### Maintenance

- Adopt the upstream cut-point correction, removing the dedicated compaction.ts host patch. Retain existing security hardening and Vitest 4.1.11, including the new durable workspace. Pin the v0.86.0 source archive and model data.
- Preserve existing release tags and assets. Custom providers must support the v0.86.0 transcript interface before they are used with this release; third-party provider code is not bundled or changed here.
- Reorganize the README around source-linked compaction, an illustrated recovery example and the limits of current evidence. Clarify that native Pi retains original session history, distinguish reference validation from semantic recovery, and show the default session writer before optional configuration.
- Add two illustrative flow diagrams and move the full configuration and event-log reference to `docs/context-memory/configuration.md`. Those documentation changes do not alter runtime behavior.

## [v0.2.3] — 2026-09-13

### Added

- Default per-compaction note budgets now use released-source size tiers, from 3,000/4,000 base/hard estimated tokens for up to 80k of readable source to 6,000/8,000 above 400k. A floor based on the preceding note's actual size prevents abrupt shrinkage without inheriting a lifetime high-water tier. Small-window and trigger caps still apply; automatic trigger and tool-turn policies do not change. Explicit `noteTokens` retains fixed hard-limit semantics.
- An otherwise valid note exceeding its frozen hard limit can receive one bounded, short same-writer size repair across the entire compaction. The default `noteRepair: true` permits this extra paid call; `false` keeps one-pass behavior. Exact quotations, source/supersedes anchors and occupied sections must survive. Other validation failures, transport errors and cancellation do not trigger repair; no model substitution or mechanical truncation is introduced.

### Fixed

- The writer's internal handover instruction now explicitly applies only to its JSON-writing response: it neither cancels the original task nor changes user authority, and must not be recorded as a user ruling or gap. Live note inspection found the earlier “stop the task” wording being carried into recovery notes as a new restriction.
- Checkpoint publication, reopening and reviewed-copy migration share stored-budget validation instead of silently imposing a separate 6,000-token limit after generation. New checkpoints carry bounded policy metadata; older checkpoints remain readable without rewriting. Notes over 6,000 require v0.2.3 or newer and cannot be resumed with an older binary. Generation preferences do not retroactively invalidate stored evidence; final model capacity guards still apply.
- Budget occupancy now compares serialized JSON bytes with the corresponding byte limit, not rendered note tokens with a JSON budget. Old events without the required measurements remain unknown instead of receiving inferred ratios.

### Maintenance

- Compaction status and local events expose frozen budget decisions, elastic acceptance and per-call generation/repair durations, sizes and usage. Failed and cancelled calls retain known costs; logs still contain no note or session text.
- Add focused boundary, repair, persistence, cold-reopen and compatibility regressions. v0.2.3 is a maintainer-approved exception to the normal minor-release policy for new strategies; the roadmap records the brought-forward scope explicitly. No new host patch or dependency is required.

## [v0.2.2] — 2026-09-12

### Fixed

- Automatic in-task handovers now pin the complete original user requests and steering from the unfinished turn in the checkpoint, independently of the writer's note. The writer must supply a nonblank next step, including final reporting when tool work is complete. Missing continuation fails before commit. Oversized requests are refused without truncation; image-bearing active requests retain their original turn rather than becoming text placeholders. Completed-turn and manual compaction policies are unchanged.
- Request guards verify that exactly one current checkpoint summary survives context handlers and that its text remains in the final provider payload. Missing or changed recovery content raises `CONTEXT_RECOVERY_MISSING` before inference. Extensions or provider adapters that intentionally rewrite checkpoint text must preserve it to remain compatible; the guard does not silently reinject or rewrite their output.
- Checkpoint publication and reopening validate the note against its source hash and rendered summary. New in-task checkpoints also validate pinned request IDs, original text and a continuation step. Damaged checkpoints are refused without rewriting the original history, including in disabled mode. Existing valid checkpoints remain readable; older checkpoints do not retroactively gain pinned requests. Compaction events count host-pinned text separately as `continuationTokens`.
- Both writers now receive the exact UTF-8 byte limit used by note validation and a smaller target with room for estimation error. Instructions favor deduplicated facts and retrieval anchors over bulky recoverable inventories. Oversized notes still fail without truncation, a hidden retry or a substitute writer; the error now reports estimated size and limit. History pagination guidance explicitly requires the original query parameters alongside the cursor.

### Maintenance

- Added eleven synthetic recovery and budget regressions and strengthened the repeated automatic-handover and history-pagination tests. These checks establish preservation and request blocking, not model understanding, long-running semantic accuracy or superiority to native Pi compaction. See the validation record for separate live Astra checks.
- Recorded the live Astra 10k sequence: nine automatic handovers, two completed audits and a successful session-reopening probe after correcting a real note-budget failure. The record includes pause and retrieval costs and does not claim a native-Pi comparison.

### Security

- Update Vitest and its matching coverage packages from 4.1.9 to 4.1.11 for [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9), a development-server file-read issue. This incorporates the security update proposed in [Dependabot PR #16](https://github.com/youxi-huang/pi-context-compaction/pull/16) with aligned coverage peers and a synchronized workspace lockfile; the generated production locks remain governed by their repository generators.

Based on Pi v0.85.1. [Changes since v0.2.1][v0.2.2 changes]. Distributed under the MIT license; still marked pre-release.

## [v0.2.1] — 2026-09-09

Reliability fixes on the same Pi v0.85.1 baseline. Automatic handovers now continue long tool tasks at low thresholds; existing session files require no migration.

### Fixed

- Automatic in-task compaction can now release fully paired tool rounds with the default zero keep budget, then continue through Pi's existing next-response hook. Previously it pinned the entire unfinished user turn and could not reduce a long-running task. Manual compaction, overflow retry and explicit keep budgets retain their existing rules.
- `compactAt` is a preferred automatic trigger, not a smaller model context window. Final message and serialized-payload guards now use the model window minus its output reserve. At a low trigger such as 5%, the payload guard could previously stop the task before the host's token estimate triggered compaction. Requests beyond the actual input allowance remain blocked.
- Repeated compaction of one unfinished tool turn follows the previous checkpoint's kept prefix instead of failing with `CONTEXT_NO_CUT`. When the turn finishes, zero keep budget again leaves only the note. Session context assembly skips older checkpoints embedded in that kept prefix; archived checkpoints, original history, `priorCheckpoints` and tool pairing are preserved. No session migration is required.
- Session and fixed writers now use the same actual output limit for capacity checks and provider requests. A model with a large maximum output previously caused false `CONTEXT_WRITER_CAPACITY` errors despite room for the much smaller requested note. Automatic thresholds and oversized-request rejection remain in place.
- Compaction events retain returned usage and writer timing when note validation fails or cancellation follows a response. `writerCalls` and `usageReports` distinguish calls with unknown usage. Invalid JSON is classified as `CONTEXT_NOTE_INVALID`. The report adds `writerAttempts.all` and `writerAttempts.byOutcome`; existing committed-only token fields keep their meaning, and old logs remain readable.

### Maintenance

- Added `docs/context-memory/roadmap.md`: version policy, the four measurements, planned minor releases and the external baseline. Linked from the README.
- Replaced the inherited upstream `AGENTS.md` with project-level agent instructions. The upstream file is retained as `UPSTREAM_AGENTS.md`. Previously an automated agent reading the repository root would have followed upstream Pi's release, test and changelog rules, which do not apply here.
- Added `docs/context-memory/upstream-delta.md`: the upstream baseline, what is new, and the seven host source files with the reason each one is changed. `THIRD_PARTY_NOTICES.md` previously counted six; the one-line `findCutPoint` change in `core/compaction/compaction.ts` from v0.2.0 is the seventh.
- The README now opens with the project's identity (experimental distribution, not a Pi package), the problem it addresses, the intended end state and what has actually been verified. No behavior described elsewhere in the README changed.
- Corrected the documented total for `scripts/security-regression-check.mjs` to 429: 77 AI tests, 235 coding-agent tests, 6 agent tests and 111 TUI tests. The earlier documentation counted only the final TUI group.
- Patch release policy now allows corrections to already promised behavior; new compaction strategies and capabilities remain minor-release work.
- `scripts/stamp-context-memory.mjs` now includes `core/compaction/compaction.ts` in the build fingerprint. The one-line `findCutPoint` change shipped in v0.2.0 was not covered, so a change to that line would not have altered the fingerprint. The build string on `main` changes as a result; no runtime behavior changes.

## [v0.2.0] — 2026-09-09

Low-friction compaction on the same Pi `v0.85.1` baseline, still an experimental source distribution and marked as a pre-release on GitHub. The session model writes its own handover note, nothing is kept after a checkpoint by default, a local event log records every attempt, and the first real two-checkpoint session drove three follow-up changes. See the validation record for what remains unproven.

### Changed

- The default writer is now the session model itself (`"writerModel": "session"`). The compaction request is the session's own provider context plus one closing handover instruction, so no second model or additional authentication is needed and the provider's prompt cache can serve the request. A fixed `provider/model` writer remains available and behaves as before. Sessions that previously relied on the implicit `openai-codex/gpt-6-astra` default must now name it in `pi-context-memory.json` to keep using it. Neither writer falls back to the other; failure still blocks the next request.
- After a checkpoint, model context keeps no original messages by default. The next request holds the system prompt, the note and the new input; original records stay in the session file and on screen and remain retrievable with `context_history`. An unfinished or retried turn keeps its own user message and tool rounds. Previously about 20,000 tokens of recent originals were kept, and sessions below that size could not be compacted.
- Manual `/compact` now works on any session with at least one complete turn, including short conversations.
- The default note budget is 3,000 estimated tokens (previously 6,000), still capped at 15% of the compaction threshold.
- Reasoning effort is passed to the writer only when the model declares reasoning support, matching Pi's own summarizer.
- `/compaction-status` reports the resolved writer, or the error class explaining why it cannot run. A fixed writer that is missing from the catalog or whose provider has no configured authentication is reported at session start, as a terminal notification or on stderr.
- Pi's `findCutPoint` falls back to the latest cut point instead of the first when the keep budget is met inside the trailing entries of the last turn. Previously a branch ending in a tool result could not prepare a compaction with a small keep budget.
- `scripts/context-memory-migrate.mjs --prepare` stops with a directed message when the writer is `session`, since the script has no live session; name a fixed writer for the run.
- Compaction events and checkpoints record the writer that actually ran (`provider/model`), not the configuration string.
- The `session` writer now reasons at the session's current thinking level, the way Pi's own summarizer does, instead of the configured `writerEffort`; `writerEffort` applies to a fixed writer only. A session with thinking off writes without reasoning. Compaction events record the effort actually sent as `writerEffort`. In a real two-checkpoint session on 2026-09-09 the session ran at `high` while both writer requests carried the configured `medium`; the two settings are now the same setting.
- `context_history` search ranks matched entries by number of matched terms, then conversation turns (user, then assistant) above tool output, then newest first. Previously ties kept conversation order, so a single-word query opened with the earliest and usually longest tool result on the branch and filled the page with it. Results are therefore no longer chronological; each excerpt now carries `position`, its index on the branch, and the tool description says so. Cursors from earlier builds are rejected with `HISTORY_CURSOR_INVALID` because the ranking version is part of the cursor signature.

### Added

- After a second checkpoint on a branch, the rendered note carries a `priorCheckpoints` section: the most recent earlier checkpoints (about three within a 600-token bound), oldest first, each as the nearest readable original at or before its `coveredThrough` plus the opening sentence of up to three state items, bounded by estimated tokens so Chinese and English cost the same share. When the bound is exceeded, middle checkpoints are dropped first and the newest last, so the oldest phase survives longest; the section also shrinks before a checkpoint would be refused for size. The host assembles it from stored checkpoints; the writer's JSON note and budget are unchanged, and the section states that its IDs are search anchors, not citable sources. Compaction events record its size as `lineageTokens`, separate from `noteTokens`. This keeps an earlier phase locatable through `context_history` when the newest note no longer mentions it: in a two-checkpoint session on 2026-09-09 the second note lost every conclusion and every entry-ID anchor from the first phase, keeping only a file read location.

- `pi-context-memory.json` accepts `keepRecentTokens` (default `0`), `noteTokens` (default `3000`, minimum `500`) and `compactAt` (an integer token count above 1 or a window share at or below 1; unset by default). Malformed values fail with `CONTEXT_CONFIG` at startup; a `compactAt` too small for the selected model fails with `CONTEXT_CAPACITY` when that model is selected.
- Local compaction event log. Each compaction attempt, request guard, `context_history` call and `context_note` candidate appends one JSON line to `context-memory-events.jsonl` in the agent directory, recording outcome, error class, durations, token counts, sizes and identifiers. No message text, note content, quotes, queries, file paths or free-form error text is written. Every session has a fixed quota per event kind; at 8 MB the file is renamed to `.1`, replacing the previous generation. `pi-context-memory.json` accepts `"eventLog": false` to disable it, and `"enabled": false` disables it as well; `/compaction-status` shows the log path and the last write error. `node scripts/context-memory-report.mjs` summarizes the log. Compaction behavior is unchanged.

### Maintenance

- Disabled Dependabot version-update pull requests for npm manifests. The three open version bumps could not pass `verify`: a lockfile out of sync in an example directory, a Biome release that changes the configuration schema and formatting of upstream files, and a `highlight.js` major release that removes the import path the host uses. Each would also widen the diff against the Pi `v0.85.1` baseline, which this project reduces only through reviewed host ports. Dependabot security updates and grouped GitHub Actions version updates remain enabled.

## [v0.1.1] — 2026-09-08

Maintenance release on the same Pi `v0.85.1` baseline. It carries the project rename, the reviewed security fixes, CI and dependency maintenance, and a compaction-handler compatibility fix. Still an experimental source distribution; see the validation record for what remains unproven.

### Changed

- Extensions that only observe `session_before_compact` and return `undefined` no longer trigger `CONTEXT_COMPACTOR_CONFLICT`. They run before the resident compactor and its writer call. A non-resident handler that returns a compaction or a cancellation still fails the compaction with the same error, now raised at the point the result is returned rather than at startup, so a competing compactor is rejected before the writer spends a request. Previously any handler registered for the event was treated as a competing compactor, which blocked startup when unrelated extensions used the event as a signal.
- Renamed the public project from Pi Context Memory to Pi Context Compaction and the repository to `pi-context-compaction`, clarifying its focus on task continuity during context compaction.
- Retained the `pi-context-memory.json` configuration file, `contextMemory` integration API, tool names, checkpoint identifiers and `context-memory` source paths. The rename does not require configuration or session migration.

### Security

- Removed quadratic regular-expression backtracking in skill-path handling, prompt-template defaults, npm package-spec parsing, diff-line parsing and LaTeX script formatting. Pathological input no longer causes the reproduced growth in processing time.
- Changed provider URL detection to match parsed HTTP(S) hostnames. Domain-like text in paths, user information or lookalike hostname suffixes no longer selects provider compatibility behavior or OpenAI-specific cache parameters. Explicit provider and compatibility settings remain supported.
- Added Git option boundaries for package clone and fetch operations. Git package references beginning with `-` or containing NUL are rejected before execution.
- Updated the sandbox example's locked `shell-quote` dependency from `1.8.3` to `1.10.0` and the Gondolin example's locked `undici` dependency from `6.26.0` to `6.28.1`, covering the nine dependency advisories reported for those lockfiles. Also updated a transitive `undici` entry in the root lockfile from `6.28.0` to `6.28.1`; the direct `undici` dependency remains `8.9.0`.

### Maintenance

- Added `node scripts/security-regression-check.mjs` to the existing CI workflow. Its 429 focused tests cover affected host behavior and existing OAuth HTML escaping and message-frame index validation, alongside the separate 18 context-compaction regressions.
- Added weekly Dependabot version checks for npm and GitHub Actions. npm minor and patch updates are grouped by production or development dependency, with a seven-day version cooldown and a limit of three version PRs. Pi host packages remain tied to the reviewed source baseline. Updates require review and are not automatically merged.

Implementation: [87b5d68](https://github.com/youxi-huang/pi-context-compaction/commit/87b5d688d113acafd522676aeaeb4453ae5c23a2) and [PR #6](https://github.com/youxi-huang/pi-context-compaction/pull/6). The offline build and focused checks passed in [Linux CI](https://github.com/youxi-huang/pi-context-compaction/actions/runs/34193631511) and on the merged observer fix. See the [validation record](docs/context-memory/validation.md) for coverage and limits.

## [v0.1.0-alpha.1] — 2026-09-07

Initial experimental source release, published as Pi Context Memory and based on Pi `v0.85.1`. Includes the host changes required by the compaction extension; it is not a drop-in extension for an unmodified Pi installation.

### Added

- A resident compaction extension that survives ordinary extension filtering and reload, with a configurable fixed writer and explicit handling of competing compactors.
- Structured context notes derived from original session records, with validated source references and exact quotations. Boundary compaction works even when the task model does not call `context_note`.
- Branch-scoped history search and paginated reads through `context_history`, including revocable parent-history grants for child-session hosts.
- Persistent-session writer leases, storage-before-publication ordering, stale-source checks and rollback handling. Failed compaction blocks the next provider request until recovery or new input.
- `/compaction-status`, a restart-latched fallback to Pi's default compactor and an explicit-copy migration workflow for complete original histories.
- Reproducible source-build helpers, pinned model data and 18 focused context-compaction regressions, verified in [release CI](https://github.com/youxi-huang/pi-context-compaction/actions/runs/34186515327).

### Compatibility and limits

- Persistent sessions support macOS and Linux; Windows persistence and network-filesystem locking are unsupported.
- Migration requires complete original records. It does not decrypt opaque remote checkpoints, reconstruct missing evidence or modify existing sessions automatically.
- Locally adapted BTW, subagent and provider packages are not bundled. Integrators must check compatibility with the exported host API.
- Long-running semantic quality and repeated incremental-note comparisons remain unvalidated. Source-reference checks do not establish semantic completeness.

Source commit: [ffbeccd](https://github.com/youxi-huang/pi-context-compaction/commit/ffbeccd0bd427058d2c62c0af5743cea9363bdc8). Distributed under the MIT license.

[Unreleased]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.3.3...main
[v0.3.3]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.3.2...v0.3.3
[v0.3.2]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.3.1...v0.3.2
[v0.3.1]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.3.0...v0.3.1
[v0.3.0]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.2.4...v0.3.0
[v0.2.3]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.2.3
[v0.2.3 changes]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.2.2...v0.2.3
[v0.2.2]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.2.2
[v0.2.2 changes]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.2.1...v0.2.2
[v0.2.1]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.2.1
[v0.2.1 changes]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.2.0...v0.2.1
[v0.2.0]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.2.0
[v0.2.0 changes]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.1.1...v0.2.0
[v0.1.1]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.1.1
[v0.1.1 changes]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.1.0-alpha.1...v0.1.1
[v0.1.0-alpha.1]: https://github.com/youxi-huang/pi-context-compaction/releases/tag/v0.1.0-alpha.1

[v0.2.4]: https://github.com/youxi-huang/pi-context-compaction/compare/v0.2.3...v0.2.4
