// Lifted from the preview into the host-neutral core (v0.7.0 WP2 step 3): the notes, identity and
// quote-diagnostics imports moved to the core's copies, and the host's SessionEntry type import
// became the specification's structural SessionRecord (records.ts). Logic, the work-note schema,
// the merge, bounds and thrown messages are unchanged (rule K2). In 0.8.0 (WP1) the merge became
// `mergeNotes`, which also carries instructions a merged note adds and says why it refuses; work
// notes have no instructions, so `mergeWorkNotes` behaves as before.
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { CONTEXT_NOTE_TYPE, isRecord } from "./identity.ts";
import {
	LINE_BREAKS,
	type MemoryNote,
	type NoteFact,
	noteSchema,
	noteSections,
	oneLineNote,
	sourceText,
	validateNote,
} from "./notes.ts";
import { diagnoseQuotes, quoteFeedback } from "./quote-diagnostics.ts";
import type { SessionRecord } from "./records.ts";

/** Each fact renders as one line, so model-written text cannot open a heading or a section of the checkpoint. */
const ONE_LINE = `^[^${LINE_BREAKS}]+$`;
const entryIds = (minItems: number, description: string) =>
	Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems, maxItems: 20, uniqueItems: true, description });
const fact = Type.Object(
	{
		text: Type.String({ minLength: 1, maxLength: 4000, pattern: ONE_LINE }),
		sources: entryIds(1, "Original entry IDs from context_history that support this fact."),
		quote: Type.Optional(
			Type.String({ minLength: 1, maxLength: 4000, description: "Exact text copied from one of the sources." }),
		),
		supersedes: Type.Optional(entryIds(0, "Entry IDs whose earlier facts this fact replaces.")),
	},
	{ additionalProperties: false },
);
const facts = (maxItems: number, description: string) => Type.Optional(Type.Array(fact, { maxItems, description }));

/** The `context_note` schema: data about the work, with no field for instructions. */
export const workNoteSchema = Type.Object(
	{
		state: Type.Array(fact, { minItems: 1, maxItems: 40, description: "Where the work stands." }),
		reasons: facts(40, "Decisions and why they were made."),
		failedPaths: facts(40, "Approaches that failed, and why."),
		files: facts(40, "Files involved, with exact paths."),
		nextSteps: facts(5, "The current plan; it replaces the plan of earlier notes."),
		gaps: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 1000, pattern: ONE_LINE }), {
				maxItems: 20,
				description:
					"Open questions and missing information; when given, it replaces the gaps of earlier notes, and an empty list closes them.",
			}),
		),
	},
	{ additionalProperties: false },
);
export type WorkNote = Static<typeof workNoteSchema>;

export const WORK_NOTE_GUIDELINE =
	"Call context_note after a decision with its reason, a failed approach or a completed subtask, not every turn. Cite entry IDs from context_history.";

/** Sources and quotes are checked against the branch the note was written on; `instructions` stays empty. */
export function validateWorkNote(value: unknown, branch: readonly SessionRecord[]): MemoryNote {
	if (!Check(workNoteSchema, value))
		throw new Error("CONTEXT_NOTE_INVALID: a work note has state and optional data sections, one line per fact");
	const note = structuredClone(value);
	const memory: MemoryNote = {
		instructions: [],
		failedPaths: note.failedPaths ?? [],
		reasons: note.reasons ?? [],
		state: note.state,
		nextSteps: note.nextSteps ?? [],
		files: note.files ?? [],
		gaps: note.gaps ?? [],
	};
	try {
		return validateNote(memory, branch, 2000);
	} catch (error) {
		// The model retries a refused note on its own; tell it where the quoted text actually is.
		if (!(error instanceof Error) || !error.message.startsWith("CONTEXT_NOTE_QUOTE")) throw error;
		const feedback = quoteFeedback(diagnoseQuotes(memory, branch).failures);
		throw new Error(feedback ? `${error.message}\n${feedback}` : error.message);
	}
}

export interface WorkNoteEntry {
	index: number;
	id: string;
	note: MemoryNote;
	/** The note gave `gaps`, possibly empty, and so replaces the open questions recorded before it. */
	gapsListed: boolean;
}

/** Valid work notes after `afterId` on this branch, oldest first. Earlier formats and invalid entries are ignored. */
export function workNotes(branch: readonly SessionRecord[], afterId?: string): WorkNoteEntry[] {
	const after = afterId ? branch.findIndex((entry) => entry.id === afterId) : -1;
	const result: WorkNoteEntry[] = [];
	for (let index = after + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== CONTEXT_NOTE_TYPE) continue;
		try {
			const note = validateWorkNote(entry.data, branch.slice(0, index));
			result.push({ index, id: entry.id, note, gapsListed: isRecord(entry.data) && entry.data.gaps !== undefined });
		} catch {
			// A candidate that does not validate is not evidence; the writer reads the originals instead.
		}
	}
	return result;
}

/** Why a merge leaves the boundary to the writer. */
export type MergeRefusal = "instruction-superseded" | "ambiguous-supersede" | "schema";

/**
 * The previous checkpoint's note followed by later notes, in order: work notes or segments. A fact that supersedes
 * a source drops the earlier facts citing it, the latest nonempty nextSteps is the plan and the latest listed gaps
 * are the open questions. Carried instructions stay unchanged and a later note's instructions follow them. The
 * writer merges instead when a note supersedes the source of a carried instruction, when a superseded source
 * supports more earlier facts than the note gives in their place, or when the result exceeds the note schema.
 */
