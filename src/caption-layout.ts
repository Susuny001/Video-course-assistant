import type { Cue } from "./types";

export type CaptionMode = "original" | "bilingual" | "corrected";
export interface DisplayCaption {
  id: string;
  sourceCueId: string;
  sourceStart: number;
  sourceEnd: number;
  start: number;
  end: number;
  /** Exact contiguous source substring; wrapping never replaces the saved transcript. */
  text: string;
  translation?: string;
  lines: string[];
  timing: "source" | "interpolated";
}

const segmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;
const graphemes = (text: string) =>
  segmenter
    ? Array.from(segmenter.segment(text), (item) => item.segment)
    : Array.from(text);
const width = (part: string): number => {
  if (
    /\p{Extended_Pictographic}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[\u3000-\u303f\uff00-\uffef]/u.test(
      part,
    )
  )
    return 1;
  if (/^\s+$/u.test(part)) return 0.35;
  return 0.55;
};
export const captionWidth = (text: string) =>
  graphemes(text).reduce((n, part) => n + width(part), 0);
const boundary = (part: string) =>
  /[。！？!?\n]/u.test(part)
    ? 3
    : /[，、；;：:,]/u.test(part)
      ? 2
      : /\s/u.test(part)
        ? 1
        : 0;

/** Split without removing, duplicating, or splitting a grapheme. */
function splitBudget(text: string, limit: number): string[] {
  const parts = graphemes(text),
    result: string[] = [];
  let from = 0;
  while (from < parts.length) {
    let end = from,
      used = 0;
    while (end < parts.length && used + width(parts[end]) <= limit + 1e-8)
      used += width(parts[end++]);
    if (end === from) end++;
    if (end < parts.length) {
      let best = end,
        bestScore = 0,
        before = used;
      for (let i = end - 1; i >= from && before >= limit * 0.6; i--) {
        const score = boundary(parts[i]);
        if (score > bestScore) {
          best = i + 1;
          bestScore = score;
        }
        before -= width(parts[i]);
      }
      end = best;
    }
    result.push(parts.slice(from, end).join(""));
    from = end;
  }
  return result;
}

/** Balance two languages to a common cue count without claiming sentence/word alignment. */
function splitBalanced(text: string, count: number, limit: number): string[] {
  const parts = graphemes(text),
    result: string[] = [];
  // Total width alone is insufficient: indivisible graphemes can strand a
  // slightly oversized final line. Reserve enough actual lines for the suffix.
  const widths = parts.map(width), next = new Array<number>(parts.length);
  let right = 0, usedWidth = 0;
  for (let left = 0; left < parts.length; left++) {
    while (right < parts.length && usedWidth + widths[right] <= limit + 1e-8)
      usedWidth += widths[right++];
    next[left] = Math.max(left + 1, right);
    usedWidth -= widths[left];
  }
  const required = new Array<number>(parts.length + 1).fill(0);
  for (let i = parts.length - 1; i >= 0; i--)
    required[i] = 1 + required[next[i]];
  let from = 0;
  for (let slot = 0; slot < count; slot++) {
    if (slot === count - 1) {
      result.push(parts.slice(from).join(""));
      break;
    }
    const slots = count - slot;
    const remaining = parts.slice(from).reduce((n, part) => n + width(part), 0);
    const target = remaining / slots;
    const minimum = Math.max(0, remaining - (slots - 1) * limit);
    let end = from,
      used = 0,
      best = from,
      distance = Infinity;
    while (end < parts.length && used + width(parts[end]) <= limit + 1e-8) {
      used += width(parts[end++]);
      if (used + 1e-8 < minimum) continue;
      if (required[end] > slots - 1) continue;
      const punctuationBonus = boundary(parts[end - 1]) * 0.15;
      const insideWord =
        end < parts.length &&
        /[A-Za-z0-9_.+-]/.test(parts[end - 1]) &&
        /[A-Za-z0-9_.+-]/.test(parts[end]);
      const candidateDistance =
        Math.abs(used - target) - punctuationBonus + (insideWord ? 4 : 0);
      if (candidateDistance < distance) {
        best = end;
        distance = candidateDistance;
      }
    }
    // Empty pieces are necessary when one language has fewer graphemes than its translation.
    if (target < 0.5 && remaining <= (slots - 1) * limit) best = from;
    if (best === from && minimum > 0) best = Math.max(from + 1, end);
    result.push(parts.slice(from, best).join(""));
    from = best;
  }
  return result;
}
const display = (text: string) => text.replace(/\r\n?|\n/g, " ");

