import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PRIMARY_PI_VERSION, SUPPORTED_PI_VERSIONS } from "../packages/coding-agent/src/extensions/context-memory/preview/compatibility.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const name = "pi-context-compaction-preview";
const version = "0.7.4";
const extensionRoot = "packages/coding-agent/src/extensions/context-memory/";
const previewRoot = `${extensionRoot}preview/`;
// The host-neutral core (v0.7.0 WP2): lifted modules may be bundled alongside preview files.
const coreRoot = "packages/compaction-core/src/";
const shared = new Set(["config.ts", "events.ts", "history.ts", "identity.ts", "notes.ts"]);
const peers = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"];
let output = resolve(root, ".artifacts/context-memory-preview-package");
for (let index = 2; index < process.argv.length; index++) {
	if (process.argv[index] !== "--output-dir" || !process.argv[index + 1]) {
		throw new Error("Usage: node scripts/context-memory-preview-build.mjs [--output-dir <directory>]");
	}
	output = resolve(process.argv[++index]);
}
if (existsSync(output)) {
	const existing = JSON.parse(readFileSync(resolve(output, "package.json"), "utf8"));
	if (existing.name !== name || existing.private !== true) throw new Error("Refusing to replace an unrelated directory");
}

const options = {
	absWorkingDir: root,
	entryPoints: [`${previewRoot}extension.ts`],
	bundle: true,
	write: false,
	metafile: true,
	format: "esm",
	platform: "node",
	target: "node22",
	packages: "external",
	external: peers.flatMap((peer) => [peer, `${peer}/*`]),
	// Workspace path aliases must never turn public Pi imports into bundled host source.
	tsconfigRaw: { compilerOptions: {} },
	sourcemap: false,
	legalComments: "inline",
	outfile: "dist/extension.js",
	logLevel: "warning",
};
const scanned = await build(options);
const inputs = Object.keys(scanned.metafile.inputs).sort();
for (const input of inputs) {
	if (
		!input.startsWith(previewRoot) &&
		!input.startsWith(coreRoot) &&
		!(input.startsWith(extensionRoot) && shared.has(input.slice(extensionRoot.length)))
	) {
		throw new Error(`Preview must not bundle host or resident lifecycle code: ${input}`);
	}
}
const hash = createHash("sha256").update("official-pi-extension\0");
const sources = inputs.map((file) => {
	const bytes = readFileSync(resolve(root, file));
	hash.update(file).update("\0").update(bytes).update("\0");
	return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const sourceHash = hash.digest("hex");
const buildId = `stock-preview+src.${sourceHash.slice(0, 16)}`;
const bundled = await build({
	...options,
	plugins: [{
		name: "preview-fingerprint",
		setup(builder) {
			builder.onLoad({ filter: /context-memory\/preview\/build\.ts$/ }, () => ({
				contents: `export const PREVIEW_BUILD_ID = ${JSON.stringify(buildId)};\n`,
				loader: "ts",
			}));
		},
	}],
});
if (JSON.stringify(Object.keys(bundled.metafile.inputs).sort()) !== JSON.stringify(inputs)) {
	throw new Error("Preview import graph changed during packaging");
}
const imports = Object.values(bundled.metafile.outputs).flatMap((item) => item.imports.map((entry) => entry.path));
for (const specifier of imports) {
	if (!specifier.startsWith("node:") && !peers.some((peer) => specifier === peer || specifier.startsWith(`${peer}/`))) {
		throw new Error(`Undeclared preview external import: ${specifier}`);
	}
}
const manifest = {
	name,
	version,
	private: true,
	description: `SLICE source-linked compaction preview for unmodified Pi ${SUPPORTED_PI_VERSIONS.join(" and ")}`,
	repository: { type: "git", url: "https://github.com/youxi-huang/slice.git" },
	homepage: "https://github.com/youxi-huang/slice/blob/main/docs/context-memory/extension-preview.md",
	type: "module",
	license: "MIT",
	engines: { node: ">=22.19.0" },
	keywords: ["pi-package"],
	files: ["dist/extension.js", "preview-build.json", "README.md", "LICENSE"],
	pi: { extensions: ["./dist/extension.js"] },
	peerDependencies: Object.fromEntries(peers.map((peer) => [peer, "*"])),
};
const git = (args) => {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	if (result.error || result.status !== 0) throw new Error("Cannot determine preview source revision");
	return result.stdout.trim();
};
// Local work-in-progress has a source fingerprint but must not claim a clean release commit.
const sourceCommit = git(["status", "--porcelain"]) ? null : git(["rev-parse", "HEAD"]);
mkdirSync(dirname(output), { recursive: true });
const staging = mkdtempSync(resolve(dirname(output), ".preview-package-"));
try {
	mkdirSync(resolve(staging, "dist"));
	writeFileSync(resolve(staging, "dist/extension.js"), bundled.outputFiles[0].contents);
	writeFileSync(resolve(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(resolve(staging, "LICENSE"), readFileSync(resolve(root, "LICENSE")));
	writeFileSync(resolve(staging, "README.md"), readFileSync(resolve(root, "docs/context-memory/extension-preview.md")));
	writeFileSync(resolve(staging, "preview-build.json"), `${JSON.stringify({
		build: buildId, version, sourceCommit, supportedPi: PRIMARY_PI_VERSION, supportedPiVersions: SUPPORTED_PI_VERSIONS, checkpointSchema: 1, sourceHash, sources,
		externalImports: [...new Set(imports)].sort(),
	}, null, 2)}\n`);
	if (existsSync(output)) rmSync(output, { recursive: true });
	renameSync(staging, output);
} finally {
	rmSync(staging, { recursive: true, force: true });
}
const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dirname(output)], {
	cwd: output, encoding: "utf8", env: process.env,
});
if (packed.error) throw packed.error;
if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
const [archive] = JSON.parse(packed.stdout);
const expected = ["LICENSE", "README.md", "dist/extension.js", "package.json", "preview-build.json"].sort();
if (JSON.stringify(archive.files.map((entry) => entry.path).sort()) !== JSON.stringify(expected)) {
	throw new Error("Unexpected file in preview archive");
}
const archivePath = resolve(dirname(output), archive.filename);
const report = {
	build: buildId,
	version,
	sourceCommit,
	packageDirectory: relative(root, output),
	archive: basename(archivePath),
	sha256: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
	files: archive.files.map(({ path, size }) => ({ path, size })),
	sourceHash,
};
writeFileSync(resolve(dirname(output), "context-memory-preview-package-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
