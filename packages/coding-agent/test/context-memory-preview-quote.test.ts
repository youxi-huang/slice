import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	diagnoseQuotes,
	normalizeQuote,
	quoteCounts,
	quoteFailureMessage,
	quoteFeedback,
} from "../../compaction-core/src/quote-diagnostics.ts";
import { applyQuoteRepair } from "../../compaction-core/src/quote-repair.ts";
import type { SessionRecord } from "../../compaction-core/src/records.ts";
import { diagnoseSchema, schemaCounts, schemaFailureMessage } from "../../compaction-core/src/schema-diagnostics.ts";
import { diagnoseScope } from "../../compaction-core/src/scope-diagnostics.ts";
import { applySourcesRepair, SOURCES_REPAIR_RULES } from "../../compaction-core/src/sources-repair.ts";
import { validateWorkNote } from "../../compaction-core/src/work-notes.ts";
import { sessionHandoverTokens } from "../../compaction-core/src/writer.ts";
import { DEFAULT_MEMORY_CONFIG, SESSION_WRITER, textTokens } from "../src/extensions/context-memory/config.ts";
import { type MemoryNote, type NoteFact, noteSchema, validateNote } from "../src/extensions/context-memory/notes.ts";
import {
	type PreviewWriterRegistry,
	quotableOriginals,
	type WriteMemoryOptions,
	type WriterProgress,
	writeMemory,
} from "../src/extensions/context-memory/preview/writer.ts";

const model: Model<Api> = {
	id: "quote-writer",
	name: "Synthetic quotation writer",
	provider: "preview-quote-test",
	api: "openai-completions",
	baseUrl: "https://writer.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 8192,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};

const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.00001, output: 0.00001, cacheRead: 0, cacheWrite: 0, total: 0.00002 },
};

function user(id: string, text: string, parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistant(id: string, text: string, parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: 1,
			usage,
		},
	};
}

const branch: SessionEntry[] = [
	user("u1", "Keep the service on port 4317.\nDo not touch vendor/."),
	assistant("a1", "Understood: \u201Cdeploy only on Thursday\u201D is my proposal.", "u1"),
	user("u2", "Use \u201Cdeploy only on Thursday\u201D as the ruling.", "a1"),
	user("u3", "The threshold is 15.", "u2"),
];

/** Pi's entries satisfy the core's structural record shapes; the union is widened, never converted (records.ts). */
const asRecords = (entries: readonly SessionEntry[]): readonly SessionRecord[] =>
	entries as unknown as readonly SessionRecord[];

function note(items: Partial<Record<"state" | "reasons" | "instructions", NoteFact[]>>): MemoryNote {
	return {
		instructions: items.instructions ?? [],
		failedPaths: [],
		reasons: items.reasons ?? [],
		state: items.state ?? [{ text: "The threshold is 15.", sources: ["u3"] }],
		nextSteps: [],
		files: [],
		gaps: [],
	};
}

describe("quotation diagnostics", () => {
	it("classifies text cited to the wrong entry, and lists where it is with roles", () => {
		const diagnosis = diagnoseQuotes(
			note({ instructions: [{ text: "Port rule.", sources: ["u3"], quote: "Keep the service on port 4317." }] }),
			asRecords(branch),
		);
		expect(diagnosis.unreadable).toBe(false);
		expect(diagnosis.failures).toEqual([
			{
				section: "instructions",
				index: 0,
				quote: "Keep the service on port 4317.",
				cited: ["u3"],
				kind: "elsewhere",
				foundIn: [{ entryId: "u1", role: "user" }],
			},
		]);
	});

	it("lists every entry with the exact text, assistant echoes included", () => {
		const diagnosis = diagnoseQuotes(
			note({ reasons: [{ text: "Thursday rule.", sources: ["u3"], quote: "\u201Cdeploy only on Thursday\u201D" }] }),
			asRecords(branch),
		);
		expect(diagnosis.failures[0].foundIn).toEqual([
			{ entryId: "a1", role: "assistant" },
			{ entryId: "u2", role: "user" },
		]);
	});

	it("classifies a spacing or punctuation difference as format", () => {
		const diagnosis = diagnoseQuotes(
			note({
				instructions: [
					{ text: "Vendor rule.", sources: ["u1"], quote: "Keep the service on port 4317. Do not touch vendor/." },
					{ text: "Thursday.", sources: ["u2"], quote: 'Use "deploy only on Thursday" as the ruling.' },
				],
			}),
			asRecords(branch),
		);
		expect(diagnosis.failures.map((failure) => [failure.kind, failure.foundIn])).toEqual([
			["format", [{ entryId: "u1", role: "user" }]],
			["format", [{ entryId: "u2", role: "user" }]],
		]);
	});

	it("classifies a paraphrase as absent and collects every failure instead of the first", () => {
		const diagnosis = diagnoseQuotes(
			note({
				state: [
					{ text: "Threshold.", sources: ["u3"], quote: "The threshold is 15." },
					{ text: "Threshold.", sources: ["u3"], quote: "The threshold was raised to 15." },
				],
				reasons: [{ text: "Port.", sources: ["u2"], quote: "Keep the service on port 4317." }],
			}),
			asRecords(branch),
		);
		expect(diagnosis.failures.map((failure) => `${failure.section}[${failure.index}]:${failure.kind}`)).toEqual([
			"reasons[0]:elsewhere",
			"state[1]:absent",
		]);
		expect(quoteCounts(diagnosis.failures)).toEqual({ failed: 2, elsewhere: 1, format: 0, absent: 1 });
	});

	it("reports unreadable sources or supersedes, which rule out a quotation repair", () => {
		expect(diagnoseQuotes(note({ state: [{ text: "x", sources: ["missing"] }] }), asRecords(branch)).unreadable).toBe(
			true,
		);
		expect(
			diagnoseQuotes(note({ state: [{ text: "x", sources: ["u3"], supersedes: ["missing"] }] }), asRecords(branch))
				.unreadable,
		).toBe(true);
		expect(diagnoseQuotes(note({}), asRecords(branch))).toEqual({ failures: [], unreadable: false });
	});

	it("caps the listed locations at five", () => {
		const many = Array.from({ length: 8 }, (_, index) => user(`m${index}`, "Repeated ruling text."));
		const diagnosis = diagnoseQuotes(
			note({ state: [{ text: "Repeated.", sources: ["u3"], quote: "Repeated ruling text." }] }),
			asRecords([...branch, ...many]),
		);
		expect(diagnosis.failures[0].foundIn.map((location) => location.entryId)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
	});

	it("normalizes only for classification", () => {
		expect(normalizeQuote(" a\u2019b \u201Cc\u201D \u2014 d\n\te ")).toBe('a\'b "c" - d e');
		expect(normalizeQuote("\uFF21\uFF22")).toBe("AB");
	});

	it("keeps quotation text out of messages and names locations in feedback", () => {
		const failures = diagnoseQuotes(
			note({
				reasons: [{ text: "Thursday.", sources: ["u3"], quote: "\u201Cdeploy only on Thursday\u201D" }],
				state: [{ text: "Threshold.", sources: ["u3"], quote: "secret paraphrase" }],
			}),
			asRecords(branch),
		).failures;
		const message = quoteFailureMessage(quoteCounts(failures));
		expect(message).toBe(
			"CONTEXT_NOTE_QUOTE: 2 quotations do not match the entries cited (1 found verbatim in other entries, 1 found in no entry). No checkpoint committed; original history retained.",
		);
		expect(message).not.toContain("Thursday");
		expect(quoteFailureMessage({ failed: 1, elsewhere: 0, format: 1, absent: 0 }, true)).toBe(
			"CONTEXT_NOTE_QUOTE: 1 quotation does not match the entries cited (1 matching only after spacing or punctuation changes) after one quotation repair. No checkpoint committed; original history retained.",
		);
		expect(quoteFeedback(failures).split("\n")).toEqual([
			"reasons[0].quote is not in u3; the exact text is in a1 (assistant), u2 (user). Cite that entry, or drop the quote. Text from an assistant or tool entry is not a user ruling.",
			"state[0].quote is in no readable entry; quote exact text from a cited entry or drop the quote.",
		]);
	});
});

function response(value: unknown): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
		stopReason: "stop",
		timestamp: 2,
		usage: structuredClone(usage),
	};
}

