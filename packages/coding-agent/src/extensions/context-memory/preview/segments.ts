// 0.8.0 WP2: the segment scheduler. One segment in flight per session; validated links kept in memory as a chain
// (U10); U9's limits: the journal's per-interval call limit and spending cap, and a breaker after three
// consecutive failures of one class until the next commit. Segments never block work: any limit leaves the next
// boundary to the synchronous writer. Assembly at the boundary is WP3's.
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { segmentBudgetLeft } from "../../../../../compaction-core/src/call-journal.ts";
import { noteSections } from "../../../../../compaction-core/src/notes.ts";
import {
	invalidPreparation,
	type PreparationSubmission,
} from "../../../../../compaction-core/src/preparation-candidate.ts";
import {
	chainHash,
	classifyChain,
	finalizeSegment,
	type PreparedSegment,
	type SegmentSnapshot,
} from "../../../../../compaction-core/src/segments.ts";
import type { CallJournal } from "./call-journal.ts";
import type { SegmentEffort } from "./preparation.ts";
import type { WriteMemoryResult, WriterCallHooks } from "./writer.ts";

/** A run still going after this long is cancelled and counted as an error; its calls stay in the journal. */
const DEADLINE_MS = 120_000;
/** U8's starting bound on the boundary's wait for the segment in flight. */
const WAIT_MS = 15_000;
/** U9: consecutive failures of one class that stop segments until the next commit. */
const BREAKER_FAILURES = 3;

/** U9's failure classes; anything else a run throws is an error. Cancellation is not a failure. */
export type SegmentFailure = "refusal" | "tool-call" | "exhausted-output" | "error";

export function segmentFailure(error: unknown): SegmentFailure {
	const message = error instanceof Error ? error.message : "";
	if (message.startsWith("CONTEXT_NOTE_")) return "refusal";
	if (message.startsWith("CONTEXT_WRITER_FAILED: toolUse")) return "tool-call";
	if (message.startsWith("CONTEXT_WRITER_FAILED: length")) return "exhausted-output";
	return "error";
}

/**
 * How this session's segments ended, content-free: calls linked into the chain; calls cancelled in flight, by a
 * checkpoint, a branch or writer change or the session's end; calls whose result no longer extended the chain; calls
 * refused or failed, by error code, with `CONTEXT_SEGMENT_DEADLINE` for a run past its deadline; and links the chain
 * dropped when a settled turn classified it again, by the reason the chain stopped.
 */
export interface SegmentResults {
	linked: number;
	cancelled: number;
	stale: number;
	failed: Record<string, number>;
	dropped: Record<string, number>;
	/** Notes that cited outside their range, by the section that did: what the scope refusals consist of. */
	outOfRange: Record<string, number>;
}

const noResults = (): SegmentResults => ({
	linked: 0,
	cancelled: 0,
	stale: 0,
	failed: {},
	dropped: {},
	outOfRange: {},
});

/** The error code a failed run carries, such as `CONTEXT_NOTE_SCOPE`; `error` when it carries none. */
function failureCode(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return /^([A-Z][A-Z_]+):/.exec(message)?.[1] ?? "error";
}

/** The level a segment is written at: the configured one, or the session's when `session` or unset. */
export function segmentLevel(
	effort: SegmentEffort | undefined,
	session: ThinkingLevel | "off" | undefined,
): ThinkingLevel | "off" | undefined {
	return effort === undefined || effort === "session" ? session : effort;
}

export interface SegmentJob {
	input: SegmentSnapshot;
	run(signal: AbortSignal, hooks: WriterCallHooks): Promise<WriteMemoryResult>;
}

