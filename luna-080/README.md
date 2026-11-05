# Raw metrics: 0.8.0 on GPT-6 Luna, 2026-11-05 UTC

Content-free per-chain metrics behind the validation entry "0.8.0 on GPT-6 Luna: `max` on both routes, more
`medium` chains, and an invented citation that blocked a session". Each directory holds `summary.json`,
`boundaries.jsonl`, `compactions.jsonl`, `rounds.jsonl` and `probes.jsonl` as the preview bench wrote them: counts,
timings, entry IDs and usage, no note text, no answers and no session copies. The next commit removes this directory,
so that `main` does not carry it.

Package `slice-pi@0.8.0`, `stock-preview+src.7c815afa75319b7b`, on official Pi 1.4.0. Every chain:

```sh
node scripts/context-memory-preview-bench.mjs --package-dir <slice-pi-0.8.0> --stock-root <official-pi-1.4.0> \
  --output-dir <scratch> --mode probes --provider openai --fixtures P5 --cache session --replay --replay-tools \
  --pace immediate --turn-latency-ms 10000 --cuts <1,3,5|2,4> --window <180000|240000> --reserve 30000 \
  --thinking <max|medium> --session-settings previewSegments=<on|off> --chain-attempts 4 \
  --unit-minutes <45|30> --probe-conditions history --max-requests <cap> --max-minutes <cap> \
  --max-cost-usd <cap> --max-input-tokens 270000 --label <label>
```

| Label | Thinking | Route | Segments | Note |
| --- | --- | --- | --- | --- |
| `luna-b-3-200k-r16k-off` | `medium` | 200k at a 160,000 window, reserve 16,384, `--compactions-only` | off | the cancelled first item |
| `luna-c-<route>-max-<on\|off>` | `max` | as named | as named | one chain per cell |
| `luna-a-<n>-<route>-<on\|off>` | `medium` | as named | as named | chains 2 to 4 of each cell; `n` is the chain less one |
| `luna-a-3-200k-on` | `medium` | 200k | on | broke on an upstream failure before cut 1 |
| `luna-a-3r-200k-on` | `medium` | 200k | on | its rerun, counted as chain 4 |
