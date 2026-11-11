#!/usr/bin/env python3
"""Install verified multilingual Whisper-turbo for a third reading of disputed audio."""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile

ARCHIVE_NAME = "sherpa-onnx-whisper-turbo.tar.bz2"
# Published by the official release's checksum.txt, not computed to accept arbitrary bytes.
ARCHIVE_SHA256 = "b11acbbcd660b44a8e0df33724feb5aaa709cf65668f2823d59f656312544f22"
SOURCE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/" + ARCHIVE_NAME
DIGEST_SOURCE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/checksum.txt"


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=project / "data/local-asr/whisper")
    parser.add_argument("--local-root", type=Path, default=project / "data/local-asr")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("shared_verified_downloads", Path(__file__).with_name("setup-local-asr.py"))
    shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shared)
    local_root, root = args.local_root.resolve(), args.root.resolve()
    python = local_root / ("venv/Scripts/python.exe" if os.name == "nt" else "venv/bin/python")
    vad = local_root / "model/silero_vad.onnx"
    if not python.is_file() or not vad.is_file() or shared.digest(vad) != shared.VAD_SHA256:
        raise RuntimeError("请先完成共享本地语音环境安装（python scripts/setup-local-asr.py）。")
    archive = root / "downloads/model-turbo.tar.bz2"
    shared.download(SOURCE, archive, ARCHIVE_SHA256, 700 * 1024 * 1024)
    model_dir = root / "model"
    model_dir.mkdir(parents=True, exist_ok=True)
    wanted = {"turbo-encoder.int8.onnx", "turbo-decoder.int8.onnx", "turbo-tokens.txt", "LICENSE", "README.md"}
    found = set()
    with tarfile.open(archive, "r:bz2") as bundle:
        for member in bundle:
            parts = PurePosixPath(member.name).parts
            if len(parts) < 2:
                continue
            relative = PurePosixPath(*parts[1:])
            name = str(relative)
            if name not in wanted:
                continue
            if not member.isfile() or relative.is_absolute() or ".." in relative.parts or member.size > 700 * 1024 * 1024:
                raise RuntimeError("第三声学模型包包含无效文件。")
            destination = model_dir / name
            temporary = None
            try:
                with bundle.extractfile(member) as source, tempfile.NamedTemporaryFile(dir=model_dir, delete=False) as output:
                    temporary = Path(output.name)
                    shutil.copyfileobj(source, output)
                os.replace(temporary, destination)
            finally:
                if temporary:
                    temporary.unlink(missing_ok=True)
            found.add(name)
    required = {"turbo-encoder.int8.onnx", "turbo-decoder.int8.onnx", "turbo-tokens.txt"}
    if not required <= found:
        raise RuntimeError(f"第三声学模型包缺少必需文件：{sorted(required-found)}")
    shutil.copy2(vad, model_dir / "silero_vad.onnx")
    manifest = {"model": ARCHIVE_NAME, "source": SOURCE, "publishedDigestSource": DIGEST_SOURCE, "archiveSha256": ARCHIVE_SHA256, "memberSha256": {name: shared.digest(model_dir / name) for name in sorted(required)}, "independentAcousticModel": True, "sharedVad": True}
    previous_manifest = model_dir / "manifest.json"
    if previous_manifest.is_file() and not (model_dir / "manifest-small.json").exists():
        previous = json.loads(previous_manifest.read_text(encoding="utf-8"))
        if previous.get("model") == "sherpa-onnx-whisper-small.tar.bz2":
            shutil.copy2(previous_manifest, model_dir / "manifest-small.json")
    (model_dir / "manifest-turbo.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    subprocess.run([str(python), str(project / "scripts/critical-transcribe.py"), "--model-dir", str(model_dir), "--threads", "2", "--check"], check=True)
    print("Third acoustic verifier ready; reference text is not a decoder input.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"第三声学复核安装失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
