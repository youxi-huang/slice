import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import {
	buildSessionProjection,
	type CompactionEntry,
	type CompactionSettings,
	convertToLlm,
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionContext,
	estimateTokens,
	type InputEvent,
	type InputEventResult,
	type SessionBeforeCompactEvent,
	type SessionCompactEvent,
	type SessionCompactFailedEvent,
	type SessionEntry,
	type SessionProjection,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	checkpointInterval as coreCheckpointInterval,
	chooseCut as coreChooseCut,
	prefixCut as corePrefixCut,
} from "../../../../../compaction-core/src/cuts.ts";
import {
	assertToolPairs,
	assertRecoveryEdits as coreAssertRecoveryEdits,
	requestLimit as coreRequestLimit,
} from "../../../../../compaction-core/src/guards.ts";
import { type InContext, inContextEntries } from "../../../../../compaction-core/src/history-view.ts";
import {
	checkpointLineage,
	compactedSourceTokens,
	hashEntries,
	latestMemory,
	type MemoryNote,
	noteBytes,
	renderNote,
	shrinkLineage,
	validateMemoryCheckpoints,
	validateNote,
} from "../../../../../compaction-core/src/notes.ts";
import {
	freezePreparationInput,
	type PreparationSubmission,
	reusablePrefix,
} from "../../../../../compaction-core/src/preparation-candidate.ts";
import type { SessionRecord } from "../../../../../compaction-core/src/records.ts";
import {
	applyReduction,
	declaredCacheLifetimeMs,
	type ReductionView,
	reduceRecords,
} from "../../../../../compaction-core/src/reduction.ts";
import {
	assertUserMessages,
	carriedUserMessages,
	coveredUserMessages,
	mergeWorkNotes,
	renderUserMessages,
	workNotes,
	writerSources,
} from "../../../../../compaction-core/src/work-notes.ts";
import { sessionHandoverTokens } from "../../../../../compaction-core/src/writer.ts";
import { type MemoryConfig, memoryBudget, SESSION_WRITER, selectNoteBudget, textTokens } from "../config.ts";
import { PROJECT_CODES } from "../events.ts";
import { CONTEXT_KEEP_NONE, CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION, isRecord } from "../identity.ts";
import { PREVIEW_BUILD_ID } from "./build.ts";
import type { CallJournal } from "./call-journal.ts";
import { PRIMARY_PI_VERSION, SUPPORTED_PI_LABEL, SUPPORTED_PI_VERSIONS, supportsPi } from "./compatibility.ts";
import type {
	InactiveReason,
	NotesFallback,
	PreviewCompaction,
	PreviewDiagnosis,
	PreviewFailureStoreContract,
	PreviewReadback,
	PreviewSession,
} from "./contracts.ts";
import { type AppendedExcerpt, selectExcerpts, unusedExcerpts } from "./excerpts.ts";
import { blockedNotice, inactiveNotice, NoticeGate, notify, readyNotice } from "./notices.ts";
import type { PreviewPreparation, PreviewSwitch } from "./preparation.ts";
import { projectSummary, RENDERING_OFF, type RenderingSwitch } from "./render-projection.ts";
import { setStatusLine } from "./status-line.ts";
import {
	modelName,
	resolveWriterModel,
	sumMemoryUsage,
	type WriteMemoryResult,
	type WriterProgress,
	writeMemory,
	writerContractHashes,
	writerReasoning,
} from "./writer.ts";

/** Pi's entries satisfy the core's structural record shapes; the union is widened here, never converted (records.ts). */
const asRecords = (branch: readonly SessionEntry[]): readonly SessionRecord[] =>
	branch as unknown as readonly SessionRecord[];
/** The host's own entries back from a core pass-through that returns a subset of what it was given (records.ts). */
const asEntries = (records: readonly SessionRecord[]): readonly SessionEntry[] =>
	records as unknown as readonly SessionEntry[];

const PREVIEW_CODES = new Set([
	"CONTEXT_PREVIEW_UNSUPPORTED",
	"CONTEXT_COMPACTION_CANCELLED",
	"CONTEXT_PREVIEW_PENDING",
	"CONTEXT_PREVIEW_MARKER_INVALID",
	"CONTEXT_PREVIEW_MARKER_IO",
	"CONTEXT_PREVIEW_SESSION_INVALID",
	"CONTEXT_PREVIEW_SESSION_IO",
	"CONTEXT_PREVIEW_COMMIT_UNCONFIRMED",
	"CONTEXT_PREVIEW_COMPACT_REQUIRED",
]);

/** Neither provider error text nor model output enters the failure marker or UI. */
export function previewErrorCode(error: unknown, aborted = false): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const matched = message.slice(0, 256).match(/^(?:CONTEXT|HISTORY)_[A-Z_]{1,40}\b/)?.[0];
	if (matched && (PROJECT_CODES.has(matched) || PREVIEW_CODES.has(matched))) return matched;
	return aborted ? "CONTEXT_COMPACTION_CANCELLED" : "CONTEXT_WRITER_FAILED";
}

/** Notification failures must never turn a cancelled compaction into stock fallback. */
export function reportPreviewError(
	ctx: ExtensionContext,
	code: string,
	durable = true,
	reason?: InactiveReason,
	version = VERSION,
	repeated = false,
): void {
	notify(ctx, blockedNotice(code, durable, reason, version, repeated), repeated ? "warning" : "error");
}

/** The core's tool-pairing guard, re-exported: Pi's `AgentMessage` satisfies its projected-message shape. */
export { assertToolPairs };

/**
 * The core's cut selection at the Pi boundary: the branch is widened, never converted (records.ts),
 * and Pi's own projection builder and token estimator are bound here.
 */
export function chooseCut(
	branch: readonly SessionEntry[],
	keepRecentTokens: number,
	projection: SessionProjection = buildSessionProjection([...branch]),
): number {
	return coreChooseCut(asRecords(branch), keepRecentTokens, projection, estimateTokens);
}

/** The core's prefix cut at the Pi boundary; the branch is widened, never converted (records.ts). */
export function prefixCut(
	branch: readonly SessionEntry[],
	projection: SessionProjection,
	coveredIndex: number,
	cut: number,
): number | undefined {
	return corePrefixCut(asRecords(branch), projection, coveredIndex, cut);
}

/** The interval a preparation belongs to: the latest checkpoint on the branch, or none yet. */
export function checkpointInterval(branch: readonly SessionEntry[]): string {
	return coreCheckpointInterval(asRecords(branch));
}

/**
 * Context size at which optional preparation starts: a band below Pi's threshold compaction point, 12.5% of it
 * and between 8,192 and 32,768 tokens. Pi's threshold is the window minus its effective reserveTokens.
 */
export function preparationStart(
	contextWindow: number,
	reserveTokens: number = DEFAULT_COMPACTION_SETTINGS.reserveTokens,
): number {
	const threshold = contextWindow - reserveTokens;
	return threshold - Math.min(32_768, Math.max(8_192, Math.floor(threshold * 0.125)));
}

/** Pi's own resolution of reserveTokens for a model: its per-model override, then the global value, then the default. */
export function piReserveTokens(
	settings: { compaction?: CompactionSettings } | undefined,
	model: { provider: string; id: string },
): number {
	const compaction = settings?.compaction;
	const value =
		compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens ??
		compaction?.reserveTokens ??
		DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("CONTEXT_CONFIG: invalid Pi reserveTokens");
	return value;
}

/** Pi's character estimate, four characters per token, for text no response has measured yet. */
function piTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Pi's own count of the current context, the figure its compaction trigger reads: the last response's reported
 * usage plus an estimate of what followed it. Absent until a response reports usage, as right after a checkpoint.
 * Four characters a token overstates English prose by about a tenth and serialized code by more, so guards that
 * estimated alone stopped requests well before Pi's trigger.
 */
