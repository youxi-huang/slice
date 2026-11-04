// Lifted from the preview controller into the host-neutral core (v0.7.0 WP2 step 4): the pure cut
// selection of the specification's cut rules — `chooseCut`, `prefixCut` — and `checkpointInterval`.
// The host's `SessionEntry`/`SessionProjection` type imports became the structural record and
// projection shapes in records.ts, and the host's projection builder and token estimator are the
// caller's to supply: the Pi adapter binds `buildSessionProjection` and `estimateTokens`. Logic,
// bounds and thrown messages are unchanged (rule K2).
import { assertToolPairs } from "./guards.ts";
import type { RecordProjection, SessionRecord } from "./records.ts";
import type { ReducibleMessage } from "./reduction.ts";

/**
 * Keep complete recent turns; a zero budget uses stock Pi's no-matching-kept-entry convention. The cut
 * follows the previous checkpoint: stock Pi keeps every entry from the cut onwards, so an earlier
 * checkpoint inside that range would reappear as a second summary.
 */
export function chooseCut<TMessage>(
	branch: readonly SessionRecord[],
	keepRecentTokens: number,
	projection: RecordProjection<TMessage>,
	estimateTokens: (message: TMessage) => number,
): number {
	if (keepRecentTokens <= 0) return branch.length;
	const projected = new Map(projection.entries.map((entry) => [entry.sourceEntry.id, entry.messages]));
	const previous = branch.findLastIndex((entry) => entry.type === "compaction");
	const starts = branch.flatMap((entry, index) =>
		index > previous && entry.type === "message" && entry.message.role === "user" && projected.get(entry.id)?.length
			? [index]
			: [],
	);
	if (!starts.length) throw new Error("CONTEXT_NO_CUT: no source turn is available");
	let accumulated = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index].type === "compaction") continue;
		accumulated += (projected.get(branch[index].id) ?? []).reduce((sum, message) => sum + estimateTokens(message), 0);
		if (accumulated >= keepRecentTokens) return starts.find((start) => start >= index) ?? starts[starts.length - 1];
	}
	return starts[starts.length - 1];
}

/**
 * The latest turn start at or before `coveredIndex + 1` and `cut`, so that only covered entries leave
 * context. It must follow the previous checkpoint: stock Pi keeps every entry from the cut onwards,
 * so an earlier checkpoint inside that range would reappear as a second summary.
 */
export function prefixCut(
	branch: readonly SessionRecord[],
	projection: RecordProjection,
	coveredIndex: number,
	cut: number,
): number | undefined {
	const previous = branch.findLastIndex((entry) => entry.type === "compaction");
	const projected = new Set(
		projection.entries.filter((entry) => entry.messages.length).map((entry) => entry.sourceEntry.id),
	);
	for (let index = Math.min(cut, coveredIndex + 1); index > previous; index--) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "user" && projected.has(entry.id)) return index;
	}
	return undefined;
}

/** Segments may also release a covered complete tool batch at the next projected assistant message. */
export function segmentPrefixCut(
	branch: readonly SessionRecord[],
	projection: RecordProjection<ReducibleMessage>,
	coveredIndex: number,
	cut: number,
): number | undefined {
	const next = coveredIndex + 1;
	const covered = branch[coveredIndex];
	const entry = branch[next];
	if (
		next <= cut &&
		next > branch.findLastIndex((record) => record.type === "compaction") &&
		covered?.type === "message" &&
		covered.message.role === "toolResult" &&
		entry?.type === "message" &&
		entry.message.role === "assistant" &&
		projection.entries.some((record) => record.sourceEntry.id === entry.id && record.messages.length)
	) {
		const prefix = new Set(branch.slice(0, next).map((record) => record.id));
		assertToolPairs(
			projection.entries.filter((record) => prefix.has(record.sourceEntry.id)).flatMap((record) => record.messages),
		);
		assertToolPairs(
			projection.entries.filter((record) => !prefix.has(record.sourceEntry.id)).flatMap((record) => record.messages),
		);
		return next;
	}
	return prefixCut(branch, projection, coveredIndex, cut);
}

/** The interval a preparation belongs to: the latest checkpoint on the branch, or none yet. */
export function checkpointInterval(branch: readonly SessionRecord[]): string {
	return branch.findLast((entry) => entry.type === "compaction")?.id ?? "none";
}
