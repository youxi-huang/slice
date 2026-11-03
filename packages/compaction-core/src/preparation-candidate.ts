// Lifted whole from the preview into the host-neutral core (v0.7.0 WP2 step 4, K11: it lifts as it
// stands): `freezePreparationInput`, `finalizePreparation`, `classifyPreparation`, `reusablePrefix`
// and their shapes. The host's `SessionEntry` type import became the structural record shapes in
// records.ts, Pi's `ThinkingLevel` the equal `WriterEffort` union below, and the shared
// config/identity imports moved to the core's copies. Logic, bounds and thrown messages are
// unchanged (rule K2).
import { type NoteBudget, storedNoteLimit } from "./config.ts";
import { hashEntries } from "./identity.ts";
import { type MemoryNote, noteBytes, sourceText, validateNote } from "./notes.ts";
import type { SessionRecord } from "./records.ts";

/** The writer effort levels the identity check accepts: exactly Pi's `ThinkingLevel` or `"off"`. */
export type WriterEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type Frozen<T> = T extends object ? { readonly [Key in keyof T]: Frozen<T[Key]> } : T;

/** Policy identities deliberately exclude the note budget, which is checked as a size bound. */
export interface PreparationWriterIdentity {
	role: "session" | "fixed";
	/** Resolved provider/model, never the unresolved `session` selector. */
	model: string;
	effort: WriterEffort;
	policyHash: string;
	promptHash: string;
	schemaHash: string;
	/** System/tool context identity; required for the session writer. */
	contextHash: string | null;
}

export interface PreparationInput {
	sessionId: string;
	epoch: number;
	branch: readonly SessionRecord[];
	coveredThrough: string;
	/** Cumulative delivered-source horizon, including inherited checkpoint provenance; no semantic attestation. */
	processedUserEntryIds: readonly string[];
	writer: PreparationWriterIdentity;
	noteBudget: NoteBudget;
}

export interface PreparationSnapshot {
	readonly version: 1;
	readonly candidateId: string;
	readonly sessionId: string;
	readonly epoch: number;
	/** Ancestry at dispatch. Appends are allowed; selecting a sibling is not. */
	readonly branchAncestry: readonly Readonly<{ id: string; parentId: string | null }>[];
	readonly branchAncestryHash: string;
	readonly baseCheckpoint: Readonly<{ id: string; hash: string }> | null;
	readonly coverage: {
		readonly coveredThrough: string;
		readonly sourceHash: string;
		readonly entryIds: readonly string[];
		readonly originalIds: readonly string[];
	};
	readonly userHorizon: { readonly entryIds: readonly string[]; readonly hash: string };
	readonly writer: Readonly<PreparationWriterIdentity>;
	readonly noteBudget: Readonly<NoteBudget>;
	/** Deeply frozen at runtime; avoid recursively mapping upstream extensible message payload types. */
	readonly sources: readonly Readonly<SessionRecord>[];
}

export interface PreparationProvenance {
	writerRole: PreparationWriterIdentity["role"];
	writerModel: string;
	writerEffort: WriterEffort;
	/** Identifiers link paid dispatches to their call journal records. */
	callIds: readonly string[];
}

export interface PreparationResult {
	note: unknown;
	provenance: PreparationProvenance;
}

export interface PreparedCandidate {
	readonly input: PreparationSnapshot;
	readonly note: Frozen<MemoryNote>;
	readonly noteHash: string;
	readonly bytes: number;
	readonly provenance: Readonly<PreparationProvenance>;
	readonly provenanceHash: string;
	readonly outputHash: string;
}

export interface PreparationSubmission {
	sessionId: string;
	epoch: number;
	branch: readonly SessionRecord[];
	writer: PreparationWriterIdentity;
	noteBudget: NoteBudget;
	customInstructions?: string;
}

export type CandidateClassification =
	| { status: "current-full"; reason: "complete" }
	| {
			status: "stale-reusable";
			reason:
				| "new-user-input"
				| "new-sources"
				| "user-horizon-incomplete"
				| "custom-instructions"
				| "submission-budget";
	  }
	| {
			status: "invalid";
			reason:
				| "session-changed"
				| "epoch-changed"
				| "branch-changed"
				| "base-checkpoint-changed"
				| "source-changed"
				| "writer-changed"
				| "configuration-invalid";
	  };

function freeze(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	for (const child of Object.values(value)) freeze(child);
	Object.freeze(value);
}

function frozenClone<T>(value: T): T {
	const cloned = structuredClone(value);
	freeze(cloned);
	return cloned;
}

