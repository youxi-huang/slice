import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OTHER_PI_VERSION, PROFILE, VERSION } from "./context-memory-preview-acceptance-profile.mjs";
import { OFFICIAL_PI_VERSIONS } from "./context-memory-preview-stock-install.mjs";

/** First release whose lifecycle suite has 28 checks per host, and two more per cross-version host. */
const CROSS_VERSION_SUITE = "0.4.2";
/**
 * First release published on npm too: the Pi extension as slice-pi, and the OpenCode and DSH packages as
 * slice-opencode and slice-dsh. Its lifecycle suite adds three npm checks on each Pi host.
 */
export const NPM_RELEASE = "0.7.5";
/** The npm client publication runs; trusted publishing from GitHub Actions needs 11.5.1 or later. */
export const NPM_CLI_VERSION = "11.21.1";
/** The npm names a release publishes, the Pi package first. */
export const NPM_PACKAGES = Object.freeze(["slice-pi", "slice-opencode", "slice-dsh"]);
/**
 * The official hosts an npm release installs the OpenCode and DSH packages on by name before publishing them: the
 * lowest version each package admits and the newest one tested.
 */
export const ADAPTER_HOSTS = Object.freeze({
	opencode: Object.freeze(["1.19.4", "1.19.5"]),
	dsh: Object.freeze(["0.2.1-rc.3", "0.2.1-rc.5"]),
});

/** Whether a reviewed version is published on npm as well as on Git. */
export function npmRelease(version) {
	return compareReleaseVersions(version, NPM_RELEASE) >= 0;
}

/** Local preparation can describe Unreleased; publication requires its versioned changelog. */
export function releaseChanges(changelog, tag, prepare = false) {
	const section = changelog.split(`## [${tag}]`)[1]?.split("\n## [")[0]
		?? (prepare ? changelog.split("## [Unreleased]")[1]?.split("\n## [")[0] : undefined);
	assert(section?.trim(), "Release requires its own changelog section");
	return section.replace(/^ —[^\n]*\n/, "").trim();
}

/** Only reviewed stable or numbered preview spellings; never normalize source refs. */
export function parseReviewedVersion(version) {
	assert.equal(typeof version, "string", "Expected a reviewed release version");
	const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-preview\.([1-9][0-9]*))?$/.exec(version);
	assert(match && match[0] === version, "Expected a reviewed release version");
	return Object.freeze({
		version,
		preview: match[4] !== undefined,
		previewNumber: match[4] ?? null,
		tag: `v${version}`,
		packageTag: `extension-v${version}`,
	});
}

/** Orders reviewed versions; a numbered preview precedes its stable release. */
export function compareReleaseVersions(left, right) {
	const [a, b] = [parseReviewedVersion(left), parseReviewedVersion(right)];
	const [x, y] = [a, b].map((value) => value.version.split("-")[0].split(".").map(Number));
	for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] < y[index] ? -1 : 1;
	if (a.preview !== b.preview) return a.preview ? -1 : 1;
	return a.preview ? Math.sign(Number(a.previewNumber) - Number(b.previewNumber)) : 0;
}

/**
 * Every release after the functional preview publishes only with the full strict scenario suite: no waiver,
 * performance exception or known gap. A new version needs no list entry to be held to it.
 */
export function isStrictRelease(version) {
	return compareReleaseVersions(version, VERSION) > 0;
}

/** The scenario profile publication requires, or null for releases that predate scenario acceptance. */
export function scenarioProfile(version) {
	if (parseReviewedVersion(version).version === VERSION) return PROFILE;
	return isStrictRelease(version) ? "strict" : null;
}

/**
 * The official hosts a candidate declares, primary first. Historical tags keep their original contract because
 * it is read from their own build metadata; every declared host must pass acceptance in the publication run.
 */
