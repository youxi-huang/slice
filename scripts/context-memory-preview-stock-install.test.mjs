import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CHORD_PI_VERSIONS, OFFICIAL_PI_VERSIONS, inspectOfficialPi, installOfficialPi, officialPiCohort, officialPiReady, parseStockInstallArguments } from "./context-memory-preview-stock-install.mjs";

const integrity = `sha512-${createHash("sha512").update("synthetic package bytes").digest("base64")}`;
const script = fileURLToPath(new URL("./context-memory-preview-stock-install.mjs", import.meta.url));

function scratch(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-stock-install-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function writeJson(file, value) {
	writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function fixture(directory, version = "1.1.0") {
	const packages = {};
	const names = officialPiCohort(version);
	for (const name of names) {
		const key = `node_modules/${name}`;
		const packageRoot = join(directory, key);
		mkdirSync(join(packageRoot, "dist/bundle"), { recursive: true });
		const dependencies = name.endsWith("/pi-coding-agent")
			? Object.fromEntries(names.filter((dependency) => dependency !== name && !dependency.endsWith("/pi-telemetry")).map((dependency) => [dependency, `^${version}`]))
			: name.endsWith("/pi-ai") ? { "@earendil-works/pi-telemetry": `^${version}` } : {};
		writeJson(join(packageRoot, "package.json"), { name, version, type: "module", dependencies });
		writeFileSync(join(packageRoot, "dist/index.js"), `export const VERSION = ${JSON.stringify(version)}; export function createAgentSession() {} export class SessionManager {}\n`);
		writeFileSync(join(packageRoot, "dist/bundle/cli.js"), "// Synthetic startup fixture only.\n");
		packages[key] = { version, integrity, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz` };
	}
	writeJson(join(directory, "node_modules/.package-lock.json"), { lockfileVersion: 3, packages });
	writeJson(join(directory, "package.json"), { dependencies: Object.fromEntries(names.map((name) => [name, version])) });
}

function changeLock(directory, operation) {
	const file = join(directory, "node_modules/.package-lock.json");
	const lock = JSON.parse(readFileSync(file, "utf8"));
	operation(lock);
	writeJson(file, lock);
}

test("CLI requires an isolated root and one reviewed exact version", () => {
	assert.deepEqual(parseStockInstallArguments(["--version", "1.0.4", "--stock-root", "/tmp/stock", "--check"]), { check: true, version: "1.0.4", stockRoot: "/tmp/stock" });
	for (const args of [[], ["--stock-root", "/tmp/stock"], ["--version", "1.5.0", "--stock-root", "/tmp/stock"], ["--version", "1.1.0", "--stock-root", "--check"], ["--version", "1.1.0", "--stock-root", "/tmp/stock", "--check", "--check"], ["--version", "1.1.0", "--version", "1.1.0", "--stock-root", "/tmp/stock"]]) {
		assert.throws(() => parseStockInstallArguments(args));
	}
});

test("all reviewed cohorts report exact versions and npm provenance without redundant report hashes", (t) => {
	for (const version of OFFICIAL_PI_VERSIONS) {
		const directory = scratch(t);
		fixture(directory, version);
		const report = inspectOfficialPi(directory, version);
		assert.equal(report.version, version);
		assert.equal(report.packages.length, CHORD_PI_VERSIONS.includes(version) || version === "1.5.2" ? 8 : 7);
		assert.equal(report.packages.some((pkg) => pkg.name === "@earendil-works/pi-schema"), version === "1.5.2");
		assert.ok(report.packages.every((record) => record.version === version && record.integrity === integrity));
		assert.deepEqual(Object.keys(report).sort(), ["host", "packages", "version"]);
		assert.ok(report.packages.every((record) => !Object.hasOwn(record, "manifestSha256")));
		assert.equal(officialPiReady(directory, version), true);
		assert.equal(officialPiReady(directory, version === "1.1.0" ? "1.0.4" : "1.1.0"), false);
	}
});

test("a newer transitive package fails readiness even when the coding agent matches", (t) => {
	const directory = scratch(t);
	fixture(directory);
	const file = join(directory, "node_modules/@earendil-works/pi-mcp/package.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	writeJson(file, { ...manifest, version: "1.2.0" });
	assert.equal(officialPiReady(directory, "1.1.0"), false);
	assert.throws(() => inspectOfficialPi(directory, "1.1.0"), /cohort version mismatch/);
});

test("cache readiness requires exact root pins for the whole cohort", (t) => {
	const directory = scratch(t);
	fixture(directory);
	writeJson(join(directory, "package.json"), { dependencies: { "@earendil-works/pi-coding-agent": "1.1.0" } });
	assert.equal(officialPiReady(directory, "1.1.0"), false);
	assert.throws(() => inspectOfficialPi(directory, "1.1.0"), /pin every runtime cohort dependency exactly/);
});

test("missing integrity and file/git provenance are rejected", (t) => {
	for (const replacement of [{ integrity: "" }, { integrity: "sha512-bad" }, { resolved: "file:patched-host" }, { link: true }, { version: "1.2.0" }]) {
		const directory = scratch(t);
		fixture(directory);
		changeLock(directory, (lock) => Object.assign(lock.packages["node_modules/@earendil-works/pi-ai"], replacement));
		assert.throws(() => inspectOfficialPi(directory, "1.1.0"), /provenance/);
	}
});

test("nested official copies and new unreviewed cohort edges fail closed", (t) => {
	const directory = scratch(t);
	fixture(directory);
	changeLock(directory, (lock) => { lock.packages["node_modules/other/node_modules/@earendil-works/pi-ai"] = lock.packages["node_modules/@earendil-works/pi-ai"]; });
	assert.throws(() => inspectOfficialPi(directory, "1.1.0"), /Nested official cohort copy/);
	fixture(directory);
	const file = join(directory, "node_modules/@earendil-works/pi-ai/package.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	writeJson(file, { ...manifest, dependencies: { "@earendil-works/pi-future": "^1.1.0" } });
	assert.throws(() => inspectOfficialPi(directory, "1.1.0"), /Unreviewed official runtime dependency/);
});

test("a symlink to a workspace package is not an official isolated install", (t) => {
	const directory = scratch(t);
	fixture(directory);
	const outside = scratch(t);
	const packageRoot = join(directory, "node_modules/@earendil-works/pi-ai");
	rmSync(packageRoot, { recursive: true });
	symlinkSync(outside, packageRoot, "dir");
	assert.throws(() => inspectOfficialPi(directory, "1.1.0"), /escapes isolated root/);
});

test("check mode never installs a missing or mixed host", (t) => {
	const directory = scratch(t);
	let calls = 0;
	assert.throws(() => installOfficialPi({ stockRoot: directory, version: "1.1.0", check: true }, () => { calls++; }), /ENOENT/);
	assert.equal(calls, 0);
});

test("installation explicitly pins the older eight-package cohort without overrides or scripts", (t) => {
	const directory = scratch(t);
	const calls = [];
	const report = installOfficialPi({ stockRoot: directory, version: "1.0.4" }, (program, args, options) => {
		calls.push({ program, args, options });
		if (program === "npm") { fixture(directory, "1.0.4"); return { status: 0, stdout: "", stderr: "" }; }
		return { status: 0, stdout: "official-sdk-ready\n", stderr: "" };
	});
	assert.equal(report.installed, true);
	assert.deepEqual(calls[0].args.slice(-8), officialPiCohort("1.0.4").map((name) => `${name}@1.0.4`));
	assert.ok(calls[0].args.includes("--ignore-scripts") && calls[0].args.includes("--save-exact") && calls[0].args.includes("--fetch-retries=0"));
	assert.equal(calls[0].options.timeout, 180_000);
	assert.equal(calls[1].options.env.PI_OFFLINE, "1");
	assert.equal(calls[1].options.env.EVAL_MODEL_CALL_BUDGET, "0");
	assert.ok(calls[1].args.includes(fileURLToPath(new URL("../eval/deny-network.mjs", import.meta.url))));
});

test("ready cache skips npm but still validates SDK startup with networking denied", (t) => {
	const directory = scratch(t);
	fixture(directory);
	const report = installOfficialPi({ stockRoot: directory, version: "1.1.0", check: true });
	assert.equal(report.installed, false);
	assert.equal(report.sdkStartup, "network-blocked import passed");
});

test("upgrading a cached older root drops chord and pins all seven Pi 1.2.0 packages", (t) => {
	const directory = scratch(t);
	fixture(directory, "1.1.0");
	const calls = [];
	const report = installOfficialPi({ stockRoot: directory, version: "1.2.0" }, (program, args) => {
		calls.push({ program, args });
		if (program === "npm") {
			const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
			assert.deepEqual(manifest.dependencies, Object.fromEntries(officialPiCohort("1.2.0").map((name) => [name, "1.2.0"])));
			rmSync(join(directory, "node_modules"), { recursive: true });
			fixture(directory, "1.2.0");
			return { status: 0, stdout: "", stderr: "" };
		}
		return { status: 0, stdout: "official-sdk-ready\n", stderr: "" };
	});
	assert.equal(report.installed, true);
	assert.equal(report.packages.length, 7);
	assert.deepEqual(calls[0].args.slice(-7), officialPiCohort("1.2.0").map((name) => `${name}@1.2.0`));
});

test("a 1.2.0 installation cannot keep chord as an extra dependency", (t) => {
	const directory = scratch(t);
	fixture(directory, "1.2.0");
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	manifest.dependencies["@earendil-works/chord"] = "1.1.0";
	writeJson(join(directory, "package.json"), manifest);
	assert.throws(() => inspectOfficialPi(directory, "1.2.0"), /pin every runtime cohort dependency exactly/);
});

test("hosts after 1.1.0 omit chord, and a newer host that still needed it fails inspection", (t) => {
	for (const version of OFFICIAL_PI_VERSIONS) {
		assert.equal(officialPiCohort(version).includes("@earendil-works/chord"), CHORD_PI_VERSIONS.includes(version), version);
	}
	assert.deepEqual(officialPiCohort("1.4.0"), officialPiCohort("1.2.0"));
	assert.deepEqual(officialPiCohort("1.3.0"), officialPiCohort("1.2.0"));
	const directory = scratch(t);
	fixture(directory, "1.4.0");
	const agent = join(directory, "node_modules/@earendil-works/pi-coding-agent/package.json");
	const manifest = JSON.parse(readFileSync(agent, "utf8"));
	writeJson(agent, { ...manifest, dependencies: { ...manifest.dependencies, "@earendil-works/chord": "1.4.0" } });
	assert.throws(() => inspectOfficialPi(directory, "1.4.0"), /Unreviewed official runtime dependency: @earendil-works\/pi-coding-agent -> @earendil-works\/chord/);
});

test("actual startup networking and broken SDK exports are rejected without installation", (t) => {
	for (const code of ["await fetch('https://example.invalid');", "export const VERSION='1.1.0';"]) {
		const directory = scratch(t);
		fixture(directory);
		writeFileSync(join(directory, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"), code);
		assert.throws(() => installOfficialPi({ stockRoot: directory, version: "1.1.0", check: true }), /EVAL_NETWORK_FORBIDDEN|OFFICIAL_PI_SDK_MISMATCH/);
	}
});

test("failed npm and SDK probes preserve failure instead of claiming a ready host", (t) => {
	const directory = scratch(t);
	assert.throws(() => installOfficialPi({ stockRoot: directory, version: "1.1.0" }, () => ({ status: 1, stderr: "synthetic install failure" })), /Official cohort installation failed/);
	fixture(directory);
	assert.throws(() => installOfficialPi({ stockRoot: directory, version: "1.1.0" }, () => ({ status: 1, stderr: "synthetic missing export" })), /SDK startup failed/);
	assert.throws(() => installOfficialPi({ stockRoot: directory, version: "1.1.0" }, () => ({ status: 0, stdout: "wrong marker" })), /did not confirm readiness/);
});

test("an unrelated project is never used as an installation destination", (t) => {
	const directory = scratch(t);
	writeJson(join(directory, "package.json"), { dependencies: { "user-package": "1.0.0" } });
	assert.throws(() => installOfficialPi({ stockRoot: directory, version: "1.1.0" }, () => assert.fail("npm must not run")), /unrelated project/);
});

test("invalid CLI versions fail before any npm call and help needs no installation", () => {
	const invalid = spawnSync(process.execPath, [script, "--version", "1.5.0", "--stock-root", "/unused"], { encoding: "utf8" });
	assert.equal(invalid.status, 2);
	assert.match(invalid.stderr, /Unsupported official Pi version/);
	const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /--stock-root/);
});
