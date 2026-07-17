import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	downloadVideo,
	probeDuration,
	probeVideo,
	ytDlpPath,
} from "./acquire.js";
import {
	describeFrames,
	generateSummary,
	makeAiContext,
	proofreadTranscript,
} from "./ai.js";
import type { AiContext, FrameNote, SummaryJson } from "./ai.js";
import {
	isUrl,
	resolveLocalPath,
	videoKeyForLocal,
	videoKeyForUrl,
	workDirFor,
} from "./cache.js";
import { loadConfig } from "./config.js";
import {
	loadDictionary,
	markApplied,
	mergeCorrections,
	saveDictionary,
} from "./dictionary.js";
import type { Correction } from "./dictionary.js";
import { extractPreciseFrame, fileToBase64, sampleFrames } from "./frames.js";
import { renderReport } from "./html.js";
import type { ChapterImage } from "./html.js";
import {
	ensureAudio,
	transcribeAudio,
	transcriptToLines,
} from "./transcribe.js";
import type { Transcript } from "./transcribe.js";
import { fmtTime } from "./util.js";

export interface PipelineIo {
	/** Verbose progress line. */
	log: (msg: string) => void;
	/** Major stage change (compact UI display). */
	stage: (msg: string) => void;
}

export interface PipelineOptions {
	source: string;
	cwd: string;
	force?: boolean;
	signal?: AbortSignal;
}

export interface PipelineResult {
	htmlPath: string;
	summary: SummaryJson;
	transcript: Transcript;
	corrections: Correction[];
	frameNotes: FrameNote[];
	visionSkippedReason?: string;
	videoDurationSec: number;
	llmModel: string;
	warnings: string[];
}