export function measuredContextTokens(ctx: Pick<ExtensionContext, "getContextUsage">): number | undefined {
	try {
		const tokens = ctx.getContextUsage()?.tokens;
		return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the transcript carries the system prompt itself. Pi 1.4.0 records system messages in the session and then
 * sends the transcript as it stands, with no leading prompt of its own, even when the first one sits mid-history, as
 * in a session begun before 1.4.0. Earlier hosts record none and send their prompt and tools first. A writer request
 * that put them first anyway would diverge from the session's requests at the first item and miss the whole cache.
 */
export function carriesSystemPrompt(messages: readonly { role: string }[]): boolean {
	return messages.some((message) => message.role === "system");
}

/**
 * The request guard's limit: Pi's threshold, window minus Pi's default reserve. Pi compacts above it after a
 * turn or before a prompt, so a request below it is never stopped. The model's output maximum does not lower it.
 */
export function requestLimit(model: { contextWindow: number }): number {
	return coreRequestLimit(model, DEFAULT_COMPACTION_SETTINGS.reserveTokens);
}

/** The checkpoint text, shortening lineage until it fits `limit` beside the retained context. */
function fittedSummary(
	note: MemoryNote,
	branch: readonly SessionEntry[],
	retainedTokens: number,
	limit: number,
	userMessages = "",
): string | undefined {
	let lineage = checkpointLineage(asRecords(branch));
	let summary = renderNote(note, lineage) + userMessages;
	while (lineage.length && textTokens(summary) + retainedTokens > limit) {
		lineage = shrinkLineage(lineage);
		summary = renderNote(note, lineage) + userMessages;
	}
	return textTokens(summary) + retainedTokens > limit ? undefined : summary;
}

/** Pi retries omit the latest failed response without changing raw evidence or a prior checkpoint. */
export function assertRecoveryEdits(branch: readonly SessionEntry[]): void {
	coreAssertRecoveryEdits(asRecords(branch));
}

/** Abort guards can leave new user input on disk; recovery must keep that whole unfinished turn. */
function interruptedTurnStart(branch: readonly SessionEntry[]): number | undefined {
	let completed = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			(entry.message.stopReason === "stop" || entry.message.stopReason === "length")
		) {
			completed = index;
			break;
		}
	}
	if (completed < 0) throw new Error("CONTEXT_TOOL_BOUNDARY: no completed source turn precedes recovery");
	for (let index = completed + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") return index;
	}
	return undefined;
}

export function isPreviewCheckpoint(entry: SessionEntry): entry is CompactionEntry {
	return (
		entry.type === "compaction" &&
		isRecord(entry.details) &&
		entry.details.kind === CONTEXT_MEMORY_KIND &&
		typeof entry.details.build === "string" &&
		entry.details.build.startsWith("stock-preview")
	);
}

/** Entry content this preview cannot check. */
function unsupportedContent(entry: SessionEntry): InactiveReason | undefined {
	if (entry.type === "message" && "content" in entry.message && Array.isArray(entry.message.content)) {
		if (entry.message.content.some((part) => part.type === "image")) return "image";
	}
	if (entry.type === "custom_message" && Array.isArray(entry.content)) {
		if (entry.content.some((part) => part.type !== "text")) return "non-text";
	}
	return undefined;
}

/** Host or session content this preview cannot check. Read-only: no IO beyond the session object. */
export function unsupportedReason(session: PreviewSession, version: string = VERSION): InactiveReason | undefined {
	if (!supportsPi(version)) return "host";
	if (!session.getSessionFile()) return "in-memory";
	const branch = session.getBranch();
	try {
		assertRecoveryEdits(branch);
	} catch {
		return "context-edit";
	}
	if (branch.some((entry) => entry.type === "compaction" && !isPreviewCheckpoint(entry))) return "foreign-checkpoint";
	for (const entry of branch) {
		const reason = unsupportedContent(entry);
		if (reason) return reason;
	}
	return undefined;
}

const UNSUPPORTED_ERRORS: Record<InactiveReason, string> = {
	host: `CONTEXT_PREVIEW_UNSUPPORTED: this preview is validated on official Pi ${SUPPORTED_PI_LABEL}`,
	"in-memory": "CONTEXT_PREVIEW_UNSUPPORTED: a persistent session is required",
	"context-edit": "CONTEXT_PREVIEW_UNSUPPORTED: only failed-response recovery omissions are supported",
	"foreign-checkpoint":
		"CONTEXT_MIGRATION_REQUIRED: start a new preview session; existing checkpoints are not migrated",
	image: "CONTEXT_PREVIEW_UNSUPPORTED: image-bearing sessions are not supported by this preview",
	"non-text": "CONTEXT_PREVIEW_UNSUPPORTED: non-text custom messages are not supported",
};

/** The preview neither migrates existing checkpoints nor accepts a second compactor's summary. */
export function assertPreviewSession(
	session: PreviewSession,
	version: string = VERSION,
	branch?: readonly SessionEntry[],
	onSerializedEntry?: (index: number, serialized: string) => void,
): ReturnType<typeof latestMemory> {
	const reason = unsupportedReason(session, version);
	if (reason) throw new Error(UNSUPPORTED_ERRORS[reason]);
	const sources = asRecords(branch ?? session.getBranch());
	const latest = validateMemoryCheckpoints(sources, onSerializedEntry);
	assertUserMessages(sources);
	return latest;
}

function assertHashedPreviewSession(session: PreviewSession, version: string, branch?: readonly SessionEntry[]) {
	const hash = createHash("sha256");
	const checkpoint = assertPreviewSession(session, version, branch, (_index, serialized) => {
		hash.update(serialized).update("\n");
	});
	return { checkpoint, sourceHash: hash.digest("hex") };
}

/** What the last full source validation proved, reused only while the same entry objects extend it. */
interface VerifiedBranch {
	session: PreviewSession;
	sessionId: string;
	length: number;
	tip: SessionEntry | undefined;
	checkpoint: ReturnType<typeof latestMemory>;
}

export interface PreviewControllerOptions {
	config?: Readonly<MemoryConfig>;
	failureStore: PreviewFailureStoreContract;
	/** Config parse errors still install cancellation and request guards. */
	configError?: string;
	/** The running Pi version; tests substitute other releases. */
	hostVersion?: string;
	preparation?: PreviewPreparation;
	/** Records every writer call; without one, calls are observed only in memory. */
	journal?: CallJournal;
	/** Arm B: commit merged work notes without a writer call when the prefix path allows it. */
	workNotes?: PreviewSwitch;
	/** WP4's LCM-style excerpt after the user's prompt; off unless `previewExcerpts.enabled`. */
	excerpts?: PreviewSwitch;
	/**
	 * Which entries the current context shows only reduced (WP2): their full text is not in context, so retrieval
	 * leaves them unmarked and an excerpt may quote them. By default the predicate reads the reduction view;
	 * with reductions off no entry is reduced. Tests may substitute it.
	 */
	reduced?: (ctx: ExtensionContext) => (entryId: string) => boolean;
	/** WP2: deterministic reversible reductions of the projected view; off by default. */
	reduction?: PreviewSwitch;
	/** WP3: rendered-note candidates, projecting the stored summary for the model only; off by default. */
	rendering?: RenderingSwitch;
	/** Pi's effective settings, read so preparation follows Pi's actual threshold; Pi's defaults without it. */
	hostSettings?: () => { compaction?: CompactionSettings } | undefined;
}

/** All host effects pass through public extension contexts and the independent failure marker. */
export class PreviewMemoryController {
	private readonly config?: Readonly<MemoryConfig>;
	private readonly store: PreviewFailureStoreContract;
	private readonly configError?: string;
	private readonly stickyFailures = new Map<string, string>();
	private readonly observedFailures = new Map<string, string>();
	private readonly activeCompactions = new Set<string>();
	private readonly stagedCompactions = new Set<string>();
	private readonly compactionStartedAt = new Map<string, number>();
	/** Per session: the checkpoint interval in which makeRoom last started a compaction. */
	private readonly roomRequested = new Map<string, string>();
	/** Per session: Pi's measured context at the last settled turn, so makeRoom can allow for a turn of that size. */
	private readonly settledTokens = new Map<string, number>();
	readonly hostVersion: string;
	private activeTools: () => Tool[] = () => [];
	/** Per session, like every other state here, so status never mixes one session's calls with another's metrics. */
	private readonly lastProgress = new Map<string, WriterProgress>();
	private verified?: VerifiedBranch;
	private pendingSessionNotice?: { sessionId: string; key: string; text: string };
	readonly notices = new NoticeGate();
	private readonly preparation?: PreviewPreparation;
	private readonly journal?: CallJournal;
	private readonly workNotes: PreviewSwitch;
	private readonly excerpts: PreviewSwitch;
	private readonly reduced: (ctx: ExtensionContext) => (entryId: string) => boolean;
	/** Per session and process: content-free counts of appended excerpts, for status. */
	private readonly excerptCounts = new Map<
		string,
		{ appended: AppendedExcerpt[]; withheld: number; tokens: number }
	>();
	private readonly reduction: PreviewSwitch;
	private readonly rendering: RenderingSwitch;
	private readonly hostSettings: () => { compaction?: CompactionSettings } | undefined;
	/** In-memory, per session: full read-backs of entries the reduced view replaces. Counts only. */
	private readonly reducedReadBacks = new Map<string, number>();
	private readonly lastCompaction = new Map<
		string,
		{
			path: "complete" | "prefix" | "notes" | "sync";
			candidateId?: string;
			foregroundCalls: number;
			stageMs: number;
			pauseMs?: number;
			diskConfirmed: boolean;
		}
	>();

