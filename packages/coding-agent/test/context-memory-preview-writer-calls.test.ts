import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { NOTE_SECTIONS, removeNoteEnvelope } from "../../compaction-core/src/note-envelope.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/extensions/context-memory/config.ts";
import type { MemoryNote } from "../src/extensions/context-memory/notes.ts";
import {
	type PreviewWriterRegistry,
	TOOL_CALL_DECLINED,
	type WriteMemoryOptions,
	type WriterCallHooks,
	type WriterDispatchRequest,
	type WriterDispatchResult,
	type WriterProgress,
	writeMemory,
} from "../src/extensions/context-memory/preview/writer.ts";

const model: Model<Api> = {
	id: "fixed-writer",
	name: "Synthetic writer",
	provider: "preview-writer-test",
	api: "openai-completions",
	baseUrl: "https://writer.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 8192,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};

const usage: Usage = {
	input: 17,
	output: 11,
	cacheRead: 7,
	cacheWrite: 3,
	cacheWrite1h: 2,
	reasoning: 5,
	totalTokens: 38,
	cost: { input: 0.000017, output: 0.000022, cacheRead: 0.0000007, cacheWrite: 0.00000375, total: 0.00004345 },
};

function source(text = "Keep the synthetic service on port 4317."): SessionEntry {
	return {
		type: "message",
		id: "source-1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function note(text = "The synthetic service uses port 4317."): MemoryNote {
	return {
		instructions: [],
		failedPaths: [],
		reasons: [],
		state: [{ text, sources: ["source-1"] }],
		nextSteps: [],
		files: [],
		gaps: [],
	};
}

function response(
	text = JSON.stringify(note()),
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text }],
		stopReason,
		timestamp: 2,
		usage: structuredClone(usage),
		...(stopReason === "error" ? { errorMessage: "Synthetic provider failure" } : {}),
	};
}

