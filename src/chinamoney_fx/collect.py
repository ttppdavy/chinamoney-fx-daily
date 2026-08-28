from __future__ import annotations

import argparse
import asyncio
import csv
import gzip
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.async_api import Page, async_playwright

from .tables import (
    extract_date_and_time,
    find_usdcny_record,
    first_value,
    normalise_table,
    option_observations,
    parse_number,
    swap_observations,
)

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    required_headers: tuple[str, ...]


SOURCES = (
    Source("fixing", "https://www.chinamoney.com.cn/chinese/bkccpr/", ("货币对", "中间价")),
    Source("spot", "https://www.chinamoney.com.cn/chinese/sddshl/", ("USD/CNY",)),
    Source("swaps", "https://www.chinamoney.com.cn/chinese/bkcurvfsw/", ("期限品种", "掉期点")),
    Source("options", "https://www.chinamoney.com.cn/chinese/bkcurvfqq/", ("货币对", "波动率类型")),
    Source("implied_rates", "https://www.chinamoney.com.cn/chinese/bkcurvuir/", ("期限",)),
)
OPTION_SURFACES = ("ATM", "25D RR", "10D BF", "25D BF")
FIELDNAMES = [
    "source_date", "source_time", "dataset", "instrument", "surface", "tenor", "metric", "value", "unit",
    "source_url", "retrieved_at_utc", "raw_sha256", "attributes_json",
]


async def table_rows(page: Page, required_headers: tuple[str, ...]) -> tuple[list[list[str]], str]:
    """Read one complete official table at a time; never iterate through webpage cells as requests."""
    tables = page.locator("table")
    for index in range(await tables.count()):
        table = tables.nth(index)
        text = await table.inner_text()
        if all(header in text for header in required_headers):
            rows = await table.locator("tr").evaluate_all(
                """rows => rows.map(r => Array.from(r.querySelectorAll('th,td')).map(c => c.innerText))"""
            )
            return rows, text
    raise RuntimeError(f"未找到表头：{required_headers}")