	constructor(options: PreviewControllerOptions) {
		this.config = options.config;
		this.store = options.failureStore;
		this.configError = options.configError;
		this.hostVersion = options.hostVersion ?? VERSION;
		this.preparation = options.preparation;
		this.journal = options.journal;
		this.workNotes = options.workNotes ?? { enabled: false };
		this.excerpts = options.excerpts ?? { enabled: false };
		this.reduction = options.reduction ?? { enabled: false };
		this.rendering = options.rendering ?? RENDERING_OFF;
		this.hostSettings = options.hostSettings ?? (() => undefined);
		this.reduced =
			options.reduced ??
			((ctx) => {
				const view = this.reducedView(ctx.sessionManager.getBranch(), ctx.model ?? undefined);
				const reducedIds = new Set((view?.entries ?? []).map((entry) => entry.recordId));
				return (entryId: string) => reducedIds.has(entryId);
			});
	}

	/**
	 * The deterministic reduced view of this branch, or none. Off, invalid or absent configuration
	 * and any classification error all leave requests unreduced: a reduction has no failure state
	 * and never stands in for a failed compaction.
	 */
	private reducedView(
		branch: readonly SessionEntry[],
		model: { promptCache?: { short?: number; long?: number } } | undefined,
	): ReductionView | undefined {
		if (!this.reduction.enabled) return undefined;
		try {
			const view = reduceRecords(branch, declaredCacheLifetimeMs(model));
			return view.entries.length ? view : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * The checkpoint text the model sees (WP3): the stored summary byte for byte, or the rendered-note
	 * projection derived from the stored note, lineage and records by the pure `projectSummary`. Both
	 * recovery-presence guards derive their expectation here, so the payload stays bound to the
	 * committed note. Off, invalid or absent configuration and any projection error all leave the
	 * stored rendering in place: a projection has no failure state of its own.
	 */
	private projectedSummary(
		checkpoint: NonNullable<ReturnType<typeof latestMemory>>,
		branch: readonly SessionEntry[],
	): string {
		if (!this.rendering.enabled || !this.rendering.candidates.length) return checkpoint.entry.summary;
		try {
			return projectSummary({
				summary: checkpoint.entry.summary,
				note: checkpoint.memory.note,
				entryId: checkpoint.entry.id,
				branch,
				candidates: this.rendering.candidates,
			});
		} catch {
			return checkpoint.entry.summary;
		}
	}

	/** Count a full read-back of an entry the current reduced view replaces; counts only, no content. */
	recordHistoryRead(ctx: ExtensionContext, entryId: string): void {
		try {
			if (!this.reduction.enabled) return;
			const view = this.reducedView(ctx.sessionManager.getBranch(), ctx.model ?? undefined);
			if (!view?.entries.some((entry) => entry.recordId === entryId)) return;
			const sessionId = ctx.sessionManager.getSessionId();
			this.reducedReadBacks.set(sessionId, (this.reducedReadBacks.get(sessionId) ?? 0) + 1);
		} catch {
			// Counting is advisory; the read itself is served from the original records regardless.
		}
	}

	bindTools(tools: () => Tool[]): void {
		this.activeTools = tools;
	}

	private preparationSubmission(ctx: ExtensionContext, customInstructions?: string): PreparationSubmission {
		if (!this.config || !ctx.model || !this.preparation) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
		const model = resolveWriterModel(this.config, ctx.modelRegistry, ctx.model);
		const branch = ctx.sessionManager.getBranch();
		const previous = latestMemory(asRecords(branch));
		const projection = ctx.sessionManager.buildSessionProjection();
		const budget = memoryBudget(ctx.model, this.config);
		const cut = chooseCut(branch, budget.recentTokens, projection);
		const active = new Set(
			projection.entries.filter((entry) => entry.messages.length).map((entry) => entry.sourceEntry.id),
		);
		return {
			sessionId: ctx.sessionManager.getSessionId(),
			epoch: this.preparation.currentEpoch,
			branch: asRecords(branch),
			writer: {
				role: this.config.writerModel === SESSION_WRITER ? "session" : "fixed",
				model: modelName(model),
				effort: writerReasoning(model, this.config, ctx.thinkingLevel),
				policyHash: hashEntries([
					{ writerModel: this.config.writerModel, writerEffort: this.config.writerEffort, model },
				]),
				...writerContractHashes(PREVIEW_BUILD_ID),
				contextHash:
					this.config.writerModel === SESSION_WRITER
						? hashEntries([ctx.getSystemPrompt(), this.activeTools()])
						: null,
			},
			noteBudget: selectNoteBudget(
				this.config,
				budget.threshold,
				compactedSourceTokens(asRecords(branch.slice(0, cut).filter((entry) => active.has(entry.id)))),
				previous ? Math.ceil(noteBytes(previous.memory.note) / 3) : 0,
			),
			customInstructions,
		};
	}

	/**
	 * A settled turn may start optional preparation, once per checkpoint interval, when the context has entered
	 * the band just below Pi's compaction threshold. No commit state is entered here.
	 */
	prepare(ctx: ExtensionContext): void {
		if (!this.preparation?.enabled || !this.config || !ctx.model) return;
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			const interval = checkpointInterval(ctx.sessionManager.getBranch());
			if (!this.preparation.mayStart(sessionId, interval)) return;
			const usage = ctx.getContextUsage();
			if (!usage?.tokens) return;
			if (usage.tokens < preparationStart(usage.contextWindow, piReserveTokens(this.hostSettings(), ctx.model)))
				return;
			if (this.safeInactive(ctx) || this.configError || ctx.hasPendingMessages()) return;
			assertPreviewSession(ctx.sessionManager, this.hostVersion);
			if (this.store.inspect(ctx.sessionManager).state !== "ready" || this.stickyFailures.has(sessionId)) return;
			const projection = ctx.sessionManager.buildSessionProjection();
			assertToolPairs(projection.messages);
			const last = [...projection.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "assistant" || !(last.stopReason === "stop" || last.stopReason === "length")) return;
			this.preparation.activate(sessionId);
			const submission = this.preparationSubmission(ctx);
			const branch = structuredClone(ctx.sessionManager.getBranch());
			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) return;
			const previous = latestMemory(asRecords(branch));
			const uncovered = asEntries(writerSources(asRecords(branch), previous));
			const input = freezePreparationInput({
				...submission,
				branch: asRecords(branch),
				coveredThrough: leafId,
				processedUserEntryIds: branch
					.filter((entry) => entry.type === "message" && entry.message.role === "user")
					.map((entry) => entry.id),
			});
			const model = structuredClone(resolveWriterModel(this.config, ctx.modelRegistry, ctx.model));
			const sessionModel = structuredClone(ctx.model);
			const registry = ctx.modelRegistry;
			const capturedRegistry = {
				find: (provider: string, id: string) =>
					provider === model.provider && id === model.id ? model : undefined,
				hasConfiguredAuth: registry.hasConfiguredAuth.bind(registry),
				streamSimple: registry.streamSimple.bind(registry),
			};
			const increments = workNotes(asRecords(branch), previous?.memory.coveredThrough).map((item) => item.note);
			// The prepared writer call reads the same reduced prefix the session's own requests carry (G4).
			const reductionView = this.reducedView(branch, ctx.model);
			const messages = structuredClone(
				convertToLlm(reductionView ? applyReduction(projection.messages, reductionView) : projection.messages),
			);
			const prefix = carriesSystemPrompt(messages)
				? { messages, sessionId }
				: { messages, sessionId, systemPrompt: ctx.getSystemPrompt(), tools: structuredClone(this.activeTools()) };
			const config = { ...this.config, noteRepair: false };
			const thinking = ctx.thinkingLevel;
			this.preparation.start(
				{
					input,
					run: (signal, callHooks) =>
						writeMemory({
							config,
							registry: capturedRegistry,
							sessionModel,
							sessionThinkingLevel: thinking,
							prefix: config.writerModel === SESSION_WRITER ? prefix : undefined,
							previous: previous?.memory.note,
							increments,
							uncovered,
							branch,
							noteTokens: submission.noteBudget.hardTokens,
							baseNoteTokens: submission.noteBudget.baseTokens,
							signal,
							callHooks,
						}),
				},
				interval,
			);
		} catch {
			// Optional work must never call fail(), begin() or abort the user's task.
		}
	}

