---
branch: codex/segments-p5-offline
pr: 119
head: d6e92d9306c080a8985f174d9d8b21be9c099243
written: 2026-11-04, Claude Code cloud (the maintainer's reviewer session, machine B)
---

# Handoff: the writer's room at Pi's trigger, then final checks

## Goal and done-when

Close the GPT-6 Luna capacity finding, settle V2 and finish PR #119. Done when the capacity fix (or the evidence
that none is needed) is merged here, any grid cell it can change is re-measured, rule C is re-applied to the
result, the final checks pass on the final source, the PR description is current, and this file is deleted in the
last commit. Add commits only; keep the PR a draft and unmerged. Call no model provider: Luna runs only from the
maintainer's reviewer session, which holds the proxy, under a budget the maintainer approves.

## State

- [verified] Complete grid: 80 rows from machines A to E, each recomputed from its raw metrics with
  `p5-tools/rows.py` and matching the published row; every build ID matches its package. Machine B, 2026-11-04.
- [verified] Rule C as amended selects V2; D's gate holds. Numbers in the validation entry's Decision section.
- [verified] `codex/segments-p5-provider` merged without conflict at `61a614d`.
- [verified] Four Luna chains, exit 0, US$0.39, data at `348858d` on `claude/confident-thompson-3k0e8p`.
- [verified] `node --test scripts/context-memory-preview-provider-proof.mjs scripts/context-memory-preview-bench.test.mjs`:
  27/27, exit 0, Node 22, at `61a614d`; `git diff --check` clean before the evidence commit.
- [inferred] The capacity refusal may reach the writer with segments off too: a real session meets Pi's own
  trigger at every boundary, and the segments-off Luna chain never reached it (validation, "Open").
- [not run] Final checks on the final source.
- An earlier coordinator on a former Codex machine may still push duplicate 10 s rows to this branch. They are
  not needed; on a conflict, keep this branch's validation entry and drop its marked block.

## Decisions

- Rule C as amended on 2026-11-04 by the maintainer: pause counts as well as service (validation, Decision).
- Cells may run on separate machines; all arms of one cell on one machine; an unconditional second run counts
  like a repeat. Rejected: per-arm splitting across machines, which breaks within-cell comparison.
- Provider evidence is reported apart from the grid, and only machine B runs it.
- The capacity work happens on `codex/segments-p5-capacity`, branched from this PR, so that this branch carried
  the evidence while it ran. Its kickoff asks for CAPACITY.md at that branch's root and no validation.md edits.

## Read first

1. `AGENTS.md`, then `docs/context-memory/handoff-protocol.md`.
2. The validation entry's sections "Decision", "GPT-6 Luna through the provider replay mode" and "Open".
3. `CAPACITY.md` on `codex/segments-p5-capacity`, and its diff.

## Settled

- V2 against V1 and V3 on the offline grid; cache semantics; the provider replay mode; 10 s turns for any Luna run.

## Next steps

1. `git fetch origin main codex/segments-p5-offline codex/segments-p5-capacity`; compare
   `git log --oneline d6e92d9306c080a8985f174d9d8b21be9c099243..origin/codex/segments-p5-offline` and merge `origin/main` if it moved.
2. Merge `origin/codex/segments-p5-capacity`. Fold CAPACITY.md into the validation entry's "Open" section, which
   becomes the finding and its fix, and delete CAPACITY.md.
3. If the fix can change grid cells, re-measure them with all four packages per cell on one machine, the fixed V2
   replacing V2, using `P5-CELL-INSTRUCTIONS.md` and `p5-tools/` from `claude/confident-thompson-3k0e8p` with the
   new V2 digest; Codex sessions may run cells in parallel. Re-apply rule C to the whole grid.
4. Ask the maintainer's reviewer session for the same four Luna chains on the final V2 (about US$0.40, new budget).
5. Run the final checks listed in the validation entry, record commands, counts and exits, rewrite the PR
   description, delete this file and push.

## Previous handoff check

- Missing: the coordinator kept running after the handoff and published four more cells; the maintainer amended
  rule C and split the grid across machines in kickoffs, not in the handoff.
- Repeated: none.
- Wrong: none.
- Unused: the serial collection steps, done by the coordinator and by machines B to E.
