import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VideoSummaryConfig } from "./config.js";
import type { Correction } from "./dictionary.js";
import type { SampledFrame } from "./frames.js";
import { fileToBase64 } from "./frames.js";
import type { TranscriptSegment } from "./transcribe.js";
import { truncateMiddle } from "./util.js";

type CompleteModel = Parameters<typeof complete>[0];

export interface AiContext {
	model: CompleteModel;
	modelId: string;
	api: string;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: NodeJS.ProcessEnv;
	visionCapable: boolean;
	/** Set after pi-ai's image serialization fails: use hand-built anthropic requests. */
	useRawAnthropicVision: boolean;
}

type RegistryResult = {
	ok: boolean;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: NodeJS.ProcessEnv;
	error?: string;
};

interface ModelRegistry {
	find(provider: string, modelId: string): CompleteModel | undefined;
	getApiKeyAndHeaders(m: CompleteModel): Promise<RegistryResult>;
	getAvailable(): CompleteModel[];
}

/** Build an AI context from the *current* pi model (the only paid step). */
export async function makeAiContext(
	ctx: ExtensionContext,
): Promise<{ ai: AiContext } | { error: string }> {
	const model = ctx.model as CompleteModel | undefined;
	if (!model) return { error: "No active model in this session" };

	const registry = ctx.modelRegistry as unknown as ModelRegistry;
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { error: auth.error ?? "Model authentication failed" };
	if (!auth.apiKey)
		return { error: "No API key available for the current model" };

	return buildAiContext(model, auth, registry);
}

/**
 * Build an AI context for a specific model by "provider/modelId" spec.
 * Returns error if the model is not found or has no auth.
 */
export async function makeAiContextForModel(
	ctx: ExtensionContext,
	modelSpec: string,
): Promise<{ ai: AiContext } | { error: string }> {
	if (!modelSpec) return { error: "Empty model spec" };

	const slashIdx = modelSpec.indexOf("/");
	if (slashIdx < 0) {
		return {
			error: `Invalid model spec "${modelSpec}". Use "provider/modelId" format, e.g. "zhipu/glm-4v-plus".`,
		};
	}

	const provider = modelSpec.slice(0, slashIdx);
	const modelId = modelSpec.slice(slashIdx + 1);
	const registry = ctx.modelRegistry as unknown as ModelRegistry;

	const model = registry.find(provider, modelId);
	if (!model) {
		return { error: `Model "${modelSpec}" not found. Use /video-summary-models to list available models.` };
	}

	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { error: auth.error ?? `Model "${modelSpec}" authentication failed` };
	if (!auth.apiKey) return { error: `No API key available for "${modelSpec}"` };

	return buildAiContext(model, auth, registry);
}

function buildAiContext(
	model: CompleteModel,
	auth: RegistryResult,
	_registry: ModelRegistry,
): { ai: AiContext } {
	const input = (model as { input?: unknown }).input;
	const visionCapable = Array.isArray(input) && input.includes("image");
	const modelId = `${(model as { provider?: string }).provider ?? "?"}/${(model as { id?: string }).id ?? "?"}`;
	const m = model as { api?: string; baseUrl?: string };

	return {
		ai: {
			model,
			modelId,
			api: m.api ?? "",
			baseUrl: m.baseUrl ?? "",
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			visionCapable,
			useRawAnthropicVision: false,
		},
	};
}

/**
 * List all available models (with valid auth) from the model registry,
 * grouped by provider.
 */
export function listAvailableModels(ctx: ExtensionContext): Array<{
	provider: string;
	modelId: string;
	label: string;
	visionCapable: boolean;
}> {
	const registry = ctx.modelRegistry as unknown as ModelRegistry;
	const available = registry.getAvailable();

	const result: Array<{
		provider: string;
		modelId: string;
		label: string;
		visionCapable: boolean;
	}> = [];

	for (const m of available) {
		const provider = (m as { provider?: string }).provider ?? "?";
		const id = (m as { id?: string }).id ?? "?";
		const input = (m as { input?: unknown }).input;
		const visionCapable = Array.isArray(input) && input.includes("image");
		result.push({
			provider,
			modelId: `${provider}/${id}`,
			label: `${provider}/${id}`,
			visionCapable,
		});
	}

	// Sort by provider, then model id
	result.sort((a, b) => {
		const pc = a.provider.localeCompare(b.provider);
		return pc !== 0 ? pc : a.modelId.localeCompare(b.modelId);
	});

	return result;
}

