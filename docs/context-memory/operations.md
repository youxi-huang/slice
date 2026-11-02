# Shared operations runbook

Claude Code and Codex use this repository-owned runbook. Read it before routine
maintenance. Work from a checkout with the pinned evaluation commit in history;
CI uses Node 22 and a full clone (`fetch-depth: 0`), and repeats `verify` on
Node 24 and 26.

## Entry points

Run `node scripts/context-memory-ops.mjs <command>` from any repository directory
(adjust the path to the script). It uses only Node built-ins and existing commands.

| Command | Existing workflow |
| --- | --- |
| `doctor` | Read-only inventory: user/HOME, Node, Git, evaluation pin, dependencies, official Pi, duplicate names, untracked extension `.ts`, worktree. |
| `deps` | Run `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` when the lock hash/installation is stale; record the hash in `node_modules/.context-memory-ops-lock`. |
| `build` | deps, duplicate check, model data, stamp, fingerprint gate, `npm run build:offline`. |
| `verify` | build, `context-memory-check.mjs`, `security-regression-check.mjs`. |
| `preview` | build, preview build, acceptance on every Pi host the candidate lists (primary first, with cross-version checkpoints for each older host), Pi 1.0.4, default-settings scenarios on the primary host, release checks, release `--prepare`. |
| `eval [--full] [--keep]` | build, network-blocked reduced evaluation; `--full` uses `eval/check.mjs`; remove scratch artifacts unless `--keep`. |
| `ci` | build, both acceptance checks, all preview steps, full offline evaluation, in CI order. |

[`.github/workflows/context-memory.yml`](../../.github/workflows/context-memory.yml)
is the sole authority for commands and order. If this script disagrees, follow CI
and report the discrepancy. Preview install/acceptance commands come from
[extension-preview.md](extension-preview.md); evaluation commands come from
[eval/README.md](../../eval/README.md).

## Scale the check to the change

Run the narrowest command that observes the change. CI runs the full pipeline
on every pull request and push to main, and skips it only for a pull request
that touches nothing but Markdown under `docs/` or the repository root;
`CHANGELOG.md` and `docs/context-memory/extension-preview.md` always run it,
because release preparation reads the first and the package README is built
from the second. A push to main always runs it: publication accepts a tagged
commit only after its `verify` check passed, and a skipped job does not count.
The publication workflow also re-verifies every release on its tag.

Node 22 is the only Node a release is verified on.
[`context-memory-newer-node.yml`](../../.github/workflows/context-memory-newer-node.yml)
runs `verify` on Node 24 and 26 for pull requests and pushes to main, with the
same SHA-pinned actions, full clone and offline variables, and skips a change of
Markdown alone under `docs/` or the repository root. It is a separate workflow
because publication requires the whole `context-memory.yml` run on main to
succeed, so a newer Node can neither block nor approve a release. The supported
range in `engines` stays `>=22.19.0`.

| Change | Minimal local check |
| --- | --- |
| Markdown only, outside the two files above | None; `doctor` if worktree state is in doubt. |
| Extension or host source, shared tests, check scripts | `verify` |
| Preview source, preview scripts, scenarios, release tooling | `verify`, then `preview` |
| OpenCode or DSH adapter, adapter build or install acceptance | `node scripts/context-memory-adapters-check.mjs`, then `node --experimental-strip-types scripts/context-memory-adapters-acceptance.mjs --hosts-root <dir>` |
| Evaluation fixtures, scorer, runners, `eval/` scripts | `eval --full` |
| CI workflows, `context-memory-ops.mjs` itself, or in doubt | `ci` |

When the supported-host matrix outgrows one pull-request run (the 0.9.0 and
0.10.0 adapters), the intended split is: pull requests keep the primary host
and the conformance vectors, and the full matrix runs on merges to main and in
the release workflow. Today's matrix is small enough to run everywhere.

All child commands receive `PI_OFFLINE=1`, `EVAL_PROVIDER_MODE=scripted`, and
`EVAL_MODEL_CALL_BUDGET=0`. Stock-Pi acceptance uses its existing isolated loopback
services and synthetic credentials; it is not a real-provider result.
Both preview runners load a copy of the package from a temporary directory
outside any Node project, so its Pi imports reach the official host under test
rather than this repository's workspace build; do not bypass that check.
Every official Pi version uses `context-memory-preview-stock-install.mjs`, which
pins seven runtime components for 1.4.0, 1.3.0 and 1.2.0 and eight for 1.1.0 and 1.0.4,
including `chord`, and checks registry provenance and SDK startup with networking
denied. The host list comes from the candidate's `preview-build.json`
(`context-memory-preview-release-checks.mjs --plan`), the same source CI and
publication read; no script branches on a release or host version. npm
verifies download integrity. The installer does not hash manifests or lockfiles
again for unused report fields. A complete matching
cache skips npm; a mixed or incomplete cache is repaired. Scenarios report listed known gaps; new failures or a listed gap
that starts passing fail the step until the gap becomes a required regression.

