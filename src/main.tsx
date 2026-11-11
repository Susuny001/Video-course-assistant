import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  Upload,
  Headphones,
  ChevronRight,
  Download,
  Settings,
  Plus,
  Search,
  X,
  ArrowUpRight,
  Play,
  Pause,
  FileText,
  Sparkles,
  MessageSquare,
  ListTree,
  Check,
  AlertCircle,
  RotateCcw,
  Volume2,
  Bookmark,
  Trash2,
  Clock3,
  Layers3,
  ArrowUp,
  SlidersHorizontal,
  RefreshCw,
  LoaderCircle,
  CheckCircle2,
  Menu,
  Scissors,
  Languages,
  Film,
} from "lucide-react";
import type {
  Course,
  Cue,
  Highlight,
  ProviderSettings,
  ChatMessage,
  ChatResult,
  Job,
} from "./types";
import "./style.css";
import { buildVtt } from "./subtitles";

const DEFAULT_KEYWORDS = ["作业", "大作业", "期末", "开卷", "下节课", "提醒"];
const initialSettings: ProviderSettings = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  speechModel: "whisper-1",
  language: "英语",
  terminologyOnly: false,
  reasoningEffort: "none",
};
const time = (n: number) => {
  const s = Math.max(0, Math.floor(n || 0));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
};
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch("/api" + url, init);
  const data = await response
    .json()
    .catch(() => ({ error: `请求失败 (${response.status})` }));
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : data.error?.message ||
          data.message ||
          `请求失败 (${response.status})`,
    );
  return data as T;
}
const json = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
function downloadText(name: string, value: string) {
  const url = URL.createObjectURL(
    new Blob([value], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function saved<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function App() {
  const [courses, setCourses] = useState<Course[]>([]),
    [course, setCourse] = useState<Course | null>(null),
    [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"outline" | "highlights" | "chat">("outline"),
    [modal, setModal] = useState<"import" | "settings" | "export" | null>(null),
    [sidebar, setSidebar] = useState(false);
  const [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [settings, setSettings] = useState(initialSettings);
  const [current, setCurrent] = useState(0),
    [playing, setPlaying] = useState(false),
    [range, setRange] = useState<[number, number] | null>(null),
    [repeat, setRepeat] = useState(false),
    [rate, setRate] = useState("1");
  const [localSpeech, setLocalSpeech] = useState<{
    ready: boolean;
    message: string;
  }>({ ready: false, message: "" });
  const [appendImport, setAppendImport] = useState(false);
  const [subtitleUrl, setSubtitleUrl] = useState("");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [query, setQuery] = useState(""),
    [caption, setCaption] = useState<"original" | "bilingual" | "corrected">(
      "original",
    ),
    [follow, setFollow] = useState(true);
  const [keywords, setKeywords] = useState(DEFAULT_KEYWORDS.join("，")),
    [highlights, setHighlights] = useState<Highlight[]>([]),
    [keywordBusy, setKeywordBusy] = useState(false);
  const [messages, setMessages] = useState<
      (ChatMessage & { sources?: ChatResult["sources"]; mode?: string })[]
    >([]),
    [question, setQuestion] = useState(""),
    [chatBusy, setChatBusy] = useState(false),
    [vision, setVision] = useState(false);
  const [job, setJob] = useState<Job | null>(null),
    [jobBusy, setJobBusy] = useState(false),
    [notes, setNotes] = useState("");
  const courseIdRef = useRef<string | undefined>(undefined);
  courseIdRef.current = course?.id;
  const media = useRef<HTMLMediaElement | null>(null),
    chatBottom = useRef<HTMLDivElement | null>(null),
    activeRow = useRef<HTMLDivElement | null>(null);
  const duration = course?.media?.duration || course?.cues.at(-1)?.end || 1;
  const openDocument = course?.documents.find((d) => d.id === documentId);
  const activeCue = course?.cues.find(
    (c) => c.start <= current && c.end > current,
  );
  const activeChapter = course?.chapters.find(
    (c) => c.start <= current && c.end > current,
  );
  const keywordList = keywords
    .split(/[,，;；\n]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  const filtered =
    course?.cues.filter(
      (c) =>
        !query ||
        (c.text + " " + c.translation + " " + c.correctedText)
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) || [];
  function openImport(append = false) {
    setAppendImport(append);
    setModal("import");
  }
  useEffect(() => {
    if (!course?.cues.length) {
      setSubtitleUrl("");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([buildVtt(course.cues, caption)], { type: "text/vtt" }),
    );
    setSubtitleUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [course?.cues, caption]);
  const notify = (s: string) => {
    setToast(s);
    setTimeout(() => setToast(""), 4000);
  };
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : "操作失败，请重试");
  async function refresh(id?: string) {
    const list = await api<Course[]>("/courses");
    setCourses(list);
    if (id) {
      const c = await api<Course>("/courses/" + id);
      setCourse(c);
    } else if (!course && list[0])
      setCourse(await api<Course>("/courses/" + list[0].id));
  }
  useEffect(() => {
    Promise.all([
      refresh(),
      api<{ ready: boolean; message: string }>("/local-asr")
        .then(setLocalSpeech)
        .catch(() => {}),
      api<ProviderSettings>("/settings").then((s) =>
        setSettings({ ...initialSettings, ...s }),
      ),
    ])
      .catch(fail)
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!course) return;
    setCurrent(0);
    setRange(null);
    setQuery("");
    setPlaying(false);
    setChatBusy(false);
    setDocumentId(null);
    setHighlights([]);
    setKeywords(
      (course.keywords?.length ? course.keywords : DEFAULT_KEYWORDS).join("，"),
    );
    setMessages(saved("chat:" + course.id, []));
    setNotes(saved("notes:" + course.id, ""));
    setJob(null);
    setJobBusy(false);
  }, [course?.id]);
  useEffect(() => {
    if (course) {
      localStorage.setItem("chat:" + course.id, JSON.stringify(messages));
    }
  }, [messages]);
  useEffect(() => {
    chatBottom.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [messages, chatBusy]);
  useEffect(() => {
    if (playing && follow)
      activeRow.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }, [activeCue?.id, playing, follow]);
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "error") return;
    const timer = setInterval(() => {
      api<Job>("/jobs/" + job.id)
        .then(async (j) => {
          setJob(j);
          if (j.status === "done") {
            setJobBusy(false);
            await refresh(j.courseId);
            if (j.type === "translate") setCaption("bilingual");
            if (j.type === "correct") setCaption("corrected");
            notify("处理完成，课程内容已更新");
          }
          if (j.status === "error") {
            setJobBusy(false);
            setError(j.error || "模型处理失败");
          }
        })
        .catch((e) => {
          setJobBusy(false);
          setJob(null);
          fail(e);
        });
    }, 1200);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModal(null);
        setDocumentId(null);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          "input,textarea,select,button,[contenteditable]",
        ) ||
        modal
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
      if (e.code === "ArrowRight") {
        e.preventDefault();
        seek(current + 5);
      }
      if (e.code === "ArrowLeft") {
        e.preventDefault();
        seek(current - 5);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [current, modal, course?.media]);
  function seek(value: number) {
    const t = Math.max(0, Math.min(duration, value));
    setCurrent(t);
    if (media.current) media.current.currentTime = t;
  }
  function syncDuration(element: HTMLMediaElement) {
    element.playbackRate = Number(rate);
    const d = element.duration;
    if (
      course &&
      Number.isFinite(d) &&
      d > 0 &&
      Math.abs((course.media?.duration || 0) - d) > 0.5
    ) {
      api<Course>("/courses/" + course.id, {
        ...json({ duration: d }),
        method: "PATCH",
      })
        .then((c) => setCourse(c))
        .catch(fail);
    }
  }
  function togglePlay() {
    if (!media.current) {
      notify("先导入录音或视频，即可播放并同步字幕");
      return;
    }
    if (media.current.paused) media.current.play().catch(fail);
    else media.current.pause();
  }
  async function selectCourse(c: Course) {
    try {
      setCourse(await api<Course>("/courses/" + c.id));
      setSidebar(false);
    } catch (e) {
      fail(e);
    }
  }
  async function extract() {
    if (!course) return;
    const id = course.id;
    setKeywordBusy(true);
    try {
      await api("/courses/" + course.id, {
        ...json({ keywords: keywordList }),
        method: "PATCH",
      });
      const hits = await api<Highlight[]>(
        "/courses/" +
          id +
          "/highlights?keywords=" +
          encodeURIComponent(keywordList.join(",")),
      );
      if (courseIdRef.current === id) setHighlights(hits);
    } catch (e) {
      fail(e);
    } finally {
      setKeywordBusy(false);
    }
  }
  useEffect(() => {
    if (tab === "highlights" && course) void extract();
  }, [tab, course?.id]);
  async function startJob(type: string) {
    if (!course || jobBusy) return;
    setJobBusy(true);
    try {
      const j = await api<Job>(
        "/courses/" + course.id + "/jobs",
        json({
          type,
          ...(type === "transcribe" && localSpeech.ready
            ? { engine: "local" }
            : {}),
          ...(range ? { start: range[0], end: range[1] } : {}),
        }),
      );
      setJob(j);
    } catch (e) {
      fail(e);
      setJobBusy(false);
    }
  }
  async function ask(text = question) {
    if (!course || !text.trim() || chatBusy) return;
    const id = course.id;
    setQuestion("");
    const prev = messages;
    setMessages([...prev, { role: "user", content: text.trim() }]);
    setChatBusy(true);
    try {
      const res = await api<ChatResult>(
        "/courses/" + course.id + "/chat",
        json({
          question: text.trim(),
          history: prev.slice(-8),
          useVision: vision,
          ...(range ? { start: range[0], end: range[1] } : {}),
        }),
      );
      if (courseIdRef.current !== id) return;
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: res.answer,
          sources: res.sources,
          mode: res.mode,
        },
      ]);
    } catch (e) {
      if (courseIdRef.current !== id) return;
      fail(e);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `本次回答未生成：${e instanceof Error ? e.message : "请求失败"}。你可以重试或检查模型设置。`,
        },
      ]);
    } finally {
      if (courseIdRef.current === id) setChatBusy(false);
    }
  }
  function selectCue(c: Cue) {
    setRange((old) =>
      old
        ? [Math.min(old[0], c.start), Math.max(old[1], c.end)]
        : [c.start, c.end],
    );
  }
  const currentSource =
    caption === "corrected"
      ? activeCue?.correctedText || activeCue?.text
      : activeCue?.text;

  return (
    <div className="app-shell">
      <aside className={"sidebar " + (sidebar ? "show" : "")}>
        <a href="/" className="brand">
          <span className="brand-icon">
            <Layers3 size={23} />
          </span>
          <strong>
            知课<span>course companion</span>
          </strong>
        </a>
        <div className="workspace-tag">
          <span className="avatar">我</span>
          <div>
            我的学习空间<small>LOCAL WORKSPACE</small>
          </div>
          <span className="status-dot" />
        </div>
        <button className="import-side" onClick={() => openImport(false)}>
          <Plus size={17} />
          导入一堂新课
        </button>
        <div className="nav-label">
          学习资料库 <span>{courses.length.toString().padStart(2, "0")}</span>
        </div>
        <div className="course-list">
          {courses.map((c) => (
            <div
              className={"course-nav " + (c.id === course?.id ? "active" : "")}
              key={c.id}
            >
              <button onClick={() => selectCourse(c)}>
                <BookOpen size={17} />
                <span>{c.title}</span>
              </button>
              <button
                className="delete-course icon-button"
                title="删除课程"
                aria-label={"删除" + c.title}
                onClick={async () => {
                  if (!confirm("删除这门课及其本地资料？此操作不可撤销。"))
                    return;
                  try {
                    await api("/courses/" + c.id, { method: "DELETE" });
                    if (course?.id === c.id) setCourse(null);
                    const list = await api<Course[]>("/courses");
                    setCourses(list);
                    if (list[0])
                      setCourse(await api<Course>("/courses/" + list[0].id));
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="quiet-card">
            <span className="tiny-spark">
              <Sparkles size={15} />
            </span>
            <strong>让重点，不再错过。</strong>
            <p>
              从课堂里的每一句话，
              <br />
              找到对你有用的知识。
            </p>
          </div>
          <button
            className="settings-link"
            onClick={() => setModal("settings")}
          >
            <Settings size={17} />
            模型与偏好设置
            <ChevronRight size={14} />
          </button>
          <div className="local-label">
            <span className="status-dot" />
            资料保存在本机
          </div>
        </div>
      </aside>
      {sidebar && (
        <div className="sidebar-scrim" onClick={() => setSidebar(false)} />
      )}
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-menu icon-button"
              aria-label="打开资料库"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </button>
            <BookOpen size={15} />
            <span>我的课程</span>
            <ChevronRight size={13} />
            <strong>{course?.title || "学习工作台"}</strong>
          </div>
          <div className="top-actions">
            <span className="save-status">
              <CheckCircle2 size={14} />
              本地存储
            </span>
            <button
              className="button subtle"
              onClick={() => setModal("export")}
              disabled={!course}
            >
              <Download size={15} />
              导出笔记
            </button>
            <button
              className="avatar small"
              onClick={() => setModal("settings")}
              aria-label="偏好设置"
            >
              我
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={17} />
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="关闭错误"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {loading ? (
          <div className="loading-screen">
            <LoaderCircle className="spin" />
            正在整理你的学习空间…
          </div>
        ) : !course ? (
          <div className="empty-workspace">
            <BookOpen size={44} />
            <h1>每一堂课，都值得学明白。</h1>
            <p>导入录音、视频或文字稿，创建你的第一门课。</p>
            <button
              className="button primary"
              onClick={() => openImport(false)}
            >
              <Plus size={17} />
              导入课程
            </button>
          </div>
        ) : (
          <main>
            <section className="course-heading">
              <div>
                <div className="eyebrow">
                  <span />
                  YOUR LEARNING, IN FOCUS
                </div>
                <h1>{course.title}</h1>
                <p>
                  <span>
                    <Headphones size={14} />
                    {course.media ? "音视频已导入" : "文字稿学习模式"}
                  </span>
                  <i />
                  <span>{course.chapters.length} 个章节</span>
                  <i />
                  <span>{course.cues.length} 条字幕</span>
                  <i />
                  <span
                    className={course.timing === "estimated" ? "estimated" : ""}
                  >
                    {course.timing === "estimated"
                      ? "时间为文字估算"
                      : course.timing === "exact"
                        ? "含真实时间戳"
                        : "等待转录"}
                  </span>
                </p>
              </div>
              <button
                className="button subtle attach-button"
                onClick={() => openImport(true)}
              >
                <Upload size={15} />
                补充资料
              </button>
            </section>
            <div className="study-grid">
              <div className="study-left">
                <section className="player-card">
                  <div
                    className={
                      "media-stage " +
                      (course.media?.type.startsWith("video")
                        ? "has-video"
                        : "")
                    }
                  >
                    {course.media ? (
                      <>
                        {course.media.type.startsWith("video") ? (
                          <video
                            key={course.media.url}
                            ref={(el) => {
                              media.current = el;
                            }}
                            src={course.media.url}
                            onTimeUpdate={(e) => {
                              const t = e.currentTarget.currentTime;
                              if (repeat && range && t >= range[1])
                                e.currentTarget.currentTime = range[0];
                              else setCurrent(t);
                            }}
                            onPlay={() => setPlaying(true)}
                            onPause={() => setPlaying(false)}
                            onEnded={() => setPlaying(false)}
                            onLoadedMetadata={(e) => {
                              syncDuration(e.currentTarget);
                            }}
                            controls
                          >
                            {subtitleUrl && (
                              <track
                                key={subtitleUrl}
                                kind="subtitles"
                                label="课程字幕"
                                srcLang={course.language || "zh"}
                                src={subtitleUrl}
                                default
                              />
                            )}
                          </video>
                        ) : (
                          <audio
                            key={course.media.url}
                            ref={(el) => {
                              media.current = el;
                            }}
                            src={course.media.url}
                            onTimeUpdate={(e) => {
                              const t = e.currentTarget.currentTime;
                              if (repeat && range && t >= range[1])
                                e.currentTarget.currentTime = range[0];
                              else setCurrent(t);
                            }}
                            onPlay={() => setPlaying(true)}
                            onPause={() => setPlaying(false)}
                            onEnded={() => setPlaying(false)}
                            onLoadedMetadata={(e) => {
                              syncDuration(e.currentTarget);
                            }}
                          />
                        )}
                      </>
                    ) : null}
                    {!course.media?.type.startsWith("video") && (
                      <>
                        <div className="stage-grid" />
                        <div className="stage-top">
                          <span>
                            <span className="record-dot" />
                            {course.media
                              ? "AUDIO CLASSROOM"
                              : "COURSE NOTEBOOK"}
                          </span>
                          <span>知课 / 01</span>
                        </div>
                        <div className="stage-art">
                          <EngineeringArt />
                          <div className="stage-copy">
                            <span>跟着自己的节奏，学懂每一课</span>
                            <h2>
                              {activeChapter?.title ||
                                course.chapters[0]?.title ||
                                "让课堂里的知识，清晰起来。"}
                            </h2>
                            <p>
                              {course.media
                                ? course.media.name
                                : "导入录音或视频，连接文字与声音"}
                            </p>
                          </div>
                        </div>
                        <div className="stage-bottom">
                          <span>
                            {course.media ? (
                              <>
                                <Volume2 size={14} />
                                音频课堂
                              </>
                            ) : (
                              <>
                                <FileText size={14} />
                                已载入文字稿
                              </>
                            )}
                          </span>
                          {!course.media && (
                            <button onClick={() => openImport(true)}>
                              <Plus size={13} />
                              添加录音 / 视频
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="live-caption">
                    <span className="caption-badge">
                      {caption === "corrected" ? "校对" : "原文"}
                    </span>
                    <div>
                      <p>
                        {currentSource || "选择下方文字，开始浏览课程内容。"}
                      </p>
                      {caption === "bilingual" && (
                        <p className="translated-caption">
                          {activeCue?.translation ||
                            "此段尚未翻译 · 可在字幕工具中生成双语字幕"}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="player-controls">
                    <div className="timeline">
                      <input
                        type="range"
                        min="0"
                        max={duration}
                        step="0.1"
                        value={Math.min(current, duration)}
                        onChange={(e) => seek(+e.target.value)}
                        aria-label="播放进度"
                        style={
                          {
                            "--progress": `${(current / duration) * 100}%`,
                          } as React.CSSProperties
                        }
                      />
                      <div className="chapter-markers">
                        {course.chapters.slice(1).map((ch) => (
                          <span
                            key={ch.id}
                            style={{ left: (ch.start / duration) * 100 + "%" }}
                            title={ch.title}
                          />
                        ))}
                      </div>
                      {range && (
                        <div
                          className="range-track"
                          style={{
                            left: (range[0] / duration) * 100 + "%",
                            width:
                              ((range[1] - range[0]) / duration) * 100 + "%",
                          }}
                        />
                      )}
                    </div>
                    <div className="playback-row">
                      <button
                        className="play-button"
                        aria-label={playing ? "暂停" : "播放"}
                        onClick={togglePlay}
                      >
                        {playing ? (
                          <Pause size={17} fill="currentColor" />
                        ) : (
                          <Play size={17} fill="currentColor" />
                        )}
                      </button>
                      <button
                        className="icon-button"
                        onClick={() => seek(current - 10)}
                        aria-label="后退十秒"
                        title="后退 10 秒"
                      >
                        <RotateCcw size={17} />
                      </button>
                      <span className="time-display">
                        {time(current)}
                        <span>
                          {" "}
                          / {time(duration)}
                          {course.timing === "estimated" ? "（估算）" : ""}
                        </span>
                      </span>
                      <div className="playback-right">
                        <select
                          value={rate}
                          onChange={(e) => {
                            setRate(e.target.value);
                            if (media.current)
                              media.current.playbackRate = +e.target.value;
                          }}
                          aria-label="播放倍速"
                        >
                          {["0.5", "0.75", "1", "1.25", "1.5", "1.75", "2"].map(
                            (r) => (
                              <option key={r} value={r}>
                                {r}×
                              </option>
                            ),
                          )}
                        </select>
                        <button
                          className={
                            "icon-button " + (repeat ? "selected" : "")
                          }
                          onClick={() => {
                            if (!range) {
                              notify("先勾选字幕，设置需要循环的范围");
                              return;
                            }
                            setRepeat(!repeat);
                          }}
                          title="循环选段"
                          aria-label="循环选段"
                        >
                          <RefreshCw size={16} />
                        </button>
                        <button
                          className="icon-button"
                          onClick={() =>
                            setRange([
                              Math.min(current, Math.max(0, duration - 0.1)),
                              Math.min(duration, current + 60),
                            ])
                          }
                          title="设置选段范围"
                          aria-label="设置选段范围"
                        >
                          <Scissors size={16} />
                        </button>
                        <button
                          className="icon-button"
                          title="模型设置"
                          aria-label="打开模型设置"
                          onClick={() => setModal("settings")}
                        >
                          <SlidersHorizontal size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                  <RangeEditor
                    range={range}
                    duration={duration}
                    onChange={setRange}
                    onSeek={seek}
                  />
                </section>
                <section className="transcript-card">
                  <div className="section-toolbar">
                    <div className="section-title">
                      <FileText size={17} />
                      <h2>课堂文字稿</h2>
                      <span>{course.cues.length}</span>
                    </div>
                    <div className="transcript-options">
                      <select
                        value={caption}
                        aria-label="字幕显示方式"
                        onChange={(e) =>
                          setCaption(e.target.value as typeof caption)
                        }
                      >
                        <option value="original">原文</option>
                        <option value="bilingual">双语对照</option>
                        <option value="corrected">校对文本</option>
                      </select>
                      <label>
                        <input
                          type="checkbox"
                          checked={follow}
                          onChange={(e) => setFollow(e.target.checked)}
                        />
                        跟随播放
                      </label>
                    </div>
                  </div>
                  <div className="transcript-tools">
                    <label className="search-field">
                      <Search size={15} />
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="在课程中搜索…"
                        aria-label="搜索文字稿"
                      />
                      {query && (
                        <button
                          className="icon-button"
                          onClick={() => setQuery("")}
                          aria-label="清空搜索"
                        >
                          <X size={13} />
                        </button>
                      )}
                    </label>
                    <div>
                      <button
                        title={
                          localSpeech.ready
                            ? "无需 API Key，本机识别录音并生成时间字幕"
                            : "从录音生成真实时间字幕"
                        }
                        disabled={jobBusy || !course.media}
                        onClick={() => startJob("transcribe")}
                      >
                        <Headphones size={14} />
                        {localSpeech.ready ? "本地转录" : "转录"}
                      </button>
                      <button
                        disabled={jobBusy || !course.cues.length}
                        onClick={() => startJob("translate")}
                      >
                        <Languages size={14} />
                        翻译
                      </button>
                      <button
                        disabled={jobBusy || !course.cues.length}
                        onClick={() => startJob("correct")}
                      >
                        <Sparkles size={14} />
                        校对
                      </button>
                    </div>
                  </div>
                  {range && (
                    <div className="selection-bar">
                      <span>
                        <Scissors size={14} />
                        已选 {time(range[0])} — {time(range[1])}
                      </span>
                      <button
                        onClick={() => {
                          setTab("chat");
                          setQuestion(
                            "请解释所选片段的重点，并用白话说明专业概念。",
                          );
                        }}
                      >
                        选段问 AI <ArrowUpRight size={13} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="取消选段"
                        onClick={() => {
                          setRange(null);
                          setRepeat(false);
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {jobBusy && (
                    <div className="job-progress">
                      <LoaderCircle size={15} className="spin" />
                      {job?.progress || "正在提交处理任务…"}
                      <small>可继续浏览，完成后自动更新</small>
                    </div>
                  )}
                  {course.timing === "estimated" && (
                    <div className="timing-note">
                      <Clock3 size={13} />
                      文字稿无时间戳，当前时间为估算；转录录音后可精准同步。
                    </div>
                  )}
                  <div className="transcript-scroll">
                    {filtered.length ? (
                      filtered.map((cue, i) => {
                        const isActive = activeCue?.id === cue.id,
                          isSelected =
                            range && cue.start < range[1] && cue.end > range[0];
                        const chapter = course.chapters.find((ch) =>
                          ch.cueIds.includes(cue.id),
                        );
                        const isChapterStart = chapter?.cueIds[0] === cue.id;
                        return (
                          <React.Fragment key={cue.id}>
                            {isChapterStart && (
                              <div className="transcript-chapter">
                                <span>
                                  {String(
                                    course.chapters.indexOf(chapter!) + 1,
                                  ).padStart(2, "0")}
                                </span>
                                {chapter?.title}
                              </div>
                            )}
                            <div
                              ref={isActive ? activeRow : null}
                              className={
                                "cue-row " +
                                (isActive ? "current " : "") +
                                (isSelected ? "in-range" : "")
                              }
                            >
                              <input
                                type="checkbox"
                                aria-label={`选择字幕 ${time(cue.start)}`}
                                checked={!!isSelected}
                                onChange={() =>
                                  isSelected ? setRange(null) : selectCue(cue)
                                }
                              />
                              <button
                                className="cue-time"
                                onClick={() => seek(cue.start)}
                              >
                                {time(cue.start)}
                                {isActive && (
                                  <span className="mini-equalizer">
                                    <i />
                                    <i />
                                    <i />
                                  </span>
                                )}
                              </button>
                              <button
                                className="cue-text"
                                onClick={() => seek(cue.start)}
                              >
                                <span>
                                  {caption === "corrected"
                                    ? cue.correctedText || cue.text
                                    : cue.text}
                                </span>
                                {caption === "bilingual" && (
                                  <small
                                    className={
                                      cue.translation ? "" : "untranslated"
                                    }
                                  >
                                    {cue.translation || "尚未翻译"}
                                  </small>
                                )}
                                {caption === "corrected" &&
                                  cue.correctedText && (
                                    <small className="original-text">
                                      原文：{cue.text}
                                    </small>
                                  )}
                              </button>
                            </div>
                          </React.Fragment>
                        );
                      })
                    ) : (
                      <div className="empty-section">
                        <FileText size={27} />
                        <p>
                          {query
                            ? "没有找到匹配内容，试试其他词语。"
                            : "导入文字稿或转录录音，即可在这里阅读和选择片段。"}
                        </p>
                        {!query && (
                          <button
                            className="button subtle"
                            onClick={() => openImport(true)}
                          >
                            导入资料
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="transcript-footer">
                    <span>勾选字幕可连续选择片段</span>
                    <span>{filtered.length} 条内容 · 原稿始终保留</span>
                  </div>
                </section>
              </div>
              <aside className="insight-panel">
                <div className="insight-tabs">
                  <button
                    className={tab === "outline" ? "active" : ""}
                    onClick={() => setTab("outline")}
                  >
                    <ListTree size={16} />
                    课程大纲
                  </button>
                  <button
                    className={tab === "highlights" ? "active" : ""}
                    onClick={() => setTab("highlights")}
                  >
                    <Bookmark size={16} />
                    我的重点
                  </button>
                  <button
                    className={tab === "chat" ? "active" : ""}
                    onClick={() => setTab("chat")}
                  >
                    <Sparkles size={16} />
                    AI 答疑
                  </button>
                </div>
                {tab === "outline" && (
                  <div className="outline-pane">
                    <div className="panel-intro">
                      <span className="pill">CHAPTERS</span>
                      <h2>先看全貌，再学细节。</h2>
                      <p>沿着知识脉络，找到你想听的部分。</p>
                    </div>
                    <div className="chapter-list">
                      {course.chapters.map((ch, i) => (
                        <button
                          key={ch.id}
                          className={
                            "chapter-item " +
                            (activeChapter?.id === ch.id ? "active" : "")
                          }
                          onClick={() => seek(ch.start)}
                        >
                          <span className="chapter-number">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <div>
                            <div className="chapter-title">
                              {ch.title}
                              {activeChapter?.id === ch.id && (
                                <span className="now-label">当前</span>
                              )}
                            </div>
                            <p>{ch.summary}</p>
                            <span className="chapter-time">
                              {time(ch.start)} — {time(ch.end)}
                            </span>
                          </div>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                    </div>
                    <button
                      className="summary-button"
                      disabled={jobBusy || !course.cues.length}
                      onClick={() => startJob("summarize")}
                    >
                      <Sparkles size={15} />
                      {range ? "生成所选范围摘要" : "用模型重新生成章节摘要"}
                      <ArrowUpRight size={14} />
                    </button>
                    <div className="source-note">
                      <FileText size={14} />
                      <div>
                        <strong>有据可查的课程内容</strong>
                        <p>
                          默认摘要提取自原文。可用模型重新生成；选段摘要会单独标记范围。点击章节即可定位。
                        </p>
                      </div>
                    </div>
                    <div className="source-documents">
                      <div className="documents-label">
                        <FileText size={14} />
                        原始资料<span>{course.documents.length}</span>
                      </div>
                      {course.documents.map((d) => (
                        <button key={d.id} onClick={() => setDocumentId(d.id)}>
                          <FileText size={14} />
                          <span>{d.name}</span>
                          <ArrowUpRight size={13} />
                        </button>
                      ))}
                    </div>
                    <div className="personal-notes">
                      <label htmlFor="personal-note">
                        <BookOpen size={15} />
                        随手记
                      </label>
                      <textarea
                        id="personal-note"
                        value={notes}
                        onChange={(e) => {
                          setNotes(e.target.value);
                          localStorage.setItem(
                            "notes:" + course.id,
                            JSON.stringify(e.target.value),
                          );
                        }}
                        placeholder="记下突然想明白的一点…"
                      />
                      <div>
                        <small>仅保存在此浏览器</small>
                        <button
                          disabled={!notes}
                          onClick={() =>
                            downloadText(
                              course.title + "-随手记.md",
                              `# ${course.title}\n\n${notes}`,
                            )
                          }
                        >
                          <Download size={13} />
                          导出
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {tab === "highlights" && (
                  <div className="highlights-pane">
                    <div className="panel-intro">
                      <span className="pill">YOUR FOCUS</span>
                      <h2>你关心的，单独留下。</h2>
                      <p>
                        输入关键词，提取原文和上下文。默认关注课前列出的作业、考试和提醒。
                      </p>
                    </div>
                    <label className="field-label" htmlFor="keywords">
                      我想重点关注
                    </label>
                    <textarea
                      id="keywords"
                      className="keyword-input"
                      value={keywords}
                      onChange={(e) => setKeywords(e.target.value)}
                      placeholder="例如：作业，期末，开卷"
                    />
                    <div className="keyword-hint">
                      多个关键词用逗号分隔 · 按原文匹配
                    </div>
                    <div className="focus-actions">
                      <button
                        className="button primary"
                        onClick={extract}
                        disabled={keywordBusy || !keywordList.length}
                      >
                        {keywordBusy ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <Search size={15} />
                        )}
                        提取我的重点
                      </button>
                      <button
                        className="icon-button"
                        disabled={!highlights.length}
                        title="导出重点"
                        aria-label="导出提取的重点"
                        onClick={() =>
                          downloadText(
                            course.title + "-重点.md",
                            `# ${course.title} · 我的重点\n\n关键词：${keywordList.join("、")}\n\n时间标记：${course.timing === "estimated" ? "文字估算，未与录音对齐" : "来源字幕时间"}\n\n` +
                              highlights
                                .map(
                                  (h) =>
                                    `## ${h.keyword} · ${time(h.start)}\n\n${h.excerpt}`,
                                )
                                .join("\n\n"),
                          )
                        }
                      >
                        <Download size={17} />
                      </button>
                    </div>
                    <div className="results-heading">
                      <strong>重点摘录</strong>
                      <span>{highlights.length} 条来源</span>
                    </div>
                    <div className="focus-results">
                      {highlights.map((h) => (
                        <div className="highlight-card" key={h.id}>
                          <div>
                            <span className="keyword-tag">{h.keyword}</span>
                            <button onClick={() => seek(h.start)}>
                              {time(h.start)}
                              <ArrowUpRight size={12} />
                            </button>
                          </div>
                          <p>{h.excerpt}</p>
                          <button
                            className="highlight-ask"
                            onClick={() => {
                              setRange([h.start, h.end]);
                              setTab("chat");
                              setQuestion(
                                `请提取这段中关于“${h.keyword}”的具体要求和注意事项。`,
                              );
                            }}
                          >
                            用这段问 AI <ChevronRight size={12} />
                          </button>
                        </div>
                      ))}
                      {!highlights.length && !keywordBusy && (
                        <div className="empty-section">
                          <Bookmark size={27} />
                          <p>
                            提取后，命中的原文会出现在这里。
                            <br />
                            未命中的关键词不会生成内容。
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {tab === "chat" && (
                  <div className="chat-pane">
                    <div className="chat-context">
                      <span className="ai-symbol">
                        <Sparkles size={19} />
                      </span>
                      <div>
                        <strong>你的课堂学习搭子</strong>
                        <small>
                          {settings.hasApiKey ||
                          settings.baseUrl.includes("localhost") ||
                          settings.baseUrl.includes("127.0.0.1")
                            ? settings.model
                            : "本地原文检索 · 可连接 AI 模型"}
                        </small>
                      </div>
                      <button
                        className="icon-button"
                        onClick={() =>
                          setRange([
                            Math.min(current, Math.max(0, duration - 0.1)),
                            Math.min(duration, current + 60),
                          ])
                        }
                        title="设置选段范围"
                        aria-label="设置选段范围"
                      >
                        <Scissors size={16} />
                      </button>
                      <button
                        className="icon-button"
                        title="模型设置"
                        aria-label="答疑模型设置"
                        onClick={() => setModal("settings")}
                      >
                        <Settings size={16} />
                      </button>
                    </div>
                    <div className="context-range">
                      <Scissors size={13} />
                      {range
                        ? `选段 ${time(range[0])} — ${time(range[1])}`
                        : "参考范围：整堂课"}
                      {range && (
                        <button onClick={() => setRange(null)}>清除</button>
                      )}
                    </div>
                    <div className="chat-messages">
                      {!messages.length && (
                        <div className="chat-welcome">
                          <div className="welcome-art">
                            <MessageSquare size={30} />
                            <Sparkles size={15} />
                          </div>
                          <h3>没听懂的，再聊一遍。</h3>
                          <p>
                            可以问概念、理清步骤，
                            <br />
                            也可以勾选字幕，只聊一小段。
                          </p>
                          {[
                            "这堂课有哪些作业和考试安排？",
                            "用白话解释剖视图和断面图的区别",
                            "找出下节课的安排和提醒",
                          ].map((q) => (
                            <button
                              key={q}
                              onClick={() => ask(q)}
                              disabled={chatBusy}
                            >
                              {q}
                              <ArrowUpRight size={14} />
                            </button>
                          ))}
                          <small>未连接模型时，仅返回原文检索结果。</small>
                        </div>
                      )}
                      {messages.map((m, i) => (
                        <div className={"message " + m.role} key={i}>
                          <div className="message-label">
                            {m.role === "assistant" ? (
                              <>
                                <Sparkles size={13} />
                                {m.mode === "local" ? "原文检索" : "课堂助手"}
                              </>
                            ) : (
                              "你"
                            )}
                          </div>
                          <div className="message-content">{m.content}</div>
                          {m.sources?.length ? (
                            <div className="source-chips">
                              {m.sources.slice(0, 6).map((s, j) => (
                                <button
                                  key={j}
                                  onClick={() => seek(s.start)}
                                  title={s.excerpt}
                                >
                                  <FileText size={11} />
                                  {time(s.start)}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                      {chatBusy && (
                        <div className="assistant-thinking">
                          <LoaderCircle size={14} className="spin" />
                          正在阅读课程上下文…
                        </div>
                      )}
                      <div ref={chatBottom} />
                    </div>
                    <form
                      className="chat-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void ask();
                      }}
                    >
                      <textarea
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.nativeEvent.isComposing
                          ) {
                            e.preventDefault();
                            void ask();
                          }
                        }}
                        placeholder="问问这堂课，或解释一个概念…"
                        aria-label="向课堂助手提问"
                      />
                      <div>
                        <label title="将选段中的视频帧发送给视觉模型，需要导入视频并配置模型">
                          <input
                            type="checkbox"
                            checked={vision}
                            onChange={(e) => setVision(e.target.checked)}
                          />
                          <Film size={13} />
                          参考视频画面
                        </label>
                        <button
                          className="send-button"
                          disabled={chatBusy || !question.trim()}
                          aria-label="发送问题"
                        >
                          {chatBusy ? (
                            <LoaderCircle className="spin" size={17} />
                          ) : (
                            <ArrowUp size={18} />
                          )}
                        </button>
                      </div>
                    </form>
                    <div className="ai-footnote">
                      回答请结合原稿核对 · Enter 发送，Shift + Enter 换行
                    </div>
                  </div>
                )}
              </aside>
            </div>
            <footer className="page-footer">
              <span>知课，让每一次学习都有迹可循。</span>
              <span>原始资料保留 · 模型处理可选 · 自己掌握节奏</span>
            </footer>
          </main>
        )}
      </div>
      {openDocument && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDocumentId(null);
          }}
        >
          <div
            className="modal document-modal"
            role="dialog"
            aria-modal="true"
            aria-label="原始资料"
          >
            <button
              className="modal-close icon-button"
              aria-label="关闭原始资料"
              onClick={() => setDocumentId(null)}
            >
              <X size={20} />
            </button>
            <span className="pill">SOURCE MATERIAL</span>
            <h2>{openDocument.name}</h2>
            <div className="document-tools">
              <span>
                原文保留 · {openDocument.text.length.toLocaleString()} 字符
              </span>
              <button
                className="button subtle"
                onClick={() =>
                  downloadText(
                    openDocument.name.replace(/\.(pdf|pptx)$/i, ".txt"),
                    openDocument.text,
                  )
                }
              >
                <Download size={14} />
                导出文字
              </button>
            </div>
            <pre className="document-reader">{openDocument.text}</pre>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <div
            className={"modal " + (modal === "import" ? "import-modal" : "")}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "settings"
                ? "模型与偏好设置"
                : modal === "import"
                  ? "导入课程资料"
                  : "导出课程笔记"
            }
          >
            <button
              className="modal-close icon-button"
              onClick={() => setModal(null)}
              aria-label="关闭弹窗"
            >
              <X size={20} />
            </button>
            {modal === "import" ? (
              <ImportDialog
                course={course}
                defaultExisting={appendImport}
                onDone={async (id) => {
                  setModal(null);
                  await refresh(id);
                  notify("资料已导入，原始文字稿已保留");
                }}
                onError={fail}
              />
            ) : modal === "settings" ? (
              <SettingsDialog
                initial={settings}
                onDone={(s) => {
                  setSettings(s);
                  notify("模型与偏好已保存");
                  setModal(null);
                }}
                onError={fail}
              />
            ) : (
              <>
                <span className="pill">TAKE IT WITH YOU</span>
                <h2>把知识带走。</h2>
                <p className="modal-description">
                  导出课程字幕、章节与重点，离线也能随时复习。
                </p>
                <div className="export-list">
                  {[
                    {
                      format: "md",
                      title: "课程笔记",
                      desc: "Markdown · 章节摘要、原稿和关键词重点",
                    },
                    {
                      format: "srt",
                      title: "字幕文件",
                      desc: "SRT · 通用播放器字幕",
                    },
                    {
                      format: "vtt",
                      title: "网页字幕",
                      desc: "WebVTT · 浏览器与网页播放器",
                    },
                    {
                      format: "json",
                      title: "完整课程数据",
                      desc: "JSON · 保留原文、校对文本与翻译",
                    },
                  ].map((f) => (
                    <a
                      key={f.format}
                      href={`/api/courses/${course?.id}/export?format=${f.format}&keywords=${encodeURIComponent(keywordList.join(","))}`}
                      download
                      onClick={() => notify("已开始下载")}
                    >
                      <span className="export-icon">
                        <FileText size={21} />
                      </span>
                      <div>
                        <strong>{f.title}</strong>
                        <small>{f.desc}</small>
                      </div>
                      <Download size={17} />
                    </a>
                  ))}
                </div>
                {course?.timing === "estimated" && (
                  <div className="notice">
                    <AlertCircle size={15} />
                    字幕时间为估算。建议转录录音后再导出用于同步播放。
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RangeEditor({
  range,
  duration,
  onChange,
  onSeek,
}: {
  range: [number, number] | null;
  duration: number;
  onChange: (r: [number, number] | null) => void;
  onSeek: (v: number) => void;
}) {
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (range) {
      setFrom(time(range[0]));
      setTo(time(range[1]));
      setError("");
    }
  }, [range?.[0], range?.[1]]);
  if (!range) return null;
  const seconds = (s: string) => {
    const parts = s.split(":");
    if (!/^\d+(?::[0-5]\d){0,2}(?:\.\d+)?$/.test(s)) return NaN;
    return parts.reduce((n, p) => n * 60 + Number(p), 0);
  };
  const apply = () => {
    const a = seconds(from),
      b = seconds(to);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a < 0 ||
      a >= b ||
      b > duration + 0.01
    ) {
      setError("请输入有效范围，结束时间需晚于开始且不超过课程时长。");
      return;
    }
    setError("");
    onChange([a, b]);
    onSeek(a);
  };
  return (
    <div className="range-editor">
      <div>
        <Scissors size={14} />
        <strong>选段范围</strong>
        <label>
          从
          <input
            aria-label="选段开始时间"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") apply();
            }}
          />
        </label>
        <label>
          至
          <input
            aria-label="选段结束时间"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") apply();
            }}
          />
        </label>
        <button onClick={apply}>定位选段</button>
        <button
          className="icon-button"
          aria-label="清除选段范围"
          onClick={() => onChange(null)}
        >
          <X size={14} />
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function EngineeringArt() {
  return (
    <svg
      className="engineering-art"
      viewBox="0 0 270 215"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="face" x1="60" y1="0" x2="200" y2="230">
          <stop stopColor="#9fbbbd" stopOpacity=".2" />
          <stop offset="1" stopColor="#80b8ae" stopOpacity=".03" />
        </linearGradient>
      </defs>
      <path
        d="M44 140 135 191 229 137 139 84 44 140Z"
        fill="url(#face)"
        stroke="#88b6ac"
      />
      <path
        d="m44 140 0-57L139 29l90 52v56M44 83l91 53 94-55m-94 55v55M139 29v55"
        stroke="#a3c9be"
      />
      <path d="m84 116 50 29 52-30-50-29-52 30Z" stroke="#bad2b2" />
      <path
        d="M84 116V85l52-30 50 29v31m-50-29V55m-52 30 50 29 52-30m-52 30v31"
        stroke="#b7d5b9"
      />
      <path
        d="m24 165 108 62 116-67M24 165v-23m108 85v-22m116-45v-24M17 67 130 2l117 66M17 67v28M130 2v20m117 46v28"
        stroke="#789491"
        strokeDasharray="3 4"
        opacity=".5"
      />
      <path
        d="m48 153 82 47m16 0 78-45M137 130v-13m0-63V17m-76 80L26 78m186 19 35-20"
        stroke="#bed8ba"
        strokeDasharray="8 4 2 4"
        opacity=".4"
      />
      <circle cx="135" cy="88" r="13" stroke="#deead1" />
      <path d="M122 88v20c0 8 26 8 26 0V88" stroke="#deead1" />
      <text x="18" y="137" fill="#91b0a3" fontSize="9" fontFamily="monospace">
        A
      </text>
      <text x="239" y="137" fill="#91b0a3" fontSize="9" fontFamily="monospace">
        A
      </text>
      <text
        x="168"
        y="28"
        fill="#91b0a3"
        fontSize="8"
        fontFamily="monospace"
        letterSpacing="2"
      >
        SECTION A–A
      </text>
    </svg>
  );
}

function ImportDialog({
  course,
  defaultExisting,
  onDone,
  onError,
}: {
  course: Course | null;
  defaultExisting: boolean;
  onDone: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const [files, setFiles] = useState<File[]>([]),
    [title, setTitle] = useState(""),
    [text, setText] = useState(""),
    [existing, setExisting] = useState(defaultExisting && !!course),
    [busy, setBusy] = useState(false),
    [drag, setDrag] = useState(false),
    [progress, setProgress] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const add = (f: FileList | null) => {
    if (f) setFiles((old) => [...old, ...Array.from(f)]);
  };
  function upload() {
    if (!files.length && !text.trim()) return;
    setBusy(true);
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    if (title.trim()) form.append("title", title.trim());
    if (text.trim()) form.append("transcript", text);
    const req = new XMLHttpRequest();
    req.open(
      "POST",
      "/api/courses" + (existing && course ? "/" + course.id + "/files" : ""),
    );
    req.upload.onprogress = (e) => {
      if (e.lengthComputable)
        setProgress(Math.round((e.loaded / e.total) * 100));
    };
    req.onerror = () => {
      onError(new Error("上传连接中断，请重试"));
      setBusy(false);
    };
    req.onload = () => {
      setBusy(false);
      try {
        const data = JSON.parse(req.responseText);
        if (req.status >= 400)
          throw new Error(
            typeof data.error === "string"
              ? data.error
              : data.message || "导入失败",
          );
        onDone(data.id || data.course?.id);
      } catch (e) {
        onError(e);
      }
    };
    req.send(form);
  }
  return (
    <>
      <span className="pill">BUILD YOUR LIBRARY</span>
      <h2>从一份课堂资料开始。</h2>
      <p className="modal-description">
        录音、视频和文字稿可以一起导入，也可以稍后补充。
      </p>
      {course && (
        <div className="import-destination">
          <button
            className={existing ? "active" : ""}
            onClick={() => setExisting(true)}
          >
            补充到当前课程
          </button>
          <button
            className={!existing ? "active" : ""}
            onClick={() => setExisting(false)}
          >
            创建新课程
          </button>
        </div>
      )}
      {!existing && (
        <label className="form-field">
          课程名称
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="留空则使用文件名"
          />
        </label>
      )}
      <button
        className={"drop-zone " + (drag ? "drag" : "")}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          add(e.dataTransfer.files);
        }}
      >
        <span className="upload-circle">
          <Upload size={23} />
        </span>
        <strong>点击选择，或把文件拖到这里</strong>
        <span>音视频 · MD / TXT · SRT / VTT · PDF / PPTX</span>
        <small>音视频最大 1 GB · 可以同时选择多个文件</small>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept="audio/*,video/*,.mp3,.mp4,.m4a,.wav,.webm,.ogg,.md,.txt,.srt,.vtt,.pdf,.pptx"
        onChange={(e) => add(e.target.files)}
        hidden
      />
      {!!files.length && (
        <div className="upload-files">
          {files.map((f, i) => (
            <div key={i}>
              <FileText size={15} />
              <span>{f.name}</span>
              <small>{(f.size / 1024 / 1024).toFixed(1)} MB</small>
              <button
                className="icon-button"
                aria-label={"移除" + f.name}
                onClick={() => setFiles((fs) => fs.filter((_, j) => i !== j))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <details className="paste-details">
        <summary>或者，直接粘贴文字稿</summary>
        <textarea
          aria-label="粘贴文字稿"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="粘贴课程原文，支持 Markdown 和带时间戳的字幕…"
        />
      </details>
      <div className="notice">
        <FileText size={15} />
        文字稿可直接使用。音视频转录可使用已安装的本地识别，或连接语音模型接口；原始录音会保留。
      </div>
      <button
        className="button primary full"
        onClick={upload}
        disabled={busy || (!files.length && !text.trim())}
      >
        {busy ? (
          <>
            <LoaderCircle size={16} className="spin" />
            {progress < 100 ? `正在上传 ${progress}%` : "正在解析资料…"}
          </>
        ) : (
          <>
            <Plus size={16} />
            导入，开始学习
          </>
        )}
      </button>
    </>
  );
}

function SettingsDialog({
  initial,
  onDone,
  onError,
}: {
  initial: ProviderSettings;
  onDone: (s: ProviderSettings) => void;
  onError: (e: unknown) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [s, setS] = useState<ProviderSettings>({ ...initial, apiKey: "" }),
    [busy, setBusy] = useState(false),
    [test, setTest] = useState(""),
    [clear, setClear] = useState(false);
  const field = (key: keyof ProviderSettings, v: unknown) =>
    setS((old) => ({ ...old, [key]: v }));
  async function save(close = true) {
    setBusy(true);
    try {
      const payload = { ...s };
      if (!s.apiKey && !clear) delete payload.apiKey;
      if (clear) payload.apiKey = "";
      const result = await api<ProviderSettings>("/settings", {
        ...json(payload),
        method: "PUT",
      });
      if (close) onDone(result);
      else {
        const t = await api<{ ok: boolean; message: string }>(
          "/settings/test",
          json({}),
        );
        setTest(t.message || (t.ok ? "连接成功" : "连接失败"));
      }
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function loadModels() {
    setBusy(true);
    try {
      const payload = { ...s };
      if (!s.apiKey && !clear) delete payload.apiKey;
      if (clear) payload.apiKey = "";
      await api("/settings", { ...json(payload), method: "PUT" });
      const data = await api<{ models: string[] }>("/models");
      setModels(data.models);
      setTest(
        `已读取 ${data.models.length} 个可用模型，可在模型输入框中选择。`,
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="pill">MAKE IT YOURS</span>
      <h2>选择你的学习搭子。</h2>
      <p className="modal-description">
        支持 OpenAI 兼容接口，或连接本机
        Ollama。无需模型也能阅读、提取重点与导出。
      </p>
      <div className="provider-presets">
        <button
          onClick={() =>
            setS({
              ...s,
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-4o-mini",
              speechModel: "whisper-1",
            })
          }
        >
          OpenAI
        </button>
        <button
          onClick={() =>
            setS({
              ...s,
              baseUrl: "https://api.deepseek.com/v1",
              model: "deepseek-chat",
            })
          }
        >
          DeepSeek
        </button>
        <button
          onClick={() =>
            setS({
              ...s,
              baseUrl: "http://127.0.0.1:11434/v1",
              model: "qwen2.5:7b",
            })
          }
        >
          Ollama 本地
        </button>
      </div>
      <label className="form-field">
        API 地址
        <input
          value={s.baseUrl}
          onChange={(e) => field("baseUrl", e.target.value)}
          placeholder="https://…/v1"
        />
      </label>
      <label className="form-field">
        API Key{" "}
        <span className="field-note">
          {initial.hasApiKey ? "已有密钥，留空则保留" : "仅存储于本机服务端"}
        </span>
        <input
          type="password"
          value={s.apiKey}
          onChange={(e) => field("apiKey", e.target.value)}
          placeholder={
            initial.hasApiKey ? "••••••••（已保存）" : "本地模型可留空"
          }
          autoComplete="new-password"
        />
      </label>
      {initial.hasApiKey && (
        <label className="clear-key">
          <input
            type="checkbox"
            checked={clear}
            onChange={(e) => setClear(e.target.checked)}
          />
          移除已保存的密钥
        </label>
      )}
      <div className="form-columns">
        <label className="form-field">
          答疑 / 翻译模型
          <input
            list="provider-models"
            value={s.model}
            onChange={(e) => field("model", e.target.value)}
          />
        </label>
        <label className="form-field">
          语音识别模型
          <input
            value={s.speechModel}
            onChange={(e) => field("speechModel", e.target.value)}
          />
        </label>
      </div>
      <div className="form-columns">
        <label className="form-field">
          翻译目标语言
          <input
            value={s.language}
            onChange={(e) => field("language", e.target.value)}
            placeholder="英语 / 简体中文…"
          />
        </label>
        <label className="form-field">
          思考强度
          <select
            value={s.reasoningEffort}
            onChange={(e) => field("reasoningEffort", e.target.value)}
          >
            <option value="none">默认（不发送参数）</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </label>
      </div>
      <datalist id="provider-models">
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <button
        className="load-models"
        disabled={busy || !s.baseUrl}
        onClick={loadModels}
      >
        <RefreshCw size={12} />
        保存并读取可用模型
      </button>
      <label className="setting-checkbox">
        <input
          type="checkbox"
          checked={s.terminologyOnly}
          onChange={(e) => field("terminologyOnly", e.target.checked)}
        />
        <div>
          <strong>只把专业术语转为目标语言</strong>
          <small>保留其余中文，适合术语对照复习</small>
        </div>
      </label>
      <div className="notice">
        <AlertCircle size={15} />
        不同服务商的转录、视觉能力和计费不同。DeepSeek 不提供语音识别；Ollama
        需先安装并拉取模型。
      </div>
      {test && (
        <div className="test-result" role="status">
          {test}
        </div>
      )}
      <div className="modal-actions">
        <button
          className="button subtle"
          disabled={busy}
          onClick={() => save(false)}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <RefreshCw size={15} />
          )}
          保存并测试连接
        </button>
        <button
          className="button primary"
          disabled={busy || !s.baseUrl || !s.model}
          onClick={() => save()}
        >
          <Check size={15} />
          保存设置
        </button>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
