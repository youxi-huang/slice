import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startVitest } from "vitest/node";
import { parseOptions, run } from "./context-memory-host-run.mjs";
import { ADAPTER_HOSTS } from "./context-memory-preview-release-checks.mjs";

/** `dsh plugin` runs the pnpm on PATH; acceptance pins the release DSH's own repository uses. */
export const PNPM_VERSION = "11.28.5";
const OFFICIAL = { opencode: "opencode-ai", dsh: "@deepseek-ai/dsh" };

const root = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function npmInstall(prefix, spec, ignoreScripts) {
	if (existsSync(join(prefix, "node_modules", ".package-lock.json"))) return;
	mkdirSync(prefix, { recursive: true });
	const result = spawnSync(
		"npm",
		["install", "--prefix", prefix, "--save-exact", "--no-audit", "--no-fund", ...(ignoreScripts ? ["--ignore-scripts"] : []), spec],
		{ encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
	);
	if (result.status !== 0) throw new Error(`npm install ${spec} failed: ${result.stderr}`);
}

/** The installed official version, from the registry the lockfile records. */
function installedVersion(prefix, name) {
	const record = JSON.parse(readFileSync(join(prefix, "node_modules", ".package-lock.json"), "utf8")).packages[`node_modules/${name}`];
	assert(record?.resolved?.startsWith(`https://registry.npmjs.org/${name}/-/`), `${name} was not installed from npm`);
	assert.match(record.integrity, /^sha512-/);
	return record.version;
}

/** Installs each package by name on every host the release requires, then runs a loopback session there. */
export async function acceptAdapters({ packageRoot, hostsRoot, outputDir }) {
	const built = JSON.parse(readFileSync(join(packageRoot, "adapters-package-report.json"), "utf8"));
	rmSync(outputDir, { recursive: true, force: true });
	mkdirSync(outputDir, { recursive: true });
	const pnpm = join(hostsRoot, `pnpm-${PNPM_VERSION}`);
	npmInstall(pnpm, `pnpm@${PNPM_VERSION}`, false);
	const path = process.env.PATH;
	process.env.PATH = [join(pnpm, "node_modules", ".bin"), path].join(delimiter);
	const summary = { version: built.version, pnpm: PNPM_VERSION, packages: built.packages, runs: [], passed: false };
	const nextResult = spawnSync("npm", ["view", OFFICIAL.dsh, "dist-tags.next"], { encoding: "utf8" });
	assert.equal(nextResult.status, 0, nextResult.stderr);
	const writingVersions = new Set(["0.2.1-rc.5", nextResult.stdout.trim()]);
	const hosts = { ...ADAPTER_HOSTS, dsh: [...new Set([...ADAPTER_HOSTS.dsh, ...writingVersions])] };
	try {
		for (const [host, versions] of Object.entries(hosts)) {
			const item = built.packages.find((entry) => entry.host === host);
			assert(item, `No built ${host} package`);
			assert.equal(sha256(join(packageRoot, item.archive)), item.sha256, `${item.archive} changed after the build`);
			for (const version of versions) {
				const hostRoot = join(hostsRoot, `${host}-${version}`);
				npmInstall(hostRoot, `${OFFICIAL[host]}@${version}`, host === "opencode");
				const row = { host, version, package: `${item.name}@${built.version}` };
				summary.runs.push(row);
				const evidence = join(outputDir, `${host}-${version}`);
				// The session runs outside any Node project, as a user's does: this repository's own .npmrc, whose
				// min-release-age=2 holds back a version published that minute, must not reach the host's installer.
				const runDir = realpathSync(mkdtempSync(join(tmpdir(), "slice-adapter-run-")));
				try {
					assert(!runDir.startsWith(`${realpathSync(root)}${sep}`), "The session must run outside this repository");
					assert.equal(installedVersion(hostRoot, OFFICIAL[host]), version);
					if (host === "dsh") {
						// Use this loop's already installed and verified host; do not maintain another installer.
						const require = createRequire(join(hostRoot, "package.json"));
						const names = ["cordis", "dsh-compaction", "dsh-llm", "dsh-session", "dsh-session-persistence-jsonl", "dsh-session-format-catalog", "dsh-commands", "dsh-token-meter", "dsh-session-projection"];
						const alias = Object.fromEntries(names.map((name) => [`@deepseek-ai/${name}`, require.resolve(`@deepseek-ai/${name}`)]));
						const probes = await startVitest("test", ["packages/compaction-dsh/test/host-probes.test.ts", "packages/compaction-dsh/test/compaction.test.ts"], { root, config: false, watch: false }, { resolve: { alias } });
						try {
							assert.equal(probes.state.getFiles().length, 2);
							assert(probes.state.getFiles().every((file) => file.result?.state === "pass"), "DSH native and writing regressions failed");
							assert.equal(probes.state.getUnhandledErrors().length, 0);
						} finally { await probes.close(); }
					}
					const options = parseOptions(["--host", host, "--route", "200k", "--provider", "loopback", "--install", "registry", "--host-root", hostRoot, "--package-dir", join(packageRoot, item.directory), "--output-dir", runDir]);
					const report = await run(options, { dshWriting: host === "dsh" && writingVersions.has(version) }).finally(() => {
						mkdirSync(evidence, { recursive: true });
						for (const file of ["report.json", "turns.jsonl", "loopback.jsonl", "host.log"]) {
							if (existsSync(join(runDir, file))) cpSync(join(runDir, file), join(evidence, file));
						}
					});
					Object.assign(row, {
						archiveSha256: report.install.sha256,
						fetched: report.install.fetched,
						compactions: report.compactions.filter((entry) => entry.ok).length,
						historyResults: report.historyResults,
						stop: report.stop,
						...(report.writing ? { writing: report.writing, compactorConflict: report.compactorConflict } : {}),
					});
					assert.equal(report.install.sha256, item.sha256, "The host installed other bytes than the built archive");
					assert.equal(report.stop, null, `The session stopped: ${report.stop}`);
					assert(row.compactions >= 1, "The host never compacted natively");
					row.passed = true;
				} catch (error) {
					row.passed = false;
					row.error = error.message;
					// What the host asked the registry for, and the end of its own log, so a CI failure can be read.
					const reportFile = join(evidence, "report.json");
					if (existsSync(reportFile)) row.requests = JSON.parse(readFileSync(reportFile, "utf8")).install?.requests;
					const log = join(evidence, "host.log");
					if (existsSync(log)) row.hostLog = readFileSync(log, "utf8").split("\n").slice(-40).join("\n");
				} finally {
					rmSync(runDir, { recursive: true, force: true });
				}
				process.stdout.write(`${row.passed ? "PASS" : "FAIL"} ${row.package} on ${host} ${version}${row.error ? `: ${row.error}` : ""}\n`);
				if (!row.passed) process.stdout.write(`registry requests: ${JSON.stringify(row.requests ?? null)}\n${row.hostLog ?? "(no host log)"}\n`);
			}
		}
	} finally {
		process.env.PATH = path;
		summary.passed = summary.runs.length === Object.values(hosts).flat().length && summary.runs.every((row) => row.passed);
		writeFileSync(join(outputDir, "adapters-acceptance.json"), `${JSON.stringify(summary, null, 2)}\n`);
	}
	return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { "package-root": { type: "string" }, "hosts-root": { type: "string" }, "output-dir": { type: "string" } } });
	assert(values["hosts-root"], "Usage: node --experimental-strip-types scripts/context-memory-adapters-acceptance.mjs --hosts-root <dir> [--package-root .artifacts/host-adapters] [--output-dir .artifacts/adapters-acceptance]");
	const summary = await acceptAdapters({
		packageRoot: resolve(values["package-root"] ?? join(root, ".artifacts/host-adapters")),
		hostsRoot: resolve(values["hosts-root"]),
		outputDir: resolve(values["output-dir"] ?? join(root, ".artifacts/adapters-acceptance")),
	});
	if (!summary.passed) process.exitCode = 1;
}
