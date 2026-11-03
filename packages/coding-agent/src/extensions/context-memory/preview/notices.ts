import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PRIMARY_PI_VERSION, SUPPORTED_PI_LABEL, supportsPi } from "./compatibility.ts";
import type { InactiveReason, PreviewDiagnosis } from "./contracts.ts";
import { compactingCopy, keptCopy, type LoadedCopy, removalStep, standsAside } from "./copies.ts";

export const NOTICE_PREFIX = "Source-linked compaction";
const RETRY = "Run /compact to try again.";
const NEW_SESSION = "Keep this session file and continue in a new session.";
const NEW_TEXT_SESSION = "Keep this session file and continue in a new text-only session.";

interface Advice {
	what: string;
	next: string;
	checkpoint?: boolean;
	compactCannotClear?: boolean;
}

/** Each controlled code answers what happened and what to do next. No provider text, note text or paths. */
const ADVICE: Record<string, Advice> = {
	CONTEXT_PREVIEW_COMPACT_REQUIRED: {
		what: "Pi's context-overflow recovery needs an explicit /compact here.",
		next: "Run /compact.",
		checkpoint: true,
	},
	CONTEXT_NOTE_QUOTE: {
		what: "A quotation in the note doesn't match the message it cites.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_NOTE_SCOPE: {
		what: "The note cites a message that can't be read on this branch.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_NOTE_INVALID: {
		what: "The note doesn't match the required format.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_NOTE_BUDGET: {
		what: "The note is larger than its size limit.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_NOTE_FROZEN: {
		what: "The note can't change while compaction is running.",
		next: "Wait until Pi is idle, then run /compact.",
	},
	CONTEXT_NOTE_REPAIR_LOSS: {
		what: "The repaired note dropped something it must keep.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_WRITER_FAILED: {
		what: "The writer didn't return a usable note.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_WRITER_UNAVAILABLE: {
		what: "The writer set in pi-context-memory.json isn't available.",
		next: 'Set writerModel to "session" or to a model Pi can reach, restart Pi, then run /compact.',
		checkpoint: true,
	},
	CONTEXT_WRITER_CAPACITY: {
		what: "The messages to compact and the note don't fit the writer's context window.",
		next: "Use a writer model with a larger context window, then run /compact.",
		checkpoint: true,
	},
	CONTEXT_RECOVERY_TOO_LARGE: {
		what: "The note and the recent messages don't fit the model's context window.",
		next: "Select a model with a larger context window, then run /compact.",
		checkpoint: true,
	},
	CONTEXT_CAPACITY: {
		what: "The model's context window is too small or unknown.",
		next: "Select a model with a larger context window, then run /compact.",
	},
	CONTEXT_COMPACTION_CANCELLED: {
		what: "Compaction was cancelled.",
		next: RETRY,
		checkpoint: true,
	},
	CONTEXT_SOURCE_CHANGED: {
		what: "The session's messages changed while they were being checked.",
		next: "Wait until Pi is idle and run /compact. If this repeats, keep this session file and continue in a new session.",
	},
	CONTEXT_TOOL_BOUNDARY: {
		what: "A turn or tool call is still unfinished.",
		next: "Let it finish, then run /compact.",
	},
	CONTEXT_NO_CUT: {
		what: "There is no completed history to compact yet.",
		next: "Finish a turn, then run /compact.",
		checkpoint: true,
	},
	CONTEXT_NO_NEW_SOURCE: {
		what: "There is no new history to compact.",
		next: "Finish a new turn, then run /compact.",
		checkpoint: true,
	},
	CONTEXT_NO_MODEL_OR_SOURCE: {
		what: "No model is selected, or there is no completed history to compact.",
		next: "Select a model and finish a turn, then run /compact.",
	},
	CONTEXT_PREVIEW_PENDING: {
		what: "An earlier compaction attempt didn't finish.",
		next: "Run /compact to retry, or /compaction-recover if Pi already saved that checkpoint.",
	},
	CONTEXT_PREVIEW_COMMIT_UNCONFIRMED: {
		what: "Pi may have saved the checkpoint, but it couldn't be confirmed on disk.",
		next: "Run /compaction-recover. If it's refused, run /compact.",
	},
	CONTEXT_PREVIEW_MARKER_IO: {
		what: "The failure record in Pi's agent directory can't be read or written.",
		next: "Check free space and permissions in context-memory-preview/, then run /compact.",
	},
	CONTEXT_PREVIEW_MARKER_INVALID: {
		what: "The failure record in Pi's agent directory is unreadable.",
		next: "Run /compact to replace it.",
	},
	CONTEXT_PREVIEW_SESSION_IO: {
		what: "The session file couldn't be read back.",
		next: "Check the disk, then run /compact. If this repeats, keep the file and continue in a new session.",
	},
	CONTEXT_PREVIEW_SESSION_INVALID: {
		what: "The session file failed its format check.",
		next: "Run /compact to try again. If this repeats, keep this session file and continue in a new session.",
	},
	CONTEXT_MIGRATION_REQUIRED: {
		what: "This protected session now has a checkpoint from another compactor, which can't be checked here.",
		next: NEW_SESSION,
		compactCannotClear: true,
	},
	CONTEXT_CONFIG: {
		what: "pi-context-memory.json can't be read.",
		next: "Fix or remove that file, then restart Pi.",
		compactCannotClear: true,
	},
	CONTEXT_INPUT_TOO_LARGE: {
		what: "The next request would exceed the model's input limit.",
		next: "Run /compact.",
	},
	CONTEXT_PAYLOAD_TOO_LARGE: {
		what: "The request Pi built would exceed the model's context window.",
		next: "Run /compact.",
	},
	CONTEXT_RECOVERY_MISSING: {
		what: "The checkpoint is missing from the request, possibly because another extension changed the context.",
		next: "Disable extensions that rewrite the context, restart Pi, then run /compact.",
	},
	CONTEXT_NOTE_VERSION: {
		what: "A saved checkpoint has a format this version can't read.",
		next: NEW_SESSION,
		compactCannotClear: true,
	},
	CONTEXT_CONTINUATION_MISSING: {
		what: "A checkpoint note is missing the unfinished request or its next step.",
		next: "Run /compact to try again. If this repeats, keep this session file and continue in a new session.",
	},
};

