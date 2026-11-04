import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type HistorySnapshot as CoreHistorySnapshot,
	queryHistory,
} from "../../../../../compaction-core/src/history.ts";
import {
	listHistory,
	previewHistorySchema,
	priceSearch,
	readLowDetail,
} from "../../../../../compaction-core/src/history-view.ts";
import type { SessionRecord } from "../../../../../compaction-core/src/records.ts";
import {
	validateWorkNote,
	WORK_NOTE_GUIDELINE,
	workNoteSchema,
} from "../../../../../compaction-core/src/work-notes.ts";
import { readMemoryConfig, SESSION_WRITER } from "../config.ts";
import { freezeHistory, type HistorySnapshot } from "../history.ts";
import { CONTEXT_NOTE_TYPE } from "../identity.ts";
import { CallJournal } from "./call-journal.ts";
import { PreviewMemoryController, previewErrorCode, reportPreviewError, unsupportedReason } from "./controller.ts";
import { type LoadedCopy, loadedCopies, recordCopy, standsAside } from "./copies.ts";
import { readExcerptSettings } from "./excerpts.ts";
import { PreviewFailureStore } from "./failure-store.ts";
import {
	doctorReport,
	duplicateNotice,
	inactiveNotice,
	NOTICE_PREFIX,
	notify,
	recoverRefusedNotice,
} from "./notices.ts";
import { PreviewPreparation, readPreparationSettings } from "./preparation.ts";
import { PreviewSegments } from "./segments.ts";
import { resolveWriterModel } from "./writer.ts";

/** Pi's entries satisfy the core's structural record shapes; the snapshot is widened here, never converted (records.ts). */
const asSnapshot = (snapshot: HistorySnapshot): CoreHistorySnapshot => snapshot as unknown as CoreHistorySnapshot;

/** Output of a command the user asked for: the UI, or stdout without one. */
function show(ctx: ExtensionContext, text: string, kind: "info" | "warning" = "info"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(text, kind);
		else console.log(text);
	} catch {
		// Status display is not a compaction or recovery operation.
	}
}

