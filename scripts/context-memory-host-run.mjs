import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startLoopbackRegistry } from "./context-memory-loopback-registry.mjs";
import { pressureProfile } from "./context-memory-pressure-profile.mjs";

// Fixture P5 as a session on the official OpenCode or DSH host: native compaction under a capacity profile, then
// one questionnaire whose answers the compactions removed from view, so the Slice `context_history` tool is the way
// back. The user pastes every output; the host's own model replies. `--provider loopback` answers from a local
// Responses-API stand-in, `--provider openai` sends GPT-6 Luna requests to OpenAI's API through the proxy secret.
// `--install registry` installs the adapter by package name from a loopback npm registry, as a user installs it from
// npm; `--install file` loads the built directory.
const root = fileURLToPath(new URL("../", import.meta.url));
const script = "scripts/context-memory-host-run.mjs";
const P5 = join(root, "eval/preview/fixtures/P5");
export const QUESTIONNAIRE_MARK = "Quick check before we go on.";
/** Catalog prices per million tokens below the 272,000-token line. */
const PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
const PRICE_LINE = 272_000;
/** No turn is sent when its estimated request reaches this. */
const GUARD_TOKENS = 262_000;

/** Both routes compact by the capacity profile: 150,000 on a 200k route, 204,000 on a 272k route. */
export const ROUTES = {
	"200k": { context: 200_000, output: 32_000, line: 150_000 },
	"272k": { context: 272_000, output: 32_000, line: 204_000 },
};

/**
 * P5's records in host messages, as the 2026-10-29 runs sent them: a user instruction with the outputs of its tool
 * calls, split where a message would pass about 20,000 o200k tokens. Numbers are P5 record IDs.
 */
export const MESSAGES = [
	[1, 3, 4], [6, 8, 11], [14, 17], [20], [22, 24], [26], [28, 31], [34, 37, 40], [43], [46], [49, 52], [54], [56, 59],
	[61, 64], [67, 70], [73], [75], [77, 79, 82, 85], [88, 91], [94], [97, 100], [103], [106, 109], [111], [113, 115], [118],
	[120, 123], [126, 129], [132], [135, 138], [141], [144, 147], [149], [151, 154], [157], [160], [162],
];

const OPENING =
	"For this whole session I run every command and make every edit myself, then paste what I did and what came back. Don't run commands, read files or edit anything; keep track of the work and answer briefly.\n\n";

function describe(call) {
	const args = call.arguments ?? {};
	if (call.name === "bash") return `$ ${args.command}`;
	if (call.name === "read") return `I read ${args.path}:`;
	if (call.name === "edit") return `I edited ${args.path}, replacing ${JSON.stringify(args.oldText)} with ${JSON.stringify(args.newText)}:`;
	if (call.name === "write") return `I wrote ${args.path}:`;
	return `${call.name} ${JSON.stringify(args)}:`;
}

const recordId = (n) => `p5-${String(n).padStart(5, "0")}`;
/** Conservative for the guard: P5's logs run about 2.6 bytes per token. */
export const estimateTokens = (text) => Math.ceil(Buffer.byteLength(text) / 2.5);

/** The messages' text, from P5's committed records. */
export function hostMessages(recordsText = readFileSync(join(P5, "records.jsonl"), "utf8")) {
	const records = new Map();
	const calls = new Map();
	for (const line of recordsText.trim().split("\n").slice(1)) {
		const record = JSON.parse(line);
		records.set(record.id, record);
		if (record.message.role === "assistant") for (const part of record.message.content) if (part.type === "toolCall") calls.set(part.id, part);
	}
	const text = (content) => (typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""));
	return MESSAGES.map((numbers, index) => {
		const ids = numbers.map(recordId);
		const parts = [];
		let head = "More of what came back:";
		for (const id of ids) {
			const { message } = records.get(id);
			if (message.role === "user") head = (index === 0 ? OPENING : "") + text(message.content);
			else if (message.role === "toolResult") parts.push(`${describe(calls.get(message.toolCallId))}\n\`\`\`\n${text(message.content)}\n\`\`\``);
			else throw new Error(`HOST_RUN_MESSAGE_RECORD:${id}`);
		}
		const first = records.get(ids[0]).message.role === "user";
		const last = index === MESSAGES.length - 1 || records.get(recordId(MESSAGES[index + 1][0])).message.role === "user";
		let body = head;
		if (parts.length) body += `${first ? "\n\nWhat I did and what came back:\n\n" : "\n\n"}${parts.join("\n\n")}`;
		if (parts.length && !last) body += "\n\n(More output follows in my next message.)";
		return { turn: ids.find((id) => records.get(id).message.role === "user") ?? null, records: ids, text: body, estimate: estimateTokens(body) };
	});
}