/** A protected session with content or a host the preview cannot check. /compact cannot repair these. */
function unsupportedAdvice(reason: InactiveReason | undefined, version: string): Advice {
	switch (reason) {
		case "host":
			return {
				what: `This protected session needs Pi ${SUPPORTED_PI_LABEL}, and this is Pi ${version}.`,
				next: `Open it with Pi ${SUPPORTED_PI_LABEL} and run /compact there, or continue in a new session.`,
				compactCannotClear: true,
			};
		case "image":
			return {
				what: "This protected session now contains an image, which can't be checked.",
				next: NEW_TEXT_SESSION,
				compactCannotClear: true,
			};
		case "non-text":
			return {
				what: "This protected session now contains a non-text extension message, which can't be checked.",
				next: NEW_TEXT_SESSION,
				compactCannotClear: true,
			};
		case "context-edit":
			return {
				what: "This protected session contains a context edit that can't be checked.",
				next: NEW_SESSION,
				compactCannotClear: true,
			};
		case "in-memory":
			return {
				what: "This protected session isn't saved to a file, so it can't be checked.",
				next: "Start Pi with a saved session.",
				compactCannotClear: true,
			};
		default:
			return {
				what: "An earlier step in this session isn't supported here.",
				next: "Run /compact to confirm a new checkpoint.",
			};
	}
}

function adviceFor(code: string, reason: InactiveReason | undefined, version: string): Advice {
	if (code === "CONTEXT_PREVIEW_UNSUPPORTED") return unsupportedAdvice(reason, version);
	return (
		ADVICE[code] ?? {
			what: "The session couldn't be confirmed as safe to continue.",
			next: "Run /compaction-doctor for details.",
		}
	);
}

