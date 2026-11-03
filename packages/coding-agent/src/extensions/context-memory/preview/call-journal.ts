// Split for the host-neutral core (v0.7.0 WP2 step 4): the call-accounting contracts — `CallUsage`,
// `CallSummary`, the unknown-never-free rule (`summarizeCalls`), `CallPurpose` and
// `PREPARATION_CALLS_PER_ATTEMPT` — moved to the core's call-journal.ts, re-exported here; the
// journal's file IO stays with this adapter.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
	type CallJournalGap,
	type CallPurpose,
	type CallRecord,
	type CallSummary,
	type CallUsage,
	PREPARATION_CALLS_PER_ATTEMPT,
	SEGMENT_CALLS_PER_INTERVAL,
	type SegmentSpend,
	segmentSpend,
	summarizeCalls,
	ZERO_USAGE,
} from "../../../../../compaction-core/src/call-journal.ts";
import { isRecord } from "../identity.ts";
import { missing, previewDirectory, readBoundedFile, syncDirectory } from "./failure-io.ts";
import type { WriterCallHooks } from "./writer.ts";

export {
	type CallPurpose,
	type CallSummary,
	type CallUsage,
	PREPARATION_CALLS_PER_ATTEMPT,
	SEGMENT_CALLS_PER_INTERVAL,
	type SegmentSpend,
} from "../../../../../compaction-core/src/call-journal.ts";

/** A per-session bound on synchronous reads; far above any realistic number of writer calls. */
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

interface SessionJournal {
	name: string;
	file: string;
	calls: Map<string, CallRecord>;
	gap?: CallJournalGap;
}

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function callUsage(value: unknown): CallUsage | undefined {
	if (!isRecord(value)) return undefined;
	const usage = { ...ZERO_USAGE };
	for (const key of Object.keys(ZERO_USAGE) as (keyof CallUsage)[]) {
		if (!count(value[key])) return undefined;
		usage[key] = value[key];
	}
	return usage;
}

function fromProvider(usage: Readonly<Usage>): CallUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: usage.cost.total,
	};
}

/** Lines are content-free: call identity, purpose, model, outcome and token counts. */
function load(journal: SessionJournal): void {
	let data: string;
	try {
		data = readBoundedFile(journal.file, MAX_JOURNAL_BYTES, "CONTEXT_PREVIEW_JOURNAL").toString("utf8");
	} catch (error) {
		if (missing(error)) return;
		throw error;
	}
	const lines = data.split("\n");
	// A crash can tear only the final line; its fsync never completed, so that call was never sent.
	if (lines.at(-1) !== "") lines.pop();
	for (const line of lines) {
		if (!line) continue;
		const value: unknown = JSON.parse(line);
		if (!isRecord(value) || value.v !== 1 || typeof value.call !== "string") throw new Error("journal-invalid");
		if (value.purpose === "preparation" || value.purpose === "compaction" || value.purpose === "segment") {
			if (typeof value.interval !== "string") throw new Error("journal-invalid");
			journal.calls.set(value.call, { purpose: value.purpose, interval: value.interval, settled: false });
			continue;
		}
		const record = journal.calls.get(value.call);
		if (!record || typeof value.dispatched !== "boolean" || typeof value.complete !== "boolean")
			throw new Error("journal-invalid");
		record.settled = true;
		record.dispatched = value.dispatched;
		record.complete = value.complete;
		record.usage = callUsage(value.usage);
	}
}

/**
 * One append-only record of every writer call the preview makes, preparation and compaction alike. The start
 * line is on disk before the request is sent; the settlement follows. After a crash, a start without a
 * settlement stays visible as unknown usage. The session history stays in Pi's JSONL; this file holds no content.
 */
