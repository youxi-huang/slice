# Provider mode: D, offline proof

Based on `cf18cb9` of PR [#119](https://github.com/youxi-huang/slice/pull/119).
Implementation: `cc1aa02` (initial work `87e7c48`). This session implements D
independently of C, as the kickoff authorises. No measurement arms or provider
calls ran; no budget is proposed.
`HANDOFF.md`, the validation entry, scheduling, fingerprints and evaluation pin remain unchanged.

The existing `--replay --replay-tools --cache session --pace immediate` accepts
`--provider openai|relay|deepseek`. `--turn-latency-ms` also applies to these task
replies; `--latency-ms` remains loopback-only. Existing provider limits are still required.

The shared repair forward path uses `configureHttpDispatcher()` and checked
`127.0.0.1` catalog relocation. Every task/writer/segment body and its own
Authorization header pass unchanged; no header is logged or retained. Tasks cap
output before Pi serialises it (Responses 16, Chat Completions 1), discard the
upstream answer, then release the recorded reply after upstream completion and
the turn delay. Local Luna replies use Responses; recorded reasoning and native
`fc_` IDs do not enter subsequent task, writer or segment requests. All forwarded
calls count, including cached input; missing usage is explicit. Disconnects abort
upstream, every request times out, and errors/limits stop later forwarding.

Checks on Node 24.19.0; code checks use `cc1aa02` unless another source is shown:

| Command | Counts / result | Exit |
| --- | --- | ---: |
| `node scripts/context-memory-ops.mjs deps` | dependencies installed | 0 |
| `node scripts/context-memory-preview-stock-install.mjs --stock-root .artifacts/context-memory-preview-stock --version 1.4.0` | 7 exact official runtime packages; network-blocked SDK startup | 0 |
| `node --test scripts/context-memory-preview-provider-proof.mjs scripts/context-memory-preview-bench.test.mjs` | 27/27: 17 proof + 10 bench; 0 skips | 0 |
| `node scripts/context-memory-ops.mjs verify` | core 221 + isolated 221; adapters 39; runtime 727; scripts 167; security 461, all passed | 0 |
| `node scripts/context-memory-ops.mjs preview` at `87e7c48` | stock 1.4/1.3/1.2/1.1: 42/36/36/36; strict scenarios 157; release checks 37; local prepare passed | 0 |
| `node scripts/context-memory-ops.mjs preview` at `cc1aa02` | stock 42/36/36/36; strict scenarios 156/157, bounded-growth timing failed; later release steps not run | 1 |
| `git diff --check` | clean | 0 |

The rerun's timing guard compared overhead of 0 ms at 10 checkpoints with 16 ms
at 20; the 50 ms per-request guard passed. No runtime, timing test or threshold
was changed for this result. The two work commits differ only in the forwarding
helper and proof. D's separate offline proof passes; no further measurements ran.

The proof uses only loopback fake upstreams and synthetic keys. Official Pi 1.4.0
builds both Responses and Chat Completions requests: two tasks, one writer and one
segment per API. Fakes compare bytes with Pi's serialised bodies and check each
request's own header. Subsequent requests preserve the session prefix, tool-call
pairs and recorded results without native function item IDs or reasoning; local
message IDs are unique. Other cases cover completion/delay ordering,
disconnect/timeout before and after headers,
HTTP 401/429, rate errors inside HTTP 200, truncation and in-chain limits.
The initial `node --test scripts/context-memory-preview-bench.test.mjs` exited 1
(dependencies absent); after `deps`, it passed 10/10. The final combined command passed 27/27.

Previous handoff check: Missing: the kickoff supplies the narrower D-only scope
and separate branch. Repeated: none. Wrong: none; the fetched handoff history and
open draft PR matched. Unused: C/serial collection steps and scheduling review.
