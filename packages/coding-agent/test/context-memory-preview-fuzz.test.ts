// 0.8.0 WP4: a seeded lifecycle fuzz of segments in the stock-Pi preview. Structured like Mastra's lifecycle fuzz,
// seeded weighted operations with invariants checked after each, and extended with what Mastra's lacks: writer
// failures and timeouts, restarts, branch and model switches, and /compact in the middle of a chain. The harness
// stands in for Pi: it emits the events the extension handles, in Pi's order, and commits what the hook returns.
// Every record and sentence is invented; no provider is called.
//
// Invariants, after every operation or commit: each original after the base checkpoint's coverage is covered by the
// new checkpoint or kept verbatim; coverage never moves back; a merged chain is the kept chain's prefix, contiguous
// from the base; the kept chain stays contiguous on the current branch; no checkpoint repeats a fact from the same
// sources; every writer request has a journal record of its purpose and every record settles; a failed compaction
// blocks the next request until a checkpoint commits; and at the end an explicit /compact always recovers.
//
// CONTEXT_MEMORY_FUZZ_SEEDS sets how many seeds run (default 100), CONTEXT_MEMORY_FUZZ_SEED reruns one with its
// last CONTEXT_MEMORY_FUZZ_LOG operations (default 24) in the failure, and CONTEXT_MEMORY_FUZZ_REPORT names a file
// for the count of each path the run reached. A segment's deadline and U8's wait are shortened to milliseconds so
// timeouts happen; their timers can shift the interleaving on a loaded machine, and every invariant must hold under
// any interleaving.
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type CompactionEntry,
	type ExtensionContext,
	estimateTokens,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { MemoryNote, NoteFact } from "../../compaction-core/src/notes.ts";
import { DEFAULT_MEMORY_CONFIG, SESSION_WRITER } from "../src/extensions/context-memory/config.ts";
import { CONTEXT_KEEP_NONE } from "../src/extensions/context-memory/identity.ts";
import { CallJournal } from "../src/extensions/context-memory/preview/call-journal.ts";
import type { PreviewCompaction, PreviewSession } from "../src/extensions/context-memory/preview/contracts.ts";
import { PreviewMemoryController } from "../src/extensions/context-memory/preview/controller.ts";
import { PreviewFailureStore } from "../src/extensions/context-memory/preview/failure-store.ts";
import { PreviewSegments } from "../src/extensions/context-memory/preview/segments.ts";

/** A preview checkpoint's details, with the preparation record a plain memory checkpoint lacks. */
type Details = NonNullable<PreviewCompaction["details"]>;

// 100 since WP5's bound on the verbatim tail: a merge after U8's wait now needs the segment it waited for to leave at
// most one range uncovered, and seeds 1 to 40 no longer reach one.
const SEEDS = Number(process.env.CONTEXT_MEMORY_FUZZ_SEEDS ?? 100);
const ONLY = process.env.CONTEXT_MEMORY_FUZZ_SEED;
const REPORT = process.env.CONTEXT_MEMORY_FUZZ_REPORT;
const OPERATIONS = 48;
const timestamp = "2026-01-01T00:00:00.000Z";
/** About 17,000 tokens: more than a later segment's 16,742-token range at this window's trigger. */
const PADDING = " Synthetic padding.".repeat(3_600);
const WINDOW = 128_000;
/** Pi's trigger with its default 16,384-token reserve. */
const TRIGGER = WINDOW - 16_384;

