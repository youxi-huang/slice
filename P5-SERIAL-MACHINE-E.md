# P5 serial cells measured on machine E

Rows for PR #119's serial continuation-cache table. Each cell's eight arms ran serially on this machine alone, in the
protocol's order, with nothing else measured, built or tested during a chain. E2 is the assigned second run of
this cell, following machine B's first run; this machine ran it once. No model provider was called.
Tools: `p5-tools/` on branch claude/confident-thompson-3k0e8p.

- Bench at `d9e4513`; official Pi 1.4.0; Node v24.19.0 on x86_64.
- Packages built by `build-packages.sh`; every `dist/extension.js` SHA-256 matched the recorded digest.
- Every arm exited 0 and replayed its recorded tool results exactly, with no remaining replies or errors.
- Raw metrics per arm are under `p5-serial-e/`; no notes, session content or local paths.
- Measurement tools came from `ac6388f`. Initial collection failed with `KeyError: 'startedAt'` on V2's automatic
  compactions. Collection then used the published `rows.py` fix from `daee684` (fetched at `ede43d2`) and exited 0.
  The measured files were unchanged; no arm was rerun.

Final commands, with local directories replaced by placeholders; each exited 0:

```sh
bash <tools>/build-packages.sh <repo> <work>
bash <tools>/run-cell.sh <work> <stock> codex-e 10000 28000 200k 2
python3 <tools>/collect.py <work> E <dest>
```

Completed cells: 10-28-200k-r2

| Run | Turn / writer / route | Package / arm | Served | Fallbacks | Wait n; total (P50/P95) | Pause P50/P95; total | Overlap calls / summed input | Peak 60 s input | Calls T/S/W; all input | Cold first wait | Cut: links / uncached spend | Segment / writer cache % | Rate errors |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| E2 | 10 / 28 / 200k | main / on | 1/3 | in-flight 2 | 2; 30.002 (15.001/15.001) | 43.052/43.075; 86.219 | 4 / 1,201,667 | 900,711 | 61/4/2; 5,047,845 | 15.001 | 1: 1/4,728; 3: 1/4,861; 5: 1/4,683 + unknown | 96.40 / 96.21 | 0 |
| E2 | 10 / 28 / 200k | main / off | 0/3 | - | 0; 0.000 (-/-) | 28.068/28.088; 84.218 | 0 / 0 | 782,379 | 61/0/3; 4,674,498 | - | 1: 0/0; 3: 0/0; 5: 0/0 | - / 95.55 | 0 |
| E2 | 10 / 28 / 200k | v1 / on | 1/3 | in-flight 2 | 1; 15.001 (15.001/15.001) | 28.061/43.058; 71.185 | 4 / 1,201,655 | 900,700 | 61/4/2; 5,047,758 | 15.001 | 1: 1/4,728; 3: 1/4,860; 5: 1/4,683 + unknown | 96.40 / 96.21 | 0 |
| E2 | 10 / 28 / 200k | v1 / off | 0/3 | - | 0; 0.000 (-/-) | 28.062/28.077; 84.195 | 0 / 0 | 782,371 | 61/0/3; 4,674,409 | - | 1: 0/0; 3: 0/0; 5: 0/0 | - / 95.55 | 0 |
| E2 | 10 / 28 / 200k | v2 / on | 3/3 | - | 0; 0.000 (-/-) | 0.060/0.073; 0.170 | 10 / 4,240,860 | 1,099,769 | 61/10/0; 6,135,637 | - | 1: 2/26,092 + unknown; 3: 3/18,394 + unknown; 5: 3/33,246 | 91.07 / - | 0 |
| E2 | 10 / 28 / 200k | v2 / off | 0/3 | - | 0; 0.000 (-/-) | 28.066/28.070; 84.200 | 0 / 0 | 782,371 | 61/0/3; 4,674,409 | - | 1: 0/0; 3: 0/0; 5: 0/0 | - / 95.55 | 0 |
| E2 | 10 / 28 / 200k | v3 / on | 3/3 | - | 0; 0.000 (-/-) | 0.058/0.069; 0.165 | 14 / 4,709,673 | 1,056,096 | 61/14/0; 5,914,818 | - | 1: 4/62,247; 3: 5/68,031; 5: 4/49,767 + unknown | 83.08 / - | 0 |
| E2 | 10 / 28 / 200k | v3 / off | 0/3 | - | 0; 0.000 (-/-) | 28.081/28.096; 84.253 | 0 / 0 | 782,371 | 61/0/3; 4,674,409 | - | 1: 0/0; 3: 0/0; 5: 0/0 | - / 95.55 | 0 |

<details><summary>Per-arm checks</summary>

- 10-28-200k-r2 main-off: 46/46 exact, build stock-preview+src.ef16bf86bac1ed9b
- 10-28-200k-r2 main-on: 46/46 exact, build stock-preview+src.ef16bf86bac1ed9b
- 10-28-200k-r2 v1-off: 46/46 exact, build stock-preview+src.653e1910b005317a
- 10-28-200k-r2 v1-on: 46/46 exact, build stock-preview+src.653e1910b005317a
- 10-28-200k-r2 v2-off: 46/46 exact, build stock-preview+src.54b54e481662267f
- 10-28-200k-r2 v2-on: 46/46 exact, build stock-preview+src.54b54e481662267f
- 10-28-200k-r2 v3-off: 46/46 exact, build stock-preview+src.82625e6ce0676ef9
- 10-28-200k-r2 v3-on: 46/46 exact, build stock-preview+src.82625e6ce0676ef9

</details>
