import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { CommandRuntime } from "@deepseek-ai/dsh-commands";
import { CompactionId, ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import {
	createSystemMessage,
	createUserMessage,
	type GenerateOptions,
	LlmAdapter,
	LlmRuntime,
	ReasoningEffortId,
	type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { type Session, type SessionEvent, SessionId, SessionLogOffset, SessionStore } from "@deepseek-ai/dsh-session";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import { afterEach, describe, expect, it } from "vitest";
import { validateMemoryCheckpoints } from "../../compaction-core/src/notes.ts";
import { TOOL_CALL_DECLINED } from "../../compaction-core/src/writer.ts";
import { dshAttempts, dshCompactionRecords } from "../src/codec.ts";
import * as Slice from "../src/compaction.ts";
import { readDshHistory } from "../src/history.ts";

const signal = () => new AbortController().signal;
const id = SessionId("synthetic-writing");
const roots: string[] = [];
const contexts: Context[] = [];
afterEach(async () => {
	for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const note = (source: string, text = "Synthetic fact: port 4317.") => ({
	instructions: [],
	failedPaths: [],
	reasons: [],
	state: [{ text, sources: [source] }],
	nextSteps: [],
	files: [],
	gaps: [],
});
const user = (text: string) => createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });

async function setup(options: { root?: string; resume?: boolean; seed?: SessionEvent[]; seeded?: boolean } = {}) {
	const root = options.root ?? (await mkdtemp(join(tmpdir(), "slice-writing-")));
	if (!options.root) roots.push(root);
	const ctx = new Context();
	contexts.push(ctx);
	await ctx.plugin(SessionStore).await();
	await ctx.plugin(Jsonl, { root, compression: "none" }).await();
	await ctx.plugin(CommandRuntime).await();
	await ctx.plugin(LlmRuntime).await();
	await ctx.plugin(SessionProjectionRegistry).await();
	await ctx.plugin(TokenMeter).await();
	let session: Session;
	if (options.resume) {
		const handle = await ctx.sessionPersistence.open(id, "write");
		const cold = await handle.read();
		session = ctx.sessions.create(id, {
			seed: [...cold.events],
			meta: structuredClone(handle.header),
			inheritedEventCount: handle.inheritedEventCount,
		});
		await handle.append(session.snapshotEvents().slice(cold.events.length));
	} else {
		session = ctx.sessions.create(id, {
			...(options.seed || options.seeded ? { seed: options.seed ?? [] } : {}),
			...(options.seeded ? { inheritedEventCount: SessionLogOffset(options.seed?.length ?? 0) } : {}),
			meta: { delegationDepth: 0, isSeeded: options.seeded ?? false },
		});
		const handle = await ctx.sessionPersistence.create(session.header, {
			inheritedEventCount: session.inheritedEventCount,
		});
		await handle.append(session.snapshotEvents());
	}
	const requests: GenerateOptions[] = [];
	const controls: { mode: "valid" | "invalid" | "refusal" | "tools"; onRequest?: () => void; noteText: string } = {
		mode: "valid",
		noteText: "Synthetic fact: port 4317.",
	};
	let original = session
		.snapshotEvents()
		.find((event) => event.type === "user/message" && event.data.source.kind === "user")?.seq;
	ctx.llm.registerAdapter(
		["synthetic"],
		new (class extends LlmAdapter {
			override async resolveModel(provider: string, model: string) {
				return {
					provider,
					id: model,
					name: model,
					context: { contextWindow: 200_000 },
					defaultMaxTokens: 32_000,
					reasoning: { efforts: [{ id: ReasoningEffortId("medium"), name: "medium" }] },
				};
			}
			override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
				requests.push(request);
				controls.onRequest?.();
				if (controls.mode === "tools" && requests.length === 1) {
					yield {
						type: "block-end",
						index: 0,
						block: { type: "tool-call", id: "synthetic-tool" as never, name: "never_run", arguments: "{}" },
					};
					yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } };
					yield { type: "finish", reason: { kind: "tool-calls" } };
					return;
				}
				const text =
					controls.mode === "invalid" ? "invalid JSON" : JSON.stringify(note(String(original), controls.noteText));
				yield { type: "text-delta", index: 0, text };
				yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } };
				yield controls.mode === "refusal"
					? {
							type: "finish",
							reason: { kind: "error", failure: { code: "SYNTHETIC_REFUSAL", message: "synthetic refusal" } },
						}
					: { type: "finish", reason: { kind: "stop" } };
			}
		})(),
	);
	if (!options.resume && !options.seed) {
		session.append("turn/start", { turn: 1 });
		session.append("step/start", { turn: 1, step: 1 });
		session.append("request/header", {
			reason: "initial",
			header: {
				config: {
					provider: "synthetic",
					model: "scripted",
					maxTokens: 32_000,
					reasoningEffort: ReasoningEffortId("medium"),
				},
				tools: [{ name: "never_run", description: "Synthetic tool", parameters: { type: "object" } }],
			},
		});
		session.append(
			"system/message",
			{ turn: 1, step: 1, message: createSystemMessage("Synthetic system.") },
			{ surfaceOp: "append" },
		);
		original = session.append("user/message", user("Synthetic original: port 4317."), { surfaceOp: "append" }).seq;
		session.append("step/end", { turn: 1, step: 1 });
		session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
	}
	await ctx.plugin(Slice).await();
	const engine = ctx.compaction as Slice.SliceCompactionEngine;
	const agent = {
		session,
		options: {},
		runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(signal()),
	};
	const gate = () =>
		ctx.waterfall(
			"agent/pre-step",
			{ agent: agent as unknown as Agent, messages: [], turn: 2, step: 1, signal: signal() },
			async () => ({ kind: "enter" as const, messages: [] }),
		);
	return {
		root,
		ctx,
		session,
		engine,
		agent,
		controls,
		requests,
		original: original!,
		gate,
		compact: (abort = signal()) => engine.compactNow(agent, abort),
	};
}

