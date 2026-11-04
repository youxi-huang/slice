import { selectNoteBudget, type NoteBudget } from "../src/config.ts";
import { prefixCut, segmentPrefixCut } from "../src/cuts.ts";
import { errorCode, PROJECT_CODES } from "../src/events.ts";
import { assertToolPairs } from "../src/guards.ts";
import { CONTEXT_KEEP_NONE, CONTEXT_MEMORY_KIND, CONTEXT_MEMORY_VERSION } from "../src/identity.ts";
import { removeNoteEnvelope } from "../src/note-envelope.ts";
import {
	type MemoryCheckpoint,
	type MemoryNote,
	noteBytes,
	renderContinuation,
	renderNote,
	validateMemoryCheckpoints,
	validateNote,
} from "../src/notes.ts";
import type { PreparationSubmission, PreparationWriterIdentity } from "../src/preparation-candidate.ts";
import { diagnoseQuotes, type QuoteFailureKind } from "../src/quote-diagnostics.ts";
import { applyQuoteRepair, quoteRepairEligible } from "../src/quote-repair.ts";
import type { CompactionRecord, SessionRecord } from "../src/records.ts";
import { diagnoseSchema, type SchemaCounts } from "../src/schema-diagnostics.ts";
import type { ScopeCounts } from "../src/scope-diagnostics.ts";
import {
	chainHash,
	type ChainClassification,
	classifyChain,
	finalizeSegment,
	freezeSegmentInput,
	mergeChain,
	nextSegmentRange,
	type PreparedSegment,
} from "../src/segments.ts";
import { applySourcesRepair, sourcesRepairEligible } from "../src/sources-repair.ts";

export type Serialization = "pi" | "jcs";
export type Outcome = { outcome: "commit" } | { outcome: "refusal"; code: string };

interface VectorBase {
	id: string;
	records: SessionRecord[];
	candidate: unknown;
	expected: Outcome;
}

export type ConformanceVector = VectorBase &
	(
		| {
				stage: "note";
				diagnosis?: {
					schema?: SchemaCounts;
					scope?: ScopeCounts;
					quote?: QuoteFailureKind;
					envelope?: "type" | "schema" | null;
				};
				budget?: {
					threshold: number;
					sourceTokens: number;
					previousTokens: number;
					expected: Pick<NoteBudget, "tier" | "baseTokens" | "hardTokens">;
					candidateBytes: number;
				};
		  }
		| { stage: "sources-repair" | "quote-repair"; response: unknown }
		| { stage: "tool-pairs" }
		| {
				stage: "checkpoint";
				originalRecords?: SessionRecord[];
				checkpoint: {
					sourceHashes: Partial<Record<Serialization, string>>;
					continuation?: string[];
					renderContinuation?: boolean;
				};
		  }
	);

export interface SegmentLink {
	firstId: string;
	lastId: string;
	note: unknown;
	processedUserEntryIds?: string[];
	chainHash?: string;
}

interface SegmentBoundary {
	records?: SessionRecord[];
	session?: string;
	epoch?: number;
	writer?: Partial<PreparationWriterIdentity>;
	customInstructions?: string;
	noteBudget?: Partial<NoteBudget>;
}

export type SegmentChainOutcome = { links: number } & Pick<ChainClassification, "coveredThrough" | "stop">;
export type SegmentMergeOutcome = ReturnType<typeof mergeChain>;
type RangeOutcome = ReturnType<typeof nextSegmentRange>;
type CutOutcome = { cut: number | null };
type SegmentOutcome = Outcome | SegmentChainOutcome | SegmentMergeOutcome | RangeOutcome | CutOutcome;

export type SegmentVector = Pick<VectorBase, "id" | "records"> &
	(
		| {
				stage: "segment-range";
				options: Parameters<typeof nextSegmentRange>[1];
				expected: RangeOutcome;
		  }
		| {
				stage: "segment-cut";
				coveredIndex: number;
				cut: number;
				path: "segments" | "prefix";
				expected: CutOutcome | Outcome;
		  }
		| { stage: "segment"; link: SegmentLink; expected: Outcome }
		| { stage: "segment-chain"; links: SegmentLink[]; boundary?: SegmentBoundary; expected: SegmentChainOutcome }
		| {
				stage: "segment-merge";
				links: SegmentLink[];
				previous?: MemoryNote;
				boundary?: SegmentBoundary;
				expected: SegmentMergeOutcome;
		  }
	);

