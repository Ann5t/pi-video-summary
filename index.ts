import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./lib/config.js";
import {
	dictionaryPath,
	loadDictionary,
	saveDictionary,
} from "./lib/dictionary.js";
import type { DictEntry } from "./lib/dictionary.js";
import { getPaths } from "./lib/paths.js";
import { runPipeline } from "./lib/pipeline.js";
import { fmtTime } from "./lib/util.js";

const PATHS = getPaths();

const STATUS_KEY = "video-summary";

interface VsDetails {
	htmlPath: string;
	title: string;
	tldr: string;
	durationSec: number;
	language: string;
	keywords: string[];
	chapters: Array<{ startSec: number; title: string }>;
	corrections: Array<{ wrong: string; correct: string }>;
	imagesEmbedded: number;
	visionNoteCount: number;
	visionSkippedReason?: string;
	warnings: string[];
}

function isInstalled(): boolean {
	return existsSync(join(PATHS.venvDir, "bin", "python"));
}

function installHint(): string {
	return `video-summary 未安装依赖。请运行:\n  bash ${join(PATHS.extDir, "install.sh")}`;
}

function makeIo(
	setStage: (msg: string) => void,
	logLine: (msg: string) => void,
): { stage: (msg: string) => void; log: (msg: string) => void } {
	return { stage: setStage, log: logLine };
}

