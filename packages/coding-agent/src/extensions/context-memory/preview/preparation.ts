import { join } from "node:path";
import {
	type CandidateClassification,
	classifyPreparation,
	finalizePreparation,
	type PreparationSnapshot,
	type PreparationSubmission,
	type PreparedCandidate,
} from "../../../../../compaction-core/src/preparation-candidate.ts";
import { isRecord } from "../identity.ts";
import type { CallJournal } from "./call-journal.ts";
import { missing, readBoundedFile } from "./failure-io.ts";
import { RENDERING_OFF, type RenderingSwitch, renderingSwitch } from "./render-projection.ts";
import type { WriteMemoryResult, WriterCallHooks } from "./writer.ts";

/** A run still going after this long is cancelled; its calls stay in the journal. */
const DEADLINE_MS = 120_000;

export interface PreviewSwitch {
	enabled: boolean;
	error?: "invalid-config";
}

/** The thinking level segments are written at: the session's own, or a fixed level (U5). */
export type SegmentEffort = "session" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const SEGMENT_EFFORTS: readonly string[] = ["session", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface SegmentsSwitch extends PreviewSwitch {
	effort: SegmentEffort;
}

type PreparationSettings = PreviewSwitch & {
	notes: PreviewSwitch;
	reduction: PreviewSwitch;
	rendering: RenderingSwitch;
	segments: SegmentsSwitch;
};

const settingsCache = new Map<string, PreparationSettings>();

function isSegmentEffort(value: unknown): value is SegmentEffort {
	return typeof value === "string" && SEGMENT_EFFORTS.includes(value);
}

/** `previewSegments`: the switch, and `effort`, the session's level unless set; an unknown level turns segments off. */
export function segmentsSwitch(section: unknown): SegmentsSwitch {
	const base = previewSwitch(section);
	const effort = isRecord(section) ? section.effort : undefined;
	if (effort !== undefined && !isSegmentEffort(effort))
		return { enabled: false, error: "invalid-config", effort: "session" };
	return { ...base, effort: effort ?? "session" };
}

export function previewSwitch(section: unknown): PreviewSwitch {
	if (section === undefined) return { enabled: false };
	return isRecord(section) && (section.enabled === undefined || typeof section.enabled === "boolean")
		? { enabled: section.enabled === true }
		: { enabled: false, error: "invalid-config" };
}

/**
 * `previewPreparation.enabled` (arm A), `previewWorkNotes.enabled` (arm B), `previewReduction.enabled`
 * (WP2), `previewRendering` with its candidate names (WP3) and 0.8.0's `previewSegments` with its effort in
 * pi-context-memory.json, latched for the process like the other settings. Keys from the earlier experiment (call, token and cost budgets) are
 * ignored; an invalid value disables its switch without touching requests or the failure contract.
 */
export function readPreparationSettings(agentDir: string): PreparationSettings {
	const path = join(agentDir, "pi-context-memory.json");
	const cached = settingsCache.get(path);
	if (cached) return cached;
	let result: PreparationSettings;
	try {
		const value: unknown = JSON.parse(readBoundedFile(path, 64 * 1024, "preparation-config").toString("utf8"));
		const record = isRecord(value) ? value : {};
		result = {
			...previewSwitch(record.previewPreparation),
			notes: previewSwitch(record.previewWorkNotes),
			reduction: previewSwitch(record.previewReduction),
			rendering: renderingSwitch(record.previewRendering),
			segments: segmentsSwitch(record.previewSegments),
		};
	} catch (error) {
		const off: PreviewSwitch = missing(error) ? { enabled: false } : { enabled: false, error: "invalid-config" };
		result = {
			...off,
			notes: off,
			reduction: off,
			rendering: { ...RENDERING_OFF, ...(off.error ? { error: off.error } : {}) },
			segments: { ...off, effort: "session" },
		};
	}
	settingsCache.set(path, result);
	return result;
}

export interface PreparationJob {
	input: PreparationSnapshot;
	run(signal: AbortSignal, hooks: WriterCallHooks): Promise<WriteMemoryResult>;
}

interface Armed {
	candidate: PreparedCandidate;
	written: WriteMemoryResult;
}

/**
 * Optional background preparation by the configured writer (arm A): one run at a time and one armed
 * candidate. A run starts at most once per checkpoint interval, as the context nears Pi's compaction
 * threshold. Its result is only a candidate: compaction classifies it again and commits it through the
 * ordinary gate, or writes synchronously. Every call it makes is in the call journal first.
 */
export class PreviewPreparation {
	readonly enabled: boolean;
	private readonly settingsError?: string;
	private readonly journal: CallJournal;
	private sessionId?: string;
	private running?: { abort: AbortController; settled: Promise<void> };
	private armed?: Armed;
	private epoch = 0;
	private disposed = false;
	private state: "idle" | "failed" | "cancelled" = "idle";
	private reason?: string;
	private dropped = false;

	constructor(options: { enabled: boolean; settingsError?: string; journal: CallJournal }) {
		this.enabled = options.enabled && !options.settingsError;
		this.settingsError = options.settingsError;
		this.journal = options.journal;
	}

	get currentEpoch(): number {
		return this.epoch;
	}

	activate(sessionId: string): void {
		if (this.sessionId === sessionId) return;
		this.invalidate("session-changed");
		this.sessionId = sessionId;
	}

	/** Cheap check before building a snapshot: one run per interval, never while one runs or calls go unrecorded. */
	mayStart(sessionId: string, interval: string): boolean {
		return (
			this.enabled &&
			!this.disposed &&
			!this.running &&
			this.journal.writable(sessionId) &&
			!this.journal.preparedIn(sessionId, interval)
		);
	}

	start(job: PreparationJob, interval: string): boolean {
		if (!this.mayStart(job.input.sessionId, interval)) return false;
		this.activate(job.input.sessionId);
		if (job.input.epoch !== this.epoch) return false;
		const abort = new AbortController();
		const task = { abort, settled: Promise.resolve() };
		this.running = task;
		this.state = "idle";
		this.reason = undefined;
		const timer = setTimeout(() => {
			this.reason = "deadline";
			abort.abort();
		}, DEADLINE_MS);
		timer.unref();
		const journal = this.journal.hooks(job.input.sessionId, "preparation", interval);
		const callIds: string[] = [];
		const hooks: WriterCallHooks = {
			beforeDispatch: async (call) => {
				const id = await journal.beforeDispatch(call);
				callIds.push(id);
				return id;
			},
			afterDispatch: journal.afterDispatch,
		};
		const current = () => !this.disposed && job.input.epoch === this.epoch && this.sessionId === job.input.sessionId;
		// Generation is queued after the host event returns; the task turn never waits for it.
		task.settled = Promise.resolve()
			.then(() => {
				abort.signal.throwIfAborted();
				return job.run(abort.signal, hooks);
			})
			.then((written) => {
				if (abort.signal.aborted || !current()) return;
				this.armed = {
					candidate: finalizePreparation(job.input, {
						note: written.note,
						provenance: {
							writerRole: job.input.writer.role,
							writerModel: written.writerModel,
							writerEffort: written.writerEffort,
							callIds,
						},
					}),
					written: structuredClone(written),
				};
			})
			.catch(() => {
				if (!current()) return;
				this.state = abort.signal.aborted ? "cancelled" : "failed";
				this.reason ??= abort.signal.aborted ? "cancelled" : "generation-failed";
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

	/** The armed candidate with its eligibility for this submission. An invalid candidate is dropped. */
	take(
		submission: PreparationSubmission,
	): (Armed & { classification: Exclude<CandidateClassification, { status: "invalid" }> }) | undefined {
		this.dropped = false;
		if (!this.armed || this.disposed || !this.enabled) return undefined;
		const classification = classifyPreparation(this.armed.candidate, submission);
		if (classification.status === "invalid") {
			this.armed = undefined;
			this.dropped = true;
			return undefined;
		}
		return { ...this.armed, classification };
	}

	/** Why the last `take` had nothing to give, for the checkpoint's record. */
	missed(): "invalid" | "failed" | "cancelled" | "none" {
		if (this.dropped) return "invalid";
		return this.state === "idle" ? "none" : this.state;
	}

	/** A staged checkpoint owns its candidate until commit or explicit recovery. */
	staged(candidateId?: string): void {
		if (candidateId && this.armed?.candidate.input.candidateId === candidateId) this.armed = undefined;
	}

	/** A confirmed checkpoint starts a new interval. */
	committed(): void {
		this.cancel("checkpoint-committed");
		this.armed = undefined;
		this.epoch++;
		this.state = "idle";
		this.reason = undefined;
	}

	cancel(reason = "cancelled"): void {
		if (!this.running) return;
		this.state = "cancelled";
		this.reason = reason;
		this.running.abort.abort();
	}

	invalidate(reason: string): void {
		this.cancel(reason);
		this.armed = undefined;
		this.epoch++;
		this.state = "idle";
		this.reason = reason;
	}

	dispose(): void {
		this.disposed = true;
		this.invalidate("session-shutdown");
	}

	status(submission?: PreparationSubmission) {
		if (!this.enabled) {
			return {
				enabled: false,
				state: this.settingsError ? "paused" : "disabled",
				...(this.settingsError ? { reason: this.settingsError } : {}),
			};
		}
		const classification =
			submission && this.armed ? classifyPreparation(this.armed.candidate, submission) : undefined;
		const usable = this.armed && classification?.status !== "invalid";
		return {
			enabled: true,
			state: this.running
				? "preparing"
				: usable
					? classification?.status === "current-full"
						? "ready"
						: "stale"
					: this.state,
			...((usable ? classification?.reason : this.reason)
				? { reason: usable ? classification?.reason : this.reason }
				: {}),
			...(this.armed
				? {
						candidateId: this.armed.candidate.input.candidateId,
						coveredThrough: this.armed.candidate.input.coverage.coveredThrough,
					}
				: {}),
		};
	}
}
