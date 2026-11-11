#!/usr/bin/env python3
"""Install the independently trained Chinese Paraformer acoustic verifier.

Uses only the official sherpa-onnx model release and its published digest. The
primary local ASR installer must be run first to provide Python dependencies/VAD.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ARCHIVE_NAME = "sherpa-onnx-paraformer-zh-int8-2025-10-07.tar.bz2"
ARCHIVE_SHA256 = "a071ee5419e14adb34d7f970ab98105a45e6608018b168f023ca2e4810744abe"
SOURCE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/" + ARCHIVE_NAME
DIGEST_SOURCE = "https://github.com/k2-fsa/sherpa-onnx/releases/expanded_assets/asr-models"


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=project / "data/local-asr/paraformer")
    parser.add_argument("--local-root", type=Path, default=project / "data/local-asr")
    args = parser.parse_args()
    shared_spec = importlib.util.spec_from_file_location("shared_verified_downloads", Path(__file__).with_name("setup-local-asr.py"))
    shared = importlib.util.module_from_spec(shared_spec)
    shared_spec.loader.exec_module(shared)
    local_root = args.local_root.resolve()
    python = local_root / ("venv/Scripts/python.exe" if os.name == "nt" else "venv/bin/python")
    vad = local_root / "model/silero_vad.onnx"
    if not python.is_file() or not vad.is_file():
        raise RuntimeError("请先运行 python scripts/setup-local-asr.py，安装共享本地语音环境。")
    if shared.digest(vad) != shared.VAD_SHA256:
        raise RuntimeError("共享 VAD 的 SHA256 校验失败，请重新运行本地语音安装脚本。")
    root = args.root.resolve()
    archive = root / "downloads/model.tar.bz2"
    shared.download(SOURCE, archive, ARCHIVE_SHA256, 300 * 1024 * 1024)
    model_dir = root / "model"
    model_dir.mkdir(parents=True, exist_ok=True)
    found = set()
    with tarfile.open(archive, "r:bz2") as bundle:
        for member in bundle:
            parts = PurePosixPath(member.name).parts
            if len(parts) < 2:
                continue
            relative = PurePosixPath(*parts[1:])
            name = str(relative)
            if name not in {"model.int8.onnx", "tokens.txt", "LICENSE", "README.md"} and not re.fullmatch(r"test_wavs/\d+\.wav", name):
                continue
            if not member.isfile() or relative.is_absolute() or ".." in relative.parts or member.size > 400 * 1024 * 1024:
                raise RuntimeError("独立模型包包含无效文件，已停止。")
            destination = model_dir.joinpath(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with bundle.extractfile(member) as source, tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
                    temporary = Path(output.name)
                    shutil.copyfileobj(source, output)
                os.replace(temporary, destination)
            finally:
                if temporary:
                    temporary.unlink(missing_ok=True)
            found.add(name)
    if not {"model.int8.onnx", "tokens.txt"} <= found:
        raise RuntimeError("独立声学模型包缺少必需文件。")
    shutil.copy2(vad, model_dir / "silero_vad.onnx")
    manifest = {"model": ARCHIVE_NAME, "source": SOURCE, "publishedDigestSource": DIGEST_SOURCE, "archiveSha256": ARCHIVE_SHA256, "modelFileSha256": shared.digest(model_dir / "model.int8.onnx"), "independentAcousticModel": True, "sharedVad": True}
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    subprocess.run([str(python), str(project / "scripts/independent-transcribe.py"), "--model-dir", str(model_dir), "--threads", "2", "--check"], check=True)
    print("Independent Chinese acoustic verifier ready; no API key required.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"独立语音复核安装失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
