import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type { CommandId } from "@deepseek-ai/dsh-commands";
import {
	type CompactionAgentContext,
	CompactionEngine,
	CompactionId,
	type CompactionResult,
	compactCheckpointSource,
	type ManualCompactAgentContext,
	ManualCompactionError,
	type ManualCompactionErrorCode,
	toolPairingBalancedAfter,
} from "@deepseek-ai/dsh-compaction";
import type { Session, SessionEvent, SessionSeq } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { TokenSurfaceNode } from "@deepseek-ai/dsh-token-meter";
import { canonicalize, hashCanonicalRecords } from "../../compaction-core/src/canonical.ts";
import { memoryBudget, selectNoteBudget } from "../../compaction-core/src/config.ts";
import { chooseCut } from "../../compaction-core/src/cuts.ts";
import { CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION } from "../../compaction-core/src/identity.ts";
import {
	compactedSourceTokens,
	type MemoryCheckpoint,
	noteBytes,
	renderNote,
	validateMemoryCheckpoints,
} from "../../compaction-core/src/notes.ts";
import { writeMemory } from "../../compaction-core/src/writer.ts";
import { dshAttempts, dshCompactionRecords, isSliceAttempt } from "./codec.ts";
import { dshTransport, nativeUsage, userMessage } from "./writer.ts";

export const name = "slice-compaction";
export const inject = ["llm", "tokenMeter", "sessions", "sessionPersistence", "commands"];
const reliance = "Preview: the checkpoint uses rawOutput, a field DSH owns.";
type Gate = { blocked: boolean; code?: string };
const codeOf = (error: unknown, fallback = "CONTEXT_STORAGE_UNCERTAIN") =>
	(error instanceof Error ? error.message : "").match(/^CONTEXT_[A-Z_]+/)?.[0] ?? fallback;

function confirmed(events: readonly SessionEvent[], attempt: ReturnType<typeof dshAttempts>["attempts"][number]) {
	const { summary, end } = attempt;
	if (!summary || !end || end.data.error !== undefined) return false;
	const replacement = events[summary.seq + 1];
	return (
		replacement?.type === "user/message" &&
		replacement.data.source.kind === "compact-checkpoint" &&
		replacement.data.source.compactionId === summary.data.compactionId
	);
}

export class SliceCompactionEngine extends CompactionEngine {
	static inject = inject;
	private readonly states = new WeakMap<Session, Promise<Gate>>();

	constructor(ctx: Context) {
		super(ctx);
		ctx.on("agent/pre-step", async ({ agent }, next) => {
			const decision = await next();
			const state = await this.state(agent.session);
			if (!state.blocked) return decision;
			ctx.logger.warn(`${state.code}: the message was not sent. Run /compact, then send it again.`);
			return { kind: "reject" };
		});
		ctx.commands.register({
			name: "compaction-status",
			description: "Show Slice compaction status",
			recordInput: false,
			handler: async ({ agent }) => {
				const state = await this.state(agent.session);
				const reason =
					state.code === "CONTEXT_PREVIEW_UNSUPPORTED"
						? "Seeded sessions cannot write. "
						: state.code === "CONTEXT_COMPACTOR_CONFLICT"
							? "The log contains another engine's compaction. "
							: state.code === "CONTEXT_NO_CUT"
								? "No balanced prefix is available. "
								: "";
				return {
					kind: "success",
					text: `Slice manual compaction: ${state.blocked ? "blocked" : "clear"}${state.code ? ` (${state.code})` : ""}. ${reason}${reliance}`,
				};
			},
		});
	}

	private set(session: Session, state: Gate) {
		this.states.set(session, Promise.resolve(state));
		return state;
	}

	private async read(session: Session, signal: AbortSignal) {
		signal.throwIfAborted();
		if (!(await this.ctx.sessions.flush(session)))
			throw new Error("CONTEXT_STORAGE_UNCERTAIN: persistence is required");
		const handle = await this.ctx.sessionPersistence.open(session.id, "read", { signal });
		try {
			return {
				events: (await handle.read(undefined, undefined, { signal })).events,
				seeded: handle.header.isSeeded,
			};
		} finally {
			await handle.close();
		}
	}

