#!/usr/bin/env python3
"""Align independent acoustic transcripts and flag review priorities without rewriting either.

Agreement means only that two acoustic decoders agree. It is not a correctness
certificate; shared VAD boundaries do not independently verify speech coverage.
"""
from __future__ import annotations
import argparse
from collections import Counter
from difflib import SequenceMatcher
import json
import math
from pathlib import Path
import re
import unicodedata

DEFAULT_KEYWORDS = ["考试", "期末", "期中", "作业", "开卷", "教材", "下节课", "下周", "名单", "学号"]
DIGITS = dict(zip("零〇一二两三四五六七八九", [0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9]))


def chinese_integer(value: str) -> str:
    if value.isdigit():
        return str(int(value))
    if all(c in DIGITS for c in value):
        return str(int("".join(str(DIGITS[c]) for c in value)))
    total, current = 0, 0
    for character in value:
        if character in DIGITS:
            current = DIGITS[character]
        elif character in {"十", "百", "千"}:
            total += (current or 1) * {"十": 10, "百": 100, "千": 1000}[character]
            current = 0
        else:
            return value
    return str(total + current)


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    # Equivalent common numeric rendering should not create a false acoustic disagreement.
    text = re.sub(r"[零〇一二两三四五六七八九十百千]+(?=\s*(?:分|周|章|页|题|小时|分钟|个|次|点))", lambda m: chinese_integer(m[0]), text)
    return "".join(c for c in text if c.isalnum())


def numeric_facts(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text)
    facts = []
    for match in re.finditer(r"(?P<value>\d+(?:[.-]\d+)*|[零〇一二两三四五六七八九十百千]+)\s*(?P<unit>小时|分钟|分|周|章|页|题|个|次|点|%)?", text):
        value, unit = match["value"], match["unit"] or ""
        if not unit and not value[0].isdigit():
            continue
        facts.append(chinese_integer(value) + unit)
    return facts


def validate_segments(data: dict) -> list[dict]:
    if not isinstance(data, dict) or not isinstance(data.get("segments"), list):
        raise ValueError("识别文件必须包含 segments 数组。")
    result = []
    last = -1
    for item in data["segments"]:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            raise ValueError("识别片段没有有效文字。")
        start, end = item.get("start"), item.get("end")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not math.isfinite(start) or not math.isfinite(end) or start < 0 or start < last or end <= start:
            raise ValueError("识别片段时间戳无效。")
        last = start
        result.append(item)
    return result


def compare(primary: dict, secondary: dict, keywords: list[str] | None = None) -> dict:
    left, right = validate_segments(primary), validate_segments(secondary)
    if primary.get("sourceSha256") and secondary.get("sourceSha256") and primary["sourceSha256"] != secondary["sourceSha256"]:
        raise ValueError("两个声学识别结果来自不同音频，不能进行复核。")
    keywords = keywords or DEFAULT_KEYWORDS
    used = set()
    items = []

    def add(start: float, end: float, first: str, second: str) -> None:
        first_normal, second_normal = normalize(first), normalize(second)
        score = SequenceMatcher(None, first_normal, second_normal, autojunk=False).ratio() if first_normal and second_normal else 0.0
        reasons = []
        if not first_normal or not second_normal:
            reasons.append("one_model_missing_speech")
        if score < 0.72:
            reasons.append("large_acoustic_disagreement")
        elif score < 0.94:
            reasons.append("wording_disagreement")
        first_numbers, second_numbers = numeric_facts(first), numeric_facts(second)
        if first_numbers != second_numbers:
            reasons.append("numeric_fact_disagreement")
        critical = [word for word in keywords if word in first or word in second]
        if critical:
            reasons.append("user_priority_content")
        # High agreement is still not a human/vision review of names or course claims.
        status = "acoustic_agreement" if first_normal and first_normal == second_normal else "needs_review"
        priority = "high" if "one_model_missing_speech" in reasons or "numeric_fact_disagreement" in reasons or (critical and status == "needs_review") else "medium" if score < 0.94 else "low"
        items.append({"id": f"acoustic-{len(items)+1:04d}", "start": start, "end": end, "primaryText": first, "secondaryText": second, "agreementScore": round(score, 4), "priority": priority, "reasons": reasons, "matchedKeywords": critical, "numericFacts": {"primary": first_numbers, "secondary": second_numbers}, "status": status})

    cursor = 0
    for segment in left:
        while cursor < len(right) and right[cursor]["end"] <= segment["start"]:
            cursor += 1
        overlaps = []
        index = cursor
        while index < len(right) and right[index]["start"] < segment["end"]:
            candidate = right[index]
            if candidate["end"] > segment["start"]:
                overlaps.append(candidate)
                used.add(index)
            index += 1
        add(segment["start"], segment["end"], segment["text"], "".join(s["text"] for s in overlaps))
    for index, segment in enumerate(right):
        if index not in used:
            add(segment["start"], segment["end"], "", segment["text"])
    items.sort(key=lambda item: (item["start"], item["end"]))
    return {"sourceSha256": primary.get("sourceSha256") or secondary.get("sourceSha256"), "models": {"primary": primary.get("model"), "secondary": secondary.get("model")}, "auditMethod": "actual independent acoustic decoding + overlap alignment; shared VAD boundaries", "reviewComplete": False, "limitation": "模型一致不证明内容正确；此表只排定回查录音和文本/视觉校对的优先级，未静默更改任何原稿。", "counts": {"primarySegments": len(left), "secondarySegments": len(right), "items": len(items), "byPriority": dict(Counter(item["priority"] for item in items)), "needsReview": sum(item["status"] == "needs_review" for item in items)}, "items": items}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--primary", type=Path, required=True)
    parser.add_argument("--secondary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--keywords", default=",".join(DEFAULT_KEYWORDS))
    args = parser.parse_args()
    primary = json.loads(args.primary.read_text(encoding="utf-8"))
    secondary = json.loads(args.secondary.read_text(encoding="utf-8"))
    result = compare(primary, secondary, [v.strip() for v in args.keywords.split(",") if v.strip()])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["counts"], ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import sys
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
