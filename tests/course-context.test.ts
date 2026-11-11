import test from "node:test";
import assert from "node:assert/strict";
import { selectCourseContext } from "../server/course-context.ts";
import type { Course } from "../src/types.ts";
const longCourse = (): Course => {
  const cues = Array.from({ length: 180 }, (_, i) => ({
    id: "s" + i,
    start: i * 30,
    end: (i + 1) * 30,
    text:
      i === 170
        ? "最后的作业是3-1到3-7，还有3-10到3-12。"
        : i === 171
          ? "跳过的题是图层内容，下节课一起做。"
          : "这一段讨论不同投影和轮廓线的绘制方法。".repeat(4),
    chapterId: "ch" + Math.floor(i / 20),
  }));
  return {
    id: "c",
    title: "工程制图",
    createdAt: "",
    updatedAt: "",
    language: "zh",
    keywords: [],
    documents: [],
    timing: "exact",
    cues,
    chapters: Array.from({ length: 9 }, (_, i) => ({
      id: "ch" + i,
      title: "第" + i + "部分",
      summary: "本章介绍制图表达方法。",
      start: i * 600,
      end: (i + 1) * 600,
      cueIds: cues.filter((c) => c.chapterId === "ch" + i).map((c) => c.id),
    })),
  };
};
test("whole-course retrieval finds late homework instead of keeping only the recording beginning", () => {
  const c = longCourse(),
    r = selectCourseContext(c, "这次作业是什么？", { maxChars: 3000 });
  assert.equal(r.coverage, "retrieved");
  assert.ok(r.cues.some((s) => s.id === "s170"));
  assert.ok(r.cues.some((s) => s.id === "s171"));
  assert.equal(r.overview.length, c.chapters.length);
});
test("explicitly chosen long ranges are rejected intact rather than silently discarding source", () => {
  const c = longCourse();
  assert.throws(
    () =>
      selectCourseContext(c, "解释所选段", {
        start: 0,
        end: 5000,
        maxChars: 2000,
      }),
    /未删减/,
  );
  const short = selectCourseContext(c, "解释所选段", {
    start: 0,
    end: 30,
    maxChars: 2000,
  });
  assert.equal(short.coverage, "complete");
  assert.deepEqual(short.cues, [c.cues[0]]);
});
test("whole-course overview represents every chapter and evidence respects the input budget", () => {
  const r = selectCourseContext(longCourse(), "总结整堂课的大纲", {
    maxChars: 5000,
  });
  assert.equal(r.overview.length, 9);
  assert.ok(r.cues.length > 0);
  assert.ok(
    JSON.stringify({
      cues: r.cues.map((c) => ({
        id: c.id,
        start: c.start,
        end: c.end,
        text: c.text,
      })),
      overview: r.overview,
    }).length <= 5000,
  );
});
