import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { selectNoteBudget } from "../../packages/coding-agent/src/extensions/context-memory/config.ts";
import { sourceText } from "../../packages/coding-agent/src/extensions/context-memory/notes.ts";

// The token-overhead report of the 0.6.0 plan (WP1), computed from the writer bench's rows.
//
// Every column comes from what the rows already hold: the per-call usage the preview records, the call journal of
// each unit, the committed note's size and the retrieval calls of each probe. Nothing here calls a model, so the
// report's arithmetic runs offline on the loopback provider's usage and on scripted rows alike. Token counts are the
// provider's, as Pi records them; sizes are the preview's own estimate, ceil(UTF-8 bytes / 3).

/** Change it whenever a column's definition changes, so reports compare only within one version. */
export const OVERHEAD_REPORT_VERSION = "0.6-overhead-report.1";

/** What a figure no call in its column reported reads, instead of zero. */
export const NOT_REPORTED = "not reported";
export type Reported = number | typeof NOT_REPORTED;

/** The v0.2.3 source-size tiers of `selectNoteBudget`, by the tokens a checkpoint releases. */
export const SOURCE_TIERS = [
	{ tier: 1, fromTokens: 0, toTokens: 80_000 },
	{ tier: 2, fromTokens: 80_001, toTokens: 200_000 },
	{ tier: 3, fromTokens: 200_001, toTokens: 400_000 },
	{ tier: 4, fromTokens: 400_001, toTokens: null },
] as const;

/** Token counts one provider call reported. */
export interface CallUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
}

/** One writer call as a bench row records it; `input` is null when the call settled without a usage report. */
export interface BenchWriterCall {
	phase: string;
	stopReason?: string | null;
	input?: number | null;
	cacheRead?: number | null;
	cacheWrite?: number | null;
	output?: number | null;
	reasoning?: number | null;
}

/** One call of the preview's call journal: its start line and, when one followed, its settlement. Content-free. */
export interface JournalCall {
	/** The journal's call ID, which a checkpoint's preparation metadata names when it merged the call's segment. */
	id?: string;
	purpose: "compaction" | "preparation" | "segment";
	phase: string;
	/** False when no settlement followed the start line: the unit stopped while the call was in flight. */
	settled: boolean;
	/** False for a call cancelled before it was sent; such a call cost nothing and is not counted. */
	dispatched: boolean | null;
	outcome: string | null;
	usage: CallUsage | null;
}

/** One compaction attempt: a writer-mode row or a probes-mode compaction row. */
export interface BenchAttempt {
	fixture: string;
	cut: number;
	/** Readable tokens the checkpoint releases, as `selectNoteBudget` measures them; see `cutMeasure`. */
	sourceTokens: number;
	/** Estimated tokens of the note the checkpoint replaces, 0 at the first cut. */
	previousNoteTokens: number;
	ok: boolean;
	crashed?: boolean;
	/** How the compaction found its note; `complete` when a prepared candidate was committed. */
	path?: string | null;
	calls?: readonly BenchWriterCall[] | null;
	/** The attempt's summed usage, the only place Pi keeps 1-hour cache writes. */
	usage?: { cacheWrite1h?: number } | null;
	journal?: readonly JournalCall[] | null;
	note?: { bytes: number; contextBytes: number; budget?: { baseTokens: number; hardTokens: number } | null } | null;
}

/** One `context_history` call of a probe: its operation, the entry a read named, and the bytes either way. */
export interface HistoryCall {
	operation: string;
	entryId?: string | null;
	callBytes: number;
	returnedBytes: number;
}

export interface BenchProbe {
	fixture: string;
	cut: number;
	condition: "history" | "none";
	/** Each assistant response's usage, or null when the response carried no usage report. */
	roundUsage?: readonly (CallUsage | null)[] | null;
	retrieval?: readonly HistoryCall[] | null;
	/** Tokens of historical excerpts the preview appended to the probe's requests; none before WP4. */
	excerptTokens?: number;
	journal?: readonly JournalCall[] | null;
}

/** A warm-up unit; only the preparation calls its journal may hold count here. */
export interface BenchWarmup {
	fixture: string;
	cut: number;
	journal?: readonly JournalCall[] | null;
}

export interface OverheadInput {
	attempts: readonly BenchAttempt[];
	probes?: readonly BenchProbe[];
	warmups?: readonly BenchWarmup[];
}

