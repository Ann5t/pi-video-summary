import type { SummaryJson } from "./ai.js";
import type { TranscriptSegment } from "./transcribe.js";
import { escapeHtml, fmtTime } from "./util.js";

export interface ChapterImage {
	/** data:image/jpeg;base64,... URI */
	dataUri: string;
	t: number;
	caption: string;
}

export interface ReportData {
	title: string;
	sourceName: string;
	source: string;
	generatedAt: Date;
	durationSec: number;
	language: string;
	whisperModel: string;
	whisperDevice: string;
	llmModel: string;
	summary: SummaryJson;
	/** chapter index -> image */
	chapterImages: Map<number, ChapterImage>;
	transcript: TranscriptSegment[];
	correctionsApplied: Array<{ wrong: string; correct: string }>;
}

const CSS = `
:root { --accent:#4f6ef7; --accent2:#7c3aed; --ink:#1f2430; --muted:#6b7280; --bg:#f4f6fb; --card:#ffffff; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink);
  font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", Roboto, sans-serif;
  line-height:1.75; }
.wrap { max-width: 880px; margin: 0 auto; padding: 0 20px 64px; }
header.hero { background: linear-gradient(135deg, #1e2a78, var(--accent) 55%, var(--accent2));
  color:#fff; padding: 56px 0 40px; margin-bottom: 32px; }
header.hero .wrap { padding-bottom: 0; }
header.hero h1 { margin:0 0 14px; font-size: 30px; line-height:1.35; }
.meta { display:flex; flex-wrap:wrap; gap:8px; font-size:13px; opacity:.92; }
.meta span { background:rgba(255,255,255,.16); padding:2px 10px; border-radius:999px; }
.card { background:var(--card); border-radius:14px; padding:22px 26px; margin:0 0 22px;
  box-shadow:0 1px 3px rgba(20,30,60,.08); }
.tldr { border-left:4px solid var(--accent); font-size:16.5px; }
.tldr .label, .label { font-size:12px; letter-spacing:.12em; color:var(--accent); font-weight:700; text-transform:uppercase; }
.keywords { margin-top:10px; }
.keywords span { display:inline-block; background:#eef1fe; color:#3b4fd8; border-radius:999px;
  padding:2px 12px; font-size:13px; margin:3px 6px 0 0; }
.toc ol { margin:8px 0 0; padding-left:22px; }
.toc a { color:var(--ink); text-decoration:none; }
.toc a:hover { color:var(--accent); }
.badge { display:inline-block; min-width:52px; text-align:center; background:#eef1fe; color:#3b4fd8;
  border-radius:8px; font-size:13px; font-weight:600; padding:1px 8px; margin-right:8px;
  font-variant-numeric:tabular-nums; }
h2.chapter { font-size:21px; margin:0 0 10px; }
ul.points { margin:8px 0 0; padding-left:22px; }
ul.points li { margin:4px 0; }
figure { margin:18px 0 4px; }
figure img { width:100%; border-radius:10px; box-shadow:0 2px 10px rgba(20,30,60,.12); }
figcaption { font-size:13px; color:var(--muted); margin-top:6px; }
blockquote { margin:10px 0; padding:10px 18px; border-left:3px solid var(--accent2);
  background:#faf7ff; border-radius:0 10px 10px 0; color:#3d3452; }
blockquote .qt { font-size:12px; color:var(--muted); }
details transcript { display:block; }
details summary { cursor:pointer; font-weight:600; }
.seg { display:flex; gap:12px; font-size:14px; padding:3px 0; border-bottom:1px dashed #eee; }
.seg .ts { flex:0 0 62px; color:var(--muted); font-variant-numeric:tabular-nums; }
footer { text-align:center; color:var(--muted); font-size:12.5px; margin-top:36px; }
.fixes { font-size:13px; color:var(--muted); }
.fixes code { background:#f0f0f5; border-radius:6px; padding:1px 6px; }
a.src { color:#cdd6ff; word-break:break-all; }
`;

function metaChip(text: string): string {
	return `<span>${escapeHtml(text)}</span>`;
}

