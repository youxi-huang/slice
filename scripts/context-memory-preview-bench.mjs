import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkpointRecords, equivalenceLine, errorClasses } from "./context-memory-equivalence-compare.mjs";

// The 0.5.0 writer bench and recovery probes for the independent preview on official Pi.
//
// Sessions come from eval/preview: invented, generated JSONL, cut at fixed checkpoints. No model drives the task;
// only writer calls and probe answers reach a provider. Two modes:
//
//   writer  For each checkpoint cut, earlier cuts are compacted by a deterministic loopback writer that builds
//           faithful notes from the gold files; the measured writer then compacts the cut on fresh copies,
//           --attempts times. Reports refusals by error code and quotation class, repairs and their cost, and
//           for each committed note its size against the bytes it condenses and the gold answers it still cites.
//   probes  The measured writer compacts every cut in order, retrying a refused /compact up to --chain-attempts
//           times in all, so that recall is measured on committed notes; writer mode measures refusals.
//           Each probe then runs on its own copy of the chain at its checkpoint, once with only context_history
//           active and once with no tools. Reports typed-answer scores, retrieval calls and missed-entry probes.
//   repair  For each quotation-repair case of eval/preview/repair.ts, the writer's first call is answered with the
//           case's planted candidate and only the repair reaches the measured model. Reports scores by template
//           and, for the repair calls, stop reasons, the reasoning settings sent, tokens and time.
//
// --provider loopback answers everything locally and never contacts a model service: it checks the harness.
// --provider deepseek-local (repair mode only) builds the same requests from Pi's catalog model and answers them here.
// --provider deepseek uses Pi's catalog model deepseek/deepseek-flash through the environment's network proxy and
// requires --max-requests, --max-minutes and --max-cost-usd; the run stops before a unit that would start past any
// of them. Up to --concurrency units run at once, so at most that many units can finish past a limit.
// --unit-minutes, 10 by default, stops a unit still running after that long: it settles as crashed and counts under
// timedOut, so one request that never returns cannot hold the run, and a probe it held is scored as blocked.
// --provider openai does the same with Pi's catalog model openai/gpt-6-luna at its own address, OpenAI's official API,
// in writer, probes and smoke modes; docs/context-memory/openai-api.md sets up the network secret that supplies the key.
// --provider relay does the same with Pi's catalog model openai/gpt-6-luna, its address moved to --base-url, an
// OpenAI-compatible service that speaks the Responses API and whose key the environment's network proxy supplies.
// --relay-model names another catalog model to move there instead, such as deepseek/deepseek-flash, and --relay-id
// the ID the relay serves it under, such as a self-hosted deployment's; the catalog's API, compatibility settings,
// level map and prices stay, so the request is the one Pi builds for that model and the limits use its prices.
// --cuts 1,3,5, in probes mode, compacts the chain only at those checkpoints, appending everything between them, so one
// fixture serves routes with different lines: P5's cuts 1, 3 and 5 are three rounds on a 200k route, 2 and 4 two
// rounds on a 272k route. --probe-conditions history runs only the condition with context_history, as a session has it.
// --compactions-only, in probes mode, runs a chain's warm-ups and compactions and no probe, for a run that measures the
// writer alone after the probes were measured.
// --arm native, in probes mode with --probe-conditions none, loads no package: Pi's own compaction summarizes each cut
// and the probes answer from its summary. It is the control a Slice run's history condition compares with.
// --max-input-tokens N stops the run once any request reports more than N input tokens, fresh, cached and
// cache-written together, as OpenAI prices a request against its long-context line. No unit starts after it.
// Output files hold counts, codes and timings. answers.jsonl keeps the synthetic probe replies for inspection.
// --keep-sessions keeps every session copy, notes included, for local reading; keep them out of the repository.
// --cache warm, the default, matches daily use, where every main-model turn keeps the session's prefix cached: the
// units of a run share one working directory, and one request over the same history precedes each cut's
// compactions, as a session's last turn would. Each warm-up is itself a cold request; warm-ups count against the
// limits and are reported apart. --cache cold gives each unit its own working directory, which Pi's system prompt
// ends with, so only the prompt's opening can be cached; it reproduces the first 0.5.0 provider run. --cache session
// runs each warm-up turn on the session itself, so it stays in the history the writer compacts: the writer's request
// then continues it, as it continues a session's last turn, which a cache serving only continuations needs.
// Writer and probes runs end with the token-overhead report of eval/preview/overhead.ts under `overhead`: writer
// tokens against the records each note replaces, by cut and by v0.2.3 source-size tier; retrieval usage apart;
// known usage of discarded work, read from the rows and each unit's call journal; calls without usage; cache
// writes; and one net column. --session-settings name=on|off,... sets the preview's own switches, previewReduction,
// previewExcerpts, previewPreparation, previewWorkNotes and previewSegments, writing `{ "enabled": true }` or `{ "enabled": false }`
// under each name into every unit's pi-context-memory.json; any other name or value stops the run before its first
// unit, and without the flag no unit gets that file. The flag as given and --control <label>, the control run a
// candidate compares with, are recorded in summary.json, beside the settings the units received.
// The loopback reports usage proportional to each request, ceil(bytes / 3), and in the history condition reads the
// probe's first gold evidence entry once before it answers, so every column has offline figures.
// --equivalence-out <file>, with a local provider in writer, probes or repair mode, appends the v0.7.0 equivalence
// records of scripts/context-memory-equivalence-compare.mjs when the run ends, sorted by case: one per writer or
// repair attempt with every checkpoint in its session copy, one per probes cut with its chain's checkpoints, and one
// per probe with its error classes. Without the flag no unit, row or file changes.
// --replay, in probes mode with --cache session, runs each round in one unit: the round's entries join the session
// step by step where the agent settles, a real turn follows each step on the session itself, Pi compacts where its
// trigger falls and /compact closes the round at the gold checkpoint. --pace settled waits for the segment in flight
// before the next step; immediate does not. --window sets the route's window. --session-settings previewSegments=on
// and --segment-effort turn segments on at a level; probe units run with segments off. Rows go to boundaries.jsonl
// and rounds.jsonl, and summary.json gains `replay`.

const script = fileURLToPath(import.meta.url);
const root = resolve(script, "../..");
const args = process.argv.slice(2);
function argument(name, fallback) {
	const index = args.indexOf(name);
	if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
	if (fallback !== undefined) return fallback;
	throw new Error(
		`Missing ${name}. Usage: node --experimental-strip-types ${script} --package-dir <package> --stock-root <official Pi> --output-dir <dir> --mode writer|probes|smoke|repair [--provider loopback|deepseek|deepseek-local|openai|relay --base-url https://... [--relay-model provider/id --relay-id id]] [--fixtures P1,P2,P3] [--attempts 8] [--chain-attempts 4] [--cache warm|cold|session] [--cuts 1,3,5] [--probe-conditions history,none] [--compactions-only] [--max-input-tokens N] [--thinking high] [--concurrency 1] [--label name] [--arm slice|native] [--session-settings ${SESSION_SWITCHES.join("|")}=on|off,...] [--control label] [--keep-sessions] [--unit-minutes 10] [--max-requests N --max-minutes N --max-cost-usd N] [--equivalence-out <file>]`,
	);
}

/**
 * The preview's switches in pi-context-memory.json, each read as `{ "enabled": boolean }`, in the order a unit's file
 * lists them. --session-settings sets nothing else, so a run cannot be labelled with a setting its units ignore.
 */
const SESSION_SWITCHES = ["previewReduction", "previewExcerpts", "previewPreparation", "previewWorkNotes", "previewSegments"];
/** The levels --segment-effort accepts, as previewSegments.effort does. */
const SEGMENT_EFFORTS = ["session", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SWITCH_STATES = new Map([
	["on", true],
	["off", false],
]);

/**
 * --session-settings as given (`label`, recorded in summary.json) and as each unit's pi-context-memory.json receives
 * it (`settings`, empty without the flag). Throws a usage error on a malformed pair, an unknown name or value, or a
 * name given twice, before any unit starts.
 */
export function parseSessionSettings(text) {
	const label = {};
	for (const item of text.split(",").filter(Boolean)) {
		const match = item.match(/^([A-Za-z][\w.-]*)=([^=]+)$/);
		if (!match) throw new Error("--session-settings takes name=on|off pairs separated by commas, such as previewReduction=on");
		const [, name, value] = match;
		if (!SESSION_SWITCHES.includes(name))
			throw new Error(`--session-settings: unknown setting ${JSON.stringify(name)}; the bench sets only ${SESSION_SWITCHES.join(", ")}`);
		if (!SWITCH_STATES.has(value)) throw new Error(`--session-settings: ${name} takes on or off, not ${JSON.stringify(value)}`);
		if (Object.hasOwn(label, name)) throw new Error(`--session-settings: ${name} is given twice`);
		label[name] = value;
	}
	const settings = Object.fromEntries(SESSION_SWITCHES.filter((name) => Object.hasOwn(label, name)).map((name) => [name, { enabled: SWITCH_STATES.get(label[name]) }]));
	return { label, settings };
}

/**
 * A unit's pi-context-memory.json: the run's session settings over whatever the file already holds. With no session
 * settings the unit gets no file, so it runs on the package's defaults, as before the flag was wired.
 */
export function writeUnitSettings(agentDir, settings) {
	if (!Object.keys(settings).length) return;
	const file = join(agentDir, "pi-context-memory.json");
	const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(file, `${JSON.stringify({ ...current, ...settings })}\n`);
}

/** The note request of 0.5.3 and later, then that of v0.5.2 and earlier, which the quotation repair still carries. */
const WRITER_REQUESTS = ["Return ONLY the memory note itself", "Return ONLY one JSON object matching this schema"];
/** The catalog model each provider measures; `deepseek-local` builds deepseek-flash's requests and answers them here. */
const MEASURED = {
	deepseek: { provider: "deepseek", id: "deepseek-flash" },
	"deepseek-local": { provider: "deepseek", id: "deepseek-flash" },
	openai: { provider: "openai", id: "gpt-6-luna" },
	relay: { provider: "openai", id: "gpt-6-luna" },
};
/** Where --provider openai sends its requests: OpenAI's official API, the catalog's own address for openai models. */
const OPENAI_HOST = "api.openai.com";
/** The variable Pi reads each relayed catalog provider's key from; the proxy supplies the real one. */
const RELAY_KEYS = { openai: "OPENAI_API_KEY", deepseek: "DEEPSEEK_API_KEY" };
const LOOPBACK = {
	id: "bench-loopback",
	name: "Bench loopback",
	provider: "bench-loopback",
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 32_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true },
};
/** The structure of a parsed answer two levels deep: keys, and for each value its kind and length. Never its text. */
/** One array item's keys and kinds, flagging what the note schema refuses: empty strings, long strings, repeated IDs. */
function itemShape(item) {
	if (Array.isArray(item)) return `array:${item.length}${new Set(item.map(String)).size < item.length ? ":repeated" : ""}`;
	if (typeof item === "string") return !item.length ? "string:empty" : item.length > 4000 ? "string:>4000" : item.length > 1000 ? "string:>1000" : "string";
	if (!item || typeof item !== "object") return typeof item;
	return `{${Object.keys(item)
		.sort()
		.map((key) => `${key}:${itemShape(item[key])}`)
		.join(",")}}`;
}

