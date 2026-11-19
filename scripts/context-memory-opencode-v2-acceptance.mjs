import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { accessSync, constants, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCode } from "@opencode/client";
import { discover, headers } from "@opencode/client/service";
import { QUESTIONNAIRE_MARK, startLoopback } from "./context-memory-host-run.mjs";
import { startLoopbackRegistry } from "./context-memory-loopback-registry.mjs";

/** A real managed 2.x service loads the candidate by name. Only the model and the candidate registry are local stand-ins. */
export async function acceptOpenCodeV2({ hostRoot, packageRoot, item, version, work }) {
	const binary = join(hostRoot, "node_modules/@opencode/cli-linux-x64-baseline/bin/opencode");
	accessSync(binary, constants.X_OK);
	const archive = join(packageRoot, item.archive);
	const archiveSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
	assert.equal(archiveSha256, item.sha256);
	const manifest = JSON.parse(readFileSync(join(packageRoot, item.directory, "package.json"), "utf8"));
	const registry = await startLoopbackRegistry({ packages: [{ manifest, archive }], upstream: "https://registry.npmjs.org" });
	const model = await startLoopback({ log: join(work, "loopback.jsonl"), summaryHeading: "## Decisions" });
	const directory = join(work, "project");
	mkdirSync(directory, { recursive: true });
	const config = {
		plugins: [`${manifest.name}@${manifest.version}`],
		providers: { "slice-loopback": {
			package: "@opencode/ai/providers/openai", activation: "enabled", env: ["SLICE_LOOPBACK_KEY"],
			settings: { baseURL: model.url, compaction: { type: "summary" } },
			models: { "scripted": { name: "Scripted", limit: { context: 200000, output: 32000 } } },
		} },
		model: "slice-loopback/scripted",
		compaction: { keep: { tokens: 0 }, background: false },
	};
	const conf = join(work, "config", "opencode");
	mkdirSync(conf, { recursive: true });
	writeFileSync(join(conf, "opencode.json"), JSON.stringify(config));
	const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|^OPENCODE_|^XDG_|^NPM_CONFIG_USERCONFIG$/i.test(key)));
	const env = { ...environment, HOME: work, XDG_CONFIG_HOME: join(work, "config"), XDG_STATE_HOME: join(work, "state"),
		XDG_CACHE_HOME: join(work, "cache"), XDG_DATA_HOME: join(work, "data"), CI: "1", SLICE_LOOPBACK_KEY: "loopback",
		OPENCODE_DISABLE_MODELS_FETCH: "1", npm_config_registry: registry.url, BUN_CONFIG_REGISTRY: registry.url,
		npm_config_cache: join(work, "npm-cache") };
	const log = openSync(join(work, "host.log"), "w");
	const child = spawn(binary, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], { env, cwd: directory, stdio: ["ignore", log, log] });
	closeSync(log);
	const exited = once(child, "exit");
	async function until(check, description) {
		for (let i = 0; i < 180; i++) {
			assert.equal(child.exitCode, null, "OpenCode service exited");
			const value = await check();
			if (value) return value;
			await delay(350);
		}
		throw new Error(`Timed out waiting for ${description}`);
	}
	try {
		const endpoint = await until(() => discover({ file: join(work, "state/opencode/service.json"), version }), "service registration");
		const client = OpenCode.make({ baseUrl: endpoint.url, headers: headers(endpoint) });
		const location = { directory };
		const plugin = await until(async () => {
			const response = await client.plugin.list({ location });
			const plugin = response.data.find((p) => p.id === "slice-history" || JSON.stringify(p.source).includes(manifest.name));
			if (plugin?.state.status === "failed") throw new Error(plugin.state.error);
			return plugin;
		}, "the installed plugin");
		assert.equal(plugin.id, "slice-history");
		const session = await client.session.create({ location, title: "SLICE synthetic history", model: { providerID: "slice-loopback", id: "scripted" },
			permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "context_history", resource: "current-session", effect: "allow" }] });
		const sessionID = session.id;
		const messages = async () => (await client.message.list({ sessionID, order: "asc", limit: 100 })).data;
		async function prompt(text) {
			const before = (await messages()).length;
			await client.session.prompt({ sessionID, text });
			return until(async () => {
				const next = (await messages()).slice(before);
				const failed = next.find((m) => m.type === "assistant" && m.error);
				assert(!failed, `Synthetic model request failed: ${failed?.error?.message}`);
				return next.some((m) => m.type === "assistant" && m.finish === "stop") && next;
			}, "a completed synthetic turn");
		}
		let compactions = 0;
		for (const text of ["The original batch size was 4317.", "The revised batch size was 8421."]) {
			await prompt(text);
			await client.session.compact({ sessionID });
			await until(async () => {
				const history = await messages();
				assert(!history.some((m) => m.type === "compaction" && m.status === "failed"), "OpenCode compaction failed");
				return history.filter((m) => m.type === "compaction" && m.status === "completed").length > compactions;
			}, "a native compaction");
			compactions++;
		}
		const originals = (await messages()).filter((m) => m.type === "user" && /4317|8421/.test(m.text));
		assert.equal(originals.length, 2);
		const context = await client.session.context({ sessionID });
		assert(originals.every((original) => !context.some((m) => m.id === original.id)), "Both originals must be outside the compacted context");
		const result = await prompt(`${QUESTIONNAIRE_MARK} Please check the original setting.`);
		const call = result.filter((m) => m.type === "assistant").flatMap((m) => m.content).find((p) => p.type === "tool" && p.name === "context_history");
		assert.equal(call?.state.status, "completed", call?.state.error?.message ?? "Missing context_history result");
		const page = JSON.parse(call.state.content.find((p) => p.type === "text").text);
		for (const original of originals) {
			assert(page.entries.some((entry) => entry.entryId === original.id && entry.text === original.text), "Original text and native citation were not recovered");
		}
		const fetched = registry.requests.includes(`GET /${manifest.name}/-/${item.archive}`);
		assert(fetched, "The candidate archive was not installed from the loopback registry");
		return { archiveSha256, fetched, compactions, historyResults: [page.entries.length], stop: null };
	} finally {
		child.kill("SIGTERM");
		const force = setTimeout(() => child.kill("SIGKILL"), 3000);
		try { await exited; } finally { clearTimeout(force); }
		await registry.close();
		model.server.closeAllConnections();
		await new Promise((resolve) => model.server.close(resolve));
	}
}