const estimate = (bytes: number) => Math.ceil(bytes / 3);
const round = (value: number, digits: number) => Number(value.toFixed(digits));
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The v0.2.3 tier a cut falls in: the shared `selectNoteBudget`, read for its tier only. */
export function sourceTier(sourceTokens: number): number {
	return selectNoteBudget({}, 0, sourceTokens).tier;
}

/**
 * What the next checkpoint of a bench session releases: the readable tokens of every entry after the latest
 * compaction, which is what `selectNoteBudget` receives when no recent entries are kept, and the estimated tokens
 * of the latest note. The bench keeps no recent entries.
 */
export function cutMeasure(entries: readonly SessionEntry[]): {
	sourceTokens: number;
	previousNoteTokens: number;
	tier: number;
} {
	const last = entries.findLastIndex((entry) => entry.type === "compaction");
	const latest = last >= 0 ? entries[last] : undefined;
	const note = latest?.type === "compaction" && record(latest.details) ? latest.details.note : undefined;
	const sourceTokens = entries
		.slice(last + 1)
		.reduce((sum, entry) => sum + estimate(Buffer.byteLength(sourceText(entry), "utf8")), 0);
	return {
		sourceTokens,
		previousNoteTokens: note === undefined ? 0 : estimate(Buffer.byteLength(JSON.stringify(note), "utf8")),
		tier: sourceTier(sourceTokens),
	};
}

function journalUsage(value: unknown): CallUsage | null {
	if (!record(value)) return null;
	const { input, output, cacheRead, cacheWrite } = value;
	if (!count(input) || !count(output) || !count(cacheRead) || !count(cacheWrite)) return null;
	return { input, output, cacheRead, cacheWrite };
}

/**
 * The calls of one session's journal file, in dispatch order. A torn final line is dropped, as the preview drops it:
 * its fsync never completed, so that call was never sent. Lines this report cannot read are skipped.
 */
export function parseCallJournal(text: string): JournalCall[] {
	const lines = text.split("\n");
	if (lines.at(-1) !== "") lines.pop();
	const calls = new Map<string, JournalCall>();
	for (const line of lines) {
		if (!line) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (!record(value) || value.v !== 1 || typeof value.call !== "string") continue;
		if (value.purpose === "compaction" || value.purpose === "preparation" || value.purpose === "segment") {
			calls.set(value.call, {
				id: value.call,
				purpose: value.purpose,
				phase: typeof value.step === "string" ? value.step : "unknown",
				settled: false,
				dispatched: null,
				outcome: null,
				usage: null,
			});
			continue;
		}
		const call = calls.get(value.call);
		if (!call) continue;
		call.settled = true;
		call.dispatched = typeof value.dispatched === "boolean" ? value.dispatched : null;
		call.outcome = typeof value.outcome === "string" ? value.outcome : null;
		call.usage = journalUsage(value.usage);
	}
	return [...calls.values()];
}

interface Figures {
	calls: number;
	usageMissing: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	/** Calls that reported a cache write; Pi records an unreported count as 0, so none means not reported. */
	cacheWriteReports: number;
	/** Only summed attempt usage carries it; undefined until one reported it. */
	cacheWrite1h?: number;
	output: number;
	reasoning: number;
}

const figures = (): Figures => ({
	calls: 0,
	usageMissing: 0,
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cacheWriteReports: 0,
	output: 0,
	reasoning: 0,
});

interface Operation {
	calls: number;
	callTokens: number;
	returnedTokens: number;
}

const OPERATIONS = ["search", "read", "list", "other"] as const;

interface Accumulator {
	writer: Figures;
	refused: Figures;
	crashed: Figures;
	toolCallDeclined: Figures;
	preparation: Figures;
	repairNotCommitted: Figures;
	probes: { history: Figures; none: Figures };
	committed: number;
	noteBytes: number;
	noteTokens: number[];
	replacedBytes: number;
	replacedTokens: number;
	savedTokens: number;
	baseTokens: number[];
	hardTokens: number[];
	questions: number;
	operations: Record<(typeof OPERATIONS)[number], Operation>;
	excerptTokens: number;
	missing: { count: number; phases: Record<string, number>; purposes: Record<string, number> };
}

