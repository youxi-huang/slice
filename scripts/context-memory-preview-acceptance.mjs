import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startLoopbackRegistry } from "./context-memory-loopback-registry.mjs";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";
import { pressureProfile } from "./context-memory-pressure-profile.mjs";

// Uses only clean official host code and a loopback mock provider. Never contacts a model service.
const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
function argument(name, optional = false) {
	const index = args.indexOf(name);
	if (index >= 0 && args[index + 1]) return args[index + 1];
	if (optional) return undefined;
	throw new Error(`Missing ${name}. Usage: node ${script} --package-dir <candidate> --stock-root <official npm installation> --output-dir <evidence> [--compatible-stock-root <older official installation>]...`);
}
/** Every value of a repeatable flag, in order. */
function argumentList(name) {
	return args.flatMap((value, index) => value === name && args[index + 1] && !args[index + 1].startsWith("--") ? [args[index + 1]] : []);
}
function fileHash(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
const packageDir = resolve(argument("--package-dir"));
const stockRoot = resolve(argument("--stock-root"));
const outputDir = resolve(argument("--output-dir"));
// Workers receive the isolated working root as their --output-dir; the parent keeps only evidence in outputDir.
let workDir = outputDir;
const stockPackage = join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const stockVersion = JSON.parse(readFileSync(join(stockPackage, "package.json"), "utf8")).version;
const workerCase = argument("--runtime-case", true);
// A case run again from another installation keeps its own evidence directory.
const caseLabel = argument("--runtime-label", true) ?? workerCase;
const installedPackage = resolve(argument("--installed-package-dir", true) ?? packageDir);
// --segments on runs every runtime case with 0.8.0's previewSegments switched on, the release gate's second pass. The
// parent hands it to each case through the case's environment, which the preview never reads.
const segmentsOn = argument("--segments", true) === "on" || process.env.SLICE_ACCEPTANCE_SEGMENTS === "on";
const segmentsSetting = segmentsOn ? { previewSegments: { enabled: true } } : {};
mkdirSync(outputDir, { recursive: true });

function environment(agentDir) {
	const value = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: "C.UTF-8",
		CI: "1",
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "0", // Loopback Git and HTTP require transport; catalogs are separately disabled.
		PI_TELEMETRY: "0",
		PI_SKIP_VERSION_CHECK: "1",
		npm_config_cache: join(workDir, "npm-cache"),
		npm_config_offline: "true",
		npm_config_audit: "false",
		npm_config_fund: "false",
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(workDir, "empty-git-config"),
	};
	if (process.env.SystemRoot) value.SystemRoot = process.env.SystemRoot;
	if (segmentsOn) value.SLICE_ACCEPTANCE_SEGMENTS = "on";
	return value;
}

