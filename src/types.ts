export interface Cue {
  id: string;
  start: number;
  end: number;
  text: string;
  translation?: string;
  correctedText?: string;
  chapterId?: string;
}
export interface Chapter {
  id: string;
  title: string;
  start: number;
  end: number;
  summary: string;
  cueIds: string[];
}
export interface CourseDocument {
  id: string;
  name: string;
  type: string;
  text: string;
}
export interface Course {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  media?: { url: string; name: string; type: string; duration?: number };
  documents: CourseDocument[];
  cues: Cue[];
  chapters: Chapter[];
  timing: "estimated" | "exact" | "none";
  language: string;
  keywords: string[];
}
export interface Highlight {
  id: string;
  keyword: string;
  chapterId: string;
  cueIds: string[];
  excerpt: string;
  start: number;
  end: number;
}
export interface ProviderSettings {
  baseUrl: string;
  apiKey?: string;
  hasApiKey?: boolean;
  model: string;
  speechModel: string;
  speechEngine?: "local" | "api";
  language: string;
  terminologyOnly: boolean;
  reasoningEffort: "none" | "low" | "medium" | "high";
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
export interface ChatResult {
  answer: string;
  sources: { cueId: string; start: number; excerpt: string }[];
  mode: "local" | "ai";
}
export interface Job {
  id: string;
  courseId: string;
  type: string;
  status: "queued" | "running" | "done" | "error";
  progress: string;
  error?: string;
  createdAt: string;
}
