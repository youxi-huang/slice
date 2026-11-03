import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock, GenerateOptions, MessageId, TokenUsage, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-token-meter";
import type { UsageSummary } from "../../compaction-core/src/events.ts";
import {
	TOOL_CALL_DECLINED,
	type WriterReasoning,
	type WriterResponse,
	type WriterTransport,
	type WriterUsage,
} from "../../compaction-core/src/writer.ts";

export function userMessage(content: readonly ContentBlock[], source: UserMessage["source"]): UserMessage {
	return { id: randomUUID() as MessageId, role: "user", source, content };
}

interface Response extends WriterResponse {
	blocks: ContentBlock[];
}

function usage(value?: TokenUsage): WriterUsage {
	const input = value?.inputTokens ?? 0;
	const output = value?.outputTokens ?? 0;
	const cacheRead = value?.cacheReadTokens ?? 0;
	const cacheWrite = value?.cacheWriteTokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: value?.totalTokens ?? input + output + cacheRead + cacheWrite,
		...(value?.reasoningTokens === undefined ? {} : { reasoning: value.reasoningTokens }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function nativeUsage(value: WriterUsage): TokenUsage {
	return {
		inputTokens: value.input,
		outputTokens: value.output,
		cacheReadTokens: value.cacheRead,
		cacheWriteTokens: value.cacheWrite,
		totalTokens: value.totalTokens,
		...(value.reasoning === undefined ? {} : { reasoningTokens: value.reasoning }),
	};
}

/** A projection of DSH's public stream into the core's text/tool-call response, never a tool executor. */
async function response(ctx: Context, request: GenerateOptions): Promise<Response> {
	const blocks = new Map<number, ContentBlock>();
	const closed = new Set<number>();
	let reported: TokenUsage | undefined;
	let stopReason = "stop";
	for await (const chunk of ctx.llm.stream(request)) {
		switch (chunk.type) {
			case "block-end":
				blocks.set(chunk.index, chunk.block);
				closed.add(chunk.index);
				break;
			case "text-delta":
			case "reasoning-delta": {
				if (closed.has(chunk.index)) break;
				const before = blocks.get(chunk.index);
				blocks.set(chunk.index, {
					type: chunk.type === "text-delta" ? "text" : "reasoning",
					text: (before?.type === "text" || before?.type === "reasoning" ? before.text : "") + chunk.text,
				});
				break;
			}
			case "tool-call-delta": {
				if (closed.has(chunk.index)) break;
				const before = blocks.get(chunk.index);
				blocks.set(chunk.index, {
					type: "tool-call",
					id: chunk.id,
					name: chunk.name ?? (before?.type === "tool-call" ? before.name : ""),
					arguments: (before?.type === "tool-call" ? before.arguments : "") + chunk.argumentsDelta,
				});
				break;
			}
			case "usage":
				reported = chunk.usage;
				break;
			case "finish":
				stopReason = chunk.reason.kind;
				break;
		}
	}
	request.signal?.throwIfAborted();
	const output = [...blocks.values()];
	return {
		stopReason: stopReason === "tool-calls" ? "toolUse" : stopReason,
		blocks: output,
		usage: usage(reported),
		content: output.map((block) =>
			block.type === "text" ? block : { type: block.type === "tool-call" ? "toolCall" : "thinking" },
		),
	};
}

/** Mirror the session's routed request; only the core's final instruction is added to its prefix. */
export async function dshTransport(ctx: Context, session: Session, signal: AbortSignal) {
	const header = session.requestHeader();
	if (!header) throw new Error("CONTEXT_WRITER_UNAVAILABLE: the session has no routed request");
	const config = header.config;
	const info = await ctx.llm.resolveModelInfo(config.provider, config.model, signal);
	if (!info.context) throw new Error("CONTEXT_CAPACITY: the routed model has no context window");
	const effort = config.reasoningEffort ?? info.reasoning?.defaultEffort;
	const prefix = session.deriveMessages();
	const transport: WriterTransport<GenerateOptions, Response> = {
		model: `${config.provider}/${config.model}`,
		effort: (effort ?? "off") as WriterReasoning,
		role: "session",
		contextWindow: info.context.contextWindow,
		maxOutputTokens: config.maxTokens ?? info.defaultMaxTokens ?? info.context.contextWindow,
		prefixTokens: () => ctx.tokenMeter.measure(session).totalTokens,
		request(request) {
			const common = { ...config, maxTokens: request.maxTokens, signal, purpose: "compaction" as const };
			return request.kind === "handover"
				? {
						...common,
						sessionId: session.id,
						tools: header.tools ? [...header.tools] : undefined,
						toolHistory: session.toolHistory(),
						messages: [...prefix, { role: "user", content: [{ type: "text", text: request.instruction }] }],
					}
				: {
						...common,
						system: request.systemPrompt,
						tools: [],
						messages: [{ role: "user", content: [{ type: "text", text: request.prompt }] }],
					};
		},
		declineToolCalls(request, result) {
			const assistant = {
				id: randomUUID() as MessageId,
				role: "assistant" as const,
				source: { kind: "model" as const, provider: config.provider, model: config.model },
				content: result.blocks,
			};
			return {
				...request,
				messages: [
					...request.messages,
					assistant,
					...result.blocks.flatMap((block) =>
						block.type === "tool-call"
							? [
									{
										id: randomUUID() as MessageId,
										role: "tool" as const,
										toolCallId: block.id,
										source: { kind: "tool" as const, callId: block.id },
										isError: true,
										content: [{ type: "text" as const, text: TOOL_CALL_DECLINED }],
									},
								]
							: [],
					),
				],
			};
		},
		dispatch(request, onSent) {
			onSent({ effort: request.reasoningEffort, maxTokens: request.maxTokens });
			return { result: () => response(ctx, request) };
		},
		summarizeUsage(value): UsageSummary {
			return {
				input: value.input,
				output: value.output,
				cacheRead: value.cacheRead,
				cacheWrite: value.cacheWrite,
				totalTokens: value.totalTokens,
				cost: 0,
			};
		},
	};
	return transport;
}