function jsonShape(value, depth) {
	if (Array.isArray(value)) {
		if (!depth || !value.length) return `array:${value.length}`;
		const items = {};
		for (const item of value) items[itemShape(item)] = (items[itemShape(item)] ?? 0) + 1;
		return { length: value.length, items };
	}
	if (!value || typeof value !== "object") return typeof value;
	if (!depth) return `object:${Object.keys(value).length}`;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonShape(item, depth - 1)]));
}

/**
 * The Responses API answers in output items: reasoning, then one or more messages, each possibly in a phase such as
 * `commentary` or `final_answer`. As each response from a URL ending in `path` streams past Pi's own parser, records
 * its items, and for a message its phase and the shape of its JSON, or its length when it does not parse. Never the
 * text itself.
 */
function observeResponseItems(responses, path) {
	const original = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const response = await original(input, init);
		if (!String(input instanceof Request ? input.url : input).endsWith(path) || !response.body) return response;
		const items = [];
		responses.push(items);
		const decoder = new TextDecoder();
		let buffer = "";
		const consume = (text) => {
			buffer += text;
			let end;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end).trim();
				buffer = buffer.slice(end + 1);
				if (!line.startsWith("data:")) continue;
				let event;
				try {
					event = JSON.parse(line.slice(5));
				} catch {
					continue;
				}
				if (event.type !== "response.output_item.done") continue;
				const item = event.item ?? {};
				if (item.type !== "message") {
					items.push({ type: String(item.type) });
					continue;
				}
				const body = (item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text).join("");
				const text = body.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
				let json;
				try {
					json = jsonShape(JSON.parse(text), 2);
				} catch {
					json = { parsed: false, chars: text.length, opensObject: text.startsWith("{"), closesObject: text.endsWith("}") };
				}
				items.push({ type: "message", phase: item.phase ?? null, json });
			}
		};
		const observed = response.body.pipeThrough(
			new TransformStream({
				transform(chunk, controller) {
					consume(decoder.decode(chunk, { stream: true }));
					controller.enqueue(chunk);
				},
				flush() {
					consume(`${decoder.decode()}\n`);
				},
			}),
		);
		return new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
}

/** Assistant responses one probe may produce before it is stopped and scored as having no answer. */
const PROBE_ROUNDS = 6;
const fixturesDir = join(root, "eval", "preview", "fixtures");

function readFixture(id) {
	const gold = JSON.parse(readFileSync(join(fixturesDir, id, "gold.json"), "utf8"));
	const lines = readFileSync(join(fixturesDir, id, "session.jsonl"), "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	return { gold, header: lines[0], entries: lines.slice(1) };
}

function readLines(file) {
	return readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
}

function writeLines(file, lines) {
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

/** The note sections a checkpoint stores; each is an array of facts with sources and an optional quote. */
const NOTE_SECTIONS = ["instructions", "failedPaths", "reasons", "state", "nextSteps", "files", "gaps"];

/** UTF-8 bytes the next compaction condenses: the latest note, if any, and every message after it. */
function condensedBytes(lines) {
	const entries = lines.slice(1);
	const last = entries.findLastIndex((entry) => entry.type === "compaction");
	const previous = last >= 0 && entries[last].details?.note ? Buffer.byteLength(JSON.stringify(entries[last].details.note)) : 0;
	return entries
		.slice(last + 1)
		.filter((entry) => entry.type === "message")
		.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.message)), previous);
}

/** Size, section counts and cited IDs of a committed note, and the budget its checkpoint froze; never its text. */
function noteShape(note, contextBytes, budget) {
	const items = NOTE_SECTIONS.flatMap((section) => (Array.isArray(note[section]) ? note[section] : []));
	const bytes = Buffer.byteLength(JSON.stringify(note));
	return {
		bytes,
		contextBytes,
		budget: budget ? { tier: budget.tier, sourceTokens: budget.sourceTokens, previousTokens: budget.previousTokens, baseTokens: budget.baseTokens, hardTokens: budget.hardTokens } : null,
		ratio: contextBytes ? Number((bytes / contextBytes).toFixed(4)) : null,
		facts: Object.fromEntries(NOTE_SECTIONS.map((section) => [section, Array.isArray(note[section]) ? note[section].length : 0])),
		quoted: items.filter((item) => typeof item?.quote === "string").length,
		sources: [...new Set(items.flatMap((item) => (Array.isArray(item?.sources) ? item.sources : [])))],
	};
}

// ---------------------------------------------------------------------------------------------------------
// Worker: one compaction or one probe on one session copy, in its own process and agent directory.
// ---------------------------------------------------------------------------------------------------------

function answerText(expected) {
	if (expected.type === "text") return expected.accept[0];
	if (expected.type === "choice") return `option ${expected.value}`;
	return String(expected.value);
}

/** A faithful note from the gold files: every answer up to this cut, cited to its first evidence entry. */
function goldNote(gold, cutIndex, readable) {
	// A replayed round may compact before its gold checkpoint; the note then ends at the last readable entry.
	const cut = readable.has(gold.checkpoints[cutIndex].afterEntryId) ? gold.checkpoints[cutIndex].afterEntryId : [...readable].at(-1);
	const seen = new Set();
	const facts = [];
	for (const probe of gold.probes) {
		const index = gold.checkpoints.findIndex((checkpoint) => checkpoint.id === probe.checkpoint);
		if (index > cutIndex || probe.expected.type === "unknown" || seen.has(probe.prompt)) continue;
		const source = probe.evidence.find((id) => readable.has(id));
		if (!source) continue;
		seen.add(probe.prompt);
		facts.push({ text: `${probe.prompt} ${answerText(probe.expected)}.`, sources: [source] });
	}
	return {
		instructions: [],
		failedPaths: [],
		reasons: facts.slice(0, 40),
		state: [{ text: `Gold checkpoint ${cutIndex + 1} of ${gold.id}.`, sources: [cut] }],
		nextSteps: [{ text: "Continue the task from the latest user request.", sources: [cut] }],
		files: [],
		gaps: [],
	};
}

/**
 * The loopback's segment over entries `firstId` through `lastId` of `entries`, the session as it stands: every gold
 * answer up to this cut whose first readable evidence lies in the range, and where the work stands at its end.
 */
function goldSegment(gold, cutIndex, entries, firstId, lastId) {
	const ids = entries.map((entry) => entry.id);
	const range = new Set(ids.slice(ids.indexOf(firstId), ids.indexOf(lastId) + 1));
	const readable = new Set(entries.filter((entry) => entry.type === "message").map((entry) => entry.id));
	const note = goldNote(gold, cutIndex, readable);
	return { ...note, reasons: note.reasons.filter((fact) => range.has(fact.sources[0])), state: [{ text: `Work continues after ${lastId}.`, sources: [lastId] }], nextSteps: [] };
}

/**
 * --replay: a round's entries split where the agent settles, as a session meets them: each step ends with an
 * assistant reply that calls no tool and that a user message follows, or with the round's last entry.
 */
export function settledSteps(entries) {
	const steps = [];
	let current = [];
	entries.forEach((entry, index) => {
		current.push(entry);
		const next = entries[index + 1];
		const settled =
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason !== "toolUse" &&
			next?.type === "message" &&
			next.message.role === "user";
		if (settled || next === undefined) {
			steps.push(current);
			current = [];
		}
	});
	return steps;
}

/** Nearest-rank percentile of the numbers in `values`; null when there are none. */
export function percentile(values, share) {
	const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
	return sorted.length ? sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] : null;
}