Dependency and official Pi installation may download packages. As in CI, build
runs `node scripts/context-memory-model-data.mjs` directly: on a cold cache it
downloads the pinned source archive and verifies SHA-256 before extraction.

Normal output is two lines per step plus the final log-directory location.
Full logs live under `os.tmpdir()`, separated by user uid and invocation.
Use `--verbose` to stream output; `doctor --verbose` shows the inventory.
Doctor reports readiness without installing or requiring a clean checkout.
Duplicate filenames fail immediately. Other failures print the step's exit code,
duration and last 40 log lines. Exit 0 means completion, 3 marks the fingerprint
gate, 2 means invalid usage; a failed command retains its own exit code.

Preview `--prepare` requires a clean committed checkout. It only prepares local
archives and never publishes. Do not bypass its clean-source check.

The independent extension keeps a source fingerprint to bind package
acceptance and scenario evidence to its exact inputs. Host file hashes before
and after acceptance check that testing did not patch official Pi. Checkpoint
source hashes protect persisted evidence and recovery. These checks cover
different objects; none replaces the npm provenance and exact-cohort checks.
The resident fingerprint and model-data pin remain on the 1.1.0 source baseline.

## Two deliberate gates

Stop maintenance decisions at either gate and wait for the maintainer:

1. After stamp, a diff in
   `packages/coding-agent/src/extensions/context-memory/build.ts` means a
   fingerprinted runtime or host input changed. Checks may finish, but do not
   commit the new fingerprint without explicit approval in this task. The script
   warns, returns 3 after remaining checks, and never commits or restores it.
2. `EVAL_FROZEN_INPUT_CHANGED` means the evaluated input differs from its frozen
   contract. Do not change the pin in `eval/runtime.ts` or alter tests to bypass
   the failure. Report the evidence and wait for the maintainer's decision.

## Routine tasks

- **Unfixed vulnerabilities:** follow [SECURITY.md](../../SECURITY.md) for private
  vulnerability reporting. Stop and notify the maintainer first; until the fix
  is released, do not disclose details in public PRs, issues, commit messages,
  or this runbook.
- **Dependabot security PRs:** npm version-update PRs are disabled; review the
  remaining security updates individually. First establish whether the affected
  package is loaded by this project: sandbox examples do not enter the bundle.
  For examples with their own lockfile, run `npm ci --ignore-scripts` and
  `npm audit` in that directory. Regenerate the coding-agent install lock with
  `scripts/generate-coding-agent-install-lock.mjs`; never hand-edit it. State the
  GHSA identifier and affected scope in CHANGELOG's Security entry.
- **Weekly grouped GitHub Actions updates:** keep actions pinned to commit SHAs;
  do not replace them with tags.
- **Red CI:** reproduce with `ci`, then check whether main fails too. Identify
  and fix the cause; do not retry for luck, skip tests, or disable checks.
- **Red verify on Node 24 or 26:** run `verify` under that Node and under Node 22
  to tell a Node change from a project change, and record the actual error. Do
  not mark the job `continue-on-error`, pin an older Node patch or skip tests.
  Add a new Node major to the matrix when it is released and drop one at its end
  of life. Node 22 reaches end of life in April 2027; moving the release
  baseline is the maintainer's decision.
- **CodeQL alerts:** assess each alert to decide whether runtime code must change.
  Add needed regressions to `security-regression-check.mjs`. Follow CHANGELOG's
  Security entries for the fixes associated with alerts #43–#46 as writing models.
- **Runtime defects:** write a focused regression that reproduces the defect,
  then fix it. Expect the first deliberate gate.
- **Porting a newer upstream Pi:** submit a plan first, covering all six host
  files, `upstream-delta.md`, the stamp input list, and the model-data pin.

## Never

The rules in [AGENTS.md](../../AGENTS.md) apply in full: publication triggers,
version strings and fingerprints, `npm test`, and what may not enter the
repository, issues or PRs. Routine maintenance adds three:

- Use any credentials to run a real provider.
- Modify upstream snapshot files; a needed host change is a separate task.
- Copy operational logs anywhere but the local machine.

## Evidence

Every "verified" claim in a report or PR must name the command, result, and exit
code. Mark omitted checks `not run`. Separate scripted/synthetic evidence from
real-provider evidence; report failures as they occurred. Commit messages use
`type: summary`, with a lowercase start: `build`, `fix`, `feat`, `test`, `docs`,
`security`, `deps`, `eval`, or `scripts`.

A provider comparison between two builds runs them side by side: started
together on the same day, with the same bench settings and script, and at
least two runs of each build. One run per build is not evidence of a
difference. On 2026-10-18 the same release build refused twice at two P cuts
where it had not refused the day before, and two runs of one candidate
committed 58 and 63 of 64 notes.

## Two agents, one repository

Before starting, inspect open PRs and branches to avoid duplicate work. Use one
branch per task and never rewrite another agent's branch. When the same class of
problem appears for the third time, propose adding its handling to this runbook
in the PR description. To stop mid-task or continue another session's work,
follow the [handoff protocol](handoff-protocol.md). Personal language and
writing preferences belong in each platform's user settings, not here.
