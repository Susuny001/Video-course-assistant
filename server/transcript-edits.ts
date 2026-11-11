import { createHash } from "node:crypto";
import type { Course, Cue } from "../src/types.ts";
import type { AuditItem } from "./study-report.ts";
import { normalizeSpokenNumbers } from "./semantic-audit.ts";

export interface TranscriptEdit {
  cueId: string;
  find: string;
  replace: string;
  reason: string;
  occurrence?: number;
}
export interface AppliedTranscriptEdit extends TranscriptEdit {
  start: number;
  end: number;
  before: string;
  after: string;
}
export interface RejectedTranscriptEdit {
  index: number;
  cueId?: string;
  reason: string;
}
interface Located {
  edit: TranscriptEdit;
  start: number;
  end: number;
  highRisk: boolean;
}
const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 18);
const content = (cue: Cue) => cue.correctedText || cue.text;
const numbers = (s: string) =>
  (normalizeSpokenNumbers(s).match(/\d+(?:-\d+)?(?:\.\d+)?/g) || [])
    .sort()
    .join("|");
const polarity = (s: string) =>
  (s.match(/没有|不得|不能|不[是要需画得]|无|未|非|否/g) || [])
    .sort()
    .join("|");
const examEntities = (s: string) =>
  (s.match(/期中|期末|开卷|闭卷|上机|笔试|选做|必做/g) || []).sort().join("|");
function risky(edit: TranscriptEdit, source: string) {
  return (
    numbers(edit.find) !== numbers(edit.replace) ||
    polarity(edit.find) !== polarity(edit.replace) ||
    examEntities(edit.find) !== examEntities(edit.replace) ||
    (/姓名|名单|学号/.test(source) && edit.find !== edit.replace)
  );
}
function applyLocated(source: string, edits: Located[]) {
  let text = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start))
    text = text.slice(0, e.start) + e.edit.replace + text.slice(e.end);
  return text;
}
/** Language editing never becomes new acoustic evidence and never overwrites the raw transcript. */
export function applyTranscriptEdits(
  input: Course,
  proposals: unknown,
): {
  course: Course;
  applied: AppliedTranscriptEdit[];
  rejected: RejectedTranscriptEdit[];
  audit: AuditItem[];
} {
  const course = structuredClone(input),
    applied: AppliedTranscriptEdit[] = [],
    rejected: RejectedTranscriptEdit[] = [],
    audit: AuditItem[] = [];
  if (!Array.isArray(proposals))
    return {
      course,
      applied,
      rejected: [
        { index: -1, reason: "语言模型校对结果不是修改列表，未采用。" },
      ],
      audit,
    };
  const byId = new Map(course.cues.map((c) => [c.id, c]));
  const grouped = new Map<string, Located[]>();
  for (const [index, value] of proposals.entries()) {
    const item = value as Partial<TranscriptEdit> | null;
    const reject = (reason: string) =>
      rejected.push({
        index,
        cueId: typeof item?.cueId === "string" ? item.cueId : undefined,
        reason,
      });
    if (
      !item ||
      typeof item.cueId !== "string" ||
      typeof item.find !== "string" ||
      !item.find ||
      typeof item.replace !== "string" ||
      !item.replace.trim() ||
      typeof item.reason !== "string" ||
      !item.reason.trim()
    ) {
      reject("缺少有效字幕 ID、原文片段、替换文字或修改依据。");
      continue;
    }
    const cue = byId.get(item.cueId);
    if (!cue) {
      reject("修改引用了不存在的字幕。");
      continue;
    }
    if (
      item.find.length > 500 ||
      item.replace.length > Math.max(80, item.find.length * 4)
    ) {
      reject("替换内容明显扩写原文，不能作为听写校对自动采用。");
      continue;
    }
    if (item.find === item.replace) continue;
    const text = content(cue);
    const offsets: number[] = [];
    let at = 0;
    while ((at = text.indexOf(item.find, at)) >= 0) {
      offsets.push(at);
      at += Math.max(1, item.find.length);
    }
    const occurrence = item.occurrence ?? 0;
    if (
      !Number.isInteger(occurrence) ||
      occurrence < 0 ||
      occurrence >= offsets.length ||
      (item.occurrence === undefined && offsets.length !== 1)
    ) {
      reject(
        offsets.length
          ? "原文片段出现多次，未明确位置，未猜测修改对象。"
          : "原文中没有该片段，未采用模型虚构的修改。",
      );
      continue;
    }
    const edit: TranscriptEdit = {
      cueId: item.cueId,
      find: item.find,
      replace: item.replace,
      reason: item.reason.trim(),
      ...(item.occurrence === undefined ? {} : { occurrence }),
    };
    const located: Located = {
      edit,
      start: offsets[occurrence],
      end: offsets[occurrence] + edit.find.length,
      highRisk: risky(edit, text),
    };
    const existing = grouped.get(cue.id) || [];
    if (existing.some((e) => located.start < e.end && located.end > e.start)) {
      reject("模型给出的多处修改互相覆盖，保留原文等待重审。");
      continue;
    }
    existing.push(located);
    grouped.set(cue.id, existing);
  }
  for (const [id, edits] of grouped) {
    const cue = byId.get(id)!,
      before = content(cue),
      safe = edits.filter((e) => !e.highRisk),
      pending = edits.filter((e) => e.highRisk);
    const after = applyLocated(before, safe);
    if (after !== before) cue.correctedText = after;
    for (const item of safe)
      applied.push({
        ...item.edit,
        start: cue.start,
        end: cue.end,
        before: item.edit.find,
        after: item.edit.replace,
      });
    if (pending.length)
      audit.push({
        id: hash(
          "edit-review:" +
            id +
            ":" +
            JSON.stringify(pending.map((e) => e.edit)),
        ),
        kind: "model-check",
        severity: "high",
        start: cue.start,
        end: cue.end,
        cueIds: [id],
        primary: before,
        correctedText: applyLocated(before, edits),
        message:
          "语言模型提出数字、否定词、考试安排或姓名变更，尚未应用；需回查录音确认，防止语言润色改写事实。",
        note: pending
          .map((p) => `${p.edit.find} → ${p.edit.replace}：${p.edit.reason}`)
          .join("\n"),
        status: "open",
      });
  }
  return { course, applied, rejected, audit };
}
