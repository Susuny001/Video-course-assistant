#!/usr/bin/env python3
"""Install a free local Chinese LLM from digest-verified official OCI/GitHub artifacts.

No account, API key, Docker daemon or GPU is required. Range requests adapt large
artifacts to bounded downloads; the complete OCI SHA256 is always verified.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "ai/qwen2.5"
MODEL_TAG = "3B-Q4_K_M"
MANIFEST_SHA256 = "41045df49cc0d72a4f8c15eb6b21464d3e6f4dc2899fe8ccd9e5b72bdf4d0bf9"
MODEL_SHA256 = "48f4925de3417c3e259c5b460024ec9907458c52c9a7aab81269a4befd473e5e"
MODEL_SIZE = 1_929_903_008
MODEL_FILENAME = "qwen2.5-3b-instruct-q4_k_m.gguf"
RUNTIME_TAG = "b8730"
RUNTIMES = {
    ("Linux", "x86_64"): ("llama-b8730-bin-ubuntu-x64.tar.gz", "3305ed459b7c261400dc780fc8ce3bd64559a9f9de69bcf9788a2f7e92300ab3"),
    ("Windows", "AMD64"): ("llama-b8730-bin-win-cpu-x64.zip", "5768d7e1d330015a7ebb496df0428b59fc8dfc17978a95ec912d5505c2510239"),
    ("Darwin", "arm64"): ("llama-b8730-bin-macos-arm64.tar.gz", "63ecb61067ffd3d34d0ed66cc4fef0307c0ce50deb4b67255ed2c6157f4b9011"),
    ("Darwin", "x86_64"): ("llama-b8730-bin-macos-x64.tar.gz", "63ee21519824ade7a91196c93a5dd8d009cfb079bb5b925b01477f510b9d530e"),
}
TLS = ssl.create_default_context()


def digest(filename: Path) -> str:
    with filename.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def request(url: str, headers: dict | None = None, timeout: int = 90):
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), context=TLS, timeout=timeout)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def registry_context() -> tuple[str, bytes]:
    # Anonymous token is scoped only to the public official model repository.
    with request("https://auth.docker.io/token?service=registry.docker.io&scope=repository:" + REPOSITORY + ":pull") as response:
        token = json.load(response)["token"]
    with request("https://registry-1.docker.io/v2/" + REPOSITORY + "/manifests/" + MODEL_TAG, {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.oci.image.manifest.v1+json",
    }) as response:
        manifest = response.read()
    if hashlib.sha256(manifest).hexdigest() != MANIFEST_SHA256:
        raise RuntimeError("官方模型 manifest 与固定 SHA256 不符，未使用变化后的模型。")
    parsed = json.loads(manifest)
    if not any(layer.get("digest") == "sha256:" + MODEL_SHA256 and layer.get("size") == MODEL_SIZE for layer in parsed["layers"]):
        raise RuntimeError("OCI manifest 缺少经过校验的 GGUF 层。")
    return token, manifest


def registry_download_url(token: str, sha256: str) -> str:
    url = "https://registry-1.docker.io/v2/" + REPOSITORY + "/blobs/sha256:" + sha256
    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=TLS))
    try:
        with opener.open(urllib.request.Request(url, headers={"Authorization": "Bearer " + token}), timeout=30):
            return url
    except urllib.error.HTTPError as exc:
        if exc.code not in (301, 302, 303, 307, 308):
            raise
        # Do not forward the registry token to its signed official CDN location.
        return exc.headers["Location"]


def download_model(root: Path, workers: int) -> None:
    target = root / MODEL_FILENAME
    if target.is_file() and target.stat().st_size == MODEL_SIZE and digest(target) == MODEL_SHA256:
        print("Verified existing local model", flush=True)
        return
    token, manifest = registry_context()
    (root / "oci-manifest.json").write_bytes(manifest)
    url = registry_download_url(token, MODEL_SHA256)
    temporary = target.with_suffix(".gguf.partial")
    start = temporary.stat().st_size if temporary.exists() else 0
    if start > MODEL_SIZE:
        temporary.unlink()
        start = 0
    chunk_size = 32 * 1024 * 1024
    ranges = [(offset, min(MODEL_SIZE - 1, offset + chunk_size - 1)) for offset in range(start, MODEL_SIZE, chunk_size)]
    cache = root / "chunks"
    cache.mkdir(exist_ok=True)

    def fetch_chunk(bounds: tuple[int, int]) -> Path:
        begin, end = bounds
        filename = cache / f"{begin}-{end}.part"
        expected = end - begin + 1
        if filename.exists() and filename.stat().st_size == expected:
            return filename
        for attempt in range(5):
            try:
                with request(url, {"Range": f"bytes={begin}-{end}"}) as response:
                    if response.status != 206 or not response.headers.get("Content-Range", "").startswith(f"bytes {begin}-"):
                        raise RuntimeError("模型分段下载未返回正确的 HTTP Range。")
                    with filename.open("wb") as output:
                        shutil.copyfileobj(response, output, 1024 * 1024)
                if filename.stat().st_size != expected:
                    raise RuntimeError("模型分段下载不完整。")
                return filename
            except urllib.error.HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504) or attempt == 4:
                    raise
                delay = int(exc.headers.get("Retry-After", "0") or "0")
                time.sleep(max(delay, 2 ** attempt))
            except (OSError, TimeoutError):
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError("模型分段下载失败。")

    with ThreadPoolExecutor(max_workers=workers) as executor, temporary.open("ab") as output:
        for filename in executor.map(fetch_chunk, ranges):
            with filename.open("rb") as source:
                shutil.copyfileobj(source, output, 1024 * 1024)
            output.flush()
            filename.unlink()
            print(f"Model download {temporary.stat().st_size}/{MODEL_SIZE} bytes", flush=True)
    if temporary.stat().st_size != MODEL_SIZE or digest(temporary) != MODEL_SHA256:
        raise RuntimeError("模型完整 SHA256 校验失败，未启用该文件。")
    os.replace(temporary, target)
    # Retain the official model license as delivered by the OCI publisher.
    parsed = json.loads(manifest)
    license_layer = next(layer for layer in parsed["layers"] if layer["mediaType"] == "application/vnd.docker.ai.license")
    with request(registry_download_url(token, license_layer["digest"].split(":", 1)[1])) as response:
        license_bytes = response.read(100_000)
    if hashlib.sha256(license_bytes).hexdigest() != license_layer["digest"].split(":", 1)[1]:
        raise RuntimeError("模型许可文件校验失败。")
    (root / "MODEL-LICENSE.txt").write_bytes(license_bytes)
    (root / "model-manifest.json").write_text(json.dumps({"model": "qwen2.5-3b-instruct", "source": f"docker.io/{REPOSITORY}:{MODEL_TAG}", "manifestSha256": MANIFEST_SHA256, "sha256": MODEL_SHA256, "bytes": MODEL_SIZE}, indent=2) + "\n")


def install_runtime(root: Path) -> None:
    key = (platform.system(), platform.machine())
    if key not in RUNTIMES:
        raise RuntimeError(f"暂未内置此系统的模型运行时：{key}；可设置 LOCAL_MODEL_BINARY 使用自行安装的 llama-server。")
    name, expected = RUNTIMES[key]
    archive = root / name
    if not archive.exists() or digest(archive) != expected:
        temporary = archive.with_suffix(archive.suffix + ".download")
        try:
            with request(f"https://github.com/ggml-org/llama.cpp/releases/download/{RUNTIME_TAG}/{name}") as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
            if digest(temporary) != expected:
                raise RuntimeError("官方 llama.cpp 运行时 SHA256 校验失败。")
            os.replace(temporary, archive)
        finally:
            temporary.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="local-model-runtime-") as directory:
        unpack = Path(directory)
        if name.endswith(".zip"):
            with zipfile.ZipFile(archive) as bundle:
                for member in bundle.infolist():
                    relative = Path(member.filename)
                    if relative.is_absolute() or ".." in relative.parts:
                        raise RuntimeError("运行时压缩包包含无效路径。")
                bundle.extractall(unpack)
        else:
            with tarfile.open(archive) as bundle:
                bundle.extractall(unpack, filter="data")
        binary_name = "llama-server.exe" if os.name == "nt" else "llama-server"
        matches = list(unpack.rglob(binary_name))
        if len(matches) != 1:
            raise RuntimeError("官方运行时包未包含唯一的 llama-server。")
        for link in matches[0].parent.rglob("*"):
            if link.is_symlink() and not link.resolve().is_relative_to(unpack):
                raise RuntimeError("运行时包包含越界链接。")
        destination = root / "runtime"
        # copytree cannot replace an already installed symlink on repeat runs.
        for source in matches[0].parent.rglob("*"):
            if source.is_symlink():
                target = destination / source.relative_to(matches[0].parent)
                if target.is_symlink():
                    target.unlink()
        shutil.copytree(matches[0].parent, destination, dirs_exist_ok=True, symlinks=True)
    binary = root / "runtime" / binary_name
    if os.name != "nt":
        binary.chmod(binary.stat().st_mode | 0o111)
    subprocess.run([str(binary), "--version"], check=True, timeout=30, capture_output=True)


def check(root: Path) -> None:
    weights = root / MODEL_FILENAME
    binary = root / "runtime" / ("llama-server.exe" if os.name == "nt" else "llama-server")
    if not weights.is_file() or weights.stat().st_size != MODEL_SIZE or digest(weights) != MODEL_SHA256:
        raise RuntimeError("本地模型缺失或 SHA256 不符。")
    subprocess.run([str(binary), "--version"], check=True, timeout=30, capture_output=True)
    print(json.dumps({"installed": True, "model": "qwen2.5-3b-instruct", "runtime": RUNTIME_TAG, "sha256": MODEL_SHA256}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "local-model")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--runtime-only", action="store_true")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        raise RuntimeError("本地模型安装需要 Python 3.11+。")
    if not 1 <= args.workers <= 4:
        raise RuntimeError("模型下载并行数必须为 1 到 4。")
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    if args.check:
        check(root)
        return
    install_runtime(root)
    if args.runtime_only:
        print("Verified local model runtime")
        return
    download_model(root, args.workers)
    check(root)
    print("本机中文模型安装完成；应用启动时自动连接，无需 API Key。", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"本地模型安装失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
