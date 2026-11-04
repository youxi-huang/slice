// The writer contract split from the preview writer (v0.7.0 WP2 step 5), driven through a scripted
// transport: the core's sequencing runs here with no host at all. The preview's writer tests keep
// running against the Pi transport untouched; this file imports nothing from Pi.
import { describe, expect, it } from "vitest";
import { textTokens } from "../src/config.ts";
import { type MemoryNote, sourceText } from "../src/notes.ts";
import type { SessionRecord } from "../src/records.ts";
import { withinSegmentRange, withoutOutOfScope } from "../src/scope-diagnostics.ts";
import {
	quotableOriginals,
	sessionHandoverTokens,
	sumMemoryUsage,
	TOOL_CALL_DECLINED,
	type WriteMemoryOptions,
	type WriterProgress,
	type WriterRequest,
	type WriterResponse,
	type WriterTransport,
	type WriterUsage,
	writeMemory,
	writerContractHashes,
} from "../src/writer.ts";

const usage = (n: number): WriterUsage => ({
	input: n,
	output: n,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 1,
	totalTokens: 2 * n,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: n / 100 },
});

const user = (id: string, text: string): SessionRecord => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", content: text },
});

const branch = [user("u1", "Keep the service on port 4317. Never touch prod."), user("u2", "Use blue-green.")];

const note = (patch: Partial<MemoryNote> = {}): MemoryNote => ({
	instructions: [],
	failedPaths: [],
	reasons: [],
	state: [{ text: "Service on port 4317.", sources: ["u1"] }],
	nextSteps: [],
	files: [],
	gaps: [],
	...patch,
});

type Scripted = WriterResponse;
const answer = (value: unknown): Scripted => ({
	stopReason: "stop",
	content: [{ type: "text", text: JSON.stringify(value) }],
	usage: usage(10),
});
const toolCall = (): Scripted => ({ stopReason: "toolUse", content: [{ type: "toolCall" }], usage: usage(5) });

interface Sent {
	request: WriterRequest;
	declined: number;
}

function scripted(
	responses: Scripted[],
	facts: Partial<
		Pick<WriterTransport<Sent, Scripted>, "role" | "prefixTokens" | "effort" | "contextWindow" | "maxOutputTokens">
	> = {},
) {
	const sent: Sent[] = [];
	let opened = 0;
	const open = (): WriterTransport<Sent, Scripted> => {
		opened++;
		return {
			model: "test/writer",
			effort: facts.effort ?? "medium",
			role: facts.role ?? "fixed",
			contextWindow: facts.contextWindow ?? 128_000,
			maxOutputTokens: facts.maxOutputTokens ?? 8192,
			...(facts.prefixTokens ? { prefixTokens: facts.prefixTokens } : {}),
			request: (request) => ({ request, declined: 0 }),
			declineToolCalls: (request) => ({ ...request, declined: request.declined + 1 }),
			dispatch: (request, onSent) => {
				sent.push(request);
				onSent({ effort: request.request.reasoning });
				const response = responses.shift();
				if (!response) throw new Error("unscripted request");
				return { result: async () => response };
			},
			summarizeUsage: (value) => ({ ...value, cost: value.cost.total }),
		};
	};
	return { sent, open, opened: () => opened };
}

function options(patch: Partial<WriteMemoryOptions> = {}, progress: WriterProgress[] = []): WriteMemoryOptions {
	return {
		config: { noteRepair: true },
		increments: [],
		uncovered: branch,
		branch,
		noteTokens: 2000,
		signal: new AbortController().signal,
		onProgress: (value) => progress.push(value),
		...patch,
	};
}

