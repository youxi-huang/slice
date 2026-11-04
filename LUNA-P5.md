# P5 on GPT-6 Luna through the provider replay mode, 2026-11-04 UTC

Provider evidence for PR #119, reported apart from the simulated grid. Approved by the maintainer before the first
request: at most four chains, each at most 120 requests, 25 minutes, US$1 and 270,000 input tokens per request,
stopping at the first 4xx or rate-limit error. Spent: US$0.39 in 232 requests. No 4xx, no rate-limit error.

- Bench: `codex/segments-p5-provider` at `69d0ed0` (provider replay: every task, writer and segment body forwarded
  unchanged; task output capped at 16 tokens and discarded; the recorded reply released after upstream completion
  and the 10 s turn delay). Official Pi 1.4.0. Package: V2, build `stock-preview+src.54b54e481662267f`, bundle
  SHA-256 `acc6da2c…` (the runtime committed at `1bf62be`).
- Luna is the writer and segment model at its real latency; `--latency-ms` is not used. Thinking `medium`.
- Command per chain, with `--session-settings previewSegments=on|off` and the route's cuts and window:
  `node scripts/context-memory-preview-bench.mjs --package-dir <v2>/package --stock-root <official-pi-1.4.0> --output-dir <out> --mode probes --provider openai --fixtures P5 --cache session --replay --replay-tools --pace immediate --cuts <1,3,5|2,4> --window <180000|240000> --reserve 30000 --compactions-only --turn-latency-ms 10000 --thinking medium --session-settings previewSegments=<on|off> --chain-attempts 1 --unit-minutes 25 --max-requests 120 --max-minutes 25 --max-cost-usd 1 --max-input-tokens 270000 --label <label>`
- Raw metrics per chain under `luna-p5/`: `summary.json`, `boundaries.jsonl`, `rounds.jsonl`. No notes, session
  content, headers or local paths. Every tool result replayed exactly where the chain reached it.

| Chain | Route | Segments | Boundaries | Paths | Total pause (s) | Requests T/S/W | Peak 60 s input | Cost (US$) |
| --- | --- | --- | --- | --- | ---: | --- | ---: | ---: |
| `luna-smoke-10-200k-v2-on` | 200k | on | 1 committed, then 2 failed | segments 1 | 0.048 | 41/5/0 | 840,582 | 0.0809 |
| `luna-control-10-200k-v2-off` | 200k | off | 3/3 | sync 3 | 51.382 | 61/0/3 | 829,989 | 0.0953 |
| `luna-10-272k-v2-on` | 272k | on | 2/2 | sync 1, segments 1 | 19.048 | 56/6/2 | 1,361,452 | 0.1148 |
| `luna-control-10-272k-v2-off` | 272k | off | 2/2 | sync 2 | 37.524 | 56/0/2 | 1,170,524 | 0.0995 |

Observations:

1. **Capacity failure, 200k with segments on.** Cut 1 was served by segments in 48 ms. Cut 3 became Pi's own
   trigger at step 4, in the middle of a tool batch, at 161,175 input tokens. Segments had not covered it: Luna's
   segment calls took 21.6 to 42.7 s in this chain. The synchronous writer refused twice with
   `CONTEXT_WRITER_CAPACITY` ("the session context leaves no room for the handover request") and the chain stopped.
   The segments-off chain reached its planned cuts first, at 146,117, 144,428 and 142,503 tokens, below Pi's
   150,000 trigger, so it never met Pi's own trigger. Whether the synchronous writer fits at Pi's own trigger plus a
   batch, with segments off, is therefore untested here.
2. **Fallback on 272k.** Cut 2 fell back to the writer with `segmentsFallback: ambiguous-supersede` (18.9 s);
   cut 4 was served by segments in 108 ms.
3. **Cache.** Segment calls read 99.9 to 100% of their input from cache and writers 100% (as few as 3 uncached
   input tokens), matching the recorded WP5 shares; the loopback simulation's 83 to 96% is conservative.
4. **Latency.** Writers 13.2 to 20.8 s; segments 15.0 to 42.7 s, longer than the grid's 28 s writer cells.
   Capped task requests took 10.0 to 23.8 s in the first chain and never exceeded the 10 s turn delay afterwards.
5. **Tokens.** Luna counts about 6% more input than the bench's bytes/3 estimate at cut 1 (146,117 against
   137,545) and about 11% more at cut 3 of the control (144,428 against 130,048).