	invalidatePreparation(reason: string): void {
		this.preparation?.invalidate(reason);
	}

	shutdownPreparation(): void {
		this.preparation?.dispose();
	}

	/**
	 * A session is protected once this package has written a checkpoint for it or recorded a pending
	 * or failed attempt. Those durable claims, never content alone, decide strict blocking.
	 */
	protected(ctx: ExtensionContext): boolean {
		const session = ctx.sessionManager;
		const sessionId = session.getSessionId();
		return (
			this.stickyFailures.has(sessionId) ||
			this.activeCompactions.has(sessionId) ||
			session.getEntries().some(isPreviewCheckpoint) ||
			this.store.markerPresent(session)
		);
	}

	/** The reason this preview stands aside, for a session it does not protect and cannot check. */
	inactive(ctx: ExtensionContext): InactiveReason | undefined {
		const reason = unsupportedReason(ctx.sessionManager, this.hostVersion);
		return reason && !this.protected(ctx) ? reason : undefined;
	}

	/** Request paths fail closed: if classification itself fails, the ordinary guards decide. */
	safeInactive(ctx: ExtensionContext): InactiveReason | undefined {
		try {
			return this.inactive(ctx);
		} catch {
			return undefined;
		}
	}

	/** Read-only: calls no model, writes no marker and latches no failure. */
	diagnose(ctx: ExtensionContext): PreviewDiagnosis {
		const session = ctx.sessionManager;
		const reason = unsupportedReason(session, this.hostVersion);
		const isProtected = this.protected(ctx);
		const inactive = reason !== undefined && !isProtected;
		let checkpointId: string | undefined;
		let state: PreviewDiagnosis["state"] = "inactive";
		let code: string | undefined;
		// compact() runs the same configuration and session checks first, so a failure here is not retryable.
		let compactCannotClear = false;
		let recover = false;
		if (!inactive) {
			const stored = this.store.inspect(session);
			state = stored.state;
			code = this.configError ?? this.stickyFailures.get(session.getSessionId()) ?? stored.code;
			compactCannotClear = this.configError !== undefined || !this.config;
			try {
				assertPreviewSession(session, this.hostVersion);
				const latest = latestMemory(asRecords(session.getBranch()));
				checkpointId = latest?.entry.id;
				// The conditions recover() checks before its readback: a staged checkpoint at the leaf and a record.
				const leaf = session.getLeafEntry();
				recover =
					state !== "ready" &&
					leaf?.type === "compaction" &&
					latest?.entry.id === leaf.id &&
					this.store.markerPresent(session);
			} catch (error) {
				code = previewErrorCode(error);
				compactCannotClear = true;
			}
			if (code && code !== stored.code) state = "blocked";
		}
		let writer: string | undefined;
		let writerError: string | undefined;
		if (this.config) {
			try {
				writer = modelName(resolveWriterModel(this.config, ctx.modelRegistry, ctx.model));
			} catch (error) {
				writerError = previewErrorCode(error);
			}
		}
		let contextTokens: number | null = null;
		try {
			contextTokens = ctx.getContextUsage()?.tokens ?? null;
		} catch {
			// Usage is advisory and may be unavailable before the first response.
		}
		const last = [...session.buildSessionProjection().messages]
			.reverse()
			.find((message) => message.role !== "system");
		const idle = !ctx.hasPendingMessages();
		const completed = last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
		// compact() also accepts a turn that ended in an error, an abort or unanswered input when it retries.
		const terminated =
			last?.role === "user" ||
			(last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted"));
		let manual: PreviewDiagnosis["manualCompaction"]["preview"];
		if (inactive) manual = "not-active";
		else if (compactCannotClear || writerError) manual = "blocked";
		else if (state === "ready") manual = completed && idle ? "ready" : "waiting-for-turn";
		else manual = (completed || terminated) && idle ? "retry" : "waiting-for-turn";
		return {
			build: PREVIEW_BUILD_ID,
			host: this.hostVersion,
			supportedHost: PRIMARY_PI_VERSION,
			supportedHosts: SUPPORTED_PI_VERSIONS,
			protection: inactive ? "not-protected" : isProtected ? "protected" : "eligible",
			...(reason ? { reason } : {}),
			state,
			...(code ? { code } : {}),
			writer,
			writerError,
			checkpointId,
			manualCompaction: {
				preview: manual,
				recover,
				pi: "unknown",
				contextTokens,
				piDefaultKeepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
			},
		};
	}

	/** Machine-readable status. Earlier fields keep their names; protection and eligibility are additions. */
	status(ctx: ExtensionContext) {
		const diagnosis = this.diagnose(ctx);
		let prepared: ReturnType<PreviewPreparation["status"]> | undefined;
		if (this.preparation) {
			try {
				prepared = this.preparation.status(this.preparation.enabled ? this.preparationSubmission(ctx) : undefined);
			} catch {
				prepared = { ...this.preparation.status(), state: "paused", reason: "writer-or-source-unavailable" };
			}
		}
		const sessionId = ctx.sessionManager.getSessionId();
		const lastCompaction = this.lastCompaction.get(sessionId);
		const excerpted = this.excerptCounts.get(sessionId);
		let calls: ReturnType<CallJournal["summary"]> | undefined;
		try {
			calls = this.journal?.summary(sessionId);
		} catch {
			// The journal is advisory for status; its own gap state is reported when it can be read.
		}
		// Content-free reduction counts: never entry text or IDs.
		let reduction:
			| {
					enabled: boolean;
					reason?: string;
					entriesReduced?: number;
					estimatedTokensRemoved?: number;
					readBacks?: number;
			  }
			| undefined;
		if (this.reduction.enabled) {
			let view: ReductionView | undefined;
			try {
				view = this.reducedView(ctx.sessionManager.getBranch(), ctx.model ?? undefined);
			} catch {
				// A reduction has no failure state; status then reports an unreduced view.
			}
			reduction = {
				enabled: true,
				entriesReduced: view?.entries.length ?? 0,
				estimatedTokensRemoved: view?.tokensRemoved ?? 0,
				readBacks: this.reducedReadBacks.get(sessionId) ?? 0,
			};
		} else if (this.reduction.error) {
			reduction = { enabled: false, reason: this.reduction.error };
		}
		// Content-free rendering state (WP3): the switch and its candidate names, never summary text.
		let rendering: { enabled: boolean; candidates?: string[]; reason?: string } | undefined;
		if (this.rendering.enabled) {
			rendering = { enabled: true, candidates: [...this.rendering.candidates] };
		} else if (this.rendering.error) {
			rendering = { enabled: false, reason: this.rendering.error };
		}
		return {
			build: diagnosis.build,
			enabled: this.config?.enabled ?? true,
			state: diagnosis.state,
			...(diagnosis.code ? { code: diagnosis.code } : {}),
			writerModel: this.config?.writerModel,
			writer: diagnosis.writer,
			writerError: diagnosis.writerError,
			checkpointId: diagnosis.checkpointId,
			noteBudgetMode: this.config?.noteTokens === undefined ? "tiered" : "fixed",
			noteRepair: this.config?.noteRepair,
			// Threshold compaction after a completed turn is handled; overflow recovery still needs /compact.
			manualOnly: false,
			lastWriter: this.lastProgress.get(sessionId),
			host: diagnosis.host,
			supportedHost: diagnosis.supportedHost,
			supportedHosts: diagnosis.supportedHosts,
			protection: diagnosis.protection,
			...(diagnosis.reason ? { reason: diagnosis.reason } : {}),
			manualCompaction: diagnosis.manualCompaction,
			...(prepared ? { preparation: prepared } : {}),
			...(reduction ? { reduction } : {}),
			...(rendering ? { rendering } : {}),
			...(calls ? { calls } : {}),
			...(lastCompaction ? { lastCompaction } : {}),
			// Counts only, never record text or IDs; `tokens` is retrieval usage, apart from any writer usage.
			excerpts: {
				enabled: this.excerpts.enabled,
				...(this.excerpts.error ? { error: this.excerpts.error } : {}),
				appended: excerpted?.appended.length ?? 0,
				unused: excerpted ? unusedExcerpts(excerpted.appended, ctx.sessionManager.getBranch()) : 0,
				withheld: excerpted?.withheld ?? 0,
				tokens: excerpted?.tokens ?? 0,
			},
		};
	}

	/**
	 * Request guard. Sources and checkpoints are validated in full at trust boundaries: session start, a branch
	 * change, a new checkpoint, compaction, recovery and after any failure. Between them a request checks only
	 * the entries added since, and the store checks the session file's identity and length.
	 */
	assertReady(ctx: ExtensionContext): ReturnType<typeof latestMemory> {
		if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
		const session = ctx.sessionManager;
		const branch = session.getBranch();
		let checkpoint: ReturnType<typeof latestMemory>;
		let serializedBranch: string[] | undefined;
		if (this.verified && this.extendsVerified(this.verified, session, branch)) {
			checkpoint = this.verified.checkpoint;
		} else {
			this.verified = undefined;
			const serialized: string[] = [];
			checkpoint = assertPreviewSession(session, this.hostVersion, branch, (_index, text) => serialized.push(text));
			serializedBranch = serialized;
		}
		const sticky = this.stickyFailures.get(session.getSessionId());
		if (sticky) throw new Error(sticky);
		this.store.assertReady(session, serializedBranch);
		this.verified = {
			session,
			sessionId: session.getSessionId(),
			length: branch.length,
			tip: branch.at(-1),
			checkpoint,
		};
		return checkpoint;
	}

	/** The same entry objects as the last full validation, followed only by ordinary new entries. */
	private extendsVerified(
		verified: VerifiedBranch,
		session: PreviewSession,
		branch: readonly SessionEntry[],
	): boolean {
		if (verified.session !== session || verified.sessionId !== session.getSessionId()) return false;
		if (branch.length < verified.length || branch[verified.length - 1] !== verified.tip) return false;
		for (let index = verified.length; index < branch.length; index++) {
			const entry = branch[index];
			// A new checkpoint, a recovery edit or unsupported content needs the full validation and its error.
			if (entry.type === "compaction" || entry.type === "context_edit" || unsupportedContent(entry)) return false;
		}
		return true;
	}

	/** The next request validates sources and reads the session file back in full. */
	private forgetVerified(): void {
		this.verified = undefined;
		this.store.forgetReadback();
	}

	/** Tree navigation is a trust boundary, even when the selected branch extends the previous one. */
	branchChanged(ctx: ExtensionContext): void {
		this.forgetVerified();
		if (this.stickyFailures.has(ctx.sessionManager.getSessionId())) {
			setStatusLine(ctx, "paused");
		} else if (unsupportedReason(ctx.sessionManager, this.hostVersion)) {
			setStatusLine(ctx, ctx.sessionManager.getEntries().some(isPreviewCheckpoint) ? "paused" : undefined);
		} else if (this.configError || !this.config) {
			setStatusLine(ctx, undefined);
		} else {
			this.readyStatus(ctx);
		}
	}

	private readyStatus(ctx: ExtensionContext): void {
		setStatusLine(ctx, ctx.sessionManager.getBranch().filter(isPreviewCheckpoint).length);
	}

	/** Text typed while paused goes back to the editor instead of into the session. */
	input(event: InputEvent, ctx: ExtensionContext): InputEventResult | undefined {
		this.showSessionNotice(ctx);
		const code =
			event.source === "interactive" && ctx.hasUI && !event.images?.length
				? this.stickyFailures.get(ctx.sessionManager.getSessionId())
				: undefined;
		// Messages Pi queued during a compaction arrive one at a time, before its failure event:
		// later ones join the first one's text and notice.
		const draft = code ? ctx.ui.getEditorText() : "";
		const joins = draft.trim() !== "";
		if (!joins) this.notices.nextEpisode();
		if (!code) return;
		if (!joins) this.reportBlocked(ctx, code);
		ctx.ui.setEditorText(joins ? `${draft}\n\n${event.text}` : event.text);
		return { action: "handled" };
	}

	/** In-process stickiness covers a marker write that failed before it could reach disk. */
	fail(ctx: ExtensionContext, code: string): void {
		this.pendingSessionNotice = undefined;
		this.forgetVerified();
		const sessionId = ctx.sessionManager.getSessionId();
		this.observedFailures.set(sessionId, code);
		this.stickyFailures.set(sessionId, code);
		setStatusLine(ctx, "paused");
		try {
			this.store.fail(ctx.sessionManager, code);
		} catch (error) {
			this.stickyFailures.set(sessionId, previewErrorCode(error));
		}
	}

	/** At most one blocking notice per session for each user input or manual compaction attempt. */
	reportBlocked(ctx: ExtensionContext, code: string, durable = true): void {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!this.notices.blockedOnce(sessionId)) return;
			reportPreviewError(
				ctx,
				code,
				durable,
				unsupportedReason(ctx.sessionManager, this.hostVersion),
				this.hostVersion,
				durable && this.notices.repeated(sessionId, code),
			);
		} catch {
			// Notices are advisory; the abort and any marker have already taken effect.
		}
	}

	/** Called once per session start: one short notice, never a marker for a session the preview does not protect. */
	sessionStart(ctx: ExtensionContext): void {
		this.pendingSessionNotice = undefined;
		this.forgetVerified();
		this.preparation?.activate(ctx.sessionManager.getSessionId());
		// Pi shows "Session compacted" after session_start, and that status rewrites info notices not yet drawn.
		const deferNotice = ctx.hasUI && ctx.sessionManager.getEntries().some((entry) => entry.type === "compaction");
		const reason = this.safeInactive(ctx);
		if (reason) {
			this.standAside(ctx, reason, deferNotice);
			return;
		}
		if (this.guard(ctx, () => this.assertReady(ctx))) {
			this.readyStatus(ctx);
			this.sessionNotice(ctx, "ready", readyNotice(), deferNotice);
		}
	}

	private sessionNotice(ctx: ExtensionContext, key: string, text: string, defer = false): void {
		if (defer) {
			this.pendingSessionNotice = { sessionId: ctx.sessionManager.getSessionId(), key, text };
		} else if (this.notices.once(key)) {
			notify(ctx, text, "info");
		}
	}

	/** The first input arrives after Pi has drawn the reopened session. */
	private showSessionNotice(ctx: ExtensionContext): void {
		const pending = this.pendingSessionNotice;
		this.pendingSessionNotice = undefined;
		if (pending?.sessionId === ctx.sessionManager.getSessionId()) {
			this.sessionNotice(ctx, pending.key, pending.text);
		}
	}

	/** The preview leaves this session to Pi; say so once per session and process. */
	standAside(ctx: ExtensionContext, reason: InactiveReason, deferNotice = false): void {
		setStatusLine(ctx, undefined);
		this.sessionNotice(
			ctx,
			`inactive:${ctx.sessionManager.getSessionId()}:${reason}`,
			inactiveNotice(reason, this.hostVersion),
			deferNotice,
		);
	}

	/**
	 * Stock Pi catches extension exceptions: abort is necessary before reporting any guard failure.
	 * A protected session records the failure durably; for a session the preview has not enrolled,
	 * only the current request is stopped and the check runs again next time.
	 */
	guard(ctx: ExtensionContext, operation: () => void): boolean {
		try {
			operation();
			return true;
		} catch (error) {
			const code = previewErrorCode(error);
			let durable = true;
			try {
				durable = this.protected(ctx);
			} catch {
				// An unclassifiable session is treated as protected, so the failure is recorded.
			}
			if (durable) this.fail(ctx, code);
			ctx.abort();
			this.reportBlocked(ctx, code, durable);
			return false;
		}
	}

	context(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[] {
		const reason = this.safeInactive(ctx);
		if (reason) {
			this.standAside(ctx, reason);
			return messages;
		}
		let projected = messages;
		let headroom = 0;
		const ready = this.guard(ctx, () => {
			const checkpoint = this.assertReady(ctx);
			if (!ctx.model || !this.config) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
			if (checkpoint) {
				// WP3: the expected text is derived from the committed note by the same pure function as
				// `beforeRequest`'s payload check. Pi restores the stored bytes from the session; the second
				// pass of this handler (`context_with_system`) sees the projection the first pass substituted.
				// Anything else is a tampered rendering and is refused.
				const expected = this.projectedSummary(checkpoint, ctx.sessionManager.getBranch());
				const restored = messages.filter((message) => message.role === "compactionSummary");
				if (
					restored.length !== 1 ||
					(restored[0].summary !== checkpoint.entry.summary && restored[0].summary !== expected)
				) {
					throw new Error("CONTEXT_RECOVERY_MISSING: the validated checkpoint is missing from model context");
				}
				if (restored[0].summary !== expected) {
					const stored = restored[0];
					projected = messages.map((message) => (message === stored ? { ...stored, summary: expected } : message));
				}
			}
			// The reduced view changes only the projection: summaries are never reduced, pairing is kept,
			// and the token estimate below measures what the request actually carries. Order cannot matter:
			// reduction touches only tool results and the WP3 projection only the compactionSummary message.
			const view = this.reducedView(ctx.sessionManager.getBranch(), ctx.model);
			if (view) projected = applyReduction(projected, view);
			assertToolPairs(projected);
			const estimate =
				measuredContextTokens(ctx) ??
				projected.reduce((sum, message) => sum + estimateTokens(message), 0) +
					(carriesSystemPrompt(projected) ? 0 : piTokens(ctx.getSystemPrompt()));
			const limit = requestLimit(ctx.model);
			if (estimate > limit) throw new Error("CONTEXT_INPUT_TOO_LARGE");
			headroom = limit - estimate;
		});
		// Note candidates already appear in context as the model's own tool calls. Re-injecting them
		// under another role would change their authority and invalidate the provider prefix cache.
		// Reduction runs first, so the excerpt's shown-term check reads the reduced stubs (G4, WP4 seam).
		return ready && this.excerpts.enabled ? this.withExcerpts(projected, ctx, headroom) : projected;
	}

	/** Whether an entry's full text is in this session's current context: projected and not reduced. Built on first use. */
	inContext(ctx: ExtensionContext): InContext {
		let marks: InContext | undefined;
		return (entryId) => {
			marks ??= inContextEntries(ctx.sessionManager.buildSessionProjection(), this.reduced(ctx));
			return marks(entryId);
		};
	}

	/**
	 * WP4's excerpt, appended after the user's prompt on the request that ends with it, the turn's first. Every
	 * message before it is the session's own projection, unchanged, so the provider's cached prefix is untouched; the
	 * turn's later requests end in tool results and carry none, so no request's prefix ever holds one. Pi uses the
	 * returned messages for this request only, so the excerpt enters no session record. It is appended only within the
	 * request limit, and any failure leaves the request as it was: excerpts never enter the failure contract.
	 */
	private withExcerpts(messages: AgentMessage[], ctx: ExtensionContext, headroom: number): AgentMessage[] {
		try {
			if (messages.at(-1)?.role !== "user") return messages;
			const session = ctx.sessionManager;
			const outside = [
				...(carriesSystemPrompt(messages) ? [] : [ctx.getSystemPrompt()]),
				...this.activeTools().map(
					(tool) => `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters)}`,
				),
			];
			const appended = selectExcerpts({
				messages,
				outside,
				branch: session.getBranch(),
				inContext: this.inContext(ctx),
			});
			if (!appended || estimateTokens(appended.message) > headroom) return messages;
			const sessionId = session.getSessionId();
			const counts = this.excerptCounts.get(sessionId) ?? { appended: [], withheld: 0, tokens: 0 };
			const anchorId = session.getLeafId();
			for (const item of appended.items) {
				if ("withheld" in item) counts.withheld++;
				else counts.appended.push({ entryId: item.entryId, anchorId });
			}
			counts.tokens += appended.tokens;
			this.excerptCounts.set(sessionId, counts);
			return [...messages, appended.message];
		} catch {
			return messages;
		}
	}

	beforeRequest(payload: unknown, ctx: ExtensionContext): void {
		if (this.safeInactive(ctx)) return;
		this.guard(ctx, () => {
			const checkpoint = this.assertReady(ctx);
			if (!ctx.model || !this.config) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
			const serialized = JSON.stringify(payload);
			// The same derivation as `context`: with a rendering candidate active the payload must carry the
			// projection of the committed note, so a stored-only or tampered rendering is refused here too.
			if (
				checkpoint &&
				!serialized?.includes(
					JSON.stringify(this.projectedSummary(checkpoint, ctx.sessionManager.getBranch())).slice(1, -1),
				)
			) {
				throw new Error("CONTEXT_RECOVERY_MISSING: the provider payload lost the validated checkpoint");
			}
			// Pi's measured count already holds the system prompt and tool schemas as the provider counted them. Before a
			// response has reported usage, the serialized request stands in, JSON escaping included, so only a payload
			// beyond the window is stopped.
			if ((measuredContextTokens(ctx) ?? piTokens(serialized ?? "")) > ctx.model.contextWindow)
				throw new Error("CONTEXT_PAYLOAD_TOO_LARGE");
		});
	}

	/**
	 * Whether Pi's threshold compaction may run now: a completed turn, no queued input and a session that is
	 * not blocked. Otherwise it is left for a later settled turn and nothing is recorded; a blocked session
	 * still needs an explicit /compact.
	 */
	thresholdReady(ctx: ExtensionContext): boolean {
		try {
			const session = ctx.sessionManager;
			if (this.configError || !this.config || ctx.hasPendingMessages()) return false;
			if (this.stickyFailures.has(session.getSessionId()) || this.store.inspect(session).state !== "ready")
				return false;
			const last = [...session.buildSessionProjection().messages]
				.reverse()
				.find((message) => message.role !== "system");
			return last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
		} catch {
			return false;
		}
	}

	/**
	 * The session writer continues the session's own context, so its handover needs room beside it: the note's output
	 * reserve and the handover request. Pi's default reserve leaves 16,384 tokens, which on a 272,000-token route is
	 * less than a handover takes, so a session that reached Pi's trigger could not compact. A settled turn whose
	 * context, with one more turn, would leave the handover no room starts the compaction /compact would, once per
	 * checkpoint interval. One more turn is Pi's default reserve or the growth of the turn just settled, whichever is
	 * larger: on GPT-6 Luna a turn that read four source files added 21,000 tokens and reached the request guard
	 * mid-turn. Returns whether it started one. A failure takes the usual path; when Pi's own trigger sits lower it
	 * runs first and leaves nothing to do here.
	 */
	makeRoom(ctx: ExtensionContext): boolean {
		try {
			if (!this.config || this.configError || this.config.writerModel !== SESSION_WRITER || !ctx.model) return false;
			// A one-shot run exits once its turn settles, before a compaction started here could finish; Pi's own
			// trigger runs inside the turn and is left to it.
			if (ctx.mode === "print" || ctx.mode === "json") return false;
			const tokens = measuredContextTokens(ctx);
			const window = ctx.model.contextWindow;
			const sessionId = ctx.sessionManager.getSessionId();
			const settled = this.settledTokens.get(sessionId);
			if (tokens === undefined) this.settledTokens.delete(sessionId);
			else this.settledTokens.set(sessionId, tokens);
			if (tokens === undefined || tokens < window / 2) return false;
			const nextTurn = Math.max(
				DEFAULT_COMPACTION_SETTINGS.reserveTokens,
				settled === undefined ? 0 : tokens - settled,
			);
			if (this.activeCompactions.has(sessionId) || this.safeInactive(ctx) || !this.thresholdReady(ctx)) return false;
			const branch = ctx.sessionManager.getBranch();
			const interval = checkpointInterval(branch);
			if (this.roomRequested.get(sessionId) === interval) return false;
			const records = asRecords(branch);
			const previous = latestMemory(records);
			const uncovered = writerSources(records, previous);
			const policy = selectNoteBudget(
				this.config,
				memoryBudget(ctx.model, this.config).threshold,
				compactedSourceTokens(uncovered),
				previous ? Math.ceil(noteBytes(previous.memory.note) / 3) : 0,
			);
			const handover = sessionHandoverTokens({
				maxOutputTokens: ctx.model.maxTokens,
				previous: previous?.memory.note,
				increments: workNotes(records, previous?.memory.coveredThrough).map((item) => item.note),
				uncovered,
				branch: records,
				noteTokens: policy.hardTokens,
				baseNoteTokens: policy.baseTokens,
			});
			if (tokens + nextTurn + handover <= window) return false;
			this.roomRequested.set(sessionId, interval);
			ctx.compact();
			return true;
		} catch {
			// Advisory: Pi's own trigger and /compact remain.
			return false;
		}
	}

	async compact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<PreviewCompaction> {
		const started = performance.now();
		this.forgetVerified();
		this.compactionStartedAt.set(ctx.sessionManager.getSessionId(), started);
		this.preparation?.cancel("compaction");
		this.activeCompactions.add(ctx.sessionManager.getSessionId());
		this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
		setStatusLine(ctx, "writing");
		try {
			if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
			const branch = structuredClone(ctx.sessionManager.getBranch());
			const { checkpoint: previous, sourceHash: branchHash } = assertHashedPreviewSession(
				ctx.sessionManager,
				this.hostVersion,
				branch,
			);
			// Pi's threshold compaction runs after a completed turn, exactly where /compact may run.
			if (!(event.reason === "manual" || event.reason === "threshold") || event.willRetry) {
				throw new Error("CONTEXT_PREVIEW_COMPACT_REQUIRED: overflow recovery needs an explicit /compact");
			}
			event.signal.throwIfAborted();
			const projection = ctx.sessionManager.buildSessionProjection();
			assertToolPairs(projection.messages);
			const last = [...projection.messages].reverse().find((message) => message.role !== "system");
			const completed = last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length");
			const readback: PreviewReadback = {};
			// status() latches a newly observed failure and fills the readback a retry's begin() reuses; a failure
			// already sticky in this process skips it, as it always has.
			if (!this.stickyFailures.has(ctx.sessionManager.getSessionId()))
				this.store.status(ctx.sessionManager, branchHash, readback);
			// A turn that ended on a provider error, an abort or a stopped request is over, not running: it is kept
			// whole after the checkpoint, so /compact may follow it at once. Requiring a recorded failure first paused
			// the session for nothing, as when a request guard's own notice said to run /compact.
			const terminated =
				last?.role === "user" ||
				(last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted"));
			if (!last || !(completed || terminated) || ctx.hasPendingMessages()) {
				throw new Error("CONTEXT_TOOL_BOUNDARY: manual compaction requires a completed turn with no queued input");
			}
			if (!ctx.model || !ctx.sessionManager.getLeafId()) throw new Error("CONTEXT_NO_MODEL_OR_SOURCE");
			// Only an explicit manual retry replaces blocked/pending with a new durable pending attempt.
			const attempt = this.store.begin(ctx.sessionManager, event.reason === "manual", branchHash, readback);
			this.observedFailures.delete(attempt.sessionId);
			const snapshot = {
				sessionId: attempt.sessionId,
				leafId: attempt.leafId,
				lastCheckpointId: attempt.lastCheckpointId,
			};
			if (hashEntries(branch) !== attempt.sourceHash) throw new Error("CONTEXT_SOURCE_CHANGED");
			const budget = memoryBudget(ctx.model, this.config);
			const interrupted = !completed ? interruptedTurnStart(branch) : undefined;
			const cut = Math.min(chooseCut(branch, budget.recentTokens, projection), interrupted ?? branch.length);
			if (cut < 1) throw new Error("CONTEXT_NO_CUT");
			const retainedFrom = (start: number) => {
				const ids = new Set(branch.slice(start).map((entry) => entry.id));
				return projection.entries
					.filter((entry) => entry.sourceEntry.type !== "compaction" && ids.has(entry.sourceEntry.id))
					.flatMap((entry) => entry.messages);
			};
			let kept = retainedFrom(cut);
			assertToolPairs(kept);
			let firstKeptEntryId = cut < branch.length ? branch[cut].id : CONTEXT_KEEP_NONE;
			let coveredIndex = branch.length - 1;
			// Notes kept after an earlier prefix checkpoint are still candidates for the next one.
			const notes = workNotes(asRecords(branch), previous?.memory.coveredThrough);
			const increments = notes.map((item) => item.note);
			const activeIds = new Set(
				projection.entries.filter((entry) => entry.messages.length > 0).map((entry) => entry.sourceEntry.id),
			);
			const released = branch.slice(0, cut).filter((entry) => activeIds.has(entry.id));
			const policy = selectNoteBudget(
				this.config,
				budget.threshold,
				compactedSourceTokens(asRecords(released)),
				previous ? Math.ceil(noteBytes(previous.memory.note) / 3) : 0,
			);
			let projectedMessages = [...projection.messages];
			// The unfinished turn stays verbatim after the checkpoint, so the session writer's prefix ends before it.
			// Ending it on that turn's unanswered request led the writer to answer the request instead of writing the
			// note. The prefix still continues the session's earlier requests, so the cache holds.
			if (interrupted !== undefined) {
				const first = projection.entries.find((entry) => entry.sourceEntry.id === branch[interrupted].id)
					?.messages[0];
				const at = first ? projectedMessages.indexOf(first) : -1;
				if (at >= 0) projectedMessages = projectedMessages.slice(0, at);
			}
			while (projectedMessages.length) {
				const tail = projectedMessages[projectedMessages.length - 1];
				if (tail.role === "assistant" && (tail.stopReason === "error" || tail.stopReason === "aborted")) {
					projectedMessages.pop();
				} else break;
			}
			// G4: the writer's session prefix shares the context projection's reduced view byte for byte,
			// so the writer continues the session's cache. Sources, hashes and readback stay on originals.
			const reductionView = this.reducedView(branch, ctx.model);
			const prefixMessages = convertToLlm(
				reductionView ? applyReduction(projectedMessages, reductionView) : projectedMessages,
			);
			assertToolPairs(prefixMessages);
			const sessionWriter = this.config.writerModel === SESSION_WRITER;
			// The session's ID travels with the prefix, as Pi sends it with each of the session's requests. Pi's measured
			// count describes the whole current context, so it stands for the prefix only when nothing was cut from it.
			const measuredTokens = interrupted === undefined ? measuredContextTokens(ctx) : undefined;
			const prefix = carriesSystemPrompt(prefixMessages)
				? { messages: prefixMessages, sessionId: attempt.sessionId, measuredTokens }
				: {
						systemPrompt: ctx.getSystemPrompt(),
						messages: prefixMessages,
						tools: this.activeTools(),
						sessionId: attempt.sessionId,
						measuredTokens,
					};
			this.lastProgress.delete(attempt.sessionId);
			const submission = this.preparation?.enabled
				? { ...this.preparationSubmission(ctx, event.customInstructions), noteBudget: policy }
				: undefined;
			const available = submission ? this.preparation?.take(submission) : undefined;
			let path: "complete" | "prefix" | "notes" | "sync" =
				available?.classification.status === "current-full" ? "complete" : "sync";
			const systemTokens = textTokens(ctx.getSystemPrompt());
			const beforeTokens =
				systemTokens + projection.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
			let userMessages: readonly SessionRecord[] = [];
			/**
			 * D16: commit `note` for the prefix through `end` and keep every later original verbatim. Only when the cut
			 * releases nothing uncovered, the context shrinks and the result fits within `share` of the threshold.
			 * Returns why it did not commit.
			 */
			const commitPrefix = (
				note: MemoryNote,
				end: number,
				share: number,
				users: readonly SessionRecord[] = [],
			): NotesFallback | undefined => {
				const start = prefixCut(branch, projection, end, cut);
				if (start === undefined) return "cut";
				const retained = retainedFrom(start);
				const retainedTokens = systemTokens + retained.reduce((sum, message) => sum + estimateTokens(message), 0);
				const section = users.length ? renderUserMessages(users) : "";
				// Every message in full or none: beyond this bound the writer consolidates the user's messages instead.
				if (textTokens(section) > Math.min(6000, Math.floor(budget.threshold * 0.05))) return "user-messages";
				const summary = fittedSummary(note, branch, retainedTokens, Math.floor(budget.threshold * share), section);
				if (!summary || textTokens(summary) + retainedTokens >= beforeTokens) return "fit";
				assertToolPairs(retained);
				kept = retained;
				firstKeptEntryId = branch[start].id;
				coveredIndex = end;
				userMessages = users;
				return undefined;
			};
			if (path === "sync" && available && interrupted === undefined) {
				const end = reusablePrefix(available.candidate, available.classification, asRecords(branch));
				if (end !== undefined && !commitPrefix(available.written.note, end, 0.8)) path = "prefix";
			}
			// D18: merge the session model's work notes without a writer call; the user's own messages follow verbatim.
			// When B leaves a compaction to the writer, the reason is recorded for evaluation.
			let notesNote: MemoryNote | undefined;
			let notesFallback: NotesFallback | undefined;
			if (path === "sync" && this.workNotes.enabled) {
				if (!notes.length) notesFallback = "no-notes";
				else if (interrupted !== undefined) notesFallback = "unfinished-turn";
				else if (event.customInstructions?.trim()) notesFallback = "custom-focus";
				else {
					const end = notes[notes.length - 1].index;
					const merged = mergeWorkNotes(previous?.memory.note, notes);
					try {
						notesNote = merged && validateNote(merged, asRecords(branch.slice(0, end + 1)), policy.hardTokens);
					} catch {
						notesNote = undefined;
					}
					const users = coveredUserMessages(
						asRecords(branch),
						activeIds,
						end,
						carriedUserMessages(previous?.entry),
					);
					// The turn of the last note stays verbatim; if that leaves half the threshold or more, a writer call is
					// worth more than a commit that barely compacts.
					notesFallback = notesNote ? commitPrefix(notesNote, end, 0.5, users) : "merge";
					if (!notesFallback) path = "notes";
				}
			}
			// A candidate that is not committed as it stands is discarded; its calls remain in the journal.
			const reused = path === "complete" || path === "prefix" ? available : undefined;
			const ready = reused
				? {
						...reused.written,
						note: validateNote(
							structuredClone(reused.written.note),
							asRecords(branch.slice(0, coveredIndex + 1)),
							policy.hardTokens,
						),
					}
				: path === "notes" && notesNote
					? { note: notesNote, writerModel: modelName(ctx.model), writerEffort: "off" as const }
					: undefined;
			let written: WriteMemoryResult;
			if (ready) {
				written = { ...ready, usage: sumMemoryUsage([]), chunkCount: 0 };
				this.lastProgress.set(attempt.sessionId, {
					writerModel: written.writerModel,
					writerEffort: written.writerEffort,
					writerCalls: 0,
					usageReports: 0,
					repairUsed: false,
					writerCallDetails: [],
				});
			} else {
				written = await writeMemory({
					config: this.config,
					registry: ctx.modelRegistry,
					sessionModel: ctx.model,
					prefix: sessionWriter ? prefix : undefined,
					sessionThinkingLevel: sessionWriter ? ctx.thinkingLevel : undefined,
					previous: previous?.memory.note,
					increments,
					uncovered: asEntries(writerSources(asRecords(branch), previous)),
					branch,
					noteTokens: policy.hardTokens,
					baseNoteTokens: policy.baseTokens,
					signal: event.signal,
					customInstructions: event.customInstructions,
					callHooks: this.journal?.hooks(attempt.sessionId, "compaction", attempt.lastCheckpointId ?? "none"),
					onProgress: (progress) => {
						this.lastProgress.set(attempt.sessionId, progress);
					},
				});
			}
			event.signal.throwIfAborted();
			if (
				snapshot.sessionId !== ctx.sessionManager.getSessionId() ||
				snapshot.leafId !== ctx.sessionManager.getLeafId() ||
				attempt.sourceHash !== hashEntries(ctx.sessionManager.getBranch())
			) {
				throw new Error("CONTEXT_SOURCE_CHANGED: discard the generated candidate");
			}
			const summary = fittedSummary(
				written.note,
				branch,
				systemTokens + kept.reduce((sum, message) => sum + estimateTokens(message), 0),
				budget.threshold,
				userMessages.length ? renderUserMessages(userMessages) : "",
			);
			if (!summary) throw new Error("CONTEXT_RECOVERY_TOO_LARGE");
			const candidate: PreviewCompaction = {
				summary,
				firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				usage: written.usage,
				details: {
					kind: CONTEXT_MEMORY_KIND,
					version: CONTEXT_MEMORY_VERSION,
					note: written.note,
					coveredThrough: branch[coveredIndex].id,
					sourceHash:
						coveredIndex === branch.length - 1
							? attempt.sourceHash
							: hashEntries(branch.slice(0, coveredIndex + 1)),
					snapshot,
					writerModel: written.writerModel,
					chunkCount: written.chunkCount,
					build: PREVIEW_BUILD_ID,
					noteBudget: policy,
					...(userMessages.length ? { userMessages: userMessages.map((entry) => entry.id) } : {}),
					...(this.preparation?.enabled || this.workNotes.enabled
						? {
								preparation: {
									version: 1 as const,
									path,
									...(reused
										? {
												candidateId: reused.candidate.input.candidateId,
												callIds: [...reused.candidate.provenance.callIds],
											}
										: {}),
									...(path === "notes" ? { noteIds: notes.map((item) => item.id) } : {}),
									...(notesFallback ? { notesFallback } : {}),
								},
							}
						: {}),
				},
			};
			this.store.stage(ctx.sessionManager, attempt, candidate);
			this.preparation?.staged(reused?.candidate.input.candidateId);
			this.stagedCompactions.add(attempt.sessionId);
			this.lastCompaction.set(attempt.sessionId, {
				path,
				...(reused ? { candidateId: reused.candidate.input.candidateId } : {}),
				foregroundCalls: this.lastProgress.get(attempt.sessionId)?.writerCalls ?? 0,
				stageMs: Math.round(performance.now() - started),
				diskConfirmed: false,
			});
			return candidate;
		} catch (error) {
			const code = previewErrorCode(error, event.signal.aborted);
			this.compactionStartedAt.delete(ctx.sessionManager.getSessionId());
			this.fail(ctx, code);
			throw new Error(code);
		}
	}

	committed(event: SessionCompactEvent, ctx: ExtensionContext): void {
		this.forgetVerified();
		const ours = this.activeCompactions.delete(ctx.sessionManager.getSessionId());
		this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
		// Pi's own compaction of a session this preview does not protect is not a commit of this package.
		if (!ours && !this.protected(ctx)) {
			setStatusLine(ctx, undefined);
			return;
		}
		try {
			const { checkpoint: memory, sourceHash } = assertHashedPreviewSession(ctx.sessionManager, this.hostVersion);
			if (!event.fromExtension || memory?.entry.id !== event.compactionEntry.id) {
				throw new Error("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
			}
			// The marker owner reads the exact checkpoint and sources back from persistent JSONL.
			this.store.commit(ctx.sessionManager, event.compactionEntry, sourceHash);
			const started = this.compactionStartedAt.get(ctx.sessionManager.getSessionId());
			this.compactionStartedAt.delete(ctx.sessionManager.getSessionId());
			const last = this.lastCompaction.get(ctx.sessionManager.getSessionId());
			if (last) {
				last.diskConfirmed = true;
				if (started !== undefined) last.pauseMs = Math.round(performance.now() - started);
			}
			this.preparation?.committed();
			this.stickyFailures.delete(ctx.sessionManager.getSessionId());
			this.observedFailures.delete(ctx.sessionManager.getSessionId());
			this.readyStatus(ctx);
			this.notices.confirmed(ctx.sessionManager.getSessionId());
		} catch (error) {
			const code = previewErrorCode(error);
			this.fail(ctx, code);
			ctx.abort();
			this.reportBlocked(ctx, code);
		}
	}

	/**
	 * Reconcile a staged checkpoint that Pi saved but whose commit observation was interrupted.
	 * Only an existing pending or blocked record can be confirmed; a refusal never creates one,
	 * and failures inside the confirmation are recorded by the failure store itself.
	 */
	recover(ctx: ExtensionContext): void {
		this.forgetVerified();
		try {
			if (this.configError || !this.config) throw new Error(this.configError ?? "CONTEXT_CONFIG");
			const { checkpoint: memory, sourceHash } = assertHashedPreviewSession(ctx.sessionManager, this.hostVersion);
			const leaf = ctx.sessionManager.getLeafEntry();
			if (
				leaf?.type !== "compaction" ||
				memory?.entry.id !== leaf.id ||
				!this.store.markerPresent(ctx.sessionManager)
			) {
				throw new Error("CONTEXT_PREVIEW_COMMIT_UNCONFIRMED");
			}
			this.store.recover(ctx.sessionManager, leaf, sourceHash);
			this.preparation?.committed();
			this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
			this.stickyFailures.delete(ctx.sessionManager.getSessionId());
			this.observedFailures.delete(ctx.sessionManager.getSessionId());
			this.readyStatus(ctx);
			this.notices.confirmed(ctx.sessionManager.getSessionId());
		} catch (error) {
			throw new Error(previewErrorCode(error));
		}
	}

	compactionFailed(event: SessionCompactFailedEvent, ctx: ExtensionContext): void {
		this.compactionStartedAt.delete(ctx.sessionManager.getSessionId());
		// Preparation can reject "nothing to compact" before this extension's hook runs.
		// No writer or staged candidate existed in that case, so retain the existing state.
		if (!this.activeCompactions.delete(ctx.sessionManager.getSessionId())) return;
		const specific = this.observedFailures.get(ctx.sessionManager.getSessionId());
		const staged = this.stagedCompactions.delete(ctx.sessionManager.getSessionId());
		const code =
			specific ??
			(event.aborted
				? "CONTEXT_COMPACTION_CANCELLED"
				: staged
					? "CONTEXT_PREVIEW_COMMIT_UNCONFIRMED"
					: previewErrorCode(event.errorMessage));
		this.fail(ctx, code);
		this.reportBlocked(ctx, code);
	}
}
