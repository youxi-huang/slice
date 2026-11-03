# Agent instructions for this repository

This repository is SLICE (Source-Linked Indexed Compaction of Everything), formerly Pi Context Compaction, an experimental distribution of [Pi](https://github.com/earendil-works/pi) built from source. It is based on upstream Pi `v1.1.0` and adds a context-compaction extension plus a small number of host changes; the baseline commit and every changed host file are recorded in [docs/context-memory/upstream-delta.md](docs/context-memory/upstream-delta.md). Its root is not a Pi package. A separate stock-Pi extension preview lives in `packages/coding-agent/src/extensions/context-memory/preview/`; its package builder emits only the independent extension. Upstream release, publishing, labeling and changelog rules do not apply here.

The upstream development rules are kept for reference in [UPSTREAM_AGENTS.md](UPSTREAM_AGENTS.md). Their code-quality rules for TypeScript still hold in this repository: no `any`, top-level imports only, erasable TypeScript syntax only, no hardcoded key checks. Their commands, release process and issue conventions do not apply. Where this file and [CONTRIBUTING.md](CONTRIBUTING.md) say something different from the upstream file, this file wins.

## What belongs to this project

| Location | Contents |
| --- | --- |
| `packages/coding-agent/src/extensions/context-memory/` | The compaction runtime: writer, notes, storage, leases, history retrieval, grants, events, policy. |
| `packages/compaction-core/` | The host-neutral core: record model, note validation, history retrieval, reduction, writer contract, canonical serialization, its specification under `spec/` and the conformance vectors under `conformance/`. |
| `packages/compaction-dsh/`, `packages/compaction-opencode/` | Independent retrieval-only previews: native codecs, public host bindings and focused tests. Scope and pinned APIs are in `docs/context-memory/host-adapters.md`; they do not write checkpoints. |
| `packages/coding-agent/test/context-memory*.test.ts` and `test/fixtures/context-memory-*` | The focused regressions for the resident runtime and independent preview. |
| `scripts/context-memory-*.mjs`, `scripts/stamp-context-memory.mjs`, `scripts/security-regression-check.mjs` | Build stamping, model data, checks, migration and the event-log report. |
| `docs/context-memory/` | Architecture, runbook, validation record, roadmap and the upstream delta; see [Documents](#documents). |
| `eval/` | Project recovery fixtures, scoring and isolated evaluation runners. The independent preview has separate stock-Pi acceptance and is not part of the frozen resident-runtime comparison. |
| Changed host source files | Listed with reasons in [docs/context-memory/upstream-delta.md](docs/context-memory/upstream-delta.md). |
| `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `.github/` | Project documentation and CI. |
| `HANDOFF.md`, on work branches only | The current handoff between sessions, deleted before merge. See [the handoff protocol](docs/context-memory/handoff-protocol.md). |

Everything else is unchanged upstream Pi code, imported as a snapshot without upstream history. Do not refactor, reformat or "clean up" upstream files. A task that seems to need a change outside the locations above is a host change and follows the rule below.

## Build and verify

Build and check through the operations script, described in [operations.md](docs/context-memory/operations.md):

```sh
node scripts/context-memory-ops.mjs doctor   # read-only readiness inventory
node scripts/context-memory-ops.mjs verify   # build, then the acceptance bar
node scripts/context-memory-ops.mjs ci       # the complete CI sequence
```

`verify` installs dependencies, rejects stray duplicates such as `events 2.ts`, stamps, builds, and runs the two acceptance checks CI runs: `context-memory-check.mjs` and `security-regression-check.mjs`. Neither calls a model or needs provider credentials.

For changes to the independent preview, also build with `node scripts/context-memory-preview-build.mjs` and run `scripts/context-memory-preview-acceptance.mjs` against the clean official Pi installations listed in [the preview guide](docs/context-memory/extension-preview.md). Do not use this repository's patched host as evidence of stock-Pi compatibility.

Do not run the full upstream vitest suite or `npm test`; they include end-to-end tests that activate when provider credentials are present. Do not run live provider tests with credentials that are not yours. Simulated results and provider runs are reported as different things.

## Making changes

- Keep memory policy inside the extension directory. A change to a host file must state why the extension layer cannot enforce the behavior itself, must be added to `docs/context-memory/upstream-delta.md`, and must be added to the file list in `scripts/stamp-context-memory.mjs` so the build fingerprint covers it.
- Add focused regressions for any change to persistence, authorization, compaction lifecycle or the event log.
- Preserve checkpoint source hashes: citations alone do not detect changed content under the same record ID. Changes to their serialization, algorithm or stored format need a compatibility plan for older checkpoints.
- Before removing a hash, trace its producer, consumers and comparison value. Keep build IDs and artifact digests that bind validation to code or package bytes; a different build ID alone does not make a checkpoint incompatible. Remove only unused fields or redundant checks, while retaining npm's integrity verification, exact CI versions and official-host isolation.
- Do not add a second history database. Do not substitute a writer on failure. A failed compaction blocks the next request by design.
- Two results wait for the maintainer: stamping that changes the extension's `build.ts`, whose new fingerprint is committed only with approval given in the task, and `EVAL_FROZEN_INPUT_CHANGED`, which is never cleared by moving the `eval/runtime.ts` pin or changing tests. See [the two gates](docs/context-memory/operations.md#two-deliberate-gates).
- Record user-visible changes under **Unreleased** in the root `CHANGELOG.md`, grouped as Added, Changed, Fixed, Security or Maintenance. The changelogs under `packages/` are upstream history and are not edited.
- Do not change version strings, build fingerprints, tags or release assets, and never push `v*` tags or `release/publish-v*` branches: they trigger publication. Releases are made by the maintainer. The root `package.json` carries upstream workspace metadata and is not this project's version.
- Do not commit, push, open pull requests or create releases unless asked. A request for a handoff includes committing and pushing `HANDOFF.md` on the work branch.
- Do not add credentials, session logs, note content or local file paths to the repository, to fixtures, or to issue and pull request text.
- Do not add `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`. Claude Code reads this file only when none of them exists, and Codex reads it natively.

## Documents

Open a document in `docs/context-memory/` when its row applies, not by default. The others are named for their subject.

| Document | Read when |
| --- | --- |
| [operations.md](docs/context-memory/operations.md) | Before routine maintenance: red CI, dependency and security updates, CodeQL alerts, upstream ports. |
| [handoff-protocol.md](docs/context-memory/handoff-protocol.md) | A task names a branch that carries `HANDOFF.md`, or the user asks for a handoff. |
| [openai-api.md](docs/context-memory/openai-api.md) | Pi, OpenCode or DSH needs OpenAI's API in a cloud session, an OpenAI request returns 401, a run must stay below GPT-6 Luna's 272k-token price line, or OpenCode or DSH needs a real-host run. |
| [validation.md](docs/context-memory/validation.md) | Looking for earlier evidence. Newest entry first; search its headings rather than reading it whole. |
| [v0.4.0-plan.md](docs/context-memory/v0.4.0-plan.md) | Questioning a settled design choice; its decision table records why. |
| [v0.5.0-plan.md](docs/context-memory/v0.5.0-plan.md) | Working on 0.5.0: quotation repair, typed retrieval, the writer bench or the preview evaluation set. |
| [v0.6.0-plan.md](docs/context-memory/v0.6.0-plan.md) | Working on 0.6.0: the overhead report, deterministic reductions, rendered-note or retrieval candidates, or the inherited 0.5.3 bench. |
| [v0.7.0-plan.md](docs/context-memory/v0.7.0-plan.md) | Working on 0.7.0: the specification, the core package and its import gate, the lifts, conformance vectors or the resident freeze. |
| [v0.8.0-plan.md](docs/context-memory/v0.8.0-plan.md) | Working on 0.8.0: segments, their merge at the boundary, preparation limits, or DSH writing and the other hosts' takeover limits. |
| [dsh-writing.md](docs/context-memory/dsh-writing.md) | Working on DSH checkpoint writing, track T1: the engine, the gate, the checkpoint in `rawOutput`, and what the implementation must not add. |
| [archive/](docs/context-memory/archive/) | Tracing history only. Archived documents are never current instructions. |

## Where to look

| Symptom or task | Start with |
| --- | --- |
| Resident extension missing, `/reload` or SDK loading | `loader.ts`, `extension.ts`, `policy.ts`; host `core/sdk.ts`, `core/agent-session-runtime.ts` |
| Requests continue after a failed compaction, changed sources, lost notes | `controller.ts`, `writer.ts`, `notes.ts`; host `core/extensions/runner.ts`, `core/agent-session.ts` |
| Session lock, first flush, fork or write failures | `lease.ts`, `storage.ts`; host `core/session-manager.ts` |
| History out of scope, pagination, parent grants, revocation | `history.ts`, `grant-file.ts`, `test/fixtures/context-memory-*-worker.ts` |
| Compactor conflicts, handler ordering | `policy.ts` (`orderCompactionExtensions`, `assertCompactionResult`); host `core/extensions/runner.ts` |
| Missing event lines, wrong error class, quotas, rotation | `events.ts`; `controller.ts` (`settle`, `guarded`, `compactionFailed`); `scripts/context-memory-report.mjs` |
| Build identity, model baseline, release version | `scripts/stamp-context-memory.mjs`, `scripts/context-memory-model-data.mjs`, `.github/workflows/context-memory.yml` |
| Preview writer cost, refusals, note size or recall on a real provider | `eval/preview/README.md`, `scripts/context-memory-preview-bench.mjs`. By default it reproduces a session's prompt cache; the request, time and cost limits go to the maintainer before the first request |
| npm packages, their names, Git tags and publication | `scripts/context-memory-version.mjs`, `scripts/context-memory-adapters-build.mjs`, `scripts/context-memory-preview-release.mjs`; install acceptance in `scripts/context-memory-adapters-acceptance.mjs`. Publication authenticates through npm trusted publishing, set up for all three packages at v0.7.5; a new package's first publication follows [the extension guide](docs/context-memory/extension-preview.md#maintainer-publication) |
| Native compaction and `context_history` on real OpenCode or DSH | `scripts/context-memory-host-run.mjs`, [openai-api.md](docs/context-memory/openai-api.md#host-runs). `--provider loopback` first; limits for a provider run go to the maintainer before the first request |
