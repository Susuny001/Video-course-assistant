import { createHash } from "node:crypto";
import type { Course, Cue } from "../src/types.ts";

export type ReviewStatus = "open" | "confirmed" | "dismissed";
export interface AuditItem {
  id: string;
  kind:
    | "recognition-disagreement"
    | "number-check"
    | "name-check"
    | "audio-gap"
    | "model-check";
  severity: "high" | "medium" | "low";
  start: number;
  end: number;
  cueIds: string[];
  primary: string;
  secondary?: string;
  message: string;
  status: ReviewStatus;
  note?: string;
  correctedText?: string;
  proposedText?: string;
  reviewedAt?: string;
  excludeFromReport?: boolean;
  checks?: {
    engine: string;
    text: string;
    sourceHash: string;
    createdAt: string;
    error?: string;
  }[];
}
export interface ReportFact {
  category: "assignment" | "exam" | "schedule" | "reminder" | "focus";
  text: string;
  cueIds: string[];
  start: number;
  end: number;
}
export interface ReportSection {
  title: string;
  abstract: string;
  cueIds: string[];
  paragraphs: { text: string; cueIds: string[]; start: number; end: number }[];
}
export interface StudyReport {
  title: string;
  generatedAt: string;
  method: "source-extraction" | "model-assisted";
  sourceHash?: string;
  keywords: string[];
  notices: ReportFact[];
  sections: ReportSection[];
  warnings: string[];
  markdown: string;
}
export interface AcousticSegment {
  start: number;
  end: number;
  text: string;
}
export interface StructuredModelReport {
  notices?: {
    category: ReportFact["category"];
    text: string;
    cueIds: string[];
  }[];
  sections?: { title: string; abstract: string; cueIds: string[] }[];
  warnings?: string[];
}
const currentText = (cue: Cue) => cue.correctedText || cue.text;
const clean = (text: string) => text.replace(/\s+/g, " ").trim();
export const showTime = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(Math.max(0, seconds) % 60)
    .toString()
    .padStart(2, "0")}`;
const stableId = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 18);
const normal = (value: string) =>
  value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
export function textSimilarity(a: string, b: string): number {
  a = normal(a).slice(0, 800);
  b = normal(b).slice(0, 800);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  // Bigrams avoid quadratic transcript-wide edit-distance work and tolerate VAD boundary wording.
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < Math.max(1, s.length - 1); i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const x = grams(a),
    y = grams(b);
  let shared = 0;
  for (const [key, count] of x) shared += Math.min(count, y.get(key) || 0);
  return (2 * shared) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1));
}
export function compareRecognitions(
  cues: Cue[],
  secondary: AcousticSegment[],
  options: { duration?: number } = {},
): AuditItem[] {
  const items: AuditItem[] = [];
  for (const cue of cues) {
    const overlaps = secondary.filter(
      (s) =>
        Math.min(s.end, cue.end) - Math.max(s.start, cue.start) >
        Math.min(s.end - s.start, cue.end - cue.start) * 0.25,
    );
    const other = clean(overlaps.map((s) => s.text).join(""));
    const primary = clean(cue.text),
      similarity = textSimilarity(primary, other);
    if (!other || similarity < 0.48) {
      items.push({
        id: stableId(`${cue.id}:asr`),
        kind: "recognition-disagreement",
        severity: !other || similarity < 0.25 ? "high" : "medium",
        start: cue.start,
        end: cue.end,
        cueIds: [cue.id],
        primary,
        secondary: other || undefined,
        message: other
          ? `两种声学模型识别差异较大（文本相似度 ${Math.round(similarity * 100)}%），需回听原录音。`
          : "第二声学模型在此区间没有对应识别，需检查是否静音、噪声或漏识。",
        status: "open",
      });
    }
    // These facts merit an explicit listening check even when two models share the same error.
    if (
      /(?:作业|考试|期末|期中|开卷|周|小时|分钟|题型|分值|页|题目|习题)/.test(
        primary,
      ) &&
      /[\d一二三四五六七八九十百]+/.test(primary)
    )
      items.push({
        id: stableId(`${cue.id}:number`),
        kind: "number-check",
        severity: "high",
        start: cue.start,
        end: cue.end,
        cueIds: [cue.id],
        primary,
        secondary: other || undefined,
        message:
          "课程安排中的数字、题号或时间需逐项回听确认；双模型一致也不等同于事实已核实。",
        status: "open",
      });
    if (
      /(?:同学|名单|名字|学号|领取|没拿|拿走)/.test(primary) &&
      /(?:作业|同学|名字|学号)/.test(primary)
    )
      items.push({
        id: stableId(`${cue.id}:name`),
        kind: "name-check",
        severity: "medium",
        start: cue.start,
        end: cue.end,
        cueIds: [cue.id],
        primary,
        secondary: other || undefined,
        message: "姓名、学号等无法仅凭常识校正，需回听并保留不确定标记。",
        status: "open",
      });
  }
  for (let i = 1; i < cues.length; i++) {
    const gap = cues[i].start - cues[i - 1].end;
    if (gap > 45)
      items.push({
        id: stableId(`gap:${cues[i - 1].end}:${cues[i].start}`),
        kind: "audio-gap",
        severity: "medium",
        start: cues[i - 1].end,
        end: cues[i].start,
        cueIds: [],
        primary: "",
        message: `存在 ${Math.round(gap)} 秒无识别文字的音频区间，可能为课堂停顿，也可能漏识，需检查音频。`,
        status: "open",
      });
  }
  const coverage = cues
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .map((c) => ({ start: Math.max(0, c.start), end: c.end }))
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const interval of coverage) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  const duration = options.duration;
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    const boundaries = merged.length
      ? [{ start: 0, end: Math.min(duration, merged[0].start) },
          { start: Math.min(duration, merged.at(-1)!.end), end: duration }]
      : [{ start: 0, end: duration }];
    for (const gap of boundaries) {
      if (gap.end - gap.start <= 45) continue;
      items.push({
        id: stableId(`boundary-gap:${gap.start}:${gap.end}`),
        kind: "audio-gap",
        severity: "medium",
        start: gap.start,
        end: gap.end,
        cueIds: [],
        primary: "",
        message: `原录音首尾存在 ${Math.round(gap.end - gap.start)} 秒无第一轮识别文字的区间，可能为静音或漏识，需回听核查。`,
        status: "open",
      });
    }
  }
  for (const segment of secondary) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
        segment.end <= segment.start || typeof segment.text !== "string" || !segment.text.trim())
      continue;
    let cursor = Math.max(0, segment.start);
    const end = typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? Math.min(duration, segment.end) : segment.end;
    const uncovered: { start: number; end: number }[] = [];
    for (const interval of merged) {
      if (interval.end <= cursor) continue;
      if (interval.start >= end) break;
      if (interval.start > cursor)
        uncovered.push({ start: cursor, end: Math.min(end, interval.start) });
      cursor = Math.max(cursor, interval.end);
      if (cursor >= end) break;
    }
    if (cursor < end) uncovered.push({ start: cursor, end });
    for (const gap of uncovered) {
      // Ignore only sub-frame timestamp rounding differences, not short spoken notices.
      if (gap.end - gap.start <= 0.05) continue;
      items.push({
        id: stableId(`secondary-uncovered:${gap.start}:${gap.end}:${segment.text}`),
        kind: "audio-gap",
        severity: "high",
        start: gap.start,
        end: gap.end,
        cueIds: [],
        primary: "",
        secondary: clean(segment.text),
        message: "独立声学模型在第一轮字幕未覆盖的音频区间识别到文字，可能漏识或分段不同，需回听。所列独立识别文字来自完整声学片段，未逐字对齐到此缺口，也未自动补入正文。",
        status: "open",
      });
    }
  }
  return items.sort(
    (a, b) => a.start - b.start || a.kind.localeCompare(b.kind),
  );
}
function category(text: string): ReportFact["category"] | undefined {
  if (/(?:作业|习题|提交|上交|领取|大作业|题号)/.test(text))
    return "assignment";
  if (/(?:考试|期末|期中|开卷|闭卷|笔试|题型|分值)/.test(text)) return "exam";
  if (/(?:下[一节次周堂]|下节课|课程安排|上机|课件|周开始)/.test(text))
    return "schedule";
  if (/(?:注意|提醒|不要忘|记住|提前|核对|责任|签字)/.test(text))
    return "reminder";
}
export function buildStudyReport(
  course: Course,
  options: {
    keywords?: string[];
    sourceHash?: string;
    model?: StructuredModelReport;
    audit?: AuditItem[];
    excludedCueIds?: string[];
  } = {},
): StudyReport {
  const excluded = new Set(options.excludedCueIds || []);
  course = { ...course, cues: course.cues.filter((c) => !excluded.has(c.id)) };
  const keywords = (options.keywords || course.keywords || [])
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 30);
  const notices: ReportFact[] = [];
  const seen = new Set<string>();
  if (options.model?.notices) {
    for (const item of options.model.notices) {
      const sources = course.cues.filter((c) => item.cueIds?.includes(c.id));
      if (
        !sources.length ||
        !["assignment", "exam", "schedule", "reminder", "focus"].includes(
          item.category,
        ) ||
        !item.text?.trim()
      )
        continue;
      const text = clean(item.text);
      if (seen.has(text)) continue;
      seen.add(text);
      notices.push({
        category: item.category,
        text,
        cueIds: sources.map((c) => c.id),
        start: Math.min(...sources.map((c) => c.start)),
        end: Math.max(...sources.map((c) => c.end)),
      });
    }
  }
  let supplemented = 0;
    for (let i = 0; i < course.cues.length; i++) {
      const cue = course.cues[i],
        body = currentText(cue),
        kind =
          category(body) ||
          (keywords.some((k) => body.includes(k)) ? "focus" : undefined);
      if (!kind) continue;
      if (options.model && notices.some((notice) => notice.cueIds.includes(cue.id))) continue;
      const following = course.cues
        .slice(i + 1, i + 3)
        .filter(
          (c) => c.chapterId === cue.chapterId && c.start - cue.end < 2.5,
        );
      const sources = [cue, ...following];
      const text = clean(sources.map(currentText).join(""));
      if (seen.has(text)) continue;
      seen.add(text);
      supplemented++;
      notices.push({
        category: kind,
        text,
        cueIds: sources.map((c) => c.id),
        start: cue.start,
        end: sources.at(-1)!.end,
      });
    }
  const used = new Set<string>();
  const sections: ReportSection[] = [];
  if (options.model?.sections) {
    for (const s of options.model.sections) {
      const sources = course.cues.filter(
        (c) => s.cueIds?.includes(c.id) && !used.has(c.id),
      );
      if (!sources.length) continue;
      sources.forEach((c) => used.add(c.id));
      sections.push({
        title: clean(s.title).slice(0, 160),
        abstract: clean(s.abstract).slice(0, 2000),
        cueIds: sources.map((c) => c.id),
        paragraphs: sources.map((c) => ({
          text: currentText(c),
          cueIds: [c.id],
          start: c.start,
          end: c.end,
        })),
      });
    }
  }
  for (const chapter of course.chapters) {
    const cues = course.cues.filter(
      (c) =>
        (c.chapterId === chapter.id || chapter.cueIds.includes(c.id)) &&
        !used.has(c.id),
    );
    if (!cues.length) continue;
    cues.forEach((c) => used.add(c.id));
    sections.push({
      title: chapter.title,
      abstract: chapter.summary,
      cueIds: cues.map((c) => c.id),
      paragraphs: cues.map((c) => ({
        text: currentText(c),
        cueIds: [c.id],
        start: c.start,
        end: c.end,
      })),
    });
  }
  const remaining = course.cues.filter((c) => !used.has(c.id));
  if (remaining.length)
    sections.push({
      title: "其他课程内容",
      abstract: "以下内容未归入前述章节，原文完整保留。",
      cueIds: remaining.map((c) => c.id),
      paragraphs: remaining.map((c) => ({
        text: currentText(c),
        cueIds: [c.id],
        start: c.start,
        end: c.end,
      })),
    });
  const warnings = [
    ...(options.model?.warnings || []),
    "原始语音识别与校对文本分别保留，文稿不代表已经逐字核实。",
  ];
  if (options.model && supplemented)
    warnings.push("部分通知或重点未被模型概括覆盖，已按来源原文补充，需对照回听审查。");
  if (excluded.size)
    warnings.push(
      `经有记录的回听审查，${excluded.size} 段旁话/噪声未纳入正文；原始识别仍保存在课程与审查记录中。`,
    );
  if (course.timing === "estimated")
    warnings.push("当前时间为文字估算，不能用于精确回听。");
  if (!options.model)
    warnings.push(
      "当前整理使用本地原文摘录与章节分段，未进行语言模型语义概括。",
    );
  const report: StudyReport = {
    title: course.title,
    generatedAt: new Date().toISOString(),
    method: options.model ? "model-assisted" : "source-extraction",
    sourceHash: options.sourceHash,
    keywords,
    notices,
    sections,
    warnings,
    markdown: "",
  };
  report.markdown = renderStudyReport(report, options.audit || []);
  return report;
}
export function renderStudyReport(
  report: StudyReport,
  audit: AuditItem[],
): string {
  const unresolved = audit.filter((a) => a.status === "open"),
    confirmed = audit.filter((a) => a.status === "confirmed");
  const lines = [
    `# ${report.title} · 课程文字稿`,
    "",
    `整理方式：${report.method === "model-assisted" ? "多模型识别与语言模型整理" : "语音识别原文分段摘录"}。原文来源可通过各段时间码回查。`,
    report.sourceHash ? `原录音 SHA-256：\`${report.sourceHash}\`` : "",
    "",
    `审查状态：${!audit.length ? "尚未建立独立审查记录" : unresolved.length ? "存在 " + unresolved.length + " 项待核查" : "当前列出的审查项均已有结论"}；已确认 ${confirmed.length} 项。`,
    "",
    "## 一、老师口头通知与重要事项（非课程内容，重点看这里）",
    "",
    "### 作业与课程安排",
    "",
  ];
  const names = {
    assignment: "作业",
    exam: "考试",
    schedule: "课程安排",
    reminder: "提醒",
    focus: "指定重点",
  };
  const keyfacts = report.notices.filter((n) => n.category !== "reminder");
  if (!keyfacts.length)
    lines.push(
      "当前录音识别结果中未提取到明确的作业、考试或课程安排；请结合审查项核查。",
    );
  keyfacts.forEach((fact, i) =>
    lines.push(
      `${i + 1}. **${names[fact.category]}**（${showTime(fact.start)}–${showTime(fact.end)}）：${fact.text}${unresolved.some((item) => item.cueIds.some((id) => fact.cueIds.includes(id))) ? " **【待核查】**" : ""}`,
      "",
      "",
    ),
  );
  lines.push("### 其他提醒", "");
  const reminders = report.notices.filter((n) => n.category === "reminder");
  if (!reminders.length) lines.push("- 暂未提取到单独提醒。");
  reminders.forEach((fact) =>
    lines.push(
      `- （${showTime(fact.start)}–${showTime(fact.end)}）${fact.text}`,
    ),
  );
  lines.push("", "## 二、课程内容逐字稿", "");
  for (const section of report.sections) {
    lines.push(
      `### ${section.title}`,
      "",
      `**本段摘要**：${section.abstract}`,
      "",
    );
    for (const p of section.paragraphs) {
      const pending = audit.filter(
        (a) =>
          a.status === "open" && a.cueIds.some((id) => p.cueIds.includes(id)),
      );
      lines.push(
        `[${showTime(p.start)}–${showTime(p.end)}] ${p.text}${pending.length ? " **【待核查】**" : ""}`,
        "",
      );
    }
  }
  lines.push("## 三、审查记录与待核对内容", "");
  if (!audit.length)
    lines.push("尚无独立复核记录；不能由没有审查项推断识别正确。");
  for (const item of audit) {
    lines.push(
      `### ${showTime(item.start)}–${showTime(item.end)} · ${item.status === "open" ? "待核查" : item.status === "confirmed" ? "已确认" : "已排除"} · ${item.message}`,
      "",
      `- 原识别：${item.primary || "（无文字）"}`,
    );
    if (item.secondary) lines.push(`- 独立模型：${item.secondary}`);
    if (item.note) lines.push(`- 审查说明：${item.note}`);
    if (item.correctedText) lines.push(`- 审查后文本：${item.correctedText}`);
    if (item.proposedText) lines.push(`- 未采用的校对候选：${item.proposedText}`);
    if(item.excludeFromReport)lines.push("- 正文处理：经审查后不纳入正文，原始识别保留。");
    for(const check of item.checks||[])lines.push(check.error?`- ${check.engine} 复核失败：${check.error}`:`- ${check.engine} 实际音频复核：${check.text}（音频 SHA-256：${check.sourceHash}）`);
    lines.push("");
  }
  lines.push("## 说明", "", ...report.warnings.map((w) => "- " + w), "");
  return lines
    .filter((line, i, array) => line !== "" || array[i - 1] !== "")
    .join("\n");
}