async function openHtml(htmlPath: string): Promise<void> {
	try {
		const opener = process.platform === "darwin" ? "open" : "xdg-open";
		const { spawn } = await import("node:child_process");
		const child = spawn(opener, [htmlPath], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// headless environment — ignore
	}
}

function parseArgs(args: string): { source: string; force: boolean } {
	const tokens = args.split(/\s+/).filter(Boolean);
	const force = tokens.includes("--force") || tokens.includes("-f");
	const source = tokens.filter((t) => !t.startsWith("-")).join(" ");
	return { source, force };
}

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------------ setup check
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!isInstalled()) {
			ctx.ui.notify(`video-summary: ${installHint()}`, "warning");
		}
	});

	// ------------------------------------------------------------------ main command
	pi.registerCommand("video-summary", {
		description:
			"总结视频：/video-summary <本地路径 | bilibili/youtube URL> [--force] — 本地 Whisper 转录 + AI 校对 + 画面理解，输出图文 HTML",
		handler: async (args, ctx) => {
			const { source, force } = parseArgs(args ?? "");
			if (!source) {
				ctx.ui.notify(
					"用法: /video-summary <视频路径或URL> [--force]",
					"warning",
				);
				return;
			}
			if (!isInstalled()) {
				ctx.ui.notify(installHint(), "error");
				return;
			}

			const verbose = !ctx.hasUI; // print mode: log to stderr for visibility
			const io = makeIo(
				(stage) => {
					if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `🎬 ${stage}…`);
					else process.stderr.write(`[video-summary] == ${stage}\n`);
				},
				(msg) => {
					if (verbose) process.stderr.write(`[video-summary] ${msg}\n`);
				},
			);

			const startedAt = Date.now();
			try {
				const result = await runPipeline(
					ctx,
					{
						source,
						cwd: ctx.cwd,
						force,
					},
					io,
				);

				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
				const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
				const msg = `✓ 《${result.summary.title}》 ${result.summary.chapters.length} 章节 · ${mins} 分钟完成\n${result.htmlPath}`;
				if (ctx.hasUI) {
					ctx.ui.notify(msg, "info");
					const cfg = loadConfig();
					if (cfg.output.openAfterGenerate) void openHtml(result.htmlPath);
				} else {
					console.log(`[video-summary] done: ${result.htmlPath}`);
				}
			} catch (e) {
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
				const msg = e instanceof Error ? e.message : String(e);
				if (ctx.hasUI) ctx.ui.notify(`video-summary 失败: ${msg}`, "error");
				else console.error(`[video-summary] failed: ${msg}`);
			}
		},
	});

	// ------------------------------------------------------------------ config command
	pi.registerCommand("video-summary-config", {
		description:
			"查看/编辑 video-summary 配置（转录、取帧、校对、输出等所有可配置项）",
		handler: async (_args, ctx) => {
			const cfgPath = join(PATHS.dataDir, "config.json");
			if (!ctx.hasUI) {
				console.log(
					`config: ${cfgPath}\n${JSON.stringify(loadConfig(), null, 2)}`,
				);
				return;
			}
			const current = JSON.stringify(loadConfig(), null, 2);
			const edited = await ctx.ui.editor(
				"编辑 video-summary 配置（保存并退出以应用）",
				current,
			);
			if (edited === undefined) return;
			try {
				JSON.parse(edited); // validate
				const { writeFileSync } = await import("node:fs");
				writeFileSync(cfgPath, edited, "utf8");
				ctx.ui.notify("配置已保存，下次运行时生效", "info");
			} catch (e) {
				ctx.ui.notify(
					`JSON 无效，未保存: ${e instanceof Error ? e.message : e}`,
					"error",
				);
			}
		},
	});

	// ------------------------------------------------------------------ dictionary command
	pi.registerCommand("video-dict", {
		description: "查看/编辑转录纠错词典（AI 校对自动学习的 wrong→correct 对）",
		handler: async (_args, ctx) => {
			const entries = loadDictionary();
			if (!ctx.hasUI) {
				console.log(
					`dictionary: ${dictionaryPath()} (${entries.length} entries)`,
				);
				for (const e of entries)
					console.log(`  ${e.wrong} → ${e.correct} (×${e.count})`);
				return;
			}
			if (entries.length === 0) {
				ctx.ui.notify("词典为空——跑过一次 AI 校对后会自动积累", "info");
			}
			const edited = await ctx.ui.editor(
				`纠错词典（${entries.length} 条，编辑后保存）`,
				JSON.stringify(entries, null, 2),
			);
			if (edited === undefined) return;
			try {
				const parsed = JSON.parse(edited) as DictEntry[];
				if (!Array.isArray(parsed)) throw new Error("应为 JSON 数组");
				saveDictionary(parsed);
				ctx.ui.notify(`词典已保存（${parsed.length} 条）`, "info");
			} catch (e) {
				ctx.ui.notify(
					`JSON 无效，未保存: ${e instanceof Error ? e.message : e}`,
					"error",
				);
			}
		},
	});

	// ------------------------------------------------------------------ LLM tool
	pi.registerTool({
		name: "video_summary",
		label: "Video Summary",
		description:
			"Summarize a video into an illustrated HTML report. Input: a local video file path " +
			"or a video URL (bilibili.com, youtube.com, anything yt-dlp supports). " +
			"Pipeline: yt-dlp download → ffmpeg audio → local faster-whisper GPU transcription → " +
			"AI proofreading (learns corrections into a local dictionary) → keyframe vision pass → " +
			"structured summary → self-contained HTML with embedded frames. " +
			"Takes a few minutes for long videos. Returns the HTML path and the structured summary.",
		promptSnippet:
			"Summarize a video (local path or bilibili/youtube URL) into an illustrated HTML report",
		promptGuidelines: [
			"Use video_summary when the user gives a video file path or a bilibili/youtube video URL and asks for a summary, 视频总结, or 总结视频.",
		],
		parameters: Type.Object({
			source: Type.String({
				description: "Local video file path or video URL",
			}),
			force: Type.Optional(
				Type.Boolean({ description: "Ignore caches and rerun every step" }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!isInstalled()) throw new Error(installHint());

			const io = makeIo(
				(stage) => {
					onUpdate?.({ content: [{ type: "text", text: `🎬 ${stage}…` }] });
				},
				(msg) => {
					onUpdate?.({ content: [{ type: "text", text: msg }] });
				},
			);

			const result = await runPipeline(
				ctx,
				{
					source: params.source,
					cwd: ctx.cwd,
					force: params.force ?? false,
					signal: signal ?? undefined,
				},
				io,
			);

			const s = result.summary;
			const details: VsDetails = {
				htmlPath: result.htmlPath,
				title: s.title,
				tldr: s.tldr,
				durationSec: result.videoDurationSec,
				language: result.transcript.language,
				keywords: s.keywords,
				chapters: s.chapters.map((c) => ({
					startSec: c.startSec,
					title: c.title,
				})),
				corrections: result.corrections.map((c) => ({
					wrong: c.wrong,
					correct: c.correct,
				})),
				imagesEmbedded: s.chapters.filter((c) => c.imageTimestampSec !== null)
					.length,
				visionNoteCount: result.frameNotes.length,
				visionSkippedReason: result.visionSkippedReason,
				warnings: result.warnings,
			};

			const text = [
				`✓ 《${s.title}》(${fmtTime(result.videoDurationSec)}, ${result.transcript.language})`,
				`HTML 报告: ${result.htmlPath}`,
				``,
				`TL;DR: ${s.tldr}`,
				``,
				`章节 (${s.chapters.length}):`,
				...s.chapters.map((c) => `  [${fmtTime(c.startSec)}] ${c.title}`),
				...(result.corrections.length > 0
					? [
							``,
							`AI 校对修正: ${result.corrections.map((c) => `${c.wrong}→${c.correct}`).join(", ")}`,
						]
					: []),
				...(result.warnings.length > 0
					? [``, `警告: ${result.warnings.join("; ")}`]
					: []),
			].join("\n");

			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme, _context) {
			const src = typeof args.source === "string" ? args.source : "";
			const short = src.length > 60 ? `…${src.slice(-59)}` : src;
			return new Text(
				theme.fg("toolTitle", theme.bold("video_summary ")) +
					theme.fg("muted", short),
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				const text =
					result.content.find((c) => c.type === "text")?.text ?? "处理中…";
				return new Text(theme.fg("warning", `🎬 ${text}`), 0, 0);
			}
			const d = result.details as VsDetails | undefined;
			if (!d || result.isError) {
				const text =
					result.content.find((c) => c.type === "text")?.text ?? "失败";
				return new Text(theme.fg("error", `✗ ${text}`), 0, 0);
			}

			let out = theme.fg("success", `✓ 《${d.title}》`);
			out += theme.fg(
				"muted",
				`  ${fmtTime(d.durationSec)} · ${d.chapters.length} 章节 · ${d.imagesEmbedded} 图` +
					(d.corrections.length > 0
						? ` · 校对 ${d.corrections.length} 处`
						: ""),
			);
			out += `\n${theme.fg("accent", d.htmlPath)}`;
			if (d.tldr) {
				out += `\n${theme.fg("dim", d.tldr.length > 120 ? `${d.tldr.slice(0, 120)}…` : d.tldr)}`;
			}
			if (expanded) {
				out += `\n${theme.bold("章节:")}`;
				for (const c of d.chapters) {
					out += `\n  ${theme.fg("accent", fmtTime(c.startSec))} ${c.title}`;
				}
				if (d.keywords.length > 0)
					out += `\n${theme.fg("dim", `关键词: ${d.keywords.join(" / ")}`)}`;
				if (d.corrections.length > 0) {
					out += `\n${theme.fg("dim", `校对: ${d.corrections.map((c) => `${c.wrong}→${c.correct}`).join(", ")}`)}`;
				}
				if (d.visionSkippedReason) {
					out += `\n${theme.fg("warning", `画面理解已跳过: ${d.visionSkippedReason}`)}`;
				}
			}
			return new Text(out, 0, 0);
		},
	});
}
