from __future__ import annotations

import re
from typing import Any


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def parse_number(value: str) -> float | None:
    text = clean(value).replace(",", "").replace("%", "")
    if not text or text in {"-", "--", "—", "N/A"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def normalise_table(rows: list[list[str]]) -> tuple[list[str], list[dict[str, str]]]:
    """Turn a rendered HTML table into a stable header/records representation."""
    if not rows:
        return [], []
    headers = [clean(x) or f"column_{i + 1}" for i, x in enumerate(rows[0])]
    records: list[dict[str, str]] = []
    for row in rows[1:]:
        values = [clean(x) for x in row]
        if not any(values):
            continue
        records.append({headers[i]: values[i] if i < len(values) else "" for i in range(len(headers))})
    return headers, records


def first_value(record: dict[str, str], aliases: tuple[str, ...]) -> str:
    for alias in aliases:
        for key, value in record.items():
            if alias in key:
                return value
    return ""


def find_usdcny_record(records: list[dict[str, str]]) -> dict[str, str] | None:
    for record in records:
        joined = " ".join(record.values()).upper().replace(".", "/")
        if "USD/CNY" in joined or "美元/人民币" in joined:
            return record
    return None


def extract_date_and_time(text: str) -> tuple[str, str]:
    date = ""
    time = ""
    date_match = re.search(r"(20\d{2}[-/]\d{1,2}[-/]\d{1,2})", text)
    if date_match:
        date = date_match.group(1).replace("/", "-")
    time_match = re.search(r"(?<!\d)([0-2]?\d:[0-5]\d)(?!\d)", text)
    if time_match:
        time = time_match.group(1).zfill(5)
    return date, time


def option_observations(records: list[dict[str, str]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for r in records:
        pair = first_value(r, ("货币对",))
        surface = first_value(r, ("波动率类型",))
        tenor = first_value(r, ("关键期限点", "期限"))
        if not (pair and surface and tenor):
            continue
        # The official table publishes all three quotes.  Keep them as separate
        # metrics so a mid-vol chart cannot accidentally be mixed with bid/ask.
        for metric, aliases in (
            ("implied_vol_mid", ("波动率(%)",)),
            ("implied_vol_bid", ("波动率报买(%)",)),
            ("implied_vol_ask", ("波动率报卖(%)",)),
        ):
            value = parse_number(first_value(r, aliases))
            if value is not None:
                output.append({"instrument": pair, "surface": surface, "tenor": tenor, "metric": metric, "value": value, "unit": "pct"})
    return output


def swap_observations(records: list[dict[str, str]]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for r in records:
        tenor = first_value(r, ("期限品种", "期限"))
        points = parse_number(first_value(r, ("掉期点",)))
        all_in = parse_number(first_value(r, ("全价汇率",)))
        if not tenor:
            continue
        if points is not None:
            output.append({"instrument": "USD.CNY", "surface": "", "tenor": tenor, "metric": "swap_points", "value": points, "unit": "pips"})
        if all_in is not None:
            output.append({"instrument": "USD.CNY", "surface": "", "tenor": tenor, "metric": "forward_all_in", "value": all_in, "unit": "rate"})
    return output
