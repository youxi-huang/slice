# P5 serial cells measured on machine B

Rows for PR #119's serial continuation-cache table, measured on a second machine so that the grid finishes sooner.
Each cell's eight arms ran serially on this machine alone, in the protocol's order (main, V1, V2, V3, each on then
off, three-second gaps), with nothing else measured, built or tested during a chain. Comparisons stay within a cell.
Run label B1 is this machine's first run of a cell. No model provider was called.

- Bench: `scripts/context-memory-preview-bench.mjs` at `d9e4513`; scripts and fixtures are identical at `cf18cb9`.
- Host: official Pi 1.4.0 (`context-memory-preview-stock-install.mjs`, seven runtime packages).
- Packages rebuilt from the recipe in the validation entry. Preview source SHA-256 and `dist/extension.js` SHA-256 match
  the recorded digests exactly: main `ef16bf86…` / `30ca900e…`, V1 `653e1910…` / `be69b5ca…`, V2 `54b54e48…` /
  `acc6da2c…`, V3 `82625e6c…` / `6981bf17…`. Archives differ in packing metadata only.
- Command: the validation entry's grid command, with `--label claude-<turn>-<writer>-<route>-r<run>-<package>-<arm>`.
- Every arm exited 0; every 272k chain replayed 43/43 recorded tool results exactly, every 200k chain 46/46, with no
  remaining replies or errors. Build IDs in each `summary.json` match the package.
- Columns and definitions follow the serial table. Raw metrics per arm are under `p5-serial-b/`: `summary.json`,
  `boundaries.jsonl`, `rounds.jsonl`; no notes, session content or local paths.

Completed cells: 10-28-272k-r1 

| Run | Turn / writer / route | Package / arm | Served | Fallbacks | Wait n; total (P50/P95) | Pause P50/P95; total | Overlap calls / summed input | Peak 60 s input | Calls T/S/W; all input | Cold first wait | Cut: links / uncached spend | Segment / writer cache % | Rate errors |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| B1 | 10 / 28 / 272k | main / on | 0/2 | tail 1, in-flight 1 | 2; 30.002 (15.001/15.001) | 43.101/43.135; 86.236 | 3 / 1,302,735 | 1,231,761 | 56/3/2; 6,108,032 | - | 2: 2/8,736; 4: 1/5,514 | 97.38 / 96.67 | 0 |
| B1 | 10 / 28 / 272k | main / off | 0/2 | - | 0; 0.000 (-/-) | 28.105/28.113; 56.218 | 0 / 0 | 1,079,004 | 56/0/2; 5,595,834 | - | 2: 0/0; 4: 0/0 | - / 96.67 | 0 |
| B1 | 10 / 28 / 272k | v1 / on | 0/2 | in-flight 2 | 0; 0.000 (-/-) | 28.107/28.126; 56.233 | 3 / 1,302,726 | 1,269,837 | 56/3/2; 6,107,950 | - | 2: 2/8,737; 4: 1/5,514 | 97.38 / 96.67 | 0 |
| B1 | 10 / 28 / 272k | v1 / off | 0/2 | - | 0; 0.000 (-/-) | 28.117/28.125; 56.242 | 0 / 0 | 1,078,995 | 56/0/2; 5,595,754 | - | 2: 0/0; 4: 0/0 | - / 96.67 | 0 |
| B1 | 10 / 28 / 272k | v2 / on | 2/2 | - | 0; 0.000 (-/-) | 0.076/0.118; 0.194 | 6 / 3,564,863 | 1,380,583 | 56/6/0; 7,053,524 | - | 2: 2/18,274 + unknown; 4: 3/37,203 | 92.69 / - | 0 |
| B1 | 10 / 28 / 272k | v2 / off | 0/2 | - | 0; 0.000 (-/-) | 28.122/28.131; 56.253 | 0 / 0 | 1,078,995 | 56/0/2; 5,595,754 | - | 2: 0/0; 4: 0/0 | - / 96.67 | 0 |
| B1 | 10 / 28 / 272k | v3 / on | 2/2 | - | 0; 0.000 (-/-) | 0.051/0.102; 0.153 | 10 / 4,427,441 | 1,355,928 | 56/10/0; 7,256,340 | - | 2: 4/56,815 + unknown; 4: 5/55,027 | 88.31 / - | 0 |
| B1 | 10 / 28 / 272k | v3 / off | 0/2 | - | 0; 0.000 (-/-) | 28.110/28.125; 56.235 | 0 / 0 | 1,078,995 | 56/0/2; 5,595,754 | - | 2: 0/0; 4: 0/0 | - / 96.67 | 0 |

