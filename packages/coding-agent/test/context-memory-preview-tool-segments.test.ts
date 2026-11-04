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
	type SessionBeforeCompactEvent,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_CONFIG, SESSION_WRITER } from "../src/extensions/context-memory/config.ts";
import { CONTEXT_KEEP_NONE, hashEntries } from "../src/extensions/context-memory/identity.ts";
import { CallJournal } from "../src/extensions/context-memory/preview/call-journal.ts";
import type { PreviewSession } from "../src/extensions/context-memory/preview/contracts.ts";
import { assertToolPairs, PreviewMemoryController } from "../src/extensions/context-memory/preview/controller.ts";
import { PreviewFailureStore } from "../src/extensions/context-memory/preview/failure-store.ts";
import { PreviewSegments } from "../src/extensions/context-memory/preview/segments.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const model: Model<Api> = {
	id: "tool-segments",
	name: "Synthetic",
	provider: "synthetic",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		api: model.api,
		provider: model.provider,
		model: model.id,
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

describe("segments inside a long tool run", () => {
	const cleanup: Array<() => void> = [];
	afterEach(() => {
		for (const dispose of cleanup.splice(0)) dispose();
	});

	async function run(enabled = true) {
		const root = fs.mkdtempSync(join(tmpdir(), "pi-tool-segments-"));
		const file = join(root, "session.jsonl");
		const header: SessionHeader = { type: "session", version: 3, id: "tool-segments", timestamp, cwd: root };
		const entries: SessionEntry[] = [];
		const persist = () =>
			fs.writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const append = (
			id: string,
			message:
				| AssistantMessage
				| { role: "user"; content: string; timestamp: number }
				| {
						role: "toolResult";
						toolCallId: string;
						toolName: string;
						content: { type: "text"; text: string }[];
						isError: boolean;
						timestamp: number;
				  },
		) => {
			entries.push({ type: "message", id, parentId: entries.at(-1)?.id ?? null, timestamp, message });
			persist();
		};
		persist();
		const session = {
			getCwd: () => root,
			getSessionDir: () => root,
			getSessionFile: () => file,
			getSessionId: () => header.id,
			getHeader: () => header,
			getEntries: () => [...entries],
			getBranch: () => [...entries],
			getLeafId: () => entries.at(-1)?.id ?? null,
			getLeafEntry: () => entries.at(-1),
			buildSessionProjection: () => buildSessionProjection(entries),
		} as unknown as PreviewSession;
		const journal = new CallJournal(join(root, "agent"));
		const segments = new PreviewSegments({ enabled, journal });
		cleanup.push(() => {
			segments.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		});
		const requests: Context[] = [];
		const store = new PreviewFailureStore(join(root, "agent"));
		const ctx = {
			sessionManager: session,
			model,
			thinkingLevel: "off",
			hasUI: false,
			ui: { notify: vi.fn() },
			abort: vi.fn(),
			getSystemPrompt: () => "Synthetic system prompt.",
			hasPendingMessages: () => false,
			getContextUsage: () => ({ tokens: 70_000, contextWindow: model.contextWindow, percent: null }),
			modelRegistry: {
				find: () => model,
				hasConfiguredAuth: () => true,
				streamSimple: (_model: Model<Api>, context: Context) => {
					requests.push(structuredClone(context));
					const range = JSON.stringify(context.messages.at(-1)).match(
						/Write a segment note for entries (\S+) through (\S+) only/,
					);
					const lastId = range?.[2] ?? entries.at(-1)!.id;
					const output = {
						instructions: [],
						failedPaths: [],
						reasons: [],
						state: [{ text: "Synthetic progress.", sources: [lastId] }],
						nextSteps: [],
						files: [],
						gaps: [],
					};
					const message = assistant([{ type: "text", text: JSON.stringify(output) }]);
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				},
			},
		} as unknown as ExtensionContext;
		const controller = new PreviewMemoryController({
			config: { ...DEFAULT_MEMORY_CONFIG, writerModel: SESSION_WRITER, noteRepair: false },
			failureStore: store,
			journal,
			segments,
		});
		append("u1", { role: "user", content: "Read the synthetic logs and continue the task.", timestamp: 1 });
		controller.sessionStart(ctx);
		for (const index of [1, 2, 3, 4]) {
			append(
				`a${index}`,
				assistant([{ type: "toolCall", id: `read-${index}`, name: "read", arguments: {} }], "toolUse"),
			);
			append(`r${index}`, {
				role: "toolResult",
				toolCallId: `read-${index}`,
				toolName: "read",
				content: [{ type: "text", text: index < 4 ? "Synthetic output. ".repeat(4_000) : "Done." }],
				isError: false,
				timestamp: 1,
			});
			controller.segment(ctx);
			await segments.waitForIdle();
		}
		append("done", assistant([{ type: "text", text: "All logs read." }]));
		const event = {
			type: "session_before_compact",
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
			preparation: { tokensBefore: 70_000 },
		} as SessionBeforeCompactEvent;
		const value = await controller.compact(event, ctx);
		return { root, entries, persist, session, ctx, controller, segments, requests, store, value };
	}

	it("commits prepared chunks and keeps only the uncovered tool batch, with disk readback", async () => {
		const { entries, persist, session, ctx, controller, requests, store, value } = await run();
		expect(value.details?.preparation?.path).toBe("segments");
		expect(value.details?.preparation?.segmentIds).toHaveLength(3);
		expect(requests).toHaveLength(3);
		expect(value.details?.coveredThrough).toBe("r3");
		expect(value.firstKeptEntryId).toBe("a4");
		expect(value.details?.sourceHash).toBe(
			hashEntries(entries.slice(0, entries.findIndex((entry) => entry.id === "r3") + 1)),
		);
		expect(store.inspect(session).state).toBe("pending");
		const checkpoint: CompactionEntry = {
			type: "compaction",
			id: "c1",
			parentId: entries.at(-1)!.id,
			timestamp,
			...value,
			fromHook: true,
		};
		entries.push(checkpoint);
		persist();
		controller.committed(
			{
				type: "session_compact",
				compactionEntry: checkpoint,
				fromExtension: true,
				reason: "manual",
				willRetry: false,
			},
			ctx,
		);
		expect(store.inspect(session).state).toBe("ready");
		expect(() => controller.assertReady(ctx)).not.toThrow();
		expect(() => assertToolPairs(session.buildSessionProjection().messages)).not.toThrow();
		expect(ctx.abort).not.toHaveBeenCalled();
	});

	it("keeps the synchronous path with segments off", async () => {
		const { requests, value } = await run(false);
		expect(requests).toHaveLength(1);
		expect(value.details?.preparation).toBeUndefined();
		expect(value.details?.coveredThrough).toBe("done");
		expect(value.firstKeptEntryId).toBe(CONTEXT_KEEP_NONE);
	});

	it("blocks readback when a covered tool result changes under the same record ID", async () => {
		const { entries, persist, session, ctx, controller, store, value } = await run();
		const result = entries.find((entry) => entry.id === "r1");
		if (result?.type !== "message" || result.message.role !== "toolResult") throw new Error("Missing result");
		result.message.content = [{ type: "text", text: "Changed synthetic output." }];
		const checkpoint: CompactionEntry = {
			type: "compaction",
			id: "c1",
			parentId: entries.at(-1)!.id,
			timestamp,
			...value,
			fromHook: true,
		};
		entries.push(checkpoint);
		persist();
		controller.committed(
			{
				type: "session_compact",
				compactionEntry: checkpoint,
				fromExtension: true,
				reason: "manual",
				willRetry: false,
			},
			ctx,
		);
		expect(store.inspect(session).state).toBe("blocked");
		expect(() => controller.assertReady(ctx)).toThrow("CONTEXT_SOURCE_CHANGED");
		expect(ctx.abort).toHaveBeenCalledOnce();
	});
});
