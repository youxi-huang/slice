import json, glob, sys
cell = sys.argv[1]
def served(pkg):
    S = json.load(open(glob.glob(f"{cell}/{pkg}-on/*/summary.json")[0]))["replay"]["boundaries"]
    return sum(v for k, v in S["paths"].items() if k != "sync")
m = served("main")
print("yes" if any(abs(served(p) - m) == 1 for p in ["v1", "v2", "v3"]) else "no")