export class PreviewSegments {
	readonly enabled: boolean;
	/** How long the boundary may wait for the segment in flight (U8). */
	readonly waitMs: number;
	/** The thinking level segments are written at (U5): the session's own unless configured. */
	readonly effort: SegmentEffort;
	private readonly deadlineMs: number;
	private readonly settingsError?: string;
	private readonly journal: CallJournal;
	private sessionId?: string;
	private epoch = 0;
	private links: PreparedSegment[] = [];
	private running?: { abort: AbortController; settled: Promise<void>; input: SegmentSnapshot };
	private streak?: { kind: SegmentFailure; count: number };
	private results = noResults();
	private broken?: SegmentFailure;
	private disposed = false;

	/** `waitMs` and `deadlineMs` keep their starting values outside tests, which shorten them to reach timeouts. */
	constructor(options: {
		enabled: boolean;
		settingsError?: string;
		journal: CallJournal;
		effort?: SegmentEffort;
		waitMs?: number;
		deadlineMs?: number;
	}) {
		this.enabled = options.enabled && !options.settingsError;
		this.settingsError = options.settingsError;
		this.journal = options.journal;
		this.effort = options.effort ?? "session";
		this.waitMs = options.waitMs ?? WAIT_MS;
		this.deadlineMs = options.deadlineMs ?? DEADLINE_MS;
	}

	get currentEpoch(): number {
		return this.epoch;
	}

	/** The validated links in order, for the next range and for WP3's merge. */
	get chain(): readonly PreparedSegment[] {
		return this.links;
	}

	activate(sessionId: string): void {
		if (this.sessionId === sessionId) return;
		this.invalidate();
		this.streak = undefined;
		this.broken = undefined;
		this.results = noResults();
		this.sessionId = sessionId;
	}

	/** Keeps the chain's longest valid prefix and cancels a run whose input no longer matches the session. */
	reconcile(submission: PreparationSubmission): void {
		if (this.running && invalidPreparation(this.running.input.preparation, submission)) this.running.abort.abort();
		const chain = classifyChain(this.links, submission);
		if (chain.stop && chain.links.length < this.links.length) {
			const reason = chain.stop.reason;
			this.results.dropped[reason] = (this.results.dropped[reason] ?? 0) + this.links.length - chain.links.length;
		}
		this.links = [...chain.links];
	}

	/** Cheap check before choosing a range: one run at a time, an intact breaker, and budget left in the interval. */
	mayStart(sessionId: string, interval: string, triggerTokens: number): boolean {
		return (
			this.enabled &&
			!this.disposed &&
			!this.running &&
			!this.broken &&
			this.journal.writable(sessionId) &&
			segmentBudgetLeft(this.journal.segmentSpend(sessionId, interval), triggerTokens)
		);
	}

