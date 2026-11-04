# P5 serial cells measured on machine C

Rows for PR #119's serial continuation-cache table. Each cell's eight arms ran serially on this machine alone, in the
protocol's order, with nothing else measured, built or tested during a chain. Run label C<n> is this machine's
n-th run of a cell. No model provider was called. Tools: `p5-tools/` on branch claude/confident-thompson-3k0e8p.

- Bench at `d9e4513`; official Pi 1.4.0; Node v24.19.0 on x86_64.
- Packages built by `build-packages.sh`; every `dist/extension.js` SHA-256 matched the recorded digest.
- Every arm exited 0 and replayed its recorded tool results exactly, with no remaining replies or errors.
- Raw metrics per arm are under `p5-serial-c/`; no notes, session content or local paths.

Completed cells: 10-13-200k-r1

| Run | Turn / writer / route | Package / arm | Served | Fallbacks | Wait n; total (P50/P95) | Pause P50/P95; total | Overlap calls / summed input | Peak 60 s input | Calls T/S/W; all input | Cold first wait | Cut: links / uncached spend | Segment / writer cache % | Rate errors |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| C1 | 10 / 13 / 200k | main / on | 3/3 | - | 2; 5.939 (2.954/2.985) | 3.005/3.018; 6.082 | 4 / 1,092,326 | 899,514 | 61/4/0; 4,766,161 | 2.985 | 1: 1/4,727; 3: 1/4,891; 5: 1/4,608 + unknown | 96.45 / - | 0 |
| C1 | 10 / 13 / 200k | main / off | 0/3 | - | 0; 0.000 (-/-) | 13.074/13.104; 39.241 | 0 / 0 | 782,375 | 61/0/3; 4,674,453 | - | 1: 0/0; 3: 0/0; 5: 0/0 | - / 95.55 | 0 |
| C1 | 10 / 13 / 200k | v1 / on | 3/3 | - | 2; 5.921 (2.951/2.970) | 3.002/3.003; 6.066 | 4 / 1,092,314 | 899,504 | 61/4/0; 4,766,072 | 2.970 | 1: 1/4,728; 3: 1/4,892; 5: 1/4,609 + unknown | 96.45 / - | 0 |
| C1 | 10 / 13 / 200k | v1 / off | 0/3 | - | 0; 0.000 (-/-) | 13.067/13.069; 39.195 | 0 / 0 | 782,367 | 61/0/3; 4,674,370 | - | 1: 0/0; 3: 0/0; 5: 0/0 | - / 95.55 | 0 |
| C1 | 10 / 13 / 200k | v2 / on | 3/3 | - | 0; 0.000 (-/-) | 0.056/0.056; 0.142 | 8 / 2,600,102 | 1,000,256 | 61/8/0; 5,132,234 | - | 1: 3/36,099; 3: 3/25,259; 5: 2/29,523 | 89.68 / - | 0 |
| C1 | 10 / 13 / 200k | v2 / off | 0/3 | - | 0; 0.000 (-/-) | 13.093/13.100; 39.244 | 0 / 0 | 782,367 | 61/0/3; 4,674,370 | - | 1: 0/0; 3: 0/0; 5: 0/0 | - / 95.55 | 0 |
| C1 | 10 / 13 / 200k | v3 / on | 3/3 | - | 0; 0.000 (-/-) | 0.060/0.089; 0.188 | 14 / 3,549,802 | 1,056,094 | 61/14/0; 5,914,772 | - | 1: 4/62,245; 3: 5/68,032; 5: 5/69,702 | 83.37 / - | 0 |
| C1 | 10 / 13 / 200k | v3 / off | 0/3 | - | 0; 0.000 (-/-) | 13.109/13.111; 39.290 | 0 / 0 | 782,367 | 61/0/3; 4,674,370 | - | 1: 0/0; 3: 0/0; 5: 0/0 | - / 95.55 | 0 |

<details><summary>Per-arm checks</summary>

- 10-13-200k-r1 main-off: 46/46 exact, build stock-preview+src.ef16bf86bac1ed9b
- 10-13-200k-r1 main-on: 46/46 exact, build stock-preview+src.ef16bf86bac1ed9b
- 10-13-200k-r1 v1-off: 46/46 exact, build stock-preview+src.653e1910b005317a
- 10-13-200k-r1 v1-on: 46/46 exact, build stock-preview+src.653e1910b005317a
- 10-13-200k-r1 v2-off: 46/46 exact, build stock-preview+src.54b54e481662267f
- 10-13-200k-r1 v2-on: 46/46 exact, build stock-preview+src.54b54e481662267f
- 10-13-200k-r1 v3-off: 46/46 exact, build stock-preview+src.82625e6ce0676ef9
- 10-13-200k-r1 v3-on: 46/46 exact, build stock-preview+src.82625e6ce0676ef9

</details>
