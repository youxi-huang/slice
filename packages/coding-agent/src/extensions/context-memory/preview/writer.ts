// Split for the host-neutral core (v0.7.0 WP2 step 5, rule K6): the writer contract — rules text, manifest
// construction, `quotableOriginals`, candidate reading with envelope removal, the diagnostics-and-repair
// sequencing, `sumMemoryUsage`, `writerContractHashes` and the progress and outcome records — moved to the
// core's writer.ts, re-exported here. This file is the Pi transport the core is given: `resolveWriterModel`,
// the reasoning-effort mapping, the provider requests built from each contract request (the session-ID
// `prompt_cache_key` among them), dispatch through `streamSimple`, the payload's reasoning settings, the
// prefix estimate and the usage summary. Cache reuse depends on reproducing the host's own request.
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ModelsSimpleStreamOptions,
	ThinkingLevel,
	Tool,
} from "@earendil-works/pi-ai";
import { estimateTokens, type ModelRegistry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MemoryNote } from "../../../../../compaction-core/src/notes.ts";
import type { SessionRecord } from "../../../../../compaction-core/src/records.ts";
import {
	quotableOriginals as coreQuotableOriginals,
	writeMemory as coreWriteMemory,
	type QuotableOriginal,
	type SentReasoning,
	TOOL_CALL_DECLINED,
	type WriteMemoryResult,
	type WriterCallDetail,
	type WriterCallHooks,
	type WriterProgress,
	type WriterRequest,
	type WriterTransport,
} from "../../../../../compaction-core/src/writer.ts";
import { type MemoryConfig, SESSION_WRITER, textTokens } from "../config.ts";
import { summarizeUsage } from "../events.ts";
import { isRecord } from "../identity.ts";

export {
	type QuotableOriginal,
	type SentReasoning,
	sumMemoryUsage,
	TOOL_CALL_DECLINED,
	type WriteMemoryResult,
	type WriterCallHooks,
	type WriterDispatchRequest,
	type WriterDispatchResult,
	type WriterProgress,
	writerContractHashes,
} from "../../../../../compaction-core/src/writer.ts";

/** Pi's entries satisfy the core's structural record shapes; the union is widened here, never converted (records.ts). */
const asRecords = (branch: readonly SessionEntry[]): readonly SessionRecord[] =>
	branch as unknown as readonly SessionRecord[];

/** The core's `quotableOriginals` over Pi's entries, widened at the boundary. */
export function quotableOriginals(
	sources: readonly SessionEntry[],
	active: readonly SessionEntry[] | undefined,
	budgetTokens: number,
): QuotableOriginal[] {
	return coreQuotableOriginals(asRecords(sources), active && asRecords(active), budgetTokens);
}

/** Public registry surface used by the portable writer; authentication remains owned by Pi. */
export type PreviewWriterRegistry = Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "streamSimple">;
export type PreviewComplete = (
	model: Model<Api>,
	context: Context,
	options?: ModelsSimpleStreamOptions,
) => Promise<AssistantMessage>;

/** One writer call as status reports it: the shared record, plus what was asked for, what was sent and how it ended. */
export type PreviewWriterCallRecord = WriterCallDetail;

/** Settings only, never content: the payload carries the whole request. */
function sentReasoning(payload: unknown): SentReasoning {
	if (!isRecord(payload)) return {};
	const sent: SentReasoning = {};
	const effort = payload.reasoning_effort ?? (isRecord(payload.reasoning) ? payload.reasoning.effort : undefined);
	if (typeof effort === "string") sent.effort = effort;
	// Since Pi 1.3.0, a Responses model that changes effort mid-conversation, such as GPT-6 Luna, gets a fixed
	// `reasoning.effort` and the level the request asks for as its last `configuration_update` input item.
	const update = Array.isArray(payload.input)
		? payload.input.findLast((item: unknown) => isRecord(item) && item.type === "configuration_update")
		: undefined;
	if (isRecord(update) && isRecord(update.reasoning) && typeof update.reasoning.effort === "string") {
		if (sent.effort !== undefined) sent.fixedEffort = sent.effort;
		sent.effort = update.reasoning.effort;
	}
	if (isRecord(payload.thinking)) {
		if (typeof payload.thinking.type === "string") sent.thinking = payload.thinking.type;
		if (typeof payload.thinking.budget_tokens === "number") sent.budgetTokens = payload.thinking.budget_tokens;
	}
	const cap = payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens;
	if (typeof cap === "number") sent.maxTokens = cap;
	return sent;
}

