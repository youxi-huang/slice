#!/bin/bash
# usage: run-cell.sh <work-dir> <stock-root> <prefix> <turnMs> <writerMs> <200k|272k> <run>
# Runs one cell's eight arms serially (main, V1, V2, V3; each on then off; three-second gaps).
# Nothing else may run on the machine meanwhile. Progress goes to <work-dir>/progress.log.
work=$(cd "$1" && pwd); stock=$(cd "$2" && pwd); prefix=$3; turn=$4; writer=$5; route=$6; run=$7
if [ "$route" = 200k ]; then cuts=1,3,5; window=180000; else cuts=2,4; window=240000; fi
cell="$((turn/1000))-$((writer/1000))-$route-r$run"; out="$work/out/$cell"; mkdir -p "$out"
cd "$work/wt-bench"
for pkg in main v1 v2 v3; do for arm in on off; do
  label="$prefix-$cell-$pkg-$arm"
  echo "$(date -u +%H:%M:%S) start $label" >> "$work/progress.log"
  node scripts/context-memory-preview-bench.mjs --package-dir "$work/$pkg/package" --stock-root "$stock" --output-dir "$out/$pkg-$arm" --mode probes --provider loopback --fixtures P5 --cache session --replay --replay-tools --pace immediate --cuts $cuts --window $window --reserve 30000 --compactions-only --latency-ms $writer --turn-latency-ms $turn --thinking medium --session-settings previewSegments=$arm --chain-attempts 1 --unit-minutes 20 --label "$label" > "$out/$pkg-$arm.log" 2>&1
  echo "$(date -u +%H:%M:%S) exit $? $label" >> "$work/progress.log"
  sleep 3
done; done
echo "$(date -u +%H:%M:%S) cell-done $cell" >> "$work/progress.log"
