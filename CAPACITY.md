# Session-writer capacity at Pi's trigger

2026-11-04. Branch `codex/segments-p5-capacity`, based on
`origin/codex/segments-p5-offline` at `a8d165fdd0baf51a10fa0cb99d9de6a06eab5ebe`.
The implementation and tests are committed in
`e23a4f97eeb160be3567ad5e3108783c0313b1ae`. No model provider was called.
The coordinator's branch and PR #119 were not changed.

## Finding: the reserve has to cover the batch as well as the writer

Let `W` be the window, `R` Pi's reserve, `B` the batch overshoot, `O` the
writer's output reservation and `I` its smallest handover instruction. At a
boundary reached at `W - R + B`, a session handover fits only if
`O + I + B <= R`. A larger window with the same reserve does not remove this
risk. Early gold cuts in an off control do not test this condition.

The output reservation is `min(model.maxTokens, max(4096, 2 * hardNoteTokens))`,
including the model's reasoning output. The focused cases select a 5,000-token
hard note budget and reserve 10,000 output tokens. `I` below already uses the
smallest instruction: bare citation IDs and no quotable-original block. It
still carries the rules, previous note and referenced evidence.

P5's largest recorded result batch (`p5-00019`'s call) contains 67,059 ASCII
characters/bytes: 22,353 tokens under the loopback's bytes/3 metric, or 16,765
under Pi's unmeasured characters/4 estimate. Assistant output, tool wrappers
and other framing add to that body-only overshoot; the table is a lower bound.
Provider-reported usage need not match either estimate.

The focused test drives two checkpoints on each specified route. Its on arm
first commits a segment chain through `r3`, retains the complete later `a4`
tool batch, confirms disk readback, then reaches the next boundary without a
covering segment. The off arm first commits synchronously. Both then present
Pi's trigger plus one P5-sized batch to the writer preflight.

| Route / segments | Window | Pi trigger | Prefix at boundary | Output `O` | Instruction `I` | Batch `B` | Reserve needed | Deficit against 30,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 200k / off | 180,000 | 150,000 | 172,353 | 10,000 | 2,287 | 22,353 | 34,640 | 4,640 |
| 200k / on, after segment commit | 180,000 | 150,000 | 172,353 | 10,000 | 3,751 | 22,353 | 36,104 | 6,104 |
| 272k / off | 240,000 | 210,000 | 232,353 | 10,000 | 2,287 | 22,353 | 34,640 | 4,640 |
| 272k / on, after segment commit | 240,000 | 210,000 | 232,353 | 10,000 | 3,751 | 22,353 | 36,104 | 6,104 |

These are synthetic lifecycle cases, not measurements of Luna's instruction
tokens. With only the smaller characters/4 batch estimate, the same off case
needs 29,052 tokens (948 spare) and the on case needs 30,516 (516 short).
Neither configuration has a general capacity guarantee from a 30,000 reserve.
The previous note and its referenced evidence can increase the instruction;
the largest supported hard note budget also raises output reservation to 16,000.

## Fix and its scope

The core selects bounded evidence requests **before dispatch** when none of
the existing session handover forms fits. It uses the already selected
transport, model and effort; it does not resolve a different writer, catch a
provider failure or retry a failed writer through another path. This reuses
the existing sequential chunk implementation, renamed `writeInChunks`.

Every original source part keeps its ID, offset and full text. Chunks carry
the preceding note and referenced originals. They share the frozen note
budget, validator, one repair allowance and call journal. Each request checks
its evidence, instruction and output against the window before dispatch.
Source chunks are bounded independently of the full session prefix, so a
larger batch or retained tail cannot consume the chunk request's headroom on
these routes. A provider refusal or invalid note still blocks the session.
This path can make more calls and lose the session prefix cache; no provider
cost or quality result is claimed.

The normal handover, including one that fits exactly, is unchanged. Optional
segment calls keep their existing capacity refusal. No segment scheduling,
wait, cut, retained-tail rule, reserve or configuration switch changed.
Checkpoint format, source hashes, resident fingerprint, versions and the
evaluation pin are unchanged. `docs/context-memory/validation.md` is untouched.

