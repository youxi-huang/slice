// packages/compaction-dsh/src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// packages/compaction-core/src/history.ts
import { createHash as createHash2 } from "node:crypto";
import { Type as Type2 } from "typebox";
import { Check as Check2 } from "typebox/value";

// packages/compaction-core/src/identity.ts
import { createHash } from "node:crypto";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hashEntries(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(JSON.stringify(entry)).update("\n");
  return hash.digest("hex");
}

// packages/compaction-core/src/config.ts
var DEFAULT_BUDGET_CONFIG = Object.freeze({ keepRecentTokens: 0 });
function textTokens(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

// packages/compaction-core/src/notes.ts
import { Type } from "typebox";
import { Check } from "typebox/value";

// packages/compaction-core/src/canonical.ts
function stringLiteral(value) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 55296 && unit <= 56319) {
      const next = value.charCodeAt(++index);
      if (!(next >= 56320 && next <= 57343)) throw new TypeError("JCS: unpaired high surrogate");
    } else if (unit >= 56320 && unit <= 57343) {
      throw new TypeError("JCS: unpaired low surrogate");
    }
  }
  return JSON.stringify(value);
}
function canonicalize(value) {
  const ancestors = /* @__PURE__ */ new Set();
  const serialize = (item) => {
    if (item === null) return "null";
    if (typeof item === "string") return stringLiteral(item);
    if (typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("JCS: non-finite number");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") throw new TypeError("JCS: expected a JSON value");
    if (ancestors.has(item)) throw new TypeError("JCS: cyclic value");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const values = [];
        for (let index = 0; index < item.length; index++) values.push(serialize(item[index]));
        return `[${values.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("JCS: expected a JSON object");
      const object = item;
      return `{${Object.keys(object).sort().map((key) => `${stringLiteral(key)}:${serialize(object[key])}`).join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return serialize(value);
}

// packages/compaction-core/src/notes.ts
var fact = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 4e3 }),
    sources: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      minItems: 1,
      maxItems: 20,
      uniqueItems: true
    }),
    quote: Type.Optional(Type.String({ minLength: 1, maxLength: 4e3 })),
    supersedes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 20 }))
  },
  { additionalProperties: false }
);
var facts = Type.Array(fact, { maxItems: 40 });
var noteSchema = Type.Object(
  {
    instructions: facts,
    failedPaths: facts,
    reasons: facts,
    state: Type.Array(fact, { minItems: 1, maxItems: 40 }),
    nextSteps: Type.Array(fact, { maxItems: 5 }),
    files: facts,
    gaps: Type.Array(Type.String({ maxLength: 1e3 }), { maxItems: 20 })
  },
  { additionalProperties: false }
);
function sourceText(entry) {
  if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "bashExecution")
      return JSON.stringify({
        command: message.command,
        output: message.output,
        exitCode: message.exitCode,
        fullOutputPath: message.fullOutputPath
      });
    if ("content" in message) {
      if (typeof message.content === "string") return message.content;
      return (message.content ?? []).map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "toolCall") return JSON.stringify({ tool: block.name, arguments: block.arguments });
        return `[${block.type} content retained in original session; not inferred in text notes]`;
      }).join("\n");
    }
  }
  if (entry.type === "custom_message")
    return typeof entry.content === "string" ? entry.content : entry.content.map((part) => part.type === "text" ? part.text : "[image retained in original session]").join("\n");
  if (entry.type === "branch_summary") return entry.summary;
  return "";
}
function sourceRole(entry) {
  return entry.type === "message" ? entry.message.role : entry.type;
}
var LINE_BREAKS = "\\r\\n\\u0085\\u2028\\u2029";
var LINE_BREAK_RUN = new RegExp(`[${LINE_BREAKS}]+`, "gu");

