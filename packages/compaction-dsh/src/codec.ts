import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { canonicalize } from "../../compaction-core/src/canonical.ts";
import type { HistorySnapshot } from "../../compaction-core/src/history.ts";
import { CONTEXT_KEEP_NONE, CONTEXT_MEMORY_KIND, isRecord } from "../../compaction-core/src/identity.ts";
import { hashEntries } from "../../compaction-core/src/notes.ts";
import type { RecordContentBlock, SessionRecord } from "../../compaction-core/src/records.ts";

/** Append-log order, never surface order or a numeric shadowedRange expansion. */
function dshRecords(events: readonly SessionEvent[]): SessionRecord[] {
	const entries: SessionRecord[] = [];
	// Tool results name their call only; the call event names the tool, so a search can tell retrieval output apart.
	const toolNames = new Map<string, string>();
	for (const [index, input] of events.entries()) {
		if (input.seq !== index) throw new Error("HISTORY_SOURCE_INVALID: expected the complete contiguous DSH log");
		// Stable key order also makes the core's existing cursor hash deterministic.
		const event = JSON.parse(canonicalize(input)) as SessionEvent;
		if (event.type === "tool/call") toolNames.set(event.data.callId, event.data.name);
		const base = {
			id: String(event.seq),
			parentId: entries.at(-1)?.id ?? null,
			timestamp: new Date(event.time).toISOString(),
		};
		const message =
			event.type === "user/message"
				? event.data
				: event.type === "assistant/message" || event.type === "tool/result"
					? event.data.message
					: undefined;
		if (!message) {
			entries.push({ ...base, type: "custom", customType: `dsh:${event.type}`, data: event });
			continue;
		}
		// Injected user-role context and native summaries are not original human instructions.
		const role =
			message.role === "tool"
				? "toolResult"
				: message.role === "user" && message.source.kind !== "user"
					? "context"
					: message.role;
		const content: RecordContentBlock[] = message.content.flatMap((block) =>
			block.type === "text" ? [{ type: "text", text: block.text }] : [],
		);
		// The native envelope enters both hashes, including source attribution and replacement metadata.
		// Keep it on a content block: JCS deliberately excludes host-only top-level fields.
		if (!content.length) {
			entries.push({ ...base, type: "custom", customType: `dsh:${event.type}`, data: event });
			continue;
		}
		content[0].nativeEvent = event;
		entries.push({
			...base,
			type: "message",
			message: {
				role,
				content,
				...(message.role === "tool"
					? {
							toolCallId: message.toolCallId,
							...(toolNames.has(message.toolCallId) ? { toolName: toolNames.get(message.toolCallId) } : {}),
							isError: message.isError ?? false,
						}
					: {}),
			},
		});
	}
	return entries;
}

export function dshHistorySnapshot(sessionId: string, events: readonly SessionEvent[]): HistorySnapshot {
	const entries = dshRecords(events);
	return { sessionId, leafId: entries.at(-1)?.id ?? null, scopeHash: hashEntries(entries), entries };
}

export const isSliceAttempt = (id: string) => id.startsWith("slice-");

/** Transaction facts come from the native log, including attempts orphaned by a resume marker. */
export function dshAttempts(events: readonly SessionEvent[]) {
	const attempts = new Map<
		string,
		{
			start: SessionEvent<"compaction/start">;
			summary?: SessionEvent<"compaction/summary">;
			end?: SessionEvent<"compaction/end">;
		}
	>();
	let open: SessionEvent<"compaction/start"> | undefined;
	for (const event of events) {
		if (event.type === "session/end-seed") open = undefined;
		if (event.type === "compaction/start") {
			attempts.set(event.data.compactionId, { start: event });
			open = event;
		}
		if (event.type === "compaction/summary") {
			const attempt = attempts.get(event.data.compactionId);
			if (attempt) attempt.summary = event;
		}
		if (event.type === "compaction/end") {
			const attempt = attempts.get(event.data.compactionId);
			if (attempt) attempt.end = event;
			open = undefined;
		}
	}
	return { attempts: [...attempts.values()], open };
}

/** Writing view only: retrieval continues to expose native text exactly as before. */
export function dshCompactionRecords(events: readonly SessionEvent[]): SessionRecord[] {
	const { attempts } = dshAttempts(events);
	const summaries = new Map(
		attempts
			.filter((attempt) => attempt.end && attempt.end.data.error === undefined)
			.flatMap((attempt) => (attempt.summary ? [[attempt.summary.seq, attempt.summary] as const] : [])),
	);
	return dshRecords(events).map((entry, index) => {
		const event = events[index];
		const summary = summaries.get(event.seq);
		if (summary && isSliceAttempt(summary.data.compactionId)) {
			let details: unknown;
			try {
				const raw = summary.data.rawOutput;
				details = raw?.length === 1 && raw[0].type === "text" ? JSON.parse(raw[0].text) : undefined;
			} catch {
				/* The core owns checkpoint validation; an unreadable envelope cannot be a checkpoint. */
			}
			if (!isRecord(details) || details.kind !== CONTEXT_MEMORY_KIND)
				throw new Error("CONTEXT_NOTE_INVALID: the Slice checkpoint envelope is missing");
			return {
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				type: "compaction",
				summary: summary.data.summary.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
				details,
				firstKeptEntryId: CONTEXT_KEEP_NONE,
				tokensBefore: summary.data.shadowedTokenCount,
			};
		}
		if (
			event.type === "user/message" &&
			event.data.source.kind === "compact-checkpoint" &&
			isSliceAttempt(event.data.source.compactionId)
		)
			return {
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				type: "custom",
				customType: "dsh:slice-replacement",
				data: event,
			};
		return entry;
	});
}
