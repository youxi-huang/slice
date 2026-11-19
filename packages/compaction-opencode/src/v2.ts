import {
	type LocationPublicInfo,
	OpenCode,
	type PermissionRequest,
	type PermissionSource,
	withMediaRefs,
} from "@opencode/client";
import { discover, headers } from "@opencode/client/service";
import { z } from "zod";
import { historyArguments } from "./arguments.ts";
import { readOpenCodeV2History } from "./v2-history.ts";

const input = z.strictObject(historyArguments);
type Call = Pick<PermissionRequest, "sessionID"> &
	Omit<PermissionSource, "type"> & { agent: string; signal: AbortSignal };
type Permission = Pick<PermissionRequest, "sessionID" | "action" | "resources" | "save" | "source"> & { agent: string };

/** Only the public promise-plugin surface consumed by this entry. */
interface HistoryTool {
	name: string;
	description: string;
	input: typeof input;
	options: { codemode: false };
	execute(args: z.infer<typeof input>, call: Call): Promise<{ content: string }>;
}

interface PluginContext {
	app: { version: string };
	location: LocationPublicInfo;
	permission: { assert(request: Permission): Promise<void> };
	tool: { transform(register: (editor: { add(tool: HistoryTool): void }) => void): Promise<unknown> };
}

export default {
	id: "slice-history",
	async setup(ctx: PluginContext) {
		if (ctx.app.version !== "2.3.2") throw new Error("SLICE history requires OpenCode 2.3.2 on the 2.x host");
		await ctx.tool.transform((editor) =>
			editor.add({
				name: "context_history",
				description:
					"Search or read original text from this session before the current call, including before compaction. Results cite native message or tool call IDs. Repeat a query with its cursor for more.",
				input,
				options: { codemode: false },
				async execute(args, call) {
					const { sessionID, messageID, signal } = call;
					await ctx.permission.assert({
						sessionID,
						agent: call.agent,
						action: "context_history",
						resources: ["current-session"],
						save: ["current-session"],
						source: { type: "tool", messageID, id: call.id },
					});
					signal.throwIfAborted();
					const endpoint = await discover({ version: ctx.app.version });
					if (!endpoint)
						throw new Error("HISTORY_SOURCE_UNAVAILABLE: the current OpenCode service is not registered");
					const client = withMediaRefs(OpenCode.make({ baseUrl: endpoint.url, headers: headers(endpoint) }));
					const server = await client.server.info({ signal });
					if (server.pid !== process.pid)
						throw new Error("HISTORY_SCOPE_DENIED: another OpenCode service is registered");
					const page = await readOpenCodeV2History(
						client,
						{
							sessionID,
							messageID,
							directory: ctx.location.directory,
							projectID: ctx.location.project.id,
						},
						args,
						signal,
					);
					return { content: JSON.stringify(page) };
				},
			}),
		);
	},
};