export function releasePiVersions(build) {
	const hosts = build?.supportedPiVersions ?? (typeof build?.supportedPi === "string" ? [build.supportedPi] : undefined);
	assert(Array.isArray(hosts) && hosts.length > 0, "Candidate must declare its supported official Pi versions");
	assert.equal(new Set(hosts).size, hosts.length, "Candidate declares a supported official Pi version twice");
	assert.equal(hosts[0], build.supportedPi, "The primary official Pi must be the first supported version");
	for (const host of hosts) {
		assert(OFFICIAL_PI_VERSIONS.includes(host), `Official Pi ${host} has no reviewed installation cohort`);
		assert.notEqual(host, OTHER_PI_VERSION, `Official Pi ${OTHER_PI_VERSION} is the unsupported scenario host`);
	}
	return Object.freeze([...hosts]);
}

/** Lifecycle checks one host report must hold: 26 before the cross-version suite, then 28 plus two per older host. */
export function minimumAcceptanceChecks(version, crossVersionHosts = 0) {
	const lifecycle = compareReleaseVersions(version, CROSS_VERSION_SUITE) < 0 ? 26 : 28 + 2 * crossVersionHosts;
	return lifecycle + (npmRelease(version) ? 3 : 0);
}

/**
 * The two checkpoint checks each older supported host adds to primary acceptance. A single older host may
 * carry the name used before more than one was supported.
 */
export function crossVersionChecks(hosts) {
	return hosts.slice(1).map((host) => Object.freeze({
		host,
		older: `compatible official Pi ${host} reopens and compacts the primary host checkpoint`,
		primary: Object.freeze([`primary host reopens the Pi ${host} checkpoint`, ...(hosts.length === 2 ? ["primary host reopens the compatible host checkpoint"] : [])]),
	}));
}

/** What the publication workflow runs, from the candidate's own package and build metadata. */
export function releasePlan({ manifest, build }) {
	const { version } = parseReviewedVersion(manifest?.version);
	assert.equal(build?.version, version, "Build metadata must describe the packaged version");
	return Object.freeze({ version, hosts: releasePiVersions(build), scenarioProfile: scenarioProfile(version), otherHost: OTHER_PI_VERSION });
}

/**
 * Whether a source tag publishes the extension it builds. A source release, such as the core-only v0.7.0, still
 * builds the last published extension version and publishes nothing; a tag beside an unpublished version stops.
 */
export function publishesPackage({ sourceTag, version, isPublished }) {
	const reviewed = parseReviewedVersion(version);
	if (selectReviewedSourceTag({ requestedTag: sourceTag }) === reviewed.tag) return true;
	assert.equal(isPublished(reviewed.packageTag), true, `${sourceTag} builds unpublished extension ${version}; tag ${reviewed.tag} to publish it`);
	return false;
}

/**
 * The plan as GitHub step outputs: hosts primary first, the scenario profile or empty, and the other host.
 * Given a source tag, also whether that tag publishes the package, and the package tag it would use.
 */
export function releasePlanOutputs(packageDir, { sourceTag, isPublished } = {}) {
	const read = (file) => JSON.parse(readFileSync(join(packageDir, file), "utf8"));
	const plan = releasePlan({ manifest: read("package.json"), build: read("preview-build.json") });
	const npm = npmRelease(plan.version);
	const outputs = `hosts=${plan.hosts.join(" ")}\nprofile=${plan.scenarioProfile ?? ""}\nother=${plan.otherHost}\nnpm=${npm}\nnpm_cli=${npm ? NPM_CLI_VERSION : ""}\n`;
	if (sourceTag === undefined) return outputs;
	const publish = publishesPackage({ sourceTag, version: plan.version, isPublished });
	return `${outputs}publish=${publish}\npackage_tag=${parseReviewedVersion(plan.version).packageTag}\n`;
}

/** "1.1.0", "1.2.0 and 1.1.0", "1.3.0, 1.2.0 and 1.1.0". */
export function hostList(hosts) {
	return hosts.length < 2 ? hosts.join("") : `${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}`;
}

