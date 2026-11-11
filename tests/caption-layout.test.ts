import { test } from "node:test";
import assert from "node:assert/strict";
import { captionForTime, captionWidth, layoutCaptions } from "../src/caption-layout.ts";
import { buildVtt } from "../src/subtitles.ts";
import { exportCourse } from "../server/processing.ts";
import type { Course, Cue } from "../src/types.ts";

const cue = (text: string, translation?: string): Cue => ({
  id: "speech-segment", start: 192.188, end: 236.828, text, translation,
});
const readable = (captions: ReturnType<typeof layoutCaptions>) => {
  for (const caption of captions) {
    assert.ok(caption.lines.length <= 2, "a display caption has at most two lines");
    for (const line of caption.lines)
      assert.ok(captionWidth(line) <= 22 + 1e-8, `line exceeds readable width: ${line}`);
  }
};

test("long speech segments become readable captions without changing source text or speech boundaries", () => {
  const source = cue(("这节课继续讲零件图的表达方法，先看内部孔槽，再看剖视图。CAD 的图层、轮廓线和中心线也要核对。👨‍👩‍👧‍👦\n" ).repeat(7));
  const before = structuredClone(source);
  const captions = layoutCaptions([source]);
  assert.ok(captions.length > 5);
  assert.equal(captions.map((c) => c.text).join(""), source.text);
  assert.equal(captions[0].start, source.start);
  assert.equal(captions.at(-1)!.end, source.end);
  for (const [i, caption] of captions.entries()) {
    assert.equal(caption.sourceCueId, source.id);
    assert.equal(caption.sourceStart, source.start);
    assert.equal(caption.sourceEnd, source.end);
    assert.equal(caption.timing, "interpolated");
    assert.ok(caption.end > caption.start);
    if (i) assert.equal(caption.start, captions[i - 1].end);
    assert.equal(captionForTime(source, (caption.start + caption.end) / 2), caption);
  }
  assert.equal(captionForTime(source, source.end), undefined);
  assert.deepEqual(source, before);
  readable(captions);
});

test("indivisible graphemes and mixed character widths never overflow the second line", () => {
  const source = cue("中".repeat(21) + "a" + "中".repeat(22) + " ");
  const captions = layoutCaptions([source]);
  readable(captions);
  assert.equal(captions.map((c) => c.text).join(""), source.text);
});

test("bilingual layout preserves both complete tracks when their lengths differ", () => {
  for (const source of [
    cue("CAD 图层。", "The entire drawing must use separate layers for visible outlines, centre lines, dimensions and annotations. ".repeat(4)),
    cue("请同学们注意，下周有上机练习，期末考试没有上机环节，画图要求仍需按照课件完成。".repeat(5), "No computer exam."),
    cue("", "A translation-only cue is still visible."),
  ]) {
    const captions = layoutCaptions([source], "bilingual");
    readable(captions);
    assert.equal(captions.map((c) => c.text).join(""), source.text);
    assert.equal(captions.map((c) => c.translation || "").join(""), source.translation);
    assert.equal(captions[0].start, source.start);
    assert.equal(captions.at(-1)!.end, source.end);
  }
});

test("corrected captions and native/export tracks share readable layout while retaining original JSON", () => {
  const source = cue("原始识别不会被覆盖。", "Keep all of the translated words. ".repeat(8));
  source.correctedText = "已回听修正：轮廓线、中心线和尺寸线需要分别设置图层。".repeat(8);
  const captions = layoutCaptions([source], "corrected");
  assert.equal(captions.map((c) => c.text).join(""), source.correctedText);
  readable(captions);
  const native = buildVtt([source], "corrected");
  assert.match(native, /NOTE .*未做逐字强制对齐/);
  assert.equal((native.match(/ --> /g) || []).length, captions.length);
  const course: Course = { id: "course", title: "课堂", createdAt: "", updatedAt: "", documents: [], cues: [source], chapters: [], timing: "exact", language: "zh", keywords: [] };
  for (const format of ["srt", "vtt"]) {
    const exported = exportCourse(course, format);
    assert.equal(exported.timingHint, "interpolated-within-source-segment");
    assert.doesNotMatch(exported.body, /原始识别不会被覆盖/);
    for (const block of exported.body.trim().split(/\n\n/)) {
      if (!block.includes(" --> ")) continue;
      const lines = block.split("\n").slice(2);
      assert.ok(lines.length <= 2);
      for (const line of lines) assert.ok(captionWidth(line) <= 22 + 1e-8);
    }
  }
  assert.equal(JSON.parse(exportCourse(course, "json").body).cues[0].text, source.text);
});
