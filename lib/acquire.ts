import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { VideoSummaryConfig } from "./config.js";
import { getPaths } from "./paths.js";
import { run } from "./util.js";

export interface AcquiredVideo {
	videoPath: string;
	displayName: string;
	/** Original input (path or URL). */
	source: string;
	fromCache: boolean;
}

export function ytDlpPath(): string {
	return join(getPaths().venvDir, "bin", "yt-dlp");
}

export interface VideoMeta {
	durationSec: number;
	width: number;
	height: number;
}

/** ffprobe duration + dimensions. */
export async function probeVideo(videoPath: string): Promise<VideoMeta> {
	const { stdout } = await run("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height:format=duration",
		"-of",
		"json",
		videoPath,
	]);
	try {
		const parsed = JSON.parse(stdout);
		const stream = parsed.streams?.[0] ?? {};
		return {
			durationSec: Number.parseFloat(parsed.format?.duration ?? "0") || 0,
			width: Number(stream.width) || 0,
			height: Number(stream.height) || 0,
		};
	} catch {
		return { durationSec: 0, width: 0, height: 0 };
	}
}

/** Download a URL (bilibili/youtube/anything yt-dlp supports) into the cache dir. */
export async function downloadVideo(
	ytdlpBin: string,
	url: string,
	destDir: string,
	cfg: VideoSummaryConfig,
	log: (msg: string) => void,
	signal?: AbortSignal,
): Promise<AcquiredVideo> {
	const outTemplate = join(destDir, "source.%(ext)s");

	// Reuse a previously downloaded file when present.
	const existing = ["mp4", "mkv", "webm", "flv", "mov"]
		.map((ext) => join(destDir, `source.${ext}`))
		.find((p) => existsSync(p));
	if (existing) {
		log(`using cached download: ${basename(existing)}`);
		return {
			videoPath: existing,
			displayName: basename(existing),
			source: url,
			fromCache: true,
		};
	}

	const format =
		cfg.download.format ||
		`bestvideo[height<=${cfg.download.maxHeight}][ext=mp4]+bestaudio[ext=m4a]/` +
			`bestvideo[height<=${cfg.download.maxHeight}]+bestaudio/` +
			`best[height<=${cfg.download.maxHeight}]/best`;

	const args = [
		"--no-playlist",
		"--no-warnings",
		"-f",
		format,
		"--merge-output-format",
		"mp4",
		"-o",
		outTemplate,
		"--print",
		"after_move:filepath",
		...cfg.download.extraArgs,
		url,
	];

	log(`yt-dlp downloading (≤${cfg.download.maxHeight}p)...`);
	const { stdout } = await run(ytdlpBin, args, {
		signal,
		timeoutMs: 30 * 60 * 1000,
		onStderrLine: (line) => {
			if (line.includes("%") || line.includes("Merging"))
				log(line.slice(0, 200));
		},
	});

	const lines = stdout
		.trim()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const filePath = lines[lines.length - 1];
	if (!filePath || !existsSync(filePath)) {
		throw new Error(
			`yt-dlp finished but output file not found.\nstdout: ${stdout.slice(-500)}`,
		);
	}
	return {
		videoPath: filePath,
		displayName: basename(filePath),
		source: url,
		fromCache: false,
	};
}