function layoutCue(cue: Cue, mode: CaptionMode): DisplayCaption[] {
  const source =
    mode === "corrected" ? cue.correctedText || cue.text : cue.text;
  const translation = mode === "bilingual" ? cue.translation : undefined;
  if (!source && !translation) return [];
  let primary: string[],
    translated: string[] = [],
    originalLines: string[][] = [];
  if (translation) {
    const count = Math.max(
      splitBudget(source, 22).length,
      splitBudget(translation, 22).length,
      1,
    );
    primary = splitBalanced(source, count, 22);
    translated = splitBalanced(translation, count, 22);
  } else {
    const lines = splitBudget(source, 22);
    for (let i = 0; i < lines.length; i += 2)
      originalLines.push(lines.slice(i, i + 2));
    primary = originalLines.map((lines) => lines.join(""));
  }
  const sourceWidth = captionWidth(source),
    translationWidth = translation ? captionWidth(translation) : 0;
  const weights = primary.map((piece, i) =>
    Math.max(
      0.1,
      captionWidth(piece),
      translation
        ? (captionWidth(translated[i] || "") * sourceWidth) /
            Math.max(1, translationWidth)
        : 0,
    ),
  );
  const totalWeight = weights.reduce((n, w) => n + w, 0);
  let position = cue.start;
  return primary.map((piece, i) => {
    const start = position;
    const end =
      i === primary.length - 1
        ? cue.end
        : position +
          (Math.max(0, cue.end - cue.start) * weights[i]) / totalWeight;
    position = end;
    const lines = translation
      ? [display(piece), display(translated[i] || "")].filter(Boolean)
      : originalLines[i].map(display);
    return {
      id: `${cue.id}:display:${i}`,
      sourceCueId: cue.id,
      sourceStart: cue.start,
      sourceEnd: cue.end,
      start,
      end,
      text: piece,
      ...(translation ? { translation: translated[i] || "" } : {}),
      lines,
      timing: primary.length === 1 ? "source" : "interpolated",
    };
  });
}

const cache = new WeakMap<
  Cue,
  Map<
    CaptionMode,
    {
      source: string;
      translation?: string;
      start: number;
      end: number;
      id: string;
      captions: DisplayCaption[];
    }
  >
>();
function cachedLayout(cue: Cue, mode: CaptionMode): DisplayCaption[] {
  const source =
      mode === "corrected" ? cue.correctedText || cue.text : cue.text,
    translation = mode === "bilingual" ? cue.translation : undefined;
  const modes = cache.get(cue) || new Map();
  const previous = modes.get(mode);
  if (
    previous &&
    previous.source === source &&
    previous.translation === translation &&
    previous.start === cue.start &&
    previous.end === cue.end &&
    previous.id === cue.id
  )
    return previous.captions;
  const captions = layoutCue(cue, mode);
  modes.set(mode, {
    source,
    translation,
    start: cue.start,
    end: cue.end,
    id: cue.id,
    captions,
  });
  cache.set(cue, modes);
  return captions;
}

/** Internal caption times are layout estimates unless an actual aligned track is supplied. */
export function layoutCaptions(
  cues: Cue[],
  mode: CaptionMode = "original",
): DisplayCaption[] {
  return cues.flatMap((cue) => cachedLayout(cue, mode));
}
export function captionForTime(
  cue: Cue | undefined,
  time: number,
  mode: CaptionMode = "original",
): DisplayCaption | undefined {
  if (!cue || time < cue.start || time >= cue.end) return undefined;
  return cachedLayout(cue, mode).find((c) => c.start <= time && c.end > time);
}

export const INTERPOLATED_CAPTION_NOTE =
  "字幕已按可读长度拆分；段内时间及双语片段对应为估算，原始语音分段边界保留，未做逐字强制对齐。";
