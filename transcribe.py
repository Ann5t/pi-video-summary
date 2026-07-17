#!/usr/bin/env python3
"""faster-whisper transcription wrapper for the pi video-summary extension.

Pure-local transcription with GPU (CUDA) acceleration and automatic CPU fallback.
Outputs a JSON transcript with segment/word timestamps and confidence scores
(avg_logprob per segment) so downstream AI proofreading can focus on
low-confidence regions.

Usage:
  python transcribe.py --input audio.wav --out transcript.json [options]

The JSON schema written to --out:
{
  "language": "zh", "languageProbability": 0.98, "duration": 123.4,
  "model": "large-v3-turbo", "deviceUsed": "cuda", "computeTypeUsed": "float16",
  "segments": [{"id":0,"start":0.0,"end":5.2,"text":"...",
                "avgLogprob":-0.21,"noSpeechProb":0.03,
                "words":[{"start":0.0,"end":0.4,"word":"...","probability":0.91}]}]
}
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any


def log(msg: str) -> None:
    print(f"[transcribe] {msg}", file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Transcribe audio/video with faster-whisper")
    p.add_argument("--input", required=True, help="Audio (wav 16k mono) or video file")
    p.add_argument("--out", required=True, help="Output JSON path")
    p.add_argument("--model", default="large-v3-turbo", help="Whisper model name or path")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--compute-type", default="auto",
                   help="auto|float16|float32|int8|int8_float16|int8_bfloat16|bfloat16")
    p.add_argument("--language", default="auto", help="Language code or 'auto'")
    p.add_argument("--beam-size", type=int, default=5)
    p.add_argument("--vad", type=int, default=1, help="1=enable silero VAD filter")
    p.add_argument("--batched", type=int, default=1, help="1=use BatchedInferencePipeline on CUDA")
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--word-timestamps", type=int, default=1)
    p.add_argument("--download-root", default=None, help="Model cache directory")
    p.add_argument("--initial-prompt", default=None,
                   help="Bias transcription (e.g. known terms from dictionary)")
    return p.parse_args()


def resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import ctranslate2
        return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    except Exception:
        return "cpu"


def resolve_compute(requested: str, device: str) -> str:
    if requested != "auto":
        return requested
    return "float16" if device == "cuda" else "int8"


def build_model(model_name: str, device: str, compute: str, download_root):
    from faster_whisper import WhisperModel
    return WhisperModel(
        model_name,
        device=device,
        compute_type=compute,
        download_root=download_root,
    )


def run_transcribe(model, args, language, batched_ok: bool):
    from faster_whisper import BatchedInferencePipeline

    lang = None if language == "auto" else language
    common: dict[str, Any] = dict(
        beam_size=args.beam_size,
        word_timestamps=bool(args.word_timestamps),
        vad_filter=bool(args.vad),
        vad_parameters=dict(min_silence_duration_ms=500),
        initial_prompt=args.initial_prompt,
        condition_on_previous_text=True,
    )
    if batched_ok:
        pipe = BatchedInferencePipeline(model=model)
        return pipe.transcribe(args.input, batch_size=args.batch_size, language=lang, **common)
    return model.transcribe(args.input, language=lang, **common)


def collect_segments(segments_iter, word_timestamps: bool) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for seg in segments_iter:
        entry: dict[str, Any] = {
            "id": seg.id,
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text.strip(),
            "avgLogprob": round(seg.avg_logprob, 4) if seg.avg_logprob is not None else None,
            "noSpeechProb": round(seg.no_speech_prob, 4) if seg.no_speech_prob is not None else None,
        }
        if word_timestamps and seg.words:
            entry["words"] = [
                {
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "word": w.word,
                    "probability": round(w.probability, 4) if w.probability is not None else None,
                }
                for w in seg.words
            ]
        segments.append(entry)
        if seg.id % 20 == 0:
            log(f"  segment {seg.id} @ {seg.end:.1f}s")
    return segments


def main() -> int:
    args = parse_args()
    t_start = time.time()

    device = resolve_device(args.device)
    compute = resolve_compute(args.compute_type, device)
    log(f"loading model={args.model} device={device} compute={compute}")

    try:
        model = build_model(args.model, device, compute, args.download_root)
        device_used, compute_used = device, compute
    except Exception as e:  # CUDA init failure -> CPU fallback
        if device == "cpu":
            raise
        log(f"GPU init failed ({e}); falling back to cpu/int8")
        device_used, compute_used = "cpu", "int8"
        model = build_model(args.model, device_used, compute_used, args.download_root)

    batched_ok = bool(args.batched) and device_used == "cuda"
    log(f"transcribing (batched={batched_ok}) ...")
    try:
        segments_iter, info = run_transcribe(model, args, args.language, batched_ok)
        segments = collect_segments(segments_iter, bool(args.word_timestamps))
    except Exception as e:
        if device_used == "cpu":
            raise
        log(f"GPU transcription failed ({e}); retrying on cpu/int8")
        device_used, compute_used = "cpu", "int8"
        model = build_model(args.model, device_used, compute_used, args.download_root)
        segments_iter, info = run_transcribe(model, args, args.language, False)
        segments = collect_segments(segments_iter, bool(args.word_timestamps))

    # Silero VAD can filter out ALL of a music-heavy video. Retry without VAD.
    # NOTE: BatchedInferencePipeline requires VAD chunking, so drop batched too.
    vad_retried = False
    if len(segments) == 0 and args.vad and (getattr(info, "duration", 0) or 0) > 1:
        log("VAD filtered out everything (music/silence?); retrying without VAD (non-batched)")
        args.vad = 0
        vad_retried = True
        segments_iter, info = run_transcribe(model, args, args.language, False)
        segments = collect_segments(segments_iter, bool(args.word_timestamps))

    result = {
        "language": info.language,
        "languageProbability": round(info.language_probability, 4),
        "duration": round(info.duration, 3),
        "model": args.model,
        "deviceUsed": device_used,
        "computeTypeUsed": compute_used,
        "vadRetried": vad_retried,
        "segments": segments,
    }
    try:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
    except OSError as e:
        log(f"ERROR: cannot write output file {args.out}: {e}")
        return 1

    elapsed = time.time() - t_start
    dur = result["duration"] or 0
    speed = (dur / elapsed) if elapsed > 0 else 0
    log(f"done: {len(segments)} segments, {dur:.1f}s audio in {elapsed:.1f}s "
        f"({speed:.1f}x realtime) on {device_used}/{compute_used}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