function stream(message: AssistantMessage) {
	const result = createAssistantMessageEventStream();
	if (message.stopReason === "aborted") result.push({ type: "error", reason: "aborted", error: message });
	else result.push({ type: "done", reason: "stop", message });
	result.end(message);
	return result;
}

/** Answers each writer call in order and records every request's text. */
function quoteHarness(answers: unknown[], changes: Partial<WriteMemoryOptions> = {}) {
	const prompts: string[] = [];
	const requests = vi.fn<PreviewWriterRegistry["streamSimple"]>((_model, context) => {
		prompts.push(
			[context.systemPrompt ?? "", ...context.messages.map((message) => JSON.stringify(message.content))].join("\n"),
		);
		const answer = answers.shift();
		if (answer === undefined) throw new Error("unexpected writer call");
		return stream(typeof answer === "function" ? answer() : response(answer));
	});
	const progress: WriterProgress[] = [];
	const options: WriteMemoryOptions = {
		config: { ...DEFAULT_MEMORY_CONFIG, writerModel: `${model.provider}/${model.id}`, writerEffort: "low" },
		registry: { find: () => model, hasConfiguredAuth: () => true, streamSimple: requests },
		increments: [],
		uncovered: branch,
		branch,
		noteTokens: 2000,
		signal: new AbortController().signal,
		onProgress: (value) => progress.push(value),
		...changes,
	};
	return { options, requests, prompts, progress };
}

describe("preview writer quotation failures", () => {
	it("refuses a misattributed quotation with counts in the message and in status progress", async () => {
		const test = quoteHarness(
			[note({ instructions: [{ text: "Port rule.", sources: ["u3"], quote: "Keep the service on port 4317." }] })],
			{ config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "preview-quote-test/quote-writer", noteRepair: false } },
		);
		await expect(writeMemory(test.options)).rejects.toThrow(
			"CONTEXT_NOTE_QUOTE: 1 quotation does not match the entries cited (1 found verbatim in other entries).",
		);
		expect(test.requests).toHaveBeenCalledTimes(1);
		expect(test.progress.at(-1)).toMatchObject({
			writerCalls: 1,
			repairUsed: false,
			quotations: { failed: 1, elsewhere: 1, format: 0, absent: 0 },
		});
	});

	it("leaves other validation failures unclassified", async () => {
		// With the repair on, a fact whose only source is unknown would go to the sources repair instead.
		const test = quoteHarness([note({ state: [{ text: "x", sources: ["missing"] }] })], {
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "preview-quote-test/quote-writer", noteRepair: false },
		});
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_NOTE_SCOPE");
		expect(test.progress.at(-1)?.quotations).toBeUndefined();
	});
});

const misattributed = (): MemoryNote =>
	note({
		instructions: [{ text: "Port rule.", sources: ["u3"], quote: "Keep the service on port 4317." }],
		state: [
			{ text: "The threshold is 15.", sources: ["u3"], quote: "The threshold is 15." },
			{ text: "Line one.\nLine two.", sources: ["u2"] },
		],
	});

function repairOf(fact: NoteFact | null, section = "instructions", index = 0) {
	return { repairs: [{ section, index, fact }] };
}

