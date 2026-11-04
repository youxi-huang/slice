---
branch: codex/segments-p5-offline
pr: 119
head: 8ff29b415ea5c7410739e3455c505f3b28445e2e
written: 2026-11-04, Codex cloud
---

# Handoff: continuation-cache serial ablation

## Goal and done-when

Finish the maintainer's current A-D round and addendum on PR #119. Add commits only;
merge main first if it moved; keep the PR draft and unmerged. Call no model provider.
Finish the serial matrix/repeats, C selection and matching requested files, conditional
offline D proof/budget, final checks and PR description under about 120 lines.
No new configuration switch. Remove this file in the final work commit.

## State

- [verified] A is implemented in `d9e4513`: `node --test scripts/context-memory-preview-bench.test.mjs`, 10/10, exit 0.
- [verified] First 14 serial benchmark commands: 14 exit 0, 36 boundaries, exact tools,
  one SDK session per chain. Commands/metrics/digests: first [validation entry](docs/context-memory/validation.md#080-segment-scheduling-review-official-pi-p5-batch-replay-offline-2026-11-04-utc), `8ff29b4`.
- [verified] Provisional V2 checks: core 221/221; focused/fuzz 445/445 with 200 seeds,
  all 13 reaches; stock-on 42/36/36/36; strict-on 157. Commands, exits 0 and source
  `1bf62be` are recorded in that entry. These are not the final chosen-source checks.
- [verified] `git fetch origin` and `git merge origin/main`: main is still `980658b`,
  already up to date, exit 0. `git diff --check`: clean, exit 0, before `8ff29b4`.
- [verified] `ps`/`pgrep` (exit 0) show one detached serial coordinator and one benchmark,
  resuming at 5/13/272 V3-on after the same 14 arms. Future survival is not guaranteed.
- [not run] Remaining serial arms/repeats, final C choice, new D proof and final full
  check set. No Luna budget is proposed; no provider request is authorised.

## Decisions

- Continue only a whole earlier request, with identical tools/system items. A shared
  opening reads zero; exact repeats qualify; reusable at dispatch, no chain expiry.
  Reject the superseded shared-prefix/concurrent matrix as selection evidence.
- Current source is provisional V2 from `1bf62be`. Its former 20/20 versus V3 19/20
  choice is withdrawn pending corrected evidence. If none qualifies, restore original
  V3 from `eea33a3`; keeping this interim V2 would violate the maintainer's fallback.
- Run main/V1/V2/V3 sequentially, each on then off, on an otherwise idle machine.
  Repeat the whole eight-arm cell once if any variant differs from main by one served
  boundary. C allows +2 s total over the own control and a genuinely cold first U8 wait;
  all observed runs count. Prefer V1, then V2, then V3, except the stated two-cell
  service improvement with no loss. Exact C/D rules are in the validation entry.

## Read first

1. `AGENTS.md` and the handoff protocol.
2. Only the first validation entry: semantics, serial protocol/provenance/results,
   decision/budget rules, checks so far. Later WP5 entries only for cache evidence.
3. Plan Decisions U3/U8 and current core specification's segment scheduling/wait rules.
4. Before D: `docs/context-memory/openai-api.md`, “Prompt cache”; the validation entry
   preserves the addendum's exact forwarding/proof requirements.

## Settled

- U8, timer removal, task delay and one session per chain were accepted. No timer,
  persisted estimate or spending-cap change.
- P5 has eight batches in the large run, 46 tool results (43 through cut 4).
- Simulated segment cache shares do not match Luna's recorded 100%; report the
  discrepancy. Writer shares match the recorded 95-97%; do not tune toward 100%.
- No-cache/zero-delay results remain labelled historical context, not headline evidence.

## Next steps

1. `git fetch origin refs/heads/main:refs/remotes/origin/main refs/heads/codex/segments-p5-offline:refs/remotes/origin/codex/segments-p5-offline`;
   compare `git log --oneline 8ff29b4..origin/codex/segments-p5-offline` and PR draft state.
   Collection may add validation-only commits after this handoff; read those first.
2. Inspect the published serial-results status before starting another measurement.
   The collector publishes content-free rows between cells. Do not run tests/builds/
   another benchmark on its machine while it measures.
   If it stopped, use published rows as completed evidence and reconstruct only missing
   arms from the recipe/digests/command grid in validation. Never fabricate a repeat.
3. Once all cells and required repeats exist, apply C, align all requested files, then
   apply D. Only if D holds, build the new proxy and prove it with fake upstreams;
   the earlier per-writer warm-up prototype was superseded and removed. No live calls.
4. Run all requested final checks, record commands/counts/exits in the same validation
   entry, rewrite the PR, delete this file last, and push normally.

## Previous handoff check

- Missing: none
- Repeated: none
- Wrong: none
- Unused: none
