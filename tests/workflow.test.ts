import test from "node:test";
import assert from "node:assert/strict";
import type { Course } from "../src/types.ts";
import {
  buildStudyReport,
  compareRecognitions,
  renderStudyReport,
} from "../server/study-report.ts";
const fixture = (): Course => ({
  id: "test-course",
  title: "工程制图",
  createdAt: "",
  updatedAt: "",
  timing: "exact",
  language: "zh",
  keywords: ["作业", "期末"],
  documents: [],
  cues: [
    {
      id: "a",
      start: 0,
      end: 12,
      text: "期末考试开卷，两小时，填空选择30分，画图分析70分。",
      chapterId: "chapter",
    },
    {
      id: "b",
      start: 12,
      end: 20,
      text: "本次作业3-1到3-7，下节课学习图层。",
      chapterId: "chapter",
    },
  ],
  chapters: [
    {
      id: "chapter",
      title: "课程安排",
      summary: "期末考试和本次作业安排。",
      start: 0,
      end: 20,
      cueIds: ["a", "b"],
    },
  ],
});
test("study report matches notice and transcript form while retaining every source cue and review status", () => {
  const course = fixture();
  const report = buildStudyReport(course, { sourceHash: "abc123" });
  assert.match(report.markdown, /一、老师口头通知与重要事项/);
  assert.match(report.markdown, /二、课程内容逐字稿/);
  assert.match(report.markdown, /30分.*70分/);
  assert.match(report.markdown, /尚未建立独立审查记录/);
  assert.equal(report.method, "source-extraction");
  assert.deepEqual(report.sections.flatMap((s) => s.cueIds).sort(), ["a", "b"]);
  assert.match(report.markdown, /未进行语言模型语义概括/);
});
test("independent recognition mismatch and critical numbers become unresolved listening checks, never auto-corrections", () => {
  const course = fixture();
  const before = structuredClone(course);
  const audit = compareRecognitions(course.cues, [
    { start: 0, end: 12, text: "这段说的是其他完全不同的内容" },
    { start: 12, end: 20, text: course.cues[1].text },
  ]);
  assert.deepEqual(course, before);
  assert.ok(
    audit.some(
      (a) => a.kind === "recognition-disagreement" && a.status === "open",
    ),
  );
  assert.ok(
    audit.some((a) => a.kind === "number-check" && a.primary.includes("30分")),
  );
  const report = buildStudyReport(course, { audit });
  assert.match(report.markdown, /【待核查】/);
  assert.match(report.markdown, /独立模型/);
});
test("model organization rejects nonexistent source IDs and cannot silently drop unassigned transcript paragraphs", () => {
  const course = fixture();
  const report = buildStudyReport(course, {
    model: {
      notices: [
        { category: "exam", text: "伪造考试内容", cueIds: ["missing"] },
      ],
      sections: [{ title: "模型标题", abstract: "摘要", cueIds: ["a"] }],
    },
  });
  assert.ok(report.notices.some((notice) => notice.text.includes("期末考试开卷")));
  assert.ok(report.notices.some((notice) => notice.text.includes("本次作业3-1到3-7")));
  assert.equal(report.sections.length, 2);
  assert.deepEqual(report.sections.flatMap((s) => s.cueIds).sort(), ["a", "b"]);
  const text = renderStudyReport(report, []);
  assert.match(text, /本次作业3-1到3-7/);
  assert.doesNotMatch(text, /伪造考试内容/);
});

test("recording boundaries and independently recognized missing speech remain listening checks", () => {
  const cues = [{ id: "middle", start: 60, end: 80, text: "已识别课堂内容。" }];
  const secondary = [
    { start: 10, end: 20, text: "开头还讲了考试安排。" },
    { start: 60, end: 80, text: cues[0].text },
    { start: 90, end: 94, text: "下次课交作业。" },
  ];
  const before = structuredClone(cues);
  const audit = compareRecognitions(cues, secondary, { duration: 150 });
  assert.deepEqual(cues, before);
  assert.ok(audit.some((a) => a.start === 0 && a.end === 60 && a.kind === "audio-gap"));
  assert.ok(audit.some((a) => a.start === 80 && a.end === 150 && a.kind === "audio-gap"));
  for (const speech of [secondary[0], secondary[2]]) {
    const item = audit.find((a) => a.secondary === speech.text);
    assert.ok(item);
    assert.equal(item.status, "open");
    assert.deepEqual(item.cueIds, []);
    assert.equal(item.primary, "");
    assert.equal(item.start, speech.start);
    assert.equal(item.end, speech.end);
    assert.match(item.message, /未自动补入正文/);
  }
});

test("secondary evidence covering a short interior hole is retained without duplicating covered speech", () => {
  const cues = [
    { id: "first", start: 0, end: 10, text: "前半句。" },
    { id: "second", start: 12, end: 20, text: "后半句。" },
  ];
  const secondary = [{ start: 0, end: 20, text: "前半句。别忘了交作业。后半句。" }];
  const audit = compareRecognitions(cues, secondary, { duration: 20 });
  const missing = audit.filter((a) => a.kind === "audio-gap");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].start, 10);
  assert.equal(missing[0].end, 12);
  assert.equal(missing[0].secondary, secondary[0].text);
  assert.match(missing[0].message, /完整声学片段/);
  assert.deepEqual(compareRecognitions(cues, secondary, { duration: 20 }), audit);
});
