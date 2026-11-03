// 0.8.0 WP1: the segment contract. Every record and sentence is invented.
import { describe, expect, it } from "vitest";
import { selectNoteBudget } from "../src/config.ts";
import { CONTEXT_MEMORY_KIND } from "../src/identity.ts";
import type { MemoryNote, NoteFact } from "../src/notes.ts";
import type { PreparationSubmission, PreparationWriterIdentity } from "../src/preparation-candidate.ts";
import type { SessionRecord } from "../src/records.ts";
import {
	chainHash,
	classifyChain,
	finalizeSegment,
	freezeSegmentInput,
	mergeChain,
	type PreparedSegment,
} from "../src/segments.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const TEXT: Record<string, string> = {
	u1: "Use port 4317 for the synthetic service.",
	u2: "The local check reports build 7 green.",
	u3: "Use port 4318 now; 4317 no longer applies.",
};

function user(id: string, parentId: string | null, content = TEXT[id]): SessionRecord {
	return { type: "message", id, parentId, timestamp, message: { role: "user", content } };
}

function reply(id: string, parentId: string): SessionRecord {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "assistant", content: [{ type: "text", text: "Synthetic progress." }], stopReason: "stop" },
	};
}

/** u1 a1 u2 a2 u3 a3: three settled turns, one range each. */
function branch(): SessionRecord[] {
	return [
		user("u1", null),
		reply("a1", "u1"),
		user("u2", "a1"),
		reply("a2", "u2"),
		user("u3", "a2"),
		reply("a3", "u3"),
	];
}

const writer: PreparationWriterIdentity = {
	role: "fixed",
	model: "synthetic/segment",
	effort: "low",
	policyHash: "synthetic-policy",
	promptHash: "synthetic-prompt",
	schemaHash: "synthetic-schema",
	contextHash: null,
};
const noteBudget = selectNoteBudget({}, 64_000, 100);

function fact(id: string, extra: Partial<NoteFact> = {}): NoteFact {
	return { text: TEXT[id], sources: [id], quote: TEXT[id], ...extra };
}

function note(sections: Partial<MemoryNote>): MemoryNote {
	return {
		instructions: [],
		failedPaths: [],
		reasons: [],
		state: [],
		nextSteps: [],
		files: [],
		gaps: [],
		...sections,
	};
}

/** A segment dispatched at the settled turn ending `lastId`, whose writer saw every user message so far. */
function segment(
	records: readonly SessionRecord[],
	firstId: string,
	lastId: string,
	before: readonly PreparedSegment[],
	written: MemoryNote,
	options: { processed?: string[]; chain?: string } = {},
): PreparedSegment {
	const prefix = records.slice(0, records.findIndex((record) => record.id === lastId) + 1);
	const snapshot = freezeSegmentInput({
		sessionId: "synthetic-session",
		epoch: 1,
		branch: prefix,
		coveredThrough: lastId,
		processedUserEntryIds:
			options.processed ??
			prefix
				.filter((record) => record.type === "message" && record.message.role === "user")
				.map((record) => record.id),
		writer,
		noteBudget,
		firstId,
		chainHash: options.chain ?? chainHash(before),
	});
	return finalizeSegment(snapshot, {
		note: written,
		provenance: { writerRole: "fixed", writerModel: writer.model, writerEffort: "low", callIds: [`call-${lastId}`] },
	});
}

function submission(
	records: readonly SessionRecord[],
	extra: Partial<PreparationSubmission> = {},
): PreparationSubmission {
	return { sessionId: "synthetic-session", epoch: 1, branch: records, writer, noteBudget, ...extra };
}

/** Three contiguous links over the default branch. */
function chain(records = branch()): PreparedSegment[] {
	const s1 = segment(records, "u1", "a1", [], note({ instructions: [fact("u1")], state: [fact("u1")] }));
	const s2 = segment(records, "u2", "a2", [s1], note({ state: [fact("u2")] }));
	const s3 = segment(records, "u3", "a3", [s1, s2], note({ state: [fact("u3", { supersedes: ["u1"] })] }));
	return [s1, s2, s3];
}