export class CallJournal {
	private readonly agentDir: string;
	private readonly sessions = new Map<string, SessionJournal>();

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	private session(sessionId: string): SessionJournal {
		const known = this.sessions.get(sessionId);
		if (known) return known;
		const name = `${createHash("sha256").update(sessionId).digest("hex")}.jsonl`;
		const journal: SessionJournal = {
			name,
			file: join(this.agentDir, "context-memory-preview", "calls", name),
			calls: new Map(),
		};
		try {
			load(journal);
		} catch {
			journal.calls.clear();
			journal.gap = "unreadable";
		}
		if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value as string);
		this.sessions.set(sessionId, journal);
		return journal;
	}

	private append(journal: SessionJournal, value: unknown): void {
		const directory = previewDirectory(this.agentDir, "calls");
		const file = join(directory, journal.name);
		let created = false;
		try {
			lstatSync(file);
		} catch (error) {
			if (!missing(error)) throw error;
			created = true;
		}
		const fd = openSync(
			file,
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			if (!fstatSync(fd).isFile()) throw new Error("journal-not-a-file");
			writeSync(fd, `${JSON.stringify(value)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (created) syncDirectory(directory);
	}

	/**
	 * Optional preparation and segments never send an unrecorded request; preparation stops at its per-attempt
	 * limit and segments at theirs per interval, counted from the journal so a restart does not reset it. A formal
	 * compaction proceeds if its record cannot be written, and the gap is shown in status.
	 */
	hooks(sessionId: string, purpose: CallPurpose, interval: string): WriterCallHooks {
		const journal = this.session(sessionId);
		const optional = purpose !== "compaction";
		const open = new Set<string>();
		let started = 0;
		return {
			beforeDispatch: (call) => {
				if (
					optional &&
					(journal.gap ||
						(purpose === "preparation" && ++started > PREPARATION_CALLS_PER_ATTEMPT) ||
						(purpose === "segment" &&
							segmentSpend(journal.calls.values(), interval).calls >= SEGMENT_CALLS_PER_INTERVAL))
				)
					throw new Error("CONTEXT_PREPARATION_BUDGET: optional preparation stopped before an unrecorded call");
				const id = randomUUID();
				try {
					this.append(journal, {
						v: 1,
						call: id,
						purpose,
						interval,
						model: call.model,
						effort: call.writerEffort,
						step: call.phase,
						at: new Date().toISOString(),
					});
				} catch {
					journal.gap = "unwritable";
					if (optional) throw new Error("CONTEXT_PREPARATION_ACCOUNTING: the call journal could not be written");
				}
				journal.calls.set(id, { purpose, interval, settled: false });
				open.add(id);
				return id;
			},
			afterDispatch: (result) => {
				const record = journal.calls.get(result.callId);
				if (!open.delete(result.callId) || !record) return;
				const usage = result.usage ? fromProvider(result.usage) : undefined;
				const complete = !result.dispatched || (result.usageComplete ?? result.outcome === "success");
				try {
					this.append(journal, {
						v: 1,
						call: result.callId,
						outcome: result.outcome,
						dispatched: result.dispatched,
						complete,
						ms: Math.round(result.elapsedMs),
						...(usage ? { usage } : {}),
					});
					Object.assign(record, { settled: true, dispatched: result.dispatched, complete, usage });
				} catch {
					// The start line remains, so a restart still counts this call as unknown usage.
					journal.gap = "unwritable";
				}
			},
		};
	}

	/** Whether optional preparation already ran for this checkpoint interval, in this process or an earlier one. */
	preparedIn(sessionId: string, interval: string): boolean {
		for (const record of this.session(sessionId).calls.values()) {
			if (record.purpose === "preparation" && record.interval === interval) return true;
		}
		return false;
	}

	/** One interval's segment calls and what they spent, in this process or an earlier one. */
	segmentSpend(sessionId: string, interval: string): SegmentSpend {
		return segmentSpend(this.session(sessionId).calls.values(), interval);
	}

	/** Optional work pauses while the journal cannot be read or written; formal compaction does not. */
	writable(sessionId: string): boolean {
		return this.session(sessionId).gap === undefined;
	}

	summary(sessionId: string): CallSummary {
		const journal = this.session(sessionId);
		return summarizeCalls(journal.calls.values(), journal.gap);
	}
}
