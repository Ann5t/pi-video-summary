import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "./paths.js";

export interface DictEntry {
	wrong: string;
	correct: string;
	/** How often this correction has been applied. */
	count: number;
	learnedAt: string;
	lastUsedAt: string;
	/** Why the model flagged it (homophone, term, name...). */
	reason?: string;
}

export interface Correction {
	wrong: string;
	correct: string;
	reason?: string;
}

export function dictionaryPath(): string {
	return join(getPaths().dataDir, "dictionary.json");
}

/** Load dictionary from the data dir; falls back to a legacy copy in the extension dir. */
export function loadDictionary(): DictEntry[] {
	const candidates = [
		dictionaryPath(),
		join(getPaths().extDir, "dictionary.json"),
	];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			if (!Array.isArray(raw)) continue;
			return raw.filter(
				(e): e is DictEntry =>
					typeof e === "object" &&
					e !== null &&
					typeof (e as DictEntry).wrong === "string" &&
					typeof (e as DictEntry).correct === "string",
			);
		} catch {
			// try next candidate
		}
	}
	return [];
}

export function saveDictionary(entries: DictEntry[]): void {
	entries.sort((a, b) => b.count - a.count);
	writeFileSync(dictionaryPath(), JSON.stringify(entries, null, 2), "utf8");
}

/** Apply known corrections to a text. Returns new text + applied entries. */
export function applyDictionaryToText(
	text: string,
	entries: DictEntry[],
): { text: string; applied: DictEntry[] } {
	const applied: DictEntry[] = [];
	let out = text;
	for (const e of entries) {
		if (e.wrong.length < 2 || e.wrong === e.correct) continue;
		if (out.includes(e.wrong)) {
			out = out.split(e.wrong).join(e.correct);
			applied.push(e);
		}
	}
	return { text: out, applied };
}

/** Merge model-found corrections into the dictionary. Returns added/updated entries. */
export function mergeCorrections(
	entries: DictEntry[],
	corrections: Correction[],
): { entries: DictEntry[]; changed: DictEntry[] } {
	const now = new Date().toISOString();
	const changed: DictEntry[] = [];
	const byWrong = new Map(entries.map((e) => [e.wrong, e]));

	for (const c of corrections) {
		const wrong = c.wrong?.trim();
		const correct = c.correct?.trim();
		if (!wrong || !correct || wrong === correct || wrong.length < 2) continue;

		const existing = byWrong.get(wrong);
		if (existing) {
			if (existing.correct !== correct) {
				existing.correct = correct;
				existing.reason = c.reason ?? existing.reason;
				changed.push(existing);
			}
			existing.lastUsedAt = now;
		} else {
			// Don't let a previously corrected term flip back via a new "wrong" entry.
			const collision = entries.find((e) => e.correct === wrong);
			if (collision) continue;
			const entry: DictEntry = {
				wrong,
				correct,
				count: 0,
				learnedAt: now,
				lastUsedAt: now,
				reason: c.reason,
			};
			entries.push(entry);
			byWrong.set(wrong, entry);
			changed.push(entry);
		}
	}
	return { entries, changed };
}

/** Bump usage counters after dictionary corrections were applied. */
export function markApplied(entries: DictEntry[], applied: DictEntry[]): void {
	const now = new Date().toISOString();
	for (const a of applied) {
		a.count += 1;
		a.lastUsedAt = now;
	}
}

/** Build an initial-prompt hint for whisper from the most used corrections. */
export function dictionaryPromptHint(
	entries: DictEntry[],
	maxTerms = 40,
): string {
	const terms = entries
		.slice()
		.sort((a, b) => b.count - a.count)
		.slice(0, maxTerms)
		.map((e) => e.correct);
	return terms.length > 0 ? terms.join(", ") : "";
}
