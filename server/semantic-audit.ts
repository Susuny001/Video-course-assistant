import { createHash } from "node:crypto";
import type { Course, Cue } from "../src/types.ts";
import type { AuditItem, StudyReport } from "./study-report.ts";

const digits: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
function chineseNumber(value: string): number {
  if (!/[十百千]/.test(value))
    return Number([...value].map((v) => digits[v] ?? v).join(""));
  let total = 0,
    current = 0;
  for (const c of value) {
    if (c in digits) current = digits[c];
    else {
      total += (current || 1) * ({ 十: 10, 百: 100, 千: 1000 }[c] || 1);
      current = 0;
    }
  }
  return total + current;
}
export function normalizeSpokenNumbers(text: string): string {
  return text
    .replace(
      /([零〇一二两三四五六七八九十百千]+)[杠－—-]([零〇一二两三四五六七八九十百千]+)/g,
      (_m, a, b) => `${chineseNumber(a)}-${chineseNumber(b)}`,
    )
    .replace(
      /[零〇一二两三四五六七八九十百千]+(?=分|小时|分钟|周|页|章|题|个|点|度)/g,
      (n) => String(chineseNumber(n)),
    );
}
const body = (cue: Cue) => cue.correctedText || cue.text;
const key = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 18);
function finding(
  cues: Cue[],
  label: string,
  message: string,
  severity: AuditItem["severity"] = "high",
): AuditItem {
  return {
    id: key("semantic:" + label + ":" + cues.map((c) => c.id).join(":")),
    kind: "model-check",
    severity,
    start: Math.min(...cues.map((c) => c.start)),
    end: Math.max(...cues.map((c) => c.end)),
    cueIds: cues.map((c) => c.id),
    primary: cues.map(body).join("\n"),
    message,
    status: "open",
  };
}
/** Guard common semantic failures even when two acoustic models agree on the same error. */
export function semanticAudit(
  course: Course,
  report?: StudyReport,
): AuditItem[] {
  const out: AuditItem[] = [];
  const cues = course.cues;
  const noFinal = cues.filter((c) =>
    /(?:没有|取消|不[设考]|无)[啊呃这个的\s]{0,4}期末(?:考试)?/.test(body(c)),
  );
  const finalEvidence = cues.filter(
    (c) =>
      /(?:期末.{0,25}(?:考试|笔试)|(?:最终|最后)的?.{0,10}考试.{0,15}(?:笔试|小时)|(?:笔试|考试).{0,15}(?:开卷|闭卷))/.test(
        body(c),
      ) && !noFinal.includes(c),
  );
  for (const cue of noFinal)
    if (finalEvidence.length)
      out.push(
        finding(
          [cue, ...finalEvidence.slice(0, 2)],
          "exam-contradiction",
          "“没有期末考试”与同堂课的期末/笔试安排冲突。可能是口误或共同误识，须对原音频重新识别，不能直接照抄任一说法。",
        ),
      );
  for (const [index, cue] of cues.entries()) {
    const text = body(cue);
    const context = [cues[index - 1], cue, cues[index + 1]]
      .filter(Boolean)
      .map(body)
      .join("");
    if (/(?:能有|有)期中考试/.test(text) && /(?:没有|无)期中/.test(context))
      out.push(
        finding(
          [cue],
          "midterm-negation",
          "“有/能有期中考试”与相邻句“没有期中”冲突，否定词影响实际安排，必须核查。",
        ),
      );
    const chars = text.replace(/[\s\p{P}\p{S}]/gu, "");
    const chinese = (chars.match(/[\u3400-\u9fff]/g) || []).length;
    if (
      (course.language === "zh" && /[가-힣ぁ-んァ-ン]/.test(chars)) ||
      (cue.end - cue.start > 7 && chinese < 3) ||
      /(.{2,5})\1{3,}/u.test(chars)
    )
      out.push(
        finding(
          [cue],
          "low-information",
          "识别含异常语言、长时间极少有效文字或机械重复；可能为环境噪声、旁话或漏识。保留原音频与原识别，核查后再决定是否纳入正文。",
          "medium",
        ),
      );
    if (
      /(?:三视图|基本视图)/.test(context) &&
      /(?:又增加|增加了).{0,30}(?:俯视图|左视图)/.test(text)
    )
      out.push(
        finding(
          [cue],
          "basic-views",
          "基本视图的枚举疑似重复三视图中已有名称。需区分讲者口误与误识；技术校注应与课堂原话分别记录。",
          "medium",
        ),
      );
  }
  const mechanical = /(?:剖视图|断面图|AutoCAD|计算机绘图|工程制图)/i.test(
    course.title + " " + cues.map(body).join(""),
  );
  if (mechanical) {
    const confusions: [RegExp, string][] = [
      [/像视图/, "向视图"],
      [/头晕.{0,5}轮廓|投晕/, "投影"],
      [/跨法几何/, "画法几何"],
      [
        /(?:吐槽|独床|同层).{0,15}(?:下[一节]|四杠|作业)|(?:下[一节]|四杠|作业).{0,20}(?:吐槽|独床|同层)/,
        "图层",
      ],
    ];
    for (const cue of cues) {
      const suspicious = confusions
        .filter(([pattern]) => pattern.test(body(cue)))
        .map(([, term]) => term);
      if (suspicious.length)
        out.push(
          finding(
            [cue],
            "technical-homophone",
            "专业术语疑似同音误识，候选为“" +
              suspicious.join("、") +
              "”。候选仅用于复核，不能凭术语表自动改写录音。",
            "medium",
          ),
        );
    }
  }
  if (report) {
    const ids = new Map(cues.map((c) => [c.id, c]));
    for (const fact of report.notices) {
      const sources = fact.cueIds
        .map((id) => ids.get(id))
        .filter((c): c is Cue => !!c);
      if (!sources.length) continue;
      const claim = normalizeSpokenNumbers(fact.text);
      const evidence = normalizeSpokenNumbers(sources.map(body).join(" "));
      const factNumbers = [...claim.matchAll(/\d+(?:-\d+)?(?:\.\d+)?/g)].map(
        (m) => m[0],
      );
      const sourceNumbers = new Set(
        [...evidence.matchAll(/\d+(?:-\d+)?(?:\.\d+)?/g)].map((m) => m[0]),
      );
      const unsupported = [
        ...new Set(factNumbers.filter((n) => !sourceNumbers.has(n))),
      ];
      if (unsupported.length)
        out.push(
          finding(
            sources,
            "report-number:" + unsupported.join(","),
            "整理后的通知包含来源片段未支持的数字/题号：" +
              unsupported.join("、") +
              "。应补充正确引用或退回文档生成，不能以有引用 ID 代替内容核查。",
          ),
        );
      if (
        /没有(?:期中|期末)/.test(claim) &&
        !/(?:没有|不考|无)(?:期中|期末)/.test(
          evidence.replace(/[，。啊呃\s]/g, ""),
        )
      )
        out.push(
          finding(
            sources,
            "report-negation",
            "整理后的考试否定结论缺少相应原句支持，应退回复核，禁止仅凭常识补写。",
          ),
        );
    }
  }
  return out;
}