/** The provider request the session model would receive next; reused verbatim so the prompt cache stays warm. */
export interface SessionPrefix {
	systemPrompt?: string;
	messages: readonly Message[];
	tools?: readonly Tool[];
	/** The session's ID, which Pi sends with every request of the session. */
	sessionId?: string;
	/**
	 * Pi's count of this context from the provider's reported usage, when the prefix is the whole current context and a
	 * response has reported usage. Four characters a token overstates English prose by about a tenth, so the estimate
	 * alone can refuse a handover that fits.
	 */
	measuredTokens?: number;
}

export interface WriteMemoryOptions {
	config: Readonly<MemoryConfig>;
	registry: PreviewWriterRegistry;
	/** Current session model; required when the writer is `session`. */
	sessionModel?: Model<Api>;
	/** Current provider context; required when the writer is `session`. */
	prefix?: SessionPrefix;
	/** The session's current thinking level; the session writer follows it instead of `writerEffort`. */
	sessionThinkingLevel?: ThinkingLevel | "off";
	previous?: MemoryNote;
	increments: readonly MemoryNote[];
	uncovered: readonly SessionEntry[];
	branch: readonly SessionEntry[];
	/** Hard limit, frozen by the host. Direct callers also remain subject to the storage maximum. */
	noteTokens: number;
	/** Preferred ceiling. Defaults to the hard limit for fixed-budget callers. */
	baseNoteTokens?: number;
	signal: AbortSignal;
	customInstructions?: string;
	/** Original user requests within an unfinished turn whose tool rounds will be released. */
	activeRequests?: readonly SessionEntry[];
	/** Cumulative call accounting, emitted before validation so failures do not erase paid usage. */
	onProgress?: (progress: WriterProgress) => void;
	/** Optional durable per-provider-call reservation and settlement, independent of cumulative progress. */
	callHooks?: WriterCallHooks;
}

/**
 * The session writer reasons at the level the session is running at, the way Pi's own summarizer does; a fixed
 * writer uses the configured effort. Models without declared reasoning support receive no effort at all.
 */
export function writerReasoning(
	model: Model<Api>,
	config: Pick<MemoryConfig, "writerModel" | "writerEffort">,
	sessionThinkingLevel?: ThinkingLevel | "off",
): ThinkingLevel | "off" {
	if (!model.reasoning) return "off";
	const level =
		config.writerModel === SESSION_WRITER ? (sessionThinkingLevel ?? config.writerEffort) : config.writerEffort;
	return level === "off" ? "off" : level;
}

export function resolveWriterModel(
	config: Readonly<MemoryConfig>,
	registry: PreviewWriterRegistry,
	sessionModel?: Model<Api>,
) {
	if (config.writerModel === SESSION_WRITER) {
		if (!sessionModel) throw new Error("CONTEXT_WRITER_UNAVAILABLE: no session model for the session writer");
		return sessionModel;
	}
	const separator = config.writerModel.indexOf("/");
	const model = registry.find(config.writerModel.slice(0, separator), config.writerModel.slice(separator + 1));
	// A catalog entry is not reachability: the provider also needs configured authentication.
	if (!model || !registry.hasConfiguredAuth(model))
		throw new Error(`CONTEXT_WRITER_UNAVAILABLE: ${config.writerModel}`);
	return model;
}

