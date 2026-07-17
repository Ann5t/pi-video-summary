import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { sha1 } from "./util.js";

export interface WorkDir {
	/** Cache root for this video. */
	dir: string;
	audioPath: string;
	transcriptPath: string;
	framesDir: string;
	reportFramesDir: string;
	summaryPath: string;
	visionPath: string;
	reportPath: string;
}

function cacheRoot(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
	return join(base, "pi-video-summary");
}

/** Stable cache key for a local file (path+size+mtime) or a URL. */
export function videoKeyForLocal(absPath: string): string {
	const st = statSync(absPath);
	return sha1(`local:${absPath}:${st.size}:${Math.floor(st.mtimeMs)}`);
}

export function videoKeyForUrl(url: string): string {
	return sha1(`url:${url.trim()}`);
}

export function workDirFor(key: string): WorkDir {
	const dir = join(cacheRoot(), key.slice(0, 16));
	const framesDir = join(dir, "frames");
	const reportFramesDir = join(dir, "report-frames");
	for (const d of [dir, framesDir, reportFramesDir]) {
		if (!existsSync(d)) mkdirSync(d, { recursive: true });
	}
	return {
		dir,
		audioPath: join(dir, "audio.wav"),
		transcriptPath: join(dir, "transcript.json"),
		framesDir,
		reportFramesDir,
		summaryPath: join(dir, "summary.json"),
		visionPath: join(dir, "vision.json"),
		reportPath: join(dir, "report.html"),
	};
}

export function resolveLocalPath(input: string, cwd: string): string | null {
	const p = isAbsolute(input) ? input : resolve(cwd, input);
	return existsSync(p) && statSync(p).isFile() ? p : null;
}

const URL_RE = /^https?:\/\//i;

export function isUrl(input: string): boolean {
	return URL_RE.test(input.trim());
}
