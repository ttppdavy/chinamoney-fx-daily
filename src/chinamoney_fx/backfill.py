"""Backfill the public ChinaMoney curves without iterating webpage table cells.

The historical endpoints power the pages' own “Save to Excel” buttons.  We call
the same endpoints through a browser context (rather than a server-side scrape),
keep the returned JSON as evidence, then append the normalised observations.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from playwright.async_api import BrowserContext, async_playwright

from .collect import DATA, REFERENCE_RATE_API, UA, upsert_observations, write_daily_dashboard, write_gzip_json
from .tables import parse_number

AGS = "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-fx/"
OPTION_URL = AGS + "FoivCurvHisData"
SWAP_URL = AGS + "FxSwapHisory"
IMPLIED_URL = AGS + "IuirCurvHis"


def months(start: date, end: date):
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        next_month = date(cursor.year + (cursor.month == 12), (cursor.month % 12) + 1, 1)
        yield cursor, min(end, next_month - timedelta(days=1))
        cursor = next_month


def text_date(value: str) -> str:
    for pattern in ("%Y-%m-%d", "%d %b %Y"):
        try:
            return datetime.strptime(value, pattern).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f"无法识别官方返回日期：{value}")


async def post_json(context: BrowserContext, endpoint: str, params: dict[str, str]) -> dict[str, Any]:
    """Use the site's normal browser session; a direct datacentre HTTP client is blocked."""
    response = await context.request.post(endpoint + "?" + urlencode(params), timeout=90_000)
    if not response.ok:
        raise RuntimeError(f"官方历史接口返回 HTTP {response.status}: {endpoint}")
    payload = await response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("records"), list):
        raise RuntimeError(f"官方历史接口未返回预期 JSON：{endpoint}")
    return payload


async def paged(context: BrowserContext, endpoint: str, params: dict[str, str], page_key: str, size_key: str = "pageSize") -> list[dict[str, Any]]:
    params = {**params, size_key: "500", page_key: "1"}
    first = await post_json(context, endpoint, params)
    records = list(first["records"])
    meta = first.get("data") or {}
    pages = int(meta.get("totalPageNum") or meta.get("pageTotal") or meta.get("count") or 1)
    for page in range(2, pages + 1):
        payload = await post_json(context, endpoint, {**params, page_key: str(page)})
        records.extend(payload["records"])
    return records


def row(source_date: str, source_time: str, dataset: str, instrument: str, surface: str, tenor: str, metric: str, value: float, unit: str, source_url: str, attributes: dict[str, Any], retrieved_at: str, sha: str) -> dict[str, str]:
    return {"source_date": source_date, "source_time": source_time, "dataset": dataset, "instrument": instrument, "surface": surface, "tenor": tenor, "metric": metric, "value": str(value), "unit": unit, "source_url": source_url, "retrieved_at_utc": retrieved_at, "raw_sha256": sha, "attributes_json": json.dumps(attributes, ensure_ascii=False, sort_keys=True)}


def value(record: dict[str, Any], *names: str) -> str:
    for name in names:
        item = record.get(name)
        if item not in (None, ""):
            return str(item)
    return ""


