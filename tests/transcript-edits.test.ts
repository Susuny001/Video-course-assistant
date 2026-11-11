import test from "node:test";
import assert from "node:assert/strict";
import { applyTranscriptEdits } from "../server/transcript-edits.ts";
import type { Course } from "../src/types.ts";
const course = (text: string): Course => ({
  id: "c",
  title: "课程",
  createdAt: "",
  updatedAt: "",
  language: "zh",
  keywords: [],
  documents: [],
  chapters: [],
  timing: "exact",
  cues: [{ id: "s", start: 10, end: 30, text }],
});
test("language edits repair exact source spans while retaining raw ASR evidence", () => {
  const input = course("头晕的轮廓线画清楚，像视图也需要标注。");
  const out = applyTranscriptEdits(input, [
    {
      cueId: "s",
      find: "头晕",
      replace: "投影",
      reason: "制图上下文的同音术语",
    },
    { cueId: "s", find: "像视图", replace: "向视图", reason: "术语候选" },
  ]);
  assert.equal(
    out.course.cues[0].correctedText,
    "投影的轮廓线画清楚，向视图也需要标注。",
  );
  assert.equal(out.course.cues[0].text, input.cues[0].text);
  assert.equal(input.cues[0].correctedText, undefined);
  assert.equal(out.applied.length, 2);
});
test("numeric, negation and exam-period changes become review candidates instead of silent corrections", () => {
  const input = course("没有期末考试，考试是30分。");
  const out = applyTranscriptEdits(input, [
    { cueId: "s", find: "期末", replace: "期中", reason: "上下文疑似口误" },
    { cueId: "s", find: "30分", replace: "70分", reason: "另一模型如此识别" },
  ]);
  assert.equal(out.course.cues[0].correctedText, undefined);
  assert.equal(out.audit.length, 1);
  assert.equal(out.audit[0].status, "open");
  assert.equal(out.audit[0].proposedText, "没有期中考试，考试是70分。");
  assert.equal(out.audit[0].correctedText, undefined);
  assert.equal(out.applied.length, 0);
});
test("equivalent spoken-number formatting is permitted but unsupported or ambiguous spans are rejected", () => {
  const input = course("三十分填空，图层与图层。");
  const out = applyTranscriptEdits(input, [
    { cueId: "s", find: "三十分", replace: "30分", reason: "等价数字格式" },
    { cueId: "s", find: "图层", replace: "涂层", reason: "未提供位置" },
    {
      cueId: "s",
      find: "不存在的原句",
      replace: "模型自己写的句子",
      reason: "没有来源",
    },
  ]);
  assert.equal(out.course.cues[0].correctedText, "30分填空，图层与图层。");
  assert.equal(out.rejected.length, 2);
  assert.equal(out.audit.length, 0);
});
test("conflicting overlapping edits are rejected and explicit occurrence edits stay at the requested span", () => {
  const input = course("图层与图层。");
  const out = applyTranscriptEdits(input, [
    {
      cueId: "s",
      find: "图层",
      replace: "涂层",
      reason: "候选",
      occurrence: 1,
    },
    { cueId: "s", find: "与图层", replace: "和图层", reason: "重叠修改" },
  ]);
  assert.equal(out.course.cues[0].correctedText, "图层与涂层。");
  assert.equal(out.rejected.length, 1);
});
