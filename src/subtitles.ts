import type { Cue } from "./types";
import { layoutCaptions, INTERPOLATED_CAPTION_NOTE } from "./caption-layout";
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
  const captions = layoutCaptions(cues, mode);
  const note = captions.some((c) => c.timing === "interpolated")
    ? `NOTE ${INTERPOLATED_CAPTION_NOTE}\n\n`
    : "";
  return (
    "WEBVTT\n\n" +
    note +
    captions
      .map(
        (c, i) =>
          `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.lines.map(escape).join("\n")}\n`,
      )
      .join("\n")
  );
}