const segmentWriter: PreparationWriterIdentity = {
	role: "fixed",
	model: "synthetic/segment",
	effort: "low",
	policyHash: "synthetic-policy",
	promptHash: "synthetic-prompt",
	schemaHash: "synthetic-schema",
	contextHash: null,
};
const segmentBudget = selectNoteBudget({}, 64_000, 100);

/** Each link is dispatched on its own settled prefix, before any later turns arrive. */
function prepareSegment(records: SessionRecord[], link: SegmentLink, before: PreparedSegment[]): PreparedSegment {
	const prefix = records.slice(0, records.findIndex((record) => record.id === link.lastId) + 1);
	const snapshot = freezeSegmentInput({
		sessionId: "synthetic-session",
		epoch: 1,
		branch: prefix,
		coveredThrough: link.lastId,
		processedUserEntryIds:
			link.processedUserEntryIds ??
			prefix
				.filter((record) => record.type === "message" && record.message.role === "user")
				.map((record) => record.id),
		writer: segmentWriter,
		noteBudget: segmentBudget,
		firstId: link.firstId,
		chainHash: link.chainHash ?? chainHash(before),
	});
	return finalizeSegment(snapshot, {
		note: link.note,
		provenance: {
			writerRole: segmentWriter.role,
			writerModel: segmentWriter.model,
			writerEffort: segmentWriter.effort,
			callIds: [`synthetic-call-${link.lastId}`],
		},
	});
}

/** Exact-size expansion only for the budget vectors; all other candidates remain untouched. */
export function materializeCandidate(vector: ConformanceVector): unknown {
	if (vector.stage !== "note" || !vector.budget) return structuredClone(vector.candidate);
	const note = structuredClone(validateNote(vector.candidate, vector.records));
	const target = vector.budget.candidateBytes;
	while (noteBytes(note) < target) {
		const fact = note.state[note.state.length - 1];
		const room = Math.min(4000 - fact.text.length, target - noteBytes(note));
		if (room > 0) fact.text += "x".repeat(room);
		else note.state.push({ text: "x", sources: [...note.state[0].sources] });
	}
	if (noteBytes(note) !== target) throw new Error(`Invalid budget vector size: ${vector.id}`);
	return note;
}

/** Shared input assembly for core and future adapter runners; no validation result is synthesized. */
export function checkpointBranch(
	vector: Extract<ConformanceVector, { stage: "checkpoint" }>,
	serialization: Serialization,
	records = vector.records,
): SessionRecord[] {
	const sourceHash = vector.checkpoint.sourceHashes[serialization];
	if (!sourceHash || !records.length) throw new Error(`Incomplete checkpoint vector: ${vector.id}`);
	const note = vector.candidate as MemoryNote;
	const coveredThrough = records[records.length - 1].id;
	const checkpoint: CompactionRecord<MemoryCheckpoint> = {
		type: "compaction",
		id: "checkpoint-1",
		parentId: coveredThrough,
		timestamp: "2026-01-01T00:00:01.000Z",
		summary: renderNote(note),
		firstKeptEntryId: CONTEXT_KEEP_NONE,
		tokensBefore: 100,
		details: {
			kind: CONTEXT_MEMORY_KIND,
			version: CONTEXT_MEMORY_VERSION,
			note,
			coveredThrough,
			sourceHash,
			snapshot: { sessionId: "synthetic-session", leafId: coveredThrough, lastCheckpointId: null },
			writerModel: "synthetic/writer",
			chunkCount: 1,
			build: "synthetic-build",
			...(vector.checkpoint.continuation === undefined ? {} : { continuation: vector.checkpoint.continuation }),
		},
	};
	if (vector.checkpoint.renderContinuation) {
		const ids = new Set(vector.checkpoint.continuation);
		checkpoint.summary += renderContinuation(records.filter((record) => ids.has(record.id)));
	}
	return [...records, checkpoint];
}

