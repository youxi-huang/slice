# Parallel P5 cells for PR #119

Several Codex sessions each measure one cell of PR #119's serial grid on their own machine, so the grid finishes
sooner. The protocol is the first entry of `docs/context-memory/validation.md` on branch `codex/segments-p5-offline`;
this file gives the exact steps, and the tools under `p5-tools/` implement them. Read `AGENTS.md` first.

Call no model provider. Write no code. Change nothing on `codex/segments-p5-offline`, push nothing there and open
no pull request. Your only push is your own branch below.

## Assignments

| ID | Cell: turn / writer / route | Run | Your branch |
| --- | --- | ---: | --- |
| C | 10 s / 13 s / 200k | 1 | `codex/segments-p5-cell-c` |
| D | 10 s / 13 s / 272k | 1 | `codex/segments-p5-cell-d` |
| E | 10 s / 28 s / 200k | 2 | `codex/segments-p5-cell-e` |

Elsewhere, the earlier coordinator measures from the front of the grid and machine B has the 10 s / 28 s cells.
E is a second run of a cell machine B measured first; it counts like a repeat.

## Steps

Use a work directory outside the repository, for example `~/p5`, and copy the tools there first.

1. `git fetch origin main codex/segments-p5-offline claude/confident-thompson-3k0e8p`, then copy each file of
   `p5-tools/` from `origin/claude/confident-thompson-3k0e8p` into `~/p5/tools` with `git show`.
2. `node scripts/context-memory-ops.mjs deps`, then
   `node scripts/context-memory-preview-stock-install.mjs --stock-root .artifacts/context-memory-preview-stock --version 1.4.0`.
3. `bash ~/p5/tools/build-packages.sh . ~/p5`. It builds main, V1, V2 and V3, checks every bundle against the
   recorded SHA-256 and prepares the bench at `d9e4513`. On any mismatch, stop and report; do not measure.
4. Run your cell, and nothing else on the machine until it prints `cell-done` in `~/p5/progress.log`
   (85 to 95 minutes; no builds, tests or other benchmarks meanwhile):
   - C: `bash ~/p5/tools/run-cell.sh ~/p5 .artifacts/context-memory-preview-stock codex-c 10000 13000 200k 1`
   - D: `bash ~/p5/tools/run-cell.sh ~/p5 .artifacts/context-memory-preview-stock codex-d 10000 13000 272k 1`
   - E: `bash ~/p5/tools/run-cell.sh ~/p5 .artifacts/context-memory-preview-stock codex-e 10000 28000 200k 2`
5. C and D only: if `python3 ~/p5/tools/needs-repeat.py ~/p5/out/<cell>-r1` prints `yes`, run the same command
   again with run `2`. Report both runs; never choose between them. E does not repeat.
6. Create your branch from `origin/main` in a separate worktree, run
   `python3 ~/p5/tools/collect.py ~/p5 <ID> <that worktree>`, which refuses to write if any arm failed, replayed
   tools inexactly or carries a local path. Commit `P5-SERIAL-MACHINE-<ID>.md` and `p5-serial-<id>/`, push the
   branch, and report its head commit and the table rows.

If the session must stop before step 6, push whatever cells completed in the same way, and say which are missing.
