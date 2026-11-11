import type { Course, Cue } from "../src/types.ts";
import { selectCues } from "./processing.ts";

export interface CourseContext {
  cues: Cue[];
  coverage: "complete" | "retrieved";
  overview: { title: string; summary: string; start: number; end: number }[];
  note: string;
}
const text = (cue: Cue) => cue.correctedText || cue.text;
const normalize = (s: string) =>
  s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const inputCue = (c: Cue) => ({
  id: c.id,
  start: c.start,
  end: c.end,
  text: text(c),
});
function terms(question: string) {
  const query = normalize(question),
    out = new Set<string>();
  for (const match of question
    .toLowerCase()
    .matchAll(/[a-z][a-z0-9+_-]{1,}|\d+/g))
    out.add(match[0]);
  for (let i = 0; i < query.length - 1; i++)
    for (const size of [2, 3])
      if (i + size <= query.length) out.add(query.slice(i, i + size));
  if (/作业|习题|留.{0,5}题|题号/.test(question))
    for (const term of ["作业", "习题", "上交", "提交", "3-", "三杠"])
      out.add(term);
  if (/考试|期末|笔试|开卷|分值/.test(question))
    for (const term of ["期末", "考试", "笔试", "开卷", "填空", "选择", "分"])
      out.add(term);
  if (/下节|下周|下次|安排/.test(question))
    for (const term of ["下节", "下周", "下一节", "下次", "安排"])
      out.add(term);
  return [...out].filter(
    (t) =>
      ![
        "什么",
        "怎么",
        "请问",
        "一下",
        "这个",
        "哪些",
        "是否",
        "的吗",
        "我们",
        "这堂",
        "的作",
        "业是",
      ].includes(t),
  );
}
/** Whole-course questions use the full searchable corpus; explicitly selected ranges are never silently cropped. */
export function selectCourseContext(
  course: Course,
  question: string,
  options: { start?: number; end?: number; maxChars?: number } = {},
): CourseContext {
  const max = Math.max(2000, options.maxChars || 42000),
    cues = selectCues(course, options.start, options.end);
  const serialize = (cs: Cue[], overview: CourseContext["overview"] = []) =>
    JSON.stringify({ cues: cs.map(inputCue), overview });
  if (serialize(cues).length <= max)
    return {
      cues,
      coverage: "complete",
      overview: [],
      note: "提供了所选范围的完整文字稿。",
    };
  if (options.start !== undefined || options.end !== undefined)
    throw Object.assign(
      new Error(
        "所选片段文字超出模型上下文容量，请缩小选段后再提问；未删减所选片段。",
      ),
      { status: 400 },
    );
  const q = terms(question),
    normalized = cues.map((c) => normalize(text(c))),
    total = cues.length;
  const frequencies = new Map(
    q.map((t) => [t, normalized.filter((s) => s.includes(t)).length]),
  );
  const scores = normalized.map((s, i) => {
    let score = 0;
    for (const term of q)
      if (s.includes(term))
        score +=
          Math.log(
            1 +
              (total - (frequencies.get(term) || 0) + 0.5) /
                ((frequencies.get(term) || 0) + 0.5),
          ) *
          Math.min(3, s.split(term).length - 1) *
          Math.min(3, term.length);
    if (
      /作业|习题|留.{0,5}题|题号/.test(question) &&
      /(?:作业|习题).{0,20}(?:[0-9]+[-－][0-9]+|三杠)|(?:最后|本次|这次|这个).{0,8}作业/.test(
        text(cues[i]),
      )
    )
      score += 20;
    if (
      /考试|期末|分值/.test(question) &&
      /(?:分|小时).{0,25}(?:填空|选择|画图)|(?:开卷|闭卷)/.test(text(cues[i]))
    )
      score += 15;
    return { i, score };
  });
  const generic = /总结|梳理|概览|大纲|整体|整堂|讲了什么|讲些什么/.test(
    question,
  );
  const maxOverview = Math.floor(max * (generic ? 0.5 : 0.2));
  const perSummary = Math.max(
    0,
    Math.floor(maxOverview / Math.max(1, course.chapters.length)) - 90,
  );
  let overview = course.chapters.map((c) => ({
    title: c.title.slice(0, 80),
    summary: c.summary.slice(0, perSummary),
    start: c.start,
    end: c.end,
  }));
  // All chapters remain represented; raw quotes below are the evidence for detailed assertions.
  if (JSON.stringify(overview).length > max * 0.6)
    overview = overview.map((c) => ({ ...c, summary: "" }));
  const chosen = new Set<number>();
  const add = (index: number) => {
    if (index < 0 || index >= cues.length || chosen.has(index)) return;
    const candidate = [...chosen, index]
      .sort((a, b) => a - b)
      .map((i) => cues[i]);
    if (serialize(candidate, overview).length <= max) chosen.add(index);
  };
  if (generic) {
    for (const chapter of course.chapters) {
      const index = cues.findIndex(
        (c) => chapter.cueIds.includes(c.id) && normalize(text(c)).length > 15,
      );
      add(index);
    }
  }
  for (const { i, score } of scores.sort(
    (a, b) => b.score - a.score || a.i - b.i,
  )) {
    if (score <= 0 && chosen.size) break;
    if (normalized[i].length < 5) continue;
    add(i);
    if (chosen.has(i)) {
      add(i + 1);
      if (!generic) add(i - 1);
    }
  }
  if (!chosen.size) {
    for (let i = 0; i < cues.length; i++)
      if (normalized[i].length > 15) {
        add(i);
        if (chosen.size >= 3) break;
      }
  }
  return {
    cues: [...chosen].sort((a, b) => a - b).map((i) => cues[i]),
    coverage: "retrieved",
    overview,
    note: "根据整堂课索引和问题检索原文。章节摘要仅提供范围线索；具体事实必须由本次提供的 cues 支持，未提供处需说明证据不足。",
  };
}
