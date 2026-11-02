import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER_HOSTS, assertFinalMainWorkflows, assertReleaseNotes, compareReleaseVersions, crossVersionChecks, hostList, isStrictRelease, minimumAcceptanceChecks, NPM_CLI_VERSION, NPM_PACKAGES, NPM_RELEASE, npmArchives, npmRelease, parseReviewedVersion, publishesPackage, releaseAssetAction, releaseChanges, releaseNotes, releasePiVersions, releasePlan, scenarioProfile, selectReviewedSourceTag } from "./context-memory-preview-release-checks.mjs";
import { PROFILE, VERSION } from "./context-memory-preview-acceptance-profile.mjs";
import { PRIMARY_PI_VERSION, SUPPORTED_PI_VERSIONS } from "../packages/coding-agent/src/extensions/context-memory/preview/compatibility.ts";

/** Released stable versions held to strict scenarios, and the next ones, which need no list entry. */
const STRICT_RELEASES = ["0.4.0", "0.4.1", "0.4.2", "0.4.3", "0.5.0"];
/** Host declarations recorded by each released tag's build metadata. */
const HISTORICAL_BUILDS = {
	"0.3.3": { supportedPi: "1.1.0" },
	"0.4.0": { supportedPi: "1.1.0" },
	"0.4.1": { supportedPi: "1.1.0" },
	"0.4.2": { supportedPi: "1.2.0", supportedPiVersions: ["1.2.0", "1.1.0"] },
};
function hostsFor(version) {
	return releasePiVersions(HISTORICAL_BUILDS[version] ?? { supportedPi: PRIMARY_PI_VERSION, supportedPiVersions: SUPPORTED_PI_VERSIONS });
}

test("reviewed versions retain exact stable and positive numbered-preview spellings", () => {
	for (const version of ["0.3.3", "0.4.0", "0.4.0-preview.1", "12.34.56-preview.123", "0.0.0"]) {
		const parsed = parseReviewedVersion(version);
		assert.equal(parsed.version, version);
		assert.equal(parsed.tag, `v${version}`);
		assert.equal(parsed.packageTag, `extension-v${version}`);
		assert.equal(parsed.preview, version.includes("-preview."));
		assert.equal(parsed.previewNumber, version.split("-preview.")[1] ?? null);
		assert(Object.isFrozen(parsed));
	}
});

test("unreviewed suffixes, noncanonical counters and lossy version spellings are rejected", () => {
	for (const version of [
		undefined, null, 4, "", "v0.4.0", "0.4", "0.4.0-preview", "0.4.0-preview.0", "0.4.0-preview.01",
		"0.4.0-preview.-1", "0.4.0-preview.+1", "0.4.0-preview.1.0", "0.4.0-preview.1-extra",
		"0.4.0-alpha.1", "0.4.0-rc.1", "0.4.0-preview.1+build", "0.4.0+build", "00.4.0", "0.04.0", "0.4.00",
		" 0.4.0", "0.4.0 ", "0.4.0\n", "0.4.0-preview.1\r\n", "0.4.0-preview.1\u0000",
	]) assert.throws(() => parseReviewedVersion(version), /Expected a reviewed release version/);
});

test("source selection accepts only exact reviewed existing source-tag forms", () => {
	for (const tag of ["v0.3.3", "v0.4.0", "v0.4.0-preview.1"]) {
		assert.equal(selectReviewedSourceTag({ triggerRef: tag }), tag);
		assert.equal(selectReviewedSourceTag({ requestedTag: "", triggerRef: `release/publish-${tag}` }), tag);
		assert.equal(selectReviewedSourceTag({ requestedTag: tag, triggerRef: "main" }), tag);
	}
	for (const triggerRef of [undefined, "main", "extension-v0.4.0-preview.1", "refs/tags/v0.4.0-preview.1", "release/publish-release/publish-v0.4.0-preview.1", "release/publish-v0.4.0-preview.0", "v0.4.0-preview.1\n"]) {
		assert.throws(() => selectReviewedSourceTag({ triggerRef }));
	}
	for (const requestedTag of ["release/publish-v0.4.0-preview.1", "v0.4.0-rc.1", " v0.3.3", 4]) {
		assert.throws(() => selectReviewedSourceTag({ requestedTag, triggerRef: "v0.3.3" }));
	}
});

