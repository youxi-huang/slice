import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";

// Bounded A/B comparison of the preview's compaction paths on official Pi: sync (both switches off), A
// (previewPreparation) and B (previewWorkNotes). Every arm runs the same scripted conversation and settings
// against a loopback provider, which never contacts a model service. By default a faithful script writes the
// notes. With --bridge, the writer's requests and B's note decisions are written to files and the run waits for
// an answer from outside, such as a model run by hand; nothing else changes. Prices and latency are synthetic.

const script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
function argument(name, fallback) {
	const index = args.indexOf(name);
	if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
	if (fallback !== undefined) return fallback;
	throw new Error(`Missing ${name}. Usage: node ${script} --package-dir <package> --stock-root <official Pi> --output-dir <dir> [--window 128000] [--latency-ms 0] [--arms sync,a,b] [--cycles 2] [--pace settled|immediate] [--logs user|model] [--bridge <dir>]`);
}
const packageDir = resolve(argument("--package-dir"));
const stockRoot = resolve(argument("--stock-root"));
const outputDir = resolve(argument("--output-dir"));
const latencyMs = Number(argument("--latency-ms", "0"));
const WINDOW = Number(argument("--window", "128000"));
const bridgeArgument = argument("--bridge", "");
const bridge = bridgeArgument ? resolve(bridgeArgument) : "";
const ARMS = argument("--arms", "sync,a,b").split(",");
// Compactions per arm: each cycle is a ruling, a long log and a follow-up, then /compact.
const CYCLES = Number(argument("--cycles", "2"));
// settled waits for A's preparation before the next input, A's best case; immediate sends it at once, as a user does.
const PACE = argument("--pace", "settled");
const workerArm = argument("--arm", "");
/** Provider requests one arm may make; the run stops beyond it. */
const MAX_REQUESTS = 80;
/** How long one bridged request waits for its answer before it fails as a provider error. */
const BRIDGE_WAIT_MS = 900_000;
if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 5000) throw new Error("--latency-ms must be an integer from 0 to 5000");
if (!Number.isInteger(WINDOW) || WINDOW < 32_000 || WINDOW > 1_000_000) throw new Error("--window must be an integer from 32000 to 1000000");
if (!ARMS.length || ARMS.some((arm) => !["sync", "a", "b"].includes(arm))) throw new Error("--arms takes sync, a and b");
if (!Number.isInteger(CYCLES) || CYCLES < 1 || CYCLES > 8) throw new Error("--cycles must be an integer from 1 to 8");
if (!["settled", "immediate"].includes(PACE)) throw new Error("--pace takes settled or immediate");

const WORK_NOTE_GUIDELINE = "Call context_note after a decision";
/** The note request of 0.5.3 and later, then that of v0.5.2 and earlier, which the quotation repair still carries. */
const WRITER_REQUESTS = ["Return ONLY the memory note itself", "Return ONLY one JSON object matching this schema"];
// About 4 bytes per token, typical of English, on the scale of Pi's own estimate.
const tokens = (text) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);
// Each log puts the turn after it inside A's preparation band: 30% into the band below Pi's threshold.
const PI_THRESHOLD = WINDOW - 16_384;
const BAND_START = PI_THRESHOLD - Math.min(32_768, Math.max(8_192, Math.floor(PI_THRESHOLD * 0.125)));
const LOG_LINES = Math.ceil(((BAND_START + 0.3 * (PI_THRESHOLD - BAND_START) - 3_000) * 4) / 41);
// The build line sits mid-log, outside the start and end that a shortened user message keeps.
const log = (cycle) =>
	`Local check log ${cycle}:\n${Array.from({ length: LOG_LINES }, (_, i) => (i === Math.floor(LOG_LINES / 2) ? `build ${6 + cycle} green` : `log ${cycle}.${String(i).padStart(5, "0")}: local check ok, port healthy`)).join("\n")}`;
