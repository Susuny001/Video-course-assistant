#!/usr/bin/env python3
"""Install the pinned, CPU-only local speech recognizer from PyPI and official release assets."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import venv

ARCHIVE_NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2"
BASE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
ARCHIVE_SHA256 = "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e"
VAD_SHA256 = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"
# SHA256 values are published by the official GitHub release, not derived to accept downloaded data.
RELEASE_PAGE = "https://github.com/k2-fsa/sherpa-onnx/releases/expanded_assets/asr-models"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url: str, path: Path, expected: str, limit: int) -> None:
    if path.is_file() and digest(path) == expected:
        print(f"Verified cached {path.name}", flush=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".download")
    temporary.unlink(missing_ok=True)
    try:
        # Keep system/injected CA trust and inherited proxy routing; do not disable TLS validation.
        context = ssl.create_default_context()
        size = 0
        with urllib.request.urlopen(url, context=context, timeout=60) as response, temporary.open("wb") as output:
            while block := response.read(1024 * 1024):
                size += len(block)
                if size > limit:
                    raise RuntimeError("模型下载超过预期大小，已停止。")
                output.write(block)
        if digest(temporary) != expected:
            raise RuntimeError("模型 SHA256 校验失败，未使用该文件。")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def extract_model(archive: Path, model_dir: Path) -> None:
    wanted = {"model.int8.onnx", "tokens.txt", "LICENSE", *("test_wavs/" + name + ".wav" for name in ["zh", "en", "ja", "ko", "yue"])}
    found = set()
    model_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:bz2") as bundle:
        for member in bundle:
            parts = PurePosixPath(member.name).parts
            if len(parts) < 2:
                continue
            relative = PurePosixPath(*parts[1:])
            if str(relative) not in wanted:
                continue
            if not member.isfile() or relative.is_absolute() or ".." in relative.parts or member.size > 300 * 1024 * 1024:
                raise RuntimeError("模型包包含无效文件，已停止解包。")
            destination = model_dir.joinpath(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as output:
                temporary = Path(output.name)
                shutil.copyfileobj(source, output)
            os.replace(temporary, destination)
            found.add(str(relative))
    if not {"model.int8.onnx", "tokens.txt"} <= found:
        raise RuntimeError("模型包缺少必需文件。")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "local-asr")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        raise RuntimeError("本地语音安装需要 Python 3.11+，推荐 Python 3.12。")
    root = args.root.resolve()
    downloads = root / "downloads"
    model_dir = root / "model"
    env_dir = root / "venv"
    env_python = env_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not env_python.is_file():
        venv.EnvBuilder(with_pip=True).create(env_dir)
    project = Path(__file__).resolve().parents[1]
    print("Installing pinned local ASR dependencies (CPU-only)…", flush=True)
    subprocess.run([str(env_python), "-m", "pip", "install", "--cache-dir", str(root / "pip-cache"), "-r", str(project / "scripts" / "local-asr-requirements.txt")], check=True)
    archive = downloads / "sensevoice-int8.tar.bz2"
    vad = downloads / "silero_vad.onnx"
    print("Downloading official SenseVoice model (~156 MiB) and VAD; validating published SHA256…", flush=True)
    download(BASE_URL + ARCHIVE_NAME, archive, ARCHIVE_SHA256, 200 * 1024 * 1024)
    download(BASE_URL + "silero_vad.onnx", vad, VAD_SHA256, 4 * 1024 * 1024)
    extract_model(archive, model_dir)
    shutil.copy2(vad, model_dir / "silero_vad.onnx")
    manifest = {"model": ARCHIVE_NAME, "source": BASE_URL + ARCHIVE_NAME, "publishedDigestSource": RELEASE_PAGE, "archiveSha256": ARCHIVE_SHA256, "vadSha256": VAD_SHA256, "modelFileSha256": digest(model_dir / "model.int8.onnx")}
    (model_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    subprocess.run([str(env_python), str(project / "scripts" / "local-transcribe.py"), "--model-dir", str(model_dir), "--check"], check=True)
    print("Local ASR ready. No audio was uploaded to a third-party service.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"本地语音安装失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