export interface ImagePayload {
	data: string; // base64
	mediaType: string;
}

interface TextBlock {
	type: string;
	text?: string;
}

/** One round-trip to the current model. Returns concatenated text. */
export async function chat(
	ai: AiContext,
	prompt: string,
	images: ImagePayload[] = [],
	signal?: AbortSignal,
): Promise<string> {
	// pi-ai's anthropic image serialization is rejected by some anthropic-compat
	// endpoints (e.g. kimi-coding): use a hand-built request once we know that.
	if (
		images.length > 0 &&
		ai.useRawAnthropicVision &&
		ai.api === "anthropic-messages"
	) {
		return chatAnthropicRaw(ai, prompt, images, signal);
	}

	const content: unknown[] = [];
	for (const img of images) {
		content.push({
			type: "image",
			source: { type: "base64", mediaType: img.mediaType, data: img.data },
		});
	}
	content.push({ type: "text", text: prompt });

	const response = await complete(
		ai.model,
		{
			messages: [
				{
					role: "user" as const,
					content: content as never,
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: ai.apiKey,
			headers: ai.headers,
			env: ai.env,
			...(signal ? { signal } : {}),
		} as Parameters<typeof complete>[2],
	);

	const stop = (response as { stopReason?: string }).stopReason;
	if (stop === "error") {
		const msg =
			(response as { errorMessage?: string }).errorMessage ??
			"unknown provider error";
		if (images.length > 0 && ai.api === "anthropic-messages") {
			ai.useRawAnthropicVision = true;
			return chatAnthropicRaw(ai, prompt, images, signal);
		}
		throw new Error(`model call failed: ${msg}`);
	}

	return (response.content as TextBlock[])
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

/**
 * Hand-built Anthropic Messages request with snake_case image sources.
 * Used when pi-ai's serialization gets a 400 from an anthropic-compat endpoint.
 */
async function chatAnthropicRaw(
	ai: AiContext,
	prompt: string,
	images: ImagePayload[],
	signal?: AbortSignal,
): Promise<string> {
	const baseUrl = (ai.baseUrl || "https://api.anthropic.com").replace(
		/\/$/,
		"",
	);
	const modelId = (ai.model as { id?: string }).id ?? "";
	const content: unknown[] = images.map((img) => ({
		type: "image",
		source: { type: "base64", media_type: img.mediaType, data: img.data },
	}));
	content.push({ type: "text", text: prompt });

	const res = await fetch(`${baseUrl}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": ai.apiKey ?? "",
			authorization: `Bearer ${ai.apiKey ?? ""}`,
			...(ai.headers ?? {}),
		},
		body: JSON.stringify({
			model: modelId,
			max_tokens: 8192,
			messages: [{ role: "user", content }],
		}),
		signal: signal ?? null,
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(
			`anthropic vision request failed: ${res.status} ${body.slice(0, 300)}`,
		);
	}
	const data = (await res.json()) as {
		content?: Array<{ type: string; text?: string }>;
	};
	return (data.content ?? [])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

/** Extract the first JSON object/array from a model response. */
export function extractJson<T>(text: string): T | null {
	let s = text.trim();
	const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) s = fence[1].trim();

	// Fast path: the whole (de-fenced) reply is JSON.
	try {
		return JSON.parse(s) as T;
	} catch {
		// continue
	}

	// Slice from first opening bracket to its last matching close.
	const start = s.search(/[{[]/);
	if (start >= 0) {
		const open = s[start];
		const close = open === "{" ? "}" : "]";
		const end = s.lastIndexOf(close);
		if (end > start) {
			try {
				return JSON.parse(s.slice(start, end + 1)) as T;
			} catch {
				// continue
			}
		}
	}

	// NDJSON / multi-object fallback: collect flat {...} objects into an array.
	const objs: unknown[] = [];
	const re = /\{[^{}]*\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		try {
			objs.push(JSON.parse(m[0]));
		} catch {
			// skip unparseable fragment
		}
	}
	if (objs.length > 0) return objs as T;
	return null;
}

// ---------------------------------------------------------------------------
// Proofreading
// ---------------------------------------------------------------------------

export interface ProofreadResult {
	corrections: Correction[];
	/** Number of segment texts actually changed. */
	changedSegments: number;
	chunksProcessed: number;
}

const PROOFREAD_PROMPT = `You are proofreading an automatic speech recognition (ASR / whisper) transcript.
Find words or phrases that are very likely WRONG — typically:
- homophone mistakes (same pronunciation, wrong characters/words)
- misheard technical terms, product names, brand names, person names
- wrong Latin transcription of English words (e.g. "CODA" instead of "CUDA")

Rules:
- ONLY report errors you are highly confident about, using context as evidence.
- "wrong" must be an exact substring of the transcript lines below.
- Do NOT rewrite sentences, fix grammar, or change style.
- Do NOT report valid colloquial wording.
- If nothing is wrong, return an empty list.

Return ONLY valid JSON:
{"corrections": [{"wrong": "...", "correct": "...", "reason": "short reason"}]}

Transcript lines:
`;

export async function proofreadTranscript(
	ai: AiContext,
	segments: TranscriptSegment[],
	knownCorrections: Correction[],
	cfg: VideoSummaryConfig,
	log: (msg: string) => void,
	signal?: AbortSignal,
): Promise<ProofreadResult> {
	const result: ProofreadResult = {
		corrections: [],
		changedSegments: 0,
		chunksProcessed: 0,
	};
	if (segments.length === 0) return result;

	// Chunk segments by character budget.
	const chunks: TranscriptSegment[][] = [];
	let current: TranscriptSegment[] = [];
	let currentChars = 0;
	for (const seg of segments) {
		current.push(seg);
		currentChars += seg.text.length;
		if (currentChars >= cfg.proofread.chunkChars) {
			chunks.push(current);
			current = [];
			currentChars = 0;
		}
	}
	if (current.length > 0) chunks.push(current);

	const known = new Set(knownCorrections.map((c) => c.wrong));
	const allCorrections: Correction[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const lines = chunk.map((s) => `[#${s.id}] ${s.text}`).join("\n");
		if (lines.trim().length === 0) continue;

		log(
			`proofreading chunk ${i + 1}/${chunks.length} (${lines.length} chars)...`,
		);
		let parsed: { corrections?: Correction[] } | null = null;
		try {
			const reply = await chat(ai, PROOFREAD_PROMPT + lines, [], signal);
			parsed = extractJson<{ corrections?: Correction[] }>(reply);
		} catch (e) {
			log(
				`proofread chunk ${i + 1} failed: ${e instanceof Error ? e.message : e}`,
			);
			continue;
		}
		result.chunksProcessed++;

		const found = (parsed?.corrections ?? []).filter(
			(c) =>
				typeof c.wrong === "string" &&
				typeof c.correct === "string" &&
				c.wrong.trim().length >= 2 &&
				c.wrong !== c.correct &&
				!known.has(c.wrong),
		);
		allCorrections.push(...found);
	}

	// Apply corrections across the whole transcript.
	const changedSegs = new Set<number>();
	for (const c of allCorrections) {
		let used = false;
		for (const seg of segments) {
			if (seg.text.includes(c.wrong)) {
				seg.text = seg.text.split(c.wrong).join(c.correct);
				changedSegs.add(seg.id);
				used = true;
			}
		}
		if (used) result.corrections.push(c);
	}
	result.changedSegments = changedSegs.size;
	if (result.corrections.length > 0) {
		log(
			`proofread: fixed ${result.corrections.length} issue(s): ` +
				result.corrections.map((c) => `${c.wrong}→${c.correct}`).join(", "),
		);
	} else {
		log("proofread: no issues found");
	}
	return result;
}

// ---------------------------------------------------------------------------
// Vision pass
// ---------------------------------------------------------------------------

export interface FrameNote {
	t: number;
	scene: string;
	text: string;
	description: string;
}

const VISION_PROMPT = `These images are frames sampled from a video, in order.
For EACH frame, in the same order, return one JSON object:
{"i": <image index starting at 0>, "scene": "scene type, e.g. slides/talking-head/screen-recording/scenery",
 "text": "readable on-screen text (may be empty)", "description": "1-2 sentences: what is visible"}
Return ONLY a valid JSON array. No commentary.`;

export async function describeFrames(
	ai: AiContext,
	frames: SampledFrame[],
	cfg: VideoSummaryConfig,
	log: (msg: string) => void,
	signal?: AbortSignal,
): Promise<FrameNote[]> {
	const notes: FrameNote[] = [];
	const batchSize = Math.max(1, cfg.vision.batchSize);

	for (let start = 0; start < frames.length; start += batchSize) {
		const batch = frames.slice(start, start + batchSize);
		const images: ImagePayload[] = batch.map((f) => ({
			data: fileToBase64(f.path),
			mediaType: "image/jpeg",
		}));
		const listing = batch
			.map((f, i) => `image ${i}: timestamp ${f.t.toFixed(0)}s`)
			.join("\n");
		log(
			`vision: describing frames ${start + 1}-${start + batch.length}/${frames.length}...`,
		);
		try {
			const reply = await chat(
				ai,
				`${VISION_PROMPT}\n\n${listing}`,
				images,
				signal,
			);
			const parsed =
				extractJson<Array<Partial<FrameNote> & { i?: number }>>(reply) ?? [];
			if (parsed.length === 0) {
				log(
					`vision: reply not parseable as JSON (preview: ${reply.slice(0, 160).replace(/\n/g, " ")})`,
				);
			}
			for (const item of parsed) {
				const idx =
					typeof item.i === "number" ? item.i : notes.length % batchSize;
				const frame = batch[Math.min(Math.max(idx, 0), batch.length - 1)];
				notes.push({
					t: frame?.t ?? 0,
					scene: typeof item.scene === "string" ? item.scene : "",
					text: typeof item.text === "string" ? item.text : "",
					description:
						typeof item.description === "string" ? item.description : "",
				});
			}
		} catch (e) {
			log(`vision batch failed: ${e instanceof Error ? e.message : e}`);
		}
	}
	return notes.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------
// Structured summary
// ---------------------------------------------------------------------------

export interface SummaryChapter {
	startSec: number;
	title: string;
	summary: string;
	keyPoints: string[];
	imageTimestampSec: number | null;
	imageReason: string;
}

export interface SummaryQuote {
	text: string;
	timestampSec: number;
}

export interface SummaryJson {
	title: string;
	tldr: string;
	keywords: string[];
	chapters: SummaryChapter[];
	notableQuotes: SummaryQuote[];
	conclusion: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
	zh: "中文（简体）",
	en: "English",
	ja: "日本語",
	ko: "한국어",
	de: "Deutsch",
	fr: "Français",
	es: "Español",
};

export interface SummaryInput {
	sourceName: string;
	durationSec: number;
	transcriptLanguage: string;
	transcriptLines: string;
	frameNotes: FrameNote[];
	fmt: (sec: number) => string;
}

export async function generateSummary(
	ai: AiContext,
	input: SummaryInput,
	cfg: VideoSummaryConfig,
	signal?: AbortSignal,
): Promise<SummaryJson> {
	const langCode =
		cfg.summary.language !== "auto"
			? cfg.summary.language
			: input.transcriptLanguage;
	const langName = LANGUAGE_NAMES[langCode] ?? "the transcript's language";

	const transcript = truncateMiddle(
		input.transcriptLines,
		cfg.summary.maxTranscriptChars,
	);

	const visionSection =
		input.frameNotes.length > 0
			? `\nVisual notes from sampled frames:\n${input.frameNotes
					.map(
						(n) =>
							`[${input.fmt(n.t)}] (${n.scene}) ${n.text ? `on-screen text: "${n.text}". ` : ""}${n.description}`,
					)
					.join("\n")}\n`
			: "";

	const prompt = `You are writing a structured summary of a video, using its ASR transcript and visual notes.

Video: ${input.sourceName}
Duration: ${input.fmt(input.durationSec)}
Transcript language: ${input.transcriptLanguage}
${visionSection}
Transcript (timestamped lines):
${transcript}

Write the summary in ${langName}. Return ONLY valid JSON with this exact shape:
{
  "title": "concise video title",
  "tldr": "2-4 sentence overview",
  "keywords": ["3-8 keywords"],
  "chapters": [
    {
      "startSec": 0,
      "title": "chapter title",
      "summary": "what happens in this chapter (2-4 sentences)",
      "keyPoints": ["bullet", "..."],
      "imageTimestampSec": 12,
      "imageReason": "why this exact moment is visually representative"
    }
  ],
  "notableQuotes": [{"text": "verbatim quote from transcript", "timestampSec": 0}],
  "conclusion": "takeaways / conclusion (1-3 sentences)"
}

Requirements:
- 3-8 chapters covering the whole video; startSec values ascending, aligned to transcript timestamps.
- imageTimestampSec: pick the most visually informative moment INSIDE the chapter (must be >= startSec). Use null when no meaningful visual exists.
- notableQuotes: 0-5 short verbatim quotes, with their timestampSec.
- keyPoints: 2-5 concise bullets per chapter.
- All textual fields in ${langName}.`;

	const reply = await chat(ai, prompt, [], signal);
	const parsed = extractJson<Partial<SummaryJson>>(reply);
	return sanitizeSummary(parsed, input.durationSec);
}

function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function asStringArray(v: unknown): string[] {
	return Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string")
		: [];
}

function asSec(v: unknown): number | null {
	const n = typeof v === "string" ? Number.parseFloat(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n >= 0
		? Math.round(n)
		: null;
}

export function sanitizeSummary(
	raw: Partial<SummaryJson> | null,
	durationSec: number,
): SummaryJson {
	const chapters: SummaryChapter[] = Array.isArray(raw?.chapters)
		? raw!.chapters
				.map((c): SummaryChapter | null => {
					if (!c || typeof c !== "object") return null;
					const start = asSec((c as SummaryChapter).startSec) ?? 0;
					const img = asSec((c as SummaryChapter).imageTimestampSec);
					return {
						startSec: start,
						title: asString((c as SummaryChapter).title, "章节"),
						summary: asString((c as SummaryChapter).summary),
						keyPoints: asStringArray((c as SummaryChapter).keyPoints),
						imageTimestampSec: img !== null && img >= start ? img : null,
						imageReason: asString((c as SummaryChapter).imageReason),
					};
				})
				.filter((c): c is SummaryChapter => c !== null)
				.sort((a, b) => a.startSec - b.startSec)
		: [];

	const quotes: SummaryQuote[] = Array.isArray(raw?.notableQuotes)
		? raw!.notableQuotes
				.map((q): SummaryQuote | null => {
					if (!q || typeof q !== "object") return null;
					const text = asString((q as SummaryQuote).text);
					if (!text) return null;
					return {
						text,
						timestampSec: asSec((q as SummaryQuote).timestampSec) ?? 0,
					};
				})
				.filter((q): q is SummaryQuote => q !== null)
		: [];

	return {
		title: asString(raw?.title, "视频总结"),
		tldr: asString(raw?.tldr),
		keywords: asStringArray(raw?.keywords),
		chapters:
			chapters.length > 0
				? chapters
				: [
						{
							startSec: 0,
							title: "完整视频",
							summary: asString(raw?.tldr),
							keyPoints: [],
							imageTimestampSec:
								durationSec > 2 ? Math.floor(durationSec / 2) : null,
							imageReason: "",
						},
					],
		notableQuotes: quotes,
		conclusion: asString(raw?.conclusion),
	};
}