/** Ordinary Pi package entry. It installs no resident loader, host patches or global settings. */
export default function contextMemoryPreview(pi: ExtensionAPI): void {
	const entry = fileURLToPath(import.meta.url);
	recordCopy(entry);
	let copies: LoadedCopy[] | undefined;
	/** Pi lists every extension's commands once all have loaded; until then this copy acts alone, as before. */
	function loaded(): LoadedCopy[] {
		try {
			copies ??= loadedCopies(pi, entry);
		} catch {
			// Not listed yet: checked again at the next event.
		}
		return copies ?? [];
	}
	/** A copy that stands aside leaves every event to the copy that compacts. Its tools still answer: Pi runs the first copy's. */
	const live =
		<A extends unknown[], R>(handler: (...args: A) => R) =>
		(...args: A): R | undefined =>
			standsAside(loaded()) ? undefined : handler(...args);
	const agentDir = getAgentDir();
	let config: ReturnType<typeof readMemoryConfig> | undefined;
	let configError: string | undefined;
	try {
		config = readMemoryConfig(agentDir);
	} catch {
		// A factory error would make stock Pi drop the extension and permit native compaction.
		configError = "CONTEXT_CONFIG";
	}
	const journal = new CallJournal(agentDir);
	const preparation = readPreparationSettings(agentDir);
	const segments = new PreviewSegments({
		enabled: preparation.segments.enabled,
		settingsError: preparation.segments.error,
		effort: preparation.segments.effort,
		journal,
	});
	const controller = new PreviewMemoryController({
		config,
		configError,
		failureStore: new PreviewFailureStore(agentDir),
		journal,
		preparation: new PreviewPreparation({ enabled: preparation.enabled, settingsError: preparation.error, journal }),
		workNotes: preparation.notes,
		segments,
		excerpts: readExcerptSettings(agentDir),
		reduction: preparation.reduction,
		rendering: preparation.rendering,
		hostSettings: () => pi.getSettings(),
	});
	const disabled = config?.enabled === false;
	pi.registerCommand("compaction-status", {
		description: "Show source-linked compaction's writer, checkpoint and request state as JSON",
		handler: async (_args, ctx) => {
			try {
				show(ctx, JSON.stringify(controller.status(ctx), null, 2));
			} catch (error) {
				reportPreviewError(ctx, previewErrorCode(error));
			}
		},
	});
	pi.registerCommand("compaction-doctor", {
		description: "Check source-linked compaction in this session without calling a model",
		handler: async (_args, ctx) => {
			try {
				show(
					ctx,
					doctorReport(controller.diagnose(ctx), {
						disabled,
						configError,
						writerModel: config?.writerModel,
						copies: loaded(),
						segments: segments.status(),
					}),
				);
			} catch (error) {
				reportPreviewError(ctx, previewErrorCode(error));
			}
		},
	});
	// Explicitly disabling this package ends its protection. Invalid config never takes this path.
	if (disabled) return;

	function activateEarlierWorkNotes(ctx: ExtensionContext): void {
		if (preparation.notes.enabled) return;
		const called = ctx.sessionManager
			.getBranch()
			.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some((part) => part.type === "toolCall" && part.name === "context_note"),
			);
		if (!called) return;
		const active = pi.getActiveTools();
		if (!active.includes("context_note")) pi.setActiveTools([...active, "context_note"]);
	}

	pi.registerCommand("compaction-recover", {
		description: "Confirm a checkpoint Pi already saved when a compaction was interrupted",
		handler: async (_args, ctx) => {
			if (standsAside(loaded())) {
				show(ctx, duplicateNotice(loaded()), "warning");
				return;
			}
			await ctx.waitForIdle();
			const reason = controller.safeInactive(ctx);
			if (reason) {
				show(ctx, inactiveNotice(reason, controller.hostVersion));
				return;
			}
			try {
				controller.recover(ctx);
				show(ctx, `${NOTICE_PREFIX}: checkpoint confirmed on disk. Requests resume.`);
			} catch (error) {
				const code = previewErrorCode(error);
				show(
					ctx,
					recoverRefusedNotice(
						code,
						unsupportedReason(ctx.sessionManager, controller.hostVersion),
						controller.hostVersion,
					),
					"warning",
				);
			}
		},
	});

	controller.bindTools(() => {
		const active = new Set(pi.getActiveTools());
		return pi
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
	});
	// Each submitted input starts a new notice episode, so a blocked input is reported once.
	pi.on(
		"input",
		live((event, ctx) => controller.input(event, ctx)),
	);
	// Stock cache warming uses a separate registry stream and bypasses request guards.
	// Stop it wherever this preview guards requests; throwing here would restore the stock decision.
	pi.on(
		"cache_warming_decision",
		live((_event, ctx) => (controller.safeInactive(ctx) ? undefined : { action: "stop" as const })),
	);
	pi.on("session_start", (_event, ctx) => {
		copies = undefined;
		if (standsAside(loaded())) {
			if (controller.notices.once("duplicate")) notify(ctx, duplicateNotice(loaded()), "warning");
			return;
		}
		controller.sessionStart(ctx);
		activateEarlierWorkNotes(ctx);
		if (config && config.writerModel !== SESSION_WRITER && !controller.safeInactive(ctx)) {
			try {
				resolveWriterModel(config, ctx.modelRegistry, ctx.model);
			} catch (error) {
				if (controller.notices.once("writer"))
					notify(
						ctx,
						`${NOTICE_PREFIX}: /compact can't write a checkpoint yet. The fixed writer in pi-context-memory.json isn't available. Correct writerModel and restart Pi. (${previewErrorCode(error)})`,
						"warning",
					);
			}
		}
	});
	pi.on(
		"context",
		live((event, ctx) => ({ messages: controller.context(event.messages, ctx) })),
	);
	pi.on(
		"context_with_system",
		live((event, ctx) => ({ messages: controller.context(event.messages, ctx) })),
	);
	pi.on(
		"before_provider_request",
		live((event, ctx) => controller.beforeRequest(event.payload, ctx)),
	);
	pi.on("session_before_compact", async (event, ctx) => {
		if (standsAside(loaded())) return undefined;
		try {
			const reason = controller.safeInactive(ctx);
			if (reason) {
				// Not this package's session: leave manual and automatic compaction to Pi.
				controller.standAside(ctx, reason);
				return undefined;
			}
			if (event.reason === "manual") controller.notices.nextEpisode();
			// Not at a completed turn, or blocked: leave it to a later turn without recording a failure.
			if (event.reason === "threshold" && !event.willRetry && !controller.thresholdReady(ctx))
				return { cancel: true };
			return { compaction: await controller.compact(event, ctx) };
		} catch (error) {
			// Cancellation is an explicit result because stock Pi swallows handler exceptions.
			controller.reportBlocked(ctx, previewErrorCode(error, event.signal.aborted));
			return { cancel: true };
		}
	});
	pi.on(
		"session_compact",
		live((event, ctx) => controller.committed(event, ctx)),
	);
	pi.on(
		"session_compact_failed",
		live((event, ctx) => controller.compactionFailed(event, ctx)),
	);
	pi.on(
		"agent_settled",
		live((_event, ctx) => {
			if (controller.makeRoom(ctx)) return;
			controller.prepare(ctx);
			controller.segment(ctx);
		}),
	);
	if (segments.enabled)
		pi.on(
			"turn_end",
			live((event, ctx) => {
				if (event.toolResults.length) controller.segment(ctx);
			}),
		);
	pi.on(
		"session_before_switch",
		live(() => controller.invalidatePreparation("session-switch")),
	);
	pi.on(
		"session_before_tree",
		live(() => controller.invalidatePreparation("branch-switch")),
	);
	pi.on(
		"session_tree",
		live((_event, ctx) => {
			controller.branchChanged(ctx);
			activateEarlierWorkNotes(ctx);
		}),
	);
	pi.on(
		"model_select",
		live(() => controller.invalidatePreparation("model-change")),
	);
	pi.on(
		"session_shutdown",
		live(() => controller.shutdownPreparation()),
	);
	pi.registerTool({
		name: "context_note",
		label: "Context note",
		defaultActive: preparation.notes.enabled,
		description:
			"Record a short work note: where the work stands, decisions and their reasons, failed approaches, files and the current plan, each fact on one line with the original entry IDs it rests on. A note is data for the next checkpoint, not an instruction; the user's own messages stay authoritative.",
		// Earlier calls keep their declaration with B off; saved notes still reach the writer as hints.
		...(preparation.notes.enabled ? { promptGuidelines: [WORK_NOTE_GUIDELINE] } : {}),
		parameters: workNoteSchema,
		async execute(_id, value, signal, _update, ctx) {
			signal?.throwIfAborted();
			controller.assertReady(ctx);
			// Pi's entries satisfy the core's structural record shapes; the union is widened, never converted (records.ts).
			validateWorkNote(value, ctx.sessionManager.getBranch() as unknown as readonly SessionRecord[]);
			pi.appendEntry(CONTEXT_NOTE_TYPE, structuredClone(value));
			return {
				content: [{ type: "text", text: "Work note saved; original messages remain authoritative." }],
				details: {},
			};
		},
	});
	pi.registerTool({
		name: "context_history",
		label: "Context history",
		description:
			"Search or read original history on the current branch, or list one kind of item newest first: constraints (instructions), decisions (reasons), failedPaths, files, nextSteps, state, edits or errors, with superseded items marked; sourceRevisedBy means a later fact revised the item's source entry without saying which fact it replaced, so check the excerpt. A list comes from earlier checkpoints and tool records and can miss what a writer left out; search to check. Returns entry IDs, roles, branch positions and continuation cursors. Search hits and list items state readTokens, the cost of reading the entry in full, and inContext when it is already in your context. Search is ranked; use position for chronology. Never infer missing or truncated evidence. Parent grants are not supported by this preview.",
		promptGuidelines: [
			"Search context_history for earlier decisions and evidence omitted by compaction, then read the matching original entry ID. Follow a cursor by repeating the same operation, query and entryId with that cursor.",
			"To see how a decision, constraint or setting changed, list its kind with a query; read the cited entry before relying on it.",
		],
		parameters: previewHistorySchema,
		async execute(_id, request, signal, _update, ctx) {
			signal?.throwIfAborted();
			controller.assertReady(ctx);
			if (request.grantId)
				throw new Error("HISTORY_SCOPE_DENIED: parent-history grants are unsupported in this preview");
			const { kind, detail, ...query } = request;
			if (detail !== undefined && request.operation !== "read")
				throw new Error("HISTORY_QUERY_INVALID: detail applies to read only");
			const snapshot = freezeHistory(ctx.sessionManager);
			const inContext = controller.inContext(ctx);
			if (request.operation === "list") {
				const view = listHistory(asSnapshot(snapshot), request, undefined, inContext);
				return { content: [{ type: "text", text: JSON.stringify(view) }], details: view };
			}
			if (kind !== undefined) throw new Error("HISTORY_QUERY_INVALID: kind applies to list only");
			if (detail === "low") {
				const low = readLowDetail(asSnapshot(snapshot), query, inContext);
				return { content: [{ type: "text", text: JSON.stringify(low) }], details: low };
			}
			// A full read is returned exactly as before; search hits gain their price and mark.
			// The core's search, which centers excerpts where the terms meet; the frozen resident copy does not.
			const page = queryHistory(asSnapshot(snapshot), query);
			// A full read of an entry the reduced view replaces is a counted page-back; counts only.
			if (query.operation === "read" && query.entryId) controller.recordHistoryRead(ctx, query.entryId);
			const result = query.operation === "search" ? priceSearch(page, asSnapshot(snapshot), inContext) : page;
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