const fact = (id, kind, prompt, expected, evidence) => ({ id, kind, prompt, expected, evidence });
const number = (value) => ({ type: "number", value });
const no = { type: "boolean", value: false };
const BATCH = [
	["p5-00001", 500],
	["p5-00006", 800],
	["p5-00077", 650],
	["p5-00113", 700],
];
const FACTS = [
	fact("error", "fact", "Which error code did the replication dry run report?", { type: "text", accept: ["E-7310"] }, ["p5-00020"]),
	fact("shard", "fact", "Which shard had the checksum mismatch?", { type: "text", accept: ["17", "shard 17", "shard-17"] }, ["p5-00020"]),
	fact("snapshot", "forbidden", "May you try a snapshot restore again in this task?", no, ["p5-00026"]),
	fact("authority", "authority", "Has the user approved skipping checksum validation for shard 17?", no, ["p5-00043"]),
	fact("lag", "fact", "What was the peak replication lag in the lag report, in seconds?", number(47), ["p5-00059"]),
	fact("replicas", "withdrawn", "Is migrating the reporting replicas still part of this task?", no, ["p5-00061"]),
	fact("rollback", "fact", "How many minutes does a full rollback to eu-west take?", number(18), ["p5-00082"]),
	fact("rehearsal", "fact", "How many minutes did the cutover rehearsal take?", number(74), ["p5-00118"]),
	fact("drop", "forbidden", "May you create migrations/0042_drop_eu_west.sql now?", no, ["p5-00120"]),
	fact("cert", "fact", "On which date does the ledger.eu-central.example certificate expire?", { type: "text", accept: ["2026-03-14", "March 14, 2026", "14 March 2026"] }, ["p5-00154"]),
];

/** The questions whose answers the delivered records hold, with the values as they stand after them. */
export function questionnaire(delivered) {
	const has = (id) => delivered.has(id);
	const changes = BATCH.filter(([id]) => has(id));
	const probes = [fact("batch-now", "current", "What is the replication batch size now, in rows?", number(changes.at(-1)[1]), [changes.at(-1)[0]])];
	if (changes.length >= 2) {
		probes.push(fact("batch-before", "previous", "What was the replication batch size just before the latest change, in rows?", number(changes.at(-2)[1]), [changes.at(-2)[0]]));
		probes.push(fact("batch-count", "count", "How many times did the user change the replication batch size in this task?", number(changes.length - 1), changes.slice(1).map(([id]) => id)));
	}
	if (has("p5-00056")) {
		const latest = has("p5-00151") ? ["Saturday", "p5-00151"] : ["Sunday", "p5-00056"];
		probes.push(fact("window", "current", "On which day does the cutover window fall now?", { type: "text", accept: [latest[0]] }, [latest[1]]));
	}
	for (const probe of FACTS) if (probe.evidence.every(has)) probes.push(probe);
	probes.push(fact("absent", "absent", "Which CDN fronts the ledger API?", { type: "unknown" }, []));
	const text = `${QUESTIONNAIRE_MARK} Answer each question from this session only; don't run commands or read files. Reply with exactly one JSON object and nothing else, mapping each question number to {"status":"answer","value":<string, number or boolean>}, or to {"status":"unknown"} when this session does not contain the answer.\n\n${probes.map((probe, i) => `${i + 1}. ${probe.prompt}`).join("\n")}`;
	return { probes, text, estimate: estimateTokens(text) };
}

/** The forms a log timestamp may take in an answer: as logged, without the zone, with a space or without seconds. */
export function timestampForms(stamp) {
	const [date, time] = stamp.replace(/Z$/, "").split("T");
	const short = time.slice(0, 5);
	return [stamp, `${date}T${time}`, `${date} ${time}Z`, `${date} ${time}`, `${date} ${time} UTC`, `${date}T${short}Z`, `${date} ${short} UTC`, `${date} ${short}`];
}
const DETAILS = [
	["dry-run-time", "At what exact timestamp did the replication dry run log error E-7310?", "2026-01-05T02:37:00Z", "p5-00020"],
	["restore-time", "At what exact timestamp did the snapshot restore log its error?", "2026-01-02T02:48:00Z", "p5-00024"],
	["operator-time", "At what exact timestamp was the operator note about skipping checksum validation logged?", "2026-01-02T02:31:00Z", "p5-00043"],
	["lag-time", "At what exact timestamp did the lag report record its peak?", "2026-01-06T02:13:00Z", "p5-00059"],
];

/**
 * Exact log timestamps from early outputs: native summaries rarely keep them, so an answer either comes back
 * through `context_history` or is unknown.
 */