describe("segment contract (0.8.0 WP1)", () => {
	it("cites only inside its range, while supersedes may name an earlier record", () => {
		const records = branch();
		expect(() => segment(records, "u2", "a2", [], note({ state: [fact("u1")] }))).toThrow(/^CONTEXT_NOTE_SCOPE/);
		expect(
			segment(records, "u3", "a3", [], note({ state: [fact("u3", { supersedes: ["u1"] })] })).snapshot.rangeIds,
		).toEqual(["u3", "a3"]);
		expect(() => segment(records, "missing", "a2", [], note({ state: [fact("u2")] }))).toThrow(
			/^CONTEXT_PREPARATION_INPUT/,
		);
	});

	it("merges the whole chain when every link is contiguous and current", () => {
		const records = branch();
		const result = classifyChain(chain(records), submission(records));
		expect(result.links).toHaveLength(3);
		expect(result.coveredThrough).toBe("a3");
		expect(result.stop).toBeUndefined();
	});

	it("keeps a chain whose last link was written before later turns arrived", () => {
		const records = [...branch(), user("u4", "a3", "Continue checking."), reply("a4", "u4")];
		expect(classifyChain(chain(records), submission(records))).toMatchObject({ coveredThrough: "a3" });
	});

	it("ends the chain at a gap and discards every link after it", () => {
		const records = branch();
		const [s1, , s3] = chain(records);
		const result = classifyChain([s1, s3], submission(records));
		expect(result.links).toEqual([s1]);
		expect(result).toMatchObject({ coveredThrough: "a1", stop: { index: 1, reason: "not-contiguous" } });
	});

	it("ends the chain at a link written over a different chain", () => {
		const records = branch();
		const [s1] = chain(records);
		const stray = segment(records, "u2", "a2", [s1], note({ state: [fact("u2")] }), { chain: chainHash([]) });
		expect(classifyChain([s1, stray], submission(records)).stop).toEqual({ index: 1, reason: "chain-mismatch" });
	});

	it("ends the chain at the first link whose sources changed", () => {
		const links = chain();
		const edited = branch();
		edited[2] = user("u2", "a1", "The local check reports build 7 red.");
		const result = classifyChain(links, submission(edited));
		expect(result).toMatchObject({ coveredThrough: "a1", stop: { index: 1, reason: "source-changed" } });
	});

	it("ends the chain at a link whose writer missed a user message in its range", () => {
		const records = branch();
		const [s1] = chain(records);
		const blind = segment(records, "u2", "a2", [s1], note({ state: [fact("u2")] }), { processed: ["u1"] });
		expect(classifyChain([s1, blind], submission(records)).stop).toEqual({
			index: 1,
			reason: "user-horizon-incomplete",
		});
	});

	it("merges nothing for a compaction with custom instructions", () => {
		const records = branch();
		const result = classifyChain(chain(records), submission(records, { customInstructions: "Focus on ports." }));
		expect(result.links).toHaveLength(0);
		expect(result.stop).toEqual({ index: 0, reason: "custom-instructions" });
	});

	it("starts after the base checkpoint's coverage and refuses a base without one", () => {
		const base: SessionRecord = {
			type: "compaction",
			id: "c1",
			parentId: "a1",
			timestamp,
			summary: "Context memory.",
			firstKeptEntryId: "u2",
			tokensBefore: 100,
			details: { kind: CONTEXT_MEMORY_KIND, coveredThrough: "a1" },
		};
		const records = [user("u1", null), reply("a1", "u1"), base, user("u2", "c1"), reply("a2", "u2")];
		const late = segment(records, "u2", "a2", [], note({ state: [fact("u2")] }));
		expect(classifyChain([late], submission(records)).stop).toEqual({ index: 0, reason: "not-contiguous" });
		const first = segment(records, "c1", "a2", [], note({ state: [fact("u2")] }));
		expect(classifyChain([first], submission(records)).coveredThrough).toBe("a2");
		const native = [...records];
		native[2] = { ...base, details: {} };
		const foreign = segment(native, "c1", "a2", [], note({ state: [fact("u2")] }));
		expect(classifyChain([foreign], submission(native)).stop).toEqual({ index: 0, reason: "base-unsupported" });
	});
});

describe("merging a chain without a model call (0.8.0 WP1, U6)", () => {
	it("adds a segment's instructions and facts after the previous note's", () => {
		const records = branch();
		const [s1, s2] = chain(records);
		const merged = mergeChain(undefined, [s1, s2]);
		expect(merged).toEqual({ note: note({ instructions: [fact("u1")], state: [fact("u1"), fact("u2")] }) });
	});

	it("leaves the boundary to the writer when a segment supersedes a carried instruction", () => {
		expect(mergeChain(undefined, chain())).toEqual({ refusal: "instruction-superseded" });
	});

	it("leaves the boundary to the writer when a superseded source supports more facts than replace them", () => {
		const records = branch();
		const previous = note({ state: [fact("u2"), { text: "Build 7 is the release candidate.", sources: ["u2"] }] });
		const s3 = segment(records, "u3", "a3", [], note({ state: [fact("u3", { supersedes: ["u2"] })] }));
		expect(mergeChain(previous, [s3])).toEqual({ refusal: "ambiguous-supersede" });
	});

	it("leaves the boundary to the writer when the merged note outgrows the schema", () => {
		const records = branch();
		const previous = note({
			state: Array.from({ length: 40 }, (_, index) => ({ text: `Synthetic fact ${index}.`, sources: ["u1"] })),
		});
		const s2 = segment(records, "u2", "a2", [], note({ state: [fact("u2")] }));
		expect(mergeChain(previous, [s2])).toEqual({ refusal: "schema" });
	});

	it("keeps earlier gaps when a segment lists none, and takes a segment's listed gaps", () => {
		const records = branch();
		const previous = note({ state: [fact("u1")], gaps: ["Which port does staging use?"] });
		const quiet = segment(records, "u2", "a2", [], note({ state: [fact("u2")] }));
		expect(mergeChain(previous, [quiet])).toMatchObject({ note: { gaps: ["Which port does staging use?"] } });
		const listed = segment(records, "u2", "a2", [], note({ state: [fact("u2")], gaps: ["Is build 8 due?"] }));
		expect(mergeChain(previous, [listed])).toMatchObject({ note: { gaps: ["Is build 8 due?"] } });
	});
});