describe("compaction core: writer contract", () => {
	it("binds candidates to the rules and schema bytes", () => {
		// The values the preview computed before the split; a change to the rules or the schema moves them.
		expect(writerContractHashes("artifact-x")).toEqual({
			promptHash: "dc749658e611df1d2e9a8008c4496787474c03ca228c15ce225dd9baae125a25",
			schemaHash: "bd4e0782cc1cd6281075b47c93b4eb995b90c4aeaf931a903f60571d4fa2663b",
		});
	});

	it("checks the budgets before the transport is opened", async () => {
		const transport = scripted([]);
		await expect(writeMemory(options({ noteTokens: 100 }), transport.open)).rejects.toThrow(/^CONTEXT_CONFIG/);
		expect(transport.opened()).toBe(0);
	});

	it("sends one chunk request at the transport's effort and accounts its usage", async () => {
		const transport = scripted([answer(note())]);
		const progress: WriterProgress[] = [];
		const result = await writeMemory(options({}, progress), transport.open);
		expect(transport.sent.map(({ request }) => [request.kind, request.reasoning])).toEqual([["chunk", "medium"]]);
		expect(result).toMatchObject({ chunkCount: 1, writerModel: "test/writer", writerEffort: "medium" });
		expect(result.usage.totalTokens).toBe(20);
		expect(progress.at(-1)?.writerCallDetails).toEqual([
			{
				phase: "generate",
				effort: "medium",
				sent: { effort: "medium" },
				stopReason: "stop",
				usage: expect.any(Object),
				ms: expect.any(Number),
				noteBytes: expect.any(Number),
			},
		]);
	});

	it("declines one session tool call without spending the repair, and refuses a second", async () => {
		const once = scripted([toolCall(), answer(note())], { role: "session", prefixTokens: () => 100 });
		const progress: WriterProgress[] = [];
		await writeMemory(options({}, progress), once.open);
		expect(once.sent.map(({ request, declined }) => [request.kind, declined])).toEqual([
			["handover", 0],
			["handover", 1],
		]);
		expect(progress.at(-1)).toMatchObject({ toolCallDeclined: true, toolCallResponses: 1, repairUsed: false });
		expect(TOOL_CALL_DECLINED).toMatch(/^Not run:/);

		const twice = scripted([toolCall(), toolCall()], { role: "session", prefixTokens: () => 100 });
		await expect(writeMemory(options(), twice.open)).rejects.toThrow("CONTEXT_WRITER_FAILED: toolUse");
	});

	it("keeps a handover that fits, including exactly at its minimum headroom", async () => {
		const opts = options();
		const needed = sessionHandoverTokens({ ...opts, maxOutputTokens: 8192 });
		const transport = scripted([answer(note())], { role: "session", prefixTokens: () => 128_000 - needed });
		const result = await writeMemory(opts, transport.open);
		expect(transport.sent.map(({ request }) => request.kind)).toEqual(["handover"]);
		expect(result.chunkCount).toBe(1);
	});

	it("uses the same session writer for bounded, lossless evidence chunks only when the handover cannot fit", async () => {
		const sources = [user("new-1", "Synthetic evidence. ".repeat(16_000)), user("new-2", "界🙂 ".repeat(12_000))];
		const opts = options({ previous: note(), branch: [...branch, ...sources], uncovered: sources, noteTokens: 5000 });
		const transport = scripted(
			Array.from({ length: 40 }, () => answer(note())),
			{
				role: "session",
				prefixTokens: () => 232_353,
				contextWindow: 240_000,
				maxOutputTokens: 32_000,
			},
		);
		const reserved: string[] = [];
		const settled: string[] = [];
		opts.callHooks = {
			beforeDispatch: (call) => {
				reserved.push(call.model);
				return `call-${reserved.length}`;
			},
			afterDispatch: (call) => {
				settled.push(call.callId);
			},
		};
		const result = await writeMemory(opts, transport.open);
		expect(transport.opened()).toBe(1);
		expect(result).toMatchObject({
			writerModel: "test/writer",
			writerEffort: "medium",
			chunkCount: transport.sent.length,
		});
		expect(transport.sent.length).toBeGreaterThan(1);
		expect(reserved).toEqual(Array(transport.sent.length).fill("test/writer"));
		expect(settled).toHaveLength(reserved.length);
		const recovered = new Map(sources.map((entry) => [entry.id, ""]));
		for (const { request } of transport.sent) {
			if (request.kind !== "chunk") throw new Error("Expected bounded evidence");
			expect(request.reasoning).toBe("medium");
			expect(request.maxTokens).toBe(10_000);
			expect(textTokens(request.systemPrompt) + textTokens(request.prompt) + request.maxTokens).toBeLessThanOrEqual(
				240_000,
			);
			const payload = JSON.parse(request.prompt) as {
				previousNote: MemoryNote;
				newSources: { entryId: string; offset: number; text: string }[];
			};
			expect(payload.previousNote).toEqual(note());
			for (const part of payload.newSources) {
				expect(part.offset).toBe(recovered.get(part.entryId)!.length);
				recovered.set(part.entryId, recovered.get(part.entryId)! + part.text);
			}
		}
		for (const source of sources) expect(recovered.get(source.id)).toBe(sourceText(source));
	});

	it("keeps segment capacity refusals and never changes path after a dispatched writer fails", async () => {
		const segment = scripted([], { role: "session", prefixTokens: () => 128_000 });
		await expect(writeMemory(options({ segment: { firstId: "u1", lastId: "u2" } }), segment.open)).rejects.toThrow(
			"CONTEXT_WRITER_CAPACITY",
		);
		expect(segment.sent).toHaveLength(0);
		const failing = scripted([{ ...answer(note()), stopReason: "error", errorMessage: "Synthetic refusal" }], {
			role: "session",
			prefixTokens: () => 128_000,
		});
		await expect(writeMemory(options(), failing.open)).rejects.toThrow("CONTEXT_WRITER_FAILED");
		expect(failing.opened()).toBe(1);
		expect(failing.sent.map(({ request }) => request.kind)).toEqual(["chunk"]);
	});

	it("needs the session prefix before any request", async () => {
		const transport = scripted([], { role: "session" });
		await expect(writeMemory(options(), transport.open)).rejects.toThrow(/^CONTEXT_WRITER_UNAVAILABLE/);
		expect(transport.sent).toEqual([]);
	});

	it("spends the one repair on quotations without reasoning, and only once", async () => {
		const misquoted = note({ instructions: [{ text: "No prod.", sources: ["u2"], quote: "Never touch prod." }] });
		const fixed = { text: "No prod.", sources: ["u1"], quote: "Never touch prod." };
		const transport = scripted([
			answer(misquoted),
			answer({ repairs: [{ section: "instructions", index: 0, fact: fixed }] }),
		]);
		const progress: WriterProgress[] = [];
		const result = await writeMemory(options({}, progress), transport.open);
		expect(transport.sent.map(({ request }) => [request.kind, request.reasoning])).toEqual([
			["chunk", "medium"],
			["repair", "off"],
		]);
		expect(result.note.instructions[0].sources).toEqual(["u1"]);
		expect(progress.at(-1)).toMatchObject({ repairUsed: true, repairKind: "quotation" });

		const off = scripted([answer(misquoted)]);
		await expect(writeMemory(options({ config: { noteRepair: false } }), off.open)).rejects.toThrow(
			/^CONTEXT_NOTE_QUOTE/,
		);
		expect(off.sent).toHaveLength(1);
	});

	it("spends the one repair on missing sources and validates the whole note again", async () => {
		const transport = scripted([
			answer(note({ nextSteps: [{ text: "Deploy blue-green." } as MemoryNote["nextSteps"][number]] })),
			answer({ repairs: [{ section: "nextSteps", index: 0, sources: ["u2"] }] }),
		]);
		const progress: WriterProgress[] = [];
		const result = await writeMemory(options({}, progress), transport.open);
		expect(result.note.nextSteps).toEqual([{ text: "Deploy blue-green.", sources: ["u2"] }]);
		expect(progress.at(-1)).toMatchObject({ repairKind: "sources", schema: { uncited: { nextSteps: 1 } } });
	});

	it("sums usage field by field, optional breakdowns included", () => {
		const total = sumMemoryUsage([usage(1), { ...usage(2), cacheWrite1h: 3 }]);
		expect(total).toMatchObject({ input: 3, totalTokens: 6, reasoning: 2, cacheWrite1h: 3 });
		expect(total.cost.total).toBeCloseTo(0.03);
	});

	it("lists quotable user messages whole, without the active requests", () => {
		expect(quotableOriginals(branch, [branch[1]], 1000)).toEqual([
			{ entryId: "u1", text: "Keep the service on port 4317. Never touch prod." },
		]);
	});
});