// packages/compaction-core/src/history.ts
var historyQuerySchema = Type2.Object(
  {
    operation: Type2.Union([Type2.Literal("search"), Type2.Literal("read")]),
    query: Type2.Optional(Type2.String({ maxLength: 1e3 })),
    entryId: Type2.Optional(Type2.String({ maxLength: 64 })),
    cursor: Type2.Optional(
      Type2.String({
        maxLength: 2e3,
        description: "Continuation cursor. Repeat the original operation, query, entryId and grantId unchanged."
      })
    ),
    grantId: Type2.Optional(Type2.String({ maxLength: 128 }))
  },
  { additionalProperties: false }
);
function searchTerms(query) {
  const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
  const chinese = query.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  return [
    .../* @__PURE__ */ new Set([
      ...words,
      ...chinese.flatMap((word) => Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)))
    ])
  ].slice(0, 64);
}
function roleWeight(role) {
  return role === "user" ? 3 : role === "assistant" ? 2 : role === "toolResult" || role === "bashExecution" ? 0 : 1;
}
var HISTORY_TOOL = "context_history";
var isRetrievalOutput = (entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === HISTORY_TOOL;
var HIT_LIMIT = 4096;
var HIT_WINDOW = 400;
function excerptStart(normalized, terms) {
  const hits = [];
  for (const [term, word] of terms.entries())
    for (let at = normalized.indexOf(word), count = 0; at >= 0 && count < HIT_LIMIT; at = normalized.indexOf(word, at + 1), count++)
      hits.push({ at, term });
  if (!hits.length) return 0;
  hits.sort((a, b) => a.at - b.at || a.term - b.term);
  const inWindow = /* @__PURE__ */ new Map();
  let best = hits[0].at;
  let most = 0;
  for (let first = 0, next = 0; first < hits.length; first++) {
    for (; next < hits.length && hits[next].at - hits[first].at <= HIT_WINDOW; next++)
      inWindow.set(hits[next].term, (inWindow.get(hits[next].term) ?? 0) + 1);
    if (inWindow.size > most) {
      most = inWindow.size;
      best = hits[first].at;
    }
    const left = (inWindow.get(hits[first].term) ?? 1) - 1;
    if (left) inWindow.set(hits[first].term, left);
    else inWindow.delete(hits[first].term);
  }
  return Math.max(0, best - 120);
}
function queryHistory(snapshot, request, budgetTokens = 4e3) {
  if (!Check2(historyQuerySchema, request)) throw new Error("HISTORY_QUERY_INVALID");
  const signature = createHash2("sha256").update(JSON.stringify([request.operation, request.query, request.entryId, "rank-v3"])).digest("hex");
  let index = 0;
  let offset = 0;
  if (request.cursor) {
    let cursor;
    try {
      cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
    } catch {
      throw new Error("HISTORY_CURSOR_INVALID");
    }
    if (!isRecord(cursor) || cursor.sessionId !== snapshot.sessionId || cursor.signature !== signature || !Number.isSafeInteger(cursor.index) || !Number.isSafeInteger(cursor.offset) || Number(cursor.index) < 0 || Number(cursor.offset) < 0) {
      throw new Error(
        "HISTORY_CURSOR_INVALID: repeat the original operation, query, entryId and grantId with the cursor, or restart the query on the current branch"
      );
    }
    if (cursor.scope !== snapshot.scopeHash) {
      const end = snapshot.entries.findIndex((entry) => entry.id === cursor.leafId);
      const pinned = end >= 0 ? snapshot.entries.slice(0, end + 1) : [];
      if (!pinned.length || hashEntries(pinned) !== cursor.scope)
        throw new Error("HISTORY_CURSOR_INVALID: source is no longer on this branch");
      snapshot = {
        ...snapshot,
        leafId: pinned[pinned.length - 1].id,
        entries: pinned,
        scopeHash: hashEntries(pinned)
      };
    }
    index = Number(cursor.index);
    offset = Number(cursor.offset);
  }
  const terms = searchTerms(request.query ?? "");
  if (request.operation === "search" && !terms.length)
    throw new Error("HISTORY_QUERY_REQUIRED: supply search keywords or read an entry ID");
  if (request.operation === "read" && !request.entryId) throw new Error("HISTORY_ENTRY_REQUIRED");
  const candidates = snapshot.entries.flatMap((entry, position) => {
    const text = sourceText(entry);
    if (!text) return [];
    if (request.operation === "read")
      return entry.id === request.entryId ? [{ entry, text, score: 1, weight: 0, position }] : [];
    if (isRetrievalOutput(entry)) return [];
    const normalized = text.toLocaleLowerCase();
    const score = terms.reduce(
      (total, term) => total + (entry.id === term ? 10 : normalized.includes(term) ? 1 : 0),
      0
    );
    return score ? [{ entry, text, score, weight: roleWeight(sourceRole(entry)), position }] : [];
  }).sort((a, b) => b.score - a.score || b.weight - a.weight || b.position - a.position);
  if (request.operation === "read" && candidates.length === 0)
    throw new Error("HISTORY_SCOPE_DENIED: entry is not in this readable scope");
  const page = {
    sessionId: snapshot.sessionId,
    leafId: snapshot.leafId,
    scopeHash: snapshot.scopeHash,
    entries: []
  };
  let remaining = Math.max(512, Math.min(4e3, budgetTokens)) - 350;
  for (; index < candidates.length; index++) {
    const { entry, text, position } = candidates[index];
    let start = offset;
    if (request.operation === "search") start = excerptStart(text.toLocaleLowerCase(), terms);
    const charLimit = request.operation === "search" ? 1400 : remaining * 2;
    let excerpt = text.slice(start, start + charLimit);
    while (textTokens(JSON.stringify(excerpt)) + 100 > remaining && excerpt.length)
      excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.8));
    if (!excerpt) break;
    page.entries.push({
      entryId: entry.id,
      parentId: entry.parentId,
      role: sourceRole(entry),
      position,
      offset: start,
      text: excerpt
    });
    remaining -= textTokens(JSON.stringify(excerpt)) + 100;
    if (request.operation === "read" && start + excerpt.length < text.length) {
      offset = start + excerpt.length;
      break;
    }
    offset = 0;
    if (remaining < 250) {
      index++;
      break;
    }
  }
  if (index < candidates.length)
    page.cursor = Buffer.from(
      JSON.stringify({
        sessionId: snapshot.sessionId,
        leafId: snapshot.leafId,
        scope: snapshot.scopeHash,
        signature,
        index,
        offset
      })
    ).toString("base64url");
  if (!page.entries.length)
    page.message = "No matching evidence in this authorized branch. Do not infer missing history.";
  return page;
}