export function renderReport(data: ReportData): string {
	const s = data.summary;
	const esc = escapeHtml;
	const chips = [
		fmtTime(data.durationSec),
		`语言 ${data.language}`,
		`whisper ${data.whisperModel} · ${data.whisperDevice}`,
		`LLM ${data.llmModel}`,
		data.generatedAt.toLocaleString("zh-CN", { hour12: false }),
	]
		.map(metaChip)
		.join("\n      ");

	const keywords =
		s.keywords.length > 0
			? `<div class="keywords">${s.keywords.map((k) => `<span>${esc(k)}</span>`).join("")}</div>`
			: "";

	const toc =
		s.chapters.length > 1
			? `<div class="card toc"><div class="label">目录 · Contents</div><ol>
${s.chapters
	.map(
		(c, i) =>
			`  <li><a href="#ch${i}"><span class="badge">${fmtTime(c.startSec)}</span>${esc(c.title)}</a></li>`,
	)
	.join("\n")}
</ol></div>`
			: "";

	const chapters = s.chapters
		.map((c, i) => {
			const img = data.chapterImages.get(i);
			const figure = img
				? `<figure><img loading="lazy" src="${img.dataUri}" alt="${esc(c.title)}">
<figcaption>📷 ${fmtTime(img.t)} — ${esc(img.caption || c.title)}</figcaption></figure>`
				: "";
			const points =
				c.keyPoints.length > 0
					? `<ul class="points">${c.keyPoints.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
					: "";
			return `<div class="card" id="ch${i}">
<h2 class="chapter"><span class="badge">${fmtTime(c.startSec)}</span>${esc(c.title)}</h2>
<p>${esc(c.summary)}</p>
${points}
${figure}
</div>`;
		})
		.join("\n");

	const quotes =
		s.notableQuotes.length > 0
			? `<div class="card"><div class="label">金句 · Quotes</div>
${s.notableQuotes
	.map(
		(q) =>
			`<blockquote>${esc(q.text)}<div class="qt">— ${fmtTime(q.timestampSec)}</div></blockquote>`,
	)
	.join("\n")}
</div>`
			: "";

	const conclusion = s.conclusion
		? `<div class="card"><div class="label">总结 · Conclusion</div><p>${esc(s.conclusion)}</p></div>`
		: "";

	const fixes =
		data.correctionsApplied.length > 0
			? `<p class="fixes">AI 校对修正：${data.correctionsApplied
					.map((c) => `<code>${esc(c.wrong)} → ${esc(c.correct)}</code>`)
					.join("、")}</p>`
			: "";

	const transcriptRows = data.transcript
		.map(
			(seg) =>
				`<div class="seg"><span class="ts">${fmtTime(seg.start)}</span><span>${esc(seg.text)}</span></div>`,
		)
		.join("\n");

	return `<!DOCTYPE html>
<html lang="${data.language === "zh" ? "zh-CN" : escapeHtml(data.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title)} · 视频总结</title>
<style>${CSS}</style>
</head>
<body>
<header class="hero"><div class="wrap">
  <h1>${esc(s.title)}</h1>
  <div class="meta">
      ${chips}
  </div>
  <div class="meta" style="margin-top:8px"><span style="background:rgba(255,255,255,.10)"><a class="src" href="${esc(data.source)}">${esc(data.sourceName)}</a></span></div>
</div></header>
<div class="wrap">
<div class="card tldr"><div class="label">TL;DR</div><p>${esc(s.tldr)}</p>${keywords}</div>
${toc}
${chapters}
${quotes}
${conclusion}
<div class="card">
<details><summary>完整文稿 · Full transcript（${data.transcript.length} 段）</summary>
${transcriptRows}
</details>
${fixes}
</div>
<footer>Generated by pi video-summary · whisper(${esc(data.whisperModel)} @ ${esc(data.whisperDevice)}) + ${esc(data.llmModel)}<br>${esc(data.generatedAt.toISOString())}</footer>
</div>
</body>
</html>
`;
}
