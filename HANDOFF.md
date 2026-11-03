# Handoff: v0.8.0 after WP5, the release decision

- Branch `claude/determined-carson-h13gug`, restarted from `main` after
  [#114](https://github.com/youxi-huang/slice/pull/114) merged; this handoff's draft PR,
  [#118](https://github.com/youxi-huang/slice/pull/118), is the only open work on it.
- `head`: `b99714c`, the merge of #114 into `main`.
- Written 2026-11-03 UTC, by the session that ran WP0 to WP5.

## Where things stand

- **verified** #114 is merged into `main` as `b99714c`. All nine checks were green on its last head, `ffba5cd`:
  verify, adapters, verify on Node 24 and 26, scope, CodeQL. It holds the plan, WP0 to WP5 and DSH writing stage 1.
- **verified** WP5 ran within the maintainer's approval and its provider gate is **not met**. Luna used 967 of 1,600
  requests, 167 of 300 minutes and $2.41 of $9; DeepSeek used 424 of 900, 22 of 150 and $3.09 of $6. No further
  provider request is approved. Record: `docs/context-memory/validation.md`, "0.8.0 WP5"; summary in
  `docs/context-memory/v0.8.0-plan.md`, WP5, "Result".
- **verified** U12's condition is not met, so WP6 was not started, as the maintainer's conditional approval said.
  Segments stay off by default (U13), and the preview guide and changelog call them an experiment.
- **verified** The offline release gates pass on `6b08fa2`, package `stock-preview+src.72c8ba45c5791e42`, with
  segments off and on. Commands and counts: `validation.md`, "0.8.0 offline release gates".
- **not done** Version, tags and npm: nothing was bumped, tagged or published.

## Decisions taken in this session, in full

- WP5's budget, the gate read at the immediate pace and U5's rule are recorded in the plan's WP5 section. The rule
  left the session's level as the segments' default.
- The maintainer approved WP6 only if WP5 met U12's condition, and asked otherwise to merge and hand off. That is what
  happened. Pre-tag release work was asked for in the case where WP6 was done. With the provider gate unmet, whether
  0.8.0 ships at all is the maintainer's call under the plan's release gates, so no version string was changed
  (AGENTS.md needs approval for that).

## What the maintainer decides first

How 0.8.0 goes out. The options:

- **(a) Release 0.8.0 now**, with segments as an off-by-default experiment and the unmet provider gate stated in the
  release notes. This ships the writer's source-limit fix (`6b08fa2`). That fix matters with segments off: Luna at
  `medium` failed six compactions in seven on P5's 272k route without it.
- **(b) Before releasing**, bound how much verbatim history a segments boundary may keep, then measure again on a new
  budget. The overflow that blocked sessions on DeepSeek comes from that tail.
- **(c) Hold 0.8.0.** Take the structural questions to the next plan: closing a range inside a long run, and U7's
  tail writer.

The session's recommendation is (a) now, then (b) as 0.8.1.

## Steps once the maintainer approves (a)

1. Next session, on this branch: set `SLICE_VERSION` in `scripts/context-memory-version.mjs` to `0.8.0`. Update the
   install commands pinned to 0.7.5 in `README.md`, `docs/context-memory/extension-preview.md` and
   `docs/context-memory/host-adapters.md`. Find them with `grep -rn "0\.7\.5"`; the scripts read the version
   themselves.
2. Next session: turn `## [Unreleased]` in `CHANGELOG.md` into `## [v0.8.0] — <date>` with a summary paragraph, and
   delete `HANDOFF.md` in the same PR. Run `node scripts/context-memory-ops.mjs ci`, then push.
3. Maintainer: merge that PR once CI is green.
4. Maintainer: push the tag `v0.8.0` to the merge commit, as in
   [Maintainer publication](docs/context-memory/extension-preview.md#maintainer-publication). The workflow builds,
   tests and tags `extension-v0.8.0`, `opencode-v0.8.0` and `dsh-v0.8.0`, and publishes all three npm packages through
   trusted publishing.
5. Maintainer, in the GitHub UI: dismiss the two minimatch runtime alerts. Also resolve
   [#117](https://github.com/youxi-huang/slice/pull/117)'s conflict in `CHANGELOG.md`; it targets `main` and edits
   the same Unreleased section.

## Read first

`validation.md` "0.8.0 WP5" and "0.8.0 offline release gates"; the plan's WP5 "Result" and Decisions table (U1 to U13,
settled); `extension-preview.md` "Maintainer publication". Do not reopen U5, U6 or U12: their outcomes are recorded in
the plan.

## Not run, or inferred

- **not run** Luna at `max` on the 272k route. Its minutes went to the source-limit finding.
- **inferred** Luna's segment notes failed the schema at `off` and `low`, likely for the same source limit. Not
  verified.
- **not run** The source-limit rule on any model other than Luna.

## First step

Ask the maintainer to choose (a), (b) or (c), showing the three options above. On (a), do steps 1 and 2 on this
branch.

Previous handoff check: none; this session took over no handoff.
