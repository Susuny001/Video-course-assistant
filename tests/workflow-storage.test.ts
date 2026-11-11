import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Course } from "../src/types.ts";
import type { WorkflowState } from "../server/workflow.ts";
import { buildStudyReport } from "../server/study-report.ts";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "course-workflow-review-"));
process.env.DATA_DIR = directory;
const { initializeStorage, saveCourse, getCourse } = await import("../server/storage.ts");
const { reviewWorkflowItem, getWorkflow } = await import("../server/workflow.ts");
await initializeStorage();
test.after(() => fs.rm(directory, {recursive: true, force: true}));

async function fixture(id: string) {
  const course: Course = {
    id, title: "工程制图", createdAt: "", updatedAt: "", timing: "exact", language: "zh",
    keywords: ["考试", "作业"], documents: [],
    cues: [
      {id: "exam", start: 0, end: 10, text: "考试填空选择30分，画图分析70分。", chapterId: "chapter"},
      {id: "assignment", start: 10, end: 20, text: "作业3-1到3-7。", chapterId: "chapter"},
    ],
    chapters: [{id: "chapter", title: "考试与作业", summary: "考试填空选择70分。", start: 0, end: 20, cueIds: ["exam", "assignment"]}],
  };
  await saveCourse(course);
  const state: WorkflowState = {
    id: "run", courseId: id, status: "needs_review", phase: "audit", progress: "等待核对", stages: [], createdAt: "", updatedAt: "",
    audit: course.cues.map((cue) => ({id: cue.id, kind: "number-check", severity: "high", start: cue.start, end: cue.end, cueIds: [cue.id], primary: cue.text, message: "核对安排中的数字。", status: "open"})),
  };
  state.report = buildStudyReport(course, {audit: state.audit});
  state.reportBase = structuredClone(state.report);
  await fs.mkdir(path.join(directory, "workflows"), {recursive: true});
  await fs.writeFile(path.join(directory, "workflows", id + ".json"), JSON.stringify(state));
  return course;
}

test("pending candidates cannot apply facts; confirmed corrections update notices and saved report artifacts", async () => {
  const course = await fixture("correction");
  for (const status of ["open", "dismissed"])
    await assert.rejects(reviewWorkflowItem(course.id, "exam", {status, note: "尚未确认修改", correctedText: "考试全部70分。"}), /确认回听结论后应用/);
  assert.equal((await getCourse(course.id)).cues[0].correctedText, undefined);
  const correctedText = "考试填空选择20分，画图分析80分。";
  await reviewWorkflowItem(course.id, "exam", {status: "confirmed", note: "已逐项回听原录音。", correctedText});
  const saved = await getCourse(course.id), state = await getWorkflow(course.id);
  assert.equal(saved.cues[0].text, course.cues[0].text);
  assert.equal(saved.cues[0].correctedText, correctedText);
  assert.ok(state?.report?.notices.some((notice) => notice.text.includes(correctedText)));
  assert.ok(state?.report?.sections[0].abstract.includes(correctedText));
  const artifacts = path.join(directory, "workflows", course.id, "run");
  assert.equal(await fs.readFile(path.join(artifacts, "课程文字稿.md"), "utf8"), state?.report?.markdown);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(artifacts, "audit.json"), "utf8")), state?.audit);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(artifacts, "study-report.json"), "utf8")), state?.report);
});

test("concurrent review saves preserve both conclusions and noise exclusion can be restored", async () => {
  await fixture("parallel");
  await Promise.all([
    reviewWorkflowItem("parallel", "exam", {status: "confirmed", note: "已回听数字。"}),
    reviewWorkflowItem("parallel", "assignment", {status: "dismissed", note: "已回听，是旁话。", excludeFromReport: true}),
  ]);
  let state = await getWorkflow("parallel");
  assert.equal(state?.status, "done");
  assert.deepEqual(state?.audit.map((item) => item.status), ["confirmed", "dismissed"]);
  assert.equal(state?.report?.sections.flatMap((section) => section.paragraphs).length, 1);
  await reviewWorkflowItem("parallel", "assignment", {status: "confirmed", note: "再次回听，仍应保留这段通知。", excludeFromReport: false});
  state = await getWorkflow("parallel");
  assert.equal(state?.report?.sections.flatMap((section) => section.paragraphs).length, 2);
  assert.equal((await getCourse("parallel")).cues.length, 2);
});