	start(job: SegmentJob, interval: string, triggerTokens: number): boolean {
		const input = job.input;
		if (!this.mayStart(input.preparation.sessionId, interval, triggerTokens)) return false;
		this.activate(input.preparation.sessionId);
		if (input.preparation.epoch !== this.epoch || input.chainHash !== chainHash(this.links)) return false;
		const abort = new AbortController();
		const task = { abort, settled: Promise.resolve(), input };
		this.running = task;
		let late = false;
		const timer = setTimeout(() => {
			late = true;
			abort.abort();
		}, this.deadlineMs);
		timer.unref();
		const journal = this.journal.hooks(input.preparation.sessionId, "segment", interval);
		const callIds: string[] = [];
		const hooks: WriterCallHooks = {
			beforeDispatch: async (call) => {
				const id = await journal.beforeDispatch(call);
				callIds.push(id);
				return id;
			},
			afterDispatch: journal.afterDispatch,
		};
		const current = () =>
			!this.disposed && input.preparation.epoch === this.epoch && this.sessionId === input.preparation.sessionId;
		// Generation is queued after the host event returns; the task turn never waits for it.
		task.settled = Promise.resolve()
			.then(() => {
				abort.signal.throwIfAborted();
				return job.run(abort.signal, hooks);
			})
			.then((written) => {
				if (abort.signal.aborted || !current()) {
					if (!late && this.sessionId === input.preparation.sessionId) this.results.cancelled++;
					return;
				}
				// Content-free: which sections cite outside the range, counted before the range check refuses the note.
				const range = new Set(input.rangeIds);
				for (const section of noteSections)
					if (written.note[section].some((item) => item.sources.some((id) => !range.has(id))))
						this.results.outOfRange[section] = (this.results.outOfRange[section] ?? 0) + 1;
				const link = finalizeSegment(input, {
					note: written.note,
					provenance: {
						writerRole: input.preparation.writer.role,
						writerModel: written.writerModel,
						writerEffort: written.writerEffort,
						callIds,
					},
				});
				// A reconcile may have shortened the chain while this link was written; it then no longer extends it.
				if (input.chainHash !== chainHash(this.links)) {
					this.results.stale++;
					return;
				}
				this.links.push(link);
				this.results.linked++;
				this.streak = undefined;
			})
			.catch((error) => {
				if ((abort.signal.aborted && !late) || !current()) {
					if (!late && this.sessionId === input.preparation.sessionId) this.results.cancelled++;
					return;
				}
				const kind = late ? "error" : segmentFailure(error);
				const code = late ? "CONTEXT_SEGMENT_DEADLINE" : failureCode(error);
				this.results.failed[code] = (this.results.failed[code] ?? 0) + 1;
				this.streak = { kind, count: this.streak?.kind === kind ? this.streak.count + 1 : 1 };
				if (this.streak.count >= BREAKER_FAILURES) this.broken = kind;
			})
			.finally(() => {
				clearTimeout(timer);
				if (this.running === task) this.running = undefined;
			});
		return true;
	}

	/** Tests and harnesses may wait; task events never do. */
	async waitForIdle(): Promise<void> {
		await this.running?.settled;
	}

	/**
	 * U8: the boundary may wait at most `ms` for the segment in flight when it extends the chain. It is never aborted
	 * here: a result that is still valid serves the next boundary. Whether it settled in time.
	 */
	async settle(ms: number, signal: AbortSignal): Promise<boolean> {
		const running = this.running;
		if (!running || running.input.chainHash !== chainHash(this.links) || signal.aborted) return false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stop: (() => void) | undefined;
		const late = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), ms);
			stop = () => resolve(false);
			signal.addEventListener("abort", stop, { once: true });
		});
		try {
			return await Promise.race([running.settled.then(() => true), late]);
		} finally {
			clearTimeout(timer);
			if (stop) signal.removeEventListener("abort", stop);
		}
	}

	/** A confirmed checkpoint starts a new interval: a new chain, and the breaker closes again. */
	committed(): void {
		this.invalidate();
		this.streak = undefined;
		this.broken = undefined;
	}

	/** A session, branch or writer change: the run in flight is cancelled at once and the chain is dropped. */
	invalidate(): void {
		this.running?.abort.abort();
		this.links = [];
		this.epoch++;
	}

	dispose(): void {
		this.disposed = true;
		this.invalidate();
	}

	/** Content-free: counts, a record ID and the breaker's failure class, never note text. */
	status(): {
		enabled: boolean;
		state: "disabled" | "paused" | "preparing" | "idle";
		effort?: SegmentEffort;
		ready: number;
		results?: SegmentResults;
		coveredThrough?: string;
		reason?: string;
	} {
		if (!this.enabled)
			return {
				enabled: false,
				state: this.settingsError ? "paused" : "disabled",
				ready: 0,
				...(this.settingsError ? { reason: this.settingsError } : {}),
			};
		return {
			enabled: true,
			state: this.running ? "preparing" : this.broken ? "paused" : "idle",
			effort: this.effort,
			ready: this.links.length,
			results: {
				...this.results,
				failed: { ...this.results.failed },
				dropped: { ...this.results.dropped },
				outOfRange: { ...this.results.outOfRange },
			},
			...(this.links.length ? { coveredThrough: this.links[this.links.length - 1].snapshot.lastId } : {}),
			...(this.broken ? { reason: this.broken } : {}),
		};
	}
}
