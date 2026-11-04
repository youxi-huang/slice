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

## Rerun on V2 with the capacity fix, 2026-11-04 UTC

The same four chains on the same terms, approved by the maintainer before the first request with the same limits.
Spent: US$0.46 in 261 requests over 45.6 minutes. No 4xx, no rate-limit error.

- Package: V2 with the capacity fix, PR #119 at `e758e11`, build `stock-preview+src.7c815afa75319b7b`, bundle
  SHA-256 `310fd964…`. Bench, command and fixture as above; labels `luna-10-<route>-v2fix-<on|off>`.
- Raw metrics under `luna-p5/luna-10-*-v2fix-*/`, the same three files per chain.

| Chain | Route | Segments | Boundaries | Paths | Total pause (s) | Requests T/S/W | Peak 60 s input | Cost (US$) |
| --- | --- | --- | --- | --- | ---: | --- | ---: | ---: |
| `luna-10-200k-v2fix-on` | 200k | on | 3/3, one refused attempt before cut 3 | segments 1, sync 2 | 169.084 | 61/5/11 | 986,587 | 0.1509 |
| `luna-10-200k-v2fix-off` | 200k | off | 3/3 | sync 3 | 60.436 | 61/0/3 | 829,994 | 0.0963 |
| `luna-10-272k-v2fix-on` | 272k | on | 2/2 | sync 2 | 43.656 | 56/4/2 | 1,361,051 | 0.1114 |
| `luna-10-272k-v2fix-off` | 272k | off | 2/2 | sync 2 | 49.668 | 56/0/2 | 1,170,526 | 0.0997 |

Observations:

1. **The block is gone; the chunked writer is slow and failed once.** Cut 1 was served by segments in 45 ms. Cut 3
   again became Pi's own trigger at step 4, and no handover form fitted, so the writer read the evidence in bounded
   chunks. The automatic attempt wrote three chunks in 55.6 s and its note failed validation with
   `CONTEXT_NOTE_INVALID`, a schema fault outside the repairable classes, so it stopped there. The retry
   (`instruction-superseded`) committed through seven chunks in 143.1 s at 161,242 tokens: 25,849 to 35,274 input
   tokens and 18.1 to 23.3 s per call, none from the cache. From the first chunk to the commit, the session waited
   198.8 s; the bench's pause counts only the committed attempt. Cut 5 went to the writer after
   `ambiguous-supersede`, 25.9 s, nearly all from the cache.
2. **What that compaction cost.** The ten chunk calls read 322,054 uncached input tokens for US$0.044, against
   US$0.011 for all three of the control's writers, which read from the cache.
3. **272k with segments on.** Both cuts went to the writer after `ambiguous-supersede`, 15.0 and 28.6 s, and the
   four segment calls were discarded. In the first run the merge served cut 4 in 108 ms; the fix touches neither
   the merge nor the segments, so the difference comes from what Luna wrote in each run.
4. **Controls.** 200k: 17.5, 23.0 and 20.0 s (51.4 s in all before, 60.4 s now). 272k: 26.7 and 23.0 s (37.5 s
   before, 49.7 s now). Every control writer read its input from the cache.

## Recovery check on V2 with the capacity fix, 2026-11-04 UTC

The maintainer chose to ship 0.8.0 with segments off by default and asked first for a small recovery check on Luna,
within US$5. The same four chains as the rerun, now with P5's probes, each answered on its own copy of the chain at
its checkpoint with only `context_history` active. Per chain at most 250 requests, 45 minutes, US$1.20 and 270,000
input tokens per request. Spent: US$0.62 in 614 requests over 80.2 minutes. No 4xx, no rate-limit error. Other
offline checks ran on the same machine during the first chain; its pauses are not timing evidence.

- Command as above, without `--compactions-only`, plus `--probe-conditions history --chain-attempts 4
  --unit-minutes 30` and the limits above; labels `luna-probes-<route>-v2fix-<on|off>`.
- Raw metrics under `luna-p5/luna-probes-*/`, the same three files per chain; the probe scores are in
  `summary.json` under `probes`. No answers, notes or session content.

| Chain | Route | Segments | Boundaries | Paths | Total pause (s) | Probes passed (wrong, blocked, invalid) | Superseded values | Requests | Cost (US$) |
| --- | --- | --- | --- | --- | ---: | --- | --- | ---: | ---: |
| `luna-probes-200k-v2fix-on` | 200k | on | 3/3 | segments 1, sync 2 | 178.129 | 28 of 30 (0, 0, 2) | 3 of 3 | 185 | 0.2527 |
| `luna-probes-200k-v2fix-off` | 200k | off | 3/3 | sync 3 | 58.729 | 29 of 30 (0, 0, 1) | 3 of 3 | 169 | 0.1198 |
| `luna-probes-272k-v2fix-on` | 272k | on | 2/2 | sync 2 | 40.782 | 19 of 19 (0, 0, 0) | 2 of 2 | 137 | 0.1305 |
| `luna-probes-272k-v2fix-off` | 272k | off | 2/2 | sync 2 | 52.095 | 18 of 19 (0, 0, 1) | 2 of 2 | 123 | 0.1139 |

Observations:

1. **Recovery holds, on a small sample.** Both arms passed 47 of 49 probes, with no wrong answer, no blocked probe
   and no fabrication; every superseded value and every answer whose source crossed an earlier checkpoint was right.
   Segments answered 43 from the records and 4 as correct unknowns, the controls 42 and 5. The misses are answers
   without a valid answer object. One chain per cell cannot show a difference smaller than that.
2. **The chunked path again, and this time first time.** On 200k with segments on, cut 3 came at Pi's own trigger
   at step 4 again, and the writer committed through seven chunks in 154.7 s (18.1 to 26.7 s per call, none from
   the cache) with no refused attempt. Across the two runs it has now committed twice and been refused once.
3. **Segments served one boundary of five.** Cut 1 on 200k merged in 50 ms. Every other segments boundary went to
   the writer after `ambiguous-supersede`, both 272k cuts included, as in the rerun.
