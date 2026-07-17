import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VideoSummaryConfig } from "./config.js";
import type { DictEntry } from "./dictionary.js";
import { applyDictionaryToText, dictionaryPromptHint } from "./dictionary.js";
import { getPaths } from "./paths.js";
import { run } from "./util.js";

export interface TranscriptWord {
	start: number;
	end: number;
	word: string;
	probability: number | null;
}

export interface TranscriptSegment {
	id: number;
	start: number;
	end: number;
	text: string;
	avgLogprob: number | null;
	noSpeechProb: number | null;
	words?: TranscriptWord[];
}

export interface Transcript {
	language: string;
	languageProbability: number;
	duration: number;
	model: string;
	deviceUsed: string;
	computeTypeUsed: string;
	segments: TranscriptSegment[];
}

export function pythonPath(): string {
	return join(getPaths().venvDir, "bin", "python");
}

function loadTranscriptFile(path: string): Transcript {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Transcript;
	} catch (e) {
		throw new Error(
			`Failed to parse transcript file ${path}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/** LD_LIBRARY_PATH pointing at pip-installed NVIDIA libs inside the venv. */
export function nvidiaLibEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	try {
		const venvLib = join(getPaths().venvDir, "lib");
		const pyDir = readdirSync(venvLib).find((d) => d.startsWith("python"));
		if (pyDir) {
			const nvidiaDir = join(venvLib, pyDir, "site-packages", "nvidia");
			const libDirs = readdirSync(nvidiaDir)
				.map((d) => join(nvidiaDir, d, "lib"))
				.filter((p) => existsSync(p));
			if (libDirs.length > 0) {
				env.LD_LIBRARY_PATH = [libDirs.join(":"), env.LD_LIBRARY_PATH ?? ""]
					.filter(Boolean)
					.join(":");
			}
		}
	} catch {
		// no nvidia packages installed -> CPU mode anyway
	}
	return env;
}

/** Extract 16kHz mono wav for transcription. Cached. */
export async function ensureAudio(
	videoPath: string,
	audioPath: string,
	log: (msg: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	if (existsSync(audioPath)) return;
	log("extracting audio (16kHz mono wav)...");
	await run(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			videoPath,
			"-vn",
			"-ac",
			"1",
			"-ar",
			"16000",
			"-c:a",
			"pcm_s16le",
			"-y",
			audioPath,
		],
		{ signal, timeoutMs: 10 * 60 * 1000 },
	);
}

export interface TranscribeResult {
	transcript: Transcript;
	fromCache: boolean;
	/** Dictionary entries applied after transcription. */
	dictApplied: DictEntry[];
}

/** Run faster-whisper (GPU when available). Result cached per workdir. */
export async function transcribeAudio(
	audioPath: string,
	transcriptPath: string,
	cfg: VideoSummaryConfig,
	dictionary: DictEntry[],
	force: boolean,
	log: (msg: string) => void,
	signal?: AbortSignal,
): Promise<TranscribeResult> {
	if (!force && existsSync(transcriptPath)) {
		const transcript = loadTranscriptFile(transcriptPath);
		if (transcript.segments.length > 0) {
			log("using cached transcript");
			return { transcript, fromCache: true, dictApplied: [] };
		}
		log("cached transcript is empty — re-transcribing");
	}

	const hint = cfg.proofread.applyDictionary
		? dictionaryPromptHint(dictionary)
		: "";
	const paths = getPaths();
	const args = [
		join(paths.extDir, "transcribe.py"),
		"--input",
		audioPath,
		"--out",
		transcriptPath,
		"--model",
		cfg.transcribe.model,
		"--device",
		cfg.transcribe.device,
		"--compute-type",
		cfg.transcribe.computeType,
		"--language",
		cfg.transcribe.language,
		"--beam-size",
		String(cfg.transcribe.beamSize),
		"--vad",
		cfg.transcribe.vad ? "1" : "0",
		"--batched",
		cfg.transcribe.batched ? "1" : "0",
		"--batch-size",
		String(cfg.transcribe.batchSize),
		"--download-root",
		paths.modelsDir,
		...(hint ? ["--initial-prompt", hint] : []),
	];

	log(
		`transcribing with ${cfg.transcribe.model} (${cfg.transcribe.device})...`,
	);
	await run(pythonPath(), args, {
		env: nvidiaLibEnv(),
		signal,
		timeoutMs: 6 * 60 * 60 * 1000,
		onStderrLine: (line) => {
			if (
				line.includes("done:") ||
				line.includes("falling back") ||
				line.includes("failed")
			) {
				log(line.replace(/^\[transcribe\]\s*/, ""));
			}
		},
	});

	const transcript = loadTranscriptFile(transcriptPath);

	// Apply known corrections right away so downstream steps see clean text.
	let dictApplied: DictEntry[] = [];
	if (cfg.proofread.applyDictionary && dictionary.length > 0) {
		const appliedSet = new Map<number, DictEntry>();
		for (const seg of transcript.segments) {
			const { text, applied } = applyDictionaryToText(seg.text, dictionary);
			if (applied.length > 0) {
				seg.text = text;
				for (const a of applied) appliedSet.set(a.wrong.length, a);
			}
		}
		dictApplied = [...appliedSet.values()];
		if (dictApplied.length > 0) {
			writeFileSync(
				transcriptPath,
				JSON.stringify(transcript, null, 1),
				"utf8",
			);
			log(`dictionary: applied ${dictApplied.length} known correction(s)`);
		}
	}

	return { transcript, fromCache: false, dictApplied };
}

/** Render transcript as timestamped lines for prompts/report. */
export function transcriptToLines(
	segments: TranscriptSegment[],
	fmt: (sec: number) => string,
): string {
	return segments.map((s) => `[${fmt(s.start)}] ${s.text}`).join("\n");
}