describe("compaction core: citations outside the branch", () => {
	// An entry with nothing to read, as a thinking-level change has.
	const level = {
		type: "thinking_level_change",
		id: "t1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		thinkingLevel: "high",
	} as unknown as SessionRecord;
	const scoped = [...branch, level];

	it("drops an ID one character off and one with nothing to read when every fact keeps a source", async () => {
		// GPT-6 Luna wrote 96c685d6 for 96a685d6 beside three valid citations, and each retry repeated it.
		const fact = { text: "Service on port 4317.", sources: ["u1", "u1x", "t1"], supersedes: ["u2"] };
		const transport = scripted([answer(note({ state: [fact] }))]);
		const progress: WriterProgress[] = [];
		const result = await writeMemory(options({ branch: scoped, uncovered: scoped }, progress), transport.open);
		expect(result.note.state).toEqual([{ text: "Service on port 4317.", sources: ["u1"], supersedes: ["u2"] }]);
		expect(transport.sent).toHaveLength(1);
		expect(progress.at(-1)).toMatchObject({
			scope: { missing: 1, unreadable: 1, inSupersedes: 0 },
			scopeDropped: 2,
			repairUsed: false,
		});
	});

	it("keeps the refusal when a fact would be left with no source", async () => {
		const transport = scripted([answer(note({ state: [{ text: "Service on port 4317.", sources: ["u1x"] }] }))]);
		const progress: WriterProgress[] = [];
		await expect(writeMemory(options({}, progress), transport.open)).rejects.toThrow("CONTEXT_NOTE_SCOPE");
		expect(transport.sent).toHaveLength(1);
		expect(progress.at(-1)?.scopeDropped).toBeUndefined();
	});

	it("adds nothing and leaves an out-of-scope supersedes to the refusal", () => {
		const value = note({ state: [{ text: "Service on port 4317.", sources: ["u1", "gone"] }] });
		expect(withoutOutOfScope(value, branch)).toEqual({ note: note(), dropped: 1 });
		expect(value.state[0].sources).toEqual(["u1", "gone"]);
		expect(withoutOutOfScope(note(), branch)).toBeUndefined();
		// Which entry a fact replaces is a claim of its own; an unknown one is not dropped.
		const superseding = note({
			state: [{ text: "Service on port 4317.", sources: ["u1", "gone"], supersedes: ["old"] }],
		});
		expect(withoutOutOfScope(superseding, branch)).toBeUndefined();
	});
});