describe("DSH manual Slice transaction", () => {
	it("commits the quartet, validates JCS on readback, and retrieves a shadowed original", async () => {
		const h = await setup();
		const before = h.session.seq;
		const result = await h.compact();
		expect(result).toBeTruthy();
		expect(
			h.session
				.snapshotEvents()
				.slice(before)
				.map((event) => event.type),
		).toEqual(["compaction/start", "compaction/summary", "user/message", "compaction/end"]);
		const records = dshCompactionRecords(h.session.snapshotEvents());
		const latest = validateMemoryCheckpoints(records, undefined, "jcs")!;
		expect(latest.memory.note).toEqual(note(String(h.original)));
		expect(h.session.deriveMessages().at(-1)?.content).toEqual(result!.summary);
		const summary = h.session.snapshotEvents().find((event) => event.type === "compaction/summary")!;
		expect(summary.type === "compaction/summary" && summary.data.llmStreamCall).toBeUndefined();
		const page = await readDshHistory(
			h.ctx.sessions,
			h.ctx.sessionPersistence,
			h.session,
			{ operation: "read", entryId: String(h.original) },
			signal(),
		);
		expect(page.entries[0].text).toBe("Synthetic original: port 4317.");
		expect(await h.gate()).toMatchObject({ kind: "enter" });
		expect(h.requests[0].messages[0].role).toBe("system");
		expect(h.requests[0].tools?.[0].name).toBe("never_run");
		expect(h.requests[0].reasoningEffort).toBe("medium");
	});

	it.each(["invalid", "refusal"] as const)(
		"blocks after a %s writer result and clears only after a successful compact",
		async (mode) => {
			const h = await setup();
			h.controls.mode = mode;
			await expect(h.compact()).rejects.toMatchObject({ code: "summary" });
			expect(dshAttempts(h.session.snapshotEvents()).attempts.at(-1)?.end?.data.error).toMatch(/^CONTEXT_/);
			expect(await h.gate()).toMatchObject({ kind: "reject" });
			h.controls.mode = "valid";
			await h.compact();
			expect(await h.gate()).toMatchObject({ kind: "enter" });
		},
	);

	it("ends an aborted attempt and recovers through a later manual compact", async () => {
		const h = await setup();
		const abort = new AbortController();
		h.controls.onRequest = () => abort.abort();
		await expect(h.compact(abort.signal)).rejects.toMatchObject({ code: "cancelled" });
		expect(dshAttempts(h.session.snapshotEvents()).attempts.at(-1)?.end?.data.error).toBeTruthy();
		expect(await h.gate()).toMatchObject({ kind: "reject" });
		h.controls.onRequest = undefined;
		await h.compact();
		expect(await h.gate()).toMatchObject({ kind: "enter" });
	});

	it("declines tools without executing them and sums usage over both writer calls", async () => {
		const h = await setup();
		h.controls.mode = "tools";
		await h.compact();
		expect(h.requests[1].messages.at(-1)?.content).toEqual([{ type: "text", text: TOOL_CALL_DECLINED }]);
		const summary = h.session.snapshotEvents().find((event) => event.type === "compaction/summary");
		expect(summary?.type === "compaction/summary" && summary.data.usage).toMatchObject({
			inputTokens: 200,
			outputTokens: 20,
			cacheReadTokens: 100,
		});
	});

	it("refuses a changed surface span without adding a Slice replacement", async () => {
		const h = await setup();
		h.controls.onRequest = () => {
			h.session.append("compaction/prune", {
				shadowedRange: { start: h.original, end: h.original },
				shadowedSeqs: [h.original],
				shadowedTokenCount: h.ctx.tokenMeter.measure(h.session).nodes.find((node) => node.seq === h.original)!
					.heuristicTokens,
			});
			h.session.append("user/message", user("Synthetic mutation: port 1234."), {
				surfaceOp: { op: "replace", startSeq: h.original, endSeq: h.original },
				sourceEventSeqs: [h.original],
			});
		};
		await expect(h.compact()).rejects.toMatchObject({ code: "changed" });
		expect(h.session.snapshotEvents().filter((event) => event.type === "compaction/summary")).toHaveLength(0);
		expect(await h.gate()).toMatchObject({ kind: "reject" });
	});

	it("refuses a false initial flush before writing a start", async () => {
		const h = await setup();
		h.ctx.sessions.flush = async () => false;
		await expect(h.compact()).rejects.toMatchObject({ code: "persistence" });
		expect(dshAttempts(h.session.snapshotEvents()).attempts).toHaveLength(0);
	});

	it.each(["flush", "readback"] as const)(
		"keeps a post-commit %s failure in memory, with no second end; a cold process confirms it",
		async (kind) => {
			const h = await setup();
			const flush = h.ctx.sessions.flush.bind(h.ctx.sessions);
			h.ctx.sessions.flush = async (session) => {
				const ok = await flush(session);
				if (session.snapshotEvents().at(-1)?.type === "compaction/end") {
					if (kind === "flush") throw new Error("synthetic post-commit failure");
				}
				return ok;
			};
			const open = h.ctx.sessionPersistence.open.bind(h.ctx.sessionPersistence);
			if (kind === "readback")
				h.ctx.sessionPersistence.open = async (...args) => {
					if (h.session.snapshotEvents().at(-1)?.type === "compaction/end")
						throw new Error("synthetic readback failure");
					return open(...args);
				};
			await expect(h.compact()).rejects.toMatchObject({ code: "persistence" });
			expect(h.session.snapshotEvents().filter((event) => event.type === "compaction/end")).toHaveLength(1);
			h.ctx.sessions.flush = flush;
			h.ctx.sessionPersistence.open = open;
			expect(await h.gate()).toMatchObject({ kind: "reject" });
			await h.ctx.fiber.dispose();
			const cold = await setup({ root: h.root, resume: true });
			expect(await cold.gate()).toMatchObject({ kind: "enter" });
		},
	);

	it.each(["start", "replacement"] as const)(
		"cold reopens blocked after a stop at %s and a manual compact recovers it",
		async (stop) => {
			const h = await setup();
			await h.compact();
			const events = [...h.session.snapshotEvents()];
			const start = events.findIndex((event) => event.type === "compaction/start");
			const end = stop === "start" ? start + 1 : events.findIndex((event) => event.type === "compaction/end");
			const stopped = await setup({ seed: events.slice(0, end) });
			expect(await stopped.gate()).toMatchObject({ kind: "reject" });
			expect(
				dshCompactionRecords(stopped.session.snapshotEvents()).filter((record) => record.type === "compaction"),
			).toHaveLength(0);
			await stopped.compact();
			expect(await stopped.gate()).toMatchObject({ kind: "enter" });
		},
	);

	it("chains two checkpoints, keeps prior replacements opaque, and validates both after cold reopen", async () => {
		const h = await setup();
		await h.compact();
		const first = validateMemoryCheckpoints(dshCompactionRecords(h.session.snapshotEvents()), undefined, "jcs")!;
		h.session.append("user/message", user("Synthetic next task."), { surfaceOp: "append" });
		h.controls.noteText = "Synthetic second fact: port 4317.";
		await h.compact();
		expect(h.requests[1].messages.at(-1)?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: expect.stringContaining(first.memory.note.state[0].text) }),
			]),
		);
		const records = dshCompactionRecords(h.session.snapshotEvents());
		expect(records.filter((record) => record.type === "compaction")).toHaveLength(2);
		expect(h.session.deriveMessages().filter((message) => message.role === "user")).toHaveLength(1);
		await h.ctx.fiber.dispose();
		const cold = await setup({ root: h.root, resume: true });
		expect(await cold.gate()).toMatchObject({ kind: "enter" });
		expect(
			validateMemoryCheckpoints(dshCompactionRecords(cold.session.snapshotEvents()), undefined, "jcs")?.memory.note
				.state[0].text,
		).toBe(h.controls.noteText);
	});

	it("detects same-ID source changes on cold read and refuses another compaction", async () => {
		const h = await setup();
		await h.compact();
		const events = structuredClone(h.session.snapshotEvents()) as SessionEvent[];
		const original = events[h.original];
		if (original.type === "user/message") original.data = user("Changed source under the same seq.");
		const cold = await setup({ seed: events });
		expect(await cold.engine.state(cold.session)).toMatchObject({
			blocked: true,
			code: "CONTEXT_SOURCE_CHANGED",
		});
		const before = cold.session.seq;
		await expect(cold.compact()).rejects.toBeInstanceOf(ManualCompactionError);
		expect(cold.session.seq).toBe(before);
	});

	it.each(["seeded", "foreign"] as const)(
		"does not let a %s refusal bypass the first-step checkpoint check",
		async (kind) => {
			const h = await setup();
			await h.compact();
			const events = structuredClone(h.session.snapshotEvents()) as SessionEvent[];
			const original = events[h.original];
			if (original.type === "user/message") original.data = user("Changed source under the same seq.");
			const cold = await setup({ seed: events, seeded: kind === "seeded" });
			if (kind === "foreign") {
				const compactionId = CompactionId("basic-foreign");
				cold.session.append("compaction/start", { compactionId, turn: null });
				cold.session.append("compaction/end", { compactionId, turn: null, error: "synthetic failure" });
			}
			const before = cold.session.seq;
			await expect(cold.compact()).rejects.toBeInstanceOf(ManualCompactionError);
			expect(cold.session.seq).toBe(before);
			expect(await cold.gate()).toMatchObject({ kind: "reject" });
			expect(await cold.engine.state(cold.session)).toMatchObject({ code: "CONTEXT_SOURCE_CHANGED" });
		},
	);

	it("refuses seeded sessions, foreign attempts and compactRegion without writing", async () => {
		const seeded = await setup({ seeded: true });
		const before = seeded.session.seq;
		await expect(seeded.compact()).rejects.toBeInstanceOf(ManualCompactionError);
		expect(seeded.session.seq).toBe(before);
		const h = await setup();
		const compactionId = CompactionId("basic-synthetic");
		h.session.append("compaction/start", { compactionId, turn: null });
		h.session.append("compaction/end", { compactionId, turn: null, error: "synthetic failure" });
		const count = h.session.seq;
		await expect(h.compact()).rejects.toBeInstanceOf(ManualCompactionError);
		await expect(h.ctx.compaction.compactRegion(h.original, h.original, h.agent, signal())).rejects.toBeInstanceOf(
			ManualCompactionError,
		);
		expect(h.session.seq).toBe(count);
		expect(await h.ctx.compaction.compactIfNeeded(h.agent, "pressure", signal())).toBeNull();
	});

	it("runs the gate after next and preserves a rejection from another listener", async () => {
		const h = await setup();
		let nextFinished = false;
		h.ctx.on("agent/pre-step", async (_payload, next) => {
			const decision = await next();
			nextFinished = true;
			return decision;
		});
		h.controls.mode = "invalid";
		await expect(h.compact()).rejects.toBeInstanceOf(ManualCompactionError);
		expect(await h.gate()).toMatchObject({ kind: "reject" });
		expect(nextFinished).toBe(true);
		h.controls.mode = "valid";
		await h.compact();
		h.ctx.on("agent/pre-step", async () => ({ kind: "reject" }));
		expect(await h.gate()).toMatchObject({ kind: "reject" });
		expect(() => Slice.apply(h.ctx)).toThrow("CONTEXT_COMPACTOR_CONFLICT");
	});

	it("does not keep a block from a first step that was cancelled", async () => {
		const h = await setup();
		const abort = new AbortController();
		abort.abort();
		await h.ctx
			.waterfall(
				"agent/pre-step",
				{ agent: h.agent as unknown as Agent, messages: [], turn: 1, step: 1, signal: abort.signal },
				async () => ({ kind: "enter" as const, messages: [] }),
			)
			.catch(() => undefined);
		expect(await h.gate()).toMatchObject({ kind: "enter" });
	});
});
