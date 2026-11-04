import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const WRITER_REQUESTS = ["Return ONLY the memory note itself", "Return ONLY one JSON object matching this schema"];

export function replayRequestKind(payload) {
	const messages = JSON.stringify(payload.messages ?? payload.input ?? []);
	return WRITER_REQUESTS.some((marker) => messages.includes(marker))
		? messages.includes("Write a segment note for entries") ? "segment" : "writer"
		: "main";
}

export const recordedCallId = (id) => id.split("|")[0];

/** Cap only the agent's task stream, before the catalog API builds its body. Writers use the registry directly. */
export function replayTaskStream(stream) {
	return (model, context, options) => stream(model, context, { ...options, maxTokens: model.api === "openai-responses" ? 16 : 1, maxRetries: 0 });
}

/** Move the catalog model, retaining its API, compatibility settings, thinking map and prices. */
export function relocatePreviewModel(runtime, provider, id, baseUrl, served = id) {
	const catalog = runtime.getModel(provider, id);
	if (!catalog) throw new Error(`${provider}/${id} is not in this Pi's catalog`);
	const address = new URL(baseUrl);
	if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || address.username || address.password)
		throw new Error("The bench address must be checked HTTP 127.0.0.1");
	runtime.registerProvider(provider, { baseUrl, ...(served === id ? {} : { models: [{ ...catalog, id: served, baseUrl }] }) });
	const model = runtime.getModel(provider, served);
	if (model?.baseUrl !== baseUrl || model.api !== catalog.api) throw new Error(`${provider}/${served} did not move to the bench's address`);
	if (!["openai-responses", "openai-completions"].includes(model.api)) throw new Error("Tool replay needs a Responses or Chat Completions catalog model");
	return { model, upstream: catalog.baseUrl.replace(/\/+$/, "") };
}

