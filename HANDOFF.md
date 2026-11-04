---
branch: claude/determined-carson-h13gug
pr: 118
head: 66c4ce5
written: 2026-11-04, Claude Code, cloud
---

# Handoff: 0.8.0 option (b), the bounded tail and Luna's rerun

## Goal and done-when

The maintainer chose option (b) of the previous handoff on 2026-11-04: fix before releasing, bound how much history a
segments boundary keeps verbatim, then measure again on a new budget, **GPT-6 Luna only, no DeepSeek**. Done when the
provider rerun has run within an approved budget and its result is recorded, and the maintainer has decided how 0.8.0
ships.

## State

- [verified] The bound is in `1a2468c`: `node scripts/context-memory-ops.mjs verify`, exit 0 (context-memory check
  722 tests, security regression check passed); core tests 210 of 210. The new regression failed on `25df0d2`'s
  controller (2 writer requests where 3 were expected), and the wait regression fails with `tail` out of U8's wait set.
- [verified] `node scripts/context-memory-ops.mjs preview` at `b7aef09`, exit 0, package
  `stock-preview+src.ef16bf86bac1ed9b`; with `--segments on` acceptance and strict scenarios pass the same counts.
  1,000 fuzz seeds pass. Counts: `validation.md`, "0.8.0 WP5 follow-up".
- [verified] The cost: the fuzz's segments boundaries fall from 427 to 112 in 1,000 seeds.
- [verified] P5's loopback replay is unchanged by the bound and does not reproduce WP5's overflow, so only a provider
  run tests the fix.
- [verified] `curl https://api.openai.com/v1/models` returned 200 on 2026-11-04: the network secret is attached.
- [inferred] The all-boundary pause gate stays unmet on P5, since WP5's first and third reasons are untouched.
- [not run] Any provider request. Nothing was versioned, tagged or published.

## Decisions

- The bound is one range, `segmentRangeTokens` of Pi's trigger (U3), measured on the retained originals as the context
  estimate counts them. Rejected: two ranges, because on P5's 200k route a 45,000-token tail still leaves the 86,000-token
  paste past the 180,000 window (about 50k start, 55k of growth, then the paste); Pi's `keepRecentTokens` (20,000),
  because it is a host setting rather than the segments' own scale; a smaller share in `commitPrefix`, because that
  bounds note, system prompt and tail together and its fallback would read as `fit`. U7 is amended in the plan's
  Decisions table.
- `tail` joins `fit`, `cut` and `in-flight` as a refusal U8's wait may resolve: a segment in flight that extends the
  chain shortens the tail.
- The fuzz's CI default rose from 40 to 100 seeds, and `fallback tail` joined its reach list. Seeds 1 to 40 no longer
  reach a merge after U8's wait (seed 31's only one now leaves a 17,134-token turn, past the 16,742 range); 100 reach 3.
- The arm-A prefix path (share 0.8) and arm B's notes path (0.5) keep their bounds. Both are off by default, and the
  maintainer asked for segments only.

## Read first

`validation.md` "0.8.0 WP5 follow-up" and "0.8.0 WP5"; the plan's WP5 "Follow-up" and U7; `eval/preview/README.md`
"Runner", `--replay`; `openai-api.md` for the key and the 272k line.

## Settled

- U5, U6 and U12, as the previous handoff said: recorded in the plan.
- DeepSeek is out of the rerun: the maintainer's instruction of 2026-11-04.

## Next steps

1. The maintainer approves, changes or declines the budget proposed in PR #118's description: Luna only, at most
   1,000 requests, 240 minutes and $5, every request below 272,000 input tokens, one run at a time. Five cells, a
   control and a segments run each, in this order: `medium` 200k, `medium` 272k, `max` 272k, then a second `medium`
   chain on each route.
   Stop on any limit, and at once if a segments chain blocks a session; a failed gate is reported, not rerun.
2. On approval, record it in the plan's WP5 follow-up, then run each arm as WP5 did, from `eval/preview/README.md`
   "Runner": `--package-dir .artifacts/context-memory-preview-package --stock-root
   .artifacts/context-memory-preview-stock --mode probes --provider openai --fixtures P5 --cache session --replay --pace immediate
   --probe-conditions history --chain-attempts 4 --unit-minutes 30 --max-input-tokens 272000`, with `--cuts 1,3,5
   --window 180000` or `--cuts 2,4 --window 240000`, `--reserve 30000`, `--thinking medium|max`,
   `--session-settings previewSegments=off|on`, and the budget left as `--max-requests`, `--max-minutes`,
   `--max-cost-usd`.
3. Record the result in `validation.md`, then ask the maintainer how 0.8.0 ships. For a release, the previous
   handoff's steps for option (a) apply: `git log -p -- HANDOFF.md`.

## Previous handoff check

- Missing: the code site of option (b), `commitPrefix(segmentsNote, end, 0.5)` in `preview/controller.ts`, and that the
  synchronous control keeps no tail (`keepRecentTokens` 0). Both took a few searches.
- Repeated: none.
- Wrong: none. #114 is in `main` as `b99714c` and #118 was open, as stated.
- Unused: `extension-preview.md` "Maintainer publication", needed only for option (a).
