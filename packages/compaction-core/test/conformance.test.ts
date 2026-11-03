import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type ConformanceVector,
	checkpointBranch,
	materializeCandidate,
	runCoreVector,
	type SegmentVector,
	type Serialization,
} from "../conformance/runner.ts";
import { serializeCanonicalRecord } from "../src/canonical.ts";
import { selectNoteBudget, storedNoteLimit } from "../src/config.ts";
import { errorCode, PROJECT_CODES } from "../src/events.ts";
import { removeNoteEnvelope } from "../src/note-envelope.ts";
import {
	latestMemory,
	type MemoryNote,
	noteBytes,
	validateMemoryCheckpoints,
	validateNoteContent,
} from "../src/notes.ts";
import { diagnoseQuotes } from "../src/quote-diagnostics.ts";
import { diagnoseSchema, schemaCounts } from "../src/schema-diagnostics.ts";
import { diagnoseScope } from "../src/scope-diagnostics.ts";
import type { ChainStop } from "../src/segments.ts";
import type { MergeRefusal } from "../src/work-notes.ts";

const directory = new URL("../conformance/", import.meta.url);
const manifest: { version: string; files: Record<string, string> } = JSON.parse(
	readFileSync(new URL("manifest.json", directory), "utf8"),
);
const vectors: ConformanceVector[] = JSON.parse(readFileSync(new URL("vectors.json", directory), "utf8"));
const segments: SegmentVector[] = JSON.parse(readFileSync(new URL("segments.json", directory), "utf8"));

