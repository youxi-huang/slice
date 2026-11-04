// Run explicitly after installing official Pi 1.4.0; this proof never contacts a provider or replays P5.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "../.artifacts/context-memory-preview-stock/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { configureHttpDispatcher } from "../.artifacts/context-memory-preview-stock/node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js";
import { createReplayForwarder, recordedCallId, recordedReply, relocatePreviewModel, replayRequestKind, replayTaskStream } from "./context-memory-preview-forward.mjs";
import { replaySourceIds } from "./context-memory-preview-bench.mjs";
import { inspectOfficialPi } from "./context-memory-preview-stock-install.mjs";

const stockRoot = fileURLToPath(new URL("../.artifacts/context-memory-preview-stock", import.meta.url));
inspectOfficialPi(stockRoot, "1.4.0");
configureHttpDispatcher();

const deferred = () => Promise.withResolvers();
const textReply = (text) => ({ content: [{ type: "text", text }] });
const usage = { input_tokens: 1234, input_tokens_details: { cached_tokens: 777 }, output_tokens: 16, total_tokens: 1250 };
const chatUsage = { prompt_tokens: 1234, prompt_tokens_details: { cached_tokens: 777 }, completion_tokens: 1, total_tokens: 1235 };

async function body(request) {
	const parts = [];
	for await (const part of request) parts.push(part);
	return Buffer.concat(parts);
}

