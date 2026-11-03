import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { SLICE_VERSION } from "./context-memory-version.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output-dir")) {
	throw new Error("Usage: node scripts/context-memory-adapters-build.mjs [--output-dir <directory>]");
}
const output = resolve(args[1] ?? resolve(root, ".artifacts/host-adapters"));
const repository = { type: "git", url: "https://github.com/youxi-huang/slice.git" };

/**
 * What each published package declares beyond its workspace manifest. The workspace keeps the exact versions its
 * tests build against; the published ranges admit every host release the adapter's APIs are unchanged in.
 */
const PUBLISHED = {
	opencode: {
		name: "slice-opencode",
		previousName: "slice-opencode-preview",
		description: "SLICE context_history for OpenCode: search and read this session's original history after compaction",
		keywords: ["opencode", "opencode-plugin", "slice", "context-compaction", "coding-agent"],
		// OpenCode refuses an npm plugin outside this range before loading it.
		engines: { opencode: ">=1.19.4 <2.0.0" },
		extraFiles: [],
	},
	dsh: {
		name: "slice-dsh",
		previousName: "slice-dsh-preview",
		description: "SLICE context_history for DeepSeek Harness: search and read this session's original history after compaction",
		keywords: ["dsh", "dsh-plugin", "deepseek-harness", "slice", "context-compaction", "coding-agent"],
		// DSH admits a plugin by its peers on DSH packages; the APIs this adapter uses are unchanged from rc.3 to rc.5.
		peerDependencies: {
			"@deepseek-ai/cordis": "~4.0.5",
			"@deepseek-ai/dsh-compaction": "^0.2.1-rc.3",
			"@deepseek-ai/dsh-session": "^0.2.1-rc.3",
			"@deepseek-ai/dsh-session-persistence": "^0.2.1-rc.3",
			"@deepseek-ai/dsh-tools": "^0.2.1-rc.3",
		},
		// A bundle patch makes `dsh plugin add` enable the tool, with no hand edit of the profile's patch.
		dsh: { bundle: { patch: "./cordis.patch.yml" } },
		extraFiles: [["cordis.patch.yml", "- insert:\n    - id: slice-history\n      name: slice-dsh\n"]],
	},
};

const report = { version: SLICE_VERSION, packages: [] };
for (const host of ["dsh", "opencode"]) {
	const source = `packages/compaction-${host}`;
	const published = PUBLISHED[host];
	const manifest = JSON.parse(readFileSync(resolve(root, source, "package.json"), "utf8"));
	const target = resolve(output, host);
	if (existsSync(target)) {
		const existing = JSON.parse(readFileSync(resolve(target, "package.json"), "utf8"));
		if (existing.name !== published.name && existing.name !== published.previousName) throw new Error("Refusing to replace an unrelated directory");
		rmSync(target, { recursive: true, force: true });
	}
	const bundled = await build({
		absWorkingDir: root,
		entryPoints: { index: `${source}/src/index.ts`, ...(host === "dsh" ? { compaction: `${source}/src/compaction.ts` } : {}) },
		bundle: true, write: false, metafile: true,
		format: "esm", platform: "node", target: "node22", packages: "external",
		tsconfigRaw: { compilerOptions: {} },
		outdir: resolve(target, "dist"), logLevel: "warning",
	});
	const inputs = Object.keys(bundled.metafile.inputs).sort();
	if (inputs.some((path) => !path.startsWith(`${source}/src/`) && !path.startsWith("packages/compaction-core/src/"))) {
		throw new Error("Adapter must bundle only its own source and the host-neutral core");
	}
	const peerDependencies = published.peerDependencies ?? manifest.peerDependencies;
	const peers = [...Object.keys(peerDependencies ?? {}), ...Object.keys(manifest.dependencies)];
	for (const item of Object.values(bundled.metafile.outputs).flatMap((entry) => entry.imports)) {
		if (!item.path.startsWith("node:") && !peers.some((peer) => item.path === peer || item.path.startsWith(`${peer}/`))) {
			throw new Error(`Undeclared adapter import: ${item.path}`);
		}
	}
	const hash = createHash("sha256");
	for (const file of inputs) hash.update(file).update("\0").update(readFileSync(resolve(root, file))).update("\0");
	const sourceHash = hash.digest("hex");
	const extraFiles = published.extraFiles.map(([file]) => file);
	const files = ["dist/index.js", ...(host === "dsh" ? ["dist/compaction.js"] : []), "README.md", "LICENSE", "adapter-build.json", ...extraFiles];
	const packageManifest = {
		name: published.name,
		version: SLICE_VERSION,
		description: published.description,
		repository,
		homepage: "https://github.com/youxi-huang/slice/blob/main/docs/context-memory/host-adapters.md",
		bugs: { url: "https://github.com/youxi-huang/slice/issues" },
		type: manifest.type,
		license: manifest.license,
		keywords: published.keywords,
		...(published.engines ? { engines: published.engines } : {}),
		main: "./dist/index.js",
		exports: { ".": "./dist/index.js", ...(host === "dsh" ? { "./compaction": "./dist/compaction.js" } : {}) },
		files,
		dependencies: manifest.dependencies,
		...(peerDependencies ? { peerDependencies } : {}),
		...(published.dsh ? { dsh: published.dsh } : {}),
	};
	mkdirSync(resolve(target, "dist"), { recursive: true });
	for (const file of bundled.outputFiles) writeFileSync(file.path, file.contents);
	writeFileSync(resolve(target, "package.json"), `${JSON.stringify(packageManifest, null, 2)}\n`);
	writeFileSync(resolve(target, "README.md"), readFileSync(resolve(root, source, "README.md")));
	writeFileSync(resolve(target, "LICENSE"), readFileSync(resolve(root, "LICENSE")));
	for (const [file, contents] of published.extraFiles) writeFileSync(resolve(target, file), contents);
	writeFileSync(resolve(target, "adapter-build.json"), `${JSON.stringify({ host, mode: host === "dsh" ? "manual-writing-opt-in" : "retrieval-only", version: SLICE_VERSION, sourceHash, sources: inputs }, null, 2)}\n`);
	// The archive npm publishes, packed once here so acceptance installs the same bytes.
	const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output], { cwd: target, encoding: "utf8", env: process.env });
	if (packed.error) throw packed.error;
	if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
	const [archive] = JSON.parse(packed.stdout);
	if (JSON.stringify(archive.files.map((entry) => entry.path).sort()) !== JSON.stringify(["package.json", ...files].sort())) {
		throw new Error(`Unexpected file in ${published.name} archive`);
	}
	const archivePath = resolve(output, archive.filename);
	report.packages.push({
		host,
		name: published.name,
		directory: host,
		archive: basename(archivePath),
		sha256: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
		integrity: archive.integrity,
		sourceHash,
	});
	console.log(`${host}: built ${published.name}@${SLICE_VERSION} (${bundled.outputFiles[0].contents.length} bytes), ${basename(archivePath)}`);
}
writeFileSync(resolve(output, "adapters-package-report.json"), `${JSON.stringify(report, null, 2)}\n`);
