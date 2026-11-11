import test from "node:test";
import assert from "node:assert/strict";
import {
  semanticAudit,
  normalizeSpokenNumbers,
} from "../server/semantic-audit.ts";
import type { Course } from "../src/types.ts";
import type { StudyReport } from "../server/study-report.ts";
const lecture = (texts: string[]): Course => ({
  id: "test",
  title: "工程制图",
  createdAt: "",
  updatedAt: "",
  language: "zh",
  keywords: [],
  documents: [],
  timing: "exact",
  chapters: [],
  cues: texts.map((text, i) => ({
    id: "s" + i,
    start: i * 30,
    end: (i + 1) * 30,
    text,
  })),
});
test("shared acoustic errors still trigger contradiction review instead of passing by model agreement", () => {
  const c = lecture([
    "我们这个课能有期中考试，虽然没有期中。",
    "虽然没有期末考试，我们最终考试是笔试两个小时。",
    "期末笔试是开卷，三十分填空选择、七十分画图分析。",
  ]);
  const findings = semanticAudit(c);
  assert.ok(
    findings.some((f) => f.message.includes("期中") && f.severity === "high"),
  );
  assert.ok(
    findings.some(
      (f) => f.message.includes("没有期末") && f.cueIds.includes("s1"),
    ),
  );
  assert.ok(findings.every((f) => f.status === "open"));
});
test("spoken homework and score numbers normalize without changing unrelated technical words", () => {
  assert.equal(
    normalizeSpokenNumbers(
      "三杠一到三杠七，三杠十到三杠十二；三十分选择，七十分分析；十二周，两小时。",
    ),
    "3-1到3-7，3-10到3-12；30分选择，70分分析；12周，2小时。",
  );
  assert.equal(
    normalizeSpokenNumbers("一部分内容用三视图表示"),
    "一部分内容用三视图表示",
  );
});
test("generated reports with unsupported scores are returned to review despite valid citation IDs", () => {
  const c = lecture(["考试三十分选择，七十分分析。"]);
  const report = {
    title: "课",
    keywords: [],
    notices: [
      {
        category: "exam",
        text: "考试五十分选择，五十分分析",
        cueIds: ["s0"],
        start: 0,
        end: 30,
      },
    ],
    sections: [],
    warnings: [],
    markdown: "",
    generatedAt: "",
    method: "model-assisted",
  } as StudyReport;
  assert.ok(
    semanticAudit(c, report).some(
      (f) => f.message.includes("50") && f.message.includes("未支持"),
    ),
  );
  report.notices[0].text = "考试30分选择，70分分析";
  assert.ok(
    !semanticAudit(c, report).some((f) => f.message.includes("未支持")),
  );
});
test("background nonsense and suspected terminology are flagged without overwriting source text", () => {
  const c = lecture([
    "どうか。",
    "投影的轮廓线与头晕的轮廓线不一致。",
    "像视图是表达零件的方式。",
  ]);
  const original = structuredClone(c);
  const findings = semanticAudit(c);
  assert.ok(findings.some((f) => f.message.includes("异常语言")));
  assert.ok(findings.some((f) => f.message.includes("向视图")));
  assert.deepEqual(c, original);
});
