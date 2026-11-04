"""Turn a checkout of main (980658b) into V1: main plus the U8 estimate only (validation entry's recipe)."""
import subprocess, sys
wt = sys.argv[1]
P = "packages/coding-agent/src/extensions/context-memory/preview"
seg = subprocess.run(["git", "-C", wt, "show", f"eea33a3:{P}/segments.ts"], check=True, capture_output=True, text=True).stdout
open(f"{wt}/{P}/segments.ts", "w").write(seg)
path = f"{wt}/{P}/controller.ts"
s = open(path).read()
edits = [
("""						const waiting = performance.now();
						const settled = await segments.settle(segments.waitMs, event.signal);
						segmentsWaitMs = Math.round(performance.now() - waiting);
						if (settled) segmentsFallback = assemble();
""", """						if (segments.skipWait(segments.waitMs)) segmentsFallback = "in-flight";
						else {
							const waiting = performance.now();
							const settled = await segments.settle(segments.waitMs, event.signal);
							segmentsWaitMs = Math.round(performance.now() - waiting);
							if (settled) segmentsFallback = assemble();
						}
"""),
("""			} else {
				written = await writeMemory({""", """			} else {
				const hooks = this.journal?.hooks(attempt.sessionId, "compaction", attempt.lastCheckpointId ?? "none");
				written = await writeMemory({"""),
("""					callHooks: this.journal?.hooks(attempt.sessionId, "compaction", attempt.lastCheckpointId ?? "none"),""",
 """					callHooks: hooks && this.segments ? this.segments.observeCalls(attempt.sessionId, hooks) : hooks,"""),
]
for old, new in edits:
    assert s.count(old) == 1, old[:60]
    s = s.replace(old, new)
open(path, "w").write(s)