async function command(program, parameters, options = {}) {
	const child = spawn(program, parameters, { cwd: workDir, env: environment(join(workDir, "package-agent")), ...options, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (data) => { stdout += data; });
	child.stderr.on("data", (data) => { stderr += data; });
	const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
	try {
		const [code] = await once(child, "exit");
		assert.equal(code, 0, `${program} ${parameters.slice(0, 3).join(" ")} failed: ${stderr.slice(-3000)} ${stdout.slice(-1000)}`);
		return stdout;
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
}

async function unusedPort() {
	const server = createTcpServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	await new Promise((done) => server.close(done));
	return port;
}

function syntheticNote(entryId, mode = "good", unreadableId) {
	const value = {
		instructions: [{ text: "Deployment remains unauthorized.", sources: [entryId], quote: "Do not deploy this synthetic service." }],
		failedPaths: [], reasons: [],
		state: [{ text: "The synthetic service uses port 4317.", sources: [entryId] }],
		nextSteps: [{ text: "Continue checking the service locally.", sources: [entryId] }],
		files: [], gaps: [],
	};
	if (mode === "bad-quote") value.instructions[0].quote = "Deployment is authorized.";
	if (mode === "bad-source") value.state[0].sources = ["fabricated-original"];
	if (mode === "bad-supersedes") value.state[0].supersedes = [unreadableId];
	return value;
}

function responseEvent(response, modelId, text, toolCall, promptTokens = 100) {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const delta = toolCall
		? { role: "assistant", tool_calls: [{ index: 0, id: "synthetic-history-call", type: "function", function: { name: "context_history", arguments: JSON.stringify(toolCall) } }] }
		: { role: "assistant", content: text };
	response.write(`data: ${JSON.stringify({ id: "synthetic-response", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	response.write(`data: ${JSON.stringify({ id: "synthetic-response", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 30, total_tokens: promptTokens + 30 } })}\n\n`);
	response.end("data: [DONE]\n\n");
}

async function runtimeAcceptance() {
	const caseDir = join(workDir, "runtime", caseLabel);
	mkdirSync(caseDir, { recursive: true });
	const reuseAgentDir = argument("--reuse-agent-dir", true);
	const agentDir = reuseAgentDir ?? join(caseDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "0";
	process.env.PI_TELEMETRY = "0";
	const stock = await import(pathToFileURL(join(stockPackage, "dist", "index.js")).href);
	const fixedWriterUnavailable = workerCase === "writer-unavailable";
	const warmingCase = workerCase === "cache-warming";
	const automaticCase = workerCase === "automatic-compaction";
	const pressureCase = workerCase.startsWith("pressure-");
	// No compactAt: preparation must find Pi's lowered line in its own settings, through a per-model override in one case.
	const pressure = pressureProfile({ contextWindow: 200_000, maxOutputTokens: 32_000, ...(workerCase === "pressure-prepared" ? { model: "synthetic-preview/synthetic-preview" } : {}) });
	// A second copy at another path, as installing a second address adds one; both load and both register.
	const duplicateCase = workerCase === "duplicate-copies";
	const secondCopy = join(caseDir, "second-copy");
	if (!reuseAgentDir) {
		writeFileSync(join(agentDir, "pi-context-memory.json"), JSON.stringify({ enabled: true, writerModel: fixedWriterUnavailable ? "missing-provider/missing-writer" : "session", eventLog: false, noteRepair: false, keepRecentTokens: 0, ...segmentsSetting }));
		if (workerCase === "config-invalid") writeFileSync(join(agentDir, "pi-context-memory.json"), "{invalid config");
		if (duplicateCase) cpSync(packageDir, secondCopy, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: duplicateCase ? [installedPackage, secondCopy] : [installedPackage], compaction: { enabled: automaticCase, keepRecentTokens: 0, reserveTokens: 16_384 }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: warmingCase ? "idle" : "off", defaultTools: [] }));
		if (pressureCase) {
			writeFileSync(join(agentDir, "pi-context-memory.json"), JSON.stringify({ enabled: true, writerModel: "session", eventLog: false, noteRepair: false, ...pressure.pi.slice, previewPreparation: { enabled: true }, ...segmentsSetting }));
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [installedPackage], ...pressure.pi.settings, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", defaultTools: [] }));
		}
	}
	const requests = [];
	const diagnostics = [];
	const toolResults = [];
	let sourceId;
	let unreadableId;
	let session;
	let manager;
	let capturedPendingMarker;
	let writerMode = ["bad-quote", "bad-source", "bad-supersedes"].includes(workerCase) ? workerCase : ["cache-warming", "marker-corrupt"].includes(workerCase) ? "bad-source" : "good";
	let mainMode = ["success", "repeat-compaction", "reopen-success", "duplicate-copies"].includes(workerCase) ? "history" : "ack";
	let onWriter;
	let pressureUsage = 100;
	const server = createHttpServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		let payload;
		try { payload = JSON.parse(raw); } catch { response.writeHead(400); response.end(); return; }
		// A normal request can contain every note-schema field in a checkpoint and tool loadout.
		// The session writer ends its request with an explicit handover instruction.
		const writer = JSON.stringify(payload.messages?.at(-1) ?? "").includes("Internal context-compaction request, not a new user task or ruling.");
		// A segment's request closes with an instruction that names its range; only --segments on can send one.
		const segment = writer && JSON.stringify(payload.messages?.at(-1) ?? "").includes("Write a segment note for entries");
		assert(segmentsOn || !segment, "A segment was written with previewSegments off");
		requests.push({ writer, segment, model: payload.model });
		assert(requests.length <= 40, "Synthetic provider call budget exceeded");
		if (writer) {
			await onWriter?.();
			const text = ["malformed-note", "pressure-failed"].includes(workerCase) ? "This looks plausible but is not JSON." : JSON.stringify(syntheticNote(sourceId, writerMode, unreadableId));
			responseEvent(response, payload.model, text);
		} else if (mainMode === "history" && payload.messages.at(-1)?.role !== "tool") {
			responseEvent(response, payload.model, "", { operation: "read", entryId: sourceId });
		} else {
			responseEvent(response, payload.model, "The synthetic port is 4317. Deployment remains unauthorized.", undefined, pressureCase ? pressureUsage - 30 : automaticCase ? 200_000 : 100);
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const model = { id: "synthetic-preview", name: "Synthetic preview", provider: "synthetic-preview", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true } };
	if (pressureCase) { model.contextWindow = 200_000; model.maxTokens = 32_000; }
	if (warmingCase) { model.promptCache = { short: 11, long: 11 }; model.cost.input = 100_000; }
	try {
		const runtime = await stock.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
		runtime.registerProvider(model.provider, { api: model.api, apiKey: "synthetic-acceptance-only", baseUrl: model.baseUrl, models: [model] });
		const file = argument("--session-file", true);
		manager = file ? stock.SessionManager.open(file) : stock.SessionManager.create(caseDir, join(caseDir, "sessions"));
		if (!file) {
			sourceId = manager.appendMessage({ role: "user", content: "Use port 4317. Do not deploy this synthetic service. Continue checking it locally.", timestamp: 1 });
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "The local check is complete." }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
			unreadableId = manager.appendThinkingLevelChange("off");
		} else {
			sourceId = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
		}
		assert(sourceId, "Missing synthetic original source");
		const settings = stock.SettingsManager.create(caseDir, agentDir);
		const loader = new stock.DefaultResourceLoader({ cwd: caseDir, agentDir, settingsManager: settings, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => "Use the synthetic evidence. Call context_history to verify original decisions." });
		await loader.reload();
		const extensions = loader.getExtensions();
		// Pi keeps both copies loaded and reports only that the second one's tools conflict with the first's.
		const loadErrors = duplicateCase ? extensions.errors.filter((error) => !(error.path.startsWith(secondCopy) && /^Tool "context_(?:note|history)" conflicts with /.test(error.error))) : extensions.errors;
		assert.deepEqual(loadErrors, [], `Package load errors: ${JSON.stringify(extensions.errors)}`);
		if (duplicateCase) assert.equal(extensions.extensions.filter((extension) => extension.path.startsWith(secondCopy)).length, 1, "Official Pi did not load the second copy");
		assert(extensions.extensions.some((extension) => extension.path.startsWith(installedPackage)), "The installed package was not loaded by official Pi");
		const loadedPreview = extensions.extensions.find((extension) => extension.path.startsWith(installedPackage));
		const warmingHandlers = loadedPreview.handlers.get("cache_warming_decision");
		assert(warmingHandlers?.length, "Enabled preview has no background warming guard");
		for (const action of ["warm", "stop"]) {
			for (const economics of [{ warmCost: 0, missCost: 100, continuationProbability: 1 }, { warmCost: 100, missCost: 0, continuationProbability: 0 }]) {
				for (const handler of warmingHandlers) assert.deepEqual(await handler({ type: "cache_warming_decision", action, ...economics }, { sessionManager: manager }), { action: "stop" }, "A warming decision may bypass failure/request guards");
			}
		}
		const warnings = [];
		const warn = console.warn;
		console.warn = (...parts) => { warnings.push(parts.map(String).join(" ")); warn(...parts); };
		const created = await stock.createAgentSession({ cwd: caseDir, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: "builtin" });
		session = created.session;
		await session.bindExtensions({ onError: (error) => diagnostics.push(error.message ?? String(error)) });
		console.warn = warn;
		assert(session.getAllTools().some((tool) => tool.name === "context_history"), "context_history is not registered");
		session.subscribe((event) => { if (event.type === "tool_execution_end" && event.toolName === "context_history") toolResults.push(event.result); });
		const marker = join(agentDir, "context-memory-preview", "failures", `${createHash("sha256").update(manager.getSessionId()).digest("hex")}.json`);
		async function commandOutput(text) {
			const printed = [];
			const original = console.log;
			console.log = (...parts) => { printed.push(parts.map(String).join(" ")); };
			try { await session.prompt(text); } finally { console.log = original; }
			return printed.join("\n");
		}
		async function assertBlocked() {
			const count = requests.length;
			await session.prompt("Continue despite the earlier failed compaction.");
			assert.equal(requests.length, count, "Blocked prompt reached the actual local HTTP provider");
			if (workerCase === "bad-quote") {
				await session.sendCustomMessage({ customType: "synthetic-guard", content: "Continue the blocked synthetic task.", display: false }, { triggerTurn: true });
				assert.equal(requests.length, count, "Custom-triggered run bypassed the compaction failure guard");
			}
		}
		if (pressureCase) {
			const checkpoints = () => manager.getBranch().filter((entry) => entry.type === "compaction");
			for (let cycle = 0; cycle < (workerCase === "pressure-failed" ? 1 : 3); cycle++) {
				// Real large source text and complete turns, plus scripted provider usage at the exact boundaries.
				for (let turn = 0; turn < 7; turn++) {
					manager.appendMessage({ role: "user", content: `Synthetic cycle ${cycle}, old turn ${turn}. ${"filler ".repeat(8000)}`, timestamp: 1 });
					manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Synthetic completed turn." }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
				}
				// Reload through the public SDK so the new durable source is also the agent's active projection.
				await session.reload();
				pressureUsage = 131_250; // The band below Pi's 150,000 line, not the 160,664 default.
				await session.prompt(`Synthetic recent-cycle-${cycle}. ${"recent ".repeat(9000)}`);
				let status;
				for (let attempt = 0; attempt < 150; attempt++) {
					status = JSON.parse(await commandOutput("/compaction-status"));
					if (["ready", "failed"].includes(status.preparation?.state)) break;
					await new Promise((done) => setTimeout(done, 20));
				}
				assert.equal(status.preparation?.state, workerCase === "pressure-failed" ? "failed" : "ready", "Preparation did not finish in the lowered band");
				assert.equal(checkpoints().length, cycle, "Host compacted before the configured line");
				// Arm A's own calls: with --segments on a segment may also be written in the band, under its own limits.
				const prepared = () => requests.filter((value) => value.writer && !value.segment).length;
				const paid = prepared();
				assert.equal(paid, cycle + 1, "More than one prepared writer call per interval");
				pressureUsage = pressure.targetTokens + 1;
				await session.prompt(`Finish synthetic recent-cycle-${cycle}.`);
				if (workerCase === "pressure-failed") {
					assert(existsSync(marker), "Failed synchronous writer did not block after failed preparation");
					assert.equal(checkpoints().length, 0);
					assert.equal(prepared(), paid + 1);
					await assertBlocked();
					await session.reload();
					await assertBlocked();
				} else {
					assert.equal(checkpoints().length, cycle + 1, "Native threshold did not commit a Slice checkpoint");
					assert.equal(prepared(), paid, "Prepared boundary made a synchronous writer request");
					assert(!existsSync(marker));
					assert(JSON.stringify(manager.buildSessionProjection().messages).includes(`recent-cycle-${cycle}`), "Recent text was lost");
					pressureUsage = 100;
					await session.prompt("A small synthetic follow-up.");
					assert.equal(checkpoints().length, cycle + 1, "Small follow-up immediately recompacted");
				}
			}
			if (workerCase !== "pressure-failed") {
				mainMode = "history";
				await session.prompt("Recover the original synthetic instruction.");
				assert(toolResults.some((result) => JSON.stringify(result).includes("Do not deploy this synthetic service.")));
			}
		} else if (automaticCase) {
			await session.prompt("Continue the synthetic local service check.");
			assert(existsSync(marker), "Native threshold compaction did not retain an explicit unsupported-boundary marker");
			assert.equal(requests.length, 1, "Native automatic compaction fell back to an additional summary or writer HTTP request");
			assert.equal(requests[0].writer, false, "Automatic-compaction fixture did not make its ordinary initial request");
			await assertBlocked();
			await session.reload();
			await assertBlocked();
		} else if (workerCase === "recover-unobserved") {
			assert(existsSync(marker), "Crash fixture did not preserve its actual staged marker");
			const beforeRecovery = requests.length;
			await assert.rejects(() => session.compact());
			assert(existsSync(marker), "Already compacted silently cleared the interrupted commit");
			await session.prompt("/compaction-recover");
			assert(!existsSync(marker), "Explicit recovery did not confirm the staged checkpoint on disk");
			assert.equal(requests.length, beforeRecovery, "Commit confirmation unexpectedly invoked a model");
			await session.prompt("Continue checking the service locally.");
			assert(requests.length > beforeRecovery, "Confirmed interrupted commit did not restore sending");
		} else if (workerCase === "doctor-read-only") {
			// First-use self-check: no provider, no marker, and no promise that Pi will accept /compact yet.
			const doctor = await commandOutput("/compaction-doctor");
			const status = JSON.parse(await commandOutput("/compaction-status"));
			assert.equal(requests.length, 0, "The self-check reached the local HTTP provider");
			assert(!existsSync(marker), "The self-check wrote a failure marker");
			for (const line of ["extension: ok", `host: ok - Pi ${stockVersion}`, "session: ok", "writer: ok", "manual /compact: unknown", "requests: ok - not paused"]) assert(doctor.includes(line), `Doctor output lacks "${line}"`);
			assert.equal(status.state, "ready", "A fresh session did not report ready");
			assert.equal(status.protection, "eligible", "A fresh session did not report eligible protection");
			assert.equal(status.manualCompaction?.pi, "unknown", "Status claimed to know Pi's own compaction gate");
		} else if (workerCase === "reopen-blocked") {
			assert(existsSync(marker), "Reopen fixture did not contain persistent failure state");
			await assertBlocked();
		} else if (workerCase === "reopen-success") {
			assert(!existsSync(marker), "Successful reopen remained blocked");
			await session.prompt("Verify the original decision with context_history.");
			assert(toolResults.some((result) => JSON.stringify(result).includes("Do not deploy this synthetic service.")), "Original source was not retrieved after reopen");
		} else {
			if (warmingCase) {
				await session.prompt("Check this synthetic service locally.");
				assert.equal(session.cacheWarmingStatus?.state, "scheduled", "Actual official SDK did not schedule the bounded cache-warming fixture");
			}
			const requestsBeforeAttempt = requests.length;
			if (workerCase === "memory-change") onWriter = () => { manager.getEntry(sourceId).message.content = "Use port 9000 instead."; };
			if (workerCase === "disk-change") onWriter = () => { const data = readFileSync(manager.getSessionFile(), "utf8").replace("Use port 4317.", "Use port 9000."); writeFileSync(manager.getSessionFile(), data); };
			if (workerCase === "checkpoint-write-failed") manager.appendCompaction = () => { throw Object.assign(new Error("Synthetic disk write failure"), { code: "ENOSPC" }); };
			if (workerCase === "unobserved-commit") {
				const originalAppend = manager.appendCompaction.bind(manager);
				manager.appendCompaction = (...parameters) => { capturedPendingMarker = readFileSync(marker); return originalAppend(...parameters); };
			}
			if (workerCase === "stage-marker-io") onWriter = () => { assert(existsSync(marker), "Attempt was not persisted before the writer request"); rmSync(marker); mkdirSync(marker); };
			if (workerCase === "first-marker-io") { mkdirSync(dirname(dirname(marker)), { recursive: true }); rmSync(dirname(marker), { recursive: true, force: true }); writeFileSync(dirname(marker), "Synthetic filesystem obstacle"); }
			if (workerCase === "cancelled") onWriter = async () => { session.abortCompaction(); await new Promise((done) => setTimeout(done, 20)); };
			let compactError;
			let result;
			try { result = await session.compact(); } catch (error) { compactError = error; }
			if (["success", "repeat-compaction", "unobserved-commit", "duplicate-copies"].includes(workerCase)) {
				assert(!compactError, `Valid compaction failed: ${compactError?.message}`);
				assert(result?.details?.kind === "pi-context-memory", "Stock host used native summarization instead of the extension");
				assert(!existsSync(marker), "Confirmed successful commit did not clear the marker");
				const disk = readFileSync(manager.getSessionFile(), "utf8");
				assert(disk.includes(manager.getLeafId()), "Compaction checkpoint is absent on disk");
				if (workerCase === "unobserved-commit") {
					assert(capturedPendingMarker, "Actual staged marker was not captured at the host append boundary");
					// Reconstruct a crash after append, before confirmation: preserve the
					// exact marker emitted by the real extension, not a fabricated hash.
					writeFileSync(marker, capturedPendingMarker);
				} else {
					await assert.rejects(() => session.compact());
					assert(!existsSync(marker), "Nothing/Already compacted operation manufactured a new failure marker");
					await session.prompt("Verify the original decision with context_history.");
					assert(toolResults.some((value) => JSON.stringify(value).includes("Do not deploy this synthetic service.")), "context_history did not retrieve the original evidence");
					if (duplicateCase) {
						// One copy compacts; the second stands aside, says so once and names the copy to remove.
						assert.equal(requests.filter((request) => request.writer).length, 1, "Both copies wrote a checkpoint for one compaction");
						assert.deepEqual(warnings.filter((text) => text.includes("CONTEXT_PREVIEW_DUPLICATE")).length, 1, "The second copy did not say once that it stands aside");
						assert(warnings.some((text) => text.includes(`run pi remove ${secondCopy}, and restart Pi`)), "The notice did not name the command that removes the second copy");
						const first = await commandOutput("/compaction-doctor:1");
						const second = await commandOutput("/compaction-doctor:2");
						assert(first.includes("  copies: duplicate - 2 loaded:") && first.includes("(this one) compacts") && first.includes("Result: ready for requests"), "The first copy's doctor did not report itself compacting");
						assert(second.includes("(this one) stands aside") && second.includes("Result: this copy stands aside"), "The second copy's doctor did not report itself standing aside");
						assert(!existsSync(marker), "A doctor run wrote a failure marker");
					}
					if (workerCase === "repeat-compaction") {
						await session.compact();
						assert(!existsSync(marker), "Repeated compaction left a failure marker");
						const before = toolResults.length;
						await session.sendCustomMessage({ customType: "synthetic-history", content: "Verify the original decision with context_history again.", display: false }, { triggerTurn: true });
						assert(toolResults.slice(before).some((value) => JSON.stringify(value).includes("Do not deploy this synthetic service.")), "History lookup failed after repeated compaction and a custom-triggered run");
					}
				}
			} else {
				assert(compactError || existsSync(marker), "Invalid compaction completed without persistent failure state");
				const afterAttempt = requests.length;
				assert(requests.slice(requestsBeforeAttempt).every((request) => request.writer), "Failed custom compaction fell back to a native HTTP summary request");
				if (fixedWriterUnavailable || ["first-marker-io", "config-invalid"].includes(workerCase)) assert.equal(afterAttempt, 0, "Writer ran despite unavailable configuration or marker IO");
				if (warmingCase) {
					const beforeWarm = requests.length;
					await new Promise((done) => setTimeout(done, 1400));
					assert.equal(requests.length, beforeWarm, "Background warming reached HTTP after a failed compaction");
					assert.equal(session.cacheWarmingStatus?.reason, "stopped by extension", "Background warming was not stopped through the public decision event");
					assert.equal(settings.getCacheWarmingMode(), "idle", "Preview rewrote the user's warming setting");
				}
				await assertBlocked();
				if (!["first-marker-io", "stage-marker-io"].includes(workerCase)) {
					assert(existsSync(marker), "Failure did not persist a recovery marker");
					if (workerCase === "marker-corrupt") writeFileSync(marker, "{corrupt marker");
					await session.reload();
					await assertBlocked();
				}
				if (workerCase === "bad-quote") {
					// The real blocked prompt wrote its own user/aborted entries. Do not
					// manufacture a completed turn to conceal an explicit-retry deadlock.
					writerMode = "good";
					await session.compact();
					assert(!existsSync(marker), "Explicit successful manual retry failed to clear persistent state");
					const projection = manager.buildSessionProjection();
					assert(projection.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Continue despite the earlier failed compaction.")), "Recovery compaction erased the unfinished user request");
					mainMode = "ack";
					const beforeResume = requests.length;
					await session.prompt("Continue the local check.");
					assert(requests.length > beforeResume, "Confirmed recovery did not restore sending");
					const beforeCustom = requests.length;
					await session.sendCustomMessage({ customType: "synthetic-recovery", content: "Continue the recovered synthetic task.", display: false }, { triggerTurn: true });
					assert(requests.length > beforeCustom, "Successful recovery did not restore custom-triggered runs");
				}
			}
		}
		const result = { case: workerCase, httpRequests: requests.length, writerRequests: requests.filter((value) => value.writer).length, mainRequests: requests.filter((value) => !value.writer).length, diagnostics: diagnostics.map((value) => value.match(/(?:CONTEXT|HISTORY)_[A-Z_]+/)?.[0] ?? "extension-error"), agentDir, sessionFile: manager.getSessionFile(), markerPresent: existsSync(marker) };
		writeFileSync(join(caseDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} finally {
		session?.dispose();
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
	}
}

// Inside a Node project, the package's Pi imports can resolve to that project's own Pi build instead of the
// host under test (here, the repository's patched workspace once `npm run build:offline` has run).
function assertNoShadowingHost(directory) {
	for (let current = directory; ; current = dirname(current)) {
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) {
			if (existsSync(join(current, "node_modules", name))) {
				throw new Error(`${join(current, "node_modules", name)} would shadow the host under test; point TMPDIR outside any Node project`);
			}
		}
		if (dirname(current) === current) return;
	}
}

async function parentAcceptance() {
	// Install, load and run the package from a directory outside any Node project, so only the official host is linked.
	const isolatedRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-preview-acceptance-")));
	const candidate = join(isolatedRoot, "package");
	cpSync(packageDir, candidate, { recursive: true });
	assertNoShadowingHost(candidate);
	workDir = isolatedRoot;
	const isolation = { packageCopy: "temporary directory outside any Node project", shadowingHost: "none" };
	const report = { host: `official npm Pi ${stockVersion}`, providers: "loopback HTTP synthetic only", assertions: [], limitations: ["A filesystem that cannot persist even the first marker cannot preserve that failure across restart; same-process fail-closed behavior is verified.", "Compatible rollback uses the same preview schema and code with temporary distribution metadata, not a historical released preview."] };
	const stockFiles = ["package.json", "dist/bundle/cli.js", "dist/index.js", "dist/core/sdk.js", "dist/core/extensions/runner.js", "dist/core/session-manager.js"];
	const originalStockHashes = Object.fromEntries(stockFiles.map((file) => [file, fileHash(join(stockPackage, file))]));
	let daemon;
	async function check(name, fn) {
		try { const evidence = await fn(); report.assertions.push({ name, passed: true, ...(evidence ? { evidence } : {}) }); process.stdout.write(`PASS ${name}\n`); return evidence; }
		catch (error) { report.assertions.push({ name, passed: false, error: error.message }); process.stdout.write(`FAIL ${name}: ${error.message}\n`); return undefined; }
	}
	try {
		await check("clean official host and independent package", () => {
			inspectOfficialPi(stockRoot, stockVersion);
			assert(realpathSync(stockPackage).startsWith(`${realpathSync(stockRoot)}${sep}`), "Official host resolves outside the clean installation");
			for (const file of ["core/sdk.js", "core/extensions/runner.js", "core/session-manager.js"]) assert(!readFileSync(join(stockPackage, "dist", file), "utf8").includes("CONTEXT_RESIDENT_REQUIRED"), "The supposedly stock runtime contains resident host changes");
			const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
			assert(Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.length === 1, "Candidate must expose one default extension entry");
			for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "typebox"]) assert(!manifest.dependencies?.[name], `Host dependency ${name} was bundled as a runtime dependency`);
			assert(!existsSync(join(candidate, "node_modules")), "Candidate carries a second host dependency tree");
			const build = JSON.parse(readFileSync(join(candidate, "preview-build.json"), "utf8"));
			assert((build.supportedPiVersions ?? [build.supportedPi]).includes(stockVersion), "Candidate does not declare this official host as supported");
			assert(build.build.startsWith("stock-preview+src."), "Candidate has no independent preview build identity");
			assert.equal(build.sourceHash.slice(0, 16), build.build.split(".").at(-1), "Candidate build ID does not match its source fingerprint");
			assert(build.sources.every((entry) => /^(?:packages\/coding-agent\/src\/extensions\/context-memory\/(?:(?:config|events|history|identity|notes)\.ts|preview\/[^/]+\.ts)|packages\/compaction-core\/src\/[^/]+\.ts)$/.test(entry.file)), "Candidate source graph includes resident lifecycle or host modules");
			assert(build.externalImports.includes("@earendil-works/pi-coding-agent") && build.externalImports.includes("typebox"), "Candidate omitted its host-provided dependency boundary");
			const lock = JSON.parse(readFileSync(join(stockRoot, "node_modules", ".package-lock.json"), "utf8"));
			const provenance = lock.packages["node_modules/@earendil-works/pi-coding-agent"];
			report.stockProvenance = { version: provenance.version, resolved: provenance.resolved, integrity: provenance.integrity, fileHashesBefore: originalStockHashes };
			report.candidate = { build: build.build, sourceHash: build.sourceHash, manifestHash: fileHash(join(candidate, "package.json")), entryHash: fileHash(join(candidate, manifest.pi.extensions[0])), buildMetadataHash: fileHash(join(candidate, "preview-build.json")), sources: build.sources, externalImports: build.externalImports };
		});
		const packageAgent = join(workDir, "package-agent");
		mkdirSync(packageAgent, { recursive: true });
		const dummy = join(workDir, "existing-dummy-package");
		mkdirSync(dummy, { recursive: true });
		writeFileSync(join(dummy, "package.json"), JSON.stringify({ name: "synthetic-existing-extension", type: "module", pi: { extensions: ["./extension.js"] } }));
		writeFileSync(join(dummy, "extension.js"), "export default function existingExtension() {}\n");
		const dummyHashes = Object.fromEntries(["package.json", "extension.js"].map((file) => [file, fileHash(join(dummy, file))]));
		const preservedSettings = { defaultProvider: "synthetic-existing-provider", retry: { enabled: false, maxRetries: 7 }, syntheticThirdPartySetting: { value: "keep-existing-value" } };
		writeFileSync(join(packageAgent, "settings.json"), JSON.stringify({ ...preservedSettings, packages: [dummy] }));
		function assertExistingSettingsPreserved() {
			const disk = JSON.parse(readFileSync(join(packageAgent, "settings.json"), "utf8"));
			for (const [key, value] of Object.entries(preservedSettings)) assert.deepEqual(disk[key], value, `Package operation changed existing ${key}`);
			assert(disk.packages.includes(dummy), "Package operation removed an unrelated existing extension");
			assert.deepEqual(Object.fromEntries(Object.keys(dummyHashes).map((file) => [file, fileHash(join(dummy, file))])), dummyHashes, "Package operation changed the unrelated existing extension files");
		}
		const gitRoot = join(workDir, "git-server");
		const remote = join(gitRoot, "owner", "preview.git");
		const work = join(workDir, "git-source");
		mkdirSync(dirname(remote), { recursive: true });
		cpSync(candidate, work, { recursive: true });
		await command("git", ["init", "-b", "extension-preview", work]);
		await command("git", ["-C", work, "config", "user.name", "Synthetic acceptance"]);
		await command("git", ["-C", work, "config", "user.email", "synthetic@example.invalid"]);
		await command("git", ["-C", work, "add", "."]);
		await command("git", ["-C", work, "commit", "-m", "Synthetic initial package"]);
		const initialCommit = (await command("git", ["-C", work, "rev-parse", "HEAD"])).trim();
		await command("git", ["-C", work, "tag", "preview-compatible-initial"]);
		// The published repository defaults to its source monorepo, not the package.
		// A distinct default branch proves that @extension-preview is necessary.
		await command("git", ["-C", work, "switch", "--orphan", "main"]);
		writeFileSync(join(work, "package.json"), JSON.stringify({ name: "synthetic-monorepo-root", private: true, workspaces: [] }));
		writeFileSync(join(work, "README.md"), "Synthetic source root; the extension package is on extension-preview.\n");
		await command("git", ["-C", work, "add", "."]);
		await command("git", ["-C", work, "commit", "-m", "Synthetic source monorepo"]);
		const defaultCommit = (await command("git", ["-C", work, "rev-parse", "HEAD"])).trim();
		await command("git", ["-C", work, "switch", "extension-preview"]);
		await command("git", ["clone", "--bare", work, remote]);
		await command("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
		const port = await unusedPort();
		daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", `--base-path=${gitRoot}`, "--listen=127.0.0.1", `--port=${port}`, gitRoot], { env: environment(packageAgent), stdio: "ignore" });
		for (let attempt = 0; attempt < 30; attempt++) {
			const ready = await new Promise((done) => { const socket = createConnection(port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => done(false)); });
			if (ready) break;
			if (attempt === 29) throw new Error("Loopback git daemon did not start");
			await new Promise((done) => setTimeout(done, 30));
		}
		const repositorySource = `git:git://127.0.0.1:${port}/owner/preview`;
		const source = `${repositorySource}@extension-preview`;
		const stockCli = join(stockPackage, "dist", "bundle", "cli.js");
		const cli = (parameters) => command(process.execPath, [stockCli, ...parameters], { env: environment(packageAgent) });
		const stock = await import(pathToFileURL(join(stockPackage, "dist", "index.js")).href);
		const settings = stock.SettingsManager.create(workDir, packageAgent);
		const pm = new stock.DefaultPackageManager({ cwd: workDir, agentDir: packageAgent, settingsManager: settings });
		let downloaded;
		const installedHead = () => command("git", ["-C", downloaded, "rev-parse", "HEAD"]).then((value) => value.trim());
		await check("stock CLI downloads and persists the explicit extension-preview branch", async () => {
			await cli(["install", source]);
			await settings.reload();
			downloaded = pm.getInstalledPath(source, "user");
			assert(downloaded && existsSync(join(downloaded, "package.json")), "Package was not downloaded");
			assert(realpathSync(downloaded).startsWith(`${realpathSync(packageAgent)}${sep}`), "Package was loaded from an external source instead of downloaded");
			assert(settings.getGlobalSettings().packages.includes(source), "Install declaration was not persisted");
			const commit = await installedHead();
			assert.equal(commit, initialCommit, "Install did not select the explicit package branch");
			assert.notEqual(commit, defaultCommit, "Install selected the non-package default branch");
			assertExistingSettingsPreserved();
			assert(!existsSync(join(downloaded, "node_modules", "@earendil-works", "pi-coding-agent")), "Install added another Pi runtime");
			return { manifestName: JSON.parse(readFileSync(join(downloaded, "package.json"), "utf8")).name, ref: "extension-preview", commit, defaultBranch: "main", defaultCommit };
		});
		await check("stock CLI update --extensions advances the explicit extension-preview branch", async () => {
			const beforeCommit = await installedHead();
			writeFileSync(join(work, "synthetic-update-marker.txt"), "updated distribution metadata\n");
			await command("git", ["-C", work, "add", "."]);
			await command("git", ["-C", work, "commit", "-m", "Synthetic package update"]);
			const updatedCommit = (await command("git", ["-C", work, "rev-parse", "HEAD"])).trim();
			await command("git", ["-C", work, "push", remote, "extension-preview"]);
			await cli(["update", "--extensions"]);
			await settings.reload();
			const afterCommit = await installedHead();
			assert.equal(beforeCommit, initialCommit, "Update did not start from the installed package commit");
			assert.notEqual(afterCommit, beforeCommit, "Explicit branch ref stayed at the older commit");
			assert.equal(afterCommit, updatedCommit, "Update did not advance to the actual branch head");
			assert(settings.getGlobalSettings().packages.includes(source), "Update replaced the explicit branch declaration");
			assert(existsSync(join(downloaded, "synthetic-update-marker.txt")), "Update did not download the newer package tree");
			assertExistingSettingsPreserved();
			return { command: ["pi", "update", "--extensions"], ref: "extension-preview", beforeCommit, afterCommit };
		});
		await check("stock CLI compatible rollback selects the previous immutable ref", async () => {
			const pinned = `${repositorySource}@preview-compatible-initial`;
			await cli(["install", pinned]);
			await cli(["update", "--extension", pinned]);
			await settings.reload();
			const commit = await installedHead();
			assert.equal(commit, initialCommit, "Compatible rollback did not select the original immutable commit");
			assert(settings.getGlobalSettings().packages.includes(pinned), "Rollback did not persist the immutable tag declaration");
			assert(!settings.getGlobalSettings().packages.includes(source), "Rollback left the updating branch declaration active");
			assert(!existsSync(join(downloaded, "synthetic-update-marker.txt")), "Compatible rollback did not restore the pinned prior package tree");
			assertExistingSettingsPreserved();
			return { ref: "preview-compatible-initial", commit };
		});
		const runtimeCases = ["doctor-read-only", "success", "duplicate-copies", "repeat-compaction", "bad-quote", "bad-source", "bad-supersedes", "malformed-note", "writer-unavailable", "config-invalid", "marker-corrupt", "memory-change", "disk-change", "checkpoint-write-failed", "stage-marker-io", "first-marker-io", "cancelled", "unobserved-commit", "cache-warming", "automatic-compaction", "pressure-prepared", "pressure-failed"];
		const results = new Map();
		for (const name of runtimeCases) {
			const value = await check(`official host runtime: ${name}`, async () => {
				await command(process.execPath, [script, "--package-dir", candidate, "--stock-root", stockRoot, "--output-dir", workDir, "--installed-package-dir", downloaded ?? candidate, "--runtime-case", name], { env: environment(join(workDir, "runtime", name, "agent")) });
				return JSON.parse(readFileSync(join(workDir, "runtime", name, "result.json"), "utf8"));
			});
			if (value) results.set(name, value);
		}
		for (const [name, fixture] of [["reopen-success", results.get("success")], ["reopen-success", results.get("pressure-prepared")], ["reopen-blocked", results.get("bad-source")], ["reopen-blocked", results.get("pressure-failed")], ["recover-unobserved", results.get("unobserved-commit")]]) {
			await check(`fresh process ${name}`, async () => {
				assert(fixture, "Required runtime fixture did not pass");
				await command(process.execPath, [script, "--package-dir", candidate, "--stock-root", stockRoot, "--output-dir", workDir, "--installed-package-dir", downloaded, "--runtime-case", name, "--reuse-agent-dir", fixture.agentDir, "--session-file", fixture.sessionFile], { env: environment(fixture.agentDir) });
				return JSON.parse(readFileSync(join(workDir, "runtime", name, "result.json"), "utf8"));
			});
		}
		// Each older supported host compacts the same session in turn, and the primary host reopens its checkpoint.
		const compatibleRoots = argumentList("--compatible-stock-root").map((value) => resolve(value));
		if (compatibleRoots.length) {
			const build = JSON.parse(readFileSync(join(candidate, "preview-build.json"), "utf8"));
			const declared = build.supportedPiVersions ?? [build.supportedPi];
			const compatibleHosts = compatibleRoots.map((root) => {
				const version = JSON.parse(readFileSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
				return { root, version: inspectOfficialPi(root, version).version };
			});
			const versions = compatibleHosts.map((host) => host.version);
			assert(versions.every((version) => version !== stockVersion && declared.includes(version)) && new Set(versions).size === versions.length, "Compatible hosts must be distinct older versions the candidate declares");
			report.compatibleHosts = compatibleHosts.map((host) => ({ version: host.version }));
			const fixture = results.get("success");
			for (const compatible of compatibleHosts) {
				await check(`compatible official Pi ${compatible.version} reopens and compacts the primary host checkpoint`, async () => {
					assert(fixture, "Required primary-host checkpoint fixture did not pass");
					await command(process.execPath, [script, "--package-dir", candidate, "--stock-root", compatible.root, "--output-dir", workDir, "--installed-package-dir", downloaded, "--runtime-case", "repeat-compaction", "--reuse-agent-dir", fixture.agentDir, "--session-file", fixture.sessionFile], { env: environment(fixture.agentDir) });
					return { host: compatible.version, passed: true };
				});
				await check(`primary host reopens the Pi ${compatible.version} checkpoint`, async () => {
					assert(fixture, "Required primary-host checkpoint fixture did not pass");
					await command(process.execPath, [script, "--package-dir", candidate, "--stock-root", stockRoot, "--output-dir", workDir, "--installed-package-dir", downloaded, "--runtime-case", "reopen-success", "--reuse-agent-dir", fixture.agentDir, "--session-file", fixture.sessionFile], { env: environment(fixture.agentDir) });
					return { host: stockVersion, compatibleHost: compatible.version, passed: true };
				});
			}
		}
		await check("stock CLI removes the package by repository, whichever ref is installed", async () => {
			// The documented command names only the repository; a pinned tag is installed at this point.
			await cli(["remove", repositorySource]);
			await settings.reload();
			assert.deepEqual(settings.getGlobalSettings().packages, [dummy], "Remove did not preserve only the unrelated original package");
			assert(!existsSync(downloaded), "Remove left the managed Git checkout installed");
			assertExistingSettingsPreserved();
		});
		// The npm channel: the archive the build packed, served by name from a loopback registry, as npm serves it.
		const packed = join(dirname(packageDir), "context-memory-preview-package-report.json");
		const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
		const registryEnv = (registry) => ({ ...environment(packageAgent), npm_config_offline: "false", npm_config_registry: registry.url });
		let npmInstalled;
		await check("stock CLI installs the release archive by name from npm", async () => {
			const pack = JSON.parse(readFileSync(packed, "utf8"));
			assert.equal(pack.build, report.candidate.build, "The packed archive is from another build");
			const archive = join(dirname(packageDir), pack.archive);
			assert.equal(fileHash(archive), pack.sha256, "The packed archive changed after the build");
			const registry = await startLoopbackRegistry({ packages: [{ manifest, archive }] });
			const spec = `npm:${manifest.name}@${manifest.version}`;
			try {
				await command(process.execPath, [stockCli, "install", spec], { env: registryEnv(registry) });
			} finally {
				await registry.close();
			}
			assert(registry.requests.includes(`GET /${manifest.name}/-/${pack.archive}`), "Pi did not fetch the archive from the registry");
			await settings.reload();
			npmInstalled = pm.getInstalledPath(spec, "user");
			assert(npmInstalled && realpathSync(npmInstalled).startsWith(`${realpathSync(packageAgent)}${sep}`), "The npm package was not installed in Pi's agent directory");
			assert(settings.getGlobalSettings().packages.includes(spec), "Install declaration was not persisted");
			for (const file of ["package.json", "preview-build.json", "README.md", "LICENSE", ...manifest.pi.extensions]) {
				assert.equal(fileHash(join(npmInstalled, file)), fileHash(join(candidate, file)), `The npm installation changed ${file}`);
			}
			assert(!existsSync(join(dirname(npmInstalled), "@earendil-works")), "Install added another Pi runtime beside the package");
			assertExistingSettingsPreserved();
			return { spec, archive: pack.archive, sha256: pack.sha256, requests: registry.requests };
		});
		await check("official host runtime from the npm installation: success", async () => {
			assert(npmInstalled, "The npm installation did not pass");
			await command(process.execPath, [script, "--package-dir", candidate, "--stock-root", stockRoot, "--output-dir", workDir, "--installed-package-dir", npmInstalled, "--runtime-case", "success", "--runtime-label", "npm-success"], { env: environment(join(workDir, "runtime", "npm-success", "agent")) });
			return JSON.parse(readFileSync(join(workDir, "runtime", "npm-success", "result.json"), "utf8"));
		});
		await check("stock CLI removes the npm package by name, whichever version is installed", async () => {
			assert(npmInstalled, "The npm installation did not pass");
			await cli(["remove", `npm:${manifest.name}`]);
			await settings.reload();
			assert.deepEqual(settings.getGlobalSettings().packages, [dummy], "Remove did not preserve only the unrelated original package");
			assert(!existsSync(npmInstalled), "Remove left the npm package installed");
			assertExistingSettingsPreserved();
		});
	} finally {
		if (daemon) { daemon.kill("SIGTERM"); await once(daemon, "exit").catch(() => {}); }
		report.passed = report.assertions.length > 0 && report.assertions.every((value) => value.passed);
		const finalStockHashes = Object.fromEntries(stockFiles.map((file) => [file, fileHash(join(stockPackage, file))]));
		if (report.stockProvenance) report.stockProvenance.fileHashesAfter = finalStockHashes;
		await check("official CLI, SDK, runner and session storage bytes stayed unchanged", () => assert.deepEqual(finalStockHashes, originalStockHashes));
		report.passed = report.assertions.length > 0 && report.assertions.every((value) => value.passed);
		report.isolation = isolation;
		report.segments = segmentsOn ? "on" : "off";
		report.cleanup = { retained: ["report.json", "runtime/*/result.json"], removed: ["isolated package copy", "loopback Git server and source checkout", "managed test installation", "synthetic session/config/auth files", "temporary npm cache"] };
		writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
		const runtimeDir = join(workDir, "runtime");
		rmSync(join(outputDir, "runtime"), { recursive: true, force: true });
		if (existsSync(runtimeDir)) {
			for (const name of readdirSync(runtimeDir)) {
				const resultPath = join(runtimeDir, name, "result.json");
				if (!existsSync(resultPath)) continue;
				mkdirSync(join(outputDir, "runtime", name), { recursive: true });
				writeFileSync(join(outputDir, "runtime", name, "result.json"), readFileSync(resultPath));
			}
		}
		rmSync(isolatedRoot, { recursive: true, force: true });
	}
	if (!report.passed) process.exitCode = 1;
}

if (workerCase) await runtimeAcceptance();
else await parentAcceptance();
