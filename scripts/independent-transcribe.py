#!/usr/bin/env python3
"""Independent Chinese acoustic re-recognition with Paraformer, never the reference transcript.

Uses the same audio decoding and VAD-boundary implementation as local-transcribe.py,
but a separately trained and separately verified acoustic model. Sharing VAD does
not make the acoustic models independent segmentation validators.
"""
from __future__ import annotations
import importlib.util
from pathlib import Path
import sys

MODEL_NAME = "paraformer-zh-int8-2025-10-07"


def load_models(args):
    import numpy as np
    import sherpa_onnx
    model_dir = args.model_dir.resolve()
    for name in ["model.int8.onnx", "tokens.txt", "silero_vad.onnx"]:
        if not (model_dir / name).is_file():
            raise RuntimeError(f"独立复核模型缺少 {name}，请运行 python scripts/setup-independent-asr.py。")
    if args.language not in {"auto", "zh"}:
        raise ValueError("此独立声学复核模型支持中文，请使用 --language zh 或 auto。")
    if not 1 <= args.threads <= 32:
        raise ValueError("线程数必须为 1 到 32。")
    args.language = "zh"
    recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
        paraformer=str(model_dir / "model.int8.onnx"),
        tokens=str(model_dir / "tokens.txt"),
        num_threads=args.threads,
        provider="cpu",
        debug=False,
    )
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(model_dir / "silero_vad.onnx")
    config.silero_vad.threshold = 0.5
    config.silero_vad.min_silence_duration = 0.45
    config.silero_vad.min_speech_duration = 0.2
    config.silero_vad.max_speech_duration = 25.0
    config.sample_rate = 16000
    config.num_threads = 1
    return np, recognizer, sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=120)


def main() -> int:
    source = Path(__file__).with_name("local-transcribe.py")
    spec = importlib.util.spec_from_file_location("course_shared_audio_decoder", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("缺少本地音频解码模块 local-transcribe.py。")
    shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shared)
    shared.MODEL_NAME = MODEL_NAME
    shared.load_models = load_models
    shared.__doc__ = __doc__
    return shared.main()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        import json
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False), file=sys.stderr, flush=True)
        raise SystemExit(1)