**Grid remeasurement: none for this fix.** It changes no existing served
boundary and no fitting synchronous control request. The old grid did not
exercise the newly handled capacity refusal. This branch keeps provisional
V2 and does not make the coordinator's pending variant selection. The
reported Luna 200k/on failure needs a future authorised provider rerun; none
was attempted here.

## Regression and loopback reach

Final regression title:
`compacts at Pi's trigger plus a P5 batch: window %i, segments %s` in
`packages/coding-agent/test/context-memory-preview.test.ts`.
With only `packages/compaction-core/src/writer.ts` restored to its base bytes,
all four final cases fail with `CONTEXT_WRITER_CAPACITY`, exit 1. Restoring the
fix makes all four pass, exit 0, with final coverage/source hashes, paired
retained tools and disk-confirmed readiness checked. The core also checks
exact-fit preservation, lossless multi-chunk evidence (including Unicode),
unchanged segment refusal, writer identity/accounting and no path change
after a dispatched writer fails.

The existing stock-Pi loopback bench was tried on the base package:

```sh
node scripts/context-memory-preview-bench.mjs \
  --package-dir work/capacity/before/package \
  --stock-root work/capacity/stock-1.4.0 --output-dir work/capacity/bench-before \
  --mode probes --provider loopback --fixtures P5 --cache session \
  --replay --replay-tools --pace immediate --cuts 1,3,5 \
  --window 180000 --reserve 30000 --compactions-only \
  --latency-ms 40000 --turn-latency-ms 10000 --thinking medium \
  --session-settings previewSegments=on --chain-attempts 1 --unit-minutes 25 \
  --label capacity-before-40-10-200k
```

Exit 0; one SDK session; all recorded tools replayed exactly; 61 task, nine
segment and zero synchronous writer calls; three committed boundaries, no
failed boundary or rate-limit error. Boundary tokens/paths were
137,535/segments, 154,418/segments and 141,563/segments. The second waited
9,887 ms for coverage. Its counterfactual synchronous preflight needs 10,000
output + 5,042 instruction tokens and would still leave 10,540 tokens spare.
Thus this run cannot reproduce the reported provider capacity refusal, even
if that boundary had not been served. Fixed latency, loopback token counts
and deterministic gold notes do not reproduce Luna's timing/token pressure.
Other checks ran during this reach probe; its pause timings are not serial
grid selection evidence.

A second base-package experiment used the same bench with `--cuts 5`,
`previewSegments=off`, no delay flags, `--unit-minutes 5`, output
`work/capacity/trigger-before`, label `capacity-trigger-before`, to avoid
early planned cuts. Exit 0 at the harness level, but the chain did not finish:
one auto checkpoint at 153,903 tokens, then `CONTEXT_INPUT_TOO_LARGE` and a
manual retry refused with `CONTEXT_NOTE_SCOPE`. This is not a capacity
reproduction or a passing chain. Neither attempted stock-loopback run
exercised `CONTEXT_WRITER_CAPACITY`; the negative/positive reproduction is
the focused four-case test above. No provider replay result is inferred.

## Commands and verification

Node 24.19.0; official npm Pi 1.4.0, isolated and unpatched. All commands below
are offline/scripted apart from dependency/Git downloads. Scratch outputs
are under `work/capacity`; the commands are from the repository root unless
the coding-agent working directory is stated. Runtime checks bind to
`e23a4f9`; this document is added afterwards.