// packages/compaction-dsh/src/codec.ts
function dshHistorySnapshot(sessionId, events) {
  const entries = [];
  const toolNames = /* @__PURE__ */ new Map();
  for (const [index, input] of events.entries()) {
    if (input.seq !== index) throw new Error("HISTORY_SOURCE_INVALID: expected the complete contiguous DSH log");
    const event = JSON.parse(canonicalize(input));
    if (event.type === "tool/call") toolNames.set(event.data.callId, event.data.name);
    const base = {
      id: String(event.seq),
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date(event.time).toISOString()
    };
    const message = event.type === "user/message" ? event.data : event.type === "assistant/message" || event.type === "tool/result" ? event.data.message : void 0;
    if (!message) {
      entries.push({ ...base, type: "custom", customType: `dsh:${event.type}`, data: event });
      continue;
    }
    const role = message.role === "tool" ? "toolResult" : message.role === "user" && message.source.kind !== "user" ? "context" : message.role;
    const content = message.content.flatMap(
      (block) => block.type === "text" ? [{ type: "text", text: block.text }] : []
    );
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
        ...message.role === "tool" ? {
          toolCallId: message.toolCallId,
          ...toolNames.has(message.toolCallId) ? { toolName: toolNames.get(message.toolCallId) } : {},
          isError: message.isError ?? false
        } : {}
      }
    });
  }
  return { sessionId, leafId: entries.at(-1)?.id ?? null, scopeHash: hashEntries(entries), entries };
}

// packages/compaction-dsh/src/history.ts
async function readDshHistory(sessions, persistence, session, request, signal) {
  signal.throwIfAborted();
  if (!await sessions.flush(session)) throw new Error("HISTORY_PERSISTENCE_REQUIRED");
  signal.throwIfAborted();
  const handle = await persistence.open(session.id, "read", { signal });
  try {
    if (handle.id !== session.id || handle.header.id !== session.id || handle.header.isSeeded)
      throw new Error("HISTORY_SCOPE_DENIED: only the current unseeded session is supported");
    const { events } = await handle.read(void 0, void 0, { signal });
    signal.throwIfAborted();
    return queryHistory(dshHistorySnapshot(session.id, events), request);
  } finally {
    await handle.close();
  }
}

// packages/compaction-dsh/src/index.ts
var name = "slice-history";
var inject = ["sessions", "sessionPersistence", "tools"];
function apply(ctx) {
  if (ctx.tools.get("context_history")) throw new Error("SLICE_TOOL_CONFLICT: context_history already registered");
  ctx.tools.register(
    defineTool({
      name: "context_history",
      description: "Search or read original text in this session's durable history. Native summaries drop exact values, quotes and timestamps: search here before answering that an earlier detail is unknown. Use native event IDs and repeat the query with its cursor for more. No other sessions are accessible. This tool does not compact history.",
      parameters: {
        operation: { type: "string", required: true, enum: ["search", "read"] },
        query: { type: "string" },
        entryId: { type: "string" },
        cursor: { type: "string" }
      },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      async execute(args, exec) {
        if (!exec.agent) throw new Error("HISTORY_SCOPE_DENIED: missing calling agent");
        return JSON.stringify(
          await readDshHistory(ctx.sessions, ctx.sessionPersistence, exec.agent.session, args, exec.signal)
        );
      }
    })
  );
}
export {
  apply,
  inject,
  name
};
