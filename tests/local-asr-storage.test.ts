import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLocalRecognition } from "../server/local-asr.ts";
import type { Course } from "../src/types.ts";
const course = (): Course => ({
  id: "test",
  title: "原始录音",
  createdAt: "",
  updatedAt: "",
  language: "zh",
  keywords: ["考试"],
  media: { url: "/media/test.mp3", name: "test.mp3", type: "audio/mpeg" },
  documents: [
    {
      id: "original",
      name: "参考稿.md",
      type: "md",
      text: "参考原文，不能充当识别输出",
    },
  ],
  cues: [{ id: "old", start: 0, end: 60, text: "旧版估算文字稿" }],
  chapters: [],
  timing: "estimated",
});
const speech = {
  duration: 12,
  language: "zh",
  model: "test-speech-model",
  segments: [
    { start: 1, end: 4, text: "这是来自识别结果的句子。" },
    { start: 6, end: 11, text: "新的音频片段。" },
  ],
};
test("full local ASR uses only audio decoder output and preserves imported sources and old subtitles", () => {
  const input = course(),
    original = structuredClone(input);
  const result = applyLocalRecognition(input, speech);
  assert.deepEqual(input, original);
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues[0].text, speech.segments[0].text);
  assert.equal(result.cues[0].start, 1);
  assert.equal(result.media?.duration, 12);
  assert.equal(result.timing, "exact");
  assert.equal(result.documents[0].text, original.documents[0].text);
  assert.ok(
    result.documents.some(
      (d) => d.type === "json" && d.text.includes("旧版估算文字稿"),
    ),
  );
});
test("partial local ASR rejects uncertain or mid-subtitle boundaries rather than deleting outside speech", () => {
  assert.throws(
    () =>
      applyLocalRecognition(
        course(),
        { ...speech, segments: [{ start: 6, end: 11, text: "选段" }] },
        5,
        12,
      ),
    /估算/,
  );
  const exact = {
    ...course(),
    timing: "exact" as const,
    cues: [{ id: "old", start: 0, end: 8, text: "横跨边界" }],
  };
  assert.throws(
    () =>
      applyLocalRecognition(
        exact,
        { ...speech, segments: [{ start: 6, end: 11, text: "选段" }] },
        5,
        12,
      ),
    /边界/,
  );
});
test("invalid or empty decoder timestamps never become valid subtitle evidence", () => {
  assert.throws(
    () => applyLocalRecognition(course(), { ...speech, segments: [] }),
    /没有识别/,
  );
  assert.throws(
    () =>
      applyLocalRecognition(course(), {
        ...speech,
        segments: [{ start: 1, end: 14, text: "越界" }],
      }),
    /无效片段/,
  );
  assert.throws(
    () =>
      applyLocalRecognition(course(), {
        ...speech,
        segments: [{ start: NaN, end: 5, text: "坏时间" }],
      }),
    /无效片段/,
  );
});
