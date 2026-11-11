# 独立声学复核与关键片段复读

主识别使用 SenseVoice；独立识别使用另一套训练得到的中文 Paraformer 声学模型；高风险片段可再交给多语言 Whisper-turbo。三套解码器均直接读取本地音频，不把参考文稿、候选姓名或预期数字作为识别提示。

## 安装与实际检查

先完成共享环境，再安装独立声学模型。安装器验证官方发布的 SHA-256，不关闭 TLS 验证。

```sh
python scripts/setup-local-asr.py
python scripts/setup-independent-asr.py
# 可选第三声学模型，主要复读否定词、作业题号、考试分值和姓名争议
python scripts/setup-critical-asr.py
```

共享 Python 在 `data/local-asr/venv`，Paraformer 模型在 `data/local-asr/paraformer/model`，Whisper 在 `data/local-asr/whisper/model`。这些目录保留在本机，不提交到 Git。

```sh
data/local-asr/venv/bin/python scripts/independent-transcribe.py --model-dir data/local-asr/paraformer/model --threads 2 --check
data/local-asr/venv/bin/python scripts/critical-transcribe.py --model-dir data/local-asr/whisper/model --threads 2 --check
```

Windows 使用 `data\local-asr\venv\Scripts\python.exe`。`--check` 实际载入模型，不只检查路径是否存在。

## 保留两份原始识别结果

```sh
data/local-asr/venv/bin/python scripts/local-transcribe.py --audio lesson.mp3 --model-dir data/local-asr/model --output data/raw-primary.json --threads 2
data/local-asr/venv/bin/python scripts/independent-transcribe.py --audio lesson.mp3 --model-dir data/local-asr/paraformer/model --output data/raw-independent.json --threads 2
python scripts/compare-transcripts.py --primary data/raw-primary.json --secondary data/raw-independent.json --output data/acoustic-audit.json --keywords 作业,期末,开卷,下节课,提醒
```

输出带实际音频 SHA-256、所用声学模型、音频全长以及分段的原音频绝对秒数。比较器按时间重叠排列分歧，不静默替换任一模型的文字。数字矛盾、某模型漏识或涉及用户重点的分歧被排为高优先级。

## 对高风险片段第三次复读

```sh
data/local-asr/venv/bin/python scripts/critical-transcribe.py --audio lesson.mp3 --model-dir data/local-asr/whisper/model --start 290 --end 367 --output data/critical-reread.json --threads 2
```

选段秒数仍指原录音位置。Whisper 解码器每次最多接收 27 秒音频，避免它的 30 秒编码窗口截掉长发言。长发言的全部样本都会按顺序解码，但切分点仍可能影响词语识别；输出时间戳是整段 VAD 边界，不能把它描述成逐字强制对齐。安装器默认安装 turbo；若已有完整 small 模型而无 turbo，解码器会保留 small 兼容性并在输出 `model` 中如实标明。

第三个模型仍需检查实际识别质量。若输出出现大量重复、遗漏或无声段幻觉，应保留原始结果并将其列为不可靠读数，不能把模型数量当作内容已经正确的证据。

两个或三个模型说法一致，也可能共同听错，或遇到讲者口误。`acoustic-agreement` 不是“人工已核实”。尤其是姓名字形，单凭同音音频不一定能够确定。审查仍须结合实际片段、同堂前后文，以及确有提供的课件证据；不能因为参考稿写了某个字就倒填成识别结果。

主识别与独立识别共享 VAD，所以它们**不是相互独立的语音覆盖率审计**。此比较器明确保存这个限制。对低信息背景、课间谈话和姓名通知，必须继续检查；不得整段将课间录音丢弃，因为通知可能在课间发生。
