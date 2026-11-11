# 本机语音识别

此流程在 CPU 上运行 SenseVoice int8 和 Silero VAD，不需要第三方 API Key，也不把录音发往云端。首次安装会下载约 156 MiB 的官方模型，解压后模型约 229 MiB。建议 Python 3.12（最低 3.11）、FFmpeg/ffprobe、4 个 CPU 线程和至少 2 GiB 空闲内存。

从仓库目录运行：

```sh
python3 scripts/setup-local-asr.py
```

Windows 使用已安装的 Python 3.11/3.12 执行同一脚本。环境、缓存和模型安装在忽略的 `data/local-asr/` 中；不要把用户录音或模型副本提交到 Git。安装脚本使用固定版本的 PyPI 包，以及 sherpa-onnx 官方 GitHub release 的 SenseVoice/Silero 资产，并校验该 release 公布的 SHA256。保持 TLS 校验和系统 CA 信任。模型与分段算法详情见 [官方发布页](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models)。

独立验证模型是否能够加载：

```sh
data/local-asr/venv/bin/python scripts/local-transcribe.py --model-dir data/local-asr/model --check
```

识别真实音频文件，输出 JSON（Windows 将 Python 路径改为 `data/local-asr/venv/Scripts/python.exe`）：

```sh
data/local-asr/venv/bin/python scripts/local-transcribe.py \
  --audio /absolute/path/to/lecture.mp3 \
  --model-dir data/local-asr/model \
  --output data/local-asr/lecture.json \
  --threads 4
```

可加 `--start 30 --end 120`，返回的字幕时间仍是原录音的绝对时间。`--language` 支持 auto、zh、en、ja、ko、yue，默认自动识别。JSON 包含 `segments: [{start,end,text}]`、源文件 SHA256、完整媒体时长、模型和识别耗时；标准错误按行输出 `{progress: "..."}` 或 `{error: "..."}`，用于后台任务进度。

时间点来自音频中的 VAD 语音边界，并保留至多 250 毫秒的真实前文音频以避免吃掉开头辅音；不会与前一段重叠。它属于真实音频分段时间，不是逐词强制对齐。模型可能识错人名、口音、专业词，需保留原录音并校对。静音不会为了产生字幕而被替换成文字稿内容；该脚本没有任何读取参考文字稿的入口。

本环境已用模型官方随包 `test_wavs/zh.wav` 的真实普通话语音完成识别验证；它不是用户上传的课程录音。只有实际识别用户音频之后，才能声称其课程转录已完成。