function accumulator(): Accumulator {
	return {
		writer: figures(),
		refused: figures(),
		crashed: figures(),
		toolCallDeclined: figures(),
		preparation: figures(),
		repairNotCommitted: figures(),
		probes: { history: figures(), none: figures() },
		committed: 0,
		noteBytes: 0,
		noteTokens: [],
		replacedBytes: 0,
		replacedTokens: 0,
		savedTokens: 0,
		baseTokens: [],
		hardTokens: [],
		questions: 0,
		operations: Object.fromEntries(
			OPERATIONS.map((operation) => [operation, { calls: 0, callTokens: 0, returnedTokens: 0 }]),
		) as Record<(typeof OPERATIONS)[number], Operation>,
		excerptTokens: 0,
		missing: { count: 0, phases: {}, purposes: {} },
	};
}

function add(target: Figures, usage: CallUsage | null): void {
	target.calls++;
	if (!usage) {
		target.usageMissing++;
		return;
	}
	target.input += usage.input;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	if (usage.cacheWrite > 0) target.cacheWriteReports++;
	target.output += usage.output;
	target.reasoning += usage.reasoning ?? 0;
}

/** A call without a usage report is unknown, never free: it is counted here and adds nothing to any total. */
function tallyMissing(acc: Accumulator, usage: CallUsage | null, purpose: string, phase: string): void {
	if (usage) return;
	acc.missing.count++;
	acc.missing.phases[phase] = (acc.missing.phases[phase] ?? 0) + 1;
	acc.missing.purposes[purpose] = (acc.missing.purposes[purpose] ?? 0) + 1;
}

function detailUsage(call: BenchWriterCall): CallUsage | null {
	if (!count(call.input)) return null;
	return {
		input: call.input,
		cacheRead: call.cacheRead ?? 0,
		cacheWrite: call.cacheWrite ?? 0,
		output: call.output ?? 0,
		reasoning: call.reasoning ?? 0,
	};
}

/**
 * The attempt's writer calls: the row's own call records first, then any journal call beyond them, which is how a
 * crashed or timed-out unit's calls, and the usage they settled with, stay counted.
 */
function writerCalls(attempt: BenchAttempt): { phase: string; stopReason: string | null; usage: CallUsage | null }[] {
	const details = (attempt.calls ?? []).map((call) => ({
		phase: call.phase,
		stopReason: call.stopReason ?? null,
		usage: detailUsage(call),
	}));
	const journal = (attempt.journal ?? []).filter((call) => call.purpose === "compaction" && call.dispatched !== false);
	return [
		...details,
		...journal.slice(details.length).map((call) => ({ phase: call.phase, stopReason: null, usage: call.usage })),
	];
}

function preparationCalls(journal: readonly JournalCall[] | null | undefined): JournalCall[] {
	return (journal ?? []).filter((call) => call.purpose === "preparation" && call.dispatched !== false);
}

function addAttempt(acc: Accumulator, attempt: BenchAttempt): void {
	const failed = attempt.crashed ? acc.crashed : acc.refused;
	for (const call of writerCalls(attempt)) {
		// Each call lands in one column: committed work, a declined tool call, or the attempt that did not commit.
		const target = !attempt.ok ? failed : call.stopReason === "toolUse" ? acc.toolCallDeclined : acc.writer;
		add(target, call.usage);
		if (!attempt.ok && call.phase === "repair") add(acc.repairNotCommitted, call.usage);
		tallyMissing(acc, call.usage, "compaction", call.phase);
	}
	const oneHour = attempt.usage?.cacheWrite1h;
	if (count(oneHour)) {
		const target = attempt.ok ? acc.writer : failed;
		target.cacheWrite1h = (target.cacheWrite1h ?? 0) + oneHour;
	}
	// A prepared candidate is committed work only when this attempt committed it; otherwise it was discarded.
	const reused = attempt.ok && attempt.path === "complete";
	for (const call of preparationCalls(attempt.journal)) {
		add(reused ? acc.writer : acc.preparation, call.usage);
		tallyMissing(acc, call.usage, "preparation", call.phase);
	}
	if (!attempt.ok || !attempt.note) return;
	const noteTokens = estimate(attempt.note.bytes);
	const replacedTokens = attempt.sourceTokens + attempt.previousNoteTokens;
	acc.committed++;
	acc.noteBytes += attempt.note.bytes;
	acc.noteTokens.push(noteTokens);
	acc.replacedBytes += attempt.note.contextBytes;
	acc.replacedTokens += replacedTokens;
	acc.savedTokens += replacedTokens - noteTokens;
	if (attempt.note.budget) {
		acc.baseTokens.push(attempt.note.budget.baseTokens);
		acc.hardTokens.push(attempt.note.budget.hardTokens);
	}
}