function inputError(): never {
	throw new Error("CONTEXT_PREPARATION_INPUT: invalid preparation snapshot");
}

function uniqueIds(ids: readonly string[]): boolean {
	return ids.every((id) => typeof id === "string" && id.length > 0) && new Set(ids).size === ids.length;
}

function linearBranch(branch: readonly SessionRecord[]): boolean {
	return (
		branch.length > 0 &&
		uniqueIds(branch.map((entry) => entry.id)) &&
		branch.every((entry, index) => entry.parentId === (index === 0 ? null : branch[index - 1].id))
	);
}

function lastCheckpoint(branch: readonly SessionRecord[]): { id: string; hash: string } | null {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "compaction") return { id: entry.id, hash: hashEntries([entry]) };
	}
	return null;
}

function writerIdentity(writer: PreparationWriterIdentity): PreparationWriterIdentity {
	if (
		!(writer.role === "session" || writer.role === "fixed") ||
		typeof writer.model !== "string" ||
		!writer.model.includes("/") ||
		writer.model.startsWith("/") ||
		writer.model.endsWith("/") ||
		!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(writer.effort) ||
		![writer.policyHash, writer.promptHash, writer.schemaHash].every(
			(id) => typeof id === "string" && id.length > 0,
		) ||
		(writer.contextHash !== null && (typeof writer.contextHash !== "string" || !writer.contextHash)) ||
		(writer.role === "session" && writer.contextHash === null)
	)
		inputError();
	return {
		role: writer.role,
		model: writer.model,
		effort: writer.effort,
		policyHash: writer.policyHash,
		promptHash: writer.promptHash,
		schemaHash: writer.schemaHash,
		contextHash: writer.contextHash,
	};
}

function notePolicy(budget: NoteBudget): NoteBudget {
	storedNoteLimit(budget);
	return {
		version: budget.version,
		mode: budget.mode,
		tier: budget.tier,
		sourceTokens: budget.sourceTokens,
		previousTokens: budget.previousTokens,
		baseTokens: budget.baseTokens,
		hardTokens: budget.hardTokens,
	};
}

/** Pure, inactive preparation foundation: no provider calls, journal writes or commit side effects. */
export function freezePreparationInput(input: PreparationInput): PreparationSnapshot {
	const branch = structuredClone(input.branch);
	const end = branch.findIndex((entry) => entry.id === input.coveredThrough);
	if (!input.sessionId || !Number.isSafeInteger(input.epoch) || input.epoch < 0 || !linearBranch(branch) || end < 0)
		inputError();
	const baseCheckpoint = lastCheckpoint(branch);
	if (baseCheckpoint && branch.findIndex((entry) => entry.id === baseCheckpoint.id) > end) inputError();
	const sources = branch.slice(0, end + 1);
	const userIds = sources
		.filter((entry) => entry.type === "message" && entry.message.role === "user")
		.map((entry) => entry.id);
	const horizon = [...input.processedUserEntryIds];
	if (
		!uniqueIds(horizon) ||
		horizon.some(
			(id, index) =>
				userIds.indexOf(id) < 0 || (index > 0 && userIds.indexOf(id) <= userIds.indexOf(horizon[index - 1])),
		)
	)
		inputError();
	const branchAncestry = branch.map((entry) => ({ id: entry.id, parentId: entry.parentId }));
	const envelope = {
		version: 1 as const,
		sessionId: input.sessionId,
		epoch: input.epoch,
		branchAncestry,
		branchAncestryHash: hashEntries([{ sessionId: input.sessionId }, ...branchAncestry]),
		baseCheckpoint,
		coverage: {
			coveredThrough: input.coveredThrough,
			sourceHash: hashEntries(sources),
			entryIds: sources.map((entry) => entry.id),
			originalIds: sources.filter((entry) => sourceText(entry)).map((entry) => entry.id),
		},
		userHorizon: { entryIds: horizon, hash: hashEntries(horizon) },
		writer: writerIdentity(input.writer),
		noteBudget: notePolicy(input.noteBudget),
	};
	return frozenClone({ ...envelope, candidateId: hashEntries([envelope]), sources });
}