export function selectReviewedSourceTag({ requestedTag, triggerRef }) {
	assert(requestedTag === undefined || typeof requestedTag === "string", "Expected an existing source tag");
	assert(triggerRef === undefined || typeof triggerRef === "string", "Expected an existing source ref");
	const tag = requestedTag || (triggerRef?.startsWith("release/publish-")
		? triggerRef.slice("release/publish-".length) : triggerRef);
	assert(typeof tag === "string" && tag.startsWith("v"), "Expected an existing reviewed source tag");
	return parseReviewedVersion(tag.slice(1)).tag;
}

export function assertFinalMainWorkflows(runs, sourceCommit) {
	for (const path of [".github/workflows/context-memory.yml", "dynamic/github-code-scanning/codeql"]) {
		assert(runs.some((run) => run.head_sha === sourceCommit && run.head_branch === "main"
			&& run.path === path && run.status === "completed" && run.conclusion === "success"
			&& (path !== ".github/workflows/context-memory.yml" || run.event === "push")),
		`Final main workflow has not passed: ${path}`);
	}
}

// The publication workflow copies only this module and the release script, so notes live here.
export function releaseNotes({ repository, branch, tag, packageTag, sourceCommit, build, hosts: hostVersions, acceptanceChecks, changes, scenarioAcceptance, adapterHosts }) {
	const reviewed = parseReviewedVersion(tag.slice(1));
	assert.equal(tag, reviewed.tag, "Expected an existing reviewed source tag");
	assert.equal(packageTag, reviewed.packageTag, "Package tag must match the source version");
	assert(Array.isArray(hostVersions) && hostVersions.length > 0, "Release notes need the hosts accepted in this run");
	const functionalPreview = reviewed.version === VERSION;
	const latencyRelease = isStrictRelease(reviewed.version);
	const hosts = hostList(hostVersions);
	if (functionalPreview) assertFunctionalProfile(scenarioAcceptance);
	if (latencyRelease) assertStrictReleaseProfile(scenarioAcceptance, reviewed.version);
	const introduction = reviewed.preview
		? `SLICE ${tag} is an **experimental A-stage preview candidate** for **unmodified official Pi ${hosts}**.\n\n`
		: `SLICE ${tag} supplies an ordinary extension for **unmodified official Pi ${hosts}**.\n\n`;
	const preparation = latencyRelease
		? `Optional preparation has two arms, both **disabled by default**: A prepares with the configured writer; B merges data-only work notes from the session model. A validated candidate can commit its covered prefix without a writer call while every later original stays verbatim. B carries covered user messages in full and falls back to the configured writer when they do not fit. Every writer call is journaled, including cancelled or discarded preparation and unknown usage. These are experimental paths; real-provider pause, total cost, cache behavior and recovery benefits remain unproven.\n\n`
		: reviewed.preview
		? `A adds opt-in preparation using the same configured writer; it is **disabled by default**. The existing commit and failure gates remain in force. B, the new instruction-authority protocol and the full A/B comparison are incomplete and deferred. Improvements in foreground pause, total cost or recovery have not been established.\n\n`
		: "";
	const validation = latencyRelease
		? `Validation: this publication run passed ${acceptanceChecks} stock-Pi package and lifecycle checks on official Pi ${hosts} and the full default-settings scenario suite on Pi ${hostVersions[0]} with **strict acceptance and no performance exceptions or known gaps**. Scenario evidence is bound to this exact package and source commit; the 50 ms request-overhead target and checkpoint-growth bound are required checks. Focused, security and frozen evaluator checks also remain required on final main. Services are synthetic and loopback only; no real-provider quality, latency or interactive TUI claim is made.\n\n`
		: functionalPreview
		? `Package/lifecycle validation: ${acceptanceChecks} stock-Pi checks passed on official Pi ${hosts}. The maintainer-approved \`${PROFILE}\` profile applies **only to v${VERSION}**. Only true failures of \`per-request-budget\` (50 ms) and \`checkpoint-overhead-growth-required\` are accepted as functional A-preview scope exceptions; correctness, security, persistence, identity, package and source checks must pass. Raw scenario gate: ${scenarioAcceptance.rawPassed ? "passed" : "failed"}. Declared raw performance exceptions: ${scenarioAcceptance.exceptions.map((entry) => `\`${entry.id}\` (${entry.status})`).join(", ") || "none"}. These are scope exceptions, not performance passes; the full v0.4.0 gates are unchanged. Focused, security, evaluator and scenario results are in the validation record. Services are synthetic and loopback only; no real-provider quality, latency or interactive TUI claim is made.\n\n`
		: reviewed.preview
		? `Package/lifecycle validation: ${acceptanceChecks} stock-Pi checks passed on official Pi ${hosts}. These checks do not establish performance acceptance. The required growth check currently fails, and the 50 ms per-request target remains unmet. Neither check is waived. Focused, security, evaluator and scenario results are in the validation record. Services are synthetic and loopback only; no real-provider quality, latency or interactive TUI claim is made.\n\n`
		: `Validation: this publication run passed ${acceptanceChecks} stock-Pi package and lifecycle checks on official Pi ${hosts}. Focused, security, evaluator and scenario results, with remaining known gaps, are in the validation record. Services are synthetic and loopback only. No real-provider quality, latency or interactive TUI claim is made.\n\n`;
	const resident = reviewed.version === "0.4.1"
		? "Resident release version remains v0.3.0; its build fingerprint changes with the one-line note fold, and the frozen evaluator is pinned to that source."
		: reviewed.preview
		? "Resident release version remains v0.3.0; shared-validation source identity and frozen comparison are tracked separately."
		: "Resident runtime keeps its v0.3.0 fingerprint.";
	const install = npmRelease(reviewed.version)
		? npmInstall({ repository, branch, tag, packageTag, version: reviewed.version, adapterHosts })
		: `Install this release's extension package (a fixed package tag) from your terminal, then restart Pi:\n\n\`\`\`sh\npi install git:github.com/${repository}@${packageTag}\n\`\`\`\n\n`
			+ `Start a new persistent text session and run \`/compaction-doctor\` to check it without calling a model. Source tag \`${tag}\` selects the development monorepo, not the package. To follow later previews instead, install the moving \`${branch}\` branch in place of the tag and update only this package with \`pi update --extension git:github.com/${repository}@${branch}\`. A plain \`pi update\` updates Pi itself.\n\n`;
	return introduction
		+ install
		+ `This pre-release supports ${latencyRelease ? "manual /compact and Pi's threshold compaction after completed text turns" : "manual compaction of completed text turns"}, source-linked history retrieval and explicit disk-confirmed failure recovery. In the sessions it handles, ${latencyRelease ? "overflow recovery still requires explicit /compact, and background cache warming is paused" : `automatic compaction is cancelled and ${reviewed.preview ? "Pi's built-in background cache warming" : "background cache warming"} is paused`}. Sessions it never protected and cannot check, such as ones with native checkpoints, images or another Pi version, are left to Pi without a failure marker. Other checkpoint formats, parent-history grants, attachments, concurrent writers and Windows are outside its verified scope.\n\n`
		+ `Ordinary Agent retries after transient provider failures are supported, including partial-response connection drops. Existing retry-related blocks and text-only context-overflow failures can use explicit /compact recovery when sufficient completed source history exists. Arbitrary context edits and unfinished tool-call omissions remain unsupported.\n\n`
		+ preparation
		+ validation
		+ `Source commit: ${sourceCommit}. Preview runtime: \`${build}\`. ${resident}\n\n`
		+ `[Usage and recovery](https://github.com/${repository}/blob/${tag}/docs/context-memory/extension-preview.md) · [Validation](https://github.com/${repository}/blob/${tag}/docs/context-memory/validation.md)\n\n`
		+ `### Changes\n${changes}\n`;
}

