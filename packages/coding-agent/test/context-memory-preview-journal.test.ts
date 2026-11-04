import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CallJournal,
	PREPARATION_CALLS_PER_ATTEMPT,
	SEGMENT_CALLS_PER_INTERVAL,
} from "../src/extensions/context-memory/preview/call-journal.ts";
import type { WriterDispatchRequest } from "../src/extensions/context-memory/preview/writer.ts";

const call: WriterDispatchRequest = { callIndex: 1, phase: "generate", model: "synthetic/writer", writerEffort: "low" };
const usage: Usage = {
	input: 100,
	output: 20,
	cacheRead: 50,
	cacheWrite: 0,
	totalTokens: 170,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

describe("preview call journal: one record of every writer call", () => {
	let agentDir: string;
	let file: string;
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-preview-journal-"));
		const name = `${createHash("sha256").update("session-1").digest("hex")}.jsonl`;
		file = join(agentDir, "context-memory-preview", "calls", name);
	});
	afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

	it("writes a content-free start line before dispatch and its settlement after", async () => {
		const hooks = new CallJournal(agentDir).hooks("session-1", "compaction", "none");
		const id = await hooks.beforeDispatch(call);
		const started = readFileSync(file, "utf8").trim().split("\n");
		expect(started).toHaveLength(1);
		expect(JSON.parse(started[0])).toMatchObject({
			v: 1,
			call: id,
			purpose: "compaction",
			model: "synthetic/writer",
		});
		await hooks.afterDispatch({
			callIndex: 1,
			callId: id,
			phase: "generate",
			dispatched: true,
			outcome: "success",
			elapsedMs: 12,
			usage,
		});
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(JSON.parse(lines[1])).toMatchObject({
			call: id,
			outcome: "success",
			complete: true,
			usage: { cost: 0.003 },
		});
		expect(new CallJournal(agentDir).summary("session-1")).toMatchObject({
			calls: 1,
			compactionCalls: 1,
			unsettled: 0,
			usage: { totalTokens: 170, cost: 0.003 },
		});
	});

	it("counts a call interrupted before its settlement as unsettled after a restart", async () => {
		await new CallJournal(agentDir).hooks("session-1", "preparation", "cp-1").beforeDispatch(call);
		const restarted = new CallJournal(agentDir);
		expect(restarted.summary("session-1")).toMatchObject({ calls: 1, preparationCalls: 1, unsettled: 1 });
		expect(restarted.preparedIn("session-1", "cp-1")).toBe(true);
		expect(restarted.preparedIn("session-1", "cp-2")).toBe(false);
	});

	it("does not count a call cancelled before dispatch", async () => {
		const hooks = new CallJournal(agentDir).hooks("session-1", "compaction", "none");
		const id = await hooks.beforeDispatch(call);
		await hooks.afterDispatch({
			callIndex: 1,
			callId: id,
			phase: "generate",
			dispatched: false,
			outcome: "cancelled",
			elapsedMs: 0,
		});
		expect(new CallJournal(agentDir).summary("session-1")).toMatchObject({ calls: 0, unsettled: 0 });
	});

	it("ignores a torn final line, whose call was never sent", async () => {
		await new CallJournal(agentDir).hooks("session-1", "compaction", "none").beforeDispatch(call);
		appendFileSync(file, '{"v":1,"call":"torn","purpose":"comp');
		expect(new CallJournal(agentDir).summary("session-1")).toMatchObject({ calls: 1 });
	});

	it("pauses optional preparation on an unreadable journal while a compaction still proceeds", async () => {
		mkdirSync(join(agentDir, "context-memory-preview", "calls"), { recursive: true });
		writeFileSync(file, "not json\n{}\n");
		const journal = new CallJournal(agentDir);
		expect(journal.writable("session-1")).toBe(false);
		expect(journal.summary("session-1").gap).toBe("unreadable");
		await expect(async () => journal.hooks("session-1", "preparation", "none").beforeDispatch(call)).rejects.toThrow(
			"CONTEXT_PREPARATION_BUDGET",
		);
		expect(typeof (await journal.hooks("session-1", "compaction", "none").beforeDispatch(call))).toBe("string");
	});

	it("stops optional preparation at its per-attempt call limit", async () => {
		const hooks = new CallJournal(agentDir).hooks("session-1", "preparation", "none");
		for (let index = 1; index <= PREPARATION_CALLS_PER_ATTEMPT; index++) await hooks.beforeDispatch(call);
		await expect(async () => hooks.beforeDispatch(call)).rejects.toThrow("CONTEXT_PREPARATION_BUDGET");
	});

	it("refuses an unrecordable preparation call but lets a compaction call proceed with a visible gap", async () => {
		mkdirSync(join(agentDir, "context-memory-preview"), { recursive: true });
		writeFileSync(join(agentDir, "context-memory-preview", "calls"), "not a directory");
		const journal = new CallJournal(agentDir);
		await expect(async () => journal.hooks("session-1", "preparation", "none").beforeDispatch(call)).rejects.toThrow(
			/CONTEXT_PREPARATION_/,
		);
		expect(typeof (await journal.hooks("session-1", "compaction", "none").beforeDispatch(call))).toBe("string");
		expect(journal.summary("session-1").gap).toBe("unwritable");
	});

	it("counts segment calls apart and stops them at the interval's limit, across a restart (0.8.0 U9)", async () => {
		const settle = async (journal: CallJournal, interval: string, reported?: Usage) => {
			const hooks = journal.hooks("session-1", "segment", interval);
			const id = await hooks.beforeDispatch(call);
			await hooks.afterDispatch({
				callIndex: 1,
				callId: id,
				phase: "generate",
				dispatched: true,
				outcome: "success",
				elapsedMs: 5,
				...(reported ? { usage: reported } : {}),
			});
		};
		const journal = new CallJournal(agentDir);
		for (let index = 1; index < SEGMENT_CALLS_PER_INTERVAL; index++) await settle(journal, "cp-1", usage);
		const restarted = new CallJournal(agentDir);
		expect(restarted.summary("session-1")).toMatchObject({
			segmentCalls: SEGMENT_CALLS_PER_INTERVAL - 1,
			preparationCalls: 0,
			compactionCalls: 0,
		});
		expect(restarted.segmentSpend("session-1", "cp-1")).toEqual({
			calls: SEGMENT_CALLS_PER_INTERVAL - 1,
			uncachedTokens: (SEGMENT_CALLS_PER_INTERVAL - 1) * 120,
			unknown: false,
		});
		await settle(restarted, "cp-1");
		expect(restarted.segmentSpend("session-1", "cp-1").unknown).toBe(true);
		await expect(async () => restarted.hooks("session-1", "segment", "cp-1").beforeDispatch(call)).rejects.toThrow(
			"CONTEXT_PREPARATION_BUDGET",
		);
		await settle(restarted, "cp-2", usage);
		expect(restarted.segmentSpend("session-1", "cp-2")).toMatchObject({ calls: 1, unknown: false });
	});
});
