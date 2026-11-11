import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Course, Cue } from "../src/types.ts";
import { chaptersFromCues, selectCues } from "./processing.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localRoot = path.join(root, "data", "local-asr");
function locations() {
  return {
    python:
      process.env.LOCAL_ASR_PYTHON ||
      path.join(
        localRoot,
        "venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      ),
    model: path.resolve(
      process.env.LOCAL_ASR_MODEL_DIR || path.join(localRoot, "model"),
    ),
    script: path.join(root, "scripts", "local-transcribe.py"),
  };
}
const problem = (message: string, status = 400) =>
  Object.assign(new Error(message), { status });
export interface LocalAsrResult {
  segments: { start: number; end: number; text: string }[];
  language: string;
  model: string;
  duration: number;
}
export interface LocalAsrStatus {
  ready: boolean;
  engine: "SenseVoice";
  message: string;
}
const execFileAsync = promisify(execFile);
let checked: { key: string; at: number } | undefined;
export async function localAsrStatus(): Promise<LocalAsrStatus> {
  const { python, model, script } = locations();
  try {
    await Promise.all([
      access(python),
      access(script),
      access(path.join(model, "model.int8.onnx")),
      access(path.join(model, "tokens.txt")),
    ]);
  } catch {
    return {
      ready: false,
      engine: "SenseVoice",
      message:
        "本地中文识别尚未安装。运行 python scripts/setup-local-asr.py 后即可无需 API Key 转录。",
    };
  }
  const key = python + "|" + model;
  if (checked?.key !== key || Date.now() - checked.at > 60000) {
    try {
      await execFileAsync(python, [script, "--model-dir", model, "--check"], {
        timeout: 30000,
        maxBuffer: 10000,
      });
      checked = { key, at: Date.now() };
    } catch {
      return {
        ready: false,
        engine: "SenseVoice",
        message:
          "本地识别依赖检查未通过，请重新运行 python scripts/setup-local-asr.py。",
      };
    }
  }
  return {
    ready: true,
    engine: "SenseVoice",
    message: "本地中文语音识别已安装，录音在本机处理，无需 API Key。",
  };
}
export function applyLocalRecognition(
  course: Course,
  result: LocalAsrResult,
  start = 0,
  end = result.duration,
): Course {
  selectCues(course, start, end);
  if (
    !Number.isFinite(result.duration) ||
    result.duration <= 0 ||
    !Array.isArray(result.segments) ||
    !result.segments.length
  )
    throw problem("本地语音模型没有识别到有效文字，原文字稿未替换。", 422);
  if (!Number.isFinite(end) || start >= Math.min(end, result.duration))
    throw problem("选段超出录音范围。");
  const to = Math.min(end, result.duration),
    full = start === 0 && to >= result.duration;
  if (!full && course.cues.length) {
    if (course.timing !== "exact")
      throw problem(
        "当前字幕使用估算时间。请取消选段，先完整转录录音，避免误覆盖选段外原文。",
      );
    if (
      course.cues.some(
        (c) =>
          (c.start < start && c.end > start) || (c.start < to && c.end > to),
      )
    )
      throw problem("选段边界位于一条字幕中间，请勾选完整字幕再转录。");
  }
  let previous = -1;
  const cues: Cue[] = result.segments.map((s) => {
    if (
      !Number.isFinite(s.start) ||
      !Number.isFinite(s.end) ||
      s.start < start ||
      s.start < previous ||
      s.end <= s.start ||
      s.end > to + 0.05 ||
      typeof s.text !== "string" ||
      !s.text.trim()
    )
      throw problem("本地识别返回了无效片段，原始文字稿未替换。", 422);
    previous = s.start;
    return {
      id: randomUUID(),
      start: s.start,
      end: Math.min(s.end, to),
      text: s.text.trim(),
    };
  });
  const original = structuredClone(course);
  // Keep previous imported documents and the previous subtitle track as independent source evidence.
  if (original.cues.length)
    original.documents.push({
      id: randomUUID(),
      name: "转录前字幕备份.json",
      type: "json",
      text: JSON.stringify(original.cues, null, 2),
    });
  const retained = full
    ? []
    : original.cues.filter((c) => c.end <= start || c.start >= to);
  const merged = [...retained, ...cues].sort((a, b) => a.start - b.start);
  return {
    ...original,
    cues: merged,
    chapters: chaptersFromCues(merged),
    timing: "exact",
    media: original.media
      ? { ...original.media, duration: result.duration }
      : undefined,
  };
}
async function audioHash(filename: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest("hex");
}
export async function runLocalRecognition(
  course: Course,
  options: {
    mediaPath?: string;
    start?: number;
    end?: number;
    onProgress?: (s: string) => void;
    evidenceOnly?: boolean;
  },
): Promise<Course> {
  const ready = await localAsrStatus();
  if (!ready.ready) throw problem(ready.message);
  if (!options.mediaPath) throw problem("请先导入录音或视频，再开始本地识别。");
  const { python, model, script } = locations();
  const directory = await mkdtemp(path.join(tmpdir(), "course-local-asr-"));
  const output = path.join(directory, "result.json");
  try {
    const args = [
      script,
      "--audio",
      options.mediaPath,
      "--model-dir",
      model,
      "--output",
      output,
      "--threads",
      "4",
    ];
    if (options.start !== undefined)
      args.push("--start", String(options.start));
    if (options.end !== undefined) args.push("--end", String(options.end));
    options.onProgress?.("正在启动本地语音模型，录音不会上传到外部服务");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(python, args, {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let tail = "",
        buffer = "";
      const timer = setTimeout(
        () => {
          child.kill("SIGTERM");
          reject(problem("本地识别超过 4 小时，请缩小处理范围后再试。", 408));
        },
        4 * 3600 * 1000,
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-4000);
        buffer = (buffer + chunk).slice(-16000);
        let pos: number;
        while ((pos = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, pos);
          buffer = buffer.slice(pos + 1);
          try {
            const p = JSON.parse(line);
            if (typeof p.progress === "string")
              options.onProgress?.(p.progress.slice(0, 300));
          } catch {
            /* Native runtime diagnostic lines are not classroom output. */
          }
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(problem("本地识别进程未能启动，请重新运行本地识别安装脚本。"));
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          let detail = "";
          for (const line of tail.split("\n").reverse()) {
            try {
              const p = JSON.parse(line);
              if (typeof p.error === "string") {
                detail = p.error.slice(0, 500);
                break;
              }
            } catch {}
          }
          reject(
            problem(
              detail || `本地识别未完成（${signal || code}），原始资料保留。`,
              422,
            ),
          );
        }
      });
    });
    const result: LocalAsrResult = JSON.parse(await readFile(output, "utf8"));
    const updated = applyLocalRecognition(
      options.evidenceOnly ? { ...course, cues: [], chapters: [] } : course,
      result,
      options.start,
      options.end,
    );
    if (options.evidenceOnly) return updated;
    updated.documents.push({
      id: randomUUID(),
      name: "本地语音识别记录.json",
      type: "json",
      text: JSON.stringify(
        {
          engine: "SenseVoice",
          model: result.model,
          source: "actual audio bytes",
          sha256: await audioHash(options.mediaPath),
          processedAt: new Date().toISOString(),
          range: {
            start: options.start ?? 0,
            end: options.end ?? result.duration,
          },
          timestampBasis: "音频切片/语音活动分段边界，未做逐字强制对齐",
          result,
        },
        null,
        2,
      ),
    });
    return updated;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
