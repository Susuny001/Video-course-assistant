#!/usr/bin/env python3
"""Third acoustic reading for disputed Chinese audio using multilingual Whisper.

The CLI accepts actual audio and a selected time range only. It does not accept
reference prose, candidate names, expected numbers, or an initial text prompt.
"""
from __future__ import annotations
import importlib.util
from pathlib import Path
import sys

MODEL_NAME = "whisper-multilingual-int8"

def model_files(model_dir):
    for prefix in ["turbo", "small"]:
        names = [f"{prefix}-encoder.int8.onnx", f"{prefix}-decoder.int8.onnx", f"{prefix}-tokens.txt"]
        if all((model_dir / name).is_file() for name in names):
            return names, f"whisper-{prefix}-multilingual-int8"
    raise RuntimeError("缺少完整的 Whisper 多语言量化模型，请运行 python scripts/setup-critical-asr.py。")


def load_models(args):
    import numpy as np
    import sherpa_onnx
    model_dir = args.model_dir.resolve()
    if args.language not in {"auto", "zh"}:
        raise ValueError("此复读流程用于中文课堂，请使用 --language zh 或 auto。")
    args.language = "zh"
    files, _ = model_files(model_dir)
    required = files + ["silero_vad.onnx"]
    for name in required:
        if not (model_dir / name).is_file():
            raise RuntimeError(f"第三声学模型缺少 {name}，请运行 python scripts/setup-critical-asr.py。")
    if not 1 <= args.threads <= 32:
        raise ValueError("线程数必须为 1 到 32。")
    actual_recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=str(model_dir / files[0]),
        decoder=str(model_dir / files[1]),
        tokens=str(model_dir / files[2]),
        language="zh", task="transcribe", num_threads=args.threads,
        provider="cpu", debug=False,
    )
    # Whisper's encoder covers at most 30 s. VAD may occasionally emit longer
    # turns, so never silently pass a >30 s turn to the acoustic decoder.
    from types import SimpleNamespace
    class BufferedStream:
        def __init__(self):
            self.samples = None
            self.result = SimpleNamespace(text="", language="zh")
        def accept_waveform(self, sample_rate, samples):
            if sample_rate != 16000:
                raise ValueError("Whisper 输入需为 16 kHz。")
            self.samples = np.asarray(samples, dtype=np.float32)
    class BoundedWhisper:
        def create_stream(self):
            return BufferedStream()
        def decode_stream(self, stream):
            texts = []
            window = 27 * 16000
            for offset in range(0, len(stream.samples), window):
                actual = actual_recognizer.create_stream()
                actual.accept_waveform(16000, stream.samples[offset:offset+window])
                actual_recognizer.decode_stream(actual)
                texts.append(actual.result.text.strip())
            stream.result.text = "".join(texts)
    recognizer = BoundedWhisper()
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
    spec = importlib.util.spec_from_file_location("course_shared_audio_decoder", Path(__file__).with_name("local-transcribe.py"))
    shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shared)
    args = shared.parse_args()
    _, actual_model_name = model_files(args.model_dir.resolve())
    shared.MODEL_NAME = actual_model_name
    shared.parse_args = lambda: args
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