| Command | Result / counts | Exit |
| --- | --- | ---: |
| `node scripts/context-memory-ops.mjs deps` | Lockfile dependencies installed with scripts ignored | 0 |
| `node scripts/context-memory-ops.mjs verify` | Build, TypeScript/format/import checks, core isolation/conformance, 731 focused runtime tests, security checks | 0 |
| `PI_OFFLINE=1 node node_modules/vitest/dist/cli.js run packages/compaction-core/test` | 224/224; 34 base + 35 segment vectors, conformance `.3` | 0 |
| Coding-agent: `PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js run test/context-memory-preview.test.ts -t "compacts at Pi's trigger plus a P5 batch"` | Base core: four capacity failures, 244 skipped; fixed core: 4/4, 244 skipped | 1 / 0 |
| Coding-agent: `PI_OFFLINE=1 CONTEXT_MEMORY_FUZZ_SEEDS=200 CONTEXT_MEMORY_FUZZ_REPORT=<report.json> node ../../node_modules/vitest/dist/cli.js run test/context-memory-preview.test.ts test/context-memory-preview-fuzz.test.ts` | 449/449 = 248 focused + 201 fuzz; 200 seeds × 48 operations = 9,600; all 13 required reaches | 0 |
| `node --test scripts/context-memory-preview-bench.test.mjs` | 10/10 | 0 |
| `node scripts/context-memory-preview-build.mjs --output-dir work/capacity/before/package` | Base V2 package, same source/bundle hashes as Machine B | 0 |
| `node scripts/context-memory-preview-stock-install.mjs --stock-root work/capacity/stock-1.4.0 --version 1.4.0` | Exact official cohort; network-blocked SDK startup | 0 |
| `node scripts/context-memory-ops.mjs preview` | Clean-source build; stock off 42/36/36/36 on Pi 1.4/1.3/1.2/1.1; 157 strict scenarios; release checks and local prepare only | 0 |
| Stock-on acceptance command below | Pi 1.4.0: 42/42, including three compatible-host round trips; official host bytes unchanged | 0 |
| Strict-on scenario command below | 157/157; zero failures, gaps, skips or performance exceptions; raw gate passed | 0 |
| `git diff --check` | Clean | 0 |

An earlier `verify` stopped at a TypeScript narrowing error in the edited
quote test (exit 1); it was corrected before the passing final run. The first
`preview` passed its acceptance/scenarios but stopped at local prepare because
it had built before the implementation was committed (`sourceCommit: null`,
exit 1). The clean-source `preview` above passed every step. No gate was
bypassed and no new resident fingerprint was committed.

```sh
node scripts/context-memory-preview-acceptance.mjs \
  --package-dir .artifacts/context-memory-preview-package \
  --stock-root .artifacts/context-memory-preview-stock \
  --compatible-stock-root .artifacts/context-memory-preview-stock-1.3.0 \
  --compatible-stock-root .artifacts/context-memory-preview-stock-1.2.0 \
  --compatible-stock-root .artifacts/context-memory-preview-stock-1.1.0 \
  --segments on --output-dir work/capacity/stock-on

node scripts/context-memory-preview-scenarios.mjs \
  --package-dir .artifacts/context-memory-preview-package \
  --stock-root .artifacts/context-memory-preview-stock \
  --other-stock-root .artifacts/context-memory-preview-stock-1.0.4 \
  --segments on --acceptance-profile strict --output-dir work/capacity/strict-on
```

Required fuzz reaches, from the final 200-seed report:

| Reach | Count |
| --- | ---: |
| Segments path | 18 |
| Synchronous path | 597 |
| Failed compaction | 144 |
| Ruling replacement by merge | 11 |
| Merge after waiting | 1 |
| Skipped segment wait | 8 |
| Custom-focus fallback | 51 |
| Tail fallback | 50 |
| Hanging segment | 42 |
| Hanging compaction | 25 |
| Breaker open | 141 |
| Branch moved before checkpoint | 128 |
| Restart dropped ready segments | 42 |

The report also reached both writer error/length/tool-call classes, in-flight,
no-segments, unfinished-turn and instruction-superseded fallbacks, manual
compaction and `makeRoom` compaction.

## Artifact identities

| Package | Source SHA-256 | Bundle SHA-256 |
| --- | --- | --- |
| Base V2, `a8d165f` runtime | `54b54e481662267f095a5855187de487894ea02142926eba9e3842ca9085ad1a` | `acc6da2caf014554f5d9a7ee90dd51824e21f07169efc28e2535e08813719415` |
| Fixed, clean `e23a4f9` | `7c815afa75319b7b3561d024ccbab32f322af56b1963bb500d86b35727c9a505` | `310fd964e232e5cff0ed2dcd883b2408c54d7ad78f0541f929bffc1dc28cfa68` |