/** Run only the nominated stage, always reaching the real core check that owns its refusal. */
export function runCoreVector(vector: ConformanceVector, serialization?: Serialization): Outcome;
export function runCoreVector(vector: SegmentVector, serialization?: Serialization): SegmentOutcome;
export function runCoreVector(
	vector: ConformanceVector | SegmentVector,
	serialization: Serialization = "pi",
): SegmentOutcome {
	try {
		if (vector.stage === "segment-range") return nextSegmentRange(vector.records, vector.options);
		if (vector.stage === "segment-cut") {
			const projection = {
				entries: vector.records.map((record) => ({
					sourceEntry: record,
					messages: record.type === "message" ? [record.message] : [],
				})),
			};
			return { cut: (vector.path === "segments" ? segmentPrefixCut : prefixCut)(vector.records, projection, vector.coveredIndex, vector.cut) ?? null };
		}
		if (vector.stage === "segment" || vector.stage === "segment-chain" || vector.stage === "segment-merge") {
			const links: PreparedSegment[] = [];
			for (const link of vector.stage === "segment" ? [vector.link] : vector.links)
				links.push(prepareSegment(vector.records, link, links));
			if (vector.stage === "segment") return { outcome: "commit" };
			const boundary = vector.boundary;
			const submission: PreparationSubmission = {
				sessionId: boundary?.session ?? "synthetic-session",
				epoch: boundary?.epoch ?? 1,
				branch: boundary?.records ?? vector.records,
				writer: { ...segmentWriter, ...boundary?.writer },
				noteBudget: { ...segmentBudget, ...boundary?.noteBudget },
				customInstructions: boundary?.customInstructions,
			};
			const classification = classifyChain(links, submission);
			if (vector.stage === "segment-chain") {
				const { links: valid, ...result } = classification;
				return { links: valid.length, ...result };
			}
			if (classification.stop) throw new Error(`Invalid segment-merge chain: ${vector.id}`);
			if (vector.previous) validateNote(vector.previous, vector.records);
			return mergeChain(vector.previous, classification.links);
		}
		let candidate = removeNoteEnvelope(materializeCandidate(vector)).value;
		switch (vector.stage) {
			case "note": {
				const budget = vector.budget;
				const limit = budget
					? selectNoteBudget({}, budget.threshold, budget.sourceTokens, budget.previousTokens).hardTokens
					: undefined;
				validateNote(candidate, vector.records, limit);
				break;
			}
			case "sources-repair": {
				const diagnosis = diagnoseSchema(candidate);
				if (!sourcesRepairEligible(diagnosis)) throw new Error(`Ineligible sources-repair vector: ${vector.id}`);
				candidate = applySourcesRepair(diagnosis.pending, diagnosis.uncited, vector.response);
				validateNote(candidate, vector.records);
				break;
			}
			case "quote-repair": {
				const note = candidate as MemoryNote;
				const diagnosis = diagnoseQuotes(note, vector.records);
				if (!quoteRepairEligible(diagnosis)) throw new Error(`Ineligible quote-repair vector: ${vector.id}`);
				candidate = applyQuoteRepair(note, diagnosis.failures, vector.response).note;
				validateNote(candidate, vector.records);
				break;
			}
			case "tool-pairs":
				assertToolPairs(vector.records.flatMap((record) => (record.type === "message" ? [record.message] : [])));
				validateNote(candidate, vector.records);
				break;
			case "checkpoint":
				validateMemoryCheckpoints(checkpointBranch(vector, serialization), undefined, serialization);
				break;
			default:
				throw new Error("Unknown conformance stage");
		}
		return { outcome: "commit" };
	} catch (error) {
		const code = errorCode(error instanceof Error ? error.message : undefined);
		if (!PROJECT_CODES.has(code)) throw error;
		return { outcome: "refusal", code };
	}
}