const RULES = "Use port 4317. Do not deploy this synthetic service. Keep the settings in config/service.json. Set the retry limit to 7 and the request timeout to 2,500 ms.";
/** One identical script for every arm: a ruling, a long log, a follow-up, then /compact. `notes` drive the scripted B model. */
// --logs user pastes each log as a user message, which B never shortens and so leaves to the writer; --logs model
// has the model show it, as a tool's output would be, and the scripted model notes it on the following turn.
const LOGS = argument("--logs", "user");
if (!["user", "model"].includes(LOGS)) throw new Error("--logs takes user or model");
const logNotes = (cycle) => [{ section: "state", marker: `build ${6 + cycle} green` }, ...(cycle === 1 ? [{ section: "files", marker: "config/service.json" }] : [])];
// Cycle 1 rules port 4317 and records 4319 failing; each later cycle moves to a new port, skipping 4319.
const port = (cycle) => (cycle === 1 ? 4317 : cycle === 2 ? 4318 : 4320 + cycle);
const CURRENT_PORT = String(port(CYCLES));
const TURNS = Array.from({ length: CYCLES }, (_, index) => {
	const cycle = index + 1;
	const follow =
		cycle === 1
			? { text: "Port 4319 failed: address in use. Stay on the agreed port.", notes: [{ section: "failedPaths", marker: "Port 4319 failed: address in use." }] }
			: { text: "Continue checking.", notes: [] };
	return [
		{ text: cycle === 1 ? RULES : `Use port ${port(cycle)} now; ${port(cycle - 1)} no longer applies.`, notes: [] },
		LOGS === "user" ? { text: log(cycle), notes: logNotes(cycle) } : { text: "Run the local check and show its log.", reply: log(cycle), notes: [] },
		LOGS === "user" ? follow : { ...follow, notes: [...logNotes(cycle), ...follow.notes] },
	];
});
// What the faithful scripted writer records when it can see the marker, and where.
const FACTS = [
	{ marker: "Do not deploy this synthetic service.", kind: "instructions" },
	{ marker: "Set the retry limit to 7 and the request timeout to 2,500 ms.", kind: "instructions" },
	{ marker: "config/service.json", kind: "files" },
	{ marker: "Port 4319 failed: address in use.", kind: "failedPaths" },
	...TURNS.flatMap((_, index) => [
		{ marker: `build ${7 + index} green`, kind: "state" },
		...(index + 1 < CYCLES ? [{ marker: `Use port ${port(index + 2)} now`, kind: "instructions" }] : []),
	]),
];
const STALE_PORTS = TURNS.slice(0, -1).map((_, index) => String(port(index + 1)));
// Recovery probes on what the model sees after a restart. The last two look for restatement errors: exact
// numbers changed, or an overturned port stated as current.
const PROBES = {
	"no deployment": (payload) => /do not deploy|not (be )?deploy|deployment (is )?(not|un)authori[sz]ed|no deploy/i.test(payload),
	"settings file": (payload) => payload.includes("config/service.json"),
	"failed port": (payload) => /4319[^\n]{0,120}(fail|in use)|(fail|in use)[^\n]{0,120}4319/i.test(payload),
	...Object.fromEntries(
		TURNS.map((_, index) => [`build ${7 + index}`, (payload) => new RegExp(`build ${7 + index}\\b[^\\n]{0,20}(green|pass)`, "i").test(payload)]),
	),
	"current port": (payload) => payload.includes(CURRENT_PORT),
	"exact numbers": (payload) => /retr(y|ies)[^\n]{0,60}\b7\b/i.test(payload) && /2,?500 ?ms|2\.5 ?s(econds)?\b/i.test(payload),
	"no stale port": (_payload, note) =>
		Object.values(note ?? {})
			.flat()
			.every((item) => {
				const text = typeof item === "string" ? item : item.text;
				return (
					!STALE_PORTS.some((stale) => text.includes(stale)) ||
					text.includes(CURRENT_PORT) ||
					(item.supersedes?.length ?? 0) > 0 ||
					/no longer|replac|supersed|previous|earlier|former|instead|was /i.test(text)
				);
			}),
};

function environment(agentDir) {
	const value = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: "C.UTF-8",
		CI: "1",
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "0", // Loopback HTTP needs transport; no catalog or provider network is used.
		PI_TELEMETRY: "0",
		PI_SKIP_VERSION_CHECK: "1",
	};
	if (process.env.SystemRoot) value.SystemRoot = process.env.SystemRoot;
	return value;
}