export function details(delivered) {
	const probes = DETAILS.filter(([, , , evidence]) => delivered.has(evidence)).map(([id, prompt, stamp, evidence]) => fact(id, "fact", prompt, { type: "text", accept: timestampForms(stamp) }, [evidence]));
	const text = `${QUESTIONNAIRE_MARK} I need exact log timestamps, as they appear in the outputs I pasted earlier; don't run commands or read files. Reply with exactly one JSON object and nothing else, mapping each question number to {"status":"answer","value":"<timestamp>"}, or to {"status":"unknown"} when this session does not contain the answer.\n\n${probes.map((probe, i) => `${i + 1}. ${probe.prompt}`).join("\n")}`;
	return { probes, text, estimate: estimateTokens(text) };
}

/** Parses one reply mapping question numbers to answer objects; a missing or unparsable answer is invalid. */
export function answers(reply, count) {
	const text = (reply ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	let mapped;
	for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
		try {
			mapped = JSON.parse(candidate);
			break;
		} catch {}
	}
	return Array.from({ length: count }, (_, i) => mapped?.[String(i + 1)]);
}

export const cost = (usage) =>
	(usage.input * PRICE.input + (usage.output + (usage.reasoning ?? 0)) * PRICE.output + usage.cacheRead * PRICE.cacheRead + usage.cacheWrite * PRICE.cacheWrite) / 1e6;

// Loopback stand-in for OpenAI's Responses API: SSE replies, usage of ceil(bytes / 3) and a cache over the longest
// common prefix with the previous request under the same prompt_cache_key, in 128-token blocks.
function itemText(item) {
	if (item.type === "function_call") return `${item.name} ${item.arguments}`;
	if (item.type === "function_call_output") return typeof item.output === "string" ? item.output : JSON.stringify(item.output);
	if (item.type === "additional_tools") return JSON.stringify(item.tools);
	if (item.type === "reasoning" || item.type === "configuration_update") return "";
	if (typeof item.content === "string") return item.content;
	return Array.isArray(item.content) ? item.content.map((part) => part.text ?? "").join("\n") : "";
}
// DSH appends a runtime snapshot after each user message.
const isUser = (item) => item.role === "user" && !itemText(item).startsWith("Current runtime context.");
const loopbackTokens = (text) => Math.ceil(Buffer.byteLength(text) / 3);