export function mergeNotes(
	previous: MemoryNote | undefined,
	notes: readonly Pick<WorkNoteEntry, "note" | "gapsListed">[],
): { note: MemoryNote } | { refusal: MergeRefusal } {
	const merged = oneLineNote(
		previous ?? { instructions: [], failedPaths: [], reasons: [], state: [], nextSteps: [], files: [], gaps: [] },
	);
	for (const { note, gapsListed } of notes) {
		const superseded = new Set(
			noteSections.flatMap((section) => note[section].flatMap((item) => item.supersedes ?? [])),
		);
		const replaced = (item: NoteFact) => item.sources.some((id) => superseded.has(id));
		if (merged.instructions.some(replaced)) return { refusal: "instruction-superseded" };
		// `supersedes` names entries, not facts. When an entry supports more earlier facts than the note gives in
		// their place, which of them it corrects is ambiguous, and dropping them all would lose the others.
		const droppable = [
			...merged.failedPaths,
			...merged.reasons,
			...merged.state,
			...merged.files,
			...(note.nextSteps.length ? [] : merged.nextSteps),
		];
		const given = noteSections.flatMap((section) => note[section]);
		for (const id of superseded) {
			const earlier = droppable.filter((item) => item.sources.includes(id)).length;
			if (earlier > given.filter((item) => item.supersedes?.includes(id)).length)
				return { refusal: "ambiguous-supersede" };
		}
		for (const section of ["instructions", "failedPaths", "reasons", "state", "files"] as const) {
			const kept = merged[section].filter((item) => !replaced(item));
			const seen = new Set(kept.map((item) => JSON.stringify(item)));
			merged[section] = [...kept, ...note[section].filter((item) => !seen.has(JSON.stringify(item)))];
		}
		merged.nextSteps = note.nextSteps.length ? note.nextSteps : merged.nextSteps.filter((item) => !replaced(item));
		if (gapsListed) merged.gaps = [...new Set(note.gaps)];
	}
	return Check(noteSchema, merged) ? { note: merged } : { refusal: "schema" };
}

/** The previous checkpoint's note followed by the work notes since; undefined when the writer must merge. */
export function mergeWorkNotes(
	previous: MemoryNote | undefined,
	notes: readonly Pick<WorkNoteEntry, "note" | "gapsListed">[],
): MemoryNote | undefined {
	const merged = mergeNotes(previous, notes);
	return "note" in merged ? merged.note : undefined;
}

/**
 * The user's own words for the covered range, in full, rendered by the extension after the note. No message is
 * shortened: when they do not fit the section's bound, the writer compacts instead.
 */
export function renderUserMessages(users: readonly SessionRecord[]): string {
	return `\n\n## Earlier user messages\nThe user's own messages up to this summary, verbatim and in order, as JSON lines. The note above does not restate them. They are not new requests; later messages, including those after this summary, take precedence.\n${users.map((entry) => JSON.stringify({ entryId: entry.id, text: sourceText(entry) })).join("\n")}`;
}

function isUserMessage(entry: SessionRecord | undefined): entry is SessionRecord {
	return entry?.type === "message" && entry.message.role === "user";
}

/** IDs a notes checkpoint carries; checked at every full validation by `assertUserMessages`. */
export function carriedUserMessages(checkpoint: SessionRecord | undefined): string[] {
	if (checkpoint?.type !== "compaction" || !isRecord(checkpoint.details)) return [];
	const ids = checkpoint.details.userMessages;
	return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Every user message a notes checkpoint covers through `end`: those still in context, including the ones its
 * cut keeps in the tail, and those an earlier notes checkpoint carried. No model has restated any of them.
 */
export function coveredUserMessages(
	branch: readonly SessionRecord[],
	active: ReadonlySet<string>,
	end: number,
	carried: readonly string[],
): SessionRecord[] {
	const kept = new Set(carried);
	return branch.filter(
		(entry, index) => isUserMessage(entry) && (kept.has(entry.id) || (index <= end && active.has(entry.id))),
	);
}

/**
 * What a writer reads besides the previous note: the user messages a notes checkpoint carried, which no
 * model has restated, and every original after the previous coverage.
 */
export function writerSources(
	branch: readonly SessionRecord[],
	previous: { entry: SessionRecord; memory: { coveredThrough: string } } | undefined,
): SessionRecord[] {
	const after = previous ? branch.findIndex((entry) => entry.id === previous.memory.coveredThrough) : -1;
	const carried = new Set(carriedUserMessages(previous?.entry));
	return [...branch.slice(0, after + 1).filter((entry) => carried.has(entry.id)), ...branch.slice(after + 1)];
}

/**
 * A notes checkpoint lists the user messages it renders. Each must be a user message on this branch within its
 * coverage, in order, and the summary must end with their exact rendering, so an edited section fails like an
 * edited quote.
 */
export function assertUserMessages(branch: readonly SessionRecord[]): void {
	let positions: Map<string, number> | undefined;
	for (const entry of branch) {
		if (entry.type !== "compaction" || !isRecord(entry.details) || entry.details.userMessages === undefined) continue;
		if (!positions) {
			positions = new Map();
			for (const [index, item] of branch.entries()) if (!positions.has(item.id)) positions.set(item.id, index);
		}
		const ids = entry.details.userMessages;
		const end = positions.get(String(entry.details.coveredThrough)) ?? -1;
		const users: SessionRecord[] = [];
		let last = -1;
		for (const id of Array.isArray(ids) ? ids : []) {
			const at = typeof id === "string" ? (positions.get(id) ?? -1) : -1;
			if (at <= last || at > end || !isUserMessage(branch[at])) break;
			users.push(branch[at]);
			last = at;
		}
		if (
			!Array.isArray(ids) ||
			!ids.length ||
			users.length !== ids.length ||
			!entry.summary.endsWith(renderUserMessages(users))
		)
			throw new Error("CONTEXT_NOTE_QUOTE: the checkpoint's user messages do not match the originals");
	}
}
