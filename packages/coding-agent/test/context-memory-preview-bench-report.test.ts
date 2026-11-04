import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type BenchAttempt,
	type BenchProbe,
	type BenchWriterCall,
	cutMeasure,
	NOT_REPORTED,
	OVERHEAD_REPORT_VERSION,
	overheadReport,
	parseCallJournal,
	SOURCE_TIERS,
	sourceTier,
} from "../../../eval/preview/overhead.ts";
import { selectNoteBudget } from "../src/extensions/context-memory/config.ts";

/** A writer call as the bench records it; `input: null` is a call that settled without a usage report. */
function call(phase: string, input: number | null, output = 0, extra: Partial<BenchWriterCall> = {}): BenchWriterCall {
	return { phase, stopReason: "stop", input, cacheRead: 0, cacheWrite: 0, output, reasoning: 0, ...extra };
}

function attempt(fields: Partial<BenchAttempt> & Pick<BenchAttempt, "ok">): BenchAttempt {
	return { fixture: "P1", cut: 1, sourceTokens: 1000, previousNoteTokens: 0, calls: [], journal: [], ...fields };
}

function probe(fields: Partial<BenchProbe>): BenchProbe {
	return { fixture: "P1", cut: 1, condition: "history", roundUsage: [], retrieval: [], journal: [], ...fields };
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** A call journal as the preview writes it: a start line before dispatch, a settlement after. */
function journalText(lines: readonly Record<string, unknown>[], torn = ""): string {
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n${torn}`;
}

describe("preview bench token-overhead report", () => {
	it("computes the writer, discarded, retrieval, cache and net columns from scripted usage", () => {
		const report = overheadReport({
			attempts: [
				attempt({
					ok: true,
					calls: [call("generate", 900, 200, { cacheRead: 100, reasoning: 50 })],
					note: { bytes: 300, contextBytes: 4000, budget: { baseTokens: 3000, hardTokens: 4000 } },
				}),
				attempt({
					ok: true,
					// A tool call the writer declined before it answered with the note.
					calls: [
						call("generate", 800, 10, { stopReason: "toolUse" }),
						call("generate", 850, 180, { cacheRead: 50, reasoning: 40 }),
					],
					note: { bytes: 400, contextBytes: 4000, budget: { baseTokens: 3000, hardTokens: 4000 } },
				}),
				attempt({ ok: false, calls: [call("generate", 900, 150), call("repair", 1000, 120)] }),
			],
			probes: [
				probe({
					roundUsage: [
						{ input: 500, output: 20, cacheRead: 0, cacheWrite: 0 },
						{ input: 900, output: 30, cacheRead: 0, cacheWrite: 0 },
					],
					retrieval: [
						{ operation: "read", entryId: "p1-00003", callBytes: 60, returnedBytes: 1200 },
						{ operation: "search", callBytes: 30, returnedBytes: 299 },
					],
				}),
				probe({ condition: "none", roundUsage: [{ input: 400, output: 25, cacheRead: 0, cacheWrite: 0 }] }),
			],
		});
		expect(report.version).toBe(OVERHEAD_REPORT_VERSION);
		const { writer, discarded, retrieval, cache, net, usageMissing } = report.overall;

		// Committed work: both notes' calls except the declined tool call.
		expect(writer.committed).toBe(2);
		expect(writer.tokens).toEqual({
			calls: 2,
			usageMissing: 0,
			input: 1750,
			cacheRead: 150,
			cacheWrite: NOT_REPORTED,
			cacheWrite1h: NOT_REPORTED,
			output: 380,
			reasoning: 90,
			totalInput: 1900,
		});
		expect(writer.perCheckpoint).toEqual({
			input: 875,
			cacheRead: 75,
			cacheWrite: NOT_REPORTED,
			cacheWrite1h: NOT_REPORTED,
			output: 190,
			reasoning: 45,
			totalInput: 950,
		});
		expect(writer.perNoteByte).toEqual({
			input: round(1750 / 700, 4),
			cacheRead: round(150 / 700, 4),
			cacheWrite: NOT_REPORTED,
			cacheWrite1h: NOT_REPORTED,
			output: round(380 / 700, 4),
			reasoning: round(90 / 700, 4),
			totalInput: round(1900 / 700, 4),
		});
		// Notes against the records they replace: 100 + 134 estimated tokens for 2 x 1000 released.
		expect(writer).toMatchObject({ noteBytes: 700, noteTokens: 234, replacedBytes: 8000, replacedTokens: 2000 });
		expect(writer.noteToReplaced).toBe(round(234 / 2000, 4));

		// Discarded work, each call once: the refused attempt and the declined tool call.
		expect(discarded.refused).toMatchObject({ calls: 2, input: 1900, output: 270 });
		expect(discarded.toolCallDeclined).toMatchObject({ calls: 1, input: 800, output: 10 });
		expect(discarded.repairNotCommitted).toMatchObject({ calls: 1, input: 1000, output: 120 });
		expect(discarded.total).toMatchObject({ calls: 3, input: 2700, output: 280 });
		expect(discarded.crashed.calls).toBe(0);
		expect(discarded.preparation.calls).toBe(0);

		// Retrieval stays apart from the writer, by operation, in estimated tokens.
		expect(retrieval).toMatchObject({ questions: 1, calls: 2, callTokens: 30, returnedTokens: 500 });
		expect(retrieval.byOperation.read).toEqual({ calls: 1, callTokens: 20, returnedTokens: 400 });
		expect(retrieval.byOperation.search).toEqual({ calls: 1, callTokens: 10, returnedTokens: 100 });
		expect(retrieval.byOperation.list.calls).toBe(0);
		expect(retrieval.probeUsage.history).toMatchObject({ calls: 2, input: 1400, output: 50 });
		expect(retrieval.probeUsage.none).toMatchObject({ calls: 1, input: 400, output: 25 });

		expect(cache).toEqual({ cacheRead: 150, cacheWrite: NOT_REPORTED, cacheWrite1h: NOT_REPORTED });
		expect(net).toEqual({
			savedTokens: 1000 - 100 + (1000 - 134),
			pageBackTokens: 500,
			pageBack: { history: 500, excerpts: 0 },
			netTokens: 1766 - 500,
		});
		expect(usageMissing).toEqual({ count: 0, phases: {}, purposes: {} });

		// The same columns per fixture cut.
		expect(Object.keys(report.byCut)).toEqual(["P1-cut1"]);
		expect(report.byCut["P1-cut1"]).toMatchObject({ tier: 1, sourceTokens: 1000, writer: { committed: 2 } });
		expect(report.byCut["P1-cut1"].net).toEqual(net);
	});

	it("reports provider cache writes beside cache reads, and says when no call reported any", () => {
		const reported = overheadReport({
			attempts: [
				attempt({
					ok: true,
					calls: [call("generate", 200, 50, { cacheRead: 800, cacheWrite: 120 })],
					usage: { cacheWrite1h: 60 },
					note: { bytes: 300, contextBytes: 3000 },
				}),
			],
		}).overall;
		expect(reported.writer.tokens).toMatchObject({
			cacheRead: 800,
			cacheWrite: 120,
			cacheWrite1h: 60,
			totalInput: 1120,
		});
		expect(reported.writer.perCheckpoint).toMatchObject({ cacheWrite: 120, cacheWrite1h: 60 });
		expect(reported.cache).toEqual({ cacheRead: 800, cacheWrite: 120, cacheWrite1h: 60 });

		const silent = overheadReport({
			attempts: [
				attempt({ ok: true, calls: [call("generate", 200, 50)], note: { bytes: 300, contextBytes: 3000 } }),
			],
		}).overall;
		// Pi records an unreported cache write as 0; the report does not read that as zero writes.
		expect(silent.writer.tokens.cacheWrite).toBe(NOT_REPORTED);
		expect(silent.writer.tokens.cacheWrite1h).toBe(NOT_REPORTED);
		expect(silent.writer.perNoteByte?.cacheWrite).toBe(NOT_REPORTED);
		expect(silent.cache).toEqual({ cacheRead: 0, cacheWrite: NOT_REPORTED, cacheWrite1h: NOT_REPORTED });
	});

	it("counts a call without a usage report under usageMissing, with its phase, never as zero", () => {
		const section = overheadReport({
			attempts: [
				attempt({
					ok: true,
					calls: [call("generate", null), call("repair", 500, 100)],
					note: { bytes: 300, contextBytes: 3000 },
				}),
			],
			probes: [probe({ roundUsage: [null, { input: 300, output: 10, cacheRead: 0, cacheWrite: 0 }] })],
		}).overall;
		expect(section.writer.tokens).toMatchObject({ calls: 2, usageMissing: 1, input: 500, output: 100 });
		expect(section.retrieval.probeUsage.history).toMatchObject({ calls: 2, usageMissing: 1, input: 300 });
		expect(section.usageMissing).toEqual({
			count: 2,
			phases: { generate: 1, probe: 1 },
			purposes: { compaction: 1, probe: 1 },
		});
	});

	it("keeps the usage of discarded preparations and of a crashed unit, read from the call journal", () => {
		const usage = { input: 400, output: 60, cacheRead: 100, cacheWrite: 0, totalTokens: 560, cost: 0.001 };
		const journal = parseCallJournal(
			journalText(
				[
					{ v: 1, call: "a", purpose: "preparation", interval: "none", step: "generate" },
					{ v: 1, call: "a", outcome: "success", dispatched: true, complete: true, ms: 9, usage },
					// Cancelled before it was sent: it cost nothing and is not counted.
					{ v: 1, call: "b", purpose: "preparation", interval: "none", step: "generate" },
					{ v: 1, call: "b", outcome: "cancelled", dispatched: false, complete: true, ms: 0 },
					{ v: 1, call: "c", purpose: "compaction", interval: "none", step: "generate" },
					{ v: 1, call: "c", outcome: "failed", dispatched: true, complete: true, ms: 30, usage },
					// The unit was killed while this call was in flight.
					{ v: 1, call: "d", purpose: "compaction", interval: "none", step: "repair" },
				],
				'{"v":1,"call":"torn","purpose":"comp',
			),
		);
		expect(journal.map((item) => [item.purpose, item.phase, item.settled, item.dispatched])).toEqual([
			["preparation", "generate", true, true],
			["preparation", "generate", true, false],
			["compaction", "generate", true, true],
			["compaction", "repair", false, null],
		]);

		const preparation = journal.filter((item) => item.purpose === "preparation");
		const report = overheadReport({
			attempts: [
				// A crashed unit: no row of calls, only what its journal recorded.
				attempt({ ok: false, crashed: true, calls: null, journal }),
				// A synchronous compaction: the candidate prepared before it was discarded.
				attempt({
					ok: true,
					path: "sync",
					calls: [call("generate", 700, 90)],
					journal: preparation,
					note: { bytes: 300, contextBytes: 3000 },
				}),
				// A compaction that committed its prepared candidate: that preparation is committed work.
				attempt({
					ok: true,
					path: "complete",
					calls: [],
					journal: preparation,
					note: { bytes: 300, contextBytes: 3000 },
				}),
			],
			probes: [probe({ journal: preparation })],
			warmups: [{ fixture: "P1", cut: 1, journal: preparation }],
		});
		const { discarded, writer, usageMissing } = report.overall;
		expect(discarded.crashed).toMatchObject({ calls: 2, usageMissing: 1, input: 400, cacheRead: 100, output: 60 });
		expect(discarded.repairNotCommitted).toMatchObject({ calls: 1, usageMissing: 1, input: 0 });
		// The crashed unit's, the synchronous compaction's, the probe's and the warm-up's prepared candidates.
		expect(discarded.preparation).toMatchObject({ calls: 4, input: 1600, output: 240 });
		expect(writer.tokens).toMatchObject({ calls: 2, input: 1100, output: 150 });
		expect(usageMissing).toEqual({ count: 1, phases: { repair: 1 }, purposes: { compaction: 1 } });
	});

	it("reads segment calls with their IDs for the replay report, and leaves the overhead columns unchanged", () => {
		const usage = { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 };
		const journal = parseCallJournal(
			journalText([
				{ v: 1, call: "s1", purpose: "segment", interval: "none", step: "generate" },
				{ v: 1, call: "s1", outcome: "success", dispatched: true, complete: true, ms: 9, usage },
				{ v: 1, call: "w1", purpose: "compaction", interval: "none", step: "generate" },
				{ v: 1, call: "w1", outcome: "success", dispatched: true, complete: true, ms: 9, usage },
			]),
		);
		expect(journal.map((item) => [item.id, item.purpose, item.dispatched])).toEqual([
			["s1", "segment", true],
			["w1", "compaction", true],
		]);
		const ok = attempt({ ok: true, path: "segments", calls: [], journal, note: { bytes: 300, contextBytes: 3000 } });
		const without = attempt({
			ok: true,
			path: "segments",
			calls: [],
			journal: journal.filter((item) => item.purpose !== "segment"),
			note: { bytes: 300, contextBytes: 3000 },
		});
		// Segment calls are the replay report's to count: the overhead report reads compaction and preparation calls only.
		expect(overheadReport({ attempts: [ok] })).toEqual(overheadReport({ attempts: [without] }));
	});

	it("charges page-backs and excerpts against the checkpoints' saving in one net column", () => {
		const checkpoint = attempt({
			ok: true,
			sourceTokens: 3000,
			previousNoteTokens: 600,
			calls: [call("generate", 3600, 300)],
			note: { bytes: 900, contextBytes: 12_000 },
		});
		const charged = overheadReport({
			attempts: [checkpoint],
			probes: [
				probe({
					retrieval: [{ operation: "read", entryId: "p1-00002", callBytes: 45, returnedBytes: 3000 }],
					excerptTokens: 200,
				}),
				probe({ condition: "none" }),
			],
		}).overall.net;
		expect(charged).toEqual({
			savedTokens: 3600 - 300,
			pageBackTokens: 1200,
			pageBack: { history: 1000, excerpts: 200 },
			netTokens: 3300 - 1200,
		});
		// Reading back more than the checkpoint saved leaves the net negative.
		const overdrawn = overheadReport({
			attempts: [checkpoint],
			probes: [probe({ retrieval: [{ operation: "list", callBytes: 30, returnedBytes: 12_000 }] })],
		}).overall.net;
		expect(overdrawn.netTokens).toBe(3300 - 4000);
		// No checkpoint committed: nothing saved, and what was read back still counts.
		const refused = overheadReport({
			attempts: [attempt({ ok: false, calls: [call("generate", 3600, 300)] })],
			probes: [probe({ retrieval: [{ operation: "search", callBytes: 30, returnedBytes: 300 }] })],
		}).overall.net;
		expect(refused).toMatchObject({ savedTokens: 0, pageBackTokens: 100, netTokens: -100 });
	});

	it("assigns the v0.2.3 tier at the 80,000, 200,000 and 400,000 boundaries", () => {
		const cases: [number, number][] = [
			[0, 1],
			[80_000, 1],
			[80_001, 2],
			[200_000, 2],
			[200_001, 3],
			[400_000, 3],
			[400_001, 4],
		];
		for (const [tokens, tier] of cases) {
			expect(sourceTier(tokens), String(tokens)).toBe(tier);
			expect(selectNoteBudget({}, 1_000_000, tokens).tier, String(tokens)).toBe(tier);
			const bounds = SOURCE_TIERS.find((item) => item.tier === tier)!;
			expect(tokens >= bounds.fromTokens && (bounds.toTokens === null || tokens <= bounds.toTokens)).toBe(true);
		}

		const report = overheadReport({
			attempts: [80_000, 80_001, 200_001, 400_001].map((sourceTokens, index) =>
				attempt({
					ok: index < 3,
					cut: index + 1,
					sourceTokens,
					calls: [call("generate", 1000 * (index + 1), 100)],
					...(index < 3
						? {
								note: {
									bytes: 3000,
									contextBytes: 30_000,
									budget: { baseTokens: 3000 + index * 1000, hardTokens: 4000 + index * 1000 },
								},
							}
						: {}),
				}),
			),
		});
		expect(Object.keys(report.byTier)).toEqual(["1", "2", "3", "4"]);
		expect(report.byTier["1"]).toMatchObject({ fromTokens: 0, toTokens: 80_000, cuts: ["P1-cut1"] });
		expect(report.byTier["2"]).toMatchObject({
			cuts: ["P1-cut2"],
			writer: { committed: 1, tokens: { input: 2000 } },
		});
		expect(report.byTier["2"].notes).toEqual({
			tokensMedian: 1000,
			tokensMax: 1000,
			baseTokensMedian: 4000,
			hardTokensMedian: 5000,
		});
		expect(report.byTier["3"].cuts).toEqual(["P1-cut3"]);
		// A tier whose cut committed nothing has no per-checkpoint figures, rather than zeros.
		expect(report.byTier["4"]).toMatchObject({
			toTokens: null,
			cuts: ["P1-cut4"],
			writer: { committed: 0, perCheckpoint: null },
		});
		expect(report.byCut["P1-cut2"].tier).toBe(2);
		expect(report.byCut["P1-cut4"].discarded.refused).toMatchObject({ calls: 1, input: 4000 });
	});

	it("measures what a bench session's next checkpoint releases, as the preview measures it", () => {
		const timestamp = "2026-01-01T00:00:00.000Z";
		const note = {
			instructions: [],
			failedPaths: [],
			reasons: [],
			state: [{ text: "Done.", sources: ["u1"] }],
			nextSteps: [],
			files: [],
		};
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "x".repeat(300), timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "u1",
				timestamp,
				summary: "Done.",
				firstKeptEntryId: "u1",
				tokensBefore: 100,
				details: { note },
			},
			{
				type: "message",
				id: "u2",
				parentId: "c1",
				timestamp,
				message: { role: "user", content: "abcd", timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u2",
				timestamp,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Reading." },
						{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
					],
					api: "openai-completions",
					provider: "synthetic",
					model: "report",
					stopReason: "toolUse",
					timestamp: 1,
					usage,
				},
			},
			{
				type: "message",
				id: "r1",
				parentId: "a1",
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: "t1",
					toolName: "read",
					content: [{ type: "text", text: "y".repeat(31) }],
					isError: false,
					timestamp: 1,
				},
			},
		];
		const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 3);
		const assistant = `Reading.\n${JSON.stringify({ tool: "read", arguments: { path: "a.ts" } })}`;
		expect(cutMeasure(entries)).toEqual({
			sourceTokens: tokens("abcd") + tokens(assistant) + tokens("y".repeat(31)),
			previousNoteTokens: tokens(JSON.stringify(note)),
			tier: 1,
		});
		// Before any checkpoint, every entry is released and no note is replaced.
		expect(cutMeasure(entries.slice(0, 1))).toEqual({ sourceTokens: 100, previousNoteTokens: 0, tier: 1 });
	});
});