test("publication workflow preserves version-aware installation and historical source selection", () => {
	const document = parseDocument(readFileSync(new URL("../.github/workflows/context-memory-preview-release.yml", import.meta.url), "utf8"));
	assert.deepEqual(document.errors, []);
	const steps = document.toJS().jobs.publish.steps;
	const selector = steps.find((step) => step.id === "source");
	const selection = selector.run.slice(0, selector.run.indexOf("git fetch origin main"));
	assert.match(selection, /selectReviewedSourceTag/);
	assert.match(selector.run, /context-memory-preview-stock-install\.mjs.*context-preview-publisher\/scripts\//);
	assert.match(selector.run, /cp eval\/deny-network\.mjs.*context-preview-publisher\/eval\//);
	assert.match(selector.run, /context-memory-preview-acceptance-profile\.mjs/);
	const cwd = fileURLToPath(new URL("../", import.meta.url));
	for (const [ref, accepted] of [["v0.3.3", true], ["release/publish-v0.4.0-preview.1", true], ["v0.4.0-preview.0", false], ["v0.4.0-preview.1\n", false], ["v0.4.0-rc.1", false]]) {
		const result = spawnSync("bash", ["-e", "-c", `${selection}\nprintf '%s' "$selected_tag"`], {
			cwd, encoding: "utf8", env: { ...process.env, PI_CONTEXT_REQUESTED_TAG: "", PI_CONTEXT_TRIGGER_REF: ref },
		});
		assert.equal(result.status === 0, accepted, ref);
		if (accepted) assert.equal(result.stdout, selectReviewedSourceTag({ triggerRef: ref }));
	}
	const plan = steps.find((step) => step.id === "plan");
	assert.match(plan.run, /context-preview-publisher\/scripts\/context-memory-preview-release-checks\.mjs" --plan \.artifacts\/context-memory-preview-package --source-tag "\$PI_CONTEXT_SOURCE_TAG" >> "\$GITHUB_OUTPUT"/);
	assert.equal(plan.env.PI_CONTEXT_SOURCE_TAG, "${{ steps.source.outputs.source_tag }}");
	const sourceRelease = steps.find((step) => step.name === "Record a source release without publishing the extension");
	assert.equal(sourceRelease.if, "steps.plan.outputs.publish == 'false'");
	assert.match(sourceRelease.run, /::notice /);
	assert.match(sourceRelease.run, /GITHUB_STEP_SUMMARY/);
	// Only an explicit source-release decision skips; a missing output must still run every gate and the publisher.
	// The npm steps also skip only on an explicit npm=false, which candidates before 0.7.5 report.
	const npmSteps = ["Build the OpenCode and DSH packages", "Install each package by name on official OpenCode and DSH", "Install the npm client publication requires"];
	for (const step of steps.slice(steps.indexOf(plan) + 1)) {
		if (step === sourceRelease) continue;
		assert.equal(step.if, npmSteps.includes(step.name) ? "steps.plan.outputs.publish != 'false' && steps.plan.outputs.npm != 'false'" : "steps.plan.outputs.publish != 'false'", step.name);
	}
	assert.deepEqual(npmSteps.map((name) => steps.findIndex((step) => step.name === name)).every((index, i, all) => index > steps.indexOf(plan) && (i === 0 || index > all[i - 1])), true, "npm steps must run in order after the plan");
	assert.match(steps.find((step) => step.name === npmSteps[1]).run, /context-memory-adapters-acceptance\.mjs --hosts-root/);
	assert.match(steps.find((step) => step.name === npmSteps[2]).run, /test -n "\$PLAN_NPM_CLI"/);
	assert.equal(document.toJS().permissions["id-token"], "write");
	const install = steps.find((step) => step.name === "Install every official Pi host the candidate declares");
	assert.match(install.run, /context-preview-publisher\/scripts\/context-memory-preview-stock-install\.mjs/);
	assert.match(install.run, /for host in \$PLAN_HOSTS/);
	assert.match(install.run, /--version "\$host"/);
	assert.doesNotMatch(install.run, /npm install/);
	const publish = steps.find((step) => step.name === "Publish checked package and source archives");
	assert.match(publish.run, /context-preview-publisher\/scripts\/context-memory-preview-release\.mjs" --publish/);
	assert.equal(publish.env.NODE_AUTH_TOKEN, "${{ secrets.NPM_TOKEN }}");
	assert(steps.indexOf(publish) > steps.findIndex((step) => step.name === npmSteps[2]), "npm acceptance precedes publication");
	const acceptance = steps.find((step) => step.name === "Verify the release package on stock Pi");
	assert.match(acceptance.run, /--compatible-stock-root/);
	assert.match(acceptance.run, /context-memory-preview-acceptance-\$host/);
	const scope = steps.find((step) => step.name === "Verify final release scenarios");
	assert.match(scope.run, /if \[ -n "\$PLAN_PROFILE" \]/);
	assert.match(scope.run, /--version "\$PLAN_OTHER"/);
	assert.match(scope.run, /context-memory-preview-scenarios\.mjs.*--acceptance-profile "\$PLAN_PROFILE"/);
	// Step outputs reach the shell through the environment, and no step branches on a literal version again.
	for (const step of steps) {
		if (!step.run) continue;
		assert.doesNotMatch(step.run, /\$\{\{\s*steps\./, `${step.name ?? step.id} interpolates a step output into its script`);
		assert.doesNotMatch(step.run, /candidate_version|--version 1\.|acceptance-1\.\d/, `${step.name ?? step.id} hardcodes a release or host version`);
	}
});

test("the plan reads every declared host from the candidate and fails closed on an unreviewed one", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-preview-plan-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const write = (manifest, build) => {
		writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
		writeFileSync(join(directory, "preview-build.json"), JSON.stringify(build));
	};
	const script = fileURLToPath(new URL("./context-memory-preview-release-checks.mjs", import.meta.url));
	write({ version: "0.4.3" }, { version: "0.4.3", supportedPi: "1.4.0", supportedPiVersions: ["1.4.0", "1.3.0", "1.2.0", "1.1.0"] });
	const result = spawnSync(process.execPath, [script, "--plan", directory], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "hosts=1.4.0 1.3.0 1.2.0 1.1.0\nprofile=strict\nother=1.0.4\nnpm=false\nnpm_cli=\n");
	write({ version: NPM_RELEASE }, { version: NPM_RELEASE, supportedPi: "1.4.0", supportedPiVersions: ["1.4.0", "1.3.0", "1.2.0", "1.1.0"] });
	assert.equal(spawnSync(process.execPath, [script, "--plan", directory], { encoding: "utf8" }).stdout, `hosts=1.4.0 1.3.0 1.2.0 1.1.0\nprofile=strict\nother=1.0.4\nnpm=true\nnpm_cli=${NPM_CLI_VERSION}\n`);
	write({ version: "0.4.3" }, { version: "0.4.3", supportedPi: "1.5.0", supportedPiVersions: ["1.5.0", "1.4.0"] });
	assert.notEqual(spawnSync(process.execPath, [script, "--plan", directory], { encoding: "utf8" }).status, 0);
	assert.equal(spawnSync(process.execPath, [script, "--plan"], { encoding: "utf8" }).status, 2);
	assert.throws(() => releasePlan({ manifest: { version: "0.4.3" }, build: { version: "0.4.2", supportedPi: "1.2.0" } }), /packaged version/);
});

test("a source tag publishes its own extension version and skips only one already published", (t) => {
	const isPublished = (packageTag) => packageTag === "extension-v0.6.0";
	assert.equal(publishesPackage({ sourceTag: "v0.6.0", version: "0.6.0", isPublished: () => assert.fail("a matching tag needs no lookup") }), true);
	assert.equal(publishesPackage({ sourceTag: "v0.7.0", version: "0.6.0", isPublished }), false);
	assert.throws(() => publishesPackage({ sourceTag: "v0.6.2", version: "0.6.1", isPublished }), /unpublished extension 0\.6\.1; tag v0\.6\.1/);
	for (const sourceTag of [undefined, "", "0.7.0", "release/publish-v0.7.0", "v0.7.0-rc.1"]) {
		assert.throws(() => publishesPackage({ sourceTag, version: "0.6.0", isPublished }), String(sourceTag));
	}

	const directory = mkdtempSync(join(tmpdir(), "pi-preview-scope-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const git = (...args) => assert.equal(spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd: directory, encoding: "utf8" }).status, 0, args.join(" "));
	git("init", "--quiet");
	git("commit", "--quiet", "--allow-empty", "-m", "seed");
	git("tag", "extension-v0.6.0");
	git("remote", "add", "origin", directory);
	const packageDir = join(directory, "package");
	mkdirSync(packageDir);
	const plan = (version, ...args) => {
		writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version }));
		writeFileSync(join(packageDir, "preview-build.json"), JSON.stringify({ version, supportedPi: PRIMARY_PI_VERSION, supportedPiVersions: SUPPORTED_PI_VERSIONS }));
		return spawnSync(process.execPath, [fileURLToPath(new URL("./context-memory-preview-release-checks.mjs", import.meta.url)), "--plan", packageDir, ...args], { cwd: directory, encoding: "utf8" });
	};
	const base = plan("0.6.0");
	assert.equal(base.status, 0, base.stderr);
	assert.doesNotMatch(base.stdout, /publish=/);
	assert.equal(plan("0.6.0", "--source-tag", "v0.7.0").stdout, `${base.stdout}publish=false\npackage_tag=extension-v0.6.0\n`);
	assert.equal(plan("0.6.0", "--source-tag", "v0.6.0").stdout, `${base.stdout}publish=true\npackage_tag=extension-v0.6.0\n`);
	const unpublished = plan("0.6.1", "--source-tag", "v0.7.0");
	assert.notEqual(unpublished.status, 0);
	assert.match(unpublished.stderr, /unpublished extension 0\.6\.1/);
	for (const args of [["--source-tag"], ["--tag", "v0.7.0"], ["--source-tag", "v0.7.0", "extra"]]) assert.equal(plan("0.6.0", ...args).status, 2, args.join(" "));
});

test("historical tags keep their own host contract and the current source declares its full matrix", () => {
	assert.deepEqual(hostsFor("0.4.2"), ["1.2.0", "1.1.0"]);
	for (const version of ["0.3.3", "0.4.0", "0.4.1"]) assert.deepEqual(hostsFor(version), ["1.1.0"]);
	assert.deepEqual(releasePiVersions({ supportedPi: PRIMARY_PI_VERSION, supportedPiVersions: SUPPORTED_PI_VERSIONS }), SUPPORTED_PI_VERSIONS);
	for (const build of [
		undefined, {}, { supportedPiVersions: [] }, { supportedPi: "1.2.0", supportedPiVersions: ["1.1.0", "1.2.0"] },
		{ supportedPi: "1.2.0", supportedPiVersions: ["1.2.0", "1.2.0"] }, { supportedPi: "1.5.0" }, { supportedPi: "1.2.0", supportedPiVersions: ["1.2.0", "1.0.4"] },
	]) assert.throws(() => releasePiVersions(build));
});

test("versions order numerically, previews precede their release, and later releases are strict", () => {
	assert.equal(compareReleaseVersions("0.4.10", "0.4.9"), 1);
	assert.equal(compareReleaseVersions("0.4.0-preview.1", "0.4.0"), -1);
	assert.equal(compareReleaseVersions("0.4.0-preview.2", "0.4.0-preview.10"), -1);
	assert.equal(compareReleaseVersions("0.4.2", "0.4.2"), 0);
	for (const version of STRICT_RELEASES) {
		assert.equal(isStrictRelease(version), true, version);
		assert.equal(scenarioProfile(version), "strict", version);
	}
	assert.equal(scenarioProfile(VERSION), PROFILE);
	for (const version of ["0.3.1", "0.3.3"]) assert.equal(scenarioProfile(version), null, version);
});

test("acceptance floors grow with each cross-version host and cross-version names stay exact", () => {
	assert.equal(minimumAcceptanceChecks("0.4.1"), 26);
	assert.equal(minimumAcceptanceChecks("0.4.2", 1), 30);
	assert.equal(minimumAcceptanceChecks("0.4.2"), 28);
	assert.equal(minimumAcceptanceChecks("0.4.3", 2), 32);
	// From 0.7.5 each Pi host also installs, runs and removes the npm archive.
	assert.equal(minimumAcceptanceChecks("0.7.4", 3), 34);
	assert.equal(minimumAcceptanceChecks(NPM_RELEASE, 3), 37);
	assert.equal(minimumAcceptanceChecks("0.8.0"), 31);
	assert.equal(npmRelease("0.7.4"), false);
	assert.equal(npmRelease(NPM_RELEASE), true);
	assert.deepEqual(crossVersionChecks(["1.2.0", "1.1.0"]).map((check) => [check.older, check.primary]), [[
		"compatible official Pi 1.1.0 reopens and compacts the primary host checkpoint",
		["primary host reopens the Pi 1.1.0 checkpoint", "primary host reopens the compatible host checkpoint"],
	]]);
	assert.deepEqual(crossVersionChecks(["1.3.0", "1.2.0", "1.1.0"]).map((check) => check.primary), [["primary host reopens the Pi 1.2.0 checkpoint"], ["primary host reopens the Pi 1.1.0 checkpoint"]]);
	assert.deepEqual([["1.1.0"], ["1.2.0", "1.1.0"], ["1.3.0", "1.2.0", "1.1.0"], ["1.4.0", "1.3.0", "1.2.0", "1.1.0"]].map(hostList), ["1.1.0", "1.2.0 and 1.1.0", "1.3.0, 1.2.0 and 1.1.0", "1.4.0, 1.3.0, 1.2.0 and 1.1.0"]);
});

test("local preparation can use Unreleased without authorizing publication from it", () => {
	const changelog = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New compatibility.\n\n## [v0.4.1] — past\n\n- Earlier changes.\n";
	assert.equal(releaseChanges(changelog, "v0.4.2", true), "### Added\n\n- New compatibility.");
	assert.throws(() => releaseChanges(changelog, "v0.4.2"), /own changelog section/);
	assert.equal(releaseChanges(changelog, "v0.4.1"), "- Earlier changes.");
});

test("main CI requires strict scenarios without removing other gates", () => {
	const document = parseDocument(readFileSync(new URL("../.github/workflows/context-memory.yml", import.meta.url), "utf8"));
	assert.deepEqual(document.errors, []);
	const runs = document.toJS().jobs.verify.steps.flatMap((step) => step.run ? [step.run] : []);
	assert(runs.some((run) => run.includes("context-memory-preview-release-checks.mjs --plan")));
	assert(runs.some((run) => run.includes("for host in $PLAN_HOSTS") && run.includes("context-memory-preview-stock-install.mjs")));
	assert(runs.some((run) => run.includes("--compatible-stock-root")));
	assert(runs.some((run) => run.includes("context-memory-preview-acceptance-$host")));
	assert(!runs.some((run) => /--version 1\.|acceptance-1\.\d/.test(run)), "Main CI must read its hosts from the candidate");
	assert(runs.some((run) => run.includes("context-memory-preview-scenarios.mjs") && run.includes("--acceptance-profile strict")));
	assert(!runs.some((run) => run.includes(`--acceptance-profile ${PROFILE}`)));
	for (const required of ["context-memory-check.mjs", "security-regression-check.mjs", "context-memory-preview-acceptance.mjs", "context-memory-preview-release.mjs --prepare", "eval/check.mjs"]) {
		assert(runs.some((run) => run.includes(required)), `Missing CI gate: ${required}`);
	}
});

test("a push to main runs verify for Markdown alone, so publication can accept any main commit", () => {
	const jobs = parseDocument(readFileSync(new URL("../.github/workflows/context-memory.yml", import.meta.url), "utf8")).toJS().jobs;
	assert.equal(jobs.verify.if, "needs.scope.outputs.docs_only != 'true'");
	const script = jobs.scope.steps.find((step) => step.id === "diff").run;
	const root = mkdtempSync(join(tmpdir(), "context-memory-scope-"));
	try {
		const repo = join(root, "repo");
		mkdirSync(join(repo, "docs"), { recursive: true });
		const git = (...args) => {
			const result = spawnSync("git", ["-c", "user.name=scope", "-c", "user.email=scope@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		git("init", "-q");
		writeFileSync(join(repo, "README.md"), "base\n");
		git("add", ".");
		git("commit", "-qm", "base");
		const before = git("rev-parse", "HEAD");
		git("update-ref", "refs/remotes/origin/main", before);
		writeFileSync(join(repo, "docs", "guide.md"), "guide\n");
		git("add", ".");
		git("commit", "-qm", "docs");
		const scope = (event) => {
			const output = join(root, `${event}.out`);
			writeFileSync(output, "");
			const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
				cwd: repo, encoding: "utf8", env: { ...process.env, EVENT: event, BASE_REF: "main", BEFORE: before, GITHUB_OUTPUT: output },
			});
			assert.equal(result.status, 0, result.stderr);
			return readFileSync(output, "utf8").trim();
		};
		assert.equal(scope("pull_request"), "docs_only=true");
		assert.equal(scope("push"), "docs_only=false");
		assert.equal(scope("workflow_dispatch"), "docs_only=false");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("newer Node majors run verify outside the workflow that gates publication", () => {
	const read = (file) => {
		const document = parseDocument(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
		assert.deepEqual(document.errors, []);
		return document.toJS();
	};
	const steps = Object.values(read("context-memory.yml").jobs).flatMap((job) => job.steps);
	const nodes = steps.filter((step) => step.uses?.startsWith("actions/setup-node@")).map((step) => step.with["node-version"]);
	assert(nodes.length > 0 && nodes.every((node) => node === "22"), "Every job of the publication-gating workflow runs Node 22");
	const jobs = Object.values(read("context-memory-newer-node.yml").jobs);
	assert.equal(jobs.length, 1);
	const [job] = jobs;
	assert.deepEqual(job.strategy.matrix.node, ["24", "26"]);
	assert.deepEqual(job.env, { PI_OFFLINE: "1", EVAL_PROVIDER_MODE: "scripted", EVAL_MODEL_CALL_BUDGET: "0" });
	for (const step of job.steps.filter((entry) => entry.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/);
	assert.equal(job.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"], 0);
	assert(job.steps.some((step) => step.run?.startsWith("node scripts/context-memory-ops.mjs verify")));
});

test("ops rejects ambiguous or misplaced acceptance-profile flags before running a pipeline", () => {
	const script = fileURLToPath(new URL("./context-memory-ops.mjs", import.meta.url));
	for (const args of [["verify", "--acceptance-profile", PROFILE], ["preview", "--acceptance-profile"], ["ci", "--acceptance-profile", "unapproved"], ["ci", "--acceptance-profile", PROFILE, "--acceptance-profile", PROFILE]]) {
		const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
		assert.equal(result.status, 2);
		assert.doesNotMatch(result.stdout, /^== /m);
	}
});

const sourceCommit = "534c8994ed17539ac97ed5712c36efe01268dffb";
// GitHub's default CodeQL setup reports event=dynamic, including scans of main.
const mainRuns = [
	{ head_sha: sourceCommit, head_branch: "main", path: ".github/workflows/context-memory.yml", event: "push", status: "completed", conclusion: "success" },
	{ head_sha: sourceCommit, head_branch: "main", path: "dynamic/github-code-scanning/codeql", event: "dynamic", status: "completed", conclusion: "success" },
];

test("completed default CodeQL and push verification both satisfy the release gate", () => {
	assert.doesNotThrow(() => assertFinalMainWorkflows(mainRuns, sourceCommit));
});

test("a scan of another source commit, tag or workflow cannot replace the main scan", () => {
	for (const replacement of [{ head_sha: "0".repeat(40) }, { head_branch: "v0.3.1" }, { path: ".github/workflows/another.yml" }]) {
		assert.throws(() => assertFinalMainWorkflows([mainRuns[0], { ...mainRuns[1], ...replacement }], sourceCommit));
	}
});

test("a missing, failed or unfinished main workflow blocks publication", () => {
	for (const index of [0, 1]) {
		assert.throws(() => assertFinalMainWorkflows(mainRuns.filter((_, i) => i !== index), sourceCommit));
		for (const replacement of [{ status: "in_progress", conclusion: null }, { conclusion: "failure" }]) {
			assert.throws(() => assertFinalMainWorkflows(mainRuns.map((run, i) => i === index ? { ...run, ...replacement } : run), sourceCommit));
		}
	}
});

test("manual verification cannot replace the final main push verification", () => {
	assert.throws(() => assertFinalMainWorkflows([{ ...mainRuns[0], event: "workflow_dispatch" }, mainRuns[1]], sourceCommit));
});

const repository = "youxi-huang/slice";
const noteOptions = { repository, packageTag: "extension-v0.3.3", branch: "extension-preview", hosts: hostsFor("0.3.3") };
const scenarioAcceptance = { profile: PROFILE, version: VERSION, accepted: true, rawPassed: false, exceptions: [
	{ id: "long-session-overhead/per-request-budget", status: "known-gap", criterion: "per-request-budget", pi: "1.1.0" },
	{ id: "long-session-overhead/bounded-growth", status: "fail", criterion: "checkpoint-overhead-growth-required", pi: "1.1.0" },
] };
const notes = releaseNotes({ ...noteOptions, tag: "v0.3.3", sourceCommit, build: "stock-preview+src.0000000000000000", acceptanceChecks: 27, changes: "### Fixed\n\n- Synthetic entry." });

test("generated release notes install the fixed package tag alone in their first block", () => {
	assert.doesNotThrow(() => assertReleaseNotes(notes, noteOptions));
	assert.match(notes, /```sh\npi install git:github\.com\/youxi-huang\/slice@extension-v0\.3\.3\n```/);
	assert.doesNotMatch(notes, /147 context checks|83 scenario checks/);
	assert.match(notes, /Resident runtime keeps its v0\.3\.0 fingerprint/);
	assert.doesNotMatch(notes, /experimental A-stage|full A\/B comparison/);
});

test("numbered previews disclose deferred scope and failed performance without claiming benefits", () => {
	const previewOptions = { ...noteOptions, packageTag: "extension-v0.4.0-preview.1" };
	const previewNotes = releaseNotes({ ...previewOptions, tag: "v0.4.0-preview.1", sourceCommit, build: "stock-preview+src.0000000000000000", acceptanceChecks: 27, changes: "### Added\n\n- Synthetic A-stage candidate.", scenarioAcceptance });
	assert.doesNotThrow(() => assertReleaseNotes(previewNotes, { ...previewOptions, scenarioAcceptance }));
	assert.match(previewNotes, /\*\*experimental A-stage preview candidate\*\*/);
	assert.match(previewNotes, /opt-in preparation using the same configured writer; it is \*\*disabled by default\*\*/);
	assert.match(previewNotes, /B, the new instruction-authority protocol and the full A\/B comparison are incomplete and deferred/);
	assert.match(previewNotes, /Improvements in foreground pause, total cost or recovery have not been established/);
	assert.match(previewNotes, /profile applies \*\*only to v0\.4\.0-preview\.1\*\*/);
	assert.match(previewNotes, /Raw scenario gate: failed/);
	assert.match(previewNotes, /long-session-overhead\/bounded-growth` \(fail\)/);
	assert.match(previewNotes, /long-session-overhead\/per-request-budget` \(known-gap\)/);
	assert.match(previewNotes, /full v0\.4\.0 gates are unchanged/);
	assert.match(previewNotes, /Pi's built-in background cache warming/);
	assert.match(previewNotes, /Resident release version remains v0\.3\.0; shared-validation source identity and frozen comparison are tracked separately/);
	assert.doesNotMatch(previewNotes, /Resident runtime keeps its v0\.3\.0 fingerprint|growth check (?:has )?passed|50 ms per-request target (?:has )?passed/);
});

test("functional-preview notes require the authorized profile and every raw-exception disclosure", () => {
	const options = { ...noteOptions, tag: `v${VERSION}`, packageTag: `extension-v${VERSION}`, sourceCommit, build: "stock-preview+src.0000000000000000", acceptanceChecks: 27, changes: "Synthetic." };
	for (const invalid of [undefined, { ...scenarioAcceptance, version: "0.4.0-preview.2" }, { ...scenarioAcceptance, profile: "strict" }, { ...scenarioAcceptance, accepted: false }]) {
		assert.throws(() => releaseNotes({ ...options, scenarioAcceptance: invalid }));
	}
	const generated = releaseNotes({ ...options, scenarioAcceptance });
	for (const removed of ["Raw scenario gate: failed.", "full v0.4.0 gates are unchanged", "correctness, security, persistence, identity, package and source checks must pass", "`long-session-overhead/bounded-growth` (fail)"]) {
		assert.throws(() => assertReleaseNotes(generated.replace(removed, ""), { ...options, scenarioAcceptance }));
	}
});

for (const version of STRICT_RELEASES) test(`v${version} notes describe both opt-in arms, threshold compaction and strict exact-package evidence`, () => {
	const acceptance = { profile: "strict", version, accepted: true, rawPassed: true, exceptions: [] };
	const options = { ...noteOptions, hosts: hostsFor(version), tag: `v${version}`, packageTag: `extension-v${version}`, sourceCommit, build: "stock-preview+src.0000000000000000", acceptanceChecks: 27, changes: "Synthetic.", scenarioAcceptance: acceptance };
	const generated = releaseNotes(options);
	assert.doesNotThrow(() => assertReleaseNotes(generated, options));
	assert.match(generated, /two arms, both \*\*disabled by default\*\*/);
	assert.match(generated, /B carries covered user messages in full/);
	assert.match(generated, /Every writer call is journaled/);
	assert.match(generated, /Pi's threshold compaction after completed text turns/);
	assert.match(generated, /overflow recovery still requires explicit \/compact/);
	assert.match(generated, /strict acceptance and no performance exceptions or known gaps/);
	if (version === "0.4.2") assert.match(generated, /unmodified official Pi 1\.2\.0 and 1\.1\.0\*\*/);
	assert(generated.includes(`unmodified official Pi ${hostList(hostsFor(version))}**`));
	assert(generated.includes(`scenario suite on Pi ${hostsFor(version)[0]} with`));
	assert.throws(() => assertReleaseNotes(generated, { ...options, hosts: ["1.4.0"] }), /every accepted official host/);
	assert.doesNotMatch(generated, /A-stage|B.*incomplete and deferred|automatic compaction is cancelled/);
	if (version === "0.4.1") assert.match(generated, /its build fingerprint changes with the one-line note fold/);
	else assert.match(generated, /Resident runtime keeps its v0\.3\.0 fingerprint/);
	for (const removed of ["strict acceptance and no performance exceptions or known gaps", "Pi's threshold compaction after completed text turns", "B carries covered user messages in full", "real-provider pause, total cost, cache behavior and recovery benefits remain unproven"]) {
		assert.throws(() => assertReleaseNotes(generated.replace(removed, ""), options));
	}
});

for (const version of STRICT_RELEASES) test(`v${version} cannot reuse preview waivers, another package's acceptance or failed raw gates`, () => {
	const accepted = { profile: "strict", version, accepted: true, rawPassed: true, exceptions: [] };
	const options = { ...noteOptions, hosts: hostsFor(version), tag: `v${version}`, packageTag: `extension-v${version}`, sourceCommit, build: "stock-preview+src.0000000000000000", acceptanceChecks: 27, changes: "Synthetic." };
	const other = STRICT_RELEASES.find((entry) => entry !== version);
	for (const invalid of [undefined, scenarioAcceptance, { ...accepted, version: "0.3.3" }, { ...accepted, version: other }, { ...accepted, profile: PROFILE }, { ...accepted, accepted: false }, { ...accepted, rawPassed: false }, { ...accepted, exceptions: scenarioAcceptance.exceptions }]) {
		assert.throws(() => releaseNotes({ ...options, scenarioAcceptance: invalid }));
	}
});

test("release notes reject mismatched or unreviewed source and package tags", () => {
	assert.throws(() => releaseNotes({ ...noteOptions, tag: "v0.4.0-preview.0" }));
	assert.throws(() => releaseNotes({ ...noteOptions, tag: "v0.4.0-preview.1" }));
	assert.throws(() => releaseNotes({ ...noteOptions, tag: "release/publish-v0.3.3" }));
});

test("install, update and remove commands may not share a copyable block", () => {
	const combined = "```sh\npi install git:github.com/youxi-huang/slice@extension-v0.3.3\npi update --extension git:github.com/youxi-huang/slice@extension-preview\n```\n";
	assert.throws(() => assertReleaseNotes(combined, noteOptions));
});

test("the first copyable block may not install the moving branch", () => {
	const moving = "```sh\npi install git:github.com/youxi-huang/slice@extension-preview\n```\n";
	assert.throws(() => assertReleaseNotes(moving, noteOptions));
});

test("npm releases install from npm first, keep the Git package and name every accepted OpenCode and DSH host", () => {
	const version = NPM_RELEASE;
	const acceptance = { profile: "strict", version, accepted: true, rawPassed: true, exceptions: [] };
	const options = { ...noteOptions, hosts: hostsFor(version), tag: `v${version}`, packageTag: `extension-v${version}`, sourceCommit, build: "stock-preview+src.0000000000000000", acceptanceChecks: 37, changes: "Synthetic.", scenarioAcceptance: acceptance, adapterHosts: ADAPTER_HOSTS };
	const generated = releaseNotes(options);
	assert.doesNotThrow(() => assertReleaseNotes(generated, options));
	assert.match(generated, new RegExp(`^SLICE v${version} supplies[^]*?\`\`\`sh\npi install npm:slice-pi@${version}\n\`\`\``));
	assert(generated.includes(`pi install git:github.com/${repository}@extension-v${version}`));
	assert(generated.includes(`{ "plugin": ["slice-opencode@${version}"] }`));
	assert(generated.includes(`dsh plugin --profile <profile> add slice-dsh@${version}`));
	assert(generated.includes(`official OpenCode ${hostList(ADAPTER_HOSTS.opencode)} and DSH ${hostList(ADAPTER_HOSTS.dsh)}`));
	assert.throws(() => releaseNotes({ ...options, adapterHosts: undefined }), /OpenCode and DSH hosts/);
	for (const removed of [`pi install git:github.com/${repository}@extension-v${version}`, `slice-opencode@${version}`, `add slice-dsh@${version}`]) {
		assert.throws(() => assertReleaseNotes(generated.replace(removed, ""), options));
	}
	const gitFirst = generated.replace(`pi install npm:slice-pi@${version}\n`, `pi install git:github.com/${repository}@extension-v${version}\n`);
	assert.throws(() => assertReleaseNotes(gitFirst, options), /fixed npm release/);
});

test("npm publication takes the packages in its own order, whatever order the adapter build reported", () => {
	// The adapter build reports DSH first; v0.7.5's first publication stopped on exactly that order.
	const built = [{ name: "slice-pi", archive: "slice-pi-0.7.5.tgz" }, { name: "slice-dsh", archive: "slice-dsh-0.7.5.tgz", sha256: "0" }, { name: "slice-opencode", archive: "slice-opencode-0.7.5.tgz" }];
	assert.deepEqual(npmArchives(built), NPM_PACKAGES.map((name) => ({ name, archive: `${name}-0.7.5.tgz` })));
	assert.throws(() => npmArchives(built.slice(0, 2)), /each once/);
	assert.throws(() => npmArchives([...built, built[1]]), /each once/);
	assert.throws(() => npmArchives([...built.slice(0, 2), { name: "slice-other", archive: "slice-other-0.7.5.tgz" }]), /each once/);
});

test("a retry replaces only the failed run's evidence on a draft and never an archive or a public asset", () => {
	const same = { digest: "sha256:aa" };
	const other = { digest: "sha256:bb" };
	assert.equal(releaseAssetAction({ file: "slice-pi-0.7.5.tgz", sha256: "aa", existing: same, draft: false }), "keep");
	assert.equal(releaseAssetAction({ file: "release-provenance.json", sha256: "aa", existing: same, draft: true }), "keep");
	assert.equal(releaseAssetAction({ file: "slice-dsh-0.7.5.tgz", sha256: "aa", draft: true }), "upload");
	assert.throws(() => releaseAssetAction({ file: "slice-dsh-0.7.5.tgz", sha256: "aa", draft: false }), /already public/);
	// The failed run's provenance names its tooling commit; the retry's names the commit with the fix.
	for (const file of ["release-provenance.json", "preview-acceptance-profile.json", "SHA256SUMS"]) {
		assert.equal(releaseAssetAction({ file, sha256: "aa", existing: other, draft: true }), "replace");
		assert.throws(() => releaseAssetAction({ file, sha256: "aa", existing: other, draft: false }), /never overwrite/);
	}
	for (const file of ["slice-pi-0.7.5.tgz", "slice-opencode-0.7.5.tgz", "pi-context-compaction-v0.7.5-source.tar.gz"]) {
		assert.throws(() => releaseAssetAction({ file, sha256: "aa", existing: other, draft: true }), /never overwrite/);
	}
	// An asset uploaded before GitHub recorded digests cannot be shown equal.
	assert.throws(() => releaseAssetAction({ file: "slice-pi-0.7.5.tgz", sha256: "aa", existing: { digest: null }, draft: true }), /never overwrite/);
});
