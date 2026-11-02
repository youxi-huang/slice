import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi loads every installed copy of this package, from two addresses or two scopes, and runs each copy's
 * handlers: two copies compacting one session commit two checkpoints for one attempt and pause it. From
 * v0.7.2 each copy records its entry file here, which tells it apart from an older copy that cannot stand aside.
 */
const RECORDED = Symbol.for("slice.preview.copies");

export interface LoadedCopy {
	/** The package source as declared in Pi's settings, such as npm:slice-pi@0.7.5 or git:github.com/youxi-huang/slice@extension-v0.7.2. */
	source: string;
	scope: string;
	self: boolean;
	recorded: boolean;
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function recorded(): Set<string> {
	const global = globalThis as unknown as Record<symbol, Set<string> | undefined>;
	global[RECORDED] ??= new Set();
	return global[RECORDED];
}

export function recordCopy(entry: string): void {
	recorded().add(real(entry));
}

/** Every loaded copy in Pi's load order, found by /compaction-recover, which each one has registered since v0.3.1. */
export function loadedCopies(pi: ExtensionAPI, entry: string): LoadedCopy[] {
	const self = real(entry);
	const known = recorded();
	const copies = new Map<string, LoadedCopy>();
	for (const command of pi.getCommands()) {
		// Pi suffixes a command name two extensions register: compaction-recover:1, compaction-recover:2.
		if (command.source !== "extension" || command.name.replace(/:\d+$/, "") !== "compaction-recover") continue;
		const path = real(command.sourceInfo.path);
		if (copies.has(path)) continue;
		const { source, scope } = command.sourceInfo;
		copies.set(path, { source, scope, self: path === self, recorded: known.has(path) });
	}
	return [...copies.values()];
}

/** The copy that compacts: the first one loaded, unless an older copy is loaded, since it cannot stand aside. */
export function compactingCopy(copies: readonly LoadedCopy[]): LoadedCopy | undefined {
	return copies.find((copy) => !copy.recorded) ?? copies[0];
}

/** An unidentified copy keeps compacting, since if every copy stood aside Pi's own compaction would run. */
export function standsAside(copies: readonly LoadedCopy[]): boolean {
	return copies.length > 1 && copies.some((copy) => copy.self) && compactingCopy(copies)?.self === false;
}

/** The copy to keep: the npm package, else one from the repository's current address, else the one that compacts now. */
export function keptCopy(copies: readonly LoadedCopy[]): LoadedCopy | undefined {
	return (
		copies.find((copy) => /^npm:slice-pi(?:@|$)/.test(copy.source)) ??
		copies.find((copy) => /github\.com[/:]youxi-huang\/slice(?:\.git)?(?:@|$)/.test(copy.source)) ??
		compactingCopy(copies)
	);
}

/** `pi remove` without a ref or version removes whichever one is installed. */
export function removalStep(copy: LoadedCopy): string {
	if (copy.scope === "temporary") return `leave out -e ${copy.source}`;
	const source = copy.source.startsWith("npm:")
		? copy.source.replace(/^(npm:(?:@[^/@]+\/)?[^/@]+)@.*$/, "$1")
		: copy.source.startsWith("git:") || copy.source.includes("://")
			? copy.source.replace(/@[^/@]*$/, "")
			: copy.source;
	return `run pi remove ${source}${copy.scope === "project" ? " -l" : ""}`;
}
