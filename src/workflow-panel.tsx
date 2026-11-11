import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Download,
  FileText,
  Headphones,
  Layers3,
  LoaderCircle,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import type { Course } from "./types";
import type { AuditItem, StudyReport } from "../server/study-report";
import type { WorkflowState } from "../server/workflow";
import "./workflow.css";

const clock = (n: number) => {
  const s = Math.floor(Math.max(0, n || 0));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
};
const active = (s?: string) => s === "running" || s === "queued";
const stageNames: Record<string, string> = {
  transcribe: "识别录音",
  crosscheck: "交叉核对",
  report: "整理文档",
  audit: "复查结果",
};
const statusNames: Record<string, string> = {
  queued: "等待开始",
  running: "正在处理",
  done: "本轮处理完成",
  needs_review: "有内容需要复核",
  error: "本轮处理未完成",
  interrupted: "处理已中断",
};
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch("/api" + url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw Object.assign(
      new Error(
        body?.error?.message ||
          body?.error ||
          body?.message ||
          "请求未完成，请稍后重试。",
      ),
      { status: res.status },
    );
  return body as T;
}
const payload = (value: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

export function WorkflowPanel({
  course,
  keywords,
  initialTerminologyOnly,
  initialTargetLanguage,
  onSource,
  onCourseChanged,
  autoStart,
  onAutoStarted,
}: {
  course: Course;
  keywords: string[];
  initialTerminologyOnly: boolean;
  initialTargetLanguage: string;
  onSource: (start: number, end: number) => void;
  onCourseChanged: (id: string) => Promise<void>;
  autoStart?: boolean;
  onAutoStarted?: () => void;
}) {
  const [state, setState] = useState<WorkflowState | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [view, setView] = useState<"report" | "audit" | null>(null),
    [options, setOptions] = useState(false),
    [targetLanguage, setTargetLanguage] = useState(initialTargetLanguage || "简体中文"),
    [terminologyOnly, setTerminologyOnly] = useState(initialTerminologyOnly),
    [existing, setExisting] = useState(false),
    [translate, setTranslate] = useState(false);
  const [filter, setFilter] = useState<"open" | "all">("open"),
    [raw, setRaw] = useState(false);
  const idRef = useRef(course.id);
  idRef.current = course.id;
  const lastRef = useRef("");
  const unresolved = state?.audit?.filter((a) => a.status === "open") || [];
  const report = state?.report;
  const running = active(state?.status);
  const load = async () => {
    try {
      const next = await request<WorkflowState | null>(
        `/courses/${course.id}/workflow`,
      );
      if (idRef.current === course.id) {
        setState(next);
        setError("");
      }
      return next;
    } catch (e) {
      if (
        (e as { status?: number }).status !== 404 &&
        idRef.current === course.id
      )
        setError((e as Error).message);
      return null;
    }
  };
  useEffect(() => {
    setLoading(true);
    setState(null);
    setView(null);
    setError("");
    lastRef.current = "";
    void load().then((next) => {
      if (!next?.options) return;
      setTargetLanguage(next.options.targetLanguage || initialTargetLanguage || "简体中文");
      setTerminologyOnly(next.options.terminologyOnly ?? initialTerminologyOnly);
      setExisting(!!next.options.useExistingTranscript);
      setTranslate(!!next.options.translate);
    }).finally(() => setLoading(false));
  }, [course.id]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void load();
    }, 2000);
    return () => clearInterval(timer);
  }, [state?.id, running, course.id]);
  useEffect(() => {
    if (
      !state ||
      state.courseId !== course.id ||
      active(state.status) ||
      lastRef.current === state.id + state.updatedAt
    )
      return;
    lastRef.current = state.id + state.updatedAt;
    void onCourseChanged(course.id);
    if (state.report)
      setView(state.status === "needs_review" ? "audit" : "report");
  }, [state?.id, state?.status, state?.updatedAt, course.id]);
  useEffect(() => {
    if (!autoStart || loading) return;
    onAutoStarted?.();
    if (!busy && !running) void start(false);
  }, [autoStart, loading]);
  async function start(useExisting = existing) {
    setBusy(true);
    setError("");
    try {
      const next = await request<WorkflowState>(
        `/courses/${course.id}/workflow`,
        payload({
          keywords,
          targetLanguage,
          terminologyOnly,
          translate,
          useExistingTranscript: useExisting,
        }),
      );
      if (idRef.current === course.id) {
        setState(next);
        setOptions(false);
        setView(null);
      }
    } catch (e) {
      if (idRef.current === course.id) setError((e as Error).message);
    } finally {
      if (idRef.current === course.id) setBusy(false);
    }
  }
  async function review(
    item: AuditItem,
    status: AuditItem["status"],
    note: string,
    correctedText: string,
    excludeFromReport: boolean,
  ) {
    const next = await request<AuditItem>(
      `/courses/${course.id}/reviews/${item.id}`,
      payload(
        {
          status,
          note,
          correctedText: excludeFromReport || status !== "confirmed" || item.cueIds.length !== 1
            ? undefined
            : correctedText.trim() || undefined,
          excludeFromReport: excludeFromReport && item.cueIds.length === 1,
        },
        "PATCH",
      ),
    );
    setState((old) =>
      old
        ? { ...old, audit: old.audit.map((a) => (a.id === next.id ? next : a)) }
        : old,
    );
    await load();
    await onCourseChanged(course.id);
  }
  async function recheck(item: AuditItem) {
    const next = await request<WorkflowState>(
      `/courses/${course.id}/reviews/${item.id}/recheck`,
      payload({}),
    );
    if (idRef.current === course.id) setState(next);
  }
  const stages =
    state?.stages ||
    Object.keys(stageNames).map((key) => ({
      key,
      status: "pending" as const,
      message: "",
    }));
  return (
    <section className="workflow-card" aria-label="整堂课处理与复查">
      <div className="workflow-heading">
        <span className="workflow-symbol">
          <Layers3 size={21} />
        </span>
        <div>
          <div className="workflow-eyebrow">从录音到可复习的课堂文档</div>
          <h2>整理整堂课，逐项查漏纠错。</h2>
          <p>
            {running
              ? state?.progress
              : state
                ? `${statusNames[state.status]}${unresolved.length ? ` · ${unresolved.length} 处待核对` : ""}`
                : course.media
                  ? "识别、交叉核对、分章整理、回查审阅，保留每一步的原始证据。"
                  : "先补充原始录音或视频，即可开始整堂课识别、整理和复查。"}
          </p>
        </div>
        <div className="workflow-heading-actions">
          <button
            className="icon-button"
            aria-label="处理选项"
            title="处理选项"
            onClick={() => setOptions(!options)}
          >
            <Settings2 size={17} />
          </button>
          <button
            className="button primary"
            disabled={busy || running || loading || !course.media}
            onClick={() => void start()}
          >
            {busy || running ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <SparkStart />
            )}
            {running
              ? "正在处理整堂课"
              : state
                ? "重新处理并复查"
                : "整堂课处理"}
          </button>
        </div>
      </div>
      {options && (
        <div className="workflow-options">
          <label>
            文档语言
            <select
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
            >
              {!["简体中文", "英语", "中英双语"].includes(targetLanguage) && (
                <option>{targetLanguage}</option>
              )}
              <option>简体中文</option>
              <option>英语</option>
              <option>中英双语</option>
            </select>
          </label>
          <label className="workflow-option-check">
            <input
              type="checkbox"
              checked={terminologyOnly}
              onChange={(e) => setTerminologyOnly(e.target.checked)}
            />
            仅专业术语使用目标语言
          </label>
          <label className="workflow-option-check">
            <input
              type="checkbox"
              checked={translate}
              onChange={(e) => setTranslate(e.target.checked)}
            />
            同时生成目标语言字幕
          </label>
          <label className="workflow-option-check">
            <input
              type="checkbox"
              checked={existing}
              onChange={(e) => setExisting(e.target.checked)}
            />
            复用同一录音已有的识别结果，继续整理与复查
          </label>
          <div className="workflow-keywords">
            <strong>本轮重点</strong>
            {keywords.length
              ? keywords.join("、")
              : "尚未设置，可在“我的重点”中修改"}
          </div>
        </div>
      )}
      {error && (
        <div className="workflow-error" role="alert">
          <AlertCircle size={15} />
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="关闭处理错误"
            onClick={() => setError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {state?.error && !error && (
        <div className="workflow-error">
          <AlertCircle size={15} />
          <span>{state.error}</span>
        </div>
      )}
      <ol className="workflow-stages">
        {stages.map((s, i) => (
          <li key={s.key} className={s.status}>
            <span className="workflow-stage-number">
              {s.status === "running" ? (
                <LoaderCircle size={14} className="spin" />
              ) : s.status === "done" ? (
                <Check size={14} />
              ) : s.status === "error" ? (
                <AlertCircle size={14} />
              ) : (
                String(i + 1).padStart(2, "0")
              )}
            </span>
            <div>
              <strong>{stageNames[s.key] || s.key}</strong>
              <small>
                {s.status === "running"
                  ? s.message || "正在进行…"
                  : s.status === "done"
                    ? "已完成"
                    : s.status === "skipped"
                      ? s.message || "本轮未运行"
                      : s.status === "error"
                        ? "需要重试"
                        : "等待处理"}
              </small>
            </div>
          </li>
        ))}
      </ol>
      <div className="workflow-navigation">
        <div>
          <button
            className={view === "report" ? "active" : ""}
            disabled={!report}
            onClick={() => setView(view === "report" ? null : "report")}
          >
            <FileText size={15} />
            课程文档{report && <span>已生成</span>}
            {view === "report" ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )}
          </button>
          <button
            className={view === "audit" ? "active" : ""}
            disabled={!state?.audit?.length && !report}
            onClick={() => setView(view === "audit" ? null : "audit")}
          >
            <ClipboardCheck size={15} />
            审查与回听
            {state?.audit?.length ? (
              <span className={unresolved.length ? "unresolved" : ""}>
                {unresolved.length} 待审
              </span>
            ) : null}
            {view === "audit" ? (
              <ChevronDown size={13} />
            ) : (
              <ChevronRight size={13} />
            )}
          </button>
        </div>
        <span>
          {running
            ? "可继续回放课程，离开后重新打开会恢复进度。"
            : state?.updatedAt
              ? `保存于 ${new Date(state.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" })}`
              : "处理过程与结果会自动保存"}
        </span>
      </div>
      {view === "report" && report && (
        <div className="study-document">
          <div className="study-document-toolbar">
            <div>
              <strong>课堂整理稿</strong>
              <small>
                {report.method === "model-assisted"
                  ? "依据录音识别与模型整理"
                  : "依据识别原文提取"}
                {unresolved.length
                  ? ` · 仍有 ${unresolved.length} 处待核对`
                  : " · 可逐段回听出处"}
              </small>
            </div>
            <button className="button subtle" onClick={() => setRaw(!raw)}>
              {raw ? "排版预览" : "Markdown 原文"}
            </button>
            <a
              className="button subtle"
              href={`/api/courses/${course.id}/report?format=md`}
              download
            >
              <Download size={14} />
              导出文档
            </a>
          </div>
          {report.warnings?.length > 0 && (
            <div className="report-warnings">
              <AlertCircle size={15} />
              <div>
                {report.warnings.map((warning, i) => (
                  <p key={i}>{warning}</p>
                ))}
              </div>
            </div>
          )}
          {raw ? (
            <pre className="report-markdown">{report.markdown}</pre>
          ) : (
            <ReportReader report={report} onSource={onSource} />
          )}
        </div>
      )}
      {view === "audit" && state && (
        <div className="audit-center">
          <div className="audit-heading">
            <div>
              <h3>让每一处修改，都有依据。</h3>
              <p>
                回听录音、比较识别结果，再决定是否修正。原始识别文本始终保留。
              </p>
            </div>
            <div className="audit-filter">
              <button
                className={filter === "open" ? "active" : ""}
                onClick={() => setFilter("open")}
              >
                待核对 {unresolved.length}
              </button>
              <button
                className={filter === "all" ? "active" : ""}
                onClick={() => setFilter("all")}
              >
                全部 {state.audit.length}
              </button>
            </div>
          </div>
          <div className="audit-summary">
            <span>
              <AlertCircle size={14} />
              {unresolved.length} 处待核对
            </span>
            <span>
              <CheckCircle2 size={14} />
              {state.audit.filter((a) => a.status === "confirmed").length}{" "}
              处已确认
            </span>
            <span>
              <ShieldCheck size={14} />
              {state.audit.filter((a) => a.status === "dismissed").length}{" "}
              处无需修改
            </span>
          </div>
          <div className="audit-list">
            {state.audit
              .filter((a) => filter === "all" || a.status === "open")
              .map((item) => (
                <AuditCard
                  key={item.id}
                  item={item}
                  onSource={onSource}
                  onReview={review}
                  onRecheck={recheck}
                  processing={running}
                />
              ))}
            {!state.audit.some(
              (a) => filter === "all" || a.status === "open",
            ) && (
              <div className="audit-empty">
                <CheckCircle2 size={30} />
                <h4>
                  {filter === "open" ? "本轮没有待核对条目" : "暂无审查条目"}
                </h4>
                <p>
                  仍可在文档中点击时间标记回听原始录音。
                  <br />
                  自动检查不能保证每一句话都识别正确。
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SparkStart() {
  return <RefreshCw size={15} />;
}
function SourceButton({
  start,
  end,
  onSource,
}: {
  start: number;
  end: number;
  onSource: (start: number, end: number) => void;
}) {
  return (
    <button
      className="report-source"
      onClick={() => onSource(start, end)}
      title={`回听 ${clock(start)} 至 ${clock(end)}`}
    >
      <Headphones size={12} />
      {clock(start)}
      <ArrowUpRight size={11} />
    </button>
  );
}
function ReportReader({
  report,
  onSource,
}: {
  report: StudyReport;
  onSource: (start: number, end: number) => void;
}) {
  const categories = [...new Set(report.notices.map((n) => n.category))];
  const names = {
    assignment: "作业",
    exam: "考试",
    schedule: "课程安排",
    reminder: "其他提醒",
    focus: "指定重点",
  };
  return (
    <article className="report-reader">
      <div className="report-title">
        <span>COURSE STUDY NOTES</span>
        <h2>{report.title}</h2>
        <p>原始录音 → 识别与交叉核对 → 文档整理 → 审查</p>
      </div>
      <h2>一、老师口头通知与重要事项</h2>
      {categories.length ? (
        categories.map((category) => (
          <section key={category}>
            <h3>{names[category]}</h3>
            <ol>
              {report.notices
                .filter((n) => n.category === category)
                .map((n, i) => (
                  <li key={i}>
                    <p>{n.text}</p>
                    <SourceButton
                      start={n.start}
                      end={n.end}
                      onSource={onSource}
                    />
                  </li>
                ))}
            </ol>
          </section>
        ))
      ) : (
        <p className="report-no-notices">
          本轮没有提取到可确认的课程通知。请结合重点关键词与原始录音核对。
        </p>
      )}
      <h2>二、课程内容逐字稿</h2>
      {report.sections.map((section, i) => (
        <section className="report-chapter" key={i}>
          <h3>{section.title}</h3>
          {section.abstract && (
            <div className="report-abstract">
              <strong>本节摘要</strong>
              <p>{section.abstract}</p>
            </div>
          )}
          {section.paragraphs.map((paragraph, j) => (
            <div className="report-paragraph" key={j}>
              <p>{paragraph.text}</p>
              <SourceButton
                start={paragraph.start}
                end={paragraph.end}
                onSource={onSource}
              />
            </div>
          ))}
        </section>
      ))}
    </article>
  );
}

function AuditCard({
  item,
  onSource,
  onReview,
  onRecheck,
  processing,
}: {
  item: AuditItem;
  onSource: (start: number, end: number) => void;
  onReview: (
    item: AuditItem,
    status: AuditItem["status"],
    note: string,
    correctedText: string,
    excludeFromReport: boolean,
  ) => Promise<void>;
  onRecheck: (item: AuditItem) => Promise<void>;
  processing: boolean;
}) {
  const [expanded, setExpanded] = useState(false),
    [note, setNote] = useState(item.note || ""),
    [correction, setCorrection] = useState(item.correctedText || item.proposedText || ""),
    [exclude, setExclude] = useState(!!item.excludeFromReport),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setNote(item.note || "");
    setCorrection(item.correctedText || item.proposedText || "");
    setExclude(!!item.excludeFromReport);
  }, [item.note, item.correctedText, item.proposedText, item.excludeFromReport]);
  async function recheck() {
    setBusy(true);
    setError("");
    try {
      await onRecheck(item);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(status: AuditItem["status"]) {
    if (status !== "open" && !note.trim()) {
      setError("请写明回听结论或排除理由，保留本次核对依据。");
      return;
    }
    if (status === "open" && exclude) {
      setError("排除正文前，请填写核对依据并确认本项审查结论。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onReview(item, status, note, correction, exclude);
      setExpanded(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={"audit-card " + item.status}>
      <div className="audit-card-heading">
        <span className={"audit-severity " + item.severity}>
          {item.severity === "high"
            ? "重点核对"
            : item.severity === "medium"
              ? "建议核对"
              : "回查提示"}
        </span>
        <strong>{item.message}</strong>
        <span className="audit-status-label">
          {item.status === "confirmed"
            ? "已确认"
            : item.status === "dismissed"
              ? "已核对，无需修改"
              : "待核对"}
        </span>
      </div>
      <div className="audit-comparison">
        <div>
          <label>原始识别</label>
          <p>{item.primary || "此处未识别到文字"}</p>
        </div>
        {item.secondary && (
          <div>
            <label>交叉识别</label>
            <p>{item.secondary}</p>
          </div>
        )}
      </div>
      {item.excludeFromReport && (
        <p className="audit-excluded">
          本段已从整理稿正文排除，原录音与识别记录仍保留。
        </p>
      )}
      {item.correctedText && (
        <div className="audit-corrected">
          <strong>确认修正</strong>
          <p>{item.correctedText}</p>
        </div>
      )}
      {item.proposedText && item.proposedText !== item.correctedText && (
        <div className="audit-proposal">
          <strong>待核对的修正建议 · 尚未写入字幕</strong>
          <p>{item.proposedText}</p>
        </div>
      )}
      {item.checks?.map((check, i) => (
        <div className="audit-check" key={check.createdAt + i}>
          <strong>独立录音复核 · {check.engine}</strong>
          <p>{check.error || check.text || "本次未识别出文字，请回听原始录音。"}</p>
        </div>
      ))}
      {item.note && <p className="audit-review-note">审阅记录：{item.note}</p>}
      <div className="audit-card-actions">
        <button
          className="listen-source"
          onClick={() => onSource(item.start, item.end)}
        >
          <Play size={13} />
          {clock(item.start)} — {clock(item.end)} · 回听这一段
        </button>
        <button onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : "核对与修正"}
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>
      {error && !expanded && (
        <p className="audit-edit-error" role="alert">{error}</p>
      )}
      {expanded && (
        <div className="audit-edit">
          <button
            className="audit-recheck"
            disabled={busy || processing || item.end - item.start > 180}
            onClick={() => void recheck()}
            title={item.end - item.start > 180 ? "超过三分钟的审查项请先在播放器选择更小片段" : "用第三个声学模型重新识别这段原录音，保留独立结果供对照"}
          >
            {busy ? <LoaderCircle size={13} className="spin" /> : <Headphones size={13} />}
            第三模型复核此段录音
          </button>
          <label>
            修正后的文字{item.cueIds.length !== 1 ? "（多段内容请在字幕列表逐段修正）" : ""}
            <textarea
              aria-label={`修正文字 ${clock(item.start)}`}
              value={correction}
              disabled={exclude || item.cueIds.length !== 1}
              onChange={(e) => setCorrection(e.target.value)}
              placeholder="只填写有录音依据的修正；无需修改时可以留空。"
            />
          </label>
          <label>
            核对依据 / 备注
            <textarea
              aria-label={`核对备注 ${clock(item.start)}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：已回听，老师说的是第12周。"
            />
          </label>
          {item.cueIds.length === 1 && (
            <label className="audit-exclude-option">
              <input
                type="checkbox"
                checked={exclude}
                onChange={(e) => setExclude(e.target.checked)}
              />
              这是噪声或旁话，从整理稿正文排除（原识别保留）
            </label>
          )}
          {item.cueIds.length > 1 && (
            <p className="audit-review-note">此项涉及多段内容；请在字幕列表逐段修正，避免影响其他通知或课堂内容。</p>
          )}
          {error && (
            <p className="audit-edit-error" role="alert">
              {error}
            </p>
          )}
          <div>
            <button disabled={busy || processing} onClick={() => void save("open")}>
              保存为待核对
            </button>
            <button
              className="button subtle"
              disabled={busy || processing}
              onClick={() => void save("dismissed")}
            >
              已核对，无需修改
            </button>
            <button
              className="button primary"
              disabled={busy || processing}
              onClick={() => void save("confirmed")}
            >
              {busy ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Check size={13} />
              )}
              确认此处
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
