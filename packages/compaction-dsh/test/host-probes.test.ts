import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { CompactionId, compactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
	SESSION_FORMAT_VERSION,
	Session,
	type SessionEvent,
	type SessionHeader,
	SessionId,
	SessionStore,
} from "@deepseek-ai/dsh-session";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import type { SessionHandle } from "@deepseek-ai/dsh-session-persistence";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import { describe, expect, it } from "vitest";

const id = SessionId("synthetic-compaction-lifecycle");
const compactionId = CompactionId("slice-synthetic-interrupted");

function fresh() {
	return Session.create(id, undefined, {
		version: SESSION_FORMAT_VERSION,
		id,
		createdAt: 1,
		isSeeded: false,
		delegationDepth: 0,
	});
}

/** Exercise the public format catalog, including its native relationship validators. */
function restore(header: SessionHeader, events: readonly SessionEvent[]) {
	const physicalHeader = sessionFormatCatalog.encodeCurrentHeader(
		{ ...header, delegationDepth: header.delegationDepth ?? 0 },
		0,
	);
	const decoder = sessionFormatCatalog.createRestore(physicalHeader, {
		recovery: "recoverable",
		validation: "current",
	});
	for (const event of events) {
		decoder.decodeRow(sessionFormatCatalog.encodeCurrentEvent(JSON.parse(JSON.stringify(event))));
	}
	return decoder.finish();
}

function interrupted() {
	const session = fresh();
	session.append("compaction/start", { compactionId, turn: null });
	return session;
}

async function mount(root: string) {
	const ctx = new Context();
	await ctx.plugin(SessionStore).await();
	await ctx.plugin(Jsonl, { root, compression: "none" }).await();
	return ctx;
}

function committed() {
	const session = fresh();
	const original = session.append(
		"user/message",
		createUserMessage({ content: [{ type: "text", text: "Synthetic original." }], source: { kind: "user" } }),
		{ surfaceOp: "append" },
	);
	const opening = session.append("compaction/start", { compactionId, turn: null });
	const summary = [{ type: "text" as const, text: "Synthetic summary." }];
	const summaryEvent = session.append("compaction/summary", {
		compactionId,
		summary,
		shadowedRange: { start: original.seq, end: original.seq },
		shadowedSeqs: [original.seq],
		shadowedTokenCount: 8,
		provider: "synthetic",
		model: "scripted",
	});
	session.append(
		"user/message",
		createUserMessage({ content: summary, source: compactCheckpointSource(compactionId) }),
		{
			surfaceOp: { op: "replace", startSeq: original.seq, endSeq: original.seq },
			sourceEventSeqs: [opening.seq, summaryEvent.seq, original.seq],
		},
	);
	session.append("compaction/end", { compactionId, turn: null });
	return session;
}

describe("DSH stage 1 native lifecycle admission (D7)", () => {
	it("orphans the interrupted attempt at resume's seed boundary and refuses a later interrupted end", () => {
		const session = interrupted();
		const resumed = Session.create(id, session.snapshotEvents(), session.header);
		expect(resumed.snapshotEvents().at(-1)?.type).toBe("session/end-seed");
		resumed.append("compaction/end", { compactionId, turn: null, error: "interrupted" });
		expect(() => restore(resumed.header, resumed.snapshotEvents())).toThrow(
			"compaction/end has no matching compaction/start",
		);
	});

	it("admits a new manual transaction after the seed boundary without ending the orphan", () => {
		const session = interrupted();
		const resumed = Session.create(id, session.snapshotEvents(), session.header);
		const next = CompactionId("slice-synthetic-next");
		resumed.append("compaction/start", { compactionId: next, turn: null });
		resumed.append("compaction/end", { compactionId: next, turn: null, error: "synthetic failure" });
		expect(restore(resumed.header, resumed.snapshotEvents()).events.at(-1)?.data).toMatchObject({
			compactionId: next,
		});
	});

	it("cold reopens the tail start, adds the same resume marker as the agent loop, and cold reopens a later blocked turn", async () => {
		const root = await mkdtemp(join(tmpdir(), "slice-dsh-lifecycle-"));
		let ctx = await mount(root);
		let handle: SessionHandle | undefined;
		try {
			const session = interrupted();
			handle = await ctx.sessionPersistence.create(session.header);
			await handle.append(session.snapshotEvents());
			await handle.flush();
			await handle.close();
			handle = undefined;
			await ctx.fiber.dispose();
			ctx = await mount(root);
			handle = await ctx.sessionPersistence.open(id, "write");
			const read = await handle.read();
			expect(read.events.at(-1)?.type).toBe("compaction/start");
			// Mirrors agent-loop resumeWith's prepare call after its turn repair (empty for this manual attempt).
			const resumed = ctx.sessions.prepare(id, {
				seed: [...read.events],
				meta: structuredClone(handle.header),
				inheritedEventCount: handle.inheritedEventCount,
				eventState: read.eventState,
			});
			expect(resumed.header.isSeeded).toBe(false);
			expect(resumed.snapshotEvents().at(-1)?.type).toBe("session/end-seed");
			resumed.append("turn/start", { turn: 1 });
			resumed.append("turn/end", { turn: 1, reason: { kind: "blocked" } });
			await handle.append(resumed.snapshotEvents().slice(read.events.length));
			await handle.close();
			handle = undefined;
			await ctx.fiber.dispose();
			ctx = await mount(root);
			handle = await ctx.sessionPersistence.open(id, "read");
			const cold = (await handle.read()).events;
			expect(cold.at(-1)?.data).toEqual({ turn: 1, reason: { kind: "blocked" } });
			expect(cold.filter((event) => event.type === "compaction/end")).toHaveLength(0);
		} finally {
			await handle?.close();
			await ctx.fiber.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("DSH stage 1 post-commit failure constraint (D3/D6)", () => {
	it("admits the four-event commit but rejects an error end appended after its clean end", () => {
		const session = committed();
		expect(restore(session.header, session.snapshotEvents()).events.at(-1)?.data).toEqual({
			compactionId,
			turn: null,
		});
		// Revised D3 writes no second end after a post-commit readback failure.
		session.append("compaction/end", {
			compactionId,
			turn: null,
			error: "CONTEXT_STORAGE_UNCERTAIN: synthetic readback failure",
		});
		expect(() => restore(session.header, session.snapshotEvents())).toThrow(
			"compaction/end has no matching compaction/start",
		);
	});
});
