import json, sys, glob, os
# usage: rows.py <cell-dir> <run> <turn/writer/route label>
cell, run, label = sys.argv[1], sys.argv[2], sys.argv[3]
def s(ms): return "-" if ms is None else f"{ms/1000:.3f}"
def n(x): return f"{x:,}"
for pkg in ["main", "v1", "v2", "v3"]:
    for arm in ["on", "off"]:
        d = glob.glob(f"{cell}/{pkg}-{arm}/*/summary.json")
        if not d: continue
        base = os.path.dirname(d[0]); S = json.load(open(d[0])); R = S["replay"]
        b = R["boundaries"]; p = R["pauseMs"]["all"]; w = b["waited"]; o = R["overlap"]
        served = sum(v for k, v in b["paths"].items() if k != "sync")
        fb = ", ".join(f"{k} {v}" for k, v in b["fallbacks"].items()) or "-"
        rounds = [json.loads(l) for l in open(f"{base}/rounds.jsonl")]
        calls = [c for r in rounds for c in r["transportCalls"]]
        kinds = {}
        for c in calls: kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
        allin = sum(c["input"] for c in calls)
        # Rows are appended in order; Pi's own (auto) compactions carry no startedAt.
        bounds = [json.loads(l) for l in open(f"{base}/boundaries.jsonl")]
        first = bounds[0] if bounds else None
        cold = "-"
        if first and first.get("segmentsWaitMs") is not None:
            if first.get("startedAt") is None: cold = "?"
            elif not [c for c in calls if c["kind"] != "main" and c.get("end", float("inf")) < first["startedAt"]]:
                cold = s(first["segmentsWaitMs"])
        iv = "; ".join(f"{i['cut']}: {i['links']}/{n(i['uncachedSpend'])}" + (" + unknown" if i["unknown"] else "") for i in R.get("intervals", [])) or "-"
        def share(x): return "-" if not x or x.get("calls", 0) == 0 or x.get("cacheReadShare") is None else f"{x['cacheReadShare']*100:.2f}"
        seg = o["segmentCalls"] if arm == "on" else 0
        print(f"| {run} | {label} | {pkg} / {arm} | {served}/{b['total']} | {fb} | {w['count']}; {s(w['total'])} ({s(w['p50'])}/{s(w['p95'])}) | {s(p['p50'])}/{s(p['p95'])}; {s(p['total'])} | {seg} / {n(o['summedInput'] if seg else 0)} | {n(o['peakMinuteInput'])} | {kinds.get('main',0)}/{kinds.get('segment',0)}/{kinds.get('writer',0)}; {n(allin)} | {cold} | {iv} | {share(R.get('segmentCalls'))} / {share(R.get('writerCalls'))} | {R['rateLimitErrors']} |")
