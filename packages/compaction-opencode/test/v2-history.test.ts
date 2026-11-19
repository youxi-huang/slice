import { OpenCode, type SessionMessageAssistant, type SessionMessageUser } from "@opencode/client";
import { describe, expect, it } from "vitest";
import { queryHistory } from "../../compaction-core/src/history.ts";
import { openCodeV2Snapshot, readOpenCodeV2History } from "../src/v2-history.ts";

const scope = { sessionID: "ses_current", messageID: "msg_call", directory: "/synthetic", projectID: "project" };
const metadata = { id: scope.sessionID, location: { directory: scope.directory }, projectID: scope.projectID };
const signal = new AbortController().signal;
const request = { operation: "search", query: "original" };

const user = (id: string, text: string): SessionMessageUser => ({ type: "user", id, time: { created: 1 }, text });
const assistant = (id: string): SessionMessageAssistant => ({
	type: "assistant",
	id,
	time: { created: 2 },
	model: { id: "scripted", providerID: "loopback" },
	agent: "build",
	content: [],
});

function sdk(response: (url: URL) => unknown) {
	return OpenCode.make({
		baseUrl: "http://synthetic.invalid",
		fetch: async (url) => Response.json(response(new URL(String(url)))),
	});
}

describe("OpenCode 2 persisted history", () => {
	it("pages the current session across compaction and stops before the calling assistant", async () => {
		const listed: URL[] = [];
		const client = sdk((url) => {
			if (url.pathname === "/api/session/ses_current") return { data: metadata };
			expect(url.pathname).toBe("/api/session/ses_current/message");
			listed.push(url);
			return url.searchParams.has("cursor")
				? {
						data: [assistant(scope.messageID), user("later", "original outside boundary")],
						cursor: { next: "unused" },
					}
				: {
						data: [
							user("early", "original 4317"),
							{
								type: "compaction",
								id: "checkpoint",
								status: "completed",
								reason: "manual",
								time: { created: 2 },
								summary: "summary",
							},
						],
						cursor: { next: "page-two" },
					};
		});
		const page = await readOpenCodeV2History(client, scope, request, signal);
		expect(page.entries.map((entry) => entry.entryId)).toEqual(["early"]);
		expect(listed.map((url) => [url.searchParams.get("order"), url.searchParams.get("cursor")])).toEqual([
			["asc", null],
			[null, "page-two"],
		]);
	});

	it.each([
		{ parentID: "parent" },
		{ fork: {} },
		{ revert: {} },
		{ projectID: "elsewhere" },
		{ location: { directory: "/other" } },
		{ id: "other" },
	])("rejects a session outside the calling scope before reading its messages", async (change) => {
		const client = sdk((url) => {
			expect(url.pathname).toBe("/api/session/ses_current");
			return { data: { ...metadata, ...change } };
		});
		await expect(readOpenCodeV2History(client, scope, request, signal)).rejects.toThrow("HISTORY_SCOPE_DENIED");
	});

	it("refuses a concurrent revert before returning the page", async () => {
		let reads = 0;
		const client = sdk((url) => {
			if (url.pathname.endsWith("/message"))
				return { data: [user("a", "original"), assistant(scope.messageID)], cursor: {} };
			return { data: reads++ ? { ...metadata, revert: {} } : metadata };
		});
		await expect(readOpenCodeV2History(client, scope, request, signal)).rejects.toThrow("HISTORY_SCOPE_DENIED");
	});

	it("rejects a missing or non-assistant boundary, non-progressing cursors and cancellation", async () => {
		for (const page of [
			{ data: [user("a", "original")], cursor: {} },
			{ data: [user(scope.messageID, "original")], cursor: {} },
			{ data: [user("a", "original")], cursor: { next: "repeated" } },
		]) {
			const client = sdk((url) => (url.pathname.endsWith("/message") ? page : { data: metadata }));
			await expect(readOpenCodeV2History(client, scope, request, signal)).rejects.toThrow("HISTORY_SOURCE_INVALID");
		}
		await expect(
			readOpenCodeV2History(
				sdk(() => {
					throw new Error("unexpected read");
				}),
				scope,
				request,
				AbortSignal.abort(),
			),
		).rejects.toThrow(/abort/i);
	});

	it("uses distinct native message and tool IDs and keeps reasoning, files and tool-result echoes out of search", () => {
		const message = assistant("answer");
		message.content = [
			{ type: "reasoning", text: "hidden" },
			{ type: "text", text: "spoken" },
			{
				type: "tool",
				name: "inspect",
				id: "call1",
				time: { created: 3 },
				state: {
					status: "completed",
					input: {},
					content: [
						{ type: "file", uri: "hidden", mime: "text/plain" },
						{ type: "text", text: "original tool result" },
					],
				},
			},
			{
				type: "tool",
				name: "context_history",
				id: "call2",
				time: { created: 4 },
				state: { status: "completed", input: {}, content: [{ type: "text", text: "original echo" }] },
			},
		];
		const snapshot = openCodeV2Snapshot(scope.sessionID, [message]);
		expect(queryHistory(snapshot, request).entries).toMatchObject([{ entryId: "call1", role: "toolResult" }]);
		expect(queryHistory(snapshot, { ...request, query: "hidden" }).entries).toEqual([]);
		expect(queryHistory(snapshot, { operation: "read", entryId: "answer" }).entries[0].text).toBe("spoken");
		expect(() => openCodeV2Snapshot(scope.sessionID, [message, user("call1", "collision")])).toThrow(
			"HISTORY_SOURCE_INVALID",
		);
	});

	it("binds cursors to stored source bytes including unchanged-ID metadata", () => {
		const original = user("a", "original text ".repeat(2000));
		const snapshot = () => openCodeV2Snapshot(scope.sessionID, [original]);
		const read = { operation: "read", entryId: "a" };
		const page = queryHistory(snapshot(), read, 512);
		expect(page.cursor).toBeTruthy();
		original.metadata = { edited: true };
		expect(() => queryHistory(snapshot(), { ...read, cursor: page.cursor }, 512)).toThrow("HISTORY_CURSOR_INVALID");
	});
});