	private async derive(session: Session, signal: AbortSignal, expectedSummary?: SessionSeq): Promise<Gate> {
		try {
			const { events, seeded } = await this.read(session, signal);
			const latest = validateMemoryCheckpoints(dshCompactionRecords(events), undefined, "jcs");
			if (expectedSummary !== undefined && latest?.entry.id !== String(expectedSummary))
				return { blocked: true, code: "CONTEXT_STORAGE_UNCERTAIN" };
			const { attempts } = dshAttempts(events);
			const slice = attempts.filter((attempt) => isSliceAttempt(attempt.start.data.compactionId)).at(-1);
			if (slice && (!confirmed(events, slice) || latest?.entry.id !== String(slice.summary?.seq)))
				return {
					blocked: true,
					code: slice.end?.data.error
						? codeOf(new Error(slice.end.data.error), "CONTEXT_WRITER_FAILED")
						: "CONTEXT_STORAGE_UNCERTAIN",
				};
			return {
				blocked: false,
				...(seeded
					? { code: "CONTEXT_PREVIEW_UNSUPPORTED" }
					: attempts.some((attempt) => !isSliceAttempt(attempt.start.data.compactionId))
						? { code: "CONTEXT_COMPACTOR_CONFLICT" }
						: {}),
			};
		} catch (error) {
			return { blocked: true, code: codeOf(error) };
		}
	}

	/** Shared by every caller, so no caller's cancellation may settle it as a block. */
	state(session: Session): Promise<Gate> {
		let state = this.states.get(session);
		if (!state) {
			state = this.derive(session, new AbortController().signal);
			this.states.set(session, state);
		}
		return state;
	}

	override async compactIfNeeded(): Promise<null> {
		return null;
	}
	override async compactRegion(): Promise<CompactionResult> {
		throw new ManualCompactionError("commit", "CONTEXT_PREVIEW_UNSUPPORTED: region compaction is unavailable");
	}

	override compactNow(
		agent: ManualCompactAgentContext,
		signal: AbortSignal,
		sourceCommandId?: CommandId,
	): Promise<CompactionResult | null> {
		try {
			return agent.runMaintenance((ownerSignal) =>
				this.compact(agent, AbortSignal.any([signal, ownerSignal]), sourceCommandId),
			);
		} catch (error) {
			throw new ManualCompactionError("busy", "CONTEXT_BUSY: the agent is busy", { cause: error });
		}
	}