export function blockedNotice(
	code: string,
	durable: boolean,
	reason?: InactiveReason,
	version = PRIMARY_PI_VERSION,
	repeated = false,
): string {
	const advice = adviceFor(code, reason, version);
	if (repeated) return `${NOTICE_PREFIX}: requests are still paused. ${advice.next} (${code})`;
	const impact = durable
		? advice.compactCannotClear
			? "Requests stay paused in this session."
			: "Requests stay paused, through /reload and restarts, until a checkpoint is saved."
		: "Nothing is paused, and the next request is checked again.";
	const outcome = advice.checkpoint ? "checkpoint not saved" : durable ? "requests paused" : "request stopped";
	return `${NOTICE_PREFIX}: ${outcome}. ${advice.what} ${impact} ${advice.next} (${code})`;
}

const INACTIVE: Record<InactiveReason, (version: string) => [string, string]> = {
	host: (version) => [
		`it needs Pi ${SUPPORTED_PI_LABEL}, and this is Pi ${version}`,
		`Use Pi ${SUPPORTED_PI_LABEL} to try it.`,
	],
	"in-memory": () => ["the session isn't saved to a file", "Start Pi with a saved session to use it."],
	"foreign-checkpoint": () => [
		"the session already has a checkpoint from Pi's own compaction or another compactor",
		"Start a new session to use it.",
	],
	image: () => ["the session contains an image", "Start a new text-only session to use it."],
	"non-text": () => ["the session contains a non-text extension message", "Start a new text-only session to use it."],
	"context-edit": () => ["the session contains a context edit it can't check", "Start a new session to use it."],
};

/** The preview stands aside: nothing was written and Pi's own behavior applies. */
export function inactiveNotice(reason: InactiveReason, version: string): string {
	const [why, hint] = INACTIVE[reason](version);
	return `${NOTICE_PREFIX} is off in this session because ${why}. Pi's own compaction applies, and nothing was changed. ${hint}`;
}

/** How to keep one copy: remove every other one, keeping the current address. */
function keepOne(copies: readonly LoadedCopy[]): string {
	const kept = keptCopy(copies);
	const steps = copies.filter((copy) => copy !== kept).map(removalStep);
	return `Keep one: exit Pi, ${steps.join(", ")}, and restart Pi.`;
}

/** Said once by a copy that stands aside: the session stays protected by the copy that compacts. */
export function duplicateNotice(copies: readonly LoadedCopy[]): string {
	return `${NOTICE_PREFIX}: ${copies.length} copies are installed. The copy from ${compactingCopy(copies)?.source} compacts this session, and this one stands aside. ${keepOne(copies)} (CONTEXT_PREVIEW_DUPLICATE)`;
}

export interface DoctorSettings {
	/** `enabled: false` in pi-context-memory.json. */
	disabled: boolean;
	configError?: string;
	writerModel?: string;
	/** Every loaded copy of this package, when Pi lists more than one. */
	copies?: readonly LoadedCopy[];
	/** 0.8.0 segments, reported only when switched on or misconfigured. */
	segments?: { enabled: boolean; state: string; reason?: string };
}

const SEGMENT_FAILURES: Record<string, string> = {
	refusal: "notes the checks refused",
	"tool-call": "tool calls instead of notes",
	"exhausted-output": "notes cut off at the output limit",
	error: "writer errors",
};

