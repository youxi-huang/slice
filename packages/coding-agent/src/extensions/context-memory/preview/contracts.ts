import type { CompactionEntry, CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PreviewAttempt, PreviewCheckpoint, PreviewStatus } from "../../../../../compaction-core/src/contracts.ts";

// The checkpoint and preparation metadata shapes with the attempt and failure-state shapes live in
// the host-neutral core (v0.7.0 WP2 step 3); the Pi-typed contracts below stay with this adapter.
export type {
	NotesFallback,
	PrefixRefusal,
	PreparationFallback,
	PreviewAttempt,
	PreviewCheckpoint,
	PreviewStatus,
} from "../../../../../compaction-core/src/contracts.ts";

export type PreviewSession = ExtensionContext["sessionManager"];
export type PreviewCompaction = CompactionResult<PreviewCheckpoint>;

/** Why the preview stands aside in a session it never enrolled. Controlled values only. */
export type InactiveReason = "host" | "in-memory" | "foreign-checkpoint" | "image" | "non-text" | "context-edit";

export type Protection = "protected" | "eligible" | "not-protected";

/** Pi's own manual-compaction gate is not visible through the public extension API. */
export interface ManualCompaction {
	/**
	 * What this preview requires before /compact can write a checkpoint: `ready` at a completed turn with no
	 * queued input; `retry` when a new /compact replaces a pending or failed attempt; `waiting-for-turn` until
	 * the turn allows either; `blocked` when /compact cannot help here, as with an unsupported session, an
	 * unreadable configuration or an unavailable writer.
	 */
	preview: "ready" | "retry" | "waiting-for-turn" | "blocked" | "not-active";
	/** A checkpoint Pi already saved after staging awaits /compaction-recover, which confirms it without a model call. */
	recover: boolean;
	/** Pi decides from its own settings whether enough older history exists. */
	pi: "unknown";
	contextTokens: number | null;
	piDefaultKeepRecentTokens: number;
}

/** Read-only findings shared by /compaction-status and /compaction-doctor. */
export interface PreviewDiagnosis {
	build: string;
	host: string;
	supportedHost: string;
	supportedHosts: readonly string[];
	protection: Protection;
	reason?: InactiveReason;
	state: "ready" | "pending" | "blocked" | "inactive";
	code?: string;
	writer?: string;
	writerError?: string;
	checkpointId?: string;
	manualCompaction: ManualCompaction;
}

/** Readback evidence shared only within one synchronous call, before any write or Pi append. */
export interface PreviewReadback {
	leafId?: string | null;
	sourceHash?: string;
}

/**
 * Operational markers contain hashes and identifiers, never transcript or note text.
 * Supplied bytes/hashes belong only to the caller's current synchronous stretch, before any write.
 */
export interface PreviewFailureStoreContract {
	/** Request guard: full readback after a trust boundary, then only a file identity and length check. */
	assertReady(session: PreviewSession, serializedBranch?: readonly string[]): void;
	/** Make the next request read the whole session file back. */
	forgetReadback(): void;
	status(session: PreviewSession, branchHash?: string, readback?: PreviewReadback): PreviewStatus;
	/** Like status, without latching a newly observed failure. */
	inspect(session: PreviewSession): PreviewStatus;
	/** Whether a pending/blocked record, or an unreadable one, exists for this session. Writes nothing. */
	markerPresent(session: PreviewSession): boolean;
	/** Only an explicit manual compaction may replace a previous failure marker. */
	begin(
		session: PreviewSession,
		explicitRetry?: boolean,
		branchHash?: string,
		readback?: PreviewReadback,
	): PreviewAttempt;
	stage(session: PreviewSession, attempt: PreviewAttempt, candidate: PreviewCompaction): void;
	/** Success requires reading the matching checkpoint and original sources from disk. */
	commit(session: PreviewSession, entry: CompactionEntry, branchHash?: string): void;
	/** Explicitly confirms an already staged durable checkpoint whose commit was not observed. */
	recover(session: PreviewSession, entry: CompactionEntry, branchHash?: string): void;
	fail(session: PreviewSession, code: string): void;
}
