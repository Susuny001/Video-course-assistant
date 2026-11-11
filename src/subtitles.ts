import type { Cue } from "./types";
const stamp = (seconds: number) => {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};
const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n\s*\n/g, "\n");
/** Native tracks retain subtitles in the browser's video fullscreen player. */
export function buildVtt(
  cues: Cue[],
  mode: "original" | "bilingual" | "corrected",
) {
  return (
    "WEBVTT\n\n" +
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${escape(mode === "corrected" ? c.correctedText || c.text : c.text)}${mode === "bilingual" && c.translation ? "\n" + escape(c.translation) : ""}\n`,
      )
      .join("\n")
  );
}
