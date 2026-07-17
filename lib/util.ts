import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface RunOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Called for each stderr line as it arrives (progress parsing). */
	onStderrLine?: (line: string) => void;
}

/** Run a command, capturing output. Throws on non-zero exit. */
export function run(
	cmd: string,
	args: string[],
	opts: RunOptions = {},
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			env: opts.env ?? process.env,
			cwd: opts.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let stderrBuf = "";
		let timedOut = false;

		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, opts.timeoutMs)
			: undefined;

		const onAbort = () => {
			child.kill("SIGKILL");
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			const text = d.toString();
			stderr += text;
			if (opts.onStderrLine) {
				stderrBuf += text;
				let idx: number;
				while ((idx = stderrBuf.indexOf("\n")) >= 0) {
					const line = stderrBuf.slice(0, idx).trim();
					stderrBuf = stderrBuf.slice(idx + 1);
					if (line) opts.onStderrLine(line);
				}
			}
		});

		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			reject(new Error(`Failed to start ${cmd}: ${err.message}`));
		});

		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			const result: RunResult = { stdout, stderr, code: code ?? -1 };
			if (timedOut) {
				reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
			} else if (opts.signal?.aborted) {
				reject(new Error(`${cmd} aborted`));
			} else if (result.code !== 0) {
				const tail = stderr.trim().split("\n").slice(-6).join("\n");
				reject(new Error(`${cmd} exited with code ${result.code}:\n${tail}`));
			} else {
				resolve(result);
			}
		});
	});
}

export function sha1(input: string): string {
	return createHash("sha1").update(input).digest("hex");
}

/** 123.4 -> "2:03", 3723.4 -> "1:02:03" */
export function fmtTime(totalSec: number): string {
	const sec = Math.max(0, Math.round(totalSec));
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.6);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n\n[... 中间 ${text.length - head - tail} 字省略 / middle truncated ...]\n\n${text.slice(text.length - tail)}`;
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
