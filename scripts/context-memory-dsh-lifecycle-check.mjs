import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startVitest } from "vitest/node";

// Run only the native lifecycle probes, using the components of an isolated official DSH install.
// No host files are changed, and neither the agent loop nor an LLM adapter is started.
const { values } = parseArgs({ options: { "host-root": { type: "string" } } });
assert(values["host-root"], "Usage: node scripts/context-memory-dsh-lifecycle-check.mjs --host-root <official DSH npm installation>");
const hostRoot = resolve(values["host-root"]);
const lock = JSON.parse(readFileSync(join(hostRoot, "node_modules/.package-lock.json"), "utf8"));
const host = lock.packages["node_modules/@deepseek-ai/dsh"];
assert(host?.resolved?.startsWith("https://registry.npmjs.org/@deepseek-ai/dsh/-/"), "DSH must be installed from npm");
assert.match(host.integrity, /^sha512-/);
const require = createRequire(join(hostRoot, "package.json"));
const names = ["cordis", "dsh-compaction", "dsh-llm", "dsh-session", "dsh-session-format-catalog", "dsh-session-persistence-jsonl"];
const alias = Object.fromEntries(names.map((name) => {
	const spec = `@deepseek-ai/${name}`;
	const record = lock.packages[`node_modules/${spec}`];
	assert(record?.resolved?.startsWith(`https://registry.npmjs.org/${spec}/-/`), `${spec} must be installed from npm`);
	assert.match(record.integrity, /^sha512-/);
	if (name.startsWith("dsh-")) assert.equal(record.version, host.version, `${spec} must match the official DSH version`);
	return [spec, require.resolve(spec)];
}));
const root = fileURLToPath(new URL("../", import.meta.url));
console.log(`DSH ${host.version}: native stage 1 lifecycle probes (no provider)`);
const runner = await startVitest("test", ["packages/compaction-dsh/test/compaction.test.ts"], {
	root,
	config: false,
	watch: false,
}, { resolve: { alias } });
try {
	if (runner.state.getUnhandledErrors().length || runner.state.getFiles().some((file) => file.result?.state !== "pass")) {
		process.exitCode = 1;
	}
	assert.equal(runner.state.getFiles().length, 1, "The lifecycle test file must run");
} finally {
	await runner.close();
}