function completed(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	if (message.stopReason === "error" || message.stopReason === "aborted")
		stream.push({ type: "error", reason: message.stopReason, error: message });
	else stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

function harness(
	streamSimple: PreviewWriterRegistry["streamSimple"] = () => completed(response()),
	changes: Partial<WriteMemoryOptions> = {},
) {
	const requests = vi.fn(streamSimple);
	const registry: PreviewWriterRegistry = {
		find: () => model,
		hasConfiguredAuth: () => true,
		streamSimple: requests,
	};
	const before: WriterDispatchRequest[] = [];
	const after: WriterDispatchResult[] = [];
	const trace: string[] = [];
	const progress: WriterProgress[] = [];
	const hooks: WriterCallHooks = {
		beforeDispatch: (call) => {
			before.push(call);
			trace.push(`before:${call.callIndex}:${call.phase}`);
			return `call-${call.callIndex}`;
		},
		afterDispatch: (call) => {
			after.push(call);
			trace.push(`after:${call.callIndex}:${call.phase}`);
		},
	};
	const options: WriteMemoryOptions = {
		config: { ...DEFAULT_MEMORY_CONFIG, writerModel: `${model.provider}/${model.id}`, writerEffort: "low" },
		registry,
		increments: [],
		uncovered: [source()],
		branch: [source()],
		noteTokens: 1000,
		signal: new AbortController().signal,
		callHooks: hooks,
		onProgress: (value) => progress.push(value),
		...changes,
	};
	return { requests, before, after, trace, progress, hooks, options };
}

describe("preview writer provider-call reservations and settlements", () => {
	it.each(["error", "aborted", "stop"] as const)(
		"keeps default zero usage unknown after a dispatched %s",
		async (stopReason) => {
			const message = response("No usage event arrived.", stopReason);
			message.usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const test = harness(() => completed(message));
			await expect(writeMemory(test.options)).rejects.toThrow(/CONTEXT_WRITER_FAILED|CONTEXT_NOTE_INVALID/);
			expect(test.after).toHaveLength(1);
			expect(test.after[0]).toMatchObject({
				dispatched: true,
				outcome: { error: "failed", aborted: "cancelled", stop: "success" }[stopReason],
			});
			expect(test.after[0].usage).toBeUndefined();
			expect(test.after[0].usageComplete).toBe(false);
			expect(test.progress.at(-1)?.usageReports).toBe(0);
		},
	);
	it("records the selected model and effort before dispatch and settles before validation", async () => {
		const test = harness(() => {
			test.trace.push("dispatch");
			expect(test.before).toHaveLength(1);
			return completed(response());
		});
		const result = await writeMemory(test.options);
		expect(test.trace).toEqual(["before:1:generate", "dispatch", "after:1:generate"]);
		// The record carries identities only; no request content reaches the call journal.
		expect(test.before[0]).toEqual({
			callIndex: 1,
			phase: "generate",
			model: `${model.provider}/${model.id}`,
			writerEffort: "low",
		});
		expect(test.after).toHaveLength(1);
		expect(test.after[0]).toMatchObject({
			callIndex: 1,
			callId: "call-1",
			phase: "generate",
			dispatched: true,
			outcome: "success",
			usage,
			elapsedMs: expect.any(Number),
		});
		expect(test.after[0].usage).not.toHaveProperty("costSource");
		expect(result.usage).toEqual(usage);
		expect(test.progress.at(-1)).toMatchObject({ writerCalls: 1, usageReports: 1, usage });
	});

	it("awaits reservation and settlement publication before dispatch and candidate acceptance", async () => {
		const test = harness(() => {
			test.trace.push("dispatch");
			return completed(response());
		});
		let reserve: ((callId: string) => void) | undefined;
		let settle: (() => void) | undefined;
		test.options.callHooks = {
			beforeDispatch: () =>
				new Promise<string>((resolve) => {
					reserve = resolve;
				}),
			afterDispatch: () =>
				new Promise<void>((resolve) => {
					settle = resolve;
				}),
		};
		let accepted = false;
		const pending = writeMemory(test.options).then(() => {
			accepted = true;
		});
		expect(test.requests).not.toHaveBeenCalled();
		reserve!("persisted-call");
		await vi.waitFor(() => expect(settle).toBeDefined());
		expect(test.requests).toHaveBeenCalledTimes(1);
		expect(accepted).toBe(false);
		settle!();
		await pending;
		expect(accepted).toBe(true);
	});

	it.each([false, true])("a %s asynchronous reservation rejection sends no request", async (asynchronous) => {
		const test = harness();
		const refused = new Error("CONTEXT_PREPARATION_BUDGET: synthetic reservation refused");
		const beforeDispatch = vi.fn(() => {
			if (asynchronous) return Promise.reject(refused);
			throw refused;
		});
		const afterDispatch = vi.fn();
		test.options.callHooks = { beforeDispatch, afterDispatch };
		await expect(writeMemory(test.options)).rejects.toBe(refused);
		expect(test.requests).not.toHaveBeenCalled();
		expect(afterDispatch).not.toHaveBeenCalled();
		expect(test.progress).toEqual([]);
	});

	it("refuses an empty reservation identity without invoking a provider or a settlement", async () => {
		const test = harness();
		const afterDispatch = vi.fn();
		test.options.callHooks = { beforeDispatch: () => "", afterDispatch };
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_WRITER_ACCOUNTING");
		expect(test.requests).not.toHaveBeenCalled();
		expect(afterDispatch).not.toHaveBeenCalled();
	});

	it("an already cancelled operation does not reserve or dispatch", async () => {
		const abort = new AbortController();
		abort.abort(new Error("Synthetic cancellation"));
		const test = harness(undefined, { signal: abort.signal });
		await expect(writeMemory(test.options)).rejects.toThrow("Synthetic cancellation");
		expect(test.before).toHaveLength(0);
		expect(test.after).toHaveLength(0);
		expect(test.requests).not.toHaveBeenCalled();
	});

	it("cancellation during reservation settles once without claiming dispatch or zero usage", async () => {
		const abort = new AbortController();
		const test = harness(undefined, { signal: abort.signal });
		test.options.callHooks = {
			...test.hooks,
			beforeDispatch: async (call) => {
				const callId = await test.hooks.beforeDispatch(call);
				abort.abort(new Error("Synthetic reservation-time cancellation"));
				return callId;
			},
		};
		await expect(writeMemory(test.options)).rejects.toThrow("Synthetic reservation-time cancellation");
		expect(test.requests).not.toHaveBeenCalled();
		expect(test.after).toHaveLength(1);
		expect(test.after[0]).toMatchObject({ outcome: "cancelled", dispatched: false });
		expect(test.after[0]).not.toHaveProperty("usage");
		expect(test.progress.at(-1)).toMatchObject({ writerCalls: 0, usageReports: 0, writerCallDetails: [] });
		expect(test.progress.at(-1)).not.toHaveProperty("usage");
	});

	it.each(["not JSON", "{}", JSON.stringify(note()).replace("source-1", "unavailable")])(
		"settles malformed or invalid paid output before parsing fails: %s",
		async (text) => {
			// One paid call each: with the repair on, the unknown only source would go to the sources repair.
			const test = harness(() => completed(response(text)), {
				config: {
					...DEFAULT_MEMORY_CONFIG,
					writerModel: `${model.provider}/${model.id}`,
					writerEffort: "low",
					noteRepair: false,
				},
			});
			await expect(writeMemory(test.options)).rejects.toThrow(/CONTEXT_NOTE_(INVALID|SCOPE)/);
			expect(test.after).toHaveLength(1);
			expect(test.after[0]).toMatchObject({ outcome: "success", dispatched: true, usage });
			expect(test.progress.at(-1)).toMatchObject({ writerCalls: 1, usageReports: 1, usage });
		},
	);

	it.each(["error", "aborted", "length", "toolUse"] as const)(
		"settles raw usage from a %s response before writer rejection",
		async (stopReason) => {
			const test = harness(() => completed(response("not JSON", stopReason)));
			await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_WRITER_FAILED");
			expect(test.after).toHaveLength(1);
			expect(test.after[0]).toMatchObject({
				outcome: stopReason === "aborted" ? "cancelled" : "failed",
				dispatched: true,
				usage,
				usageComplete: stopReason !== "error" && stopReason !== "aborted",
			});
			expect(test.progress.at(-1)?.usage).toEqual(usage);
		},
	);

	it.each([false, true])("settles %s asynchronous provider throws with unknown usage", async (asynchronous) => {
		const failure = new Error("Synthetic provider setup failure");
		const test = harness(() => {
			if (asynchronous) {
				const stream = createAssistantMessageEventStream();
				vi.spyOn(stream, "result").mockRejectedValue(failure);
				return stream;
			}
			throw failure;
		});
		await expect(writeMemory(test.options)).rejects.toBe(failure);
		expect(test.requests).toHaveBeenCalledTimes(1);
		expect(test.after).toHaveLength(1);
		expect(test.after[0]).toMatchObject({ outcome: "failed", dispatched: true });
		expect(test.after[0]).not.toHaveProperty("usage");
		expect(test.progress.at(-1)).toMatchObject({ writerCalls: 1, usageReports: 0 });
	});

	it("preserves paid usage when cancellation arrives before the raw response is consumed", async () => {
		const abort = new AbortController();
		const test = harness(
			() => {
				abort.abort(new Error("Synthetic in-flight cancellation"));
				return completed(response());
			},
			{ signal: abort.signal },
		);
		await expect(writeMemory(test.options)).rejects.toThrow("Synthetic in-flight cancellation");
		expect(test.after).toHaveLength(1);
		expect(test.after[0]).toMatchObject({ outcome: "cancelled", dispatched: true, usage });
		expect(test.progress.at(-1)).toMatchObject({ writerCalls: 1, usageReports: 1, usage });
	});

	it("reserves and settles each fixed-writer chunk and its sole size repair separately", async () => {
		const original = source("Evidence marker ".repeat(8000));
		let dispatched = 0;
		const test = harness(
			() => {
				dispatched++;
				return completed(response(JSON.stringify(note(dispatched === 1 ? "界".repeat(700) : undefined))));
			},
			{ branch: [original], uncovered: [original], noteTokens: 500 },
		);
		const result = await writeMemory(test.options);
		expect(result.chunkCount).toBeGreaterThan(1);
		expect(dispatched).toBe(result.chunkCount + 1);
		expect(test.before.map((call) => call.phase)).toEqual([
			"generate",
			"repair",
			...Array.from({ length: result.chunkCount - 1 }, () => "generate"),
		]);
		expect(test.after.map((call) => call.callIndex)).toEqual(
			Array.from({ length: dispatched }, (_, index) => index + 1),
		);
		expect(new Set(test.after.map((call) => call.callId)).size).toBe(dispatched);
		expect(test.after.every((call) => call.dispatched && call.usage?.totalTokens === usage.totalTokens)).toBe(true);
		expect(result.usage.totalTokens).toBe(usage.totalTokens * dispatched);
		expect(test.progress.at(-1)).toMatchObject({
			writerCalls: dispatched,
			usageReports: dispatched,
			repairUsed: true,
		});
		// The size repair offers no tools and, like the session writer, sets no tool choice.
		const [, repairContext, repairOptions] = test.requests.mock.calls[1];
		expect(repairContext.tools).toEqual([]);
		expect(repairOptions).not.toHaveProperty("toolChoice");
	});

	it("a refused repair preserves the first paid generation and does not send the repair", async () => {
		const test = harness(() => completed(response(JSON.stringify(note("界".repeat(700))))), { noteTokens: 500 });
		test.options.callHooks = {
			...test.hooks,
			beforeDispatch: (call) => {
				if (call.phase === "repair") throw new Error("CONTEXT_PREPARATION_BUDGET: repair refused");
				return test.hooks.beforeDispatch(call);
			},
		};
		await expect(writeMemory(test.options)).rejects.toThrow("repair refused");
		expect(test.requests).toHaveBeenCalledTimes(1);
		expect(test.after).toHaveLength(1);
		expect(test.progress.at(-1)).toMatchObject({ writerCalls: 1, usageReports: 1, usage });
	});

	it("cancellation during repair preserves both paid calls and prevents further source chunks", async () => {
		const abort = new AbortController();
		const original = source("Evidence marker ".repeat(8000));
		let calls = 0;
		const test = harness(
			() => {
				calls++;
				if (calls === 2) abort.abort(new Error("Synthetic repair cancellation"));
				return completed(response(JSON.stringify(note(calls === 1 ? "界".repeat(700) : undefined))));
			},
			{ branch: [original], uncovered: [original], noteTokens: 500, signal: abort.signal },
		);
		await expect(writeMemory(test.options)).rejects.toThrow("Synthetic repair cancellation");
		expect(test.requests).toHaveBeenCalledTimes(2);
		expect(test.after.map((call) => [call.callIndex, call.phase, call.outcome])).toEqual([
			[1, "generate", "success"],
			[2, "repair", "cancelled"],
		]);
		expect(test.after.every((call) => call.usage?.totalTokens === usage.totalTokens)).toBe(true);
		expect(test.progress.at(-1)).toMatchObject({
			writerCalls: 2,
			usageReports: 2,
			usage: { totalTokens: usage.totalTokens * 2 },
			repairUsed: true,
		});
	});

	it("a settlement failure rejects a good note while preserving raw progress", async () => {
		const test = harness();
		const failure = new Error("CONTEXT_PREPARATION_LEDGER: settlement failed");
		test.options.callHooks = {
			...test.hooks,
			afterDispatch: async (call) => {
				test.hooks.afterDispatch(call);
				throw failure;
			},
		};
		await expect(writeMemory(test.options)).rejects.toBe(failure);
		expect(test.after).toHaveLength(1);
		expect(test.after[0].usage).toEqual(usage);
		expect(test.progress.at(-1)?.usage).toEqual(usage);
	});

	it("a settlement failure retains an original provider exception in its cause and error list", async () => {
		const original = new Error("Synthetic original provider failure");
		const accounting = new Error("Synthetic accounting failure");
		const test = harness(() => {
			throw original;
		});
		test.options.callHooks = {
			...test.hooks,
			afterDispatch: (call) => {
				test.hooks.afterDispatch(call);
				throw accounting;
			},
		};
		const failure = await writeMemory(test.options).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AggregateError);
		expect(failure).toMatchObject({ cause: original, errors: [original, accounting] });
		expect(test.after).toHaveLength(1);
	});

	it("a settlement failure retains a failed response error and already reported usage", async () => {
		const test = harness(() => completed(response("not JSON", "error")));
		const accounting = new Error("Synthetic accounting failure");
		test.options.callHooks = {
			...test.hooks,
			afterDispatch: (call) => {
				test.hooks.afterDispatch(call);
				throw accounting;
			},
		};
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_WRITER_FAILED: Synthetic provider failure");
		expect(test.after[0]).toMatchObject({ outcome: "failed", usage });
		expect(test.progress.at(-1)?.usage).toEqual(usage);
	});

	it("awaits an already dispatched response even if the progress observer throws", async () => {
		const failure = new Error("Synthetic progress observer failure");
		const test = harness();
		let notifications = 0;
		test.options.onProgress = (value) => {
			test.progress.push(value);
			if (notifications++ === 0) throw failure;
		};
		await expect(writeMemory(test.options)).rejects.toBe(failure);
		expect(test.requests).toHaveBeenCalledTimes(1);
		expect(test.after).toHaveLength(1);
		expect(test.after[0].usage).toEqual(usage);
		expect(test.progress.at(-1)?.usage).toEqual(usage);
	});

	describe("a session writer that calls a tool", () => {
		const prefix = {
			systemPrompt: "Synthetic session control",
			messages: [{ role: "user" as const, content: "Keep port 4317.", timestamp: 1 }],
			tools: [{ name: "synthetic_tool", description: "Synthetic schema", parameters: { type: "object" } }],
		};
		const called: AssistantMessage = {
			...response(),
			content: [{ type: "toolCall", id: "call-1", name: "synthetic_tool", arguments: {} }],
			stopReason: "toolUse",
		};
		const toolUse = () => {
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "toolUse", message: called });
			stream.end(called);
			return stream;
		};
		const sessionHarness = (replies: (() => ReturnType<typeof completed>)[], noteRepair = true) => {
			let index = 0;
			return harness(() => replies[Math.min(index++, replies.length - 1)](), {
				config: { ...DEFAULT_MEMORY_CONFIG, writerEffort: "low", noteRepair },
				sessionModel: { ...model, id: "session-model" },
				sessionThinkingLevel: "high",
				prefix,
			});
		};

		it("declines one call without running it and commits the note written after it", async () => {
			const test = sessionHarness([toolUse, () => completed(response())]);
			const result = await writeMemory(test.options);
			expect(result.note.state[0].text).toBe("The synthetic service uses port 4317.");
			expect(test.requests).toHaveBeenCalledTimes(2);
			const [first, second] = test.requests.mock.calls.map((call) => call[1]);
			// The second request continues the first, so the provider can read all of it from cache.
			expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
			expect(second.messages.at(-2)).toEqual(called);
			expect(second.messages.at(-1)).toMatchObject({
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "synthetic_tool",
				isError: true,
				content: [{ type: "text", text: TOOL_CALL_DECLINED }],
			});
			expect(second.tools).toEqual(prefix.tools);
			// Each call observes its own payload; every setting the provider receives is the same.
			const [firstOptions, secondOptions] = test.requests.mock.calls.map((call) => call[2]);
			expect(typeof secondOptions?.onPayload).toBe("function");
			expect({ ...secondOptions, onPayload: undefined }).toEqual({ ...firstOptions, onPayload: undefined });
			expect(test.progress.at(-1)).toMatchObject({
				writerCalls: 2,
				repairUsed: false,
				toolCallDeclined: true,
				toolCallResponses: 1,
			});
			expect(test.progress.at(-1)).not.toHaveProperty("repairKind");
			expect(test.before.map((call) => call.phase)).toEqual(["generate", "generate"]);
			expect(first.messages.at(-1)?.content).toContain("call no tool");
		});

		it("refuses the note at a second call", async () => {
			const test = sessionHarness([toolUse]);
			await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_WRITER_FAILED");
			expect(test.requests).toHaveBeenCalledTimes(2);
			expect(test.progress.at(-1)).toMatchObject({ writerCalls: 2, toolCallDeclined: true, toolCallResponses: 2 });
		});

		it("still repairs the quotations of the note written after a declined call, in three calls at most", async () => {
			const misquoted = {
				...note(),
				state: [{ text: "The synthetic service uses port 4317.", sources: ["source-1"], quote: "port 4318" }],
			};
			const repair = {
				repairs: [
					{
						section: "state",
						index: 0,
						fact: { text: "The synthetic service uses port 4317.", sources: ["source-1"], quote: "port 4317" },
					},
				],
			};
			const test = sessionHarness([
				toolUse,
				() => completed(response(JSON.stringify(misquoted))),
				() => completed(response(JSON.stringify(repair))),
			]);
			const result = await writeMemory(test.options);
			expect(result.note.state[0].quote).toBe("port 4317");
			expect(test.requests).toHaveBeenCalledTimes(3);
			expect(test.before.map((call) => call.phase)).toEqual(["generate", "generate", "repair"]);
			expect(test.progress.at(-1)).toMatchObject({
				writerCalls: 3,
				repairUsed: true,
				repairKind: "quotation",
				toolCallDeclined: true,
				toolCallResponses: 1,
			});
		});

		it("refuses the note at once when repair is off", async () => {
			const test = sessionHarness([toolUse, () => completed(response())], false);
			await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_WRITER_FAILED");
			expect(test.requests).toHaveBeenCalledTimes(1);
			expect(test.progress.at(-1)).toMatchObject({ writerCalls: 1, repairUsed: false, toolCallResponses: 1 });
		});
	});

	it("preserves session prefix values and cache defaults with the current session model and effort", async () => {
		const prefix = {
			systemPrompt: "Synthetic session control",
			messages: [{ role: "user" as const, content: "Keep port 4317.", timestamp: 1 }],
			tools: [{ name: "synthetic_tool", description: "Synthetic schema", parameters: { type: "object" } }],
		};
		const selected = { ...model, id: "session-model" };
		const test = harness(undefined, {
			config: { ...DEFAULT_MEMORY_CONFIG, writerEffort: "low" },
			sessionModel: selected,
			sessionThinkingLevel: "high",
			prefix,
		});
		const result = await writeMemory(test.options);
		const [actualModel, actualContext, actualRequest] = test.requests.mock.calls[0];
		expect(actualModel).toBe(selected);
		expect(actualContext.systemPrompt).toBe(prefix.systemPrompt);
		expect(actualContext.messages.slice(0, prefix.messages.length)).toEqual(prefix.messages);
		expect(actualContext.messages[0]).toBe(prefix.messages[0]);
		expect(actualContext.tools).toEqual(prefix.tools);
		expect(actualContext.tools?.[0]).toBe(prefix.tools[0]);
		expect(actualRequest).toMatchObject({ reasoning: "high", maxRetries: 0 });
		// Like the session's own requests, so the provider can reuse the cached prefix tools included.
		expect(actualRequest).not.toHaveProperty("toolChoice");
		expect(actualRequest).not.toHaveProperty("cacheRetention");
		expect(test.before[0].model).toBe(`${model.provider}/session-model`);
		expect(test.before[0].writerEffort).toBe("high");
		expect(result.writerModel).toBe(`${model.provider}/session-model`);
		expect(result.writerEffort).toBe("high");
		expect(Object.isFrozen(prefix.messages[0])).toBe(false);
	});

	it("keeps the legacy progress and usage path when no hooks are installed", async () => {
		const test = harness(undefined, { callHooks: undefined });
		const result = await writeMemory(test.options);
		expect(test.before).toHaveLength(0);
		expect(test.after).toHaveLength(0);
		expect(test.requests).toHaveBeenCalledTimes(1);
		expect(result.usage).toEqual(usage);
		expect(test.progress[0]).toMatchObject({ writerCalls: 1, usageReports: 0 });
		expect(test.progress.at(-1)).toMatchObject({ writerCalls: 1, usageReports: 1, usage });
	});
});

