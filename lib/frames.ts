import {
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { run } from "./util.js";

export interface SampledFrame {
	path: string;
	/** Approximate capture time in seconds. */
	t: number;
}

/** Duration via ffprobe (seconds, 0 on failure). */
export async function probeDuration(videoPath: string): Promise<number> {
	try {
		const { stdout } = await run("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			videoPath,
		]);
		return Number.parseFloat(stdout.trim()) || 0;
	} catch {
		return 0;
	}
}

/**
 * Sample frames at a fixed interval (adaptive when the video is long so the
 * total stays within maxFrames). Cached per workdir+settings.
 */
export async function sampleFrames(
	videoPath: string,
	framesDir: string,
	opts: { intervalSec: number; maxFrames: number; width: number },
	log: (msg: string) => void,
	signal?: AbortSignal,
): Promise<SampledFrame[]> {
	const duration = await probeDuration(videoPath);
	const interval =
		duration > 0
			? Math.max(
					opts.intervalSec,
					Math.ceil(duration / Math.max(1, opts.maxFrames)),
				)
			: opts.intervalSec;

	const stamp = `i${interval}w${opts.width}`;
	const marker = join(framesDir, `.${stamp}.done`);

	let files: string[] = [];
	if (!existsSync(marker)) {
		// Clear stale samples from other settings.
		for (const f of readdirSync(framesDir)) {
			if (f.startsWith("sample_")) {
				try {
					rmSync(join(framesDir, f));
				} catch {
					/* ignore */
				}
			}
		}
		log(`sampling keyframes (every ${interval}s, width ${opts.width})...`);
		await run(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				videoPath,
				"-vf",
				`fps=1/${interval},scale=${opts.width}:-2`,
				"-q:v",
				"4",
				"-start_number",
				"0",
				join(framesDir, "sample_%04d.jpg"),
			],
			{ signal, timeoutMs: 15 * 60 * 1000 },
		);
		await run("touch", [marker]);
	}

	files = readdirSync(framesDir)
		.filter((f) => /^sample_\d+\.jpg$/.test(f))
		.sort();
	const frames = files.map((f) => {
		const idx = Number.parseInt(f.slice(7, 11), 10);
		return { path: join(framesDir, f), t: (idx + 0.5) * interval };
	});
	if (duration > 0) {
		// Drop frames beyond the actual duration (fps rounding can add one).
		return frames.filter((f) => f.t <= duration + 1);
	}
	return frames;
}

/** Extract one high-quality frame at an exact timestamp for the report. */
export async function extractPreciseFrame(
	videoPath: string,
	tSec: number,
	outPath: string,
	opts: { width: number; quality: number },
	signal?: AbortSignal,
): Promise<boolean> {
	if (existsSync(outPath) && statSync(outPath).size > 0) return true;
	const t = Math.max(0, tSec);
	try {
		await run(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-ss",
				t.toFixed(2),
				"-i",
				videoPath,
				"-frames:v",
				"1",
				"-vf",
				`scale=${opts.width}:-2`,
				"-q:v",
				String(opts.quality),
				"-y",
				outPath,
			],
			{ signal, timeoutMs: 60 * 1000 },
		);
		return existsSync(outPath) && statSync(outPath).size > 0;
	} catch {
		return false;
	}
}

export function fileToBase64(path: string): string {
	return readFileSync(path).toString("base64");
}
