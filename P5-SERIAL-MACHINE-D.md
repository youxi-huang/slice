# P5 serial cells measured on machine D

Rows for PR #119's serial continuation-cache table. Each cell's eight arms ran serially on this machine alone, in the
protocol's order, with nothing else measured, built or tested during a chain. Run label D<n> is this machine's
n-th run of a cell. No model provider was called. Tools: `p5-tools/` at `ac6388f` on branch claude/confident-thompson-3k0e8p.

- Bench at `d9e4513`; official Pi 1.4.0; Node v24.19.0 on x86_64.
- Packages built by `build-packages.sh`; every `dist/extension.js` SHA-256 matched the recorded digest.
- Every arm exited 0 and replayed its recorded tool results exactly, with no remaining replies or errors.
- `needs-repeat.py` returned `no` (exit 0): main, V1, V2 and V3 each served 2/2 boundaries with segments on; no repeat was required.
- `collect.py` validated all eight arms and exported one completed cell (exit 0).
- Raw metrics per arm are under `p5-serial-d/`; no notes, session content or local paths.

Completed cells: 10-13-272k-r1

| Run | Turn / writer / route | Package / arm | Served | Fallbacks | Wait n; total (P50/P95) | Pause P50/P95; total | Overlap calls / summed input | Peak 60 s input | Calls T/S/W; all input | Cold first wait | Cut: links / uncached spend | Segment / writer cache % | Rate errors |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| D1 | 10 / 13 / 272k | main / on | 2/2 | - | 2; 5.915 (2.925/2.990) | 3.011/3.083; 6.094 | 3 / 1,148,754 | 1,231,789 | 56/3/0; 5,733,317 | - | 2: 2/8,736; 4: 1/5,559 | 97.39 / - | 0 |
| D1 | 10 / 13 / 272k | main / off | 0/2 | - | 0; 0.000 (-/-) | 13.063/13.086; 26.149 | 0 / 0 | 1,079,028 | 56/0/2; 5,596,066 | - | 2: 0/0; 4: 0/0 | - / 96.67 | 0 |
| D1 | 10 / 13 / 272k | v1 / on | 2/2 | - | 2; 5.905 (2.918/2.987) | 2.991/3.054; 6.045 | 3 / 1,148,745 | 1,231,781 | 56/3/0; 5,733,240 | - | 2: 2/8,737; 4: 1/5,560 | 97.39 / - | 0 |
| D1 | 10 / 13 / 272k | v1 / off | 0/2 | - | 0; 0.000 (-/-) | 13.083/13.120; 26.203 | 0 / 0 | 1,079,019 | 56/0/2; 5,595,986 | - | 2: 0/0; 4: 0/0 | - / 96.67 | 0 |
| D1 | 10 / 13 / 272k | v2 / on | 2/2 | - | 0; 0.000 (-/-) | 0.052/0.076; 0.128 | 5 / 2,165,282 | 1,355,862 | 56/5/0; 5,948,992 | - | 2: 3/47,104; 4: 2/26,367 | 90.03 / - | 0 |
| D1 | 10 / 13 / 272k | v2 / off | 0/2 | - | 0; 0.000 (-/-) | 13.076/13.096; 26.172 | 0 / 0 | 1,079,019 | 56/0/2; 5,595,986 | - | 2: 0/0; 4: 0/0 | - / 96.67 | 0 |
| D1 | 10 / 13 / 272k | v3 / on | 2/2 | - | 0; 0.000 (-/-) | 0.048/0.069; 0.117 | 9 / 2,876,384 | 1,355,960 | 56/9/0; 6,188,063 | - | 2: 5/69,390; 4: 4/51,158 | 87.64 / - | 0 |
| D1 | 10 / 13 / 272k | v3 / off | 0/2 | - | 0; 0.000 (-/-) | 13.096/13.102; 26.198 | 0 / 0 | 1,079,019 | 56/0/2; 5,595,986 | - | 2: 0/0; 4: 0/0 | - / 96.67 | 0 |

<details><summary>Per-arm checks</summary>

- 10-13-272k-r1 main-off: 43/43 exact, build stock-preview+src.ef16bf86bac1ed9b
- 10-13-272k-r1 main-on: 43/43 exact, build stock-preview+src.ef16bf86bac1ed9b
- 10-13-272k-r1 v1-off: 43/43 exact, build stock-preview+src.653e1910b005317a
- 10-13-272k-r1 v1-on: 43/43 exact, build stock-preview+src.653e1910b005317a
- 10-13-272k-r1 v2-off: 43/43 exact, build stock-preview+src.54b54e481662267f
- 10-13-272k-r1 v2-on: 43/43 exact, build stock-preview+src.54b54e481662267f
- 10-13-272k-r1 v3-off: 43/43 exact, build stock-preview+src.82625e6ce0676ef9
- 10-13-272k-r1 v3-on: 43/43 exact, build stock-preview+src.82625e6ce0676ef9

</details>