/** Install instructions from npm, with the Git package beside it and the OpenCode and DSH packages after it. */
function npmInstall({ repository, branch, tag, packageTag, version, adapterHosts }) {
	assert(adapterHosts?.opencode?.length && adapterHosts?.dsh?.length, "npm release notes need the OpenCode and DSH hosts accepted in this run");
	return `Install this release from npm, then restart Pi:\n\n\`\`\`sh\npi install npm:slice-pi@${version}\n\`\`\`\n\n`
		+ `Start a new persistent text session and run \`/compaction-doctor\` to check it without calling a model. To follow later releases, install \`npm:slice-pi\` without a version and update only this package with \`pi update --extension npm:slice-pi\`. A plain \`pi update\` updates Pi itself. The same package is on Git as the fixed tag \`${packageTag}\`; source tag \`${tag}\` selects the development monorepo, not the package:\n\n\`\`\`sh\npi install git:github.com/${repository}@${packageTag}\n\`\`\`\n\n`
		+ `An installation from Git keeps working and updating through \`${branch}\`. To move it to npm, run \`pi remove git:github.com/${repository}\` and install from npm; sessions and settings carry over.\n\n`
		+ `OpenCode and DSH get SLICE's \`context_history\` from npm too, with no build. For OpenCode, add the package to \`plugin\` in \`opencode.json\` and restart it:\n\n\`\`\`json\n{ "plugin": ["slice-opencode@${version}"] }\n\`\`\`\n\n`
		+ `For DSH, add it to a profile built on DSH's base bundle; the package enables itself there:\n\n\`\`\`sh\ndsh plugin --profile <profile> add slice-dsh@${version}\n\`\`\`\n\n`
		+ `Before publication each package was installed by name from a loopback registry on official OpenCode ${hostList(adapterHosts.opencode)} and DSH ${hostList(adapterHosts.dsh)}, where a scripted session compacted natively and read its original history back. Both are retrieval only: compaction stays the host's.\n\n`;
}