async function serve(t, handle) {
	const server = createServer((request, response) => {
		Promise.resolve(handle(request, response)).catch((error) => {
			response.destroy();
			t.assert.fail(error.message);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		const closed = once(server, "close");
		server.close();
		server.closeAllConnections();
		await closed;
	});
	return `http://127.0.0.1:${server.address().port}`;
}

async function proxy(t, upstream, options = {}) {
	const calls = [];
	const forwarder = createReplayForwarder({ upstream: () => upstream, nextReply: () => textReply("RECORDED"), timeoutMs: 1000, ...options });
	const url = await serve(t, async (request, response) => {
		const raw = await body(request);
		const payload = JSON.parse(raw);
		const call = { kind: replayRequestKind(payload), input: raw.length, start: Date.now() };
		calls.push(call);
		await forwarder.handle(request, response, raw, payload, call);
		call.end = Date.now();
	});
	return { url, calls, state: forwarder.state };
}

function send(url, payload, signal) {
	return fetch(`${url}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-proof-only" }, body: JSON.stringify(payload), signal });
}

for (const [provider, id, api] of [["openai", "gpt-6-luna", "openai-responses"], ["deepseek", "deepseek-flash", "openai-completions"]]) {
	test(`${api}: official Pi forwards task, writer and segment bytes, own auth and locally answered history`, { timeout: 15_000 }, async (t) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-provider-proof-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, allowModelNetwork: false });
		const catalog = runtime.getModel(provider, id);
		assert.equal(catalog.api, api);
		const expected = [];
		const received = [];
		const reported = api === "openai-responses" ? usage : chatUsage;
		const upstream = await serve(t, async (request, response) => {
			const raw = await body(request);
			const prior = expected.shift();
			assert.ok(prior, "Every forwarded request must originate in Pi");
			assert.deepEqual(raw, prior.raw);
			// Synthetic keys vary by request; assertions never print a header.
			assert.ok(request.headers.authorization === `Bearer synthetic-proof-${prior.index}`);
			assert.equal(request.url, api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions");
			const payload = JSON.parse(raw);
			received.push(payload);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(recordedReply(payload, textReply("UPSTREAM"), reported));
		});
		const recorded = [
			{ content: [{ type: "thinking", thinking: "Recorded reasoning", thinkingSignature: '{"type":"reasoning","id":"rs_recorded"}' }, { type: "text", text: "Use the recorded tool", textSignature: "msg_recorded" }, { type: "toolCall", id: "call_recorded|fc_recorded", name: "read", arguments: { path: "synthetic.txt" } }] },
			textReply("RECORDED FINAL"),
		];
		const local = await proxy(t, `${upstream}/v1`, { nextReply: () => recorded.shift(), prices: catalog.cost });
		const { model, upstream: original } = relocatePreviewModel(runtime, provider, id, local.url);
		assert.equal(original, catalog.baseUrl.replace(/\/+$/, ""));
		assert.deepEqual({ ...model, baseUrl: catalog.baseUrl }, catalog);
		for (const address of ["http://localhost:1234", "https://127.0.0.1:1234", "http://127.0.0.1.evil.invalid", "http://user:password@127.0.0.1:1234"])
			assert.throws(() => relocatePreviewModel(runtime, provider, id, address), /checked HTTP 127.0.0.1/);
		const task = replayTaskStream(runtime.streamSimple.bind(runtime));
		const context = { systemPrompt: "Synthetic system prompt", tools: [{ name: "read", description: "Synthetic read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }], messages: [{ role: "user", content: "Synthetic task", timestamp: 1 }] };
		let index = 0;
		const options = () => {
			const current = ++index;
			return { apiKey: `synthetic-proof-${current}`, sessionId: "synthetic-provider-proof", reasoning: "off", maxTokens: 4000, maxRetries: 0, onPayload: (payload) => { expected.push({ raw: Buffer.from(JSON.stringify(payload)), index: current }); } };
		};
		const first = await (await task(model, context, options())).result();
		assert.equal(first.stopReason, "toolUse");
		assert.equal(first.content.some((part) => part.type === "thinking"), false);
		const tool = first.content.find((part) => part.type === "toolCall");
		assert.equal(recordedCallId(tool.id), "call_recorded");
		context.messages.push(first, { role: "toolResult", toolCallId: tool.id, toolName: tool.name, content: [{ type: "text", text: "Recorded result" }], isError: false, timestamp: 2 });
		const final = await (await task(model, context, options())).result();
		assert.equal(final.stopReason, "stop");
		assert.equal(final.content.find((part) => part.type === "text").text, "RECORDED FINAL");
		context.messages.push(final);
		for (const closing of ["Return ONLY the memory note itself", "Return ONLY the memory note itself. Write a segment note for entries first through last only"]) {
			const answer = await runtime.streamSimple(model, { ...context, messages: [...context.messages, { role: "user", content: closing, timestamp: 3 }] }, options()).result();
			assert.equal(answer.stopReason, "stop");
			assert.equal(answer.content.find((part) => part.type === "text").text, "UPSTREAM");
		}
		assert.equal(expected.length, 0);
		assert.equal(recorded.length, 0);
		assert.deepEqual(local.calls.map((call) => call.kind), ["main", "main", "writer", "segment"]);
		assert.equal(local.state.requests, 4);
		assert.equal(local.state.usageMissing, 0);
		assert.equal(local.state.failure, null);
		assert.ok(local.calls.every((call) => call.input === 1234 && call.cacheRead === 777 && !call.inputEstimated));
		assert.equal(local.state.costUsd, local.calls.reduce((sum, call) => sum + call.costUsd, 0));
		for (const [position, payload] of received.entries()) {
			const cap = payload.max_output_tokens ?? payload.max_completion_tokens ?? payload.max_tokens;
			assert.equal(cap, position < 2 ? api === "openai-responses" ? 16 : 1 : 4000);
			if (api === "openai-responses") {
				assert.equal(payload.prompt_cache_key, "synthetic-provider-proof");
				assert.equal(payload.input.some((item) => item.type === "reasoning"), false);
				assert.ok(payload.input.filter((item) => item.type === "function_call").every((item) => item.id === undefined && item.call_id === "call_recorded"));
				assert.deepEqual(payload.input.slice(0, received[0].input.length), received[0].input);
				if (position) assert.equal(payload.input.filter((item) => item.type === "function_call_output" && item.call_id === "call_recorded").length, 1);
			}
		}
		assert.equal(replaySourceIds([{ type: "message", id: "recorded-result", message: { role: "toolResult", toolCallId: "call_recorded", content: [] } }], [{ type: "message", id: "actual-result", message: { role: "toolResult", toolCallId: tool.id, content: [] } }]).get("recorded-result"), "actual-result");
	});
}

test("task reply waits for the entire upstream body, even after a terminal event", { timeout: 5000 }, async (t) => {
	const arrived = deferred();
	const finish = deferred();
	const upstream = await serve(t, async (request, response) => {
		const payload = JSON.parse(await body(request));
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(recordedReply(payload, textReply("DISCARDED"), usage));
		arrived.resolve();
		await finish.promise;
		response.end();
	});
	const local = await proxy(t, upstream);
	let released = false;
	const answer = send(local.url, { input: [] }).then(async (response) => { released = true; return response.text(); });
	await arrived.promise;
	await delay(30);
	assert.equal(released, false);
	finish.resolve();
	const result = await answer;
	assert.match(result, /RECORDED/);
	assert.doesNotMatch(result, /DISCARDED/);
});

test("task reply also waits for its turn delay when upstream finishes first", { timeout: 5000 }, async (t) => {
	const finished = deferred();
	const upstream = await serve(t, async (request, response) => {
		const payload = JSON.parse(await body(request));
		response.end(recordedReply(payload, textReply("DISCARDED"), usage));
		finished.resolve();
	});
	const local = await proxy(t, upstream, { turnLatencyMs: 150 });
	let released = false;
	const answer = send(local.url, { input: [] }).then(async (response) => { released = true; return response.text(); });
	await finished.promise;
	await delay(30);
	assert.equal(released, false);
	assert.match(await answer, /RECORDED/);
});

for (const role of ["task", "writer"]) {
	const payload = { input: role === "task" ? [] : [{ role: "user", content: "Return ONLY the memory note itself" }] };
	test(`${role}: Pi disconnect aborts an upstream in flight`, { timeout: 5000 }, async (t) => {
		const arrived = deferred();
		const closed = deferred();
		const upstream = await serve(t, async (request, response) => {
			await body(request);
			response.once("close", () => closed.resolve());
			arrived.resolve();
		});
		const local = await proxy(t, upstream);
		const controller = new AbortController();
		const answer = send(local.url, payload, controller.signal);
		await arrived.promise;
		controller.abort();
		await assert.rejects(answer);
		await closed.promise;
		assert.equal(local.state.requests, 1);
	});
	test(`${role}: every upstream has a timeout`, { timeout: 5000 }, async (t) => {
		const closed = deferred();
		const upstream = await serve(t, async (request, response) => {
			await body(request);
			response.once("close", () => closed.resolve());
		});
		const local = await proxy(t, upstream, { timeoutMs: 50 });
		const answer = await send(local.url, payload);
		assert.equal(answer.status, 502);
		assert.doesNotMatch(await answer.text(), /RECORDED/);
		await closed.promise;
		assert.ok(local.state.failure);
	});
	for (const failure of ["disconnect", "timeout"]) {
		test(`${role}: ${failure} also aborts after upstream headers and a partial body`, { timeout: 5000 }, async (t) => {
			const arrived = deferred();
			const closed = deferred();
			const upstream = await serve(t, async (request, response) => {
				await body(request);
				response.once("close", () => closed.resolve());
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write('data: {"type":"response.created","response":{"id":"resp_partial"}}\n\n');
				arrived.resolve();
			});
			const local = await proxy(t, upstream, { timeoutMs: failure === "timeout" ? 50 : 1000 });
			const controller = new AbortController();
			const answer = send(local.url, payload, controller.signal).then(async (response) => {
				if (response.status >= 400) { await response.text(); return "failed"; }
				return response.text();
			});
			await arrived.promise;
			if (failure === "disconnect") controller.abort();
			const outcome = await answer.catch(() => "failed");
			assert.equal(outcome, "failed");
			await closed.promise;
			assert.equal(local.state.requests, 1);
		});
	}
}

for (const fault of ["401", "429", "stream-rate-limit", "truncated"]) {
	test(`${fault}: stop before another upstream dispatch, including HTTP 200 errors`, { timeout: 5000 }, async (t) => {
		let requests = 0;
		const upstream = await serve(t, async (request, response) => {
			await body(request);
			requests++;
			if (fault === "401" || fault === "429") response.writeHead(Number(fault));
			else response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(fault === "stream-rate-limit" ? 'data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded"}}}\n\n' : "incomplete");
		});
		const local = await proxy(t, upstream);
		for (let index = 0; index < 2; index++) {
			const response = await send(local.url, { input: [] });
			assert.ok(response.status >= 400);
			assert.doesNotMatch(await response.text(), /RECORDED/);
		}
		assert.equal(requests, 1);
		assert.equal(local.state.requests, 1);
		assert.equal(local.state.failure.rateLimit, fault === "429" || fault === "stream-rate-limit");
	});
}

test("request, cost, time and input limits include forwarded tasks and cached input inside a chain", { timeout: 5000 }, async (t) => {
	const upstream = await serve(t, async (request, response) => {
		const payload = JSON.parse(await body(request));
		response.end(recordedReply(payload, textReply("DISCARDED"), usage));
	});
	for (const limits of [{ requests: 1 }, { costUsd: 0.000001 }, { inputTokens: 1000 }]) {
		const local = await proxy(t, upstream, { prices: { input: 1, cacheRead: 1, output: 1 }, limits });
		const first = await send(local.url, { input: [] });
		await first.text();
		assert.equal(first.status, 200);
		const second = await send(local.url, { input: [] });
		assert.equal(second.status, 502);
		await second.text();
		assert.equal(local.state.requests, 1);
	}
	const expired = await proxy(t, upstream, { limits: { until: Date.now() - 1 } });
	const blocked = await send(expired.url, { input: [] });
	assert.equal(blocked.status, 502);
	await blocked.text();
	assert.equal(expired.state.requests, 0);
});
