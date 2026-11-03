// Lifted from the preview into the host-neutral core (v0.7.0 WP2 step 4): the call-accounting
// contracts — `CallUsage`, `CallSummary`, `CallPurpose`, the gap states,
// `PREPARATION_CALLS_PER_ATTEMPT`, and the unknown-never-free rule as `summarizeCalls`, the
// aggregation `CallJournal.summary` performed over its records. The journal's file IO class stays
// with the adapter in the preview's call-journal.ts, which re-exports these. Shapes and logic are
// unchanged (rule K2).

/** Optional preparation never sends more provider requests than this in one attempt. */
export const PREPARATION_CALLS_PER_ATTEMPT = 8;

/** 0.8.0 U9: segment calls per checkpoint interval, repairs included. */
export const SEGMENT_CALLS_PER_INTERVAL = 8;

export type CallPurpose = "preparation" | "compaction" | "segment";

export interface CallUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** As reported or estimated by Pi's model catalog, in USD. */
	cost: number;
}

/** A journal that cannot be read or written leaves a gap: optional work pauses, and status says so. */
export type CallJournalGap = "unreadable" | "unwritable";

/** What `/compaction-status` reports. A call without reported usage is unknown, never free. */
export interface CallSummary {
	calls: number;
	preparationCalls: number;
	compactionCalls: number;
	segmentCalls: number;
	/** Recorded before dispatch but never settled: interrupted, still in flight, or settled after a write failure. */
	unsettled: number;
	/** Settled without any reported usage. */
	unknownUsage: number;
	/** Usage reported only up to an interruption. */
	partialUsage: number;
	usage: CallUsage;
	gap?: CallJournalGap;
}

/** One writer call as the journal knows it: started, and settled once its outcome is on disk. */
export interface CallRecord {
	purpose: CallPurpose;
	interval: string;
	settled: boolean;
	dispatched?: boolean;
	usage?: CallUsage;
	complete?: boolean;
}

/** All-zero usage: the identity of the usage sum. */
export const ZERO_USAGE: Readonly<CallUsage> = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};

/**
 * The status summary over a journal's records. A call settled as never dispatched is not counted; a call that was
 * never settled is unsettled, and one settled without reported usage is unknown: neither adds to the usage sum, so
 * a call without a usage report is unknown, never free.
 */
export function summarizeCalls(records: Iterable<CallRecord>, gap?: CallJournalGap): CallSummary {
	const summary: CallSummary = {
		calls: 0,
		preparationCalls: 0,
		compactionCalls: 0,
		segmentCalls: 0,
		unsettled: 0,
		unknownUsage: 0,
		partialUsage: 0,
		usage: { ...ZERO_USAGE },
		...(gap ? { gap } : {}),
	};
	for (const record of records) {
		if (record.settled && record.dispatched === false) continue;
		summary.calls++;
		if (record.purpose === "preparation") summary.preparationCalls++;
		else if (record.purpose === "segment") summary.segmentCalls++;
		else summary.compactionCalls++;
		if (!record.settled) summary.unsettled++;
		else if (!record.usage) summary.unknownUsage++;
		else {
			if (!record.complete) summary.partialUsage++;
			for (const key of Object.keys(ZERO_USAGE) as (keyof CallUsage)[]) summary.usage[key] += record.usage[key];
		}
	}
	return summary;
}

/** What one interval's segment calls have spent, for U9's call limit and spending cap. */
export interface SegmentSpend {
	calls: number;
	/** Input, cache writes and output: the tokens a cache miss multiplies. Cache reads are U4's intended path. */
	uncachedTokens: number;
	/** A dispatched call with no reported usage, settled or not. */
	unknown: boolean;
}

export function segmentSpend(records: Iterable<CallRecord>, interval: string): SegmentSpend {
	const spend: SegmentSpend = { calls: 0, uncachedTokens: 0, unknown: false };
	for (const record of records) {
		if (record.purpose !== "segment" || record.interval !== interval) continue;
		if (record.settled && record.dispatched === false) continue;
		spend.calls++;
		if (!record.usage) spend.unknown = true;
		else spend.uncachedTokens += record.usage.input + record.usage.cacheWrite + record.usage.output;
	}
	return spend;
}

/**
 * U9's spending cap, a starting value WP5 measures: one interval's segments may spend as many uncached tokens as the
 * trigger holds, about what one synchronous compaction reads when its cache misses. Unknown usage spends it all.
 */
export function segmentBudgetLeft(spend: SegmentSpend, triggerTokens: number): boolean {
	return !spend.unknown && spend.calls < SEGMENT_CALLS_PER_INTERVAL && spend.uncachedTokens < triggerTokens;
}