	private async compact(
		agent: CompactionAgentContext,
		signal: AbortSignal,
		sourceCommandId?: CommandId,
	): Promise<CompactionResult | null> {
		const session = agent.session;
		let failure: ManualCompactionErrorCode = "persistence";
		let opening: SessionEvent<"compaction/start"> | undefined;
		let ended = false;
		try {
			const { events, seeded } = await this.read(session, signal);
			failure = "commit";
			if (seeded || session.header.isSeeded)
				throw new Error("CONTEXT_PREVIEW_UNSUPPORTED: seeded sessions cannot write");
			const { attempts, open } = dshAttempts(events);
			if (attempts.some((attempt) => !isSliceAttempt(attempt.start.data.compactionId)))
				throw new Error("CONTEXT_COMPACTOR_CONFLICT: the log contains another engine");
			if (open) throw new Error("CONTEXT_STORAGE_UNCERTAIN: a compaction is still open");
			const records = dshCompactionRecords(events);
			const previous = validateMemoryCheckpoints(records, undefined, "jcs");
			failure = "summary";
			const transport = await dshTransport(this.ctx, session, signal);
			const routed = session.requestHeader()!.config;
			const budget = memoryBudget({
				id: transport.model.split("/").slice(1).join("/"),
				contextWindow: transport.contextWindow,
				maxTokens: session.requestHeader()?.config.maxTokens ?? 0,
			});
			const measurement = this.ctx.tokenMeter.measure(session);
			const cut = chooseCut(
				records,
				budget.recentTokens,
				{
					entries: measurement.nodes.map((node) => ({
						sourceEntry: { id: String(node.seq) },
						messages: session.deriveEventMessage(events[node.seq])
							? [session.deriveEventMessage(events[node.seq])!]
							: [],
					})),
				},
				(message) => this.ctx.tokenMeter.estimateMessage(message),
			);
			const nodes = measurement.nodes.filter(
				(node, index) => !(index === 0 && events[node.seq]?.type === "system/message"),
			);
			const selected = nodes.filter((node) => Number(node.seq) < cut);
			const first = selected[0];
			const last = selected.at(-1);
			if (
				!first ||
				!last ||
				!toolPairingBalancedAfter(session, last.seq) ||
				nodes.some((node) => node.seq <= last.seq && !selected.includes(node))
			) {
				this.set(session, { ...(await this.state(session)), code: "CONTEXT_NO_CUT" });
				return null;
			}
			const sources = records.slice(0, last.seq + 1);
			const sourceHash = hashCanonicalRecords(sources);
			const previousEnd = previous
				? records.findIndex((record) => record.id === previous.memory.coveredThrough)
				: -1;
			const uncovered = sources.slice(previousEnd + 1);
			const noteBudget = selectNoteBudget(
				{},
				budget.threshold,
				compactedSourceTokens(uncovered),
				previous ? Math.ceil(noteBytes(previous.memory.note) / 3) : 0,
			);
			signal.throwIfAborted();
			failure = "changed";
			if (session.seq !== events.length) throw new Error("CONTEXT_SOURCE_CHANGED: the log grew before the attempt");
			const compactionId = CompactionId(`slice-${randomUUID()}`);
			const identity = { compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) };
			opening = session.append("compaction/start", { ...identity, turn: null });
			this.set(session, { blocked: true, code: "CONTEXT_STORAGE_UNCERTAIN" });
			failure = "summary";
			const result = await writeMemory(
				{
					config: { noteRepair: true },
					previous: previous?.memory.note,
					increments: [],
					uncovered,
					branch: records,
					noteTokens: noteBudget.hardTokens,
					baseNoteTokens: noteBudget.baseTokens,
					signal,
				},
				() => transport,
			);
			signal.throwIfAborted();
			failure = "changed";
			const current = this.ctx.tokenMeter.measure(session).nodes;
			const start = current.findIndex((node) => node.seq === first.seq);
			const span = current.slice(start, start + selected.length);
			const same = (left: TokenSurfaceNode, right: TokenSurfaceNode) =>
				left.seq === right.seq && left.tokens === right.tokens && left.heuristicTokens === right.heuristicTokens;
			if (start < 0 || span.length !== selected.length || span.some((node, index) => !same(node, selected[index])))
				throw new Error("CONTEXT_SOURCE_CHANGED: the selected span or its prices changed");
			const summary = [{ type: "text" as const, text: renderNote(result.note) }];
			const checkpoint: MemoryCheckpoint = {
				kind: CONTEXT_MEMORY_KIND,
				version: CONTEXT_MEMORY_VERSION,
				note: result.note,
				coveredThrough: String(last.seq),
				sourceHash,
				snapshot: {
					sessionId: session.id,
					leafId: records.at(-1)?.id ?? null,
					lastCheckpointId: previous?.entry.id ?? null,
				},
				writerModel: result.writerModel,
				chunkCount: result.chunkCount,
				build: "slice-dsh/compaction",
				noteBudget,
			};
			failure = "commit";
			const shadowedRange = { start: first.seq, end: last.seq };
			const shadowedSeqs = selected.map((node) => node.seq);
			const shadowedTokenCount = selected.reduce((sum, node) => sum + node.heuristicTokens, 0);
			const summaryEvent = session.append("compaction/summary", {
				...identity,
				summary,
				rawOutput: [{ type: "text", text: canonicalize(checkpoint) }],
				shadowedRange,
				shadowedSeqs,
				shadowedTokenCount,
				provider: routed.provider,
				model: routed.model,
				usage: nativeUsage(result.usage),
			});
			session.append("user/message", userMessage(summary, compactCheckpointSource(compactionId, sourceCommandId)), {
				surfaceOp: { op: "replace", startSeq: first.seq, endSeq: last.seq },
				sourceEventSeqs: [opening.seq, summaryEvent.seq, ...shadowedSeqs],
			});
			const end = session.append("compaction/end", { ...identity, turn: null });
			ended = true;
			failure = "persistence";
			const state = await this.derive(session, signal, summaryEvent.seq);
			if (state.blocked) throw new Error("CONTEXT_STORAGE_UNCERTAIN: checkpoint readback failed");
			this.set(session, state);
			return {
				...identity,
				startSeq: opening.seq,
				summarySeq: summaryEvent.seq,
				endSeq: end.seq,
				summary,
				shadowedRange,
				shadowedSeqs,
				shadowedTokenCount,
			};
		} catch (error) {
			const code = ended
				? "CONTEXT_STORAGE_UNCERTAIN"
				: codeOf(error, failure === "persistence" ? "CONTEXT_STORAGE_UNCERTAIN" : "CONTEXT_WRITER_FAILED");
			// Before the start, nothing was written: the gate stays what the log derives.
			if (opening) this.set(session, { blocked: true, code });
			if (opening && !ended) {
				session.append("compaction/end", {
					...opening.data,
					error: `${code}: ${error instanceof Error && error.message.startsWith("CONTEXT_") ? error.message.slice(code.length + 2) : "compaction failed"}`,
				});
				try {
					if (!(await this.ctx.sessions.flush(session))) failure = "persistence";
				} catch {
					failure = "persistence";
				}
			}
			throw new ManualCompactionError(signal.aborted ? "cancelled" : failure, code, { cause: error });
		}
	}
}

export function apply(ctx: Context) {
	if (ctx.get("compaction")) throw new Error("CONTEXT_COMPACTOR_CONFLICT: disable the compaction-basic row");
	ctx.plugin(SliceCompactionEngine);
}
