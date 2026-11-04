---
branch: claude/v0.8.0-release
pr: none yet
head: 65b9d8d5dd40ebd94e2e2d7a1da6d0925c82b720
written: 2026-11-04, Claude Code cloud (the maintainer's reviewer session)
---

# Handoff: 0.8.0 up to the tag, then the larger Luna run

## Goal and done-when

Part 1 brings 0.8.0 to where only the maintainer's tag remains. Done when this branch carries the 0.8.0 version,
install pins and changelog heading, the cross-version reopen check has passed on its build and is recorded,
`node scripts/context-memory-ops.mjs ci` exits 0, this file is deleted in the last commit and the PR is ready. The
maintainer merges and pushes `v0.8.0`. Never push a `v*` tag or a `release/publish-v*` branch.

Part 2 measures what the release leaves open, on GPT-6 Luna, only after the maintainer approves its limits. It does
not gate the release.

## State

- [verified] PR #119 merged into `main` as `65b9d8d`: V2, U8's estimated wait, the bounded writer path and the
  provider replay mode. CI green on its head `d44ea44`. Final checks on `e758e11` (later commits are documents):
  `verify` and `preview` exit 0; stock 42/36/36/36 with segments off and on; strict scenarios 157 both ways; core
  224; fuzz 449/449 at 200 seeds; P5 off-equivalence with the previous `main` equal on both routes. Commands and
  counts: `validation.md`, "0.8.0 segment scheduling review", section "Final checks".
- [verified] Preview package `stock-preview+src.7c815afa75319b7b`, bundle SHA-256 `310fd964…`, built from `e758e11`.
- [verified] Luna recovery check, US$0.62: both arms passed 47 of 49 of P5's probes, none wrong. Same entry,
  "Recovery on Luna with V2: a small check".
- [verified] #120 closed, its branch kept: the entry cites its commits `348858d`, `6e68943` and `2e15513`.
- [not run] The cross-version reopen check on this build. It last passed on `6b08fa2` (`validation.md`, "0.8.0
  offline release gates"). [inferred] It should pass: no commit since changed the checkpoint format or the source
  hashes, as #119's description states.
- [not run] No version string changed; nothing was tagged or published. npm's current release is 0.7.5.

## Decisions (maintainer, 2026-11-04)

- Ship 0.8.0 with segments off by default as an experiment; the changelog says they did not shorten the pause.
  Rejected: holding 0.8.0 for more provider evidence. Segments are off by default, and the release carries two
  fixes that matter with them off: the writer's 20-source rule and the bounded writer path.
- Release before the larger run. The bounded path acts only where the session would otherwise block, so a refusal
  in it leaves the session as 0.7.5 would: blocked until `/compact` succeeds.
- Deferred past this release's tag: the larger provider run (needs limits), the evaluation of hard compaction, DSH
  writing stages 2 and 3, and track T2's upstream requests, which the maintainer files; none is filed yet.

## Read first

1. `AGENTS.md`, then `docs/context-memory/handoff-protocol.md`.
2. `git show 3cb3743:HANDOFF.md`, section "Steps once the maintainer approves (a)". Its steps 1 and 2 are this
   branch's work; its step 5 is the maintainer's after publication.
3. `validation.md`: the status paragraph of "0.8.0 segment scheduling review", then "0.8.0 offline release gates"
   for how the reopen check was run.
4. `extension-preview.md`, "Maintainer publication".

## Settled

- V2 under rule C and U1 to U13: `v0.8.0-plan.md`, Decisions and WP5. Do not reopen them.
- The bounded writer path is consistent with "Do not substitute a writer on failure": `validation.md`, "The
  writer's room at Pi's own trigger: the finding and its fix".

## Next steps

1. `git fetch origin main claude/v0.8.0-release`; `git log --oneline 65b9d8d..origin/claude/v0.8.0-release` should
   list only handoff commits. Merge `origin/main` if it moved.
2. On this branch: `SLICE_VERSION` to `0.8.0` in `scripts/context-memory-version.mjs`; the install pins in
   `README.md`, `extension-preview.md` and `host-adapters.md` (`grep -rn "0\.7\.5"`; keep history such as "from
   v0.7.5"); rewrite the guide's opening, which still describes v0.7.5, for 0.8.0; turn `## [Unreleased]` into
   `## [v0.8.0] — <date>` with a short summary paragraph.
3. The reopen check on the built package, as "0.8.0 offline release gates" records it: checkpoints this build writes
   on the segments path (P5's 200k route, loopback replay, `--keep-sessions`) reopen in `slice-pi@0.7.5` from npm,
   and checkpoints from `extension-v0.4.3` and `extension-v0.5.3` written on Pi 1.3.0 reopen in this build; one
   request and one `context_history` read each, loopback provider, official Pi 1.4.0. Record it in `validation.md`.
4. `node scripts/context-memory-ops.mjs ci`; delete this file; push; mark the PR ready. Tell the maintainer to merge
   it and push `v0.8.0` to the merge commit. After publication the maintainer dismisses the two minimatch alerts
   (#117 documents why they stay) and may delete `codex/segments-p5-capacity` and `codex/segments-p5-provider`,
   both merged.
5. Part 2: propose the larger Luna run's limits before any request. Candidates: probe pairs repeated on both
   routes, to see the variance one chain cannot; the chunked path's refusal rate and pause at Pi's default reserve
   of 16,384 with segments off, where users will meet it; V2 at Luna's `max`. Rules: `openai-api.md`.
6. Ask the maintainer where hard compaction's evaluation goes, then update the `roadmap.md` paragraph beginning
   "Scheduling needs a separate evaluation", which still places it in 0.8.0.

## Previous handoff check

Recorded in PR #119's description.
