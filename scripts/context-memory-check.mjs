import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checks = [
	["scripts/context-memory-pressure-profile.test.mjs", []],
	["node_modules/@biomejs/biome/bin/biome", ["check", "--error-on-warnings", "."]],
	["scripts/check-pinned-deps.mjs", []],
	["scripts/check-runtime-deps.mjs", []],
	["scripts/check-ts-relative-imports.mjs", []],
	["scripts/check-entry-graphs.mjs", []],
	["scripts/generate-coding-agent-install-lock.mjs", ["--check"]],
	["node_modules/typescript/bin/tsc", ["--noEmit"]],
	["scripts/context-memory-core-check.mjs", []],
	["scripts/context-memory-adapters-check.mjs", []],
];
for (const [file, args] of checks) {
	const result = spawnSync(process.execPath, [resolve(root, file), ...args], { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
const prefixResult = spawnSync(process.execPath, ["--test", resolve(root, "scripts/context-memory-prefix-profile.test.mjs"), resolve(root, "scripts/context-memory-preview-stock-install.test.mjs"), resolve(root, "scripts/context-memory-preview-acceptance-profile.test.mjs"), resolve(root, "scripts/context-memory-preview-release-checks.test.mjs"), resolve(root, "scripts/context-memory-preview-bench.test.mjs"), resolve(root, "scripts/context-memory-host-run.test.mjs"), resolve(root, "scripts/context-memory-equivalence-compare.test.mjs"), resolve(root, "scripts/context-memory-core-check.test.mjs"), resolve(root, "scripts/context-memory-preview-source-migration.test.mjs")], {
	cwd: root, stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" },
});
if (prefixResult.error) throw prefixResult.error;
if (prefixResult.status !== 0) process.exit(prefixResult.status ?? 1);
const result = spawnSync(process.execPath, [resolve(root, "node_modules/vitest/dist/cli.js"), "--run", "test/context-memory.test.ts", "test/context-memory-budget.test.ts", "test/context-memory-preview.test.ts", "test/context-memory-preview-preparation.test.ts", "test/context-memory-preview-writer-calls.test.ts", "test/context-memory-preview-journal.test.ts", "test/context-memory-validation.test.ts", "test/context-memory-preview-readback.test.ts", "test/context-memory-preview-quote.test.ts", "test/context-memory-preview-history-view.test.ts", "test/context-memory-preview-excerpt.test.ts", "test/context-memory-preview-reduction.test.ts", "test/context-memory-preview-bench-report.test.ts", "test/context-memory-preview-render.test.ts", "test/context-memory-preview-fuzz.test.ts", "test/context-memory-preview-tool-segments.test.ts"], {
	cwd: resolve(root, "packages/coding-agent"), stdio: "inherit", env: { ...process.env, PI_OFFLINE: "1" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