function addProbe(acc: Accumulator, probe: BenchProbe): void {
	for (const usage of probe.roundUsage ?? []) {
		add(acc.probes[probe.condition], usage);
		tallyMissing(acc, usage, "probe", "probe");
	}
	if (probe.condition === "history") acc.questions++;
	for (const call of probe.retrieval ?? []) {
		const operation = (OPERATIONS as readonly string[]).includes(call.operation)
			? (call.operation as (typeof OPERATIONS)[number])
			: "other";
		const target = acc.operations[operation];
		target.calls++;
		target.callTokens += estimate(call.callBytes);
		target.returnedTokens += estimate(call.returnedBytes);
	}
	acc.excerptTokens += probe.excerptTokens ?? 0;
	// A probe's session copy is discarded with it, so a candidate prepared during the probe is never committed.
	for (const call of preparationCalls(probe.journal)) {
		add(acc.preparation, call.usage);
		tallyMissing(acc, call.usage, "preparation", call.phase);
	}
}

function addWarmup(acc: Accumulator, warmup: BenchWarmup): void {
	for (const call of preparationCalls(warmup.journal)) {
		add(acc.preparation, call.usage);
		tallyMissing(acc, call.usage, "preparation", call.phase);
	}
}

function merged(list: readonly Figures[]): Figures {
	const total = figures();
	for (const item of list) {
		for (const key of ["calls", "usageMissing", "input", "cacheRead", "cacheWrite", "cacheWriteReports"] as const)
			total[key] += item[key];
		total.output += item.output;
		total.reasoning += item.reasoning;
		if (item.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + item.cacheWrite1h;
	}
	return total;
}

export interface TokenColumn {
	calls: number;
	/** Calls in this column without a usage report; their tokens are unknown, not zero. */
	usageMissing: number;
	input: number;
	cacheRead: number;
	cacheWrite: Reported;
	cacheWrite1h: Reported;
	output: number;
	reasoning: number;
	/** Input, cache reads and reported cache writes together: every prompt token the provider processed. */
	totalInput: number;
}

function column(value: Figures): TokenColumn {
	const cacheWrite = value.cacheWriteReports ? value.cacheWrite : 0;
	return {
		calls: value.calls,
		usageMissing: value.usageMissing,
		input: value.input,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWriteReports ? value.cacheWrite : NOT_REPORTED,
		cacheWrite1h: value.cacheWrite1h ?? NOT_REPORTED,
		output: value.output,
		reasoning: value.reasoning,
		totalInput: value.input + value.cacheRead + cacheWrite,
	};
}

/** A column's figures divided by `divisor`, or null when there is nothing to divide by. */
function per(value: TokenColumn, divisor: number, digits: number) {
	if (!divisor) return null;
	const share = (figure: number) => round(figure / divisor, digits);
	const reported = (figure: Reported): Reported => (figure === NOT_REPORTED ? NOT_REPORTED : share(figure));
	return {
		input: share(value.input),
		cacheRead: share(value.cacheRead),
		cacheWrite: reported(value.cacheWrite),
		cacheWrite1h: reported(value.cacheWrite1h),
		output: share(value.output),
		reasoning: share(value.reasoning),
		totalInput: share(value.totalInput),
	};
}

/** The bench's median convention: the middle value, the upper one of an even count. */
function median(values: readonly number[]): number | null {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function writerSection(acc: Accumulator) {
	const tokens = column(acc.writer);
	const noteTokens = acc.noteTokens.reduce((sum, value) => sum + value, 0);
	return {
		committed: acc.committed,
		tokens,
		perCheckpoint: per(tokens, acc.committed, 1),
		perNoteByte: per(tokens, acc.noteBytes, 4),
		noteBytes: acc.noteBytes,
		noteTokens,
		replacedBytes: acc.replacedBytes,
		replacedTokens: acc.replacedTokens,
		noteToReplaced: acc.replacedTokens ? round(noteTokens / acc.replacedTokens, 4) : null,
	};
}

function section(acc: Accumulator) {
	const discarded = [acc.refused, acc.crashed, acc.toolCallDeclined, acc.preparation];
	const everything = merged([acc.writer, ...discarded, acc.probes.history, acc.probes.none]);
	const operations = Object.values(acc.operations);
	const returnedTokens = operations.reduce((sum, item) => sum + item.returnedTokens, 0);
	const pageBackTokens = returnedTokens + acc.excerptTokens;
	const all = column(everything);
	return {
		writer: writerSection(acc),
		retrieval: {
			questions: acc.questions,
			calls: operations.reduce((sum, item) => sum + item.calls, 0),
			callTokens: operations.reduce((sum, item) => sum + item.callTokens, 0),
			returnedTokens,
			byOperation: structuredClone(acc.operations),
			probeUsage: { history: column(acc.probes.history), none: column(acc.probes.none) },
		},
		discarded: {
			total: column(merged(discarded)),
			refused: column(acc.refused),
			crashed: column(acc.crashed),
			toolCallDeclined: column(acc.toolCallDeclined),
			preparation: column(acc.preparation),
			/** Repair calls of attempts that did not commit; already counted under refused or crashed. */
			repairNotCommitted: column(acc.repairNotCommitted),
		},
		usageMissing: structuredClone(acc.missing),
		cache: { cacheRead: all.cacheRead, cacheWrite: all.cacheWrite, cacheWrite1h: all.cacheWrite1h },
		net: {
			savedTokens: acc.savedTokens,
			pageBackTokens,
			pageBack: { history: returnedTokens, excerpts: acc.excerptTokens },
			netTokens: acc.savedTokens - pageBackTokens,
		},
	};
}

/**
 * The report for one run: overall, per fixture cut, and the writer's figures per source-size tier. Every writer call
 * is counted once: committed work under `writer`; discarded work under `discarded`; a call without usage under
 * `usageMissing` as well as in its column's own `usageMissing`, never as zero.
 */
export function overheadReport(input: OverheadInput) {
	const overall = accumulator();
	const cuts = new Map<string, { acc: Accumulator; tier: number | null; sourceTokens: number | null }>();
	const tiers = new Map<number, { acc: Accumulator; cuts: Set<string> }>(
		SOURCE_TIERS.map((item) => [item.tier, { acc: accumulator(), cuts: new Set<string>() }]),
	);
	const cut = (fixture: string, index: number) => {
		const key = `${fixture}-cut${index}`;
		let value = cuts.get(key);
		if (!value) {
			value = { acc: accumulator(), tier: null, sourceTokens: null };
			cuts.set(key, value);
		}
		return { key, value };
	};
	for (const attempt of input.attempts) {
		const { key, value } = cut(attempt.fixture, attempt.cut);
		const tier = sourceTier(attempt.sourceTokens);
		value.tier ??= tier;
		value.sourceTokens ??= attempt.sourceTokens;
		const byTier = tiers.get(tier)!;
		byTier.cuts.add(key);
		for (const acc of [overall, value.acc, byTier.acc]) addAttempt(acc, attempt);
	}
	for (const probe of input.probes ?? []) {
		const { value } = cut(probe.fixture, probe.cut);
		for (const acc of [overall, value.acc]) addProbe(acc, probe);
	}
	for (const warmup of input.warmups ?? []) {
		const { value } = cut(warmup.fixture, warmup.cut);
		for (const acc of [overall, value.acc]) addWarmup(acc, warmup);
	}
	return {
		version: OVERHEAD_REPORT_VERSION,
		overall: section(overall),
		byCut: Object.fromEntries(
			[...cuts].map(([key, value]) => [
				key,
				{ tier: value.tier, sourceTokens: value.sourceTokens, ...section(value.acc) },
			]),
		),
		byTier: Object.fromEntries(
			SOURCE_TIERS.map((item) => {
				const value = tiers.get(item.tier)!;
				return [
					String(item.tier),
					{
						fromTokens: item.fromTokens,
						toTokens: item.toTokens,
						cuts: [...value.cuts],
						writer: writerSection(value.acc),
						notes: {
							tokensMedian: median(value.acc.noteTokens),
							tokensMax: value.acc.noteTokens.length ? Math.max(...value.acc.noteTokens) : null,
							baseTokensMedian: median(value.acc.baseTokens),
							hardTokensMedian: median(value.acc.hardTokens),
						},
					},
				];
			}),
		),
	};
}