/** Mulberry32: small, fast and the same on every platform. */
function generator(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function model(id: string): Model<Api> {
	return {
		id,
		name: `Synthetic ${id}`,
		provider: "preview-test",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: WINDOW,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function reply(stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "preview-test",
		model: "preview-test",
		content,
		stopReason,
		timestamp: 1,
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** A session file Pi would write: append-only JSONL, with tree navigation moving only the leaf. */
class FuzzSession implements PreviewSession {
	readonly header: SessionHeader;
	readonly entries: SessionEntry[] = [];
	readonly file: string;
	readonly root: string;
	leafId: string | null = null;
	constructor(root: string) {
		this.root = root;
		this.file = join(root, "fuzz-session.jsonl");
		this.header = { type: "session", version: 3, id: "fuzz-session", timestamp, cwd: root };
		fs.writeFileSync(this.file, `${JSON.stringify(this.header)}\n`);
	}
	getCwd() {
		return this.root;
	}
	getSessionDir() {
		return this.root;
	}
	getSessionId() {
		return this.header.id;
	}
	getSessionFile() {
		return this.file;
	}
	getLeafId() {
		return this.leafId;
	}
	getLeafEntry() {
		return this.leafId ? this.getEntry(this.leafId) : undefined;
	}
	getEntry(id: string) {
		return this.entries.find((entry) => entry.id === id);
	}
	getLabel(_id: string) {
		return undefined;
	}
	getHeader() {
		return this.header;
	}
	getEntries() {
		return [...this.entries];
	}
	getTree() {
		return [];
	}
	getSessionName() {
		return undefined;
	}
	getBranch(fromId?: string): SessionEntry[] {
		const branch: SessionEntry[] = [];
		let entry = this.getEntry(fromId ?? this.leafId ?? "");
		while (entry) {
			branch.unshift(entry);
			entry = entry.parentId ? this.getEntry(entry.parentId) : undefined;
		}
		return branch;
	}
	buildContextEntries() {
		return this.getBranch();
	}
	buildSessionProjection() {
		return buildSessionProjection(this.getBranch());
	}
	append(entry: SessionEntry): void {
		this.entries.push(entry);
		this.leafId = entry.id;
		fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
	}
}

type Outcome = "refusal" | "tool-call" | "length" | "error" | "hang";

const text = (entry: SessionEntry | undefined): string =>
	entry?.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string"
		? entry.message.content
		: "";
const empty = (): MemoryNote => ({
	instructions: [],
	failedPaths: [],
	reasons: [],
	state: [],
	nextSteps: [],
	files: [],
	gaps: [],
});
const PORT = /Use port (\d+)\./;
const RETRIES = /Keep retries at (\d+)\./;
const FILE = /Record (src\/[\w-]+\.ts) as touched\./;
const PROGRESS = "Work continues after ";

/**
 * A faithful scripted writer: one instruction per standing ruling, cited and quoted from the user's message, a file
 * fact per recorded file and one progress fact. A segment gives what its range adds or changes and names in
 * `supersedes` every source the current note cites for a ruling or progress it replaces, as the instruction asks.
 */
function writtenNote(records: readonly SessionEntry[], previous: MemoryNote | undefined): MemoryNote {
	const note = empty();
	const replaced = (pattern: RegExp | string) =>
		[...(previous?.instructions ?? []), ...(previous?.state ?? [])]
			.filter((item) => (typeof pattern === "string" ? item.text.startsWith(pattern) : pattern.test(item.text)))
			.flatMap((item) => item.sources);
	for (const pattern of [PORT, RETRIES]) {
		const ruling = records.findLast((entry) => pattern.test(text(entry)));
		const match = ruling && text(ruling).match(pattern);
		if (!ruling || !match) continue;
		// A whole note restates the standing rulings and names nothing it replaces.
		const supersedes = previous
			? [
					...new Set([
						...replaced(pattern),
						...records.filter((entry) => entry !== ruling && pattern.test(text(entry))).map((entry) => entry.id),
					]),
				]
			: [];
		note.instructions.push({
			text: match[0],
			sources: [ruling.id],
			quote: match[0],
			...(supersedes.length ? { supersedes } : {}),
		});
	}
	for (const entry of records) {
		const file = text(entry).match(FILE);
		if (file) note.files.push({ text: file[1], sources: [entry.id] });
	}
	// Progress cites the last reply with text; an aborted reply has none and is not a readable source.
	const last =
		records.findLast(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((part) => part.type === "text"),
		) ?? records.findLast((entry) => text(entry));
	if (last) {
		const supersedes = previous ? replaced(PROGRESS) : [];
		note.state.push({
			text: `${PROGRESS}${last.id}.`,
			sources: [last.id],
			...(supersedes.length ? { supersedes } : {}),
		});
	}
	return note;
}

/** The request's closing instruction: the session writer's handover is the last message. */
function instruction(context: Context): string {
	const last = context.messages.at(-1);
	return typeof last?.content === "string" ? last.content : "";
}

class Violation extends Error {}

/** One seed's run: Pi's side of every event, the scripted writer and the invariants. */
class Harness {
	readonly random: () => number;
	readonly root: string;
	readonly agentDir: string;
	readonly session: FuzzSession;
	readonly models = [model("fuzz-a"), model("fuzz-b")];
	readonly log: string[] = [];
	ctx!: ExtensionContext;
	journal!: CallJournal;
	segments!: PreviewSegments;
	controller!: PreviewMemoryController;
	/** Writer requests by kind, across restarts. */
	readonly requests = { segment: 0, compaction: 0 };
	pending?: Outcome;
	/** A provider problem that fails the next segment requests the same way, which is what trips the breaker. */
	failing?: { outcome: Exclude<Outcome, "hang">; left: number };
	compacting?: AbortController;
	/** Set by a failed compaction or a refused request, cleared by a confirmed commit. */
	blocked = false;
	/** Set by the extension's ctx.compact(); Pi starts that compaction as soon as the handler returns. */
	compactRequested = false;
	turns = 0;
	checkpoints = 0;
	/** What the run reached, so a seed set that never exercised a path is visible and fails the coverage test. */
	readonly reached = new Map<string, number>();

	readonly seed: number;

	constructor(seed: number) {
		this.seed = seed;
		this.random = generator(seed);
		this.root = fs.mkdtempSync(join(tmpdir(), `pi-preview-fuzz-${seed}-`));
		this.agentDir = join(this.root, "agent");
		this.session = new FuzzSession(this.root);
		this.turn("plain", false);
		this.start();
	}

	note(event: string): void {
		this.reached.set(event, (this.reached.get(event) ?? 0) + 1);
	}

	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.random() * items.length)];
	}

	/** Pi starting, or restarting: a new process with the same agent directory and session file. */
	start(): void {
		const registry = {
			find: (provider: string, id: string) =>
				this.models.find((item) => item.provider === provider && item.id === id),
			hasConfiguredAuth: () => true,
			streamSimple: (_model: Model<Api>, context: Context, options?: { signal?: AbortSignal }) =>
				this.write(context, options?.signal),
		};
		const current = this.ctx?.model ?? this.models[0];
		this.ctx = {
			sessionManager: this.session,
			model: current,
			modelRegistry: registry,
			thinkingLevel: "off",
			getSystemPrompt: () => "Synthetic system prompt.",
			hasPendingMessages: () => false,
			getContextUsage: () => ({ tokens: this.tokens(), contextWindow: WINDOW, percent: null }),
			hasUI: false,
			ui: { notify: vi.fn() },
			abort: vi.fn(),
			compact: () => {
				this.compactRequested = true;
			},
		} as unknown as ExtensionContext;
		this.journal = new CallJournal(this.agentDir);
		this.segments = new PreviewSegments({
			enabled: true,
			journal: this.journal,
			waitMs: 3,
			deadlineMs: 60,
		});
		this.controller = new PreviewMemoryController({
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: SESSION_WRITER, noteRepair: false },
			failureStore: new PreviewFailureStore(this.agentDir),
			segments: this.segments,
			journal: this.journal,
		});
		this.controller.sessionStart(this.ctx);
	}

	/** Pi's context estimate after the latest checkpoint on the branch. */
	tokens(): number {
		return this.session.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	}

	/** The scripted provider. The next scheduled outcome, if any, applies to whichever request comes first. */
	write(context: Context, signal: AbortSignal | undefined) {
		const request = instruction(context);
		const range = request.match(/Write a segment note for entries (\S+) through (\S+) only/);
		this.requests[range ? "segment" : "compaction"]++;
		let outcome = this.pending;
		this.pending = undefined;
		if (range && this.failing && !outcome) {
			outcome = this.failing.outcome;
			if (--this.failing.left === 0) this.failing = undefined;
		}
		if (outcome) this.note(`${outcome}:${range ? "segment" : "compaction"}`);
		const stream = createAssistantMessageEventStream();
		const done = (message: AssistantMessage) => {
			stream.push({
				type: "done",
				reason: message.stopReason === "stop" ? "stop" : message.stopReason === "length" ? "length" : "toolUse",
				message,
			});
			stream.end(message);
		};
		const fail = (reason: "aborted" | "error") => {
			const error = { ...reply(reason, []), errorMessage: `Synthetic ${reason}.` };
			stream.push({ type: "error", reason, error });
			stream.end(error);
		};
		if (outcome === "hang") {
			// Only an abort ends it: the segment's deadline, an invalidation, or Pi cancelling a compaction.
			if (signal?.aborted) queueMicrotask(() => fail("aborted"));
			else signal?.addEventListener("abort", () => fail("aborted"), { once: true });
			if (!range) setImmediate(() => this.compacting?.abort());
			return stream;
		}
		if (outcome === "error") {
			queueMicrotask(() => fail("error"));
			return stream;
		}
		if (outcome === "tool-call") {
			queueMicrotask(() =>
				done(
					reply("toolUse", [
						{ type: "toolCall", id: "call-writer", name: "read", arguments: { path: "src/a.ts" } },
					]),
				),
			);
			return stream;
		}
		const at = request.indexOf("Attachments:\n");
		const attachments = (at < 0 ? {} : JSON.parse(request.slice(at + 13))) as { previousNote?: MemoryNote };
		const branch = this.session.getBranch();
		// A segment writes over its range; the synchronous writer restates the whole standing state.
		const records = range
			? branch.slice(
					branch.findIndex((entry) => entry.id === range[1]),
					branch.findIndex((entry) => entry.id === range[2]) + 1,
				)
			: branch;
		const note = writtenNote(records, range ? attachments.previousNote : undefined);
		// A quotation that is not in its source, so the note check refuses it.
		if (outcome === "refusal")
			note.state.push({ text: "Synthetic fabricated fact.", sources: [records[0].id], quote: "Never said here." });
		const body = JSON.stringify(note);
		const schedule = this.random() < 0.3 ? (finish: () => void) => setTimeout(finish, 8) : queueMicrotask;
		schedule(() =>
			done(
				reply(outcome === "length" ? "length" : "stop", [
					{ type: "text", text: outcome === "length" ? body.slice(0, body.length >> 1) : body },
				]),
			),
		);
		return stream;
	}

	fail(message: string): never {
		throw new Violation(
			`seed ${this.seed}: ${message}\nlast operations:\n${this.log.slice(-Number(process.env.CONTEXT_MEMORY_FUZZ_LOG ?? 24)).join("\n")}`,
		);
	}

	latestCheckpoint(branch: readonly SessionEntry[] = this.session.getBranch()): CompactionEntry<Details> | undefined {
		return branch.findLast((entry): entry is CompactionEntry<Details> => entry.type === "compaction");
	}

	/** Pi's request path: the guard either lets the request go or aborts the turn. */
	request(): boolean {
		const abort = this.ctx.abort as ReturnType<typeof vi.fn>;
		abort.mockClear();
		const summary = this.latestCheckpoint()?.summary;
		this.controller.beforeRequest({ messages: summary === undefined ? [] : [{ content: summary }] }, this.ctx);
		const refused = abort.mock.calls.length > 0;
		// A failed compaction blocks the next request by design, until a checkpoint commits.
		if (this.blocked && !refused) this.fail("a request went out while the session was blocked");
		if (refused && !this.blocked) {
			const state = new PreviewFailureStore(this.agentDir).inspect(this.session);
			if (!(state.state !== "ready" && state.code === "CONTEXT_PAYLOAD_TOO_LARGE"))
				this.fail(`a request was refused with ${JSON.stringify(state)}`);
		}
		if (refused) this.blocked = true;
		return !refused;
	}

	userText(kind: string): string {
		const n = ++this.turns;
		switch (kind) {
			case "port":
				return `Use port ${4400 + n}.`;
			case "retries":
				return `Keep retries at ${n % 9}.`;
			case "both":
				return `Use port ${4400 + n}. Keep retries at ${n % 9}.`;
			case "file":
				return `Record src/synthetic-${n}.ts as touched.`;
			default:
				return `Continue the synthetic check, step ${n}.`;
		}
	}

	/** A user turn the agent completes; `tools` adds one answered tool call, `aborted` ends it without a reply. */
	turn(kind: string, long: boolean, shape: "plain" | "tools" | "aborted" = "plain"): void {
		const id = `${this.turns + 1}`;
		const add = (entryId: string, message: Extract<SessionEntry, { type: "message" }>["message"]) =>
			this.session.append({ type: "message", id: entryId, parentId: this.session.getLeafId(), timestamp, message });
		add(`u${id}`, { role: "user", content: `${this.userText(kind)}${long ? PADDING : ""}`, timestamp: 1 });
		if (shape === "tools") {
			add(
				`c${id}`,
				reply("toolUse", [{ type: "toolCall", id: `call-${id}`, name: "read", arguments: { path: "src/a.ts" } }]),
			);
			add(`t${id}`, {
				role: "toolResult",
				toolCallId: `call-${id}`,
				toolName: "read",
				content: [{ type: "text", text: "Synthetic file text." }],
				isError: false,
				timestamp: 1,
			});
		}
		add(
			`a${id}`,
			shape === "aborted"
				? reply("aborted", [])
				: reply("stop", [{ type: "text", text: `Synthetic step ${id} is done.` }]),
		);
	}

	/** Pi's agent_settled handler, then its own threshold check. */
	async settled(): Promise<void> {
		if (this.controller.makeRoom(this.ctx)) {
			await this.requested();
			return;
		}
		this.controller.prepare(this.ctx);
		this.controller.segment(this.ctx);
		if (this.random() < 0.6) await this.segments.waitForIdle();
		if (this.tokens() > TRIGGER) await this.compact("threshold");
	}

	/** The compaction the extension asked Pi for with ctx.compact(), which Pi runs as a manual one. */
	async requested(): Promise<void> {
		if (!this.compactRequested) return;
		this.compactRequested = false;
		await this.compact("manual", undefined, "makeRoom");
	}

	/** Pi's compaction: the extension's hook, then the commit or the failure event. */
	async compact(reason: "manual" | "threshold", focus?: string, origin = reason as string): Promise<void> {
		const before = this.session.getBranch();
		const base = this.latestCheckpoint(before);
		// Pi finds nothing to compact without messages after the latest checkpoint and runs no hook.
		if (!before.slice(base ? before.indexOf(base) + 1 : 0).some((entry) => entry.type === "message")) return;
		if (reason === "threshold" && !this.controller.thresholdReady(this.ctx)) return;
		const abort = new AbortController();
		this.compacting = abort;
		const event = {
			type: "session_before_compact",
			reason,
			willRetry: false,
			signal: abort.signal,
			customInstructions: focus,
			preparation: { tokensBefore: this.tokens() },
		} as SessionBeforeCompactEvent;
		let value: PreviewCompaction;
		try {
			value = await this.controller.compact(event, this.ctx);
		} catch (error) {
			this.compacting = undefined;
			this.log.push(
				`  ${reason} compaction failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
			);
			// The extension returns { cancel: true }; Pi reports a cancelled compaction.
			this.controller.compactionFailed(
				{ type: "session_compact_failed", reason, aborted: true, willRetry: false, fromExtension: false },
				this.ctx,
			);
			this.blocked = true;
			this.note("compaction failed");
			return;
		}
		this.compacting = undefined;
		// The links the boundary could merge, read before the commit starts a new interval; U8's wait may have added one.
		const chain = this.segments.chain.map((link) => link.snapshot);
		const entry: CompactionEntry<Details> = {
			type: "compaction",
			id: `checkpoint-${++this.checkpoints}`,
			parentId: this.session.getLeafId(),
			timestamp,
			...value,
			fromHook: true,
		};
		this.session.append(entry);
		this.controller.committed(
			{ type: "session_compact", compactionEntry: entry, fromExtension: true, reason, willRetry: false },
			this.ctx,
		);
		if (new PreviewFailureStore(this.agentDir).inspect(this.session).state !== "ready")
			this.fail("a returned checkpoint did not commit");
		this.blocked = false;
		const preparation = value.details?.preparation;
		this.note(`path ${preparation?.path ?? "sync"}`);
		this.note(`${origin} compaction`);
		if (preparation?.segmentsFallback) this.note(`fallback ${preparation.segmentsFallback}`);
		if (preparation?.segmentsFallback === "in-flight" && preparation.segmentsWaitMs === undefined)
			this.note("skipped segment wait");
		if (preparation?.path === "segments") {
			if (preparation.segmentsWaitMs !== undefined) this.note("merged after waiting for a segment");
			if (value.details?.note.instructions.some((item) => item.supersedes?.length))
				this.note("ruling replaced by merge");
		}
		this.checkCommit(before, entry, chain);
	}

	/** Coverage, a coverage that never moves back, the merged chain's contiguity and no duplicated fact. */
	checkCommit(
		before: readonly SessionEntry[],
		entry: CompactionEntry<Details>,
		chain: readonly { segmentId: string; firstId: string; lastId: string }[],
	): void {
		const details = entry.details;
		if (!details) this.fail(`${entry.id} has no details`);
		const at = (id: string) => before.findIndex((item) => item.id === id);
		const covered = at(details.coveredThrough);
		if (covered < 0) this.fail(`${entry.id} covers through an entry not on its branch`);
		if (entry.firstKeptEntryId === CONTEXT_KEEP_NONE) {
			if (covered !== before.length - 1)
				this.fail(`${entry.id} keeps nothing but covers only through ${details.coveredThrough}`);
		} else {
			const kept = at(entry.firstKeptEntryId);
			if (kept < 0 || kept > covered + 1)
				this.fail(`${entry.id} leaves a gap between its coverage and its first kept entry`);
		}
		const base = this.latestCheckpoint(before);
		const start = base ? at(String(base.details?.coveredThrough)) : -1;
		if (base && start < 0) this.fail(`the base of ${entry.id} covers through an entry not on its branch`);
		if (covered <= start) this.fail(`${entry.id} moves coverage back from ${String(base?.details?.coveredThrough)}`);
		const ids = details.preparation?.segmentIds;
		if (details.preparation?.path === "segments") {
			if (!ids?.length) this.fail(`${entry.id} merged segments without naming them`);
			let next = start + 1;
			for (const [index, segmentId] of ids.entries()) {
				const link = chain[index];
				if (link?.segmentId !== segmentId) this.fail(`${entry.id} merged a segment out of order`);
				if (at(link.firstId) !== next) this.fail(`${entry.id} merged a chain with a gap before ${link.firstId}`);
				next = at(link.lastId) + 1;
			}
			if (next - 1 !== covered) this.fail(`${entry.id}'s merged chain ends before its coverage`);
		}
		const seen = new Set<string>();
		for (const section of ["instructions", "failedPaths", "reasons", "state", "nextSteps", "files"] as const)
			for (const item of details.note[section] as NoteFact[]) {
				const key = JSON.stringify([item.text, [...item.sources].sort()]);
				if (seen.has(key)) this.fail(`${entry.id} repeats "${item.text}" from the same sources`);
				seen.add(key);
			}
	}

	/** The kept chain is contiguous on the current branch from the base checkpoint's coverage. */
	checkChain(): void {
		const branch = this.session.getBranch();
		const base = this.latestCheckpoint(branch);
		let next = base ? branch.findIndex((item) => item.id === base.details?.coveredThrough) + 1 : 0;
		for (const link of this.segments.chain) {
			if (branch.findIndex((item) => item.id === link.snapshot.firstId) !== next)
				this.fail(`the kept chain is not contiguous at ${link.snapshot.firstId}`);
			next = branch.findIndex((item) => item.id === link.snapshot.lastId) + 1;
			if (next === 0) this.fail(`a kept link ends at ${link.snapshot.lastId}, which is not on the branch`);
		}
	}

	/** Every writer request has a journal record of its purpose, and once nothing runs, a settlement. */
	checkJournal(settledNow: boolean): void {
		const directory = join(this.agentDir, "context-memory-preview", "calls");
		const lines = fs.existsSync(directory)
			? fs
					.readdirSync(directory)
					.flatMap((name) => fs.readFileSync(join(directory, name), "utf8").split("\n").filter(Boolean))
					.map(
						(line) =>
							JSON.parse(line) as { call: string; purpose?: string; outcome?: string; dispatched?: boolean },
					)
			: [];
		const started = lines.filter((line) => line.purpose);
		// A record is on disk before its request is sent, and a call stopped before sending settles as not dispatched.
		const unsent = new Set(lines.filter((line) => line.dispatched === false).map((line) => line.call));
		for (const kind of ["segment", "compaction"] as const) {
			const recorded = started.filter((line) => line.purpose === kind);
			const sent = recorded.filter((line) => !unsent.has(line.call)).length;
			if (this.requests[kind] > recorded.length || (settledNow && this.requests[kind] !== sent))
				this.fail(`${this.requests[kind]} ${kind} requests but ${recorded.length} journal records, ${sent} sent`);
		}
		if (settledNow) {
			const settled = new Set(lines.filter((line) => line.outcome).map((line) => line.call));
			const open = started.filter((line) => !settled.has(line.call));
			if (open.length) this.fail(`${open.length} journal records never settled`);
		}
		const calls = new Set(started.map((line) => line.call));
		for (const entry of this.session.entries)
			for (const id of entry.type === "compaction"
				? ((entry.details as Details | undefined)?.preparation?.callIds ?? [])
				: [])
				if (!calls.has(id)) this.fail(`${entry.id} names call ${id}, which the journal never recorded`);
		for (const link of this.segments.chain)
			for (const id of link.candidate.provenance.callIds)
				if (!calls.has(id)) this.fail(`a kept segment names call ${id}, which the journal never recorded`);
	}

	async operation(): Promise<void> {
		const roll = this.random();
		// A blocked user retries the prompt, sees the notice and runs /compact, sometimes after restarting Pi.
		const weights: [number, string][] = this.blocked
			? [
					[4, "turn"],
					[4, "compact"],
					[2, "restart"],
				]
			: [
					[22, "turn"],
					[16, "long"],
					[6, "tools"],
					[2, "aborted"],
					[6, "outcome"],
					[2, "failing"],
					[2, "compact"],
					// A restart matters most while segments are ready: U10 keeps them in memory only.
					[this.segments.chain.length ? 8 : 2, "restart"],
					[3, "branch"],
					[3, "model"],
					[4, "idle"],
				];
		const total = weights.reduce((sum, [weight]) => sum + weight, 0);
		let mark = roll * total;
		let name = "turn";
		for (const [weight, operation] of weights) {
			mark -= weight;
			if (mark < 0) {
				name = operation;
				break;
			}
		}
		const kind = this.pick(["plain", "plain", "port", "retries", "both", "file"]);
		this.log.push(
			`${this.log.length + 1} ${name}${name === "turn" || name === "long" ? ` ${kind}` : ""} at ${Math.round(this.tokens() / 1000)}k`,
		);
		switch (name) {
			case "turn":
			case "long":
			case "tools":
			case "aborted":
				if (!this.request()) return;
				this.turn(kind, name === "long", name === "tools" ? "tools" : name === "aborted" ? "aborted" : "plain");
				await this.settled();
				return;
			case "outcome":
				this.pending = this.pick(["refusal", "tool-call", "length", "error", "hang"] as const);
				this.log[this.log.length - 1] += ` ${this.pending}`;
				return;
			case "failing":
				this.failing = { outcome: this.pick(["refusal", "tool-call", "length", "error"] as const), left: 3 };
				this.log[this.log.length - 1] += ` ${this.failing.outcome}`;
				return;
			case "compact": {
				// /compact in the middle of a chain, sometimes with a focus, which leaves the boundary to the writer.
				const focus = this.random() < 0.2 ? "Focus on the ports." : undefined;
				await this.compact("manual", focus);
				return;
			}
			case "restart":
				if (this.segments.chain.length) this.note("restart dropped ready segments");
				this.controller.shutdownPreparation();
				await this.segments.waitForIdle();
				this.start();
				return;
			case "branch": {
				// Tree navigation to an earlier settled reply, before or after the latest checkpoint.
				const replies = this.session
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.stopReason === "stop",
					)
					.slice(0, -1);
				if (!replies.length) return;
				const target = this.pick(replies);
				this.log[this.log.length - 1] += ` to ${target.id}`;
				const base = this.latestCheckpoint();
				if (base && this.session.getBranch().indexOf(base) > this.session.getBranch().indexOf(target))
					this.note("branch moved before a checkpoint");
				this.controller.invalidatePreparation("branch-switch");
				this.session.leafId = target.id;
				this.controller.branchChanged(this.ctx);
				await this.requested();
				return;
			}
			case "model": {
				const next = this.models.find((item) => item !== this.ctx.model) ?? this.models[0];
				(this.ctx as { model: Model<Api> }).model = next;
				this.controller.invalidatePreparation("model-change");
				return;
			}
			default:
				await this.segments.waitForIdle();
		}
	}

	async run(): Promise<Map<string, number>> {
		try {
			for (let index = 0; index < OPERATIONS; index++) {
				await this.operation();
				if (this.segments.status().state === "paused") this.note("breaker open");
				this.checkChain();
				this.checkJournal(this.segments.status().state !== "preparing");
			}
			// Recovery is always possible: an explicit /compact with a working writer commits and unblocks.
			this.pending = undefined;
			await this.segments.waitForIdle();
			this.log.push("final compact");
			await this.compact("manual");
			if (this.blocked) this.fail("the final /compact did not unblock the session");
			this.controller.shutdownPreparation();
			await this.segments.waitForIdle();
			this.checkChain();
			this.checkJournal(true);
			return this.reached;
		} finally {
			this.controller.shutdownPreparation();
			await this.segments.waitForIdle();
			fs.rmSync(this.root, { recursive: true, force: true });
		}
	}
}