async def read_json_responses(tasks: list[asyncio.Task[Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for task in tasks:
        try:
            value = await task
            if value is not None:
                results.append(value)
        except Exception:
            pass
    return results


async def capture_response(response: Any) -> dict[str, Any] | None:
    content_type = (response.headers.get("content-type") or "").lower()
    if "json" not in content_type:
        return None
    return {"url": response.url, "body": await response.json()}


async def load_source(page: Page, source: Source) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    tasks: list[asyncio.Task[Any]] = []
    page.on("response", lambda response: tasks.append(asyncio.create_task(capture_response(response))))
    await page.goto(source.url, wait_until="domcontentloaded", timeout=60_000)
    await page.wait_for_timeout(4_000)
    rows, table_text = await table_rows(page, source.required_headers)
    headers, records = normalise_table(rows)
    body_text = await page.locator("body").inner_text()
    date, time = extract_date_and_time(body_text)
    snapshot = {
        "source": source.name,
        "source_url": source.url,
        "source_date": date,
        "source_time": time,
        "headers": headers,
        "records": records,
        "table_text": table_text,
    }
    return snapshot, await read_json_responses(tasks)


async def load_all_option_surfaces(page: Page) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    source = SOURCES[3]
    base, responses = await load_source(page, source)
    snapshots = [base]
    select = page.locator("#foiv-curv-type")
    if not await select.count():
        return snapshots, responses
    options = await select.locator("option").evaluate_all("opts => opts.map(o => ({value:o.value,label:o.textContent.trim()}))")
    for surface in OPTION_SURFACES:
        selected = next((x for x in options if x["label"] == surface), None)
        if not selected or surface == first_value(base["records"][0], ("波动率类型",)):
            continue
        tasks: list[asyncio.Task[Any]] = []
        page.on("response", lambda response: tasks.append(asyncio.create_task(capture_response(response))))
        await select.select_option(selected["value"])
        await page.evaluate("doSearch()")
        await page.wait_for_timeout(1_500)
        rows, table_text = await table_rows(page, source.required_headers)
        headers, records = normalise_table(rows)
        date, time = extract_date_and_time(await page.locator("body").inner_text())
        snapshots.append({
            "source": source.name,
            "source_url": source.url,
            "source_date": date,
            "source_time": time,
            "headers": headers,
            "records": records,
            "table_text": table_text,
        })
        responses.extend(await read_json_responses(tasks))
    return snapshots, responses


def fixed_observations(dataset: str, snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    record = find_usdcny_record(snapshot["records"])
    if not record:
        return []
    aliases = ("中间价",) if dataset == "fixing" else ("即期", "spot")
    value = parse_number(first_value(record, aliases))
    if value is None:
        return []
    return [{
        "instrument": "USD/CNY",
        "surface": "",
        "tenor": "",
        "metric": dataset,
        "value": value,
        "unit": "rate",
        "attributes": record,
    }]


def implied_rate_observations(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for record in snapshot["records"]:
        tenor = first_value(record, ("期限", "关键期限点"))
        rate = parse_number(first_value(record, ("隐含利率", "外币隐含利率", "美元隐含利率")))
        if tenor and rate is not None:
            output.append({
                "instrument": "USD",
                "surface": first_value(record, ("参数组合", "曲线", "人民币利率")),
                "tenor": tenor,
                "metric": "implied_usd_rate",
                "value": rate,
                "unit": "pct",
                "attributes": record,
            })
    return output


def observations(dataset: str, snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    if dataset in {"fixing", "spot"}:
        return fixed_observations(dataset, snapshot)
    if dataset == "swaps":
        return [{**x, "attributes": {}} for x in swap_observations(snapshot["records"])]
    if dataset == "options":
        return [{**x, "attributes": {}} for x in option_observations(snapshot["records"])]
    return implied_rate_observations(snapshot)


def write_gzip_json(path: Path, value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wb") as file:
        file.write(payload)
    return hashlib.sha256(payload).hexdigest()


def upsert_observations(rows: list[dict[str, str]]) -> None:
    path = DATA / "observations.csv"
    existing: dict[tuple[str, ...], dict[str, str]] = {}
    if path.exists():
        with path.open(encoding="utf-8", newline="") as file:
            for row in csv.DictReader(file):
                existing[tuple(row[x] for x in FIELDNAMES[:8])] = row
    for row in rows:
        existing[tuple(row[x] for x in FIELDNAMES[:8])] = row
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(sorted(existing.values(), key=lambda x: tuple(x[k] for k in FIELDNAMES[:8])))


def validate(snapshots: list[dict[str, Any]]) -> None:
    names = {x["source"] for x in snapshots}
    missing = {x.name for x in SOURCES} - names
    if missing:
        raise RuntimeError(f"缺少数据集：{sorted(missing)}")
    surfaces = {
        first_value(x["records"][0], ("波动率类型",))
        for x in snapshots
        if x["source"] == "options" and x["records"]
    }
    missing_surfaces = set(OPTION_SURFACES) - surfaces
    if missing_surfaces:
        raise RuntimeError(f"缺少期权波动率类型：{sorted(missing_surfaces)}")


async def run() -> None:
    retrieved_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    async with async_playwright() as browser_api:
        browser = await browser_api.chromium.launch(headless=True)
        context = await browser.new_context(user_agent=UA, locale="zh-CN", timezone_id="Asia/Shanghai")
        snapshots: list[dict[str, Any]] = []
        raw_api: dict[str, list[dict[str, Any]]] = {}
        for source in SOURCES:
            page = await context.new_page()
            if source.name == "options":
                source_snapshots, responses = await load_all_option_surfaces(page)
                snapshots.extend(source_snapshots)
            else:
                snapshot, responses = await load_source(page, source)
                snapshots.append(snapshot)
            raw_api[source.name] = responses
            await page.close()
        await browser.close()

    validate(snapshots)
    source_date = next(
        (x["source_date"] for x in snapshots if x["source_date"]),
        datetime.now().date().isoformat(),
    )
    flat_rows: list[dict[str, str]] = []
    for index, snapshot in enumerate(snapshots, start=1):
        raw_path = DATA / "raw" / source_date / f"{snapshot['source']}_{index:02d}.json.gz"
        sha = write_gzip_json(
            raw_path,
            {"snapshot": snapshot, "api_responses": raw_api.get(snapshot["source"], [])},
        )
        for item in observations(snapshot["source"], snapshot):
            flat_rows.append({
                "source_date": snapshot["source_date"] or source_date,
                "source_time": snapshot["source_time"],
                "dataset": snapshot["source"],
                "instrument": item["instrument"],
                "surface": item["surface"],
                "tenor": item["tenor"],
                "metric": item["metric"],
                "value": str(item["value"]),
                "unit": item["unit"],
                "source_url": snapshot["source_url"],
                "retrieved_at_utc": retrieved_at,
                "raw_sha256": sha,
                "attributes_json": json.dumps(item.get("attributes", {}), ensure_ascii=False, sort_keys=True),
            })
    upsert_observations(flat_rows)
    report = {
        "retrieved_at_utc": retrieved_at,
        "source_date": source_date,
        "snapshot_count": len(snapshots),
        "observation_count": len(flat_rows),
        "sources": [{
            "name": x["source"],
            "date": x["source_date"],
            "time": x["source_time"],
            "rows": len(x["records"]),
        } for x in snapshots],
    }
    (DATA / "latest_run.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


def main() -> None:
    argparse.ArgumentParser().parse_args()
    asyncio.run(run())


if __name__ == "__main__":
    main()