/**
 * Copyable commands stay unambiguous: the first block installs the fixed release alone, no block
 * holds more than one Pi command, and the moving branch never shares a block with the fixed tag.
 */
function assertFunctionalProfile(value) {
	assert.equal(value?.profile, PROFILE, "This preview requires its authorized acceptance profile");
	assert.equal(value.version, VERSION, "The acceptance profile cannot apply to another version");
	assert.equal(value.accepted, true, "The acceptance profile must pass all non-excepted gates");
	assert.equal(typeof value.rawPassed, "boolean", "The raw scenario outcome must remain visible");
	assert(Array.isArray(value.exceptions), "The acceptance profile must declare its raw exceptions");
}

function assertStrictReleaseProfile(value, version) {
	assert.equal(value?.profile, "strict", `v${version} requires strict scenario acceptance`);
	assert.equal(value.version, version, `Strict release evidence must match v${version}`);
	assert.equal(value.accepted, true, `Every v${version} scenario gate must pass`);
	assert.equal(value.rawPassed, true, `v${version} cannot waive a raw scenario failure`);
	assert.deepEqual(value.exceptions, [], `v${version} cannot accept performance exceptions`);
}

export function assertReleaseNotes(notes, { repository, packageTag, branch, hosts, scenarioAcceptance, adapterHosts }) {
	assert(packageTag.startsWith("extension-v"), "Expected a reviewed fixed package tag");
	const reviewed = parseReviewedVersion(packageTag.slice("extension-v".length));
	assert(Array.isArray(hosts) && hosts.length > 0, "Release notes must be checked against the accepted hosts");
	assert(notes.includes(`unmodified official Pi ${hostList(hosts)}**`), "Release notes must name every accepted official host");
	if (isStrictRelease(reviewed.version)) {
		assertStrictReleaseProfile(scenarioAcceptance, reviewed.version);
		assert(notes.includes("strict acceptance and no performance exceptions or known gaps"), "Release notes must retain strict scenario acceptance");
		assert(notes.includes("Pi's threshold compaction after completed text turns"), "Release notes must describe threshold compaction");
		assert(notes.includes("B carries covered user messages in full"), "Release notes must describe complete user-message retention");
		assert(notes.includes("real-provider pause, total cost, cache behavior and recovery benefits remain unproven"), "Release notes must retain unmeasured benefits");
	}
	if (reviewed.version === VERSION) {
		assertFunctionalProfile(scenarioAcceptance);
		assert(notes.includes(`\`${PROFILE}\` profile applies **only to v${VERSION}**`), "Preview notes must name the version-bound authorization");
		assert(notes.includes("correctness, security, persistence, identity, package and source checks must pass"), "Preview notes must retain every other gate");
		assert(notes.includes(`Raw scenario gate: ${scenarioAcceptance.rawPassed ? "passed" : "failed"}.`), "Preview notes must preserve the raw scenario outcome");
		assert(notes.includes("scope exceptions, not performance passes; the full v0.4.0 gates are unchanged"), "Preview notes must not promote scope exceptions to full-version acceptance");
		assert(notes.includes("Improvements in foreground pause, total cost or recovery have not been established"), "Preview notes must not claim unmeasured benefits");
		for (const entry of scenarioAcceptance.exceptions) assert(notes.includes(`\`${entry.id}\` (${entry.status})`), "Preview notes must disclose each raw performance exception");
	}
	const blocks = [...notes.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1].trim());
	assert(blocks.length > 0, "Release notes need a copyable install command");
	if (npmRelease(reviewed.version)) {
		assert.equal(blocks[0], `pi install npm:slice-pi@${reviewed.version}`, "The first block must install the fixed npm release alone");
		assert(blocks.includes(`pi install git:github.com/${repository}@${packageTag}`), "npm release notes must keep the fixed Git package");
		assert(blocks.includes(`{ "plugin": ["slice-opencode@${reviewed.version}"] }`), "npm release notes must install the OpenCode package");
		assert(blocks.includes(`dsh plugin --profile <profile> add slice-dsh@${reviewed.version}`), "npm release notes must install the DSH package");
		assert(notes.includes(`official OpenCode ${hostList(adapterHosts.opencode)} and DSH ${hostList(adapterHosts.dsh)}`), "npm release notes must name the accepted OpenCode and DSH hosts");
	} else assert.equal(blocks[0], `pi install git:github.com/${repository}@${packageTag}`, "The first block must install the fixed package tag alone");
	for (const block of blocks) {
		const commands = block.split("\n").filter((line) => /^pi\s/.test(line.trim()));
		assert(commands.length <= 1, "Each copyable block may hold one Pi command");
		assert(!(block.includes(`@${packageTag}`) && block.includes(`@${branch}`)), "A fixed tag and the moving branch must not share a block");
	}
}

/** Whether origin holds a tag; `git ls-remote --exit-code` exits 2 when nothing matches. */
function originHasTag(tag) {
	const result = spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], { encoding: "utf8" });
	if (result.error) throw result.error;
	assert([0, 2].includes(result.status), `git ls-remote failed: ${result.stderr}`);
	return result.status === 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [flag, packageDir, tagFlag, sourceTag, ...rest] = process.argv.slice(2);
	if (flag !== "--plan" || !packageDir || rest.length > 0 || (tagFlag !== undefined && (tagFlag !== "--source-tag" || sourceTag === undefined))) {
		console.error("Usage: node scripts/context-memory-preview-release-checks.mjs --plan <package-dir> [--source-tag <tag>]");
		process.exitCode = 2;
	} else process.stdout.write(releasePlanOutputs(resolve(packageDir), tagFlag ? { sourceTag, isPublished: originHasTag } : {}));
}