/** A read-only self-check; Pi's own history gate is unknown through the extension API. */
export function doctorReport(diagnosis: PreviewDiagnosis, settings: DoctorSettings): string {
	const lines = [`${NOTICE_PREFIX} doctor (read-only: no model call, nothing written)`];
	const line = (label: string, result: string, detail: string) => lines.push(`  ${label}: ${result} - ${detail}`);
	const reason = diagnosis.reason;
	const inactive = diagnosis.protection === "not-protected";
	if (settings.disabled) {
		line("extension", "inactive", 'turned off by "enabled": false in pi-context-memory.json');
		lines.push("Result: off. Pi's own compaction applies. Remove that setting and restart Pi to turn it on.");
		return lines.join("\n");
	}
	line(
		"extension",
		settings.configError ? "blocked" : "ok",
		settings.configError
			? `pi-context-memory.json can't be read. Fix or remove it, then restart Pi. (${settings.configError})`
			: `loaded, build ${diagnosis.build}`,
	);
	const copies = settings.copies ?? [];
	if (copies.length > 1) {
		const compacting = compactingCopy(copies);
		const listed = copies.map(
			(copy) =>
				`${copy.source}${copy.self ? " (this one)" : ""} ${copy === compacting ? "compacts" : "stands aside"}`,
		);
		line("copies", "duplicate", `${copies.length} loaded: ${listed.join(", ")}. ${keepOne(copies)}`);
		if (standsAside(copies)) {
			lines.push(
				"Result: this copy stands aside. The copy that compacts protects the session; nothing was changed.",
			);
			return lines.join("\n");
		}
	}
	line(
		"host",
		supportsPi(diagnosis.host) ? "ok" : inactive ? "inactive" : "blocked",
		supportsPi(diagnosis.host)
			? `Pi ${diagnosis.host}, supported`
			: `Pi ${diagnosis.host}, needs Pi ${SUPPORTED_PI_LABEL}`,
	);
	if (inactive && reason === "host") {
		line("session", "inactive", "not checked on this Pi version. Pi's own compaction applies");
	} else if (inactive && reason) {
		line("session", "inactive", `${INACTIVE[reason](diagnosis.host)[0]}. Pi's own compaction applies`);
	} else if (reason) {
		line(
			"session",
			"blocked",
			adviceFor(diagnosis.code ?? "CONTEXT_PREVIEW_UNSUPPORTED", reason, diagnosis.host).what,
		);
	} else {
		line(
			"session",
			"ok",
			diagnosis.protection === "protected"
				? "saved text session, protected"
				: "saved text session, protection starts with /compact",
		);
	}
	if (diagnosis.writerError) {
		const advice = adviceFor(diagnosis.writerError, reason, diagnosis.host);
		line("writer", "blocked", `${advice.what} ${advice.next} (${diagnosis.writerError})`);
	} else if (diagnosis.writer) {
		line(
			"writer",
			"ok",
			settings.writerModel === "session"
				? `session model (${diagnosis.writer})`
				: `fixed writer (${diagnosis.writer})`,
		);
	} else {
		line("writer", "unknown", settings.configError ? "depends on pi-context-memory.json" : "select a model first");
	}
	const segments = settings.segments;
	if (segments?.reason === "invalid-config")
		line("segments", "off", "previewSegments in pi-context-memory.json is not valid, so segments stay off");
	else if (segments?.enabled && settings.writerModel !== "session")
		line("segments", "inactive", "they need the session writer. The fixed writer compacts as before");
	else if (segments?.state === "paused")
		line(
			"segments",
			"paused",
			`three ${SEGMENT_FAILURES[segments.reason ?? "error"] ?? "failures"} in a row. The writer compacts until the next checkpoint`,
		);
	else if (segments?.enabled)
		line("segments", "ok", "written at settled turns and merged at the next compaction without a writer call");
	const manual = diagnosis.manualCompaction;
	const tokens = manual.contextTokens
		? ` About ${manual.contextTokens.toLocaleString("en-US")} tokens are in context now.`
		: "";
	const gate = `Pi compacts only history older than its latest ${manual.piDefaultKeepRecentTokens.toLocaleString("en-US")} tokens by default.${tokens}`;
	const recover = "Run /compaction-recover to confirm the saved checkpoint";
	if (manual.preview === "not-active") line("manual /compact", "inactive", "Pi's own compaction applies");
	else if (manual.preview === "blocked") {
		const blocking = diagnosis.code ?? diagnosis.writerError;
		line(
			"manual /compact",
			"blocked",
			blocking
				? `/compact can't clear this here. ${adviceFor(blocking, reason, diagnosis.host).next} (${blocking})`
				: "/compact can't run here yet",
		);
	} else if (manual.preview === "retry")
		line(
			"manual /compact",
			"retry",
			manual.recover ? `${recover}, or /compact to retry. ${gate}` : `Run /compact to retry. ${gate}`,
		);
	else if (manual.preview === "waiting-for-turn")
		line(
			"manual /compact",
			"unknown",
			`Finish a turn with no queued input first.${manual.recover ? ` ${recover} now.` : ""} ${gate}`,
		);
	else line("manual /compact", "unknown", `Ready to try. ${gate}`);
	const durable =
		diagnosis.state === "pending" || (diagnosis.state === "blocked" && diagnosis.protection === "protected");
	if (durable && diagnosis.code) {
		const advice = adviceFor(diagnosis.code, reason, diagnosis.host);
		line("requests", "paused", `${advice.what} ${advice.next} (${diagnosis.code})`);
	} else if (diagnosis.code) {
		const advice = adviceFor(diagnosis.code, reason, diagnosis.host);
		line(
			"requests",
			"stopped",
			`${advice.what} Nothing is paused, and each request is checked again. ${advice.next} (${diagnosis.code})`,
		);
	} else {
		line("requests", "ok", "not paused");
	}
	if (inactive) lines.push("Result: off in this session. Pi's own compaction applies, and nothing was changed.");
	else if (diagnosis.code && manual.recover)
		lines.push(
			"Result: requests paused. Run /compaction-recover to confirm the saved checkpoint, or /compact if recovery is refused.",
		);
	else if (diagnosis.code)
		lines.push(
			`Result: ${durable ? "requests paused" : "request stopped"}. ${adviceFor(diagnosis.code, reason, diagnosis.host).next}`,
		);
	else if (diagnosis.writerError)
		lines.push(
			`Result: ready, but /compact can't write a checkpoint yet. ${adviceFor(diagnosis.writerError, reason, diagnosis.host).next}`,
		);
	else lines.push("Result: ready for requests. Run /compact once the conversation grows.");
	return lines.join("\n");
}