describe("segments lifecycle fuzz (0.8.0 WP4)", () => {
	const seeds = ONLY ? [Number(ONLY)] : Array.from({ length: SEEDS }, (_, index) => index + 1);
	const reached = new Map<string, number>();
	afterAll(() => {
		const summary = { seeds: seeds.length, operations: OPERATIONS, reached: Object.fromEntries([...reached].sort()) };
		if (REPORT) fs.writeFileSync(REPORT, `${JSON.stringify(summary, null, 2)}\n`);
		else console.info("lifecycle fuzz", summary);
	});

	it.each(seeds)("holds every invariant for seed %i", async (seed) => {
		for (const [event, count] of await new Harness(seed).run()) reached.set(event, (reached.get(event) ?? 0) + count);
	});

	// A run that never reached a path proves nothing about it.
	it.skipIf(ONLY !== undefined || SEEDS < 40)("reaches every path the invariants are meant to cover", () => {
		for (const event of [
			"path segments",
			"path sync",
			"compaction failed",
			"ruling replaced by merge",
			"merged after waiting for a segment",
			"skipped segment wait",
			"fallback custom-focus",
			"fallback tail",
			"hang:segment",
			"hang:compaction",
			"breaker open",
			"branch moved before a checkpoint",
			"restart dropped ready segments",
		])
			expect(reached.get(event) ?? 0, event).toBeGreaterThan(0);
	});
});
