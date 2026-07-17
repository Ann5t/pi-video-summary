import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Two-root layout:
 * - extDir: the extension CODE (this package; may be wiped/re-cloned by pi update)
 * - dataDir: mutable STATE (venv, whisper models, config, dictionary) that must
 *   survive package updates. Lives outside the package dir.
 */
export interface VsPaths {
	/** Package/extension directory (where index.ts lives). */
	extDir: string;
	/** State directory: venv, models, config.json, dictionary.json. */
	dataDir: string;
	/** Python venv root (dataDir/.venv). */
	venvDir: string;
	/** Whisper model cache (dataDir/models). */
	modelsDir: string;
}

let cached: VsPaths | null = null;

export function getPaths(): VsPaths {
	if (cached) return cached;

	const libDir =
		typeof __dirname !== "undefined"
			? __dirname
			: dirname(fileURLToPath(import.meta.url));
	const extDir = dirname(libDir); // lib/ -> package root

	const xdg = process.env.XDG_DATA_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
	const dataDir = join(base, "pi-video-summary");
	const venvDir = join(dataDir, ".venv");
	const modelsDir = join(dataDir, "models");

	for (const d of [dataDir, modelsDir]) {
		if (!existsSync(d)) mkdirSync(d, { recursive: true });
	}

	cached = { extDir, dataDir, venvDir, modelsDir };
	return cached;
}