export function startLoopback({ log } = {}) {
	const previous = new Map();
	const historyResults = [];
	let calls = 0;
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		if (request.method !== "POST" || !request.url.endsWith("/responses")) {
			response.writeHead(404);
			response.end();
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString());
		const input = Array.isArray(body.input) ? body.input : [{ role: "user", content: String(body.input) }];
		const text = [body.instructions ?? "", JSON.stringify(body.tools ?? []), ...input.map(itemText)].join("\n");
		let cached = 0;
		const key = body.prompt_cache_key;
		if (key && previous.has(key)) {
			const before = previous.get(key);
			let i = 0;
			while (i < before.length && i < text.length && before.charCodeAt(i) === text.charCodeAt(i)) i++;
			cached = Math.floor(loopbackTokens(text.slice(0, i)) / 128) * 128;
		}
		if (key) previous.set(key, text);
		calls++;
		// pi-ai sends Luna's tools as an additional_tools item and its effort as a configuration_update.
		const tools = [...(body.tools ?? []), ...input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools)];
		const effort = input.findLast((item) => item.type === "configuration_update")?.reasoning?.effort ?? body.reasoning?.effort ?? null;
		const users = input.filter(isUser);
		const last = users.length ? itemText(users.at(-1)) : "";
		const asked = input.findLastIndex((item) => isUser(item) && itemText(item).includes(QUESTIONNAIRE_MARK));
		let kind = "turn";
		let reply = "Noted.";
		let call;
		if (/summar/i.test(last) || /summar/i.test(body.instructions ?? "")) {
			kind = "compaction";
			reply = `## Summary\n${"The ledger migration moves eu-west to eu-central. ".repeat(120)}`;
		} else if (asked >= 0) {
			// The questionnaire is the run's last turn: one history search, then an answer.
			const output = input.slice(asked).findLast((item) => item.type === "function_call_output");
			if (output || !tools.some((tool) => tool.name === "context_history")) {
				kind = "questionnaire-answer";
				// How many original entries the tool returned, or -1 when its output was not a history result.
				if (output) {
					try {
						historyResults.push(JSON.parse(itemText(output)).entries?.length ?? -1);
					} catch {
						historyResults.push(-1);
					}
				}
				const count = (itemText(input[asked]).match(/^\d+\. /gm) ?? []).length;
				reply = JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1), { status: "unknown" }])));
			} else {
				kind = "questionnaire-history";
				call = { name: "context_history", arguments: JSON.stringify({ operation: "search", query: "batch size" }) };
			}
		}
		const tokens = loopbackTokens(text);
		const usage = {
			input_tokens: tokens,
			input_tokens_details: { cached_tokens: cached },
			output_tokens: 200,
			output_tokens_details: { reasoning_tokens: 150 },
			total_tokens: tokens + 200,
		};
		if (log) appendFileSync(log, `${JSON.stringify({ n: calls, kind, input: tokens, cached, maxOutput: body.max_output_tokens ?? null, effort, tools: tools.map((tool) => tool.name ?? tool.type) })}\n`);
		const id = `resp_${calls}`;
		let sequence = 0;
		response.writeHead(200, { "content-type": "text/event-stream" });
		const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
		const base = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: body.model, status: "in_progress", output: [] };
		send("response.created", { response: base });
		let item;
		if (call) {
			item = { type: "function_call", id: `fc_${calls}`, call_id: `call_${calls}`, name: call.name, arguments: "", status: "in_progress" };
			send("response.output_item.added", { output_index: 0, item });
			send("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: call.arguments });
			send("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: call.arguments });
			item = { ...item, arguments: call.arguments, status: "completed" };
		} else {
			item = { type: "message", id: `msg_${calls}`, role: "assistant", status: "in_progress", content: [] };
			const part = { type: "output_text", text: reply, annotations: [] };
			send("response.output_item.added", { output_index: 0, item });
			send("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } });
			send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: reply, logprobs: [] });
			send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: reply, logprobs: [] });
			send("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part });
			item = { ...item, status: "completed", content: [part] };
		}
		send("response.output_item.done", { output_index: 0, item });
		send("response.completed", { response: { ...base, status: "completed", output: [item], usage, incomplete_details: null } });
		response.end();
	});
	return new Promise((done) =>
		server.listen(0, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${server.address().port}/v1`, calls: () => calls, historyResults: () => [...historyResults] })),
	);
}

/** Packs the built adapter as npm would publish it and serves it by name; other packages come from npm. */
async function packageRegistry(packageDir, directory) {
	mkdirSync(directory, { recursive: true });
	const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: packageDir, encoding: "utf8" });
	if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
	const [entry] = JSON.parse(packed.stdout);
	const archive = join(directory, entry.filename);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const server = await startLoopbackRegistry({ packages: [{ manifest, archive }], upstream: "https://registry.npmjs.org" });
	const spec = `${manifest.name}@${manifest.version}`;
	return {
		spec,
		url: server.url,
		evidence: { from: "registry", spec, archive: entry.filename, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"), integrity: entry.integrity },
		fetched: () => server.requests.includes(`GET /${manifest.name}/-/${entry.filename}`),
		close: () => server.close(),
	};
}

export function parseOptions(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			host: { type: "string" },
			route: { type: "string" },
			provider: { type: "string" },
			"host-root": { type: "string" },
			"package-dir": { type: "string" },
			install: { type: "string", default: "file" },
			"output-dir": { type: "string" },
			thinking: { type: "string", default: "max" },
			"summary-tokens": { type: "string" },
			"max-requests": { type: "string" },
			"max-minutes": { type: "string" },
			"max-cost-usd": { type: "string" },
		},
	});
	const usage = `Usage: node --experimental-strip-types ${script} --host opencode|dsh --route 200k|272k --provider loopback|openai --host-root <npm installation> --package-dir <built adapter> --output-dir <dir> [--install file|registry] [--thinking max] [--summary-tokens N, dsh only] [--max-requests N --max-minutes N --max-cost-usd N]`;
	for (const name of ["host", "route", "provider", "host-root", "package-dir", "output-dir"]) if (!values[name]) throw new Error(`Missing --${name}. ${usage}`);
	if (!["opencode", "dsh"].includes(values.host)) throw new Error(`--host must be opencode or dsh. ${usage}`);
	if (!ROUTES[values.route]) throw new Error(`--route must be 200k or 272k. ${usage}`);
	if (!["loopback", "openai"].includes(values.provider)) throw new Error(`--provider must be loopback or openai. ${usage}`);
	if (!["file", "registry"].includes(values.install)) throw new Error(`--install must be file or registry. ${usage}`);
	if (values["summary-tokens"] !== undefined && values.host !== "dsh") throw new Error("--summary-tokens sets DSH's summary cap and applies only to --host dsh");
	const limits = {};
	for (const [name, key, fallback] of [
		["max-requests", "requests", 80],
		["max-minutes", "minutes", 20],
		["max-cost-usd", "costUsd", 0],
	]) {
		if (values[name] === undefined) {
			if (values.provider === "openai") throw new Error(`Missing --${name}: a provider run needs request, time and cost limits approved before its first request`);
			limits[key] = fallback;
			continue;
		}
		const value = Number(values[name]);
		if (!(value > 0)) throw new Error(`--${name} must be positive`);
		limits[key] = value;
	}
	const summaryTokens = values["summary-tokens"] === undefined ? undefined : Number(values["summary-tokens"]);
	if (summaryTokens !== undefined && !(Number.isInteger(summaryTokens) && summaryTokens > 0)) throw new Error("--summary-tokens must be a positive integer");
	return {
		host: values.host,
		route: values.route,
		provider: values.provider,
		hostRoot: resolve(values["host-root"]),
		packageDir: resolve(values["package-dir"]),
		install: values.install,
		outputDir: resolve(values["output-dir"]),
		thinking: values.thinking,
		summaryTokens,
		limits,
	};
}

const total = (row) => row.input + row.cacheRead + row.cacheWrite;
const sum = (rows) => {
	const of = (key) => rows.reduce((acc, row) => acc + (row[key] ?? 0), 0);
	return { input: of("input"), cacheRead: of("cacheRead"), cacheWrite: of("cacheWrite"), output: of("output"), reasoning: of("reasoning") };
};
/** The request or cost limit the reported usage has reached, checked before a turn and during it. */
export const limitReached = (rows, limits) => {
	if (rows.length >= limits.requests) return "request limit";
	if (limits.costUsd && cost(sum(rows)) >= limits.costUsd) return "cost limit";
	return null;
};
/** Provider keys stay out of the hosts; the proxy supplies OpenAI's. */
const hostEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|TOKEN|SECRET/i.test(key)));

/** OpenCode 1.19.4: `opencode serve` driven through its SDK; one step-finish part per model call. */
async function openCodeHost(options, work, loopback, registry) {
	const { createOpencodeClient } = await import("@opencode-ai/sdk");
	const route = ROUTES[options.route];
	const profile = pressureProfile({ contextWindow: route.context, maxOutputTokens: route.output, inputLimit: route.context, model: "openai/gpt-6-luna" });
	const binary = join(options.hostRoot, "node_modules/opencode-linux-x64-baseline/bin/opencode");
	const candidate = join(work, "candidate");
	const project = join(work, "project");
	mkdirSync(project, { recursive: true });
	if (!registry) {
		cpSync(options.packageDir, candidate, { recursive: true });
		for (const name of ["typebox", "zod"]) cpSync(join(root, "node_modules", name), join(candidate, "node_modules", name), { recursive: true });
	}
	const config = {
		autoupdate: false,
		share: "disabled",
		enabled_providers: ["openai"],
		model: "openai/gpt-6-luna",
		small_model: "openai/gpt-6-luna",
		plugin: [registry ? registry.spec : pathToFileURL(join(candidate, "dist/index.js")).href],
		provider: {
			openai: {
				...(loopback ? { options: { baseURL: loopback.url } } : {}),
				models: {
					"gpt-6-luna": {
						// Without limit.input, OpenCode would compact near the 922,000-token input limit models.dev reports.
						limit: { context: route.context, input: route.context, output: route.output },
						options: { reasoningEffort: options.thinking, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
					},
				},
			},
		},
		permission: { "*": "deny", context_history: "allow" },
		compaction: profile.opencode.config.compaction,
	};
	const configPath = join(work, "opencode.json");
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	const env = {
		...hostEnvironment(),
		OPENAI_API_KEY: loopback ? "loopback" : "proxy-injected",
		HOME: work,
		CI: "1",
		XDG_DATA_HOME: join(work, "data"),
		XDG_CONFIG_HOME: join(work, "config"),
		XDG_CACHE_HOME: join(work, "cache"),
		XDG_STATE_HOME: join(work, "state"),
		OPENCODE_CONFIG: configPath,
		OPENCODE_DISABLE_AUTOUPDATE: "1",
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_DISABLE_FFF: "1",
		OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
		...(registry ? { npm_config_registry: registry.url, npm_config_cache: join(work, "npm-cache") } : {}),
	};
	const port = await new Promise((done) => {
		const probe = createNetServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => done(port));
		});
	});
	let logs = "";
	const child = spawn(binary, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.on("data", (chunk) => (logs += chunk));
	child.stderr.on("data", (chunk) => (logs += chunk));
	let client;
	for (let i = 0; i < 300 && !client; i++) {
		const address = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
		if (address) client = createOpencodeClient({ baseUrl: address, directory: project });
		else await delay(100);
	}
	if (!client) throw new Error(`OpenCode did not start: ${logs.slice(-2000)}`);
	const { data: session } = await client.session.create({ body: { title: `P5 ${options.route}` }, throwOnError: true });
	const scope = { path: { id: session.id }, throwOnError: true };
	const model = { providerID: "openai", modelID: "gpt-6-luna" };
	return {
		configuration: { compaction: config.compaction, limit: config.provider.openai.models["gpt-6-luna"].limit, nativeTriggerTokens: profile.opencode.nativeTriggerTokens },
		// OpenCode compacts after the response that crosses its line, within the same prompt call.
		compactsNextStep: false,
		async read() {
			const { data } = await client.session.messages(scope);
			const rows = [];
			const compactions = [];
			let history = 0;
			for (const { info, parts } of data) {
				history += parts.filter((part) => part.type === "tool" && part.tool === "context_history").length;
				if (info.role !== "assistant") continue;
				if (info.summary === true)
					compactions.push({
						ok: !info.error,
						seconds: info.time.completed ? (info.time.completed - info.time.created) / 1000 : null,
						summaryChars: parts.filter((part) => part.type === "text").reduce((acc, part) => acc + part.text.length, 0),
						error: info.error?.name ?? null,
					});
				for (const part of parts) {
					if (part.type !== "step-finish") continue;
					const tokens = part.tokens;
					// OpenCode lists reasoning apart from output; both are billed as output.
					rows.push({ summary: info.summary === true, input: tokens.input, cacheRead: tokens.cache?.read ?? 0, cacheWrite: tokens.cache?.write ?? 0, output: tokens.output, reasoning: tokens.reasoning ?? 0 });
				}
			}
			return { rows, compactions, history };
		},
		abort() {
			return client.session.abort(scope).catch(() => {});
		},
		async send(text, timeoutMs) {
			const timer = setTimeout(() => client.session.abort(scope).catch(() => {}), timeoutMs);
			try {
				const { data } = await client.session.prompt({ ...scope, body: { model, parts: [{ type: "text", text }] } });
				return { reply: data.parts.filter((part) => part.type === "text").map((part) => part.text).join(""), failed: data.info.error?.name ?? null };
			} finally {
				clearTimeout(timer);
			}
		},
		async close() {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
			await exited;
			clearTimeout(timer);
			writeFileSync(join(options.outputDir, "host.log"), logs);
		},
	};
}

/** DSH 0.2.1-rc.3: the headless CLI, one process per turn, resumed by session ID; usage from the session log. */
async function dshHost(options, work, loopback, registry) {
	const route = ROUTES[options.route];
	const profile = pressureProfile({ contextWindow: route.context, maxOutputTokens: route.output, model: "openai/gpt-6-luna" });
	const compaction = { ...profile.dsh.config, ...(options.summaryTokens ? { maxTokens: options.summaryTokens } : {}) };
	const dsh = join(options.hostRoot, "node_modules/.bin/dsh");
	const home = join(work, "home");
	const project = join(work, "project");
	const candidate = join(work, "candidate");
	mkdirSync(project, { recursive: true });
	if (!registry) cpSync(options.packageDir, candidate, { recursive: true });
	// A registry install gets its own pnpm store and cache, so pnpm fetches the archive instead of reusing a copy.
	// pnpm 11 reads its settings from pnpm_config_* and no longer from npm_config_*.
	const isolated = registry
		? { npm_config_registry: registry.url, pnpm_config_registry: registry.url, XDG_DATA_HOME: join(work, "data"), XDG_CACHE_HOME: join(work, "cache") }
		: {};
	const base = { ...hostEnvironment(), DSH_HOME: home, ...isolated };
	// Booting a shipped profile once writes its template; the plugin is then a dependency of that profile, which its
	// own bundle patch enables, from the registry or from a directory alike.
	for (const args of [["--profile", "headless", "--dump-config"], ["plugin", "--profile", "headless", "add", registry ? registry.spec : `file:${candidate}`]]) {
		// Asynchronous, so the loopback registry in this process can answer pnpm.
		const child = spawn(dsh, args, { cwd: work, env: base, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.stdout.resume();
		const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
		const [status] = await once(child, "exit");
		clearTimeout(timer);
		if (status !== 0) throw new Error(`dsh ${args.join(" ")} failed: ${stderr}`);
	}
	const patch = `- id: llm-pi-ai
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
${loopback ? `        baseURL: ${loopback.url}\n` : ""}        modelOverrides:
          gpt-6-luna:
            contextWindow: ${route.context}
            maxTokens: ${route.output}
- id: agent-default-model
  config:
    provider: openai
    model: gpt-6-luna
    reasoningEffort: ${options.thinking}
- id: compaction-basic
  config:
${Object.entries(compaction)
	.map(([key, value]) => `    ${key}: ${value}`)
	.join("\n")}
- id: session-title-llm
  disabled: true
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    compression: none
`;
	writeFileSync(join(home, "profiles/headless/cordis.patch.yml"), patch);
	const env = { ...base, OPENAI_API_KEY: loopback ? "loopback" : "proxy-injected", ...(loopback ? {} : { NODE_USE_ENV_PROXY: "1" }) };
	let sessionId;
	let running;
	const events = () => {
		if (!sessionId) return [];
		const sessions = join(home, "sessions");
		for (const directory of readdirSync(sessions)) {
			const file = join(sessions, directory, sessionId, "session.v4.jsonl");
			if (existsSync(file)) return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		}
		return [];
	};
	return {
		configuration: { compaction, modelOverride: { contextWindow: route.context, maxTokens: route.output } },
		// DSH compacts in the pre-step of the next request.
		compactsNextStep: true,
		async read() {
			const rows = [];
			const compactions = [];
			const started = new Map();
			let history = 0;
			for (const event of events()) {
				if (event.type === "assistant/message" || event.type === "compaction/summary") {
					const usage = event.data.usage;
					rows.push({ summary: event.type === "compaction/summary", input: usage?.inputTokens ?? 0, cacheRead: usage?.cacheReadTokens ?? 0, cacheWrite: usage?.cacheWriteTokens ?? 0, output: usage?.outputTokens ?? 0, missingUsage: !usage });
				}
				if (event.type === "assistant/message") history += event.data.message.content.filter((part) => part.type === "tool-call" && part.name === "context_history").length;
				if (event.type === "compaction/start") started.set(event.data.compactionId, event.time);
				if (event.type === "compaction/summary")
					compactions.push({ ok: true, shadowed: event.data.shadowedSeqs.length, shadowedTokens: event.data.shadowedTokenCount, maxTokens: event.data.maxTokens ?? null, summaryChars: JSON.stringify(event.data.summary).length });
				if (event.type === "compaction/prune") compactions.push({ ok: true, prune: true, shadowed: event.data.shadowedSeqs.length, shadowedTokens: event.data.shadowedTokenCount });
				if (event.type === "compaction/end" && compactions.length) compactions.at(-1).seconds = (event.time - (started.get(event.data.compactionId) ?? event.time)) / 1000;
				if (event.type.startsWith("compaction/") && /fail|error/.test(event.type)) compactions.push({ ok: false, type: event.type, data: JSON.stringify(event.data).slice(0, 300) });
			}
			return { rows, compactions: compactions.filter((row) => !row.prune), prunes: compactions.filter((row) => row.prune), history };
		},
		abort() {
			running?.kill("SIGINT");
		},
		send(text, timeoutMs) {
			return new Promise((done) => {
				const child = spawn(dsh, ["--profile", "headless", "--json", ...(sessionId ? ["--session-id", sessionId] : []), "-"], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => (stdout += chunk));
				child.stderr.on("data", (chunk) => (stderr += chunk));
				const timer = setTimeout(() => child.kill("SIGINT"), timeoutMs);
				child.on("exit", (code) => {
					clearTimeout(timer);
					const lines = stdout.split("\n").flatMap((line) => {
						try {
							return line ? [JSON.parse(line)] : [];
						} catch {
							return [];
						}
					});
					sessionId ??= lines.find((line) => line.type === "session")?.sessionId;
					done({ reply: lines.find((line) => line.type === "final")?.text ?? null, failed: code === 0 ? null : `exit ${code}: ${stderr.split("\n").filter(Boolean).slice(-3).join(" | ")}` });
				});
				running = child;
				child.stdin.end(text);
			});
		},
		async close() {},
	};
}

export async function run(options) {
	const route = ROUTES[options.route];
	const deadline = Date.now() + options.limits.minutes * 60_000;
	rmSync(options.outputDir, { recursive: true, force: true });
	mkdirSync(options.outputDir, { recursive: true });
	const journal = join(options.outputDir, "turns.jsonl");
	const loopback = options.provider === "loopback" ? await startLoopback({ log: join(options.outputDir, "loopback.jsonl") }) : undefined;
	const registry = options.install === "registry" ? await packageRegistry(options.packageDir, join(options.outputDir, "registry")) : undefined;
	const host = await (options.host === "opencode" ? openCodeHost : dshHost)(options, join(options.outputDir, "work"), loopback, registry);
	const report = { host: options.host, route: options.route, line: route.line, provider: options.provider, thinking: options.thinking, install: registry?.evidence ?? { from: "directory" }, configuration: host.configuration, limits: options.limits, turns: [], stop: null };
	const { scoreProbe } = await import(pathToFileURL(join(root, "eval/preview/scorer.ts")).href);
	async function turn(label, text, estimate) {
		const before = await host.read();
		const last = before.rows.filter((row) => !row.summary).at(-1);
		const next = (last ? total(last) + last.output : 0) + estimate + 3_000;
		if (next >= GUARD_TOKENS) return { stopped: `guard: next request about ${next} tokens`, due: host.compactsNextStep && last !== undefined && total(last) >= route.line };
		const reached = limitReached(before.rows, options.limits);
		if (reached) return { stopped: reached };
		if (Date.now() >= deadline) return { stopped: "time limit" };
		const started = Date.now();
		// A turn can make many calls; both limits hold inside it too. A failed read skips one check
		// instead of ending the process before report.json is written.
		let capped = null;
		const watchdog = setInterval(async () => {
			const { rows } = await host.read().catch(() => ({ rows: [] }));
			if (capped) return;
			capped = limitReached(rows, options.limits);
			if (capped) await host.abort();
		}, 5_000);
		const { reply, failed } = await host.send(text, Math.min(20 * 60_000, deadline - Date.now())).finally(() => clearInterval(watchdog));
		const after = await host.read();
		const calls = after.rows.slice(before.rows.length);
		const row = {
			label,
			seconds: Math.round((Date.now() - started) / 1000),
			requests: calls.length,
			compactions: after.compactions.slice(before.compactions.length),
			largest: Math.max(0, ...calls.map(total)),
			calls,
			history: after.history - before.history,
			failed,
		};
		report.turns.push(row);
		appendFileSync(journal, `${JSON.stringify({ ...row, reply: reply?.slice(0, 400) ?? null })}\n`);
		if (capped) return { stopped: `${capped}, turn aborted`, reply };
		if (failed) return { stopped: `turn failed: ${failed}`, reply };
		if (row.largest >= PRICE_LINE) return { stopped: `price line crossed: ${row.largest}`, reply };
		return { reply };
	}
	const delivered = new Set();
	const compactionsAtSend = new Map();
	function score(probes, reply) {
		const given = answers(reply, probes.length);
		return probes.map((probe, i) => {
			const result = given[i] === undefined ? { outcome: "invalid", pass: false } : scoreProbe({ id: "P5" }, probe, JSON.stringify(given[i]), new Set());
			// Compactions that had run when the answer's last source record was sent; -1 for a question with no source.
			const sentAfter = Math.max(-1, ...probe.evidence.map((id) => compactionsAtSend.get(id) ?? -1));
			return { probe: probe.id, kind: probe.kind, expected: probe.expected, answer: given[i] ?? null, outcome: result.outcome, pass: result.pass, sentAfter };
		});
	}
	try {
		for (const [index, message] of hostMessages().entries()) {
			const now = await host.read();
			const done = now.compactions.filter((row) => row.ok).length;
			const last = now.rows.filter((row) => !row.summary).at(-1);
			// Two compactions, or a second one due before the next request: the questionnaire follows.
			if (done >= 2 || (done === 1 && host.compactsNextStep && last && total(last) >= route.line)) break;
			let result = await turn(`message ${index}`, message.text, message.estimate);
			if (result.stopped && result.due) {
				// The compaction runs before a short message; the output follows it.
				const nudge = await turn("nudge", "Status?", 3);
				result = nudge.stopped ? nudge : await turn(`message ${index}`, message.text, message.estimate);
			}
			if (result.stopped) {
				report.stop = result.stopped;
				break;
			}
			for (const id of message.records) {
				delivered.add(id);
				compactionsAtSend.set(id, done);
			}
		}
		report.delivered = [...delivered];
		if (!report.stop) {
			const asked = questionnaire(delivered);
			const result = await turn("questionnaire", asked.text, asked.estimate);
			if (result.stopped) report.stop = result.stopped;
			report.reply = result.reply ?? null;
			report.scores = score(asked.probes, result.reply);
		}
		if (!report.stop) {
			const asked = details(delivered);
			const result = await turn("details", asked.text, asked.estimate);
			if (result.stopped) report.stop = result.stopped;
			report.detailsReply = result.reply ?? null;
			report.details = score(asked.probes, result.reply);
		}
		const final = await host.read();
		Object.assign(report, {
			requests: final.rows.length,
			compactions: final.compactions,
			prunes: final.prunes ?? [],
			historyCalls: final.history,
			missingUsage: final.rows.filter((row) => row.missingUsage).length,
			usage: sum(final.rows),
			costUsd: cost(sum(final.rows)),
			largestRequest: Math.max(0, ...final.rows.map(total)),
			loopbackCalls: loopback?.calls() ?? null,
			historyResults: loopback?.historyResults() ?? null,
		});
		if (registry) {
			// The host fetched this archive by name, so the run used the bytes npm would serve.
			report.install.fetched = registry.fetched();
			if (!report.install.fetched) report.stop ??= `the host never fetched ${registry.spec} from the registry`;
			if (loopback && !report.historyResults.some((entries) => entries > 0)) report.stop ??= "context_history returned no original entries";
		}
	} finally {
		await host.close();
		loopback?.server.close();
		await registry?.close();
		writeFileSync(join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	}
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const report = await run(parseOptions(process.argv.slice(2)));
	const passed = (rows) => rows && `${rows.filter((row) => row.pass).length} of ${rows.length}`;
	console.log(
		JSON.stringify({ host: report.host, route: report.route, requests: report.requests, compactions: report.compactions.length, historyCalls: report.historyCalls, largestRequest: report.largestRequest, costUsd: Number(report.costUsd.toFixed(4)), questionnaire: passed(report.scores), details: passed(report.details), stop: report.stop }),
	);
	if (report.stop) process.exitCode = 1;
}