async function worker() {
	const action = JSON.parse(Buffer.from(argument("--action"), "base64url").toString("utf8"));
	const packageDir = resolve(argument("--package-dir"));
	const stockRoot = resolve(argument("--stock-root"));
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const cwd = action.cwd;
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	// The native arm loads no package, so Pi's own compaction summarizes each cut with the same model and settings.
	const native = action.arm === "native";
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: native ? [] : [packageDir], cacheWarming: "off", defaultTools: [], compaction: { keepRecentTokens: 0, ...(action.reserve ? { reserveTokens: action.reserve } : {}) } }));
	let commandOutput;
	const diagnostics = [];
	for (const level of ["log", "warn", "error"]) {
		const original = console[level].bind(console);
		console[level] = (...parts) => {
			const text = parts.map(String).join(" ");
			if (commandOutput) commandOutput.push(text);
			else if (!text.includes("Source-linked compaction")) original(...parts);
		};
	}
	const stock = await import(pathToFileURL(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);

	// Loopback: the gold writer for scripted cuts and a fixed unknown answer for probes, after one read of the probe's
	// first evidence entry when context_history is active. In repair mode the writer's first call gets the planted
	// candidate, and only the quotation repair reaches the measured model: from here, so the request is the one
	// official Pi built for that model. `deepseek-local` answers it with the case's scripted repair and never leaves
	// this machine.
	const { gold } = readFixture(action.fixture);
	const repairSettings = [];
	let forwarded = 0;
	/** The catalog's address for the measured model, read before the bench moves it. */
	let upstream;
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const part of request) raw += part;
		const payload = JSON.parse(raw);
		const serialized = JSON.stringify(payload.messages ?? []);
		if (action.type === "repair") {
			const repair = serialized.includes("Correct the quotations of a memory candidate");
			if (repair) repairSettings.push({ thinking: payload.thinking?.type ?? null, effort: payload.reasoning_effort ?? null, maxTokens: payload.max_tokens ?? payload.max_completion_tokens ?? null, toolChoice: payload.tool_choice ?? null, tools: Array.isArray(payload.tools) ? payload.tools.length : 0 });
			if (repair && action.provider === "deepseek") {
				forwarded++;
				try {
					const answer = await fetch(`${upstream}${request.url}`, { method: "POST", headers: { "content-type": "application/json", authorization: request.headers.authorization ?? "" }, body: raw, signal: AbortSignal.timeout(600_000) });
					response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" });
					if (answer.body) for await (const part of answer.body) response.write(part);
					response.end();
				} catch (cause) {
					if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: `bench forward failed: ${String(cause?.message ?? cause).slice(0, 120)}` } }));
				}
				return;
			}
			// Local answers carry no usage: only the measured repair is counted.
			const text = JSON.stringify(repair ? action.scripted : action.candidate);
			const chunk = (delta, finish) => `data: ${JSON.stringify({ id: "bench", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.write(chunk({ role: "assistant", content: text }, null));
			response.write(chunk({}, "stop"));
			response.end("data: [DONE]\n\n");
			return;
		}
		const writer = WRITER_REQUESTS.some((marker) => serialized.includes(marker));
		const readable = new Set(
			readLines(action.sessionFile)
				.slice(1)
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.id),
		);
		// Usage proportional to the request, so a smaller request reads as smaller offline. No cache is simulated.
		const usage = (answer) => {
			const prompt = Math.ceil(Buffer.byteLength(serialized + JSON.stringify(payload.tools ?? [])) / 3);
			const completion = Math.ceil(Buffer.byteLength(answer) / 3);
			return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
		};
		const chunk = (delta, finish, reported) =>
			`data: ${JSON.stringify({ id: "bench", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(reported ? { usage: reported } : {}) })}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		// A history probe first reads its first gold evidence entry once, so retrieval and page-back carry figures.
		const evidence = action.type === "probe" && action.probe ? gold.probes.find((probe) => probe.id === action.probe)?.evidence[0] : undefined;
		const messages = payload.messages ?? [];
		const answered = messages.slice(messages.findLastIndex((message) => message.role === "user") + 1).some((message) => message.role === "tool");
		if (!writer && evidence && !answered && (payload.tools ?? []).some((tool) => tool.function?.name === "context_history")) {
			const call = JSON.stringify({ operation: "read", entryId: evidence });
			response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "bench_read_1", type: "function", function: { name: "context_history", arguments: call } }] }, null));
			response.write(chunk({}, "tool_calls", usage(call)));
			response.end("data: [DONE]\n\n");
			return;
		}
		const range = writer ? serialized.match(/Write a segment note for entries (\S+) through (\S+) only/) : null;
		const text = range
			? JSON.stringify(goldSegment(gold, action.cutIndex ?? 0, readLines(action.sessionFile).slice(1), range[1], range[2]))
			: writer
				? JSON.stringify(goldNote(gold, action.cutIndex ?? 0, readable))
				: JSON.stringify({ status: "unknown" });
		response.write(chunk({ role: "assistant", content: text }, null));
		response.write(chunk({}, "stop", usage(text)));
		response.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");

	const runtime = await stock.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
	const measured = action.provider === "relay" ? action.relay.model : MEASURED[action.provider];
	const responseItems = [];
	let model;
	if (action.provider === "loopback") {
		model = { ...LOOPBACK, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
		runtime.registerProvider(model.provider, { api: model.api, apiKey: "bench-loopback-only", baseUrl: model.baseUrl, models: [model] });
	} else if (action.type === "repair") {
		// The catalog's own model, with its compatibility settings and level map; only the address moves here.
		if (action.provider === "deepseek") {
			const dispatcher = await import(pathToFileURL(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "http-dispatcher.js")).href);
			dispatcher.configureHttpDispatcher();
		}
		upstream = runtime.getModel(measured.provider, measured.id)?.baseUrl;
		if (!upstream?.startsWith("https://")) throw new Error(`${measured.provider}/${measured.id} is not in this Pi's catalog`);
		runtime.registerProvider(measured.provider, { baseUrl: `http://127.0.0.1:${server.address().port}` });
		model = runtime.getModel(measured.provider, measured.id);
		if (!model?.baseUrl?.startsWith("http://127.0.0.1:")) throw new Error(`${measured.provider}/${measured.id} did not move to the bench's address`);
	} else {
		// The Pi CLI installs its proxy-aware dispatcher at startup; an SDK caller has to do the same.
		const dispatcher = await import(pathToFileURL(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "http-dispatcher.js")).href);
		dispatcher.configureHttpDispatcher();
		if (action.provider === "openai" || action.provider === "relay") observeResponseItems(responseItems, "/responses");
		// The catalog's own model, with its compatibility settings and level map; only the address moves to the relay,
		// and with --relay-id the ID it is served under. --provider openai keeps the catalog's address.
		const catalog = runtime.getModel(measured.provider, measured.id);
		if (!catalog) throw new Error(`${measured.provider}/${measured.id} is not in this Pi's catalog`);
		const served = action.provider === "relay" ? action.relay.id : measured.id;
		if (action.provider === "relay")
			runtime.registerProvider(measured.provider, { baseUrl: action.baseUrl, ...(served === measured.id ? {} : { models: [{ ...catalog, id: served, baseUrl: action.baseUrl }] }) });
		model = runtime.getModel(measured.provider, served);
		if (!model) throw new Error(`${measured.provider}/${served} is not registered`);
		if (action.provider === "relay" && model.baseUrl !== action.baseUrl) throw new Error(`${measured.provider}/${served} did not move to the relay's address`);
		if (action.provider === "openai" && new URL(model.baseUrl).host !== OPENAI_HOST) throw new Error(`${measured.provider}/${served} is not served from ${OPENAI_HOST} in this Pi's catalog`);
	}
	const settingsManager = stock.SettingsManager.create(cwd, agentDir);
	const loader = new stock.DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	if (loaded.errors.length || loaded.extensions.some((extension) => extension.path.startsWith(packageDir)) === native)
		throw new Error(native ? "The native arm loaded the preview package" : `The preview package did not load: ${JSON.stringify(loaded.errors).slice(0, 300)}`);
	const sessionManager = stock.SessionManager.open(action.sessionFile);
	const thinkingLevel = action.provider === "loopback" ? "off" : action.thinking;
	// --window: the route's window, so Pi's trigger and the preview's segment ranges follow the route, not the catalog.
	// The output maximum is capped as a model of that class would have it: the preview reserves the larger of 16,384
	// and the model's maximum below its window, so a catalog maximum of 128,000 or 384,000 would leave no budget.
	if (action.window) model = { ...model, contextWindow: action.window, maxTokens: Math.min(model.maxTokens, 32_000) };
	const { session } = await stock.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel, sessionManager, settingsManager, resourceLoader: loader, noTools: "builtin" });
	await session.bindExtensions({ onError: (error) => diagnostics.push(String(error?.message ?? error).slice(0, 200)) });
	const status = async () => {
		commandOutput = [];
		try {
			await session.prompt("/compaction-status");
			return JSON.parse(commandOutput.join("\n"));
		} catch {
			return {};
		} finally {
			commandOutput = undefined;
		}
	};

	let result;
	if (action.type === "compact" || action.type === "repair") {
		const contextBytes = condensedBytes(readLines(action.sessionFile));
		const started = performance.now();
		let error;
		let compacted;
		try {
			compacted = await session.compact();
		} catch (cause) {
			error = String(cause?.message ?? cause).slice(0, 200);
		}
		const after = native ? {} : await status();
		const writer = after.lastWriter ?? {};
		// Pi's own checkpoint: the session's last entry is a compaction this package did not write.
		const nativeCheckpoint = native ? readLines(action.sessionFile).at(-1) : undefined;
		result = {
			ok: error === undefined && (native ? nativeCheckpoint?.type === "compaction" && nativeCheckpoint.details?.kind !== "pi-context-memory" : after.lastCompaction?.diskConfirmed === true),
			...(native && nativeCheckpoint?.type === "compaction" ? { nativeSummaryBytes: Buffer.byteLength(nativeCheckpoint.summary ?? "") } : {}),
			...(error ? { error } : {}),
			code: after.code ?? null,
			ms: Math.round(performance.now() - started),
			// Pi summarizes a split turn in a second call.
			writerCalls: native ? (compacted ? (nativeCheckpoint?.summary?.includes("**Turn Context (split turn):**") ? 2 : 1) : 0) : (writer.writerCalls ?? 0),
			phases: (writer.writerCallDetails ?? []).map((call) => call.phase),
			// Per call: the effort asked for, the reasoning the request carried, how it ended, the schema envelope
			// removed from its note and its tokens; input is null when the call carried no usage report.
			// The native arm's summary is one entry, so --max-input-tokens and largestInput see Pi's own call too.
			calls: native
				? compacted?.usage
					? [{ phase: "native", ms: null, effort: null, sent: null, stopReason: null, envelope: null, input: compacted.usage.input ?? null, cacheRead: compacted.usage.cacheRead ?? null, cacheWrite: compacted.usage.cacheWrite ?? null, output: compacted.usage.output ?? null, reasoning: compacted.usage.reasoning ?? null }]
					: []
				: (writer.writerCallDetails ?? []).map((call) => ({ phase: call.phase, ms: call.ms ?? null, effort: call.effort ?? null, sent: call.sent ?? null, stopReason: call.stopReason ?? null, envelope: call.envelope ?? null, input: call.usage?.input ?? null, cacheRead: call.usage?.cacheRead ?? null, cacheWrite: call.usage?.cacheWrite ?? null, output: call.usage?.output ?? null, reasoning: call.usage?.reasoning ?? null })),
			// `complete` when the compaction committed a prepared candidate instead of calling the writer.
			path: after.lastCompaction?.path ?? null,
			repairKind: writer.repairKind ?? null,
			quotations: writer.quotations ?? null,
			scope: writer.scope ?? null,
			schema: writer.schema ?? null,
			quotationRepair: writer.quotationRepair ?? null,
			toolCalls: writer.toolCallResponses ?? 0,
			toolCallDeclined: writer.toolCallDeclined ?? false,
			usage: native ? (compacted?.usage ?? null) : (writer.usage ?? null),
			pauseMs: after.lastCompaction?.pauseMs ?? null,
			// /compaction-status's content-free reduction counts over the branch, null while previewReduction is off.
			reduction: after.reduction ?? null,
			...(action.provider === "openai" ? { openaiResponses: responseItems } : {}),
			...(action.provider === "relay" ? { relayResponses: responseItems } : {}),
		};
		if (result.ok) {
			const details = readLines(action.sessionFile).findLast((entry) => entry.type === "compaction" && entry.details?.kind === "pi-context-memory")?.details;
			const note = details?.note;
			if (note) result.note = noteShape(note, contextBytes, details.noteBudget);
			// Synthetic text, scored by the parent and never written to the run's files.
			if (note && action.type === "repair") result.committedNote = note;
		}
		if (action.type === "repair") Object.assign(result, { repairSettings, forwarded });
	} else if (action.type === "round") {
		// --replay: one round of a chain. Each step's fixture entries join the session as its own records, IDs kept,
		// and one real turn follows on the session itself, as the main model's last turn before the user speaks again:
		// it keeps the provider's cache warm and settles the agent, so the preview writes segments where a session
		// would. Pi compacts wherever its trigger falls; the round ends with /compact at the gold checkpoint unless a
		// compaction has just covered it. A failed compaction is retried, as a user retries /compact.
		const steps = JSON.parse(readFileSync(action.stepsFile, "utf8"));
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		const roundUsage = [];
		let rounds = 0;
		session.subscribe((event) => {
			if (event.type !== "message_end" || event.message?.role !== "assistant") return;
			rounds++;
			const reported = event.message.usage;
			if (reported) {
				usage.input += reported.input ?? 0;
				usage.output += reported.output ?? 0;
				usage.cacheRead += reported.cacheRead ?? 0;
				usage.cacheWrite += reported.cacheWrite ?? 0;
				usage.cost += reported.cost?.total ?? 0;
			}
			roundUsage.push(reported ? { input: reported.input ?? 0, output: reported.output ?? 0, cacheRead: reported.cacheRead ?? 0, cacheWrite: reported.cacheWrite ?? 0, reasoning: reported.reasoning ?? 0 } : null);
		});
		const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
		const checkpoints = () => sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
		// Pi may compact after a turn, and the preview's room check may ask it to: nothing is read before that ends.
		const quiet = async () => {
			const until = Date.now() + 900_000;
			while (session.isCompacting && Date.now() < until) await sleep(250);
		};
		// The settled pace: the user speaks again only once the segment in flight has settled.
		const idle = async () => {
			const until = Date.now() + 300_000;
			while (Date.now() < until) {
				await quiet();
				if ((await status()).segments?.state !== "preparing") return;
				await sleep(1_000);
			}
		};
		/** The checkpoint just written, when `appeared`, or the failure just recorded, as one content-free row. */
		const describe = async (trigger, step, appeared, extra = {}) => {
			const entry = appeared ? sessionManager.getEntries().findLast((item) => item.type === "compaction") : undefined;
			const preparation = entry?.details?.preparation ?? {};
			const after = await status();
			const committed = appeared && after.lastCompaction?.diskConfirmed === true && entry?.details?.kind === "pi-context-memory";
			const path = committed ? (preparation.path ?? after.lastCompaction?.path ?? null) : null;
			const writer = after.lastWriter ?? {};
			const foreground = committed && path !== "segments" && path !== "complete" && path !== "prefix" && path !== "notes";
			return {
				trigger,
				step,
				ok: committed,
				code: after.code ?? null,
				path,
				segmentsFallback: preparation.segmentsFallback ?? null,
				segmentsWaitMs: preparation.segmentsWaitMs ?? null,
				segments: preparation.segmentIds?.length ?? 0,
				mergedCallIds: path === "segments" ? (preparation.callIds ?? []) : [],
				pauseMs: committed ? (after.lastCompaction?.pauseMs ?? null) : null,
				tokensBefore: entry?.tokensBefore ?? null,
				coveredThrough: entry?.details?.coveredThrough ?? null,
				noteBytes: entry?.details?.note ? Buffer.byteLength(JSON.stringify(entry.details.note)) : null,
				writerCalls: foreground ? (writer.writerCalls ?? 0) : 0,
				calls: foreground
					? (writer.writerCallDetails ?? []).map((call) => ({ phase: call.phase, ms: call.ms ?? null, effort: call.effort ?? null, stopReason: call.stopReason ?? null, input: call.usage?.input ?? null, cacheRead: call.usage?.cacheRead ?? null, cacheWrite: call.usage?.cacheWrite ?? null, output: call.usage?.output ?? null, reasoning: call.usage?.reasoning ?? null }))
					: [],
				...extra,
			};
		};
		const boundaries = [];
		const errors = [];
		/** /compact until it commits or `action.chainAttempts` attempts in all have failed. */
		const compactNow = async (trigger, step, extra) => {
			for (let attempt = 1; attempt <= action.chainAttempts; attempt++) {
				const before = checkpoints();
				let error;
				const started = performance.now();
				try {
					await session.compact();
				} catch (cause) {
					error = String(cause?.message ?? cause).slice(0, 200);
				}
				const ms = Math.round(performance.now() - started);
				await quiet();
				const row = await describe(trigger, step, checkpoints() > before, { attempt, ms, ...extra, ...(error ? { error } : {}) });
				boundaries.push(row);
				if (row.ok) return true;
			}
			return false;
		};
		let broken = false;
		for (const [index, step] of steps.entries()) {
			for (const entry of step) sessionManager._appendEntry({ ...entry, parentId: sessionManager.getLeafId() });
			session._refreshFinalizedContext();
			const before = checkpoints();
			try {
				await session.prompt(action.prompt);
			} catch (cause) {
				errors.push(String(cause?.message ?? cause).slice(0, 200));
			}
			await quiet();
			if (checkpoints() > before) {
				const row = await describe("auto", index + 1, true, { attempt: 1 });
				boundaries.push(row);
				if (!row.ok && !(await compactNow("retry", index + 1))) {
					broken = true;
					break;
				}
			} else if ((await status()).code) {
				// An automatic compaction that failed leaves no entry, only the blocked state: the user retries /compact.
				boundaries.push(await describe("auto", index + 1, false, { attempt: 1 }));
				if (!(await compactNow("retry", index + 1))) {
					broken = true;
					break;
				}
			}
			if (action.pace === "settled") await idle();
		}
		// The gold checkpoint. P5's last step before each one is a short closing turn, so a compaction Pi made at that
		// step or the one before already covers the round, and a user would not compact again at once; it stands as
		// the round's checkpoint. Otherwise /compact closes the round.
		const recent = boundaries.filter((row) => row.ok && row.step >= steps.length - 1);
		if (!broken) {
			if (recent.length) recent.at(-1).gold = true;
			else {
				const coverage = (await status()).segments?.coverage ?? null;
				broken = !(await compactNow("gold", steps.length, { gold: true, coverage }));
			}
		}
		await quiet();
		if (action.pace === "settled") await idle();
		// How this round's segments ended: linked, cancelled, superseded, failed by code, dropped by reason.
		const segmentsStatus = (await status()).segments ?? null;
		// Every call the preview journaled in this unit, with its catalog cost: segments, writers and repairs.
		const prices = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const journalDir = join(agentDir, "context-memory-preview", "calls");
		const journal = new Map();
		for (const name of existsSync(journalDir) ? readdirSync(journalDir).filter((item) => item.endsWith(".jsonl")) : [])
			for (const line of readFileSync(join(journalDir, name), "utf8").split("\n")) {
				let value;
				try {
					value = JSON.parse(line);
				} catch {
					continue;
				}
				if (value?.v !== 1 || typeof value.call !== "string") continue;
				if (value.purpose) journal.set(value.call, { id: value.call, purpose: value.purpose, phase: value.step ?? null, outcome: null, dispatched: null, usage: null, costUsd: 0 });
				else if (journal.has(value.call)) {
					const call = journal.get(value.call);
					call.outcome = value.outcome ?? null;
					call.dispatched = typeof value.dispatched === "boolean" ? value.dispatched : null;
					if (value.usage) {
						const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = value.usage;
						call.usage = { input, output, cacheRead, cacheWrite };
						call.costUsd = (input * prices.input + output * prices.output + cacheRead * prices.cacheRead + cacheWrite * prices.cacheWrite) / 1_000_000;
					}
				}
			}
		const journalCalls = [...journal.values()];
		const sent = journalCalls.filter((call) => call.dispatched !== false);
		result = {
			ok: !broken && boundaries.some((row) => row.gold && row.ok),
			steps: steps.length,
			boundaries,
			segmentsStatus,
			errors,
			rounds,
			usage,
			roundUsage,
			journalCalls,
			requests: rounds + sent.length,
			costUsd: usage.cost + sent.reduce((sum, call) => sum + call.costUsd, 0),
			...(action.provider === "openai" ? { openaiResponses: responseItems } : {}),
		};
	} else {
		// "session" keeps the session's own tools, so a warm-up request carries the writer's exact prefix.
		if (action.condition !== "session") session.setActiveToolsByName(action.condition === "history" ? ["context_history"] : []);
		const activeTools = session.agent.state.tools.map((tool) => tool.name);
		const before = sessionManager.getBranch().length;
		let rounds = 0;
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		// Each response's usage; null when it carried none, which Pi leaves at zero, as the preview's writer reads it.
		const roundUsage = [];
		session.subscribe((event) => {
			if (event.type !== "message_end" || event.message?.role !== "assistant") return;
			rounds++;
			const reported = event.message.usage;
			if (reported) {
				usage.input += reported.input ?? 0;
				usage.output += reported.output ?? 0;
				usage.cacheRead += reported.cacheRead ?? 0;
				usage.cacheWrite += reported.cacheWrite ?? 0;
				usage.cost += reported.cost?.total ?? 0;
			}
			const known = reported && [reported.input, reported.output, reported.cacheRead, reported.cacheWrite, reported.totalTokens, reported.cost?.total].some((value) => value);
			roundUsage.push(known ? { input: reported.input ?? 0, output: reported.output ?? 0, cacheRead: reported.cacheRead ?? 0, cacheWrite: reported.cacheWrite ?? 0, reasoning: reported.reasoning ?? 0 } : null);
			if (rounds >= PROBE_ROUNDS) session.abort();
		});
		let error;
		try {
			await session.prompt(action.prompt);
		} catch (cause) {
			error = String(cause?.message ?? cause).slice(0, 200);
		}
		const added = sessionManager.getBranch().slice(before);
		const assistants = added.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		const last = assistants.at(-1)?.message;
		const calls = assistants.flatMap((entry) =>
			entry.message.content.filter((block) => block.type === "toolCall" && block.name === "context_history").map((block) => block.arguments?.operation ?? "invalid"),
		);
		// Each context_history call: its operation, the entry a read named, and the bytes of the call and its result.
		const results = new Map(added.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").map((entry) => [entry.message.toolCallId, entry.message]));
		const retrieval = assistants.flatMap((entry) =>
			entry.message.content
				.filter((block) => block.type === "toolCall" && block.name === "context_history")
				.map((block) => {
					const returned = (results.get(block.id)?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
					return { operation: block.arguments?.operation ?? "invalid", entryId: typeof block.arguments?.entryId === "string" ? block.arguments.entryId : null, callBytes: Buffer.byteLength(JSON.stringify({ tool: block.name, arguments: block.arguments })), returnedBytes: Buffer.byteLength(returned) };
				}),
		);
		const after = native ? {} : await status();
		result = {
			activeTools,
			reached: rounds > 0,
			...(error ? { error } : {}),
			code: after.code ?? null,
			rounds,
			roundLimit: rounds >= PROBE_ROUNDS,
			stopReason: last?.stopReason ?? null,
			...(last?.errorMessage ? { errorMessage: String(last.errorMessage).slice(0, 300) } : {}),
			reply: last && last.stopReason === "stop" ? last.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : undefined,
			history: { search: calls.filter((op) => op === "search").length, read: calls.filter((op) => op === "read").length, list: calls.filter((op) => op === "list").length, other: calls.filter((op) => !["search", "read", "list"].includes(op)).length },
			usage,
			roundUsage,
			retrieval,
			reduction: after.reduction ?? null,
			// The excerpt counts, and the estimated tokens of the excerpts the preview appended to this probe's
			// requests: page-back, as retrieval is.
			excerpts: after.excerpts ?? null,
			excerptTokens: after.excerpts?.tokens ?? 0,
			// --equivalence-out only: the error classes of failed tool results, in order; never their text.
			...(action.equivalence
				? { historyCodes: added.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError).flatMap((entry) => errorClasses(...(entry.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text))) }
				: {}),
		};
	}
	session.dispose();
	server.close();
	process.stdout.write(`BENCH_RESULT ${JSON.stringify({ ...result, diagnostics })}\n`);
	process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------
// Parent: chains, units, limits and the report.
// ---------------------------------------------------------------------------------------------------------

async function parent() {
	const { scoreProbe, summarizePreview } = await import(pathToFileURL(join(root, "eval", "preview", "scorer.ts")).href);
	const { ANSWER_CONTRACT } = await import(pathToFileURL(join(root, "eval", "preview", "schema.ts")).href);
	const { REPAIR_CASES_VERSION, repairCases, scoreRepair, summarizeRepairs } = await import(pathToFileURL(join(root, "eval", "preview", "repair.ts")).href);
	const { cutMeasure, overheadReport, parseCallJournal } = await import(pathToFileURL(join(root, "eval", "preview", "overhead.ts")).href);
	const packageDir = resolve(argument("--package-dir"));
	const stockRoot = resolve(argument("--stock-root"));
	const outputDir = resolve(argument("--output-dir"));
	const mode = argument("--mode");
	const provider = argument("--provider", "loopback");
	const fixtures = argument("--fixtures", "P1,P2,P3").split(",");
	const attempts = Number(argument("--attempts", "8"));
	const thinking = argument("--thinking", "high");
	const concurrency = Number(argument("--concurrency", "1"));
	const chainAttempts = Number(argument("--chain-attempts", "4"));
	const cache = argument("--cache", "warm");
	const cutList = argument("--cuts", "");
	const probeConditions = argument("--probe-conditions", "history,none").split(",");
	const compactionsOnly = args.includes("--compactions-only");
	const maxInputTokens = args.includes("--max-input-tokens") ? Number(argument("--max-input-tokens")) : Number.POSITIVE_INFINITY;
	const label = argument("--label", "run");
	// --arm native runs the same chain with Pi's own compaction and no package: the control a Slice run compares with.
	const arm = argument("--arm", "slice");
	if (!["slice", "native"].includes(arm)) throw new Error("--arm must be slice or native");
	if (arm === "native" && (mode !== "probes" || probeConditions.join() !== "none"))
		throw new Error("--arm native serves only --mode probes with --probe-conditions none: without the package there is no context_history");
	// --replay: each round's entries arrive step by step with a real turn at every settled point, so segments are
	// written where a session writes them; --pace says whether the next step waits for the segment in flight, and
	// --window sets the route's window. Every arm of a comparison replays the same way.
	const replay = args.includes("--replay");
	const pace = argument("--pace", "settled");
	const window = args.includes("--window") ? Number(argument("--window")) : null;
	// --reserve: Pi's compaction.reserveTokens for every unit, so its trigger sits where the route compacts.
	const reserve = args.includes("--reserve") ? Number(argument("--reserve")) : null;
	const segmentEffort = argument("--segment-effort", "");
	if (replay && mode !== "probes") throw new Error("--replay applies to probes mode");
	if (replay && cache !== "session") throw new Error("--replay runs every turn on the session itself: give --cache session");
	if (replay && arm !== "slice") throw new Error("--replay needs the package");
	if (!["settled", "immediate"].includes(pace)) throw new Error("--pace takes settled or immediate");
	if (window !== null && !(Number.isSafeInteger(window) && window >= 32_000 && window <= 1_000_000)) throw new Error("--window takes a token count from 32000 to 1000000");
	if (reserve !== null && !(Number.isSafeInteger(reserve) && reserve >= 1_000 && reserve <= 200_000)) throw new Error("--reserve takes a token count from 1000 to 200000");
	if (segmentEffort && !SEGMENT_EFFORTS.includes(segmentEffort)) throw new Error(`--segment-effort takes ${SEGMENT_EFFORTS.join(", ")}`);
	const unitMinutes = Number(argument("--unit-minutes", "10"));
	if (!(unitMinutes > 0)) throw new Error("--unit-minutes must be positive");
	// The preview switches a run sets, such as previewReduction=on for a candidate, written into every unit's
	// pi-context-memory.json, and the label of the control run a candidate compares with.
	const { label: sessionSettings, settings: unitSettings } = parseSessionSettings(argument("--session-settings", ""));
	if (segmentEffort && unitSettings.previewSegments?.enabled !== true) throw new Error("--segment-effort needs --session-settings previewSegments=on");
	if (segmentEffort) unitSettings.previewSegments.effort = segmentEffort;
	// Probe units answer from the committed checkpoint; a segment written in a probe's own turn would only add calls.
	const probeSettings = unitSettings.previewSegments ? { ...unitSettings, previewSegments: { enabled: false } } : unitSettings;
	const control = argument("--control", "") || null;
	if (!["writer", "probes", "smoke", "repair"].includes(mode)) throw new Error("--mode must be writer, probes, smoke or repair");
	if (!["loopback", "deepseek", "deepseek-local", "openai", "relay"].includes(provider)) throw new Error("--provider must be loopback, deepseek, deepseek-local, openai or relay");
	if (provider === "deepseek-local" && mode !== "repair") throw new Error("--provider deepseek-local serves only --mode repair");
	// Repair mode answers the writer's first call here in Chat Completions; Pi's catalog sends gpt-6-luna through the
	// Responses API.
	if (provider === "openai" && mode === "repair") throw new Error("--provider openai does not serve --mode repair");
	if (provider === "relay" && mode === "repair") throw new Error("--provider relay does not serve --mode repair");
	const baseUrl = provider === "relay" ? argument("--base-url", "").replace(/\/+$/, "") : undefined;
	if (provider === "relay" && !baseUrl.startsWith("https://")) throw new Error("--provider relay needs --base-url https://...");
	const relayModel = argument("--relay-model", `${MEASURED.relay.provider}/${MEASURED.relay.id}`);
	const relaySeparator = relayModel.indexOf("/");
	const relay = provider === "relay" ? { model: { provider: relayModel.slice(0, relaySeparator), id: relayModel.slice(relaySeparator + 1) } } : undefined;
	if (relay) relay.id = argument("--relay-id", relay.model.id);
	if (relay && (relaySeparator <= 0 || !RELAY_KEYS[relay.model.provider] || !relay.id)) throw new Error(`--relay-model takes provider/id for a provider among ${Object.keys(RELAY_KEYS).join(", ")}`);
	if (!["cold", "warm", "session"].includes(cache)) throw new Error("--cache must be cold, warm or session");
	// 1-based checkpoint numbers, ascending; the fixtures' own counts are checked when each fixture is read.
	const cuts = cutList ? cutList.split(",").map(Number) : null;
	if (cuts && mode !== "probes") throw new Error("--cuts applies to probes mode");
	if (compactionsOnly && mode !== "probes") throw new Error("--compactions-only applies to probes mode");
	if (cuts && (!cuts.length || cuts.some((cut, index) => !Number.isSafeInteger(cut) || cut < 1 || (index > 0 && cut <= cuts[index - 1]))))
		throw new Error("--cuts takes ascending checkpoint numbers from 1, such as 1,3,5");
	if (!probeConditions.length || probeConditions.some((condition) => !["history", "none"].includes(condition)) || new Set(probeConditions).size < probeConditions.length)
		throw new Error("--probe-conditions takes history, none or both");
	if (!(maxInputTokens > 0)) throw new Error("--max-input-tokens must be positive");
	const equivalenceOut = argument("--equivalence-out", "") ? resolve(argument("--equivalence-out")) : null;
	if (args.includes("--equivalence-out") && !equivalenceOut) throw new Error("--equivalence-out needs a file");
	// Equivalence compares scripted inputs across builds: a model's answers are not scripted, and smoke compacts nothing.
	if (equivalenceOut && !["loopback", "deepseek-local"].includes(provider)) throw new Error("--equivalence-out needs --provider loopback or deepseek-local");
	if (equivalenceOut && mode === "smoke") throw new Error("--equivalence-out records compactions; --mode smoke runs none");
	const remote = provider === "deepseek" || provider === "openai" || provider === "relay";
	const limits = !remote
		? { requests: Number.POSITIVE_INFINITY, minutes: Number.POSITIVE_INFINITY, costUsd: Number.POSITIVE_INFINITY }
		: { requests: Number(argument("--max-requests")), minutes: Number(argument("--max-minutes")), costUsd: Number(argument("--max-cost-usd")) };
	for (const [name, value] of Object.entries(limits))
		if (!(value > 0)) throw new Error(`--max-${name} must be positive for a provider run`);
	const build = JSON.parse(readFileSync(join(packageDir, "preview-build.json"), "utf8"));
	const hostVersion = JSON.parse(readFileSync(join(stockRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
	const runDir = join(outputDir, label);
	rmSync(runDir, { recursive: true, force: true });
	mkdirSync(runDir, { recursive: true });
	const started = Date.now();
	const used = { requests: 0, costUsd: 0, units: 0, unstarted: 0, timedOut: 0, warmups: 0, warmupCostUsd: 0, largestInput: 0, inputBreaches: 0 };
	const exhausted = () =>
		used.requests >= limits.requests ||
		used.costUsd >= limits.costUsd ||
		(Date.now() - started) / 60_000 >= limits.minutes ||
		used.inputBreaches > 0;
	const record = (file, row) => appendFileSync(join(runDir, file), `${JSON.stringify(row)}\n`);

	const environment = (agentDir) => {
		const value = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: join(agentDir, "home"),
			LANG: "C.UTF-8",
			CI: "1",
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "0",
			PI_TELEMETRY: "0",
			PI_SKIP_VERSION_CHECK: "1",
		};
		// Answered on this machine: Pi still needs a key to build the request, and gets one that opens nothing.
		if (provider === "deepseek-local") value.DEEPSEEK_API_KEY = "bench-local-only";
		if (remote) {
			// The proxy injects the real key; Pi receives only a placeholder.
			if (provider === "deepseek") value.DEEPSEEK_API_KEY = "proxy-injected";
			if (provider === "openai") value.OPENAI_API_KEY = "proxy-injected";
			if (provider === "relay") value[RELAY_KEYS[relay.model.provider]] = "proxy-injected";
			value.NODE_USE_ENV_PROXY = "1";
			for (const name of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"])
				if (process.env[name]) value[name] = process.env[name];
		}
		return value;
	};

	let sequence = 0;
	async function run(action) {
		const id = String(++sequence).padStart(4, "0");
		const agentDir = join(runDir, "agents", id);
		// Pi's system prompt ends with the working directory, so a directory per unit gives every request its own
		// prefix after a few hundred tokens; a warm run shares one directory, as one user's session does.
		const cwd = join(runDir, "cwd", cache === "cold" ? id : "shared");
		writeUnitSettings(agentDir, action.type === "probe" && action.condition !== "session" ? probeSettings : unitSettings);
		const encoded = Buffer.from(JSON.stringify({ ...action, arm, cwd, ...(window ? { window } : {}), ...(reserve ? { reserve } : {}), ...(action.provider === "relay" ? { baseUrl, relay } : {}), ...(equivalenceOut ? { equivalence: true } : {}) })).toString("base64url");
		const child = spawn(process.execPath, [script, "--worker", "--action", encoded, "--package-dir", packageDir, "--stock-root", stockRoot], { cwd: runDir, env: environment(agentDir), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (part) => (stdout += part));
		child.stderr.on("data", (part) => (stderr += part));
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, unitMinutes * 60_000);
		const [code] = await once(child, "close");
		clearTimeout(timer);
		// The unit's call journal, content-free, read before its directory goes: a crashed or timed-out unit's
		// calls and the usage they settled with stay in the report.
		const journal = readJournal(agentDir);
		rmSync(agentDir, { recursive: true, force: true });
		if (timedOut) used.timedOut++;
		const line = stdout.split("\n").find((item) => item.startsWith("BENCH_RESULT "));
		if (!line) return { crashed: true, ...(timedOut ? { timedOut } : {}), exitCode: code, stderr: stderr.slice(-600), journal };
		return { ...JSON.parse(line.slice("BENCH_RESULT ".length)), journal };
	}

	/** Every call the preview journaled in one unit's agent directory: purpose, phase, outcome and usage. */
	function readJournal(agentDir) {
		const directory = join(agentDir, "context-memory-preview", "calls");
		let names;
		try {
			names = readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort();
		} catch {
			return [];
		}
		return names.flatMap((name) => parseCallJournal(readFileSync(join(directory, name), "utf8")));
	}

	/** The most input one request of a unit reported: its writer calls and its probe rounds, cached tokens included. */
	function largestInput(result) {
		const requests = [
			...(result.calls ?? []),
			...(result.roundUsage ?? []).filter(Boolean),
			...(result.boundaries ?? []).flatMap((row) => row.calls ?? []),
			...(result.journalCalls ?? []).map((call) => call.usage).filter(Boolean),
		];
		return requests.reduce((most, item) => Math.max(most, (item.input ?? 0) + (item.cacheRead ?? 0) + (item.cacheWrite ?? 0)), 0);
	}

	/** Measured requests and catalog cost, counted as each unit settles, and any request past --max-input-tokens. */
	function spend(result, measured) {
		used.units++;
		if (!measured) return;
		used.requests += result.requests ?? result.forwarded ?? result.writerCalls ?? result.rounds ?? 0;
		used.costUsd += result.costUsd ?? result.usage?.cost?.total ?? result.usage?.cost ?? 0;
		const largest = largestInput(result);
		used.largestInput = Math.max(used.largestInput, largest);
		if (largest > maxInputTokens) used.inputBreaches++;
	}

	/**
	 * --equivalence-out: one content-free record per unit or cut, kept until the run ends and then written sorted by
	 * case, so concurrency cannot reorder the file. `file` is the session the unit left, read for its checkpoints;
	 * the fixture's own entry IDs stay raw.
	 */
	const equivalence = [];
	const unitClasses = (result) => errorClasses(result.error, ...(result.historyCodes ?? []), ...(result.diagnostics ?? []), result.code);
	const unitOutcome = (result) => (result.crashed ? "crashed" : result.ok ? "committed" : "refused");
	function equivalent(id, fixture, file, classes, extra) {
		if (!equivalenceOut) return;
		const checkpoints = file ? checkpointRecords(readLines(file), new Set(fixture.entries.map((entry) => entry.id))) : [];
		equivalence.push({ id, line: equivalenceLine({ runner: "bench", id, host: hostVersion, checkpoints, classes, extra, build: build.buildId ?? build.build ?? null }) });
	}

	/** Warm-up rows; the overhead report reads only the preparation calls their journals may hold. */
	const warmups = [];
	/**
	 * In a warm or session run, one request with the session's own tools, as the main model's last turn would be, so
	 * that the writer's attempts at this cut find the history cached: over a copy of `file` when warm, on `file` itself
	 * when session.
	 */
	async function warm(fixture, cut, file) {
		if (cache === "cold" || exhausted()) return;
		// --cache session runs the turn on the session itself, so the writer's request continues it as it would
		// continue a session's last turn: a cache that serves only continuations of an earlier request, as OpenAI's
		// implicit mode on GPT-6 Luna does, is then measured as a session meets it. --cache warm keeps the history
		// unchanged and serves providers that match any shared prefix.
		const sessionFile = cache === "session" ? file : copy(file, `${fixture.gold.id}-cut${cut + 1}-warm`);
		const result = await run({ type: "probe", provider, fixture: fixture.gold.id, sessionFile, condition: "session", prompt: "Reply with the single word OK.", thinking });
		spend(result, provider !== "loopback");
		used.warmups++;
		used.warmupCostUsd += result.usage?.cost ?? 0;
		const row = { fixture: fixture.gold.id, cut: cut + 1, reached: result.reached ?? false, rounds: result.rounds ?? 0, crashed: result.crashed ?? false, usage: result.usage ?? null, journal: result.journal ?? [] };
		warmups.push(row);
		record("warmups.jsonl", row);
	}

	async function pool(units, work) {
		const queue = [...units];
		const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
			while (queue.length) {
				const unit = queue.shift();
				if (exhausted()) {
					used.unstarted++;
					continue;
				}
				await work(unit);
			}
		});
		await Promise.all(runners);
	}

	const position = (fixture, id) => fixture.entries.findIndex((entry) => entry.id === id);
	/** The fixture's entries after cut `cut` up to and including cut `cut + 1`, the first re-parented on `leaf`. */
	function segment(fixture, cut, leaf) {
		const from = cut < 0 ? 0 : position(fixture, fixture.gold.checkpoints[cut].afterEntryId) + 1;
		const to = position(fixture, fixture.gold.checkpoints[cut + 1].afterEntryId) + 1;
		const next = fixture.entries.slice(from, to).map((entry) => ({ ...entry }));
		next[0].parentId = leaf;
		return next;
	}

	/**
	 * Compact `file` at checkpoint `cut`, retrying a refused measured writer up to `chainAttempts` attempts in all, as
	 * a user retries /compact. Returns every attempt; the last one decides.
	 */
	async function compactAt(fixture, cut, writer, file) {
		const results = [];
		do {
			const result = await run({ type: "compact", provider: writer, fixture: fixture.gold.id, cutIndex: cut, sessionFile: file, thinking });
			spend(result, writer !== "loopback");
			results.push(result);
		} while (!results.at(-1).ok && writer !== "loopback" && results.length < chainAttempts && !exhausted());
		return results;
	}

	/** The fixture's entries after cut `from` up to and including cut `to`, the first re-parented on `leaf`. */
	function span(fixture, from, to, leaf) {
		const start = from < 0 ? 0 : position(fixture, fixture.gold.checkpoints[from].afterEntryId) + 1;
		const next = fixture.entries.slice(start, position(fixture, fixture.gold.checkpoints[to].afterEntryId) + 1).map((entry) => ({ ...entry }));
		next[0].parentId = leaf;
		return next;
	}

	/** --replay: every boundary row, every unit's journal calls and the steps each round took, for the report. */
	const boundaryRows = [];
	const roundRows = [];
	/**
	 * --replay: one unit replays the round that ends at cut `k` on `file`, step by step, and compacts wherever Pi's
	 * trigger falls and at the gold checkpoint. Returns the gold checkpoint's attempts, shaped as compactAt's.
	 */
	async function replayRound(fixture, k, file, entries) {
		const steps = settledSteps(entries);
		mkdirSync(join(runDir, "steps"), { recursive: true });
		const stepsFile = join(runDir, "steps", `${fixture.gold.id}-cut${k + 1}.json`);
		writeFileSync(stepsFile, JSON.stringify(steps));
		const result = await run({ type: "round", provider, fixture: fixture.gold.id, cutIndex: k, sessionFile: file, stepsFile, pace, chainAttempts, prompt: "Reply with the single word OK.", thinking });
		spend(result, provider !== "loopback");
		rmSync(stepsFile, { force: true });
		if (result.crashed) return [{ ...result, ok: false, code: null }];
		for (const row of result.boundaries) {
			const line = { fixture: fixture.gold.id, cut: k + 1, ...row };
			boundaryRows.push(line);
			record("boundaries.jsonl", line);
		}
		const round = { fixture: fixture.gold.id, cut: k + 1, steps: result.steps, rounds: result.rounds, usage: result.usage, requests: result.requests, costUsd: result.costUsd, errors: result.errors, segments: result.segmentsStatus?.results ?? null, segmentsState: result.segmentsStatus ? { state: result.segmentsStatus.state, reason: result.segmentsStatus.reason ?? null } : null, journalCalls: result.journalCalls };
		roundRows.push(round);
		record("rounds.jsonl", { ...round, journalCalls: undefined });
		const gold = result.boundaries.filter((row) => row.gold);
		const attempts = (gold.length ? gold : [{ ok: false, code: result.boundaries.at(-1)?.code ?? null }]).map((row) => ({ ...row, diagnostics: result.diagnostics, journal: [] }));
		// The note the gold checkpoint committed, for the cited-answer counts: it is the session's latest.
		if (attempts.at(-1).ok) {
			const lines = readLines(file);
			const last = lines.findLastIndex((entry) => entry.type === "compaction" && entry.details?.kind === "pi-context-memory");
			const details = lines[last]?.details;
			if (details?.note) attempts.at(-1).note = noteShape(details.note, condensedBytes(lines.slice(0, last)), details.noteBudget);
		}
		return attempts;
	}

	/** A session file holding the fixture up to cut k, with every earlier cut compacted by the loopback writer. */
	async function base(fixture, k) {
		mkdirSync(join(runDir, "chains"), { recursive: true });
		const file = join(runDir, "chains", `${fixture.gold.id}-base-cut${k + 1}.jsonl`);
		let lines = [fixture.header, ...segment(fixture, -1, null)];
		for (let cut = 0; cut < k; cut++) {
			writeLines(file, lines);
			const results = await compactAt(fixture, cut, "loopback", file);
			if (!results.at(-1).ok) throw new Error(`The loopback writer could not compact ${fixture.gold.id} cut ${cut + 1}`);
			lines = readLines(file);
			lines = [...lines, ...segment(fixture, cut, lines.at(-1).id)];
		}
		writeLines(file, lines);
		return file;
	}

	/** A plain copy: entries, the header and so every hash stay as they were. */
	function copy(file, name) {
		const target = join(runDir, "copies", `${name}.jsonl`);
		mkdirSync(join(runDir, "copies"), { recursive: true });
		copyFileSync(file, target);
		return target;
	}

	/** Gold answers a note cites: those first asked at this cut, and those from earlier cuts carried forward. */
	function noteRow(fixture, k, note) {
		if (!note) return null;
		const { sources, ...shape } = note;
		const cited = new Set(sources);
		const order = new Map(fixture.gold.checkpoints.map((checkpoint, index) => [checkpoint.id, index]));
		const answerable = fixture.gold.probes.filter((probe) => probe.expected.type !== "unknown");
		const count = (list) => ({ cited: list.filter((probe) => probe.evidence.some((id) => cited.has(id))).length, total: list.length });
		return {
			...shape,
			cited: cited.size,
			coverage: { current: count(answerable.filter((probe) => order.get(probe.checkpoint) === k)), carried: count(answerable.filter((probe) => order.get(probe.checkpoint) < k)) },
		};
	}

	/** Medians of note size and ratio over committed notes, and gold coverage summed over them. */
	function noteSummary(list) {
		const notes = list.filter((row) => row.ok && row.note).map((row) => row.note);
		const median = (values) => {
			const sorted = [...values].sort((a, b) => a - b);
			return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
		};
		const total = (pick) => notes.reduce((sum, note) => ({ cited: sum.cited + pick(note).cited, total: sum.total + pick(note).total }), { cited: 0, total: 0 });
		return {
			measured: notes.length,
			bytesMedian: median(notes.map((note) => note.bytes)),
			contextBytesMedian: median(notes.map((note) => note.contextBytes)),
			ratioMedian: median(notes.map((note) => note.ratio)),
			factsMedian: median(notes.map((note) => Object.values(note.facts).reduce((sum, value) => sum + value, 0))),
			quotedMedian: median(notes.map((note) => note.quoted)),
			coverage: { current: total((note) => note.coverage.current), carried: total((note) => note.coverage.carried) },
		};
	}

	const shown = Object.fromEntries(Object.entries(limits).map(([name, value]) => [name, Number.isFinite(value) ? value : "unlimited"]));
	const report = { label, mode, provider, model: provider === "loopback" ? LOOPBACK.id : relay ? `${relay.model.provider}/${relay.id}` : `${MEASURED[provider].provider}/${MEASURED[provider].id}`, ...(relay && relay.id !== relay.model.id ? { catalogModel: `${relay.model.provider}/${relay.model.id}` } : {}), ...(baseUrl ? { endpoint: new URL(baseUrl).host } : provider === "openai" ? { endpoint: OPENAI_HOST } : {}), thinking, cache, arm, ...(cuts ? { cuts } : {}), ...(mode === "probes" ? { probeConditions, compactionsOnly } : {}), ...(mode === "writer" || mode === "repair" ? { attempts } : {}), ...(mode === "probes" ? { chainAttempts } : {}), concurrency, build: build.buildId ?? build.build ?? null, piVersion: hostVersion, fixtures, sessionSettings, ...(segmentEffort ? { segmentEffort } : {}), unitSettings: Object.keys(unitSettings).length ? unitSettings : null, control, limits: { ...shown, inputTokensPerRequest: Number.isFinite(maxInputTokens) ? maxInputTokens : "unlimited" } };

	if (mode === "smoke") {
		// One small request through the history conversion: the opening turn of P1 and a one-word reply.
		const fixture = readFixture("P1");
		const end = fixture.entries.findIndex((entry) => entry.message?.role === "assistant" && entry.message.stopReason === "stop");
		const file = join(runDir, "smoke.jsonl");
		writeLines(file, [fixture.header, ...fixture.entries.slice(0, end + 1)]);
		const result = await run({ type: "probe", provider, fixture: "P1", sessionFile: file, condition: "none", prompt: "Reply with the single word OK.", thinking: "low" });
		spend(result, provider !== "loopback");
		report.smoke = { reached: result.reached, stopReason: result.stopReason, errorMessage: result.errorMessage ?? null, reply: result.reply?.slice(0, 40), error: result.error ?? null, crashed: result.crashed ?? false, ...(result.crashed ? { exitCode: result.exitCode, stderr: result.stderr } : {}), usage: result.usage ?? null, diagnostics: result.diagnostics ?? [] };
	}

	if (mode === "writer") {
		const rows = [];
		for (const id of fixtures) {
			const fixture = readFixture(id);
			for (let k = 0; k < fixture.gold.checkpoints.length; k++) {
				if (exhausted()) {
					used.unstarted += attempts;
					continue;
				}
				const baseFile = await base(fixture, k);
				// What this cut's checkpoint releases and its v0.2.3 tier; the same for every attempt on a copy.
				const measure = cutMeasure(readLines(baseFile).slice(1));
				await warm(fixture, k, baseFile);
				await pool(
					Array.from({ length: attempts }, (_, attempt) => attempt),
					async (attempt) => {
						const file = copy(baseFile, `${id}-cut${k + 1}-attempt${attempt + 1}`);
						const result = await run({ type: "compact", provider, fixture: id, cutIndex: k, sessionFile: file, thinking });
						spend(result, provider !== "loopback");
						const row = { fixture: id, cut: k + 1, attempt: attempt + 1, ...measure, ...result, note: noteRow(fixture, k, result.note) };
						delete row.diagnostics;
						rows.push(row);
						record("writer.jsonl", row);
						equivalent(`bench/writer/${id}/cut${k + 1}/attempt${attempt + 1}`, fixture, file, unitClasses(result), { outcome: unitOutcome(result) });
					},
				);
			}
		}
		const group = (list) => {
			const codes = {};
			for (const row of list) if (!row.ok) codes[row.code ?? (row.crashed ? "CRASHED" : "UNKNOWN")] = (codes[row.code ?? (row.crashed ? "CRASHED" : "UNKNOWN")] ?? 0) + 1;
			const sum = (pick) => list.reduce((total, row) => total + (pick(row) ?? 0), 0);
			const pauses = list.filter((row) => row.ok && row.pauseMs !== null).map((row) => row.pauseMs).sort((a, b) => a - b);
			return {
				attempts: list.length,
				committed: list.filter((row) => row.ok).length,
				refusedByCode: codes,
				firstPassQuotationFailures: list.filter((row) => row.quotations).length,
				quotationClasses: { elsewhere: sum((row) => row.quotations?.elsewhere), format: sum((row) => row.quotations?.format), absent: sum((row) => row.quotations?.absent) },
				// Scope refusals' citations: IDs on no entry, entries without readable text and their kinds; counts only.
				scopeCitations: {
					refusals: list.filter((row) => row.scope).length,
					missing: sum((row) => row.scope?.missing),
					unreadable: sum((row) => row.scope?.unreadable),
					inSupersedes: sum((row) => row.scope?.inSupersedes),
					unreadableKinds: list.reduce((kinds, row) => {
						for (const [kind, count] of Object.entries(row.scope?.unreadableKinds ?? {})) kinds[kind] = (kinds[kind] ?? 0) + count;
						return kinds;
					}, {}),
				},
				// Schema refusals' facts without sources, by section, and the refusals that failed the schema otherwise too.
				schemaRefusals: {
					refusals: list.filter((row) => row.schema).length,
					uncited: Object.fromEntries(NOTE_SECTIONS.map((section) => [section, sum((row) => row.schema?.uncited?.[section])]).filter(([, count]) => count > 0)),
					other: list.filter((row) => row.schema?.other).length,
				},
				repairs: {
					quotation: list.filter((row) => row.repairKind === "quotation").length,
					sources: list.filter((row) => row.repairKind === "sources").length,
					size: list.filter((row) => row.repairKind === "size").length,
				},
				toolCallsDeclined: list.filter((row) => row.toolCallDeclined).length,
				repairedAndCommitted: list.filter((row) => row.repairKind && row.ok).length,
				toolCallResponses: sum((row) => row.toolCalls),
				// Writer answers whose note arrived inside a schema envelope, by shape, and the attempts that then committed.
				envelopes: {
					type: sum((row) => row.calls?.filter((call) => call.envelope === "type").length),
					schema: sum((row) => row.calls?.filter((call) => call.envelope === "schema").length),
					committed: list.filter((row) => row.ok && row.calls?.some((call) => call.envelope)).length,
				},
				repairOutcome: { requoted: sum((row) => row.quotationRepair?.requoted), unquoted: sum((row) => row.quotationRepair?.unquoted), dropped: sum((row) => row.quotationRepair?.dropped), droppedFrom: Object.fromEntries(NOTE_SECTIONS.map((section) => [section, sum((row) => row.quotationRepair?.droppedFrom?.[section])]).filter(([, count]) => count > 0)) },
				writerCalls: sum((row) => row.writerCalls),
				usage: { input: sum((row) => row.usage?.input), output: sum((row) => row.usage?.output), cacheRead: sum((row) => row.usage?.cacheRead), costUsd: Number(sum((row) => row.usage?.cost?.total).toFixed(4)) },
				pauseMsMedian: pauses.length ? pauses[Math.floor(pauses.length / 2)] : null,
				notes: noteSummary(list),
			};
		};
		report.writer = {
			overall: group(rows),
			byCut: Object.fromEntries([...new Set(rows.map((row) => `${row.fixture}-cut${row.cut}`))].map((key) => [key, group(rows.filter((row) => `${row.fixture}-cut${row.cut}` === key))])),
		};
		const ordered = [...rows].sort((a, b) => fixtures.indexOf(a.fixture) - fixtures.indexOf(b.fixture) || a.cut - b.cut || a.attempt - b.attempt);
		report.overhead = overheadReport({ attempts: ordered, warmups });
	}

	if (mode === "repair") {
		// Every case at every cut, --attempts times: the planted candidate is the writer's first answer, and the
		// measured model answers only the repair. Rows keep scores, codes and call settings, never note text.
		const rows = [];
		const scores = [];
		const skipped = [];
		// The repair carries no session prefix, but every repair request opens with the same rules. The run's first
		// unit goes alone, so that a provider that caches prefixes has them before the rest arrive concurrently.
		let primed = false;
		for (const id of fixtures) {
			const fixture = readFixture(id);
			for (let k = 0; k < fixture.gold.checkpoints.length; k++) {
				const baseFile = await base(fixture, k);
				const branch = readLines(baseFile).slice(1);
				const readable = new Set(branch.filter((entry) => entry.type === "message").map((entry) => entry.id));
				const set = repairCases({ fixture: id, cut: k + 1, base: goldNote(fixture.gold, k, readable), branch });
				for (const item of set.skipped) skipped.push({ fixture: id, cut: k + 1, ...item });
				const units = set.cases.flatMap((repairCase) => Array.from({ length: attempts }, (_, attempt) => ({ repairCase, attempt })));
				const work = async ({ repairCase, attempt }) => {
					const file = copy(baseFile, `${repairCase.id}-attempt${attempt + 1}`);
					const result = await run({ type: "repair", provider, fixture: id, cutIndex: k, sessionFile: file, thinking, candidate: repairCase.candidate, scripted: repairCase.scripted });
					spend(result, provider === "deepseek");
					const score = scoreRepair(repairCase, { committed: result.ok === true, code: result.code ?? (result.crashed ? "CRASHED" : null), note: result.committedNote }, branch);
					scores.push(score);
					const row = { case: repairCase.id, template: repairCase.template, fixture: id, cut: k + 1, attempt: attempt + 1, ok: result.ok ?? false, code: result.code ?? null, crashed: result.crashed ?? false, writerCalls: result.writerCalls ?? 0, repairKind: result.repairKind ?? null, quotations: result.quotations ?? null, scope: result.scope ?? null, schema: result.schema ?? null, quotationRepair: result.quotationRepair ?? null, calls: result.calls ?? [], repairSettings: result.repairSettings ?? [], forwarded: result.forwarded ?? 0, pauseMs: result.pauseMs ?? null, usage: result.usage ?? null, score: { pass: score.pass, silentLoss: score.silentLoss, promoted: score.promoted, keptUnsupported: score.keptUnsupported, facts: score.facts } };
					rows.push(row);
					record("repairs.jsonl", row);
					equivalent(`bench/repair/${repairCase.id}/attempt${attempt + 1}`, fixture, file, unitClasses(result), { outcome: unitOutcome(result) });
				};
				if (!primed && units.length) {
					primed = true;
					await work(units.shift());
				}
				await pool(units, work);
			}
		}
		const repairCalls = rows.flatMap((row) => row.calls.filter((call) => call.phase === "repair"));
		const ordered = (values) => values.filter((value) => typeof value === "number").sort((a, b) => a - b);
		const at = (values, share) => (values.length ? values[Math.min(values.length - 1, Math.floor(values.length * share))] : null);
		const stats = (values) => {
			const sorted = ordered(values);
			return { reported: sorted.length, median: at(sorted, 0.5), p90: at(sorted, 0.9), max: sorted.at(-1) ?? null };
		};
		const tally = (values) => values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
		report.repair = {
			cases: REPAIR_CASES_VERSION,
			attemptsPerCase: attempts,
			skipped,
			scores: summarizeRepairs(scores),
			repairCalls: {
				calls: repairCalls.length,
				stopReasons: tally(repairCalls.map((call) => call.stopReason ?? "unknown")),
				requested: tally(repairCalls.map((call) => call.effort ?? "unknown")),
				sent: tally(rows.flatMap((row) => row.repairSettings).map((item) => JSON.stringify(item))),
				outputTokens: stats(repairCalls.map((call) => call.output)),
				reasoningTokens: stats(repairCalls.map((call) => call.reasoning)),
				ms: stats(repairCalls.map((call) => call.ms)),
				// Share of the repair calls' input the provider reported as read from its cache.
				cacheReadShare: (() => {
					const read = repairCalls.reduce((sum, call) => sum + (call.cacheRead ?? 0), 0);
					const total = read + repairCalls.reduce((sum, call) => sum + (call.input ?? 0), 0);
					return total ? Number((read / total).toFixed(4)) : null;
				})(),
				costUsd: Number(rows.reduce((sum, row) => sum + (row.usage?.cost?.total ?? 0), 0).toFixed(4)),
			},
		};
	}

	if (mode === "probes") {
		const scores = { history: [], none: [] };
		const calls = { history: { questions: 0, search: 0, read: 0, list: 0, other: 0 }, none: { questions: 0, search: 0, read: 0, list: 0, other: 0 } };
		const missed = { history: { cited: [], uncited: [] }, none: { cited: [], uncited: [] } };
		const compactions = [];
		const probeRows = [];
		for (const id of fixtures) {
			const fixture = readFixture(id);
			const ids = new Set(fixture.entries.map((entry) => entry.id));
			mkdirSync(join(runDir, "chains"), { recursive: true });
			// One chain per fixture, compacted by the measured writer cut after cut, as a user would continue it; with
			// --cuts, only at those checkpoints, everything between them appended as the session grew.
			const chain = cuts ? cuts.map((cut) => cut - 1) : fixture.gold.checkpoints.map((_, index) => index);
			if (chain.at(-1) >= fixture.gold.checkpoints.length) throw new Error(`--cuts: ${id} has ${fixture.gold.checkpoints.length} checkpoints`);
			const file = join(runDir, "chains", `${id}-measured.jsonl`);
			// --replay starts from the header alone: each round unit adds its own entries as the session meets them.
			let lines = replay ? [fixture.header] : [fixture.header, ...span(fixture, -1, chain[0], null)];
			let broken = false;
			for (const [step, k] of chain.entries()) {
				const probes = fixture.gold.probes.filter((probe) => probe.checkpoint === fixture.gold.checkpoints[k].id);
				if (broken || exhausted()) {
					if (broken) for (const probe of probes) for (const condition of probeConditions) scores[condition].push(scoreProbe(fixture.gold, probe, undefined, ids));
					else used.unstarted += probes.length * probeConditions.length;
					continue;
				}
				writeLines(file, lines);
				const roundEntries = replay ? span(fixture, step === 0 ? -1 : chain[step - 1], k, null) : [];
				const measure = cutMeasure([...lines.slice(1), ...roundEntries]);
				if (!replay) await warm(fixture, k, file);
				if (exhausted()) {
					used.unstarted += probes.length * probeConditions.length;
					continue;
				}
				const results = replay ? await replayRound(fixture, k, file, roundEntries) : await compactAt(fixture, k, provider, file);
				results.forEach((result, attempt) => {
					const row = { fixture: id, cut: k + 1, attempt: attempt + 1, ...measure, ok: result.ok, code: result.code, writerCalls: result.writerCalls, repairKind: result.repairKind, quotations: result.quotations, scope: result.scope ?? null, schema: result.schema ?? null, quotationRepair: result.quotationRepair, toolCalls: result.toolCalls ?? 0, toolCallDeclined: result.toolCallDeclined ?? false, calls: result.calls ?? [], path: result.path ?? null, pauseMs: result.pauseMs, usage: result.usage, reduction: result.reduction ?? null, crashed: result.crashed ?? false, journal: result.journal ?? [], note: noteRow(fixture, k, result.note), ...(result.nativeSummaryBytes !== undefined ? { nativeSummaryBytes: result.nativeSummaryBytes } : {}) };
					compactions.push(row);
					record("compactions.jsonl", row);
				});
				equivalent(`bench/probes/${id}/cut${k + 1}/compact`, fixture, file, results.flatMap(unitClasses), { outcome: unitOutcome(results.at(-1)), attempts: results.length });
				if (!results.at(-1).ok) {
					// A blocked checkpoint blocks its probes and every later one in this chain; they are scored as blocked.
					broken = true;
					for (const probe of probes) for (const condition of probeConditions) scores[condition].push(scoreProbe(fixture.gold, probe, undefined, ids));
					continue;
				}
				lines = readLines(file);
				const snapshot = join(runDir, "chains", `${id}-measured-cut${k + 1}.jsonl`);
				writeLines(snapshot, lines);
				const cited = new Set(
					lines
						.filter((entry) => entry.type === "compaction" && entry.details?.kind === "pi-context-memory")
						.flatMap((entry) => Object.values(entry.details.note).flatMap((items) => (Array.isArray(items) ? items.flatMap((item) => item?.sources ?? []) : []))),
				);
				const units = compactionsOnly ? [] : probes.flatMap((probe) => probeConditions.map((condition) => ({ probe, condition })));
				await pool(units, async ({ probe, condition }) => {
					const copied = copy(snapshot, `${probe.id}-${condition}`);
					const result = await run({ type: "probe", provider, fixture: id, probe: probe.id, sessionFile: copied, condition, prompt: `${probe.prompt}\n\n${ANSWER_CONTRACT}`, thinking });
					spend(result, provider !== "loopback");
					const score = scoreProbe(fixture.gold, probe, result.reached ? (result.reply ?? "") : undefined, ids);
					scores[condition].push(score);
					calls[condition].questions++;
					for (const op of ["search", "read", "list", "other"]) calls[condition][op] += result.history?.[op] ?? 0;
					(probe.evidence.some((entry) => cited.has(entry)) || probe.expected.type === "unknown" ? missed[condition].cited : missed[condition].uncited).push(score);
					const row = { probe: probe.id, kind: probe.kind, fixture: id, cut: k + 1, condition, activeTools: result.activeTools, outcome: score.outcome, supported: score.supported, rounds: result.rounds, roundLimit: result.roundLimit, history: result.history, code: result.code, crashed: result.crashed ?? false, usage: result.usage, roundUsage: result.roundUsage ?? [], retrieval: result.retrieval ?? [], reduction: result.reduction ?? null, excerpts: result.excerpts ?? null, excerptTokens: result.excerptTokens ?? 0, journal: result.journal ?? [] };
					probeRows.push(row);
					record("probes.jsonl", row);
					record("answers.jsonl", { probe: probe.id, condition, reply: result.reply ?? null, error: result.error ?? null, errorMessage: result.errorMessage ?? null });
					equivalent(`bench/probes/${id}/cut${k + 1}/${probe.id}/${condition}`, fixture, null, unitClasses(result), { outcome: result.crashed ? "crashed" : score.outcome });
				});
				if (step + 1 < chain.length && !replay) lines = [...lines, ...span(fixture, k, chain[step + 1], lines.at(-1).id)];
			}
		}
		const rate = (list) => ({ planned: list.length, passed: list.filter((row) => row.pass).length });
		report.probes = {
			compactions: { attempts: compactions.length, committed: compactions.filter((row) => row.ok).length, refusedByCode: compactions.filter((row) => !row.ok).reduce((codes, row) => ({ ...codes, [row.code ?? "UNKNOWN"]: (codes[row.code ?? "UNKNOWN"] ?? 0) + 1 }), {}), toolCallResponses: compactions.reduce((sum, row) => sum + (row.toolCalls ?? 0), 0), toolCallsDeclined: compactions.filter((row) => row.toolCallDeclined).length, notes: noteSummary(compactions) },
			...Object.fromEntries(probeConditions.map((condition) => [condition, summarizePreview(scores[condition])])),
			callsPerQuestion: Object.fromEntries(
				Object.entries(calls).map(([condition, value]) => [condition, { questions: value.questions, total: value.search + value.read + value.list + value.other, ...value }]),
			),
			missedEntry: Object.fromEntries(Object.entries(missed).map(([condition, value]) => [condition, { cited: rate(value.cited), uncited: rate(value.uncited) }])),
		};
		report.overhead = overheadReport({ attempts: compactions, probes: probeRows, warmups });
		if (replay) report.replay = replaySummary();
	}

	/**
	 * --replay's report, the measures WP5 of the 0.8.0 plan compares with the synchronous control: the pause over
	 * every committed boundary and over those the segments served, the fallback causes and U8's waits, coverage at
	 * the gold checkpoints, and the calls segments, writers and the session's own turns made, with catalog costs.
	 */
	function replaySummary() {
		const tally = (values) => values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
		const spread = (values) => ({ count: values.filter((value) => typeof value === "number").length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1) });
		const committed = boundaryRows.filter((row) => row.ok);
		const calls = roundRows.flatMap((round) => round.journalCalls ?? []).filter((call) => call.dispatched !== false);
		const merged = new Set(committed.flatMap((row) => row.mergedCallIds ?? []));
		const figures = (list) => {
			const total = (key) => list.reduce((sum, call) => sum + (call.usage?.[key] ?? 0), 0);
			const read = total("cacheRead");
			const input = total("input");
			return { calls: list.length, usageMissing: list.filter((call) => !call.usage).length, input, cacheRead: read, cacheWrite: total("cacheWrite"), output: total("output"), cacheReadShare: read + input ? Number((read / (read + input)).toFixed(4)) : null, costUsd: Number(list.reduce((sum, call) => sum + (call.costUsd ?? 0), 0).toFixed(4)) };
		};
		const segmentCalls = calls.filter((call) => call.purpose === "segment");
		const warm = roundRows.reduce((sum, round) => ({ rounds: sum.rounds + (round.rounds ?? 0), input: sum.input + (round.usage?.input ?? 0), cacheRead: sum.cacheRead + (round.usage?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (round.usage?.cacheWrite ?? 0), output: sum.output + (round.usage?.output ?? 0), costUsd: sum.costUsd + (round.usage?.cost ?? 0) }), { rounds: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 });
		return {
			window,
			reserve,
			pace,
			segments: unitSettings.previewSegments?.enabled === true ? (segmentEffort || "session") : "off",
			steps: roundRows.reduce((sum, round) => sum + (round.steps ?? 0), 0),
			boundaries: {
				total: boundaryRows.length,
				committed: committed.length,
				failed: boundaryRows.length - committed.length,
				byTrigger: tally(boundaryRows.map((row) => row.trigger)),
				paths: tally(committed.map((row) => row.path)),
				fallbacks: tally(committed.map((row) => row.segmentsFallback).filter(Boolean)),
				waited: spread(committed.map((row) => row.segmentsWaitMs)),
			},
			pauseMs: { all: spread(committed.map((row) => row.pauseMs)), covered: spread(committed.filter((row) => row.path === "segments").map((row) => row.pauseMs)), writer: spread(committed.filter((row) => row.path !== "segments").map((row) => row.pauseMs)) },
			coverageAtGold: boundaryRows.filter((row) => row.gold && row.attempt === 1).map((row) => row.coverage ?? null),
			segmentCalls: { ...figures(segmentCalls), merged: segmentCalls.filter((call) => merged.has(call.id)).length, outcomes: tally(segmentCalls.map((call) => call.outcome ?? "unsettled")), discarded: figures(segmentCalls.filter((call) => !merged.has(call.id))) },
			// The preview's own account of each round's segments, summed: /compaction-status's segments.results.
			segmentResults: roundRows.reduce(
				(sum, round) => {
					const results = round.segments;
					if (!results) return sum;
					const add = (into, from) => Object.entries(from ?? {}).reduce((acc, [key, value]) => ({ ...acc, [key]: (acc[key] ?? 0) + value }), into);
					return { linked: sum.linked + results.linked, cancelled: sum.cancelled + results.cancelled, stale: sum.stale + results.stale, failed: add(sum.failed, results.failed), dropped: add(sum.dropped, results.dropped) };
				},
				{ linked: 0, cancelled: 0, stale: 0, failed: {}, dropped: {} },
			),
			pausedRounds: roundRows.filter((round) => round.segmentsState?.state === "paused").map((round) => ({ cut: round.cut, reason: round.segmentsState.reason })),
			writerCalls: figures(calls.filter((call) => call.purpose === "compaction")),
			warmups: { ...warm, costUsd: Number(warm.costUsd.toFixed(4)), cacheReadShare: warm.cacheRead + warm.input ? Number((warm.cacheRead / (warm.cacheRead + warm.input)).toFixed(4)) : null },
		};
	}

	if (equivalenceOut) {
		mkdirSync(dirname(equivalenceOut), { recursive: true });
		const ordered = equivalence.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		appendFileSync(equivalenceOut, ordered.map((item) => item.line).join(""));
	}
	report.used = { ...used, costUsd: Number(used.costUsd.toFixed(4)), warmupCostUsd: Number(used.warmupCostUsd.toFixed(4)), minutes: Number(((Date.now() - started) / 60_000).toFixed(1)) };
	writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
	if (!args.includes("--keep-sessions")) rmSync(join(runDir, "copies"), { recursive: true, force: true });
	rmSync(join(runDir, "cwd"), { recursive: true, force: true });
	process.stdout.write(`${JSON.stringify(report.used)}\nSummary: ${join(runDir, "summary.json")}\n`);
	if (!existsSync(join(runDir, "summary.json"))) process.exit(1);
}

/** A run starts only when this file is the script node was given; a test imports the helpers above without one. */
function invoked() {
	try {
		return realpathSync(process.argv[1]) === realpathSync(script);
	} catch {
		return false;
	}
}

if (invoked()) {
	if (args.includes("--worker")) await worker();
	else await parent();
}
