import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "./paths.js";

export interface VideoSummaryConfig {
	transcribe: {
		/** Transcription backend. Currently only "faster-whisper" (local, GPU). */
		backend: "faster-whisper";
		/** Whisper model: tiny/base/small/medium/large-v3/large-v3-turbo or local path. */
		model: string;
		/** auto | cuda | cpu */
		device: "auto" | "cuda" | "cpu";
		/** auto | float16 | int8 | int8_float16 | float32 ... */
		computeType: string;
		/** BCP-47-ish whisper language code, or "auto". */
		language: string;
		beamSize: number;
		vad: boolean;
		batched: boolean;
		batchSize: number;
	};
	vision: {
		/** Extract keyframes and describe them with the current model (needs image input). */
		enabled: boolean;
		/** Sample one frame every N seconds. */
		intervalSec: number;
		/** Cap on sampled frames sent to the model. */
		maxFrames: number;
		/** Width of sampled frames sent to the model (smaller = cheaper). */
		frameWidth: number;
		/** Images per model call. */
		batchSize: number;
	};
	proofread: {
		/** Ask the model to find likely ASR mistakes (terms, names, homophones). */
		enabled: boolean;
		/** Apply learned dictionary corrections before proofreading. */
		applyDictionary: boolean;
		/** Save newly found corrections into dictionary.json. */
		learnToDictionary: boolean;
		/** Transcript chunk size (chars) per proofreading call. */
		chunkChars: number;
	};
	summary: {
		/** "auto" = follow transcript language. Otherwise e.g. "zh", "en". */
		language: string;
		maxTranscriptChars: number;
		/** Max precise frames embedded into the HTML report. */
		imagesInReport: number;
	};
	frames: {
		/** Width of images embedded in the report. */
		reportWidth: number;
		/** ffmpeg -q:v for report images (2 best .. 31 worst). */
		jpegQuality: number;
	};
	download: {
		/** Max video height when downloading from URL. */
		maxHeight: number;
		/** Custom yt-dlp --format override; empty = automatic. */
		format: string;
		/** Extra raw yt-dlp args, e.g. ["--cookies", "cookies.txt"]. */
		extraArgs: string[];
	};
	output: {
		/** Directory for HTML reports; empty = alongside the video (or cache dir for URLs). */
		dir: string;
		openAfterGenerate: boolean;
	};
}

export const DEFAULT_CONFIG: VideoSummaryConfig = {
	transcribe: {
		backend: "faster-whisper",
		model: "large-v3-turbo",
		device: "auto",
		computeType: "auto",
		language: "auto",
		beamSize: 5,
		vad: true,
		batched: true,
		batchSize: 16,
	},
	vision: {
		enabled: true,
		intervalSec: 30,
		maxFrames: 24,
		frameWidth: 768,
		batchSize: 6,
	},
	proofread: {
		enabled: true,
		applyDictionary: true,
		learnToDictionary: true,
		chunkChars: 12000,
	},
	summary: {
		language: "auto",
		maxTranscriptChars: 60000,
		imagesInReport: 8,
	},
	frames: {
		reportWidth: 1280,
		jpegQuality: 3,
	},
	download: {
		maxHeight: 1080,
		format: "",
		extraArgs: [],
	},
	output: {
		dir: "",
		openAfterGenerate: true,
	},
};

export function configPath(): string {
	return join(getPaths().dataDir, "config.json");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, override: unknown): T {
	if (!isPlainObject(override)) return base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(override)) {
		const cur = out[k];
		out[k] = isPlainObject(cur) && isPlainObject(v) ? merge(cur, v) : v;
	}
	return out as T;
}

/**
 * Load config.json merged over defaults. Missing/invalid file -> defaults.
 * Falls back to a legacy config.json inside the extension dir (pre-dataDir installs).
 */
export function loadConfig(): VideoSummaryConfig {
	const paths = getPaths();
	const candidates = [configPath(), join(paths.extDir, "config.json")];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			return merge(structuredClone(DEFAULT_CONFIG), raw);
		} catch {
			// try next candidate
		}
	}
	return structuredClone(DEFAULT_CONFIG);
}