/** The provider request as plain text, for a model answering through the bridge. */
function renderMessages(messages) {
	return messages
		.map((message) => {
			// Text parts keep their own line breaks, so long logs stay readable line by line.
			const content =
				typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content.map((part) => (part?.type === "text" ? part.text : JSON.stringify(part))).join("\n")
						: JSON.stringify(message.content ?? "");
			const calls = message.tool_calls ? `\n[tool calls] ${JSON.stringify(message.tool_calls.map((call) => call.function))}` : "";
			return `## ${message.role}${message.tool_call_id ? ` (result of ${message.tool_call_id})` : ""}\n${content}${calls}`;
		})
		.join("\n\n");
}

async function worker() {
	const arm = workerArm;
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const caseDir = join(outputDir, "arms", arm);
	mkdirSync(agentDir, { recursive: true });
	let commandOutput;
	for (const level of ["log", "warn", "error"]) {
		const original = console[level].bind(console);
		console[level] = (...parts) => {
			const text = parts.map(String).join(" ");
			if (commandOutput) commandOutput.push(text);
			else if (!text.includes("Source-linked compaction")) original(...parts);
		};
	}
	const stockPackage = join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent");
	const stock = await import(pathToFileURL(join(stockPackage, "dist", "index.js")).href);

	let manager;
	let turn;
	const requests = [];
	let lastMainPayload = "";
	let asked = 0;
	const branchText = (marker) => manager.getBranch().filter((entry) => entry.type === "message" && JSON.stringify(entry.message.content ?? "").includes(marker));
	/** A faithful writer: every fact whose marker it can see, cited to the original that contains it. */
	function writerNote(serialized) {
		const note = { instructions: [], failedPaths: [], reasons: [], state: [], nextSteps: [], files: [], gaps: [] };
		for (const fact of FACTS) {
			if (!serialized.includes(fact.marker)) continue;
			const source = branchText(fact.marker)[0];
			if (source) note[fact.kind].push({ text: fact.marker, sources: [source.id], ...(fact.kind === "instructions" ? { quote: fact.marker } : {}) });
		}
		// A faithful writer also retires an overturned ruling: only the newest port it sees stays, naming those it replaces.
		const ports = note.instructions.filter((item) => item.text.startsWith("Use port "));
		if (ports.length > 1) {
			note.instructions = note.instructions.filter((item) => !ports.includes(item) || item === ports.at(-1));
			ports.at(-1).supersedes = ports.slice(0, -1).flatMap((item) => item.sources);
		}
		if (!note.state.length) note.state.push({ text: "The local service check continues.", sources: [manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user").id] });
		return note;
	}
	/** Write a request for an outside answer and wait for it; a missing answer fails like a provider error. */
	async function ask(kind, text) {
		const name = `${arm}-${String(++asked).padStart(2, "0")}-${kind}`;
		writeFileSync(join(bridge, `${name}.request.md`), text);
		const answer = join(bridge, `${name}.response.json`);
		let seen;
		for (const deadline = Date.now() + BRIDGE_WAIT_MS; Date.now() < deadline; ) {
			if (existsSync(answer)) {
				try {
					return JSON.parse(readFileSync(answer, "utf8"));
				} catch {
					// Still being written, or malformed: a malformed answer fails after five seconds.
					seen ??= Date.now();
					if (Date.now() - seen > 5_000) return undefined;
				}
			}
			await new Promise((done) => setTimeout(done, 500));
		}
		return undefined;
	}
	function respond(response, model, payloadTokens, { text = "", toolCall } = {}) {
		const chunk = (delta, finish, usage) =>
			`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
		const delta = toolCall
			? { role: "assistant", tool_calls: [{ index: 0, id: `ab-${requests.length}`, type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] }
			: { role: "assistant", content: text };
		const output = tokens(JSON.stringify(delta));
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.write(chunk(delta, null));
		response.write(chunk({}, toolCall ? "tool_calls" : "stop", { prompt_tokens: payloadTokens, completion_tokens: output, total_tokens: payloadTokens + output }));
		response.end("data: [DONE]\n\n");
	}
	function fail(response, message) {
		response.writeHead(500, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message, type: "server_error" } }));
	}
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		const payload = JSON.parse(raw);
		const serialized = JSON.stringify(payload.messages ?? []);
		const payloadTokens = tokens(JSON.stringify({ messages: payload.messages, tools: payload.tools }));
		if (requests.length >= MAX_REQUESTS) return fail(response, "synthetic request budget exhausted");
		const writing = WRITER_REQUESTS.some((marker) => serialized.includes(marker));
		// Counted on arrival, so a request in flight when a compaction starts is not charged to that compaction.
		requests.push({ kind: writing ? "writer" : "main", inputTokens: payloadTokens });
		if (latencyMs) await new Promise((done) => setTimeout(done, latencyMs));
		if (writing) {
			if (!bridge) return respond(response, payload.model, payloadTokens, { text: JSON.stringify(writerNote(serialized)) });
			const answer = await ask(
				"writer",
				`# A request to the model\n\nYou are the model receiving the provider request below. Answer it exactly as asked: the last user message asks for one JSON object. Answer with JSON {"text": "<your complete reply>"}.\n\n${renderMessages(payload.messages)}`,
			);
			// The reply as a string under "text", or the reply object itself.
			const text = answer === undefined ? undefined : typeof answer.text === "string" ? answer.text : JSON.stringify(answer.text ?? answer);
			return text ? respond(response, payload.model, payloadTokens, { text }) : fail(response, "no bridged answer");
		}
		lastMainPayload = serialized;
		// With B's guideline in its system prompt, the model may note what a turn established: one search for entry
		// IDs, then the note. Without the guideline it writes no notes.
		const guided = serialized.includes(WORK_NOTE_GUIDELINE);
		if (guided && bridge && !turn.decided) {
			turn.decided = true;
			const ids = manager
				.getBranch()
				.filter((entry) => entry.type === "message")
				.map((entry) => `${entry.id} ${entry.message.role}: ${JSON.stringify(entry.message.content ?? "").slice(0, 100)}`);
			const tool = (payload.tools ?? []).find((item) => item.function?.name === "context_note")?.function;
			const answer = await ask(
				"note",
				`# A decision for the session model\n\nYou are the coding assistant in the conversation below. Its system prompt says: "${WORK_NOTE_GUIDELINE} ..." Decide whether you would call the context_note tool now, for the latest user message. If yes, give its arguments; cite entry IDs from the list, which a context_history search would return. Answer with JSON {"note": null} or {"note": <arguments>}.\n\n## context_note\n${tool?.description ?? ""}\nParameters: ${JSON.stringify(tool?.parameters ?? {})}\n\n## Entry IDs on this branch (ID role: opening words)\n${ids.join("\n")}\n\n# Conversation\n\n${renderMessages(payload.messages)}`,
			);
			if (answer?.note) turn.pendingNote = { args: answer.note, query: "decision" };
		} else if (guided && !bridge && !turn.pendingNote) {
			const next = turn.notes.shift();
			if (next) {
				const fact = { text: next.marker, sources: [branchText(next.marker).at(-1).id] };
				turn.pendingNote = { args: next.section === "state" ? { state: [fact] } : { state: [{ text: "Recorded during the local check.", sources: fact.sources }], [next.section]: [fact] }, query: next.marker };
			}
		}
		if (turn.pendingNote && !turn.searched) {
			turn.searched = true;
			return respond(response, payload.model, payloadTokens, { toolCall: { name: "context_history", args: { operation: "search", query: turn.pendingNote.query } } });
		}
		if (turn.pendingNote) {
			const { args } = turn.pendingNote;
			turn.pendingNote = undefined;
			turn.searched = false;
			return respond(response, payload.model, payloadTokens, { toolCall: { name: "context_note", args } });
		}
		return respond(response, payload.model, payloadTokens, { text: turn.reply ?? "Checked; continuing." });
	});
	server.keepAliveTimeout = 600_000;
	server.headersTimeout = 610_000;
	server.requestTimeout = 0;
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const model = {
		id: "synthetic-ab",
		name: "Synthetic A/B",
		provider: "synthetic-ab",
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		reasoning: false,
		input: ["text"],
		contextWindow: WINDOW,
		maxTokens: 8192,
		// Synthetic USD per million tokens, the same for every arm; not a provider's price.
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true },
	};
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir], cacheWarming: "off", defaultTools: [], compaction: { enabled: false, keepRecentTokens: 0 } }));
	writeFileSync(join(agentDir, "pi-context-memory.json"), JSON.stringify({ previewPreparation: { enabled: arm === "a" }, previewWorkNotes: { enabled: arm === "b" } }));
	let session;
	async function open(sessionManager) {
		session?.dispose();
		manager = sessionManager;
		const runtime = await stock.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
		runtime.registerProvider(model.provider, { api: model.api, apiKey: "synthetic-ab-only", baseUrl: model.baseUrl, models: [model] });
		const settingsManager = stock.SettingsManager.create(caseDir, agentDir);
		const loader = new stock.DefaultResourceLoader({ cwd: caseDir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
		await loader.reload();
		if (loader.getExtensions().errors.length) throw new Error("Package load errors");
		session = (await stock.createAgentSession({ cwd: caseDir, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", sessionManager, settingsManager, resourceLoader: loader, noTools: "builtin" })).session;
		await session.bindExtensions({ onError: () => {} });
	}
	async function status() {
		commandOutput = [];
		try {
			await session.prompt("/compaction-status");
			return JSON.parse(commandOutput.join("\n"));
		} finally {
			commandOutput = undefined;
		}
	}
	// Optional preparation runs after the turn. The script lets it finish so every arm submits the same next turn.
	// Pi starts it from agent_settled, just after the prompt returns, so A first waits a moment for it to begin.
	const settle = async () => {
		if (PACE === "immediate") return;
		if (arm === "a") {
			for (const until = Date.now() + (bridge ? 3_000 : 1_000); Date.now() < until && (await status()).preparation?.state !== "preparing"; )
				await new Promise((done) => setTimeout(done, 50));
		}
		for (const deadline = Date.now() + (bridge ? BRIDGE_WAIT_MS : 5_000); Date.now() < deadline && (await status()).preparation?.state === "preparing"; )
			await new Promise((done) => setTimeout(done, bridge ? 500 : 25));
	};
	const result = { arm, turnMs: 0, turnRequests: 0, compactions: [], errors: [] };
	try {
		mkdirSync(caseDir, { recursive: true });
		await open(stock.SessionManager.create(caseDir, join(caseDir, "sessions")));
		for (const [cycle, turns] of TURNS.entries()) {
			for (const scripted of turns) {
				turn = { notes: [...scripted.notes], reply: scripted.reply };
				const started = performance.now();
				const sent = requests.filter((r) => r.kind === "main").length;
				await session.prompt(scripted.text);
				result.turnMs += Math.round(performance.now() - started);
				result.turnRequests += requests.filter((r) => r.kind === "main").length - sent;
				await settle();
			}
			const before = requests.length;
			const started = performance.now();
			let error;
			try {
				await session.compact();
			} catch (cause) {
				error = String(cause?.message ?? cause).slice(0, 200);
			}
			const wallMs = Math.round(performance.now() - started);
			const checkpoint = manager.getBranch().findLast((entry) => entry.type === "compaction");
			const after = await status();
			turn = { notes: [], decided: true };
			await session.prompt("Status check after compaction.");
			result.compactions.push({
				cycle: cycle + 1,
				...(error ? { error } : {}),
				path: checkpoint?.details?.preparation?.path ?? "sync",
				wallMs,
				pauseMs: after.lastCompaction?.pauseMs ?? null,
				foregroundWriterCalls: requests.slice(before).filter((r) => r.kind === "writer").length,
				foregroundWriterInputTokens: requests.slice(before).filter((r) => r.kind === "writer").reduce((sum, r) => sum + r.inputTokens, 0),
				contextTokensAfter: requests.at(-1)?.inputTokens ?? null,
				userMessagesCarried: checkpoint?.details?.userMessages?.length ?? 0,
				noteFacts: checkpoint ? Object.values(checkpoint.details.note).reduce((sum, items) => sum + items.length, 0) : 0,
				...(checkpoint?.details?.preparation?.notesFallback ? { notesFallback: checkpoint.details.preparation.notesFallback } : {}),
				...(checkpoint?.details?.preparation?.preparationFallback ? { preparationFallback: checkpoint.details.preparation.preparationFallback } : {}),
				state: after.state,
				...(after.code ? { code: after.code } : {}),
			});
		}
		const final = await status();
		const notes = manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "context-memory-note");
		const refused = manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "context_note" && entry.message.isError);
		const file = manager.getSessionFile();
		await open(stock.SessionManager.open(file));
		turn = { notes: [], decided: true };
		await session.prompt("Summarize the current port, constraints and state.");
		const restarted = await status();
		const latest = manager.getBranch().findLast((entry) => entry.type === "compaction");
		const usedCalls = new Set(manager.getEntries().flatMap((entry) => (entry.type === "compaction" ? (entry.details?.preparation?.callIds ?? []) : [])));
		const main = manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant").map((entry) => entry.message.usage);
		const sum = (values, pick) => values.reduce((total, value) => total + (pick(value) ?? 0), 0);
		result.main = {
			requests: requests.filter((r) => r.kind === "main").length,
			inputTokens: sum(main, (u) => u.input),
			outputTokens: sum(main, (u) => u.output),
			cost: Number(sum(main, (u) => u.cost?.total).toFixed(6)),
		};
		result.writer = { ...final.calls, usage: { ...final.calls.usage, cost: Number(final.calls.usage.cost.toFixed(6)) } };
		result.workNotes = { saved: notes.length, refused: refused.length };
		result.requests = requests.map((r) => `${r.kind}:${r.inputTokens}`);
		result.discardedPreparationCalls = Math.max(0, (final.calls?.preparationCalls ?? 0) - usedCalls.size);
		result.total = {
			tokens: result.main.inputTokens + result.main.outputTokens + (final.calls?.usage?.totalTokens ?? 0),
			cost: Number((result.main.cost + (final.calls?.usage?.cost ?? 0)).toFixed(6)),
			unknownWriterUsage: final.calls?.unknownUsage ?? 0,
		};
		result.recovery = {
			restartState: restarted.state,
			probes: Object.fromEntries(Object.entries(PROBES).map(([name, probe]) => [name, probe(lastMainPayload, latest?.details?.note)])),
		};
		result.latestNote = latest?.details?.note ?? null;
		// Every boundary counts, covered and fallback alike; a covered one is any that spent no foreground writer call.
		const pauses = result.compactions.map((c) => c.pauseMs ?? c.wallMs);
		const covered = result.compactions.filter((c) => c.path !== "sync").map((c) => c.pauseMs ?? c.wallMs);
		const causes = result.compactions.flatMap((c) => [c.preparationFallback, c.notesFallback].filter(Boolean));
		result.pause = {
			p50: percentile(pauses, 0.5),
			p95: percentile(pauses, 0.95),
			coveredP95: percentile(covered, 0.95),
			covered: covered.length,
			boundaries: pauses.length,
			fallbacks: Object.fromEntries([...new Set(causes)].map((cause) => [cause, causes.filter((c) => c === cause).length])),
		};
		// Turn time beyond the simulated provider latency, per main request: the package's own cost on the request path.
		result.turnOverheadMs = result.turnRequests ? Math.round((result.turnMs - latencyMs * result.turnRequests) / result.turnRequests) : null;
	} catch (error) {
		result.errors.push(String(error?.stack ?? error).slice(0, 800));
	} finally {
		session?.dispose();
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
	}
	writeFileSync(join(caseDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	process.exit(0);
}

// The package's host imports must reach the Pi under test, so a copy outside any Node project is loaded.
/** Nearest-rank percentile; null for no values. */
function percentile(values, share) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)];
}

function assertNoShadowingHost(directory) {
	for (let current = directory; ; current = dirname(current)) {
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) {
			if (existsSync(join(current, "node_modules", name))) throw new Error(`${join(current, "node_modules", name)} would shadow the host under test; point TMPDIR outside any Node project`);
		}
		if (dirname(current) === current) return;
	}
}