async def run(start: date, end: date) -> None:
    retrieved_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    all_rows: list[dict[str, str]] = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(user_agent=UA, locale="zh-CN", timezone_id="Asia/Shanghai")
        # Load configs once.  Values, not display labels, are the stable official query parameters.
        option_config = await post_json(context, OPTION_URL, {"lang": "EN", "pageSize": "1", "pageNum": "1"})
        option_types = {item.get("enLabel"): str(item.get("value")) for item in (option_config.get("data") or {}).get("volatilityTypeList", [])}
        implied_config = await post_json(context, IMPLIED_URL, {"page": "1", "pageSize": "1"})
        implied_data = implied_config.get("data") or {}
        def first_id(name: str) -> str:
            values = implied_data.get(name) or []
            if not values:
                raise RuntimeError(f"隐含利率历史接口未返回 {name} 参数")
            return str(values[0]["value"])
        rmb_rate, spot_rate, bp = first_id("rmdRateList"), first_id("spotRateList"), first_id("bpList")
        ccy_pair = str((implied_data.get("ccyPairList") or [{"value": "USD.CNY"}])[0]["value"])
        swap_config = await post_json(context, SWAP_URL, {"lang": "en", "page": "1", "pagesize": "1"})
        swap_data = swap_config.get("data") or {}
        curve_type = str(swap_data.get("curveType") or (swap_data.get("cplist") or ["USD.CNY"])[0])
        swap_time = str((swap_data.get("timeList") or [""])[0])

        for month_start, month_end in months(start, end):
            start_text, end_text = month_start.isoformat(), month_end.isoformat()
            folder = DATA / "raw" / "backfill" / f"{month_start:%Y-%m}"

            # 14:00 RMB FX reference rate (the user-facing spot reference).
            reference = await post_json(context, REFERENCE_RATE_API, {"lang": "en", "indexType": "1", "startDateTool": month_start.strftime("%d %b %Y"), "endDateTool": month_end.strftime("%d %b %Y"), "currencyCode": "USD.CNY"})
            sha = write_gzip_json(folder / "reference_rate.json.gz", reference)
            for record in reference["records"]:
                rate = parse_number(value(record, "rateOf14hour"))
                if record.get("ccyPair") == "USD/CNY" and rate is not None:
                    all_rows.append(row(text_date(value(record, "dealDate")), "14:00", "reference_rate", "USD/CNY", "", "", "reference_rate_14", rate, "rate", REFERENCE_RATE_API, record, retrieved_at, sha))

            # Option curves: only 10:00, all four requested volatility surfaces and all tenors/quotes.
            option_raw: dict[str, Any] = {}
            for surface in ("ATM", "25D RR", "10D BF", "25D BF"):
                kind = option_types.get(surface)
                if not kind:
                    raise RuntimeError(f"期权历史接口未提供 {surface}")
                records = await paged(context, OPTION_URL, {"lang": "EN", "tradeTime": "10:00", "ccyPair": "USD.CNY", "volatilityType": kind, "startDate": start_text, "endDate": end_text}, "pageNum")
                option_raw[surface] = records
                for record in records:
                    source_date = text_date(value(record, "tradeDate"))
                    tenor = value(record, "tenor")
                    for metric, field in (("implied_vol_mid", "midVolatilityStr"), ("implied_vol_bid", "bidVolatilityStr"), ("implied_vol_ask", "askVolatilityStr")):
                        quote = parse_number(value(record, field))
                        if tenor and quote is not None:
                            # SHA is assigned after the month's complete raw bundle is written.
                            all_rows.append(row(source_date, "10:00", "options", "USD.CNY", surface, tenor, metric, quote, "pct", OPTION_URL, record, retrieved_at, "PENDING"))
            option_sha = write_gzip_json(folder / "options_10am.json.gz", option_raw)
            for item in all_rows:
                if item["raw_sha256"] == "PENDING":
                    item["raw_sha256"] = option_sha

            swap_records = await paged(context, SWAP_URL, {"lang": "en", "startDate": start_text, "endDate": end_text, "curveType": curve_type, "time": swap_time}, "page", "pagesize")
            swap_sha = write_gzip_json(folder / "swaps.json.gz", swap_records)
            for record in swap_records:
                source_date, tenor = text_date(value(record, "curveTime", "curveTimeEN")), value(record, "tenor")
                for metric, field, unit in (("swap_points", "points", "pips"), ("forward_all_in", "swapAllPrc", "rate")):
                    quote = parse_number(value(record, field))
                    if tenor and quote is not None:
                        all_rows.append(row(source_date, value(record, "time") or swap_time, "swaps", curve_type, "", tenor, metric, quote, unit, SWAP_URL, record, retrieved_at, swap_sha))

            implied_records = await paged(context, IMPLIED_URL, {"rmbRateSrc": rmb_rate, "spotrateSrc": spot_rate, "bpSrc": bp, "startDate": start_text, "endDate": end_text, "ccyPair": ccy_pair}, "page")
            implied_sha = write_gzip_json(folder / "implied_rates.json.gz", implied_records)
            for record in implied_records:
                source_date, tenor = text_date(value(record, "showDateCn", "tradeDate")), value(record, "tl")
                rate = parse_number(value(record, "dollarRateDes", "dollarRate"))
                if tenor and rate is not None:
                    all_rows.append(row(source_date, "16:50", "implied_rates", "USD", "", tenor, "implied_usd_rate", rate, "pct", IMPLIED_URL, record, retrieved_at, implied_sha))
        await browser.close()
    upsert_observations(all_rows)
    write_daily_dashboard()
    print(json.dumps({"start": start.isoformat(), "end": end.isoformat(), "observation_count": len(all_rows)}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill official ChinaMoney FX history")
    parser.add_argument("--start", required=True, type=date.fromisoformat)
    parser.add_argument("--end", default=date.today().isoformat(), type=date.fromisoformat)
    args = parser.parse_args()
    if args.start > args.end:
        parser.error("--start cannot be after --end")
    asyncio.run(run(args.start, args.end))


if __name__ == "__main__":
    main()
