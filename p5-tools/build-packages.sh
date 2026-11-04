#!/bin/bash
# usage: build-packages.sh <repo> <work-dir>
# Builds main, V1, V2 and V3 into <work-dir>/<pkg>/package, checks each bundle against the recorded SHA-256,
# and prepares the bench checkout <work-dir>/wt-bench at d9e4513. Stops on the first mismatch.
set -euo pipefail
repo=$(cd "$1" && pwd); work=$2; mkdir -p "$work"; work=$(cd "$work" && pwd); tools=$(cd "$(dirname "$0")" && pwd)
declare -A commit=( [main]=980658b [v1]=980658b [v2]=1bf62be [v3]=eea33a3 [bench]=d9e4513 )
declare -A bundle=(
  [main]=30ca900e401c13f1cacfd15667d9d5fdc5eb0ebefd1c452f966cc5944689676f
  [v1]=be69b5ca6797600f2713d4fe0a083219544b819c7acadcac15a5d0530767bb12
  [v2]=acc6da2caf014554f5d9a7ee90dd51824e21f07169efc28e2535e08813719415
  [v3]=6981bf175d9fb7b1702115327c2f649bb3dad81404a18df68125d4d341b2b413 )
checkout() {
  git -C "$repo" worktree add -q --detach "$2" "$1"
  ln -s "$repo/node_modules" "$2/node_modules"
  for d in $(cd "$repo" && ls -d packages/*/node_modules 2>/dev/null); do ln -s "$repo/$d" "$2/$d"; done
}
for pkg in main v1 v2 v3; do
  checkout "${commit[$pkg]}" "$work/wt-$pkg"
  if [ "$pkg" = v1 ]; then python3 "$tools/make-v1.py" "$work/wt-$pkg"; fi
  (cd "$work/wt-$pkg" && node scripts/context-memory-preview-build.mjs --output-dir "$work/$pkg/package" > "$work/$pkg.build.log" 2>&1)
  got=$(sha256sum "$work/$pkg/package/dist/extension.js" | cut -d' ' -f1)
  if [ "$got" != "${bundle[$pkg]}" ]; then echo "MISMATCH $pkg bundle $got, expected ${bundle[$pkg]}"; exit 1; fi
  echo "$pkg bundle ok ${got:0:16}"
done
checkout "${commit[bench]}" "$work/wt-bench"
echo "bench checkout ready at d9e4513"