async function parent() {
	mkdirSync(outputDir, { recursive: true });
	if (bridge) mkdirSync(bridge, { recursive: true });
	const build = JSON.parse(readFileSync(join(packageDir, "preview-build.json"), "utf8"));
	const hostVersion = JSON.parse(readFileSync(join(stockRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
	const isolated = mkdtempSync(join(tmpdir(), "pi-preview-ab-"));
	const candidate = join(isolated, "package");
	cpSync(packageDir, candidate, { recursive: true });
	const report = {
		providers: bridge ? "loopback HTTP; writer requests and B's note decisions answered through the file bridge" : "loopback HTTP, scripted only",
		runnerSha256: createHash("sha256").update(readFileSync(script)).digest("hex"),
		package: { build: build.build, sourceCommit: build.sourceCommit, sourceHash: build.sourceHash },
		host: inspectOfficialPi(stockRoot, hostVersion),
		settings: { cycles: TURNS.length, pace: PACE, window: WINDOW, logLines: LOG_LINES, logs: LOGS, latencyMs, maxRequestsPerArm: MAX_REQUESTS, bridge: Boolean(bridge), syntheticPricePerMillion: { input: 3, output: 15 } },
		arms: [],
	};
	try {
		assertNoShadowingHost(candidate);
		for (const arm of ARMS) {
			const agentDir = join(outputDir, "arms", arm, "agent");
			rmSync(join(outputDir, "arms", arm), { recursive: true, force: true });
			mkdirSync(agentDir, { recursive: true });
			const child = spawn(process.execPath, [script, "--package-dir", candidate, "--stock-root", stockRoot, "--output-dir", outputDir, "--latency-ms", String(latencyMs), "--window", String(WINDOW), "--cycles", String(CYCLES), "--pace", PACE, "--logs", LOGS, ...(bridge ? ["--bridge", bridge] : []), "--arm", arm], { cwd: outputDir, env: environment(agentDir), stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (data) => {
				stderr = (stderr + data).slice(-2000);
			});
			const timer = setTimeout(() => child.kill("SIGKILL"), bridge ? 7_200_000 : 300_000);
			const [code] = await once(child, "exit");
			clearTimeout(timer);
			const path = join(outputDir, "arms", arm, "result.json");
			const result = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { arm, errors: [`exit ${code}: ${stderr}`] };
			// Keep the compact result only; synthetic sessions and agent state are removed.
			for (const entry of ["agent", "sessions"]) rmSync(join(outputDir, "arms", arm, entry), { recursive: true, force: true });
			report.arms.push(result);
		}
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
	writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	const rows = report.arms.map((r) => {
		const c = r.compactions ?? [];
		const probes = Object.entries(r.recovery?.probes ?? {});
		return [
			r.arm,
			r.turnMs,
			c.map((x) => x.path + (x.error ? "!" : "")).join("/"),
			c.map((x) => x.wallMs).join("/"),
			`${r.pause?.p50 ?? "-"}/${r.pause?.p95 ?? "-"}`,
			r.pause?.coveredP95 ?? "-",
			Object.entries(r.pause?.fallbacks ?? {}).map(([cause, count]) => `${cause} ${count}`).join(", ") || "-",
			c.map((x) => x.foregroundWriterCalls).join("/"),
			c.map((x) => x.contextTokensAfter).join("/"),
			r.main?.requests,
			r.writer?.calls,
			r.total?.tokens,
			r.total?.cost,
			r.arm === "b" ? `${c.filter((x) => x.notesFallback).length}/${c.length}${c.some((x) => x.notesFallback) ? ` (${c.flatMap((x) => (x.notesFallback ? [x.notesFallback] : [])).join(", ")})` : ""}` : "-",
			r.discardedPreparationCalls,
			r.total?.unknownWriterUsage,
			r.turnOverheadMs ?? "-",
			`${probes.filter(([, passed]) => passed).length}/${probes.length}${probes.some(([, passed]) => !passed) ? ` (failed: ${probes.filter(([, passed]) => !passed).map(([name]) => name).join(", ")})` : ""}`,
			r.errors?.length ? "error" : "ok",
		].join(" | ");
	});
	process.stdout.write(`arm | turn ms | paths | pause ms | pause p50/p95 | covered p95 | fallback causes | fg writer calls | context after | main requests | writer calls | total tokens | synthetic cost | B fallbacks | discarded prep | unknown usage | overhead ms/request | probes | run\n${rows.join("\n")}\n`);
	if (report.arms.some((r) => r.errors?.length)) process.exitCode = 1;
}

if (workerArm) await worker();
else await parent();
