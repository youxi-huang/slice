// Lifted from the preview into the host-neutral core (v0.7.0 WP2 step 2): the notes import moved
// to the core's copy, and the host's SessionEntry type import became the specification's
// structural SessionRecord (records.ts). Logic, bounds and thrown messages are unchanged (rule K2).
import { type MemoryNote, noteSections, sourceRole, sourceText } from "./notes.ts";
import type { SessionRecord } from "./records.ts";

/** Why a refused candidate cites outside its evidence: counts and entry kinds, never the IDs. */
export interface ScopeCounts {
	/** Distinct cited IDs that name no entry on the branch. */
	missing: number;
	/** Distinct cited IDs of entries on the branch that have no readable text. */
	unreadable: number;
	/** Of either kind, the IDs a fact names in `supersedes`. */
	inSupersedes: number;
	/** The unreadable entries by message role or entry type, such as `compaction`. */
	unreadableKinds: Record<string, number>;
}

/**
 * Every citation of a schema-valid note that the scope check refuses, where the validator stops at the first. An
 * invented ID and a real entry with nothing to read call for different fixes. Later duplicates win, as in
 * `validateNoteContent`.
 */
export function diagnoseScope(note: MemoryNote, branch: readonly SessionRecord[]): ScopeCounts {
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const missing = new Set<string>();
	const unreadable = new Set<string>();
	const superseding = new Set<string>();
	const check = (id: string, supersedes: boolean) => {
		const entry = byId.get(id);
		if (entry && sourceText(entry)) return;
		(entry ? unreadable : missing).add(id);
		if (supersedes) superseding.add(id);
	};
	for (const section of noteSections)
		for (const item of note[section]) {
			for (const id of item.sources) check(id, false);
			for (const id of item.supersedes ?? []) check(id, true);
		}
	const unreadableKinds: Record<string, number> = {};
	for (const id of unreadable) {
		const kind = sourceRole(byId.get(id)!);
		unreadableKinds[kind] = (unreadableKinds[kind] ?? 0) + 1;
	}
	return { missing: missing.size, unreadable: unreadable.size, inSupersedes: superseding.size, unreadableKinds };
}

/**
 * The note without the sources the scope check refuses: IDs that name no entry on the branch, or an entry with
 * nothing to read. Nothing is added; each fact's text, quote, supersedes and remaining sources stay as written.
 * Undefined when nothing is dropped, when a fact would be left with no source, so that its evidence would be unknown,
 * or when a `supersedes` ID is out of scope: which entry a fact replaces is a claim of its own, and the refusal stands.
 */
export function withoutOutOfScope(
	note: MemoryNote,
	branch: readonly SessionRecord[],
): { note: MemoryNote; dropped: number } | undefined {
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const readable = (id: string) => {
		const entry = byId.get(id);
		return entry !== undefined && sourceText(entry).length > 0;
	};
	const pruned = structuredClone(note);
	let dropped = 0;
	for (const section of noteSections)
		for (const item of pruned[section]) {
			if (item.supersedes?.some((id) => !readable(id))) return undefined;
			const sources = item.sources.filter(readable);
			if (!sources.length) return undefined;
			dropped += item.sources.length - sources.length;
			item.sources = sources;
		}
	return dropped ? { note: pruned, dropped } : undefined;
}

/**
 * The note without its out-of-scope sources, when that leaves a fact with none, so that the sources repair may ask
 * the writer for them. Found on GPT-6 Luna: seven of eight attempts at one compaction were refused, and the answers
 * read back cited `1598f6dcb`, the head of one entry's ID and the tail of another's, for one fact. Nothing is added:
 * an emptied fact keeps its text, quote and supersedes, and its sources stay empty until the writer names them.
 * Undefined when a `supersedes` ID is out of scope, as in `withoutOutOfScope`, or when every fact keeps a readable
 * source, which `withoutOutOfScope` handles.
 */
export function withoutUnreadableSources(
	note: MemoryNote,
	branch: readonly SessionRecord[],
): { note: MemoryNote; dropped: number } | undefined {
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const readable = (id: string) => {
		const entry = byId.get(id);
		return entry !== undefined && sourceText(entry).length > 0;
	};
	const pruned = structuredClone(note);
	let dropped = 0;
	let emptied = false;
	for (const section of noteSections)
		for (const item of pruned[section]) {
			if (item.supersedes?.some((id) => !readable(id))) return undefined;
			const sources = item.sources.filter(readable);
			dropped += item.sources.length - sources.length;
			if (!sources.length) emptied = true;
			item.sources = sources;
		}
	return emptied ? { note: pruned, dropped } : undefined;
}

/**
 * 0.8.0: a segment note without what lies outside its range. A segment records what its own entries add or change,
 * and the merge carries the previous note, so a fact that cites only earlier entries restates what that note holds or
 * claims what the segment cannot support: it is dropped. A fact that also cites the range keeps only those sources.
 * `nextSteps` is the whole current plan, so a plan with a step resting only on earlier entries is dropped whole and
 * the previous plan stands. `supersedes` may name earlier entries and stays as written. Nothing is added; the note is
 * validated again, and a refusal still stands when, say, no state fact is left. Undefined when nothing lies outside.
 */
export function withinSegmentRange(
	note: MemoryNote,
	rangeIds: ReadonlySet<string>,
): { note: MemoryNote; dropped: number } | undefined {
	const pruned = structuredClone(note);
	let dropped = 0;
	for (const section of noteSections) {
		const items = pruned[section];
		const kept = items.filter((item) => item.sources.some((id) => rangeIds.has(id)));
		if (section === "nextSteps" && kept.length < items.length) {
			dropped += items.reduce((sum, item) => sum + item.sources.length, 0);
			pruned.nextSteps = [];
			continue;
		}
		for (const item of items) {
			const sources = item.sources.filter((id) => rangeIds.has(id));
			dropped += item.sources.length - sources.length;
			item.sources = sources;
		}
		pruned[section] = kept;
	}
	return dropped ? { note: pruned, dropped } : undefined;
}