describe("preview writer note format", () => {
	const prefix = {
		systemPrompt: "Synthetic session control",
		messages: [{ role: "user" as const, content: "Keep port 4317.", timestamp: 1 }],
		tools: [{ name: "synthetic_tool", description: "Synthetic schema", parameters: { type: "object" } }],
		sessionId: "session-synthetic",
	};
	const without = (value: Record<string, unknown>, key: string) =>
		Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
	/** The two answers GPT-6 Luna gave around a complete note. */
	const typed = (value: MemoryNote = note()) => ({ type: "object", ...value });
	const schema = (value: MemoryNote = note()) => ({
		type: "object",
		properties: value,
		required: [...NOTE_SECTIONS],
	});
	const sessionWriter = (text: string, changes: Partial<WriteMemoryOptions> = {}) =>
		harness(() => completed(response(text)), {
			config: { ...DEFAULT_MEMORY_CONFIG, writerEffort: "low" },
			sessionModel: { ...model, id: "session-model" },
			prefix,
			...changes,
		});

	it("removes the two schema envelopes and returns any other answer as it came", () => {
		expect(NOTE_SECTIONS).toEqual(["instructions", "failedPaths", "reasons", "state", "nextSteps", "files", "gaps"]);
		expect(removeNoteEnvelope(typed())).toEqual({ value: note(), envelope: "type" });
		expect(removeNoteEnvelope(schema())).toEqual({ value: note(), envelope: "schema" });
		const plain = note();
		expect(removeNoteEnvelope(plain)).toEqual({ value: plain });
		expect(removeNoteEnvelope(plain).value).toBe(plain);
	});

	it.each([
		["a type beside six sections", () => without(typed(), "gaps")],
		["a type beside the sections and another key", () => ({ ...typed(), required: [...NOTE_SECTIONS] })],
		["a type that is not a string", () => ({ ...note(), type: { const: "object" } })],
		["a schema envelope with another keyword", () => ({ ...schema(), additionalProperties: false })],
		["a schema envelope without required", () => without(schema(), "required")],
		[
			"a schema envelope whose properties lack a section",
			() => ({ ...schema(), properties: without(note(), "gaps") }),
		],
		["a schema envelope around a typed note", () => ({ ...schema(), properties: typed() })],
		["a schema envelope whose properties are a list", () => ({ ...schema(), properties: [note()] })],
		["a list of notes", () => [note()]],
		["null", () => null],
		["a string", () => JSON.stringify(note())],
	])("leaves %s unchanged", (_name, make) => {
		const value = make();
		const result = removeNoteEnvelope(value);
		expect(result.value).toBe(value);
		expect(result).not.toHaveProperty("envelope");
	});

	it.each([
		["type", typed],
		["schema", schema],
	] as const)("commits a note that arrived in the %s envelope and records the envelope", async (envelope, wrap) => {
		const test = sessionWriter(JSON.stringify(wrap()));
		const result = await writeMemory(test.options);
		expect(result.note).toEqual(note());
		const [call] = test.progress.at(-1)?.writerCallDetails ?? [];
		expect(call).toMatchObject({ envelope, noteBytes: Buffer.byteLength(JSON.stringify(note()), "utf8") });
	});

	it("also removes an envelope from a fixed writer's note", async () => {
		const test = harness(() => completed(response(JSON.stringify(typed()))));
		const result = await writeMemory(test.options);
		expect(result.note).toEqual(note());
		expect(test.progress.at(-1)?.writerCallDetails[0].envelope).toBe("type");
	});

	it("records no envelope for a plain note", async () => {
		const test = sessionWriter(JSON.stringify(note()));
		await writeMemory(test.options);
		expect(test.progress.at(-1)?.writerCallDetails[0]).not.toHaveProperty("envelope");
	});

	it("refuses a near miss as before", async () => {
		const test = sessionWriter(JSON.stringify({ ...schema(), additionalProperties: false }));
		await expect(writeMemory(test.options)).rejects.toThrow("CONTEXT_NOTE_INVALID");
		expect(test.progress.at(-1)?.writerCallDetails[0]).not.toHaveProperty("envelope");
	});

	it("checks an unwrapped note like any other", async () => {
		// Sections described as schemas pass the envelope's shape but not the note's.
		const described = Object.fromEntries(NOTE_SECTIONS.map((section) => [section, { type: "array" }]));
		const invalid = sessionWriter(JSON.stringify({ type: "object", properties: described, required: [] }));
		await expect(writeMemory(invalid.options)).rejects.toThrow("CONTEXT_NOTE_INVALID");
		expect(invalid.progress.at(-1)?.writerCallDetails[0].envelope).toBe("schema");
		// An unknown supersedes ID refuses the note whatever the repair; an unknown only source would go to it.
		const unscoped = note();
		unscoped.state[0].supersedes = ["unknown-entry"];
		const scope = sessionWriter(JSON.stringify(typed(unscoped)));
		await expect(writeMemory(scope.options)).rejects.toThrow("CONTEXT_NOTE_SCOPE");
		expect(scope.progress.at(-1)?.scope).toMatchObject({ missing: 1, inSupersedes: 1 });
	});

	it("removes an envelope from the size repair's answer, which is checked again", async () => {
		let dispatched = 0;
		const test = sessionWriter("", { noteTokens: 500 });
		test.requests.mockImplementation(() => {
			dispatched++;
			return completed(response(JSON.stringify(dispatched === 1 ? note("界".repeat(700)) : schema())));
		});
		const result = await writeMemory(test.options);
		expect(result.note).toEqual(note());
		expect(test.before.map((call) => call.phase)).toEqual(["generate", "repair"]);
		expect(test.progress.at(-1)?.writerCallDetails.map((call) => call.envelope)).toEqual([undefined, "schema"]);
	});

	it("asks every note writer for the note itself, not an object matching a schema", async () => {
		const asks = (text: string | undefined) => {
			expect(text).toContain(
				"Return ONLY the memory note itself: one JSON object whose top-level keys are exactly instructions, failedPaths, reasons, state, nextSteps, files, gaps.",
			);
			expect(text).toContain('"additionalProperties":false');
			expect(text).not.toContain("matching this schema");
			expect(text).not.toContain("complete JSON schema");
		};
		const session = sessionWriter(JSON.stringify(note()));
		await writeMemory(session.options);
		const closing = session.requests.mock.calls[0][1].messages.at(-1)?.content;
		asks(typeof closing === "string" ? closing : undefined);
		let dispatched = 0;
		const fixed = harness(
			() => {
				dispatched++;
				return completed(response(JSON.stringify(note(dispatched === 1 ? "界".repeat(700) : undefined))));
			},
			{ noteTokens: 500 },
		);
		await writeMemory(fixed.options);
		const [generate, repair] = fixed.requests.mock.calls.map((call) => call[1].systemPrompt);
		asks(generate);
		asks(repair);
		expect(repair).toContain("the answer is the whole shortened note");
	});

	it("sends the session's ID with the session writer's request and its continuation only", async () => {
		const test = sessionWriter(JSON.stringify(note()));
		await writeMemory(test.options);
		expect(test.requests.mock.calls[0][2]?.sessionId).toBe("session-synthetic");
		const bare = sessionWriter(JSON.stringify(note()), { prefix: { ...prefix, sessionId: undefined } });
		await writeMemory(bare.options);
		expect(bare.requests.mock.calls[0][2]).not.toHaveProperty("sessionId");
		const fixed = harness(undefined, { prefix });
		await writeMemory(fixed.options);
		expect(fixed.requests.mock.calls[0][2]).not.toHaveProperty("sessionId");
	});

	it("sends no session ID with a quotation repair, whose context is its own", async () => {
		const misquoted = {
			...note(),
			state: [{ text: "The synthetic service uses port 4317.", sources: ["source-1"], quote: "port 4318" }],
		};
		const repair = {
			repairs: [
				{
					section: "state",
					index: 0,
					fact: { text: "The synthetic service uses port 4317.", sources: ["source-1"], quote: "port 4317" },
				},
			],
		};
		let dispatched = 0;
		const test = sessionWriter("");
		test.requests.mockImplementation(() =>
			completed(response(JSON.stringify(dispatched++ === 0 ? misquoted : repair))),
		);
		const result = await writeMemory(test.options);
		expect(result.note.state[0].quote).toBe("port 4317");
		const [generate, repaired] = test.requests.mock.calls.map((call) => call[2]);
		expect(generate?.sessionId).toBe("session-synthetic");
		expect(repaired).not.toHaveProperty("sessionId");
		expect(repaired?.cacheRetention).toBe("none");
	});
});
