import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readMemoryConfig } from "../packages/coding-agent/src/extensions/context-memory/config.ts";
import { readExcerptSettings } from "../packages/coding-agent/src/extensions/context-memory/preview/excerpts.ts";
import { readPreparationSettings } from "../packages/coding-agent/src/extensions/context-memory/preview/preparation.ts";
// Importing the bench starts no run: only its helpers are read here.
import { loopbackLatencyMs, parseSessionSettings, percentile, settledSteps, writeUnitSettings } from "./context-memory-preview-bench.mjs";

const script = fileURLToPath(new URL("./context-memory-preview-bench.mjs", import.meta.url));

function scratch(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-preview-bench-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

const settingsFile = (agentDir) => join(agentDir, "pi-context-memory.json");

test("loopback writer latency covers Luna's measured range and refuses provider runs before dispatch", () => {
	for (const ms of [0, 13_000, 28_000, 52_000, 133_000, 180_000]) assert.equal(loopbackLatencyMs(String(ms), "loopback"), ms);
	for (const value of ["-1", "0.5", "Infinity", "NaN", "180001"]) assert.throws(() => loopbackLatencyMs(value, "loopback"), /--latency-ms takes/);
	assert.throws(() => loopbackLatencyMs("13000", "openai"), /needs --provider loopback/);
	assert.equal(loopbackLatencyMs("0", "openai"), 0);
});

test("a unit's pi-context-memory.json carries each named switch in the shape the preview reads", (t) => {
	const { label, settings } = parseSessionSettings("previewReduction=on,previewExcerpts=off");
	// The label stays as given, for summary.json; the file holds the preview's own switch objects.
	assert.deepEqual(label, { previewReduction: "on", previewExcerpts: "off" });
	assert.deepEqual(settings, { previewReduction: { enabled: true }, previewExcerpts: { enabled: false } });

	const agentDir = join(scratch(t), "agents", "0001");
	writeUnitSettings(agentDir, settings);
	assert.deepEqual(JSON.parse(readFileSync(settingsFile(agentDir), "utf8")), settings);
	// The preview's readers accept it: the named switches take effect and nothing else is disturbed.
	assert.deepEqual(readPreparationSettings(agentDir), {
		enabled: false,
		notes: { enabled: false },
		reduction: { enabled: true },
		rendering: { enabled: false, candidates: [] },
		segments: { enabled: false, effort: "session" },
	});
	assert.deepEqual(readExcerptSettings(agentDir), { enabled: false });
	assert.equal(readMemoryConfig(agentDir).enabled, true);

	// All four switches map, and the file lists them in one fixed order whatever order the flag gives.
	const every = parseSessionSettings("previewWorkNotes=on,previewPreparation=off,previewExcerpts=on,previewReduction=on");
	assert.deepEqual(Object.keys(every.label), ["previewWorkNotes", "previewPreparation", "previewExcerpts", "previewReduction"]);
	assert.deepEqual(every.settings, {
		previewReduction: { enabled: true },
		previewExcerpts: { enabled: true },
		previewPreparation: { enabled: false },
		previewWorkNotes: { enabled: true },
	});
	const everyDir = join(scratch(t), "every");
	writeUnitSettings(everyDir, every.settings);
	assert.deepEqual(readPreparationSettings(everyDir), {
		enabled: false,
		notes: { enabled: true },
		reduction: { enabled: true },
		rendering: { enabled: false, candidates: [] },
		segments: { enabled: false, effort: "session" },
	});
	assert.deepEqual(readExcerptSettings(everyDir), { enabled: true });

	// Merged over what the unit's file already holds; a named switch replaces its earlier value.
	const merged = join(scratch(t), "merged");
	mkdirSync(merged, { recursive: true });
	writeFileSync(settingsFile(merged), JSON.stringify({ eventLog: false, previewReduction: { enabled: false } }));
	writeUnitSettings(merged, settings);
	assert.deepEqual(JSON.parse(readFileSync(settingsFile(merged), "utf8")), {
		eventLog: false,
		previewReduction: { enabled: true },
		previewExcerpts: { enabled: false },
	});
});

test("an unknown name or value is a usage error, and the run stops before any unit starts", (t) => {
	for (const [text, message] of [
		["previewReducton=on", /unknown setting "previewReducton"/],
		["keepRecentTokens=0", /unknown setting "keepRecentTokens"/],
		["previewReduction=yes", /previewReduction takes on or off, not "yes"/],
		["previewReduction=true", /previewReduction takes on or off/],
		["previewReduction=on,previewReduction=off", /previewReduction is given twice/],
		["previewReduction", /name=on\|off pairs/],
		["previewReduction=on=off", /name=on\|off pairs/],
	])
		assert.throws(() => parseSessionSettings(text), message, text);

	// The whole bench, with a package and host that do not exist: the flag is refused before either is read and
	// before the run directory, and so any unit's agent directory, is created.
	const directory = scratch(t);
	const output = join(directory, "output");
	const result = spawnSync(
		process.execPath,
		[
			script,
			"--package-dir",
			join(directory, "no-package"),
			"--stock-root",
			join(directory, "no-pi"),
			"--output-dir",
			output,
			"--mode",
			"writer",
			"--label",
			"mislabelled",
			"--session-settings",
			"previewReduction=on,previewReducton=on",
		],
		{ encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1" } },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /--session-settings: unknown setting "previewReducton"/);
	assert.doesNotMatch(result.stderr, /preview-build\.json|ENOENT/);
	assert.equal(existsSync(output), false);
});

test("without --session-settings no unit gets a settings file, so units run on the package defaults", (t) => {
	assert.deepEqual(parseSessionSettings(""), { label: {}, settings: {} });
	assert.deepEqual(parseSessionSettings(","), { label: {}, settings: {} });
	const agentDir = join(scratch(t), "agents", "0001");
	writeUnitSettings(agentDir, parseSessionSettings("").settings);
	assert.equal(existsSync(agentDir), false);
	assert.equal(existsSync(settingsFile(agentDir)), false);
	// What a unit without the file reads: every preview switch at its off default.
	assert.deepEqual(readPreparationSettings(agentDir), {
		enabled: false,
		notes: { enabled: false },
		reduction: { enabled: false },
		rendering: { enabled: false, candidates: [] },
		segments: { enabled: false, effort: "session" },
	});
	assert.deepEqual(readExcerptSettings(agentDir), { enabled: false });
});

test("--provider openai is a provider run on the official API, and the long-route options are checked before any file", (t) => {
	const directory = scratch(t);
	const output = join(directory, "output");
	const bench = (...flags) =>
		spawnSync(
			process.execPath,
			[script, "--package-dir", join(directory, "no-package"), "--stock-root", join(directory, "no-pi"), "--output-dir", output, ...flags],
			{ encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1" } },
		);
	// Each is refused before the package, the host or the run directory is read, so no request can follow.
	for (const [flags, message] of [
		[["--mode", "probes", "--provider", "openai", "--latency-ms", "13000"], /--latency-ms needs --provider loopback/],
		[["--mode", "probes", "--latency-ms", "180001"], /--latency-ms takes an integer/],
		[["--mode", "smoke", "--provider", "openai"], /Missing --max-requests/],
		[["--mode", "smoke", "--provider", "openai", "--max-requests", "1", "--max-minutes", "1", "--max-cost-usd", "0"], /--max-costUsd must be positive for a provider run/],
		[["--mode", "repair", "--provider", "openai", "--max-requests", "1", "--max-minutes", "1", "--max-cost-usd", "0.01"], /--provider openai does not serve --mode repair/],
		[["--mode", "smoke", "--provider", "codex"], /--provider must be loopback, deepseek, deepseek-local, openai or relay/],
		// The long-route options: a chain's cuts only in probes mode and ascending, known probe conditions once each,
		// and a positive per-request input line.
		[["--mode", "writer", "--cuts", "1,3"], /--cuts applies to probes mode/],
		[["--mode", "writer", "--compactions-only"], /--compactions-only applies to probes mode/],
		[["--mode", "probes", "--cache", "hot"], /--cache must be cold, warm or session/],
		[["--mode", "probes", "--cuts", "3,1"], /--cuts takes ascending checkpoint numbers from 1/],
		[["--mode", "probes", "--cuts", "0,2"], /--cuts takes ascending checkpoint numbers from 1/],
		[["--mode", "probes", "--probe-conditions", "history,history"], /--probe-conditions takes history, none or both/],
		[["--mode", "probes", "--probe-conditions", "tools"], /--probe-conditions takes history, none or both/],
		[["--mode", "writer", "--max-input-tokens", "0"], /--max-input-tokens must be positive/],
		[["--mode", "writer", "--max-input-tokens", "many"], /--max-input-tokens must be positive/],
		// The native control arm loads no package, so it has no context_history and no writer to measure.
		[["--mode", "probes", "--arm", "pi"], /--arm must be slice or native/],
		[["--mode", "probes", "--arm", "native"], /--arm native serves only --mode probes with --probe-conditions none/],
		[["--mode", "writer", "--arm", "native", "--probe-conditions", "none"], /--arm native serves only --mode probes/],
		// --replay: a probes chain whose every turn runs on the session itself, with the package, at a known pace,
		// in a window of plausible size; a segment level only with segments switched on.
		[["--mode", "writer", "--replay"], /--replay applies to probes mode/],
		[["--mode", "probes", "--replay"], /--replay runs every turn on the session itself: give --cache session/],
		[["--mode", "probes", "--replay", "--cache", "session", "--arm", "native", "--probe-conditions", "none"], /--replay needs the package/],
		[["--mode", "probes", "--pace", "eventually"], /--pace takes settled or immediate/],
		[["--mode", "probes", "--window", "1000"], /--window takes a token count from 32000 to 1000000/],
		[["--mode", "probes", "--reserve", "10"], /--reserve takes a token count from 1000 to 200000/],
		[["--mode", "probes", "--segment-effort", "fast"], /--segment-effort takes session, off/],
		[["--mode", "probes", "--segment-effort", "low"], /--segment-effort needs --session-settings previewSegments=on/],
	]) {
		const result = bench(...flags);
		assert.notEqual(result.status, 0, flags.join(" "));
		assert.match(result.stderr, message, flags.join(" "));
		assert.doesNotMatch(result.stderr, /preview-build\.json|ENOENT/, flags.join(" "));
		assert.equal(existsSync(output), false, flags.join(" "));
	}
});

test("previewSegments is a session switch, and the preview reads its level from the same object", (t) => {
	const { settings } = parseSessionSettings("previewSegments=on");
	assert.deepEqual(settings, { previewSegments: { enabled: true } });
	const agentDir = join(scratch(t), "segments");
	writeUnitSettings(agentDir, { previewSegments: { ...settings.previewSegments, effort: "low" } });
	assert.deepEqual(readPreparationSettings(agentDir).segments, { enabled: true, effort: "low" });
});

test("--replay splits a round where the agent settles, and reports nearest-rank percentiles", () => {
	const message = (id, role, stopReason) => ({ type: "message", id, message: { role, ...(stopReason ? { stopReason } : {}) } });
	const entries = [
		message("u1", "user"),
		message("a1", "assistant", "toolUse"),
		message("t1", "toolResult"),
		message("a2", "assistant", "stop"),
		message("u2", "user"),
		message("a3", "assistant", "stop"),
		message("u3", "user"),
		message("a4", "assistant", "toolUse"),
		message("t4", "toolResult"),
	];
	// A tool call's reply settles nothing; the round's last entry ends the last step whatever it is.
	assert.deepEqual(
		settledSteps(entries).map((step) => step.map((entry) => entry.id)),
		[["u1", "a1", "t1", "a2"], ["u2", "a3"], ["u3", "a4", "t4"]],
	);
	assert.deepEqual(settledSteps([]), []);
	assert.equal(percentile([5, 1, 3, null, 4, 2], 0.5), 3);
	assert.equal(percentile([5, 1, 3, 4, 2], 0.95), 5);
	assert.equal(percentile([7], 0.95), 7);
	assert.equal(percentile([null], 0.5), null);
});