export function modelName(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** A Pi provider request: the context and the stream options, as `streamSimple` takes them. */
interface PiWriterRequest {
	readonly context: Context;
	readonly options: ModelsSimpleStreamOptions;
}

/**
 * The Pi transport for the core's writer contract: the resolved model, its reasoning effort and window, and each
 * contract request built as the provider request Pi itself would send.
 */
function piTransport(options: WriteMemoryOptions): WriterTransport<PiWriterRequest, AssistantMessage> {
	const model = resolveWriterModel(options.config, options.registry, options.sessionModel);
	const { prefix, signal } = options;
	const role = options.config.writerModel === SESSION_WRITER ? "session" : "fixed";
	return {
		model: modelName(model),
		effort: writerReasoning(model, options.config, options.sessionThinkingLevel),
		role,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		...(role === "session" && prefix
			? {
					// The provider's count when Pi has one; otherwise Pi's estimator, so images count at their flat
					// estimate, not as base64 text.
					prefixTokens: () =>
						prefix.measuredTokens ??
						textTokens(prefix.systemPrompt ?? "") +
							prefix.messages.reduce((sum, message) => sum + estimateTokens(message), 0) +
							textTokens(JSON.stringify(prefix.tools ?? [])),
				}
			: {}),
		request: (request: WriterRequest): PiWriterRequest => {
			const reasoning = request.reasoning === "off" ? {} : { reasoning: request.reasoning };
			if (request.kind === "chunk")
				return {
					context: {
						systemPrompt: request.systemPrompt,
						messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
						tools: [],
					},
					options: {
						...reasoning,
						maxTokens: request.maxTokens,
						signal,
						maxRetries: 0,
						cacheRetention: "none",
						toolChoice: "none",
						transport: "sse",
					},
				};
			if (request.kind === "repair")
				return {
					context: {
						systemPrompt: request.systemPrompt,
						messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
						tools: [],
					},
					options: {
						...reasoning,
						maxTokens: request.maxTokens,
						signal,
						maxRetries: 0,
						// No tool choice, as in the session writer's request; this one carries no tools to choose.
						transport: "sse",
						cacheRetention: "none",
					},
				};
			if (!prefix)
				throw new Error("CONTEXT_WRITER_UNAVAILABLE: the session writer needs the current provider context");
			return {
				context: {
					systemPrompt: prefix.systemPrompt,
					messages: [...prefix.messages, { role: "user", content: request.instruction, timestamp: Date.now() }],
					...(prefix.tools ? { tools: [...prefix.tools] } : {}),
				},
				options: {
					...reasoning,
					maxTokens: request.maxTokens,
					signal,
					maxRetries: 0,
					// No tool choice, as in the session's own requests: the provider can then reuse the cached prefix.
					// Under "none", DeepSeek leaves the tool definitions out of the prompt, so the prefix ends after the
					// system prompt. A tool call is never run: it is declined once, and a second one refuses the note
					// with CONTEXT_WRITER_FAILED.
					transport: "sse",
					// The session's ID, as Pi sends it with the session's own requests. Pi's Codex provider uses it as
					// `prompt_cache_key`, without which the writer misses the session's cache; providers that need none
					// ignore it.
					...(prefix.sessionId ? { sessionId: prefix.sessionId } : {}),
				},
			};
		},
		declineToolCalls: (request, response) => {
			const calls = response.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
			const declined: Message[] = calls.map((call) => ({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: TOOL_CALL_DECLINED }],
				isError: true,
				timestamp: Date.now(),
			}));
			return {
				context: { ...request.context, messages: [...request.context.messages, response, ...declined] },
				options: request.options,
			};
		},
		dispatch: (request, onSent) =>
			options.registry.streamSimple(model, request.context, {
				...request.options,
				// Read, never changed: what reasoning the request carries after the host has mapped the level.
				onPayload: (payload) => {
					onSent(sentReasoning(payload));
					return undefined;
				},
			}),
		summarizeUsage,
	};
}

/**
 * Sequential chunks when fixed; at most one repair across the whole operation, for missing sources, quotations or
 * size. No model fallback. The contract is the core's; this binds the Pi transport.
 */
export async function writeMemory(options: WriteMemoryOptions): Promise<WriteMemoryResult> {
	return await coreWriteMemory(
		{
			config: options.config,
			previous: options.previous,
			increments: options.increments,
			uncovered: asRecords(options.uncovered),
			branch: asRecords(options.branch),
			noteTokens: options.noteTokens,
			baseNoteTokens: options.baseNoteTokens,
			signal: options.signal,
			customInstructions: options.customInstructions,
			activeRequests: options.activeRequests ? asRecords(options.activeRequests) : undefined,
			onProgress: options.onProgress,
			callHooks: options.callHooks,
		},
		() => piTransport(options),
	);
}
