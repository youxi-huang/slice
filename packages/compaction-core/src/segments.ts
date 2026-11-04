// 0.8.0 WP1: segments, preparation candidates over closed ranges of the branch that the boundary merges without a
// model call. A segment is frozen and validated exactly as a preparation candidate is, with three additions: the
// first record of its range, the chain of validated segments before it, and a note that cites only inside its
// range. WP2 adds the choice of each range (U3); dispatch belongs to the host, and assembly to WP3.
import { assertToolPairs } from "./guards.ts";
import { hashEntries, isRecord } from "./identity.ts";
import { compactedSourceTokens, type MemoryNote, noteSections } from "./notes.ts";
import {
	type CandidateClassification,
	classifyPreparation,
	finalizePreparation,
	freezePreparationInput,
	type PreparationInput,
	type PreparationResult,
	type PreparationSnapshot,
	type PreparationSubmission,
	type PreparedCandidate,
} from "./preparation-candidate.ts";
import type { SessionRecord } from "./records.ts";
import { type MergeRefusal, mergeNotes } from "./work-notes.ts";

export interface SegmentInput extends PreparationInput {
	/** First record of the range; `coveredThrough` is its last. */
	firstId: string;
	/** `chainHash` of the validated segments before this one, `chainHash([])` for the first. */
	chainHash: string;
}

export interface SegmentSnapshot {
	readonly preparation: PreparationSnapshot;
	readonly firstId: string;
	readonly lastId: string;
	readonly rangeIds: readonly string[];
	readonly chainHash: string;
	readonly segmentId: string;
}

export interface PreparedSegment {
	readonly snapshot: SegmentSnapshot;
	readonly candidate: PreparedCandidate;
	readonly segmentHash: string;
}

/** Why a chain ends before its last segment: a preparation candidate's reasons, plus the chain's own. */
export type ChainStop =
	| Extract<CandidateClassification, { status: "invalid" }>["reason"]
	| "custom-instructions"
	| "submission-budget"
	| "user-horizon-incomplete"
	| "base-unsupported"
	| "not-contiguous"
	| "chain-mismatch";

export interface ChainClassification {
	/** The longest valid prefix of the chain, in order. */
	readonly links: readonly PreparedSegment[];
	/** The last record the valid links cover, or undefined when none is valid. */
	readonly coveredThrough?: string;
	/** The first link that is not merged, and why; later links are discarded with it. */
	readonly stop?: { readonly index: number; readonly reason: ChainStop };
}

function freeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

export function chainHash(links: readonly PreparedSegment[]): string {
	return hashEntries(links.map((link) => link.segmentHash));
}

/** Pure: freezes the range through `coveredThrough` as a preparation snapshot and names where the range begins. */
export function freezeSegmentInput(input: SegmentInput): SegmentSnapshot {
	const preparation = freezePreparationInput(input);
	const first = preparation.coverage.entryIds.indexOf(input.firstId);
	if (first < 0 || typeof input.chainHash !== "string" || !input.chainHash)
		throw new Error("CONTEXT_PREPARATION_INPUT: invalid segment range");
	const rangeIds = preparation.coverage.entryIds.slice(first);
	return freeze({
		preparation,
		firstId: input.firstId,
		lastId: input.coveredThrough,
		rangeIds,
		chainHash: input.chainHash,
		segmentId: hashEntries([
			{ candidateId: preparation.candidateId, firstId: input.firstId, chainHash: input.chainHash },
		]),
	});
}

/** Validates the note as a preparation candidate's, then requires every source to lie inside the range. */
export function finalizeSegment(snapshot: SegmentSnapshot, result: PreparationResult): PreparedSegment {
	const candidate = finalizePreparation(snapshot.preparation, result);
	const range = new Set(snapshot.rangeIds);
	if (
		noteSections.some((section) => candidate.note[section].some((item) => item.sources.some((id) => !range.has(id))))
	)
		throw new Error("CONTEXT_NOTE_SCOPE: a segment cites a record outside its range");
	return freeze({
		snapshot,
		candidate,
		segmentHash: hashEntries([{ segmentId: snapshot.segmentId, outputHash: candidate.outputHash }]),
	});
}

/** Index of the first record a chain covers: after the latest checkpoint's coverage, or the branch's first. */
function chainStart(branch: readonly SessionRecord[]): number | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "compaction") continue;
		const covered = isRecord(entry.details) ? entry.details.coveredThrough : undefined;
		const end = typeof covered === "string" ? branch.findIndex((record) => record.id === covered) : -1;
		return end < 0 ? undefined : end + 1;
	}
	return 0;
}

/**
 * The share of the history after the base checkpoint's coverage that a chain through `coveredThrough` covers, by the
 * compacted-source estimate; 0 when nothing is uncovered or the base supports no chain. For status only.
 */
export function chainCoverage(branch: readonly SessionRecord[], coveredThrough: string | undefined): number {
	const start = chainStart(branch);
	if (start === undefined) return 0;
	const total = compactedSourceTokens(branch.slice(start));
	const end = coveredThrough === undefined ? -1 : branch.findIndex((record) => record.id === coveredThrough);
	if (!total || end < start) return 0;
	return Math.round((compactedSourceTokens(branch.slice(start, end + 1)) / total) * 100) / 100;
}

