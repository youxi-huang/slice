// Lifted from the preview into the host-neutral core (v0.7.0 WP2 step 3): the checkpoint and
// preparation metadata shapes of the specification's checkpoint format, with the attempt and
// failure-state shapes the commit gate records. The notes import moved to the core's copy; the
// shapes themselves are unchanged (rule K2). `PreviewSession` and the Pi-typed store contract
// stay with the adapter in the preview's contracts.ts, which re-exports these.
import type { MemoryCheckpoint } from "./notes.ts";
import type { MergeRefusal } from "./work-notes.ts";

export interface PreviewCheckpoint extends MemoryCheckpoint {
	/** Preview-only observational metadata; no extension of checkpoint source scope. */
	preparation?: {
		version: 1;
		path: "complete" | "prefix" | "notes" | "segments" | "sync";
		candidateId?: string;
		callIds?: string[];
		/** Work notes merged by the notes path. */
		noteIds?: string[];
		/** Why arm B left this compaction to the writer. */
		notesFallback?: NotesFallback;
		/** Why arm A's preparation did not serve this compaction. */
		preparationFallback?: PreparationFallback;
		/** 0.8.0: the segments the segments path merged, in chain order. */
		segmentIds?: string[];
		/** 0.8.0: why the segments did not serve this compaction. */
		segmentsFallback?: SegmentsFallback;
		/** 0.8.0 U8: how long the boundary waited for the segment in flight, when it waited. */
		segmentsWaitMs?: number;
	};
	/** User messages rendered verbatim after the note by the notes path; re-rendered at every full validation. */
	userMessages?: string[];
}

/**
 * Why arm B did not commit: no work notes since the previous checkpoint, an unfinished turn, custom focus, a merge
 * the note schema or budget rejects, no cut that releases only covered entries, user messages that do not fit in
 * full, or a result that would not compact enough.
 */
export type NotesFallback = "no-notes" | "unfinished-turn" | "custom-focus" | "merge" | PrefixRefusal;

/**
 * Why a note was not committed for a prefix: no cut that releases only covered entries, user messages that do not fit
 * in full, or a result that would not compact enough.
 */
export type PrefixRefusal = "cut" | "user-messages" | "fit";

/**
 * Why arm A did not serve a compaction: nothing was prepared in the interval, a run was still in flight, the run failed
 * or was cancelled, the candidate's sources no longer matched, a stale candidate left no reusable prefix, the turn was
 * unfinished, or the prefix was refused. Arm A carries no user messages, so `user-messages` does not occur.
 */
/**
 * Why segments did not serve a compaction (0.8.0 WP3): none was ready, the one in flight did not finish in time, none
 * of the ready ones was still valid, the turn was unfinished, custom focus, a merge refusal or a merged note that does
 * not validate, or the prefix was refused. Segments carry no user messages, so `user-messages` does not occur.
 */
export type SegmentsFallback =
	| "no-segments"
	| "in-flight"
	| "invalid"
	| "unfinished-turn"
	| "custom-focus"
	| "merge"
	| MergeRefusal
	| PrefixRefusal;

export type PreparationFallback =
	| "none"
	| "in-flight"
	| "failed"
	| "cancelled"
	| "invalid"
	| "stale"
	| "unfinished-turn"
	| PrefixRefusal;

export interface PreviewAttempt {
	attemptId: string;
	sessionId: string;
	leafId: string;
	lastCheckpointId: string | null;
	sourceHash: string;
}

export interface PreviewStatus {
	state: "ready" | "pending" | "blocked";
	code?: string;
}
