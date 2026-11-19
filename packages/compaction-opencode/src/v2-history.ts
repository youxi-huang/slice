import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client";
import { canonicalize } from "../../compaction-core/src/canonical.ts";
import { queryHistory } from "../../compaction-core/src/history.ts";
import { hashEntries } from "../../compaction-core/src/notes.ts";
import type { SessionRecord } from "../../compaction-core/src/records.ts";

interface Scope {
	sessionID: string;
	messageID: string;
	projectID: string;
	directory: string;
}

export function openCodeV2Snapshot(sessionId: string, messages: readonly SessionMessageInfo[]) {
	const entries: SessionRecord[] = [];
	const ids = new Set<string>();
	function identity(id: string, created: number) {
		if (!id || id.length > 64 || ids.has(id))
			throw new Error("HISTORY_SOURCE_INVALID: invalid or duplicate native ID");
		ids.add(id);
		return { id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(created).toISOString() };
	}
	for (const input of messages) {
		// Include the native envelope in the source hash, even when only part of it is readable text.
		const native = JSON.parse(canonicalize(input)) as SessionMessageInfo;
		const record = identity(native.id, native.time.created);
		let text = "";
		if (native.type === "user") text = native.text;
		if (native.type === "assistant") {
			text = native.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		}
		if (native.type === "compaction" && native.status === "completed") text = native.summary;
		if (text) {
			entries.push({
				...record,
				type: "message",
				message: {
					role: native.type === "compaction" ? "context" : native.type,
					content: [{ type: "text", text, native }],
				},
			});
		} else {
			entries.push({ ...record, type: "custom", customType: `opencode:${native.type}`, data: native });
		}
		if (native.type !== "assistant") continue;
		for (const tool of native.content) {
			if (tool.type !== "tool" || (tool.state.status !== "completed" && tool.state.status !== "error")) continue;
			const output = tool.state.content
				?.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			entries.push({
				...identity(tool.id, tool.time.created),
				type: "message",
				message: {
					role: "toolResult",
					toolName: tool.name,
					toolCallId: tool.id,
					isError: tool.state.status === "error",
					content: output || (tool.state.status === "error" ? tool.state.error.message : ""),
				},
			});
		}
	}
	return { sessionId, leafId: entries.at(-1)?.id ?? null, scopeHash: hashEntries(entries), entries };
}

type HistoryClient = {
	session: Pick<OpenCodeClient["session"], "get">;
	message: Pick<OpenCodeClient["message"], "list">;
};

/** The plugin context starts at the last compaction. The public message API pages the persisted session instead. */
export async function readOpenCodeV2History(
	client: HistoryClient,
	scope: Scope,
	request: unknown,
	signal: AbortSignal,
) {
	const { sessionID, messageID, directory, projectID } = scope;
	signal.throwIfAborted();
	async function verifyScope() {
		const session = await client.session.get({ sessionID }, { signal });
		if (
			session.id !== sessionID ||
			session.projectID !== projectID ||
			session.location.directory !== directory ||
			session.parentID ||
			session.fork ||
			session.revert
		)
			throw new Error("HISTORY_SCOPE_DENIED: session is outside the current root history");
	}
	await verifyScope();
	const messages: SessionMessageInfo[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	do {
		signal.throwIfAborted();
		const page = await client.message.list(
			{ sessionID, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) },
			{ signal },
		);
		signal.throwIfAborted();
		for (const message of page.data) {
			if (message.id === messageID) {
				if (message.type !== "assistant")
					throw new Error("HISTORY_SOURCE_INVALID: expected a calling assistant message");
				// A revert or move can change the visible scope while reading pages.
				await verifyScope();
				signal.throwIfAborted();
				return queryHistory(openCodeV2Snapshot(sessionID, messages), request);
			}
			messages.push(message);
		}
		cursor = page.cursor.next ?? undefined;
		if (cursor && (!page.data.length || cursors.has(cursor)))
			throw new Error("HISTORY_SOURCE_INVALID: native pagination stalled");
		if (cursor) cursors.add(cursor);
	} while (cursor);
	throw new Error("HISTORY_SOURCE_INVALID: calling message is missing from native history");
}