/** Local recorded output uses the catalog's wire API; no recorded reasoning or native function item IDs. */
export function recordedReply(payload, reply, usage) {
	const text = reply.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	const tools = reply.content.filter((part) => part.type === "toolCall");
	if (!Array.isArray(payload.input)) {
		const chunk = (delta, finish, reported) => `data: ${JSON.stringify({ id: "bench", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(reported ? { usage: reported } : {}) })}\n\n`;
		return chunk({ role: "assistant", content: text, ...(tools.length ? { tool_calls: tools.map((part, index) => ({ index, id: recordedCallId(part.id), type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments) } })) } : {}) }, null)
			+ chunk({}, tools.length ? "tool_calls" : "stop", usage) + "data: [DONE]\n\n";
	}
	const responseId = randomUUID().replaceAll("-", "");
	const output = [
		...(text ? [{ type: "message", id: `msg_replay_${responseId}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] : []),
		// Pi's parser needs an item ID, but its serializer drops IDs without the native fc_ prefix.
		...tools.map((part) => ({ type: "function_call", id: `replay_${recordedCallId(part.id)}`, call_id: recordedCallId(part.id), name: part.name, arguments: JSON.stringify(part.arguments), status: "completed" })),
	];
	const event = (value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
	return output.map((item, output_index) => event({ type: "response.output_item.done", output_index, item })).join("")
		+ event({ type: "response.completed", response: { id: `resp_replay_${responseId}`, object: "response", status: "completed", model: payload.model, output, ...(usage ? { usage } : {}) } });
}

/** Observe only usage and error state, never retain upstream text or request headers. */
function streamAccount(responses) {
	const decoder = new TextDecoder();
	let buffer = "";
	const account = { usage: null, failed: false, rateLimit: false, complete: false };
	return {
		account,
		push(part, final = false) {
			buffer += decoder.decode(part, { stream: !final });
			if (final) buffer += "\n";
			let end;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end).trim();
				buffer = buffer.slice(end + 1);
				if (!line.startsWith("data:")) continue;
				if (line.slice(5).trim() === "[DONE]") { account.complete = true; continue; }
				let value;
				try { value = JSON.parse(line.slice(5)); } catch { continue; }
				const error = value.error ?? value.response?.error ?? (value.type === "error" ? value : null);
				if (error || value.type === "response.failed") {
					account.failed = true;
					account.rateLimit ||= /rate.?limit|too many requests|\b429\b/i.test(JSON.stringify(error));
				}
				if (["response.completed", "response.incomplete"].includes(value.type)) account.complete = true;
				const usage = responses ? value.response?.usage : value.usage;
				if (usage) account.usage = usage;
			}
		},
	};
}

export function forwardedUsage(usage) {
	if (!usage) return null;
	const total = usage.input_tokens ?? usage.prompt_tokens ?? 0;
	const cacheRead = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
	const cacheWrite = usage.input_tokens_details?.cache_creation_tokens ?? 0;
	return { input: Math.max(0, total - cacheRead - cacheWrite), cacheRead, cacheWrite, output: usage.output_tokens ?? usage.completion_tokens ?? 0 };
}

/** The repair forward path, also used for every replay task/writer/segment. Bodies and Authorization pass inline. */
export async function forwardPreviewRequest(request, response, raw, upstream, { localReply, turnLatencyMs = 0, timeoutMs = 600_000, onUsage = () => {}, onFailure = () => {} } = {}) {
	const controller = new AbortController();
	const disconnect = () => { if (!response.writableEnded) controller.abort(); };
	request.once("aborted", disconnect);
	response.once("close", disconnect);
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const waiting = delay(turnLatencyMs, undefined, { signal: controller.signal });
	// A rejection may arrive before headers, while fetch is still pending.
	waiting.catch(() => {});
	try {
		if (response.destroyed) { controller.abort(); return; }
		const answer = await fetch(`${upstream}${request.url}`, { method: "POST", headers: { "content-type": "application/json", authorization: request.headers.authorization ?? "" }, body: raw, signal: controller.signal });
		if (!answer.ok) {
			onFailure({ status: answer.status, rateLimit: answer.status === 429 });
			await answer.body?.cancel();
			response.writeHead(answer.status, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: `bench upstream HTTP ${answer.status}` } }));
			return;
		}
		const observer = streamAccount(request.url?.split("?")[0].endsWith("/responses"));
		if (!localReply) response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" });
		if (answer.body) for await (const part of answer.body) {
			observer.push(part);
			if (observer.account.failed) {
				onFailure({ status: answer.status, rateLimit: observer.account.rateLimit });
				throw new Error("bench upstream stream error");
			}
			if (!localReply) response.write(part);
		}
		observer.push(undefined, true);
		onUsage(observer.account.usage);
		if (!observer.account.complete) throw new Error("bench upstream stream incomplete");
		await waiting;
		if (response.destroyed) return;
		if (localReply) {
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.end(localReply(observer.account.usage));
		} else response.end();
	} catch {
		if (!response.destroyed) {
			onFailure({ status: null, rateLimit: false });
			if (response.headersSent) response.destroy();
			else {
				response.writeHead(502, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "bench upstream failed, disconnected or timed out" } }));
			}
		}
	} finally {
		controller.abort();
		clearTimeout(timer);
		request.off("aborted", disconnect);
		response.off("close", disconnect);
	}
}

/** All provider replay calls share a stop gate and include task usage, even though task output is discarded. */
export function createReplayForwarder({ upstream, nextReply, turnLatencyMs, prices, limits = {}, timeoutMs }) {
	const state = { requests: 0, costUsd: 0, usageMissing: 0, failure: null };
	return {
		state,
		async handle(request, response, raw, payload, call) {
			if (!state.failure && (state.requests >= (limits.requests ?? Infinity) || state.costUsd >= (limits.costUsd ?? Infinity) || Date.now() >= (limits.until ?? Infinity)))
				state.failure = { status: null, rateLimit: false, limit: true };
			if (state.failure) {
				response.writeHead(502, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "bench forwarding stopped" } }));
				return;
			}
			state.requests++;
			call.forwarded = true;
			call.inputEstimated = true;
			let reported = false;
			await forwardPreviewRequest(request, response, raw, upstream(), {
				timeoutMs: Math.min(timeoutMs ?? 600_000, Math.max(1, (limits.until ?? Infinity) - Date.now())),
				...(call.kind === "main" ? { turnLatencyMs, localReply: (usage) => recordedReply(payload, nextReply(), usage) } : {}),
				onUsage(usage) {
					const value = forwardedUsage(usage);
					if (!value) return;
					reported = true;
					call.usage = value;
					call.input = value.input + value.cacheRead + value.cacheWrite;
					call.inputEstimated = false;
					call.cacheRead = value.cacheRead;
					call.costUsd = Object.entries(value).reduce((sum, [key, count]) => sum + count * (prices?.[key] ?? 0), 0) / 1_000_000;
					state.costUsd += call.costUsd;
					if (call.input > (limits.inputTokens ?? Infinity)) state.failure ??= { status: null, rateLimit: false, limit: true };
				},
				onFailure(failure) { state.failure ??= failure; },
			});
			if (!reported) state.usageMissing++;
		},
	};
}