/** U3's starting value for a later link's range: 15 % of the trigger, between 8,192 and 32,000 tokens. */
export function segmentRangeTokens(triggerTokens: number): number {
	return Math.min(32_000, Math.max(8_192, Math.floor(triggerTokens * 0.15)));
}

/** Why no range closes now. Each one defers without advancing the chain. */
export type RangeDeferral = "base-unsupported" | "not-contiguous" | "unsettled" | "below-start" | "too-small";

export interface SegmentRange {
	readonly firstId: string;
	readonly lastId: string;
	/** The range's new history, estimated as the core estimates compacted sources. */
	readonly tokens: number;
}

/**
 * U3: the next range to prepare, or why none closes now. A range starts right after the chain's last link, or
 * after the base checkpoint's coverage for the first link of an interval, and ends at the branch's last record,
 * which must close a settled turn: an assistant reply that stopped, with every tool call in the range answered.
 * The first link waits until the context passes half the trigger and then covers everything uncovered, so a
 * session that never nears compaction pays nothing; each later link waits for `segmentRangeTokens` of new history.
 */
export function nextSegmentRange(
	branch: readonly SessionRecord[],
	options: { chainEnd?: string; triggerTokens: number; contextTokens: number },
): { range: SegmentRange } | { defer: RangeDeferral } {
	let start: number | undefined;
	if (options.chainEnd === undefined) {
		start = chainStart(branch);
		if (start === undefined) return { defer: "base-unsupported" };
		if (options.contextTokens < Math.floor(options.triggerTokens / 2)) return { defer: "below-start" };
	} else {
		start = branch.findIndex((record) => record.id === options.chainEnd) + 1;
		if (start === 0) return { defer: "not-contiguous" };
	}
	const range = branch.slice(start);
	const last = range.at(-1);
	if (!last) return { defer: "too-small" };
	if (last.type !== "message" || last.message.role !== "assistant" || last.message.stopReason !== "stop")
		return { defer: "unsettled" };
	try {
		assertToolPairs(range.flatMap((record) => (record.type === "message" ? [record.message] : [])));
	} catch {
		return { defer: "unsettled" };
	}
	const tokens = compactedSourceTokens(range);
	const minimum = options.chainEnd === undefined ? 1 : segmentRangeTokens(options.triggerTokens);
	if (tokens < minimum) return { defer: "too-small" };
	return { range: { firstId: range[0].id, lastId: last.id, tokens } };
}

/**
 * The longest prefix of `links` that the boundary may merge: each link starts where the one before it ends, or
 * right after the base checkpoint's coverage, names the chain before it, and is still a valid candidate whose
 * writer saw every user message through its range. The first link that fails ends the chain; none after it is
 * merged out of order.
 */
export function classifyChain(
	links: readonly PreparedSegment[],
	submission: PreparationSubmission,
): ChainClassification {
	const branch = submission.branch;
	const valid: PreparedSegment[] = [];
	const result = (stop?: ChainClassification["stop"]): ChainClassification => ({
		links: valid,
		...(valid.length ? { coveredThrough: valid[valid.length - 1].snapshot.lastId } : {}),
		...(stop ? { stop } : {}),
	});
	let start = chainStart(branch);
	for (const [index, link] of links.entries()) {
		if (start === undefined) return result({ index, reason: "base-unsupported" });
		if (link.snapshot.firstId !== branch[start]?.id) return result({ index, reason: "not-contiguous" });
		if (link.snapshot.chainHash !== chainHash(valid)) return result({ index, reason: "chain-mismatch" });
		const classification = classifyPreparation(link.candidate, submission);
		if (classification.status === "invalid") return result({ index, reason: classification.reason });
		if (classification.reason === "custom-instructions" || classification.reason === "submission-budget")
			return result({ index, reason: classification.reason });
		const end = start + link.snapshot.rangeIds.length - 1;
		const seen = new Set(link.candidate.input.userHorizon.entryIds);
		if (
			branch
				.slice(0, end + 1)
				.some((entry) => entry.type === "message" && entry.message.role === "user" && !seen.has(entry.id))
		)
			return result({ index, reason: "user-horizon-incomplete" });
		valid.push(link);
		start = end + 1;
	}
	return result();
}

/**
 * The previous checkpoint's note with the chain's notes merged in order, without a model call. A segment's empty
 * gaps do not close earlier ones: its writer may simply have listed none for its range. A ruling that retires a
 * carried instruction must cite a user message in its own range, the only records a segment cites.
 */
export function mergeChain(
	previous: MemoryNote | undefined,
	links: readonly PreparedSegment[],
): { note: MemoryNote } | { refusal: MergeRefusal } {
	return mergeNotes(
		previous,
		links.map((link) => {
			// A mutable copy for the merge; the candidate itself stays frozen.
			const note = structuredClone(link.candidate.note) as MemoryNote;
			const range = new Set(link.snapshot.rangeIds);
			const userMessages = new Set(
				link.candidate.input.sources.flatMap((record) =>
					range.has(record.id) && record.type === "message" && record.message.role === "user" ? [record.id] : [],
				),
			);
			return { note, gapsListed: note.gaps.length > 0, userMessages };
		}),
	);
}