/** /compaction-recover never creates a block; a refusal says what it checked and what to do instead. */
export function recoverRefusedNotice(code: string, reason?: InactiveReason, version = PRIMARY_PI_VERSION): string {
	if (code === "CONTEXT_PREVIEW_COMMIT_UNCONFIRMED") {
		return `${NOTICE_PREFIX}: nothing to confirm. No saved checkpoint is waiting to be confirmed, so nothing was changed. If requests are paused, run /compact. (${code})`;
	}
	const advice = adviceFor(code, reason, version);
	return `${NOTICE_PREFIX}: checkpoint not confirmed. ${advice.what} ${advice.next} (${code})`;
}

export function readyNotice(): string {
	return `${NOTICE_PREFIX} is on. It writes a checkpoint on /compact and when the context nears its limit. /compaction-doctor checks this session.`;
}

/** Unrequested notices go to the UI, or to stderr so print-mode output stays clean. */
export function notify(ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(text, kind);
		else console.warn(text);
	} catch {
		// Notices are advisory; markers and request aborts remain authoritative.
	}
}

/**
 * One blocking notice per session for each user input or manual compaction attempt, however many
 * request hooks observe the same block. Informational notices appear once per key.
 */
export class NoticeGate {
	private episode = 0;
	private readonly blocked = new Map<string, number>();
	private readonly fullCode = new Map<string, string>();
	private readonly shown = new Set<string>();

	nextEpisode(): void {
		this.episode++;
	}

	blockedOnce(sessionId: string): boolean {
		if (this.blocked.get(sessionId) === this.episode) return false;
		this.blocked.set(sessionId, this.episode);
		return true;
	}

	repeated(sessionId: string, code: string): boolean {
		const repeated = this.fullCode.get(sessionId) === code;
		this.fullCode.set(sessionId, code);
		return repeated;
	}

	confirmed(sessionId: string): void {
		this.fullCode.delete(sessionId);
	}

	once(key: string): boolean {
		if (this.shown.has(key)) return false;
		this.shown.add(key);
		return true;
	}
}