describe("0.8-conformance.1", () => {
	it("pins the complete data set and uses only unique IDs and closed-set refusal classes", () => {
		expect(manifest.version).toBe("0.8-conformance.1");
		expect(Object.keys(manifest.files).sort()).toEqual(["segments.json", "vectors.json"]);
		expect(Object.keys(manifest.files).sort()).toEqual(
			readdirSync(directory)
				.filter((name) => name.endsWith(".json") && name !== "manifest.json")
				.sort(),
		);
		for (const [file, digest] of Object.entries(manifest.files)) {
			expect(digest).toMatch(/^[a-f0-9]{64}$/);
			expect(
				createHash("sha256")
					.update(readFileSync(new URL(file, directory)))
					.digest("hex"),
				file,
			).toBe(digest);
		}
		expect(vectors).toHaveLength(34);
		expect(segments).toHaveLength(24);
		const all = [...vectors, ...segments];
		expect(new Set(all.map((vector) => vector.id)).size).toBe(all.length);
		for (const vector of all) {
			expect(vector.id).toMatch(/^[a-z0-9-]+$/);
			if ("outcome" in vector.expected && vector.expected.outcome === "refusal")
				expect(PROJECT_CODES.has(vector.expected.code), vector.id).toBe(true);
			for (const [index, record] of vector.records.entries())
				expect(record.parentId).toBe(vector.records[index - 1]?.id ?? null);
		}
	});

	it("covers every chain stop and merge refusal in the segment contract", () => {
		const stops: Record<ChainStop, true> = {
			"session-changed": true,
			"epoch-changed": true,
			"branch-changed": true,
			"base-checkpoint-changed": true,
			"source-changed": true,
			"writer-changed": true,
			"configuration-invalid": true,
			"custom-instructions": true,
			"submission-budget": true,
			"user-horizon-incomplete": true,
			"base-unsupported": true,
			"not-contiguous": true,
			"chain-mismatch": true,
		};
		const refusals: Record<MergeRefusal, true> = {
			"instruction-superseded": true,
			"ambiguous-supersede": true,
			schema: true,
		};
		expect(
			new Set(
				segments.flatMap((vector) =>
					vector.stage === "segment-chain" && vector.expected.stop ? [vector.expected.stop.reason] : [],
				),
			),
		).toEqual(new Set(Object.keys(stops)));
		expect(
			new Set(
				segments.flatMap((vector) =>
					vector.stage === "segment-merge" && "refusal" in vector.expected ? [vector.expected.refusal] : [],
				),
			),
		).toEqual(new Set(Object.keys(refusals)));
	});

	for (const vector of segments) {
		it(vector.id, () => {
			const before = structuredClone(vector);
			if (
				vector.stage === "segment" &&
				vector.expected.outcome === "refusal" &&
				vector.expected.code === "CONTEXT_NOTE_SCOPE"
			)
				// The source and quotation are valid in the dispatch prefix; only the segment's range excludes them.
				expect(() => validateNoteContent(vector.link.note, vector.records)).not.toThrow();
			expect(runCoreVector(vector)).toEqual(vector.expected);
			expect(vector).toEqual(before);
		});
	}

	for (const vector of vectors) {
		const serializations: Serialization[] =
			vector.stage === "checkpoint" ? (Object.keys(vector.checkpoint.sourceHashes) as Serialization[]) : ["pi"];
		for (const serialization of serializations) {
			it(`${vector.id} (${serialization})`, () => {
				const candidate = removeNoteEnvelope(materializeCandidate(vector));
				if (vector.stage === "note") {
					const { diagnosis, budget } = vector;
					if (diagnosis?.schema) expect(schemaCounts(diagnoseSchema(candidate.value))).toEqual(diagnosis.schema);
					if (diagnosis?.scope)
						expect(diagnoseScope(candidate.value as MemoryNote, vector.records)).toEqual(diagnosis.scope);
					if (diagnosis?.quote) {
						const quotes = diagnoseQuotes(candidate.value as MemoryNote, vector.records);
						expect(quotes.unreadable).toBe(false);
						expect(quotes.failures.map((failure) => failure.kind)).toEqual([diagnosis.quote]);
					}
					if (diagnosis && "envelope" in diagnosis) expect(candidate.envelope ?? null).toBe(diagnosis.envelope);
					if (budget) {
						const policy = selectNoteBudget({}, budget.threshold, budget.sourceTokens, budget.previousTokens);
						expect(policy).toMatchObject(budget.expected);
						expect(storedNoteLimit(policy)).toBe(budget.expected.hardTokens);
						expect(noteBytes(validateNoteContent(candidate.value, vector.records))).toBe(budget.candidateBytes);
					}
				}
				if (vector.stage === "checkpoint" && vector.originalRecords) {
					expect(runCoreVector({ ...vector, records: vector.originalRecords }, serialization)).toEqual({
						outcome: "commit",
					});
					// The edited evidence still supports the exact quotation: only its stored hash may refuse.
					expect(() => validateNoteContent(vector.candidate, vector.records)).not.toThrow();
					const original = checkpointBranch(vector, serialization, vector.originalRecords);
					expect(latestMemory(original, serialization)?.entry.id).toBe("checkpoint-1");
					try {
						latestMemory(checkpointBranch(vector, serialization), serialization);
						throw new Error("Expected source change refusal");
					} catch (error) {
						expect(errorCode(error instanceof Error ? error.message : undefined)).toBe("CONTEXT_SOURCE_CHANGED");
					}
				}
				const before = structuredClone(vector);
				expect(runCoreVector(vector, serialization)).toEqual(vector.expected);
				expect(vector).toEqual(before);
			});
		}
	}

	it("keeps canonical reopen stable on key reordering and keeps the default Pi policy", () => {
		const vector = vectors.find((item) => item.stage === "checkpoint" && item.originalRecords);
		if (!vector || vector.stage !== "checkpoint" || !vector.originalRecords) throw new Error("Missing source vector");
		const branch = checkpointBranch(vector, "jcs", vector.originalRecords);
		const source = branch[0];
		if (source.type !== "message") throw new Error("Expected message record");
		branch[0] = {
			message: { content: source.message.content, role: source.message.role },
			timestamp: source.timestamp,
			parentId: source.parentId,
			id: source.id,
			type: source.type,
		};
		const emitted: string[] = [];
		expect(validateMemoryCheckpoints(branch, (_index, bytes) => emitted.push(bytes), "jcs")?.entry.id).toBe(
			"checkpoint-1",
		);
		expect(emitted).toEqual(branch.map(serializeCanonicalRecord));
		expect(() => validateMemoryCheckpoints(branch)).toThrow("CONTEXT_SOURCE_CHANGED");
		const bare: string[] = [];
		expect(validateMemoryCheckpoints(branch.slice(0, 1), (_index, bytes) => bare.push(bytes), "jcs")).toBeUndefined();
		expect(bare).toEqual([serializeCanonicalRecord(branch[0])]);
	});
});
