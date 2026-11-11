#!/usr/bin/env python3
"""Decode local speech with SenseVoice int8 + Silero VAD. Never reads a reference transcript.

CLI JSON is written atomically to --output. Progress/error events are JSON lines on
stderr. Segment times are absolute source-audio speech boundaries, not word-level
forced alignment. --check actually loads the model and voice activity detector.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import wave

MODEL_NAME = "sensevoice-int8-2024-07-17"
SAMPLE_RATE = 16000


def event(**value: object) -> None:
    print(json.dumps(value, ensure_ascii=False), file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--end", type=float)
    parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--language", choices=["auto", "zh", "en", "ja", "ko", "yue"], default="auto")
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def load_models(args: argparse.Namespace):
    try:
        import numpy as np
        import sherpa_onnx
    except ImportError as exc:
        raise RuntimeError("缺少本地语音依赖，请先运行 python scripts/setup-local-asr.py。") from exc
    model_dir = args.model_dir.resolve()
    for name in ["model.int8.onnx", "tokens.txt", "silero_vad.onnx"]:
        if not (model_dir / name).is_file():
            raise RuntimeError(f"缺少本地模型文件 {name}，请先运行 scripts/setup-local-asr.py。")
    if not 1 <= args.threads <= 32:
        raise ValueError("线程数必须为 1 到 32。")
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model_dir / "model.int8.onnx"),
        tokens=str(model_dir / "tokens.txt"),
        num_threads=args.threads,
        use_itn=True,
        language=args.language,
        provider="cpu",
        debug=False,
    )
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(model_dir / "silero_vad.onnx")
    config.silero_vad.threshold = 0.5
    config.silero_vad.min_silence_duration = 0.45
    config.silero_vad.min_speech_duration = 0.2
    config.silero_vad.max_speech_duration = 25.0
    config.sample_rate = SAMPLE_RATE
    config.num_threads = 1
    vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=120)
    return np, recognizer, vad


def run_tool(command: list[str]) -> str:
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True, timeout=300).stdout
    except FileNotFoundError as exc:
        raise RuntimeError("找不到 FFmpeg/ffprobe，请先安装 FFmpeg 并加入 PATH。") from exc
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("音频解码失败或超时，请检查媒体文件和 FFmpeg。") from exc


def source_duration(audio: Path) -> float:
    output = run_tool(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(audio)])
    try:
        duration = float(output.strip())
    except ValueError as exc:
        raise ValueError("媒体没有有效的音频时长。") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("媒体没有有效的音频时长。")
    return duration


def write_output(filename: Path, result: dict) -> None:
    filename = filename.resolve()
    filename.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=filename.parent, delete=False, prefix=".asr-", suffix=".tmp") as stream:
            temporary = Path(stream.name)
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, filename)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def main() -> int:
    args = parse_args()
    event(progress="正在加载本地语音模型（CPU，无需 API Key）")
    np, recognizer, vad = load_models(args)
    if args.check:
        print(json.dumps({"ready": True, "model": MODEL_NAME, "vad": "silero", "language": args.language}))
        return 0
    if not args.audio or not args.output:
        raise ValueError("转录需要 --audio 和 --output；检测环境可使用 --check。")
    audio = args.audio.resolve()
    if not audio.is_file():
        raise ValueError("本地录音文件不存在。")
    output = args.output.resolve()
    if output == audio:
        raise ValueError("输出文件不能覆盖原始音视频。")
    duration = source_duration(audio)
    start = args.start
    end = min(args.end if args.end is not None else duration, duration)
    if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
        raise ValueError("转录起止时间无效，结束时间必须晚于开始时间。")
    if end - start > 8 * 3600:
        raise ValueError("一次本地转录最多处理 8 小时，请分段提交。")
    begin = time.monotonic()
    event(progress="正在解码录音并检测真实语音片段")
    segments = []
    language_counts: dict[str, int] = {}
    with tempfile.TemporaryDirectory(prefix="course-local-asr-") as directory:
        pcm = Path(directory) / "audio.wav"
        run_tool(["ffmpeg", "-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-ss", str(start), "-i", str(audio), "-t", str(end-start), "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(pcm)])

        last_segment_end = 0

        def drain() -> None:
            nonlocal last_segment_end
            while not vad.empty():
                speech = vad.front
                detected_start = speech.start
                end_frame = min(context_wav.getnframes(), detected_start + len(speech.samples))
                # VAD can clip an initial consonant. Add actual source context, bounded by
                # the previous segment so long-speech split points never overlap.
                start_frame = max(0, last_segment_end, detected_start - int(0.25 * SAMPLE_RATE))
                if end_frame <= start_frame:
                    vad.pop()
                    continue
                context_wav.setpos(start_frame)
                samples = np.frombuffer(context_wav.readframes(end_frame-start_frame), dtype="<i2").astype(np.float32) / 32768.0
                speech_start = start + start_frame / SAMPLE_RATE
                speech_end = min(end, start + end_frame / SAMPLE_RATE)
                last_segment_end = end_frame
                vad.pop()
                if speech_end <= speech_start:
                    continue
                stream = recognizer.create_stream()
                stream.accept_waveform(SAMPLE_RATE, samples)
                recognizer.decode_stream(stream)
                text = re.sub(r"<\|[^|]+\|>", "", stream.result.text).strip()
                if not text:
                    continue
                language = getattr(stream.result, "lang", "") or getattr(stream.result, "language", "")
                if isinstance(language, str) and language:
                    language = language.removeprefix("<|").removesuffix("|>")
                    language_counts[language] = language_counts.get(language, 0) + 1
                segments.append({"start": round(speech_start, 3), "end": round(speech_end, 3), "text": text})
                event(progress=f"已识别 {len(segments)} 段，录音进度 {min(100, round((speech_end-start)/(end-start)*100))}%（{speech_end:.1f}/{end:.1f} 秒）")

        with wave.open(str(pcm), "rb") as wav, wave.open(str(pcm), "rb") as context_wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != SAMPLE_RATE:
                raise RuntimeError("解码后的音频格式无效。")
            while data := wav.readframes(512):
                samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
                if len(samples) < 512:
                    samples = np.pad(samples, (0, 512-len(samples)))
                vad.accept_waveform(samples)
                drain()
            vad.flush()
            drain()
    # Hash actual audio bytes for provenance. This never hashes or reads a reference transcript.
    with audio.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    result = {"segments": segments, "language": max(language_counts, key=language_counts.get) if language_counts else args.language, "model": MODEL_NAME, "duration": duration, "start": start, "end": end, "timing": "vad-speech-boundaries-with-250ms-source-context", "sourceSha256": digest, "elapsedSeconds": round(time.monotonic()-begin, 3)}
    write_output(output, result)
    print(json.dumps({"ok": True, "segments": len(segments), "model": MODEL_NAME, "duration": duration, "output": str(output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        event(error=f"{type(exc).__name__}: {exc}")
        raise SystemExit(1)