function slugify(text: string, max = 40): string {
	const s = text
		.replace(/[\\/:*?"<>|#%&{}$!'@+`=~\s]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max);
	return s || "video-summary";
}

export async function runPipeline(
	ctx: ExtensionContext,
	opts: PipelineOptions,
	io: PipelineIo,
): Promise<PipelineResult> {
	const cfg = loadConfig();
	const force = opts.force ?? false;
	const warnings: string[] = [];
	const signal = opts.signal;

	// ---- 1. acquire -------------------------------------------------------
	io.stage("获取视频");
	let videoPath: string;
	let displayName: string;
	let workDir;
	const localPath = resolveLocalPath(opts.source, opts.cwd);
	if (localPath) {
		videoPath = localPath;
		displayName = basename(localPath);
		workDir = workDirFor(videoKeyForLocal(localPath));
		io.log(`local file: ${localPath}`);
	} else if (isUrl(opts.source)) {
		workDir = workDirFor(videoKeyForUrl(opts.source));
		const acquired = await downloadVideo(
			ytDlpPath(),
			opts.source,
			workDir.dir,
			cfg,
			io.log,
			signal,
		);
		videoPath = acquired.videoPath;
		displayName = acquired.fromCache ? basename(videoPath) : opts.source;
	} else {
		throw new Error(
			`Not a readable file or URL: ${opts.source}\n` +
				"Usage: /video-summary <本地视频路径 | bilibili/youtube URL> [--force]",
		);
	}

	const meta = await probeVideo(videoPath);
	const durationSec = meta.durationSec || (await probeDuration(videoPath));
	io.log(`video: ${meta.width}x${meta.height}, ${fmtTime(durationSec)}`);

	// ---- 2. audio + transcription (local, GPU) -----------------------------
	io.stage("提取音频");
	await ensureAudio(videoPath, workDir.audioPath, io.log, signal);

	const dictionary = loadDictionary();
	io.stage(`Whisper 转录（${cfg.transcribe.model}）`);
	const tx = await transcribeAudio(
		workDir.audioPath,
		workDir.transcriptPath,
		cfg,
		dictionary,
		force,
		io.log,
		signal,
	);
	const transcript = tx.transcript;
	if (tx.dictApplied.length > 0) {
		markApplied(dictionary, tx.dictApplied);
		saveDictionary(dictionary);
	}
	if (transcript.segments.length === 0) {
		throw new Error(
			"Transcription produced no segments (silent video or transcription failure).",
		);
	}
	io.log(
		`transcript: ${transcript.segments.length} segments, lang=${transcript.language} ` +
			`(${transcript.deviceUsed}/${transcript.computeTypeUsed})`,
	);

	// ---- 3. AI context (the only paid step) --------------------------------
	const aiOrErr = await makeAiContext(ctx);
	if ("error" in aiOrErr) {
		throw new Error(`Cannot reach the current model: ${aiOrErr.error}`);
	}
	const ai: AiContext = aiOrErr.ai;
	io.log(
		`LLM: ${ai.modelId}${ai.visionCapable ? " (vision)" : " (text-only)"}`,
	);

	// ---- 4. AI proofreading + dictionary learning ---------------------------
	const corrections: Correction[] = [];
	if (cfg.proofread.enabled && !tx.fromCache) {
		io.stage("AI 校对转录文本");
		const pr = await proofreadTranscript(
			ai,
			transcript.segments,
			dictionary,
			cfg,
			io.log,
			signal,
		);
		corrections.push(...pr.corrections);
		if (corrections.length > 0) {
			writeFileSync(
				workDir.transcriptPath,
				JSON.stringify(transcript, null, 1),
				"utf8",
			);
			if (cfg.proofread.learnToDictionary) {
				const merged = mergeCorrections(dictionary, corrections);
				saveDictionary(merged.entries);
				if (merged.changed.length > 0) {
					io.log(
						`dictionary: learned ${merged.changed.length} new correction(s)`,
					);
				}
			}
		}
	} else if (tx.fromCache) {
		io.log("proofread skipped (cached transcript)");
	}

	// ---- 5. Vision pass ------------------------------------------------------
	let frameNotes: FrameNote[] = [];
	let visionSkippedReason: string | undefined;
	if (!cfg.vision.enabled) {
		visionSkippedReason = "disabled in config";
	} else if (!ai.visionCapable) {
		visionSkippedReason = `current model ${ai.modelId} has no image input`;
	} else if (!force && existsSync(workDir.visionPath)) {
		try {
			frameNotes = JSON.parse(
				readFileSync(workDir.visionPath, "utf8"),
			) as FrameNote[];
			io.log(`vision: using cached notes (${frameNotes.length})`);
		} catch {
			visionSkippedReason = "cached vision notes unreadable";
		}
	} else {
		io.stage("抽取关键帧 + 画面理解");
		try {
			const frames = await sampleFrames(
				videoPath,
				workDir.framesDir,
				{
					intervalSec: cfg.vision.intervalSec,
					maxFrames: cfg.vision.maxFrames,
					width: cfg.vision.frameWidth,
				},
				io.log,
				signal,
			);
			io.log(`sampled ${frames.length} frames`);
			frameNotes = await describeFrames(ai, frames, cfg, io.log, signal);
			writeFileSync(
				workDir.visionPath,
				JSON.stringify(frameNotes, null, 1),
				"utf8",
			);
		} catch (e) {
			visionSkippedReason = e instanceof Error ? e.message : String(e);
			warnings.push(`vision step failed: ${visionSkippedReason}`);
			io.log(`vision failed, continuing without it: ${visionSkippedReason}`);
		}
	}
	if (visionSkippedReason && !warnings.some((w) => w.includes("vision"))) {
		io.log(`vision skipped: ${visionSkippedReason}`);
	}

	// ---- 6. Structured summary ------------------------------------------------
	let summary: SummaryJson | null = null;
	if (!force && existsSync(workDir.summaryPath)) {
		try {
			const cached = JSON.parse(readFileSync(workDir.summaryPath, "utf8")) as {
				language?: string;
				summary?: SummaryJson;
			};
			const wantLang =
				cfg.summary.language !== "auto"
					? cfg.summary.language
					: transcript.language;
			if (cached.summary && cached.language === wantLang) {
				summary = cached.summary;
				io.log("summary: using cached result");
			}
		} catch {
			// regenerate
		}
	}
	if (!summary) {
		io.stage("生成结构化总结");
		summary = await generateSummary(
			ai,
			{
				sourceName: displayName,
				durationSec,
				transcriptLanguage: transcript.language,
				transcriptLines: transcriptToLines(transcript.segments, fmtTime),
				frameNotes,
				fmt: fmtTime,
			},
			cfg,
			signal,
		);
		writeFileSync(
			workDir.summaryPath,
			JSON.stringify(
				{
					language:
						cfg.summary.language !== "auto"
							? cfg.summary.language
							: transcript.language,
					summary,
				},
				null,
				1,
			),
			"utf8",
		);
	}

	// ---- 7. Precise frames for the report -------------------------------------
	io.stage("精确截取配图");
	const chapterImages = new Map<number, ChapterImage>();
	const chaptersWithImages = summary.chapters
		.map((c, i) => ({ c, i }))
		.filter(({ c }) => c.imageTimestampSec !== null)
		.slice(0, cfg.summary.imagesInReport);
	for (const { c, i } of chaptersWithImages) {
		const t = Math.min(
			c.imageTimestampSec as number,
			Math.max(0, durationSec - 0.5),
		);
		const outPath = join(workDir.reportFramesDir, `chapter-${i}.jpg`);
		const ok = await extractPreciseFrame(
			videoPath,
			t,
			outPath,
			{
				width: cfg.frames.reportWidth,
				quality: cfg.frames.jpegQuality,
			},
			signal,
		);
		if (ok) {
			chapterImages.set(i, {
				dataUri: `data:image/jpeg;base64,${fileToBase64(outPath)}`,
				t,
				caption: c.imageReason || c.title,
			});
		}
	}
	io.log(
		`report images: ${chapterImages.size}/${chaptersWithImages.length} extracted`,
	);

	// ---- 8. HTML report ---------------------------------------------------------
	io.stage("生成 HTML 报告");
	const html = renderReport({
		title: summary.title,
		sourceName: displayName,
		source: opts.source,
		generatedAt: new Date(),
		durationSec,
		language: transcript.language,
		whisperModel: transcript.model,
		whisperDevice: `${transcript.deviceUsed}/${transcript.computeTypeUsed}`,
		llmModel: ai.modelId,
		summary,
		chapterImages,
		transcript: transcript.segments,
		correctionsApplied: corrections.map((c) => ({
			wrong: c.wrong,
			correct: c.correct,
		})),
	});

	let htmlPath: string;
	if (cfg.output.dir) {
		htmlPath = join(cfg.output.dir, `${slugify(summary.title)}.html`);
	} else if (localPath) {
		const ext = extname(localPath);
		htmlPath = join(
			dirname(localPath),
			`${basename(localPath, ext)}.summary.html`,
		);
	} else {
		htmlPath = workDir.reportPath;
	}
	writeFileSync(htmlPath, html, "utf8");

	return {
		htmlPath,
		summary,
		transcript,
		corrections,
		frameNotes,
		visionSkippedReason,
		videoDurationSec: durationSec,
		llmModel: ai.modelId,
		warnings,
	};
}