describe("preview writer quotation repair", () => {
	it("re-cites a quotation found in another entry with one request about that fact only", async () => {
		const test = quoteHarness([
			misattributed(),
			repairOf({ text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317." }),
		]);
		const result = await writeMemory(test.options);
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(result.note.instructions).toEqual([
			{ text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317." },
		]);
		// Untouched facts come back unchanged, folded onto one line like any committed note.
		expect(result.note.state).toEqual([
			{ text: "The threshold is 15.", sources: ["u3"], quote: "The threshold is 15." },
			{ text: "Line one. Line two.", sources: ["u2"] },
		]);
		expect(() => validateNote(result.note, branch, 2000)).not.toThrow();
		const repairPrompt = test.prompts[1];
		expect(repairPrompt).toContain("Correct the quotations of a memory candidate");
		expect(repairPrompt).toContain('\\"problem\\":\\"elsewhere\\"');
		expect(repairPrompt).toContain('\\"entryId\\":\\"u1\\",\\"role\\":\\"user\\"');
		// Only the failing fact is asked about.
		expect(repairPrompt).not.toContain("Line two");
		const last = test.progress.at(-1);
		expect(last).toMatchObject({
			writerCalls: 2,
			repairUsed: true,
			repairKind: "quotation",
			quotations: { failed: 1, elsewhere: 1, format: 0, absent: 0 },
			quotationRepair: { requoted: 1, unquoted: 0, dropped: 0 },
		});
		expect(last?.writerCallDetails.map((call) => call.phase)).toEqual(["generate", "repair"]);
	});

	it("copies a format-only difference exactly, or drops the quote, or withdraws the fact", async () => {
		const format = note({
			instructions: [
				{ text: "Vendor.", sources: ["u1"], quote: "Keep the service on port 4317. Do not touch vendor/." },
			],
		});
		const exact = quoteHarness([
			format,
			repairOf({ text: "Vendor.", sources: ["u1"], quote: "Keep the service on port 4317.\nDo not touch vendor/." }),
		]);
		expect((await writeMemory(exact.options)).note.instructions[0].quote).toBe(
			"Keep the service on port 4317.\nDo not touch vendor/.",
		);
		const absent = note({
			reasons: [{ text: "Threshold raised.", sources: ["u3"], quote: "The threshold was raised to 15." }],
		});
		const unquoted = quoteHarness([absent, repairOf({ text: "Threshold raised.", sources: ["u3"] }, "reasons")]);
		const kept = await writeMemory(unquoted.options);
		expect(kept.note.reasons).toEqual([{ text: "Threshold raised.", sources: ["u3"] }]);
		expect(unquoted.progress.at(-1)?.quotationRepair).toEqual({ requoted: 0, unquoted: 1, dropped: 0 });
		const withdrawn = quoteHarness([absent, repairOf(null, "reasons")]);
		const without = await writeMemory(withdrawn.options);
		expect(without.note.reasons).toEqual([]);
		expect(without.note.state).toEqual(absent.state);
		expect(withdrawn.progress.at(-1)?.quotationRepair).toEqual({
			requoted: 0,
			unquoted: 0,
			dropped: 1,
			droppedFrom: { reasons: 1 },
		});
	});

	it("blocks when the repaired note still fails, naming the repair in the message", async () => {
		const test = quoteHarness([
			misattributed(),
			repairOf({ text: "Port rule.", sources: ["u2"], quote: "Keep the service on port 4317." }),
		]);
		await expect(writeMemory(test.options)).rejects.toThrow(
			"CONTEXT_NOTE_QUOTE: 1 quotation does not match the entries cited (1 found verbatim in other entries) after one quotation repair.",
		);
		expect(test.requests).toHaveBeenCalledTimes(2);
	});

	it("refuses a repair that changes a fact's text or supersedes", async () => {
		const text = quoteHarness([
			misattributed(),
			repairOf({ text: "Port rule, reworded.", sources: ["u1"], quote: "Keep the service on port 4317." }),
		]);
		await expect(writeMemory(text.options)).rejects.toThrow("CONTEXT_NOTE_REPAIR_LOSS");
		const supersedes = quoteHarness([
			misattributed(),
			repairOf({ text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317.", supersedes: ["u2"] }),
		]);
		await expect(writeMemory(supersedes.options)).rejects.toThrow("CONTEXT_NOTE_REPAIR_LOSS");
	});

	it("refuses a repair that withdraws an instruction whose quotation a user message contains", async () => {
		// The port rule's quotation is in user entry u1. Withdrawing the rule would commit a note without it, so the
		// note blocks instead; re-citing or dropping the quote stays available.
		const test = quoteHarness([misattributed(), repairOf(null)]);
		await expect(writeMemory(test.options)).rejects.toThrow(
			"CONTEXT_NOTE_REPAIR_LOSS: a quotation repair may not withdraw an instruction whose quotation a user message contains",
		);
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(test.progress.at(-1)?.quotationRepair).toBeUndefined();
		// The same holds when the writer cited the assistant: the user's message still holds the ruling.
		const cited = note({
			instructions: [{ text: "Port rule.", sources: ["a1"], quote: "Keep the service on port 4317." }],
		});
		await expect(writeMemory(quoteHarness([cited, repairOf(null)]).options)).rejects.toThrow(
			"CONTEXT_NOTE_REPAIR_LOSS",
		);
		const kept = quoteHarness([misattributed(), repairOf({ text: "Port rule.", sources: ["u3"] })]);
		expect((await writeMemory(kept.options)).note.instructions).toEqual([{ text: "Port rule.", sources: ["u3"] }]);
	});

	it("withdraws an instruction no user message supports, and counts withdrawals by section", async () => {
		// The quoted proposal is only in the assistant's entry a1, so it is no user ruling; the threshold quotation
		// is in no entry. Both are the writer's to withdraw.
		const proposal = note({
			instructions: [
				{
					text: "Deploy only on Thursday.",
					sources: ["u2"],
					quote: "Understood: \u201Cdeploy only on Thursday\u201D is my proposal.",
				},
			],
			reasons: [{ text: "Threshold raised.", sources: ["u3"], quote: "The threshold was raised to 15." }],
		});
		expect(
			diagnoseQuotes(proposal, asRecords(branch)).failures.map((failure) => [failure.kind, failure.foundIn]),
		).toEqual([
			["elsewhere", [{ entryId: "a1", role: "assistant" }]],
			["absent", []],
		]);
		const test = quoteHarness([
			proposal,
			{ repairs: [...repairOf(null).repairs, ...repairOf(null, "reasons").repairs] },
		]);
		const result = await writeMemory(test.options);
		expect(result.note.instructions).toEqual([]);
		expect(result.note.reasons).toEqual([]);
		expect(test.progress.at(-1)?.quotationRepair).toEqual({
			requoted: 0,
			unquoted: 0,
			dropped: 2,
			droppedFrom: { instructions: 1, reasons: 1 },
		});
	});

	it("records each call's requested effort, the reasoning its payload carries and how it ended", async () => {
		// A repair cut off at the length limit returns no usable JSON; the record says so.
		const answers = [response(misattributed()), { ...response('{"repairs":[{"sect'), stopReason: "length" as const }];
		const reasoning = { ...model, reasoning: true };
		const tools: { choice?: unknown; count: number }[] = [];
		const test = quoteHarness([], {
			registry: {
				find: () => reasoning,
				hasConfiguredAuth: () => true,
				streamSimple: (_model, context, options) => {
					tools.push({ choice: options?.toolChoice, count: context.tools?.length ?? 0 });
					// What a DeepSeek-style adapter builds; the writer reads these fields and nothing else.
					void options?.onPayload?.(
						{
							model: "quote-writer",
							messages: [{ role: "user", content: "not recorded" }],
							thinking: { type: options?.reasoning ? "enabled" : "disabled" },
							...(options?.reasoning
								? { reasoning_effort: options.reasoning === "medium" ? "high" : options.reasoning }
								: {}),
							max_tokens: options.maxTokens,
						},
						reasoning,
					);
					return stream(answers.shift()!);
				},
			},
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "preview-quote-test/quote-writer", writerEffort: "medium" },
		});
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_WRITER_FAILED: length");
		const calls = test.progress.at(-1)?.writerCallDetails ?? [];
		expect(calls).toMatchObject([
			{ phase: "generate", effort: "medium", sent: { effort: "high", thinking: "enabled", maxTokens: 4096 } },
			// The repair runs without reasoning, whatever the writer's effort.
			{ phase: "repair", effort: "off", sent: { thinking: "disabled", maxTokens: 4096 } },
		]);
		expect(calls[1].sent).not.toHaveProperty("effort");
		expect(calls.map((call) => call.stopReason)).toEqual(["stop", "length"]);
		expect(JSON.stringify(calls)).not.toContain("not recorded");
		// Like the session writer, the repair sets no tool choice; it offers no tools to choose from.
		expect(tools[1]).toEqual({ choice: undefined, count: 0 });
	});

	it("reports the level a configuration_update item carries, not the fixed reasoning.effort beside it", async () => {
		// What Pi 1.3.0 builds for GPT-6 Luna: a fixed `reasoning.effort`, an item before each earlier assistant
		// message with that turn's level, and a last item with the level this request asks for.
		const reasoning = { ...model, reasoning: true };
		const payloads = [
			{
				reasoning: { effort: "medium" },
				max_output_tokens: 4096,
				input: [
					{ role: "user", content: "not recorded" },
					{ type: "configuration_update", reasoning: { effort: "low" } },
					{ role: "assistant", content: "not recorded" },
					{ type: "configuration_update", reasoning: { effort: "max" } },
				],
			},
			{ reasoning: { effort: "high" }, max_output_tokens: 4096, input: [{ role: "user", content: "not recorded" }] },
		];
		const sent = [];
		for (const payload of payloads) {
			const test = quoteHarness([], {
				registry: {
					find: () => reasoning,
					hasConfiguredAuth: () => true,
					streamSimple: (_model, _context, options) => {
						void options?.onPayload?.(payload, reasoning);
						return stream(response(note({})));
					},
				},
			});
			await writeMemory(test.options);
			expect(JSON.stringify(test.progress)).not.toContain("not recorded");
			sent.push(test.progress.at(-1)?.writerCallDetails[0].sent);
		}
		expect(sent).toEqual([
			{ effort: "max", fixedEffort: "medium", maxTokens: 4096 },
			{ effort: "high", maxTokens: 4096 },
		]);
	});

	it("requires one answer for each failing fact and nothing else", () => {
		const failures = diagnoseQuotes(misattributed(), asRecords(branch)).failures;
		const fact = { text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317." };
		expect(() => applyQuoteRepair(misattributed(), failures, { repairs: [] })).toThrow("CONTEXT_NOTE_INVALID");
		expect(() => applyQuoteRepair(misattributed(), failures, repairOf(fact, "state", 0))).toThrow(
			"CONTEXT_NOTE_INVALID",
		);
		expect(() =>
			applyQuoteRepair(misattributed(), failures, {
				repairs: [repairOf(fact).repairs[0], repairOf(fact).repairs[0]],
			}),
		).toThrow("CONTEXT_NOTE_INVALID");
		expect(() => applyQuoteRepair(misattributed(), failures, "not json")).toThrow("CONTEXT_NOTE_INVALID");
	});

	it("does not repair when a cited ID is unreadable, more than five quotations fail, or repair is off", async () => {
		const unreadable = note({
			instructions: [{ text: "Port rule.", sources: ["u3"], quote: "Keep the service on port 4317." }],
			state: [{ text: "x", sources: ["missing"] }],
		});
		const first = quoteHarness([unreadable]);
		await expect(writeMemory(first.options)).rejects.toThrow("CONTEXT_NOTE_QUOTE");
		expect(first.requests).toHaveBeenCalledTimes(1);
		const six = note({
			state: Array.from({ length: 6 }, (_, index) => ({
				text: `Fact ${index}.`,
				sources: ["u3"],
				quote: "Keep the service on port 4317.",
			})),
		});
		const many = quoteHarness([six]);
		await expect(writeMemory(many.options)).rejects.toThrow("6 quotations do not match");
		expect(many.requests).toHaveBeenCalledTimes(1);
		const off = quoteHarness([misattributed()], {
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "preview-quote-test/quote-writer", noteRepair: false },
		});
		await expect(writeMemory(off.options)).rejects.toThrow("CONTEXT_NOTE_QUOTE");
		expect(off.requests).toHaveBeenCalledTimes(1);
	});

	it("spends the compaction's one repair: a quotation-repaired note over the hard limit blocks", async () => {
		const large = misattributed();
		large.state.push({ text: "x".repeat(1600), sources: ["u3"] });
		const test = quoteHarness(
			[large, repairOf({ text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317." })],
			{ noteTokens: 500 },
		);
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_NOTE_BUDGET");
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(test.progress.at(-1)).toMatchObject({ repairKind: "quotation", repairUsed: true });
	});

	it("repairs once across fixed-writer chunks", async () => {
		const long = (id: string, parentId: string | null, words: string) =>
			user(id, `${words} ${"filler text for chunking. ".repeat(3200)}`, parentId);
		const chunked = [long("c1", null, "Keep the service on port 4317."), long("c2", "c1", "The threshold is 15.")];
		const bad = (quoteSource: string): MemoryNote => ({
			...note({ state: [{ text: "Port.", sources: [quoteSource], quote: "Keep the service on port 4317." }] }),
		});
		const test = quoteHarness(
			[
				bad("c2"),
				repairOf({ text: "Port.", sources: ["c1"], quote: "Keep the service on port 4317." }, "state"),
				bad("c2"),
			],
			{ uncovered: chunked, branch: chunked, noteTokens: 2000 },
		);
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_NOTE_QUOTE");
		expect(test.progress.at(-1)?.writerCallDetails.map((call) => call.phase)).toEqual([
			"generate",
			"repair",
			"generate",
		]);
	});

	it("keeps both paid calls when the repair is cancelled", async () => {
		const abort = new AbortController();
		const test = quoteHarness(
			[
				misattributed(),
				() => {
					abort.abort(new Error("Synthetic repair cancellation"));
					return { ...response(""), stopReason: "aborted" as const };
				},
			],
			{ signal: abort.signal },
		);
		await expect(writeMemory(test.options)).rejects.toThrow("Synthetic repair cancellation");
		expect(test.progress.at(-1)).toMatchObject({ writerCalls: 2, repairKind: "quotation" });
	});

	it("keeps the stored note shape: a repaired note is an ordinary schema-valid note", async () => {
		const test = quoteHarness([
			misattributed(),
			repairOf({ text: "Port rule.", sources: ["u1"], quote: "Keep the service on port 4317." }),
		]);
		const result = await writeMemory(test.options);
		expect(Object.keys(result.note).sort()).toEqual(Object.keys(noteSchema.properties).sort());
	});
});

describe("session writer quotable originals", () => {
	const active = user("u4", "Now finish the report.", "u3");
	it("keeps whole user messages beside their IDs, newest first within the bound, in conversation order", () => {
		expect(quotableOriginals(branch, undefined, 1000)).toEqual([
			{ entryId: "u1", text: "Keep the service on port 4317.\nDo not touch vendor/." },
			{ entryId: "u2", text: "Use \u201cdeploy only on Thursday\u201d as the ruling." },
			{ entryId: "u3", text: "The threshold is 15." },
		]);
		// u3 and u2 fit; u1 does not and is left out rather than cut.
		const [, second, third] = quotableOriginals(branch, undefined, 1000);
		const bound = textTokens(JSON.stringify(second)) + textTokens(JSON.stringify(third));
		expect(quotableOriginals(branch, undefined, bound).map((item) => item.entryId)).toEqual(["u2", "u3"]);
		expect(quotableOriginals([...branch, active], [active], 1000).map((item) => item.entryId)).toEqual([
			"u1",
			"u2",
			"u3",
		]);
	});

	const long = user("u5", `Long ruling. ${"Keep every report under out/. ".repeat(120)}`, "u3");
	const sessionBranch = [...branch, long];

	function sessionHarness(contextWindow: number) {
		const session = { ...model, contextWindow };
		const test = quoteHarness([note({})], {
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: SESSION_WRITER },
			sessionModel: session,
			prefix: { messages: [{ role: "user", content: "Earlier conversation.", timestamp: 1 }] },
			uncovered: sessionBranch,
			branch: sessionBranch,
		});
		const instructions: string[] = [];
		const streamSimple = test.options.registry.streamSimple;
		test.options.registry = {
			...test.options.registry,
			streamSimple: (selected, context, request) => {
				const last = context.messages.at(-1);
				if (last && typeof last.content === "string") instructions.push(last.content);
				return streamSimple(selected, context, request);
			},
		};
		return { ...test, instructions };
	}

	it("sends the block in the handover request and drops it before shrinking the manifest", async () => {
		const roomy = sessionHarness(128_000);
		await writeMemory(roomy.options);
		const full = roomy.instructions[0];
		expect(full).toContain("Quotable user messages, complete and verbatim");
		// The list serves quotation; it must not read as the whole task and demote the assistant's announced plan.
		expect(full).toContain(
			"work the assistant announced within the task stays a next step unless a user message withdrew it",
		);
		expect(full).toContain('{"entryId":"u3","text":"The threshold is 15."}');
		expect(full).toContain("The openings only locate entries; never copy a quotation from them.");
		const start = full.indexOf("Quotable user messages");
		const without = full.slice(0, start) + full.slice(full.indexOf("Entry IDs for citations"));
		// Room for the request without the block, not with it: 4096 output tokens plus the prefix message.
		expect(textTokens(full) - textTokens(without)).toBeGreaterThan(500);
		const tight = sessionHarness(4096 + textTokens(without) + 100);
		await writeMemory(tight.options);
		expect(tight.instructions[0]).not.toContain("Quotable user messages");
		expect(tight.instructions[0]).toContain("u1 user: Keep the service on port 4317. Do not touch vendor/.");
	});

	it("sizes the prefix by Pi's measured count, up to the line sessionHandoverTokens gives", async () => {
		// The prefix holds one short message: by estimate alone either request would fit.
		const handover = sessionHandoverTokens({
			maxOutputTokens: model.maxTokens,
			increments: [],
			uncovered: asRecords(sessionBranch),
			branch: asRecords(sessionBranch),
			noteTokens: 2000,
		});
		const fits = sessionHarness(128_000);
		fits.options.prefix = { ...fits.options.prefix!, measuredTokens: 128_000 - handover };
		await writeMemory(fits.options);
		expect(fits.instructions).toHaveLength(1);
		expect(fits.instructions[0]).not.toContain("Quotable user messages");
		const over = sessionHarness(128_000);
		over.options.prefix = { ...over.options.prefix!, measuredTokens: 128_000 - handover + 1 };
		const written = await writeMemory(over.options);
		expect(written.writerModel).toBe(`${fits.options.sessionModel!.provider}/${fits.options.sessionModel!.id}`);
		expect(over.requests).toHaveBeenCalledOnce();
		const evidence = JSON.parse(over.instructions[0]) as { newSources: { entryId: string; text: string }[] };
		expect(evidence.newSources.map((entry) => entry.entryId)).toEqual(sessionBranch.map((entry) => entry.id));
		expect(evidence.newSources.at(-1)?.text).toBe(
			long.type === "message" && long.message.role === "user" ? long.message.content : undefined,
		);
	});
});

describe("work-note quotation feedback", () => {
	it("names the field and where the quoted text actually is", () => {
		expect(() =>
			validateWorkNote(
				{ state: [{ text: "Port rule.", sources: ["u3"], quote: "Keep the service on port 4317." }] },
				asRecords(branch),
			),
		).toThrow(
			"CONTEXT_NOTE_QUOTE: a quoted source does not match the original text\nstate[0].quote is not in u3; the exact text is in u1 (user).",
		);
	});
});

describe("preview writer scope diagnostics", () => {
	const level: SessionEntry = {
		type: "thinking_level_change",
		id: "t1",
		parentId: "u3",
		timestamp: "2026-01-01T00:00:00.000Z",
		thinkingLevel: "high",
	};
	const scoped = [...branch, level];
	const outOfScope = note({
		instructions: [{ text: "Port rule.", sources: ["u1", "invented"] }],
		reasons: [{ text: "Threshold raised.", sources: ["t1"], supersedes: ["invented", "gone"] }],
	});

	it("counts invented IDs and unreadable entries by kind, never the IDs", () => {
		expect(diagnoseScope(outOfScope, asRecords(scoped))).toEqual({
			missing: 2,
			unreadable: 1,
			inSupersedes: 2,
			unreadableKinds: { thinking_level_change: 1 },
		});
		expect(diagnoseScope(note({}), asRecords(scoped))).toEqual({
			missing: 0,
			unreadable: 0,
			inSupersedes: 0,
			unreadableKinds: {},
		});
	});

	it("reports the first scope refusal's counts in status progress, and the refusal is unchanged", async () => {
		const test = quoteHarness([outOfScope], { branch: scoped, uncovered: scoped });
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_NOTE_SCOPE: a note cites unavailable evidence");
		expect(test.requests).toHaveBeenCalledTimes(1);
		const last = test.progress.at(-1);
		expect(last?.scope).toEqual({
			missing: 2,
			unreadable: 1,
			inSupersedes: 2,
			unreadableKinds: { thinking_level_change: 1 },
		});
		expect(last?.repairUsed).toBe(false);
		expect(JSON.stringify(last)).not.toContain("invented");
	});
});

/** A note whose next steps are listed with text alone, as GPT-6 Luna returned them in the 0.5.3 bench. */
function uncited(steps: Record<string, unknown>[] = [{ text: "Report the threshold." }]): Record<string, unknown> {
	return { ...note({}), nextSteps: steps };
}

function sourcesOf(sources: string[], section = "nextSteps", index = 0) {
	return { section, index, sources };
}

describe("schema diagnostics", () => {
	it("counts facts without sources by section, absent or empty, and leaves the answer as it was", () => {
		const value = {
			...uncited([{ text: "Report the threshold." }, { text: "Check the port.", sources: [] }]),
			files: [{ text: "out/report.md", quote: "The threshold is 15." }],
		};
		const before = structuredClone(value);
		const diagnosis = diagnoseSchema(value);
		expect(diagnosis.uncited).toEqual([
			{ section: "nextSteps", index: 0 },
			{ section: "nextSteps", index: 1 },
			{ section: "files", index: 0 },
		]);
		expect(diagnosis.other).toBe(false);
		// The pending note holds empty sources where they were missing, never the placeholder.
		expect(diagnosis.pending?.nextSteps).toEqual([
			{ text: "Report the threshold.", sources: [] },
			{ text: "Check the port.", sources: [] },
		]);
		expect(diagnosis.pending?.files).toEqual([{ text: "out/report.md", quote: "The threshold is 15.", sources: [] }]);
		expect(value).toEqual(before);
		expect(schemaCounts(diagnosis)).toEqual({ uncited: { nextSteps: 2, files: 1 }, other: false });
	});

	it("marks any other fault, and then holds no pending note", () => {
		const cases: unknown[] = [
			{ ...uncited(), gaps: undefined },
			{ ...uncited(), extra: [] },
			uncited([{ text: "Report the threshold.", sources: null }]),
			uncited([{ text: "", sources: ["u3"] }]),
			uncited([{ text: "Report the threshold.", source: ["u3"] }]),
			uncited(Array.from({ length: 6 }, () => ({ text: "Report the threshold." }))),
			{ ...note({}), state: [] },
			"not a note",
			[note({})],
		];
		for (const value of cases) {
			const diagnosis = diagnoseSchema(value);
			expect(diagnosis.other).toBe(true);
			expect(diagnosis.pending).toBeUndefined();
		}
		expect(schemaCounts(diagnoseSchema(uncited([{ text: "Step.", sources: null }])))).toEqual({
			uncited: {},
			other: true,
		});
	});

	it("names counts and sections in the message, never the facts' text", () => {
		const message = schemaFailureMessage(schemaCounts(diagnoseSchema(uncited())));
		expect(message).toBe(
			"CONTEXT_NOTE_INVALID: 1 fact has no sources (1 in nextSteps). No checkpoint committed; original history retained.",
		);
		expect(message).not.toContain("Report the threshold");
		expect(schemaFailureMessage({ uncited: { nextSteps: 2, state: 1 }, other: true })).toBe(
			"CONTEXT_NOTE_INVALID: 3 facts have no sources (2 in nextSteps, 1 in state), and the note fails the schema otherwise too. No checkpoint committed; original history retained.",
		);
		expect(schemaFailureMessage({ uncited: {}, other: true })).toBe(
			"CONTEXT_NOTE_INVALID: writer must return the complete note schema. No checkpoint committed; original history retained.",
		);
	});
});

describe("preview writer sources repair", () => {
	it("asks for the sources of a fact whose only citation joins two IDs, and never sends that citation back", async () => {
		// GPT-6 Luna cited 1598f6dcb for 1598fbb5, borrowing the tail of 011f6dcb, and seven attempts of eight failed.
		const joined = { text: "The port rule.", sources: ["u1a1"], quote: "Keep the service on port 4317." };
		const test = quoteHarness([note({ instructions: [joined] }), { repairs: [sourcesOf(["u1"], "instructions")] }]);
		const result = await writeMemory(test.options);
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(result.note.instructions).toEqual([{ ...joined, sources: ["u1"] }]);
		expect(test.prompts[1].startsWith(SOURCES_REPAIR_RULES)).toBe(true);
		expect(test.prompts[1]).not.toContain("u1a1");
		expect(test.progress.at(-1)).toMatchObject({
			writerCalls: 2,
			repairUsed: true,
			repairKind: "sources",
			scope: { missing: 1, unreadable: 0, inSupersedes: 0 },
			scopeDropped: 1,
		});
	});

	it("cites next steps left without sources with one request about those facts only", async () => {
		const test = quoteHarness([
			uncited([{ text: "Report the threshold." }, { text: "Keep port 4317.", sources: [] }]),
			{ repairs: [sourcesOf(["u3"]), sourcesOf(["u1"], "nextSteps", 1)] },
		]);
		const result = await writeMemory(test.options);
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(result.note.nextSteps).toEqual([
			{ text: "Report the threshold.", sources: ["u3"] },
			{ text: "Keep port 4317.", sources: ["u1"] },
		]);
		// Untouched facts come back unchanged.
		expect(result.note.state).toEqual([{ text: "The threshold is 15.", sources: ["u3"] }]);
		expect(() => validateNote(result.note, branch, 2000)).not.toThrow();
		const repairPrompt = test.prompts[1];
		expect(repairPrompt.startsWith(SOURCES_REPAIR_RULES)).toBe(true);
		expect(repairPrompt).toContain('{\\"text\\":\\"Report the threshold.\\",\\"sources\\":[]}');
		// User messages in full, and every uncovered entry by its opening, as citable evidence.
		expect(repairPrompt).toContain(
			'\\"entryId\\":\\"u1\\",\\"text\\":\\"Keep the service on port 4317.\\\\nDo not touch vendor/.\\"',
		);
		expect(repairPrompt).toContain("a1 assistant: Understood:");
		// Only the facts without sources are asked about.
		expect(repairPrompt).not.toContain('\\"section\\":\\"state\\"');
		const last = test.progress.at(-1);
		expect(last).toMatchObject({
			writerCalls: 2,
			repairUsed: true,
			repairKind: "sources",
			schema: { uncited: { nextSteps: 2 }, other: false },
		});
		expect(last?.writerCallDetails.map((call) => call.phase)).toEqual(["generate", "repair"]);
		expect(last?.quotations).toBeUndefined();
		// Status carries counts only.
		expect(JSON.stringify(last)).not.toContain("Report the threshold");
	});

	it("sends the request without reasoning, tools or the session prefix, as the quotation repair does", async () => {
		const reasoning = { ...model, reasoning: true };
		const settings: { reasoning?: string; tools: number; messages: number; cache?: string }[] = [];
		const answers = [response(uncited()), response({ repairs: [sourcesOf(["u3"])] })];
		const test = quoteHarness([], {
			registry: {
				find: () => reasoning,
				hasConfiguredAuth: () => true,
				streamSimple: (_model, context, options) => {
					settings.push({
						reasoning: options?.reasoning,
						tools: context.tools?.length ?? 0,
						messages: context.messages.length,
						cache: options?.cacheRetention,
					});
					return stream(answers.shift()!);
				},
			},
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "preview-quote-test/quote-writer", writerEffort: "high" },
		});
		await writeMemory(test.options);
		expect(settings).toEqual([
			{ reasoning: "high", tools: 0, messages: 1, cache: "none" },
			{ reasoning: undefined, tools: 0, messages: 1, cache: "none" },
		]);
	});

	it("blocks when the repair cites an entry the branch does not hold", async () => {
		const test = quoteHarness([uncited(), { repairs: [sourcesOf(["invented"])] }]);
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_NOTE_SCOPE");
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(test.progress.at(-1)).toMatchObject({ repairKind: "sources", scope: { missing: 1 } });
	});

	it("requires one answer for each fact without sources and nothing else", async () => {
		const pending = diagnoseSchema(uncited()).pending!;
		const facts = [{ section: "nextSteps" as const, index: 0 }];
		for (const answer of [
			{ repairs: [] },
			{ repairs: [sourcesOf(["u3"], "state")] },
			{ repairs: [sourcesOf(["u3"]), sourcesOf(["u1"])] },
			{ repairs: [{ ...sourcesOf(["u3"]), text: "Reworded step." }] },
			{ repairs: [sourcesOf([])] },
			{ repairs: [sourcesOf(["u3", "u3"])] },
			"not json",
		])
			expect(() => applySourcesRepair(pending, facts, answer)).toThrow("CONTEXT_NOTE_INVALID");
		const reworded = quoteHarness([uncited(), { repairs: [{ ...sourcesOf(["u3"]), text: "Reworded step." }] }]);
		await expect(writeMemory(reworded.options)).rejects.toThrow(
			"CONTEXT_NOTE_INVALID: the sources repair did not return its schema",
		);
		expect(reworded.requests).toHaveBeenCalledTimes(2);
	});

	it("keeps each repaired fact's text, quote and supersedes, and the rest of the note, byte for byte", () => {
		const value = uncited([{ text: "Report the threshold.", quote: "The threshold is 15.", supersedes: ["u2"] }]);
		const pending = diagnoseSchema(value).pending!;
		const repaired = applySourcesRepair(pending, [{ section: "nextSteps", index: 0 }], {
			repairs: [sourcesOf(["u3"])],
		});
		expect(repaired.nextSteps).toEqual([
			{ text: "Report the threshold.", quote: "The threshold is 15.", supersedes: ["u2"], sources: ["u3"] },
		]);
		expect({ ...repaired, nextSteps: [] }).toEqual({ ...pending, nextSteps: [] });
		expect(pending.nextSteps[0].sources).toEqual([]);
	});

	it("does not repair another schema fault, more than five facts without sources, or with repair off", async () => {
		const other = quoteHarness([{ ...uncited(), extra: true }]);
		await expect(writeMemory(other.options)).rejects.toThrow(
			"CONTEXT_NOTE_INVALID: 1 fact has no sources (1 in nextSteps), and the note fails the schema otherwise too.",
		);
		expect(other.requests).toHaveBeenCalledTimes(1);
		expect(other.progress.at(-1)).toMatchObject({
			repairUsed: false,
			schema: { uncited: { nextSteps: 1 }, other: true },
		});
		const many = {
			...uncited(Array.from({ length: 5 }, (_, index) => ({ text: `Step ${index}.` }))),
			reasons: [{ text: "Port.", sources: [] }],
		};
		const six = quoteHarness([many]);
		await expect(writeMemory(six.options)).rejects.toThrow("6 facts have no sources (1 in reasons, 5 in nextSteps)");
		expect(six.requests).toHaveBeenCalledTimes(1);
		const off = quoteHarness([uncited()], {
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: "preview-quote-test/quote-writer", noteRepair: false },
		});
		await expect(writeMemory(off.options)).rejects.toThrow("CONTEXT_NOTE_INVALID: 1 fact has no sources");
		expect(off.requests).toHaveBeenCalledTimes(1);
		expect(off.progress.at(-1)).toMatchObject({
			repairUsed: false,
			schema: { uncited: { nextSteps: 1 }, other: false },
		});
		const invalidJson = quoteHarness(["{ not json"]);
		await expect(writeMemory(invalidJson.options)).rejects.toThrow(
			"CONTEXT_NOTE_INVALID: writer did not return valid JSON",
		);
		expect(invalidJson.progress.at(-1)?.schema).toBeUndefined();
	});

	it("spends the compaction's one repair: a quotation failure after it blocks without another request", async () => {
		const value = {
			...uncited([{ text: "Keep port 4317.", quote: "Keep the service on port 4317." }]),
		};
		const test = quoteHarness([value, { repairs: [sourcesOf(["u3"])] }]);
		await expect(writeMemory(test.options)).rejects.toThrow(
			"CONTEXT_NOTE_QUOTE: 1 quotation does not match the entries cited (1 found verbatim in other entries).",
		);
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(test.progress.at(-1)).toMatchObject({
			repairKind: "sources",
			quotations: { failed: 1, elsewhere: 1, format: 0, absent: 0 },
		});
		const large = uncited();
		large.state = [{ text: "x".repeat(1600), sources: ["u3"] }];
		const budget = quoteHarness([large, { repairs: [sourcesOf(["u3"])] }], { noteTokens: 500 });
		await expect(writeMemory(budget.options)).rejects.toThrow("CONTEXT_NOTE_BUDGET");
		expect(budget.requests).toHaveBeenCalledTimes(2);
	});

	it("repairs once across fixed-writer chunks", async () => {
		const long = (id: string, parentId: string | null, words: string) =>
			user(id, `${words} ${"filler text for chunking. ".repeat(3200)}`, parentId);
		const chunked = [long("c1", null, "Keep the service on port 4317."), long("c2", "c1", "The threshold is 15.")];
		const chunkNote = { ...note({ state: [{ text: "Port.", sources: ["c1"] }] }), nextSteps: [{ text: "Check." }] };
		const test = quoteHarness([chunkNote, { repairs: [sourcesOf(["c1"])] }, chunkNote], {
			uncovered: chunked,
			branch: chunked,
		});
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_NOTE_INVALID: 1 fact has no sources");
		expect(test.progress.at(-1)?.writerCallDetails.map((call) => call.phase)).toEqual([
			"generate",
			"repair",
			"generate",
		]);
	});

	it("offers the active requests as evidence and still requires the continuation step", async () => {
		const active = user("u4", "Now finish the report.", "u3");
		const activeBranch = [...branch, active];
		const test = quoteHarness([uncited([{ text: "Finish the report." }]), { repairs: [sourcesOf(["u4"])] }], {
			uncovered: activeBranch,
			branch: activeBranch,
			activeRequests: [active],
		});
		const result = await writeMemory(test.options);
		expect(result.note.nextSteps).toEqual([{ text: "Finish the report.", sources: ["u4"] }]);
		expect(test.prompts[1]).toContain('{\\"entryId\\":\\"u4\\",\\"text\\":\\"Now finish the report.\\"}');
	});

	it("keeps the stored note shape: a repaired note is an ordinary schema-valid note", async () => {
		const test = quoteHarness([uncited(), { repairs: [sourcesOf(["u3"])] }]);
		const result = await writeMemory(test.options);
		expect(Object.keys(result.note).sort()).toEqual(Object.keys(noteSchema.properties).sort());
		expect(result.note.nextSteps[0]).toEqual({ text: "Report the threshold.", sources: ["u3"] });
	});
});

describe("writer instruction: every fact cites its sources", () => {
	const rule =
		"Every item in instructions, failedPaths, reasons, state, nextSteps and files needs sources: the original entry IDs that support it, whether or not it has a quote.";
	const nextSteps = "citing the request or recorded progress each step continues";

	it("reaches the fixed writer, the session writer and the size repair", async () => {
		const fixed = quoteHarness([note({})]);
		await writeMemory(fixed.options);
		expect(fixed.prompts[0]).toContain(rule);
		expect(fixed.prompts[0]).toContain(nextSteps);
		const active = user("u4", "Now finish the report.", "u3");
		const sessionBranch = [...branch, active];
		const session = quoteHarness([{ ...note({}), nextSteps: [{ text: "Finish the report.", sources: ["u4"] }] }], {
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: SESSION_WRITER },
			sessionModel: model,
			prefix: { messages: [{ role: "user", content: "Earlier conversation.", timestamp: 1 }] },
			uncovered: sessionBranch,
			branch: sessionBranch,
			activeRequests: [active],
		});
		await writeMemory(session.options);
		expect(session.prompts[0]).toContain(rule);
		expect(session.prompts[0]).toContain("and cite the active request it continues");
		const large = note({ state: [{ text: "x".repeat(1600), sources: ["u3"] }] });
		const sized = quoteHarness([large, note({})], { noteTokens: 500 });
		await writeMemory(sized.options);
		expect(sized.progress.at(-1)?.repairKind).toBe("size");
		expect(sized.prompts[1]).toContain("Shorten a validated memory candidate");
		expect(sized.prompts[1]).toContain(rule);
	});
});
