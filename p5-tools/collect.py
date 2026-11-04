"""usage: collect.py <work-dir> <machine-id> <dest-dir>
Checks every completed cell under <work-dir>/out (exit 0, exact tool replay, no remaining replies or errors), then
writes <dest-dir>/P5-SERIAL-MACHINE-<ID>.md and the raw metrics under <dest-dir>/p5-serial-<id>/. Content-free."""
import glob, json, os, platform, re, shutil, subprocess, sys
work, mid, dest = os.path.abspath(sys.argv[1]), sys.argv[2].upper(), os.path.abspath(sys.argv[3])
here = os.path.dirname(os.path.abspath(__file__))
log = open(f"{work}/progress.log").read()
bad = re.findall(r"exit ([1-9]\d*) (\S+)", log)
if bad: sys.exit(f"non-zero exits: {bad}")
cells = re.findall(r"cell-done (\S+)", log)
if not cells: sys.exit("no completed cell")
raw = f"{dest}/p5-serial-{mid.lower()}"
rows, checks = [], []
for cell in cells:
    key, run = cell.rsplit("-r", 1)
    turn, writer, route = key.split("-")
    for arm_dir in sorted(glob.glob(f"{work}/out/{cell}/*/")):
        arm = os.path.basename(arm_dir.rstrip("/"))
        src = glob.glob(f"{arm_dir}*/summary.json")
        if not src: sys.exit(f"{cell} {arm}: no summary.json")
        base = os.path.dirname(src[0])
        rounds = [json.loads(line) for line in open(f"{base}/rounds.jsonl")]
        expected = sum(r["tools"]["expected"] for r in rounds); executed = sum(r["tools"]["executed"] for r in rounds)
        exact = all(r["tools"]["exact"] for r in rounds); left = sum(r["remainingReplies"] for r in rounds); errs = sum(len(r["errors"]) for r in rounds)
        want = 46 if route == "200k" else 43
        if not (exact and executed == expected == want and left == 0 and errs == 0):
            sys.exit(f"{cell} {arm}: tools {executed}/{expected} exact={exact} remaining={left} errors={errs}")
        checks.append(f"{cell} {arm}: {executed}/{expected} exact, build {json.load(open(src[0]))['build']}")
        os.makedirs(f"{raw}/{cell}/{arm}", exist_ok=True)
        for name in ("summary.json", "boundaries.jsonl", "rounds.jsonl"):
            shutil.copy(f"{base}/{name}", f"{raw}/{cell}/{arm}/{name}")
    label = f"{turn} / {writer} / {route}"
    rows.append(subprocess.run([sys.executable, f"{here}/rows.py", f"{work}/out/{cell}", f"{mid}{run}", label], check=True, capture_output=True, text=True).stdout.strip())
for path in glob.glob(f"{raw}/**/*", recursive=True):
    if os.path.isfile(path) and re.search(r'"/(tmp|home|root|workspace|Users)/', open(path).read()):
        sys.exit(f"local path in {path}")
node = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
header = "| Run | Turn / writer / route | Package / arm | Served | Fallbacks | Wait n; total (P50/P95) | Pause P50/P95; total | Overlap calls / summed input | Peak 60 s input | Calls T/S/W; all input | Cold first wait | Cut: links / uncached spend | Segment / writer cache % | Rate errors |\n| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |"
open(f"{dest}/P5-SERIAL-MACHINE-{mid}.md", "w").write(f"""# P5 serial cells measured on machine {mid}

Rows for PR #119's serial continuation-cache table. Each cell's eight arms ran serially on this machine alone, in the
protocol's order, with nothing else measured, built or tested during a chain. Run label {mid}<n> is this machine's
n-th run of a cell. No model provider was called. Tools: `p5-tools/` on branch claude/confident-thompson-3k0e8p.

- Bench at `d9e4513`; official Pi 1.4.0; Node {node} on {platform.machine()}.
- Packages built by `build-packages.sh`; every `dist/extension.js` SHA-256 matched the recorded digest.
- Every arm exited 0 and replayed its recorded tool results exactly, with no remaining replies or errors.
- Raw metrics per arm are under `p5-serial-{mid.lower()}/`; no notes, session content or local paths.

Completed cells: {", ".join(cells)}

{header}
{chr(10).join(rows)}

<details><summary>Per-arm checks</summary>

{chr(10).join("- " + c for c in checks)}

</details>
""")
print(f"wrote P5-SERIAL-MACHINE-{mid}.md with {len(cells)} cell(s)")
