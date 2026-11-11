import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
const exec = promisify(execFile);
const root = path.resolve(".");
const model =
  process.env.LOCAL_ASR_MODEL_DIR || path.join(root, "data/local-asr/model");
const python =
  process.env.LOCAL_ASR_PYTHON ||
  path.join(
    root,
    "data/local-asr/venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
const fixture = path.join(model, "test_wavs/zh.wav");
const script = path.join(root, "scripts/local-transcribe.py");
const available =
  existsSync(python) &&
  existsSync(fixture) &&
  existsSync(path.join(model, "model.int8.onnx"));
const skip = available
  ? false
  : "Optional real local-ASR assets are absent; run python scripts/setup-local-asr.py first.";
interface Output {
  segments: { start: number; end: number; text: string }[];
  duration: number;
  sourceSha256: string;
  language: string;
  model: string;
  start: number;
  end: number;
}
async function decode(input: string, extra: string[] = []): Promise<Output> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "local-python-asr-test-"),
  );
  try {
    const output = path.join(directory, "result.json");
    await exec(
      python,
      [
        script,
        "--audio",
        input,
        "--model-dir",
        model,
        "--output",
        output,
        "--threads",
        "2",
        ...extra,
      ],
      { timeout: 60_000 },
    );
    return JSON.parse(await readFile(output, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test(
  "real local model decodes the official Mandarin speech recording without API mocks or reference text",
  { skip },
  async () => {
    const source = await readFile(fixture);
    const output = await decode(fixture);
    assert.equal(
      output.sourceSha256,
      createHash("sha256").update(source).digest("hex"),
    );
    assert.deepEqual(await readFile(fixture), source);
    assert.equal(output.language, "zh");
    assert.equal(output.model, "sensevoice-int8-2024-07-17");
    assert.ok(output.segments.length > 0);
    // The official sample says 开放时间. Source-context padding prevents the VAD's
    // clipped initial consonant from changing this into 派放 in our actual model.
    assert.match(
      output.segments.map((s) => s.text).join(""),
      /开放时间.*9点.*5点/,
    );
    for (const [i, segment] of output.segments.entries()) {
      assert.ok(
        segment.start >= 0 &&
          segment.end > segment.start &&
          segment.end <= output.duration,
      );
      if (i > 0) assert.ok(segment.start >= output.segments[i - 1].end);
    }
  },
);

test(
  "real local-ASR selected-range output retains absolute source time and the full original duration",
  { skip },
  async () => {
    const output = await decode(fixture, ["--start", "0.4", "--end", "5.4"]);
    assert.equal(output.start, 0.4);
    assert.equal(output.end, 5.4);
    assert.ok(Math.abs(output.duration - 5.592) < 0.02);
    assert.ok(output.segments.length > 0);
    for (const segment of output.segments) {
      assert.ok(segment.start >= 0.4);
      assert.ok(segment.end <= 5.4);
    }
  },
);

test(
  "actual local voice detector leaves silent audio empty instead of inventing recognized text",
  { skip },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "local-asr-silence-"));
    try {
      const audio = path.join(directory, "silence.wav");
      await exec("ffmpeg", [
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=16000:cl=mono",
        "-t",
        "2",
        audio,
      ]);
      const output = await decode(audio);
      assert.deepEqual(output.segments, []);
      assert.equal(output.duration, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