/** A result may finish after an append; freshness is checked independently at submission. */
export function finalizePreparation(input: PreparationSnapshot, result: PreparationResult): PreparedCandidate {
	const actual = result.provenance;
	const provenance = {
		writerRole: actual.writerRole,
		writerModel: actual.writerModel,
		writerEffort: actual.writerEffort,
		callIds: [...actual.callIds],
	};
	if (
		provenance.writerRole !== input.writer.role ||
		provenance.writerModel !== input.writer.model ||
		provenance.writerEffort !== input.writer.effort
	)
		throw new Error("CONTEXT_PREPARATION_WRITER: result writer differs from the frozen configured writer");
	if (!provenance.callIds.length || !uniqueIds(provenance.callIds))
		throw new Error("CONTEXT_PREPARATION_PROVENANCE: missing or ambiguous call accounting links");
	const note = validateNote(
		structuredClone(result.note),
		structuredClone(input.sources),
		storedNoteLimit(input.noteBudget),
	);
	const noteHash = hashEntries([note]);
	const provenanceHash = hashEntries([provenance]);
	return frozenClone({
		input,
		note,
		noteHash,
		bytes: noteBytes(note),
		provenance,
		provenanceHash,
		outputHash: hashEntries([{ candidateId: input.candidateId, noteHash, provenanceHash }]),
	});
}

type InvalidReason = Extract<CandidateClassification, { status: "invalid" }>["reason"];

/**
 * Why a frozen input no longer matches the submission, or undefined while it does. 0.8.0 (WP2) split it from
 * `classifyPreparation` unchanged, so a run still in flight is cancelled the moment its input turns invalid.
 */
export function invalidPreparation(
	input: PreparationSnapshot,
	submission: PreparationSubmission,
): InvalidReason | undefined {
	if (submission.sessionId !== input.sessionId) return "session-changed";
	if (submission.epoch !== input.epoch) return "epoch-changed";
	const branch = submission.branch;
	if (
		!linearBranch(branch) ||
		input.branchAncestry.some(
			(entry, index) => branch[index]?.id !== entry.id || branch[index]?.parentId !== entry.parentId,
		)
	)
		return "branch-changed";
	if (JSON.stringify(lastCheckpoint(branch)) !== JSON.stringify(input.baseCheckpoint))
		return "base-checkpoint-changed";
	const prefix = branch.slice(0, input.coverage.entryIds.length);
	if (hashEntries(prefix) !== input.coverage.sourceHash) return "source-changed";
	try {
		if (hashEntries([writerIdentity(submission.writer)]) !== hashEntries([input.writer])) return "writer-changed";
		storedNoteLimit(submission.noteBudget);
	} catch {
		return "configuration-invalid";
	}
	return undefined;
}

/** Mechanical source/horizon eligibility only; this does not prove semantic preservation of user rulings. */
export function classifyPreparation(
	candidate: PreparedCandidate,
	submission: PreparationSubmission,
): CandidateClassification {
	const input = candidate.input;
	const invalid = invalidPreparation(input, submission);
	if (invalid) return { status: "invalid", reason: invalid };
	const branch = submission.branch;
	const prefix = branch.slice(0, input.coverage.entryIds.length);
	const hardTokens = storedNoteLimit(submission.noteBudget);
	if (candidate.bytes > hardTokens * 3) return { status: "stale-reusable", reason: "submission-budget" };
	if (submission.customInstructions?.trim()) return { status: "stale-reusable", reason: "custom-instructions" };
	const tail = branch.slice(input.coverage.entryIds.length);
	if (tail.some((entry) => entry.type === "message" && entry.message.role === "user"))
		return { status: "stale-reusable", reason: "new-user-input" };
	// Conservatively include context edits and metadata appends until their projection contract is integrated.
	if (tail.length) return { status: "stale-reusable", reason: "new-sources" };
	if (
		prefix.some(
			(entry) =>
				entry.type === "message" && entry.message.role === "user" && !input.userHorizon.entryIds.includes(entry.id),
		)
	)
		return { status: "stale-reusable", reason: "user-horizon-incomplete" };
	return { status: "current-full", reason: "complete" };
}

/**
 * Index of the last entry a prepared note covers, when it can be committed for that prefix as it stands:
 * the prefix is intact and fully seen, and only later entries were appended. Those later originals stay
 * in context verbatim, after the note, as any newer message does in an ordinary conversation.
 */
export function reusablePrefix(
	candidate: PreparedCandidate,
	classification: CandidateClassification,
	branch: readonly SessionRecord[],
): number | undefined {
	if (
		classification.status !== "stale-reusable" ||
		(classification.reason !== "new-user-input" && classification.reason !== "new-sources")
	)
		return undefined;
	const end = candidate.input.coverage.entryIds.length - 1;
	const seen = new Set(candidate.input.userHorizon.entryIds);
	const unseen = branch
		.slice(0, end + 1)
		.some((entry) => entry.type === "message" && entry.message.role === "user" && !seen.has(entry.id));
	return unseen ? undefined : end;
}