describe("compaction core: segment requests (0.8.0 WP2, U4)", () => {
	it("closes the session's request with an instruction that names the range and cites only inside it", async () => {
		const transport = scripted([answer(note({ state: [{ text: "Use blue-green.", sources: ["u2"] }] }))], {
			role: "session",
			prefixTokens: () => 1000,
		});
		const previous = note();
		const result = await writeMemory(
			options({ previous, uncovered: [branch[1]], segment: { firstId: "u2", lastId: "u2" } }),
			transport.open,
		);
		expect(result.note.state).toEqual([{ text: "Use blue-green.", sources: ["u2"] }]);
		const [{ request }] = transport.sent;
		if (request.kind !== "handover") throw new Error("expected the session handover");
		expect(request.instruction).toContain("Write a segment note for entries u2 through u2 only");
		// The merge retires a carried instruction only for an instruction in its place (U6).
		expect(request.instruction).toContain("give the replacement in the same section");
		expect(request.instruction).not.toContain("Write the memory note that lets the next model continue");
		const manifest = request.instruction.slice(request.instruction.indexOf("Entry IDs for citations"));
		expect(manifest).toContain("u2 user");
		expect(manifest).not.toContain("u1 user");
		const attachments = JSON.parse(request.instruction.slice(request.instruction.indexOf("Attachments:\n") + 13));
		expect(attachments).toMatchObject({ previousNote: previous });
		expect(attachments.referencedEvidence).toBeUndefined();
	});

	it("keeps a segment to its range when the writer restates the previous note (found on WP5's provider runs)", async () => {
		// The writer rewrote the whole note: facts the previous note holds, cited to u1, beside what u2 adds.
		const restated = note({
			instructions: [{ text: "Never touch prod.", sources: ["u1"] }],
			reasons: [{ text: "Blue-green keeps the old version serving.", sources: ["u1", "u2"] }],
			state: [
				{ text: "Service on port 4317.", sources: ["u1"] },
				{ text: "Deploying with blue-green.", sources: ["u2"] },
			],
		});
		const transport = scripted([answer(restated)], { role: "session", prefixTokens: () => 1000 });
		const progress: WriterProgress[] = [];
		const result = await writeMemory(
			options({
				previous: note(),
				uncovered: [branch[1]],
				segment: { firstId: "u2", lastId: "u2" },
				onProgress: (value) => progress.push(value),
			}),
			transport.open,
		);
		// What only u1 supports is left to the previous note; a fact that also rests on u2 keeps u2 alone.
		expect(result.note.instructions).toEqual([]);
		expect(result.note.reasons).toEqual([{ text: "Blue-green keeps the old version serving.", sources: ["u2"] }]);
		expect(result.note.state).toEqual([{ text: "Deploying with blue-green.", sources: ["u2"] }]);
		expect(progress.at(-1)?.scopeDropped).toBe(3);
		expect(transport.sent).toHaveLength(1);
	});

	it("still refuses a segment that keeps no state of its own once limited to its range", async () => {
		const transport = scripted([answer(note())], { role: "session", prefixTokens: () => 1000 });
		await expect(
			writeMemory(
				options({ previous: note(), uncovered: [branch[1]], segment: { firstId: "u2", lastId: "u2" } }),
				transport.open,
			),
		).rejects.toThrow(/^CONTEXT_NOTE_SCOPE: a segment cites a record outside its range/);
	});

	it("drops a plan with a step that rests only on earlier entries, so the previous plan stands", () => {
		const range = new Set(["u2"]);
		const plan = note({
			state: [{ text: "Deploying with blue-green.", sources: ["u2"] }],
			nextSteps: [
				{ text: "Switch traffic.", sources: ["u2"] },
				{ text: "Keep prod untouched.", sources: ["u1"] },
			],
		});
		expect(withinSegmentRange(plan, range)?.note.nextSteps).toEqual([]);
		// supersedes may name earlier entries, and a note already inside its range is left as it is.
		const inside = note({
			state: [{ text: "Port 4318 now.", sources: ["u2"], supersedes: ["u1"] }],
			nextSteps: [{ text: "Switch traffic.", sources: ["u2"] }],
		});
		expect(withinSegmentRange(inside, range)).toBeUndefined();
	});

	it("refuses a segment for a fixed writer before any request", async () => {
		const transport = scripted([answer(note())]);
		await expect(
			writeMemory(options({ uncovered: [branch[1]], segment: { firstId: "u2", lastId: "u2" } }), transport.open),
		).rejects.toThrow(/^CONTEXT_WRITER_UNAVAILABLE/);
		expect(transport.sent).toHaveLength(0);
	});
});
