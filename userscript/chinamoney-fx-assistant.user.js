// ==UserScript==
// @name         中国货币网外汇助手
// @namespace    https://github.com/ttppdavy/chinamoney-fx-daily
// @version      0.5.2
// @description  一键保存中国货币网外汇曲线、查看历史分位数，并导出本地汇总 Excel。
// @author       Yutao
// @downloadURL  https://raw.githubusercontent.com/ttppdavy/chinamoney-fx-daily/main/userscript/chinamoney-fx-assistant.user.js
// @updateURL    https://raw.githubusercontent.com/ttppdavy/chinamoney-fx-daily/main/userscript/chinamoney-fx-assistant.user.js
// @match        https://www.chinamoney.com.cn/*
// @match        http://www.chinamoney.com.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      www.chinamoney.com.cn
// @run-at       document-idle
// ==/UserScript==

(async () => {
  'use strict';

  const STORE = 'cmfx.snapshots.v1';
  const CLOUD_STORE = 'cmfx.github-history.v1';
  const OPTION_BACKFILL_STORE = 'cmfx.option-backfill.v1';
  const DB_NAME = 'cmfx-local-history-v1';
  const DASHBOARD_URL = 'https://raw.githubusercontent.com/ttppdavy/chinamoney-fx-daily/main/data/daily_market_dashboard.csv';
  const MAX_SNAPSHOTS = 12_000;
  const $ = (selector, root = document) => root.querySelector(selector);
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

  function sourceType() {
    const path = location.pathname;
    if (/bkccpr/i.test(path)) return 'fixing';
    if (/hombtbrrthdt|RefRateHis/i.test(path)) return 'reference_rate';
    if (/bkcurvfsw|bmkycvfscfschdt/i.test(path)) return 'swaps';
    if (/bkcurvfqq|bmkycvivcivchdt/i.test(path)) return 'options';
    if (/bkcurvuir|bkcurvuiruuh/i.test(path)) return 'implied_rates';
    return 'unknown';
  }

  function dateOnPage() {
    const match = document.body.innerText.match(/20\d{2}[\/-]\d{1,2}[\/-]\d{1,2}/);
    return match ? match[0].replaceAll('/', '-').replace(/-(\d)(?=-|$)/g, '-0$1') : today();
  }

  function selectedOptionLabel(selector) {
    const option = $(`${selector} option:checked`);
    return clean(option?.textContent);
  }

  function findDataTable() {
    const hints = {
      fixing: ['货币对', '中间价'], reference_rate: ['货币对', '14'], swaps: ['期限', '掉期'],
      options: ['货币对', '波动率'], implied_rates: ['期限', '隐含利率'],
    }[sourceType()] || [];
    return [...document.querySelectorAll('table')].find((table) => {
      const content = clean(table.innerText);
      return hints.length && hints.every((hint) => content.includes(hint));
    });
  }

  function parseTable() {
    const table = findDataTable();
    if (!table) throw new Error('当前页面还没有找到完整的数据表。请先在官网点“查询”，等表格出现后再采集。');
    const rows = [...table.querySelectorAll('tr')]
      .map((row) => [...row.querySelectorAll('th,td')].map((cell) => clean(cell.innerText)))
      .filter((row) => row.some(Boolean));
    const headers = rows.shift();
    if (!headers || rows.length === 0) throw new Error('表格没有可保存的数据行。');
    return { headers, rows };
  }

  function optionTime() {
    const pageValue = selectedOptionLabel('#foiv-curv-rmb-time');
    const matched = pageValue.match(/(\d{1,2})\s*(?::\s*(\d{2}))?/);
    return matched ? `${matched[1].padStart(2, '0')}:${(matched[2] || '00').padStart(2, '0')}` : pageValue;
  }

  function findColumn(headers, text) {
    return headers.findIndex((header) => header.includes(text));
  }

  function normaliseSnapshot() {
    const { headers, rows } = parseTable();
    const dataset = sourceType();
    const sourceDate = dateOnPage();
    let sourceTime = '';
    let surface = '';
    if (dataset === 'options') {
      sourceTime = optionTime();
      surface = selectedOptionLabel('#foiv-curv-type');
    }
    const dateIndex = findColumn(headers, '日期');
    const timeIndex = findColumn(headers, '时');
    const rowsWithMeta = rows.map((row) => ({
      source_date: dateIndex >= 0 && /^20\d{2}/.test(row[dateIndex]) ? row[dateIndex].replaceAll('/', '-') : sourceDate,
      source_time: dataset === 'options' ? sourceTime : (timeIndex >= 0 ? row[timeIndex] : sourceTime),
      dataset, surface, values: row,
    }));
    return { captured_at: new Date().toISOString(), source_url: location.href, dataset, source_date: sourceDate, source_time: sourceTime, surface, headers, rows: rowsWithMeta };
  }

  async function snapshots() {
    const saved = await GM_getValue(STORE, []);
    return Array.isArray(saved) ? saved : [];
  }

  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function openHistoryDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('points', { keyPath: 'key' });
        store.createIndex('series', 'series'); store.createIndex('date', 'date');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function putHistoryPoints(points) {
    if (!points.length) return;
    const database = await openHistoryDb();
    for (let start = 0; start < points.length; start += 2_000) {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('points', 'readwrite');
        points.slice(start, start + 2_000).forEach((point) => transaction.objectStore('points').put(point));
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
      });
    }
    database.close();
  }

  async function allHistoryPoints() {
    const database = await openHistoryDb();
    const values = await new Promise((resolve, reject) => {
      const request = database.transaction('points').objectStore('points').getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    database.close(); return values;
  }

  async function clearHistoryPoints() {
    const database = await openHistoryDb();
    await new Promise((resolve, reject) => {
      const request = database.transaction('points', 'readwrite').objectStore('points').clear();
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
    });
    database.close();
  }

  function point(date, time, dataset, surface, tenor, metric, value, unit = '') {
    const numeric = Number(String(value ?? '').replaceAll(',', '').replace('%', ''));
    if (!Number.isFinite(numeric) || !date) return null;
    const series = [dataset, surface, tenor, metric, unit].join('|');
    return { key: [date, time, series].join('|'), date, time, dataset, surface, tenor, metric, unit, value: numeric, series };
  }

  function snapshotPoints(snapshot) {
    const index = (name) => findColumn(snapshot.headers, name);
    const valueAt = (row, name) => row.values[index(name)];
    const output = [];
    snapshot.rows.forEach((row) => {
      if (snapshot.dataset === 'fixing') output.push(point(row.source_date, row.source_time, 'fixing', '', '', 'fixing', valueAt(row, '中间价'), 'rate'));
      if (snapshot.dataset === 'swaps') {
        const tenor = valueAt(row, '期限');
        output.push(point(row.source_date, row.source_time, 'swaps', '', tenor, 'swap_points', valueAt(row, '掉期点'), 'pips'));
        output.push(point(row.source_date, row.source_time, 'swaps', '', tenor, 'forward_all_in', valueAt(row, '全价'), 'rate'));
      }
      if (snapshot.dataset === 'implied_rates') output.push(point(row.source_date, row.source_time, 'implied_rates', '', valueAt(row, '期限'), 'implied_usd_rate', valueAt(row, '隐含利率'), 'pct'));
      if (snapshot.dataset === 'options') {
        const tenor = valueAt(row, '期限');
        output.push(point(row.source_date, row.source_time, 'options', snapshot.surface, tenor, 'implied_vol_mid', valueAt(row, '波动率(%)'), 'pct'));
        output.push(point(row.source_date, row.source_time, 'options', snapshot.surface, tenor, 'implied_vol_bid', valueAt(row, '波动率报买'), 'pct'));
        output.push(point(row.source_date, row.source_time, 'options', snapshot.surface, tenor, 'implied_vol_ask', valueAt(row, '波动率报卖'), 'pct'));
      }
    });
    return output.filter(Boolean);
  }
  const pageSignature = () => clean(findDataTable()?.innerText).slice(0, 1_500);
  function pagerButton(kind) {
    return document.querySelector(`.san-pagination .page-${kind} a, .san-pagination .page-${kind}, .pagination .${kind} a, .pagination .${kind}`);
  }
  async function clickAndWait(button, previous) {
    if (!button || button.classList.contains('disabled') || button.getAttribute('aria-disabled') === 'true') return false;
    button.click();
    for (let attempt = 0; attempt < 35; attempt += 1) {
      await pause(180);
      if (pageSignature() !== previous) return true;
    }
    return false;
  }

  async function collectAllPages() {
    // ChinaMoney tables use the same pagination component across the curve pages.
    // We drive that component once, rather than requiring the user to save every page.
    const first = pagerButton('first');
    const beforeFirst = pageSignature();
    if (first) await clickAndWait(first, beforeFirst);
    const firstSnapshot = normaliseSnapshot();
    const allRows = [...firstSnapshot.rows];
    const seenPages = new Set([JSON.stringify(firstSnapshot.rows.map((row) => row.values))]);
    let prior = pageSignature();
    for (let page = 0; page < 200; page += 1) {
      const next = pagerButton('next');
      if (!await clickAndWait(next, prior)) break;
      const snapshot = normaliseSnapshot();
      const pageKey = JSON.stringify(snapshot.rows.map((row) => row.values));
      if (seenPages.has(pageKey)) break;
      seenPages.add(pageKey);
      allRows.push(...snapshot.rows);
      prior = pageSignature();
    }
    return { ...firstSnapshot, rows: allRows };
  }

  async function saveCurrent() {
    const current = await collectAllPages();
    const saved = await snapshots();
    const key = `${current.dataset}|${current.source_date}|${current.source_time}|${current.surface}|${current.source_url}`;
    const next = [current, ...saved.filter((item) => `${item.dataset}|${item.source_date}|${item.source_time}|${item.surface}|${item.source_url}` !== key)].slice(0, MAX_SNAPSHOTS);
    await GM_setValue(STORE, next);
    await putHistoryPoints(snapshotPoints(current));
    return current;
  }

  function metricValue(snapshot, row) {
    const { headers } = snapshot;
    const number = (column) => Number(String(row.values[column] || '').replaceAll(',', '').replace('%', ''));
    if (snapshot.dataset === 'options') {
      const mid = findColumn(headers, '波动率(%)');
      return mid >= 0 ? number(mid) : NaN;
    }
    if (snapshot.dataset === 'swaps') {
      const points = findColumn(headers, '掉期点');
      return points >= 0 ? number(points) : NaN;
    }
    if (snapshot.dataset === 'implied_rates') {
      const rate = findColumn(headers, '隐含利率');
      return rate >= 0 ? number(rate) : NaN;
    }
    const rate = findColumn(headers, snapshot.dataset === 'fixing' ? '中间价' : '14');
    return rate >= 0 ? number(rate) : NaN;
  }

  function seriesKey(snapshot, row) {
    const h = snapshot.headers;
    const pair = row.values[findColumn(h, '货币对')] || '';
    const tenor = row.values[findColumn(h, '期限')] || '';
    return [snapshot.dataset, snapshot.surface, pair, tenor].map(clean).join('|');
  }

  async function summaryRows() {
    const all = await snapshots();
    const flat = all.flatMap((snapshot) => snapshot.rows.map((row) => ({ snapshot, row, value: metricValue(snapshot, row), key: seriesKey(snapshot, row) })))
      .filter((item) => Number.isFinite(item.value));
    const groups = new Map();
    flat.forEach((item) => groups.set(item.key, [...(groups.get(item.key) || []), item]));
    const local = flat.map((item) => {
      const history = groups.get(item.key).filter((x) => x.row.source_date <= item.row.source_date).sort((a, b) => a.row.source_date.localeCompare(b.row.source_date));
      const values = history.map((x) => x.value);
      const percentile = values.length ? (100 * values.filter((x) => x <= item.value).length / values.length).toFixed(1) : '';
      const previous = history.length > 1 ? history.at(-2).value : null;
      return { date: item.row.source_date, time: item.row.source_time, dataset: item.snapshot.dataset, surface: item.snapshot.surface, series: item.key, value: item.value, change: previous === null ? '' : (item.value - previous).toFixed(6), percentile, samples: values.length, source_url: item.snapshot.source_url };
    });
    const cloud = await GM_getValue(CLOUD_STORE, []);
    const fromGithub = (Array.isArray(cloud) ? cloud : []).map((item) => ({
      date: item.source_date, time: item.source_time, dataset: item.dataset, surface: item.surface,
      series: [item.dataset, item.instrument, item.surface, item.tenor, item.metric].filter(Boolean).join('|'),
      value: Number(item.value), change: item.day_change, percentile: item.percentile_3y || item.percentile_1y,
      samples: item.observations_3y || item.observations_1y, source_url: item.source_url,
    })).filter((item) => Number.isFinite(item.value));
    return [...fromGithub, ...local].sort((a, b) => `${b.date}${b.series}`.localeCompare(`${a.date}${a.series}`));
  }

  async function localHistorySummary() {
    const points = await allHistoryPoints();
    const groups = new Map();
    points.forEach((item) => groups.set(item.series, [...(groups.get(item.series) || []), item]));
    const output = [];
    groups.forEach((series) => {
      series.sort((a, b) => `${a.date}|${a.time}`.localeCompare(`${b.date}|${b.time}`));
      const latest = series.at(-1); const latestDate = new Date(`${latest.date}T00:00:00`);
      const lookback = (days) => series.filter((item) => (latestDate - new Date(`${item.date}T00:00:00`)) / 86_400_000 <= days);
      const oneYear = lookback(365); const threeYear = lookback(1095);
      const percentile = (items) => items.length ? (100 * items.filter((item) => item.value <= latest.value).length / items.length).toFixed(1) : '';
      const previous = series.length > 1 ? series.at(-2).value : null;
      output.push({ date: latest.date, time: latest.time, dataset: latest.dataset, surface: latest.surface, series: latest.series, value: latest.value, change: previous === null ? '' : (latest.value - previous).toFixed(6), percentile: percentile(threeYear), percentile_1y: percentile(oneYear), samples: threeYear.length, source_url: '中国货币网官方历史接口' });
    });
    return output.sort((a, b) => `${b.date}${b.series}`.localeCompare(`${a.date}${a.series}`));
  }

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  function download(name, content, mime = 'application/vnd.ms-excel;charset=utf-8') {
    const url = URL.createObjectURL(new Blob(['\ufeff', content], { type: mime }));
    // Native downloads work with Blob URLs in Chrome/Edge; GM_download rejects
    // them in some Tampermonkey versions, which caused the first export failure.
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.style.display = 'none';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }

  async function exportCurrent() {
    const snapshot = await collectAllPages();
    const table = `<table><thead><tr>${snapshot.headers.map((x) => `<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${snapshot.rows.map((r) => `<tr>${r.values.map((x) => `<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    download(`中国货币网_${snapshot.dataset}_${snapshot.source_date}.xls`, `<html><meta charset="utf-8"><body>${table}</body></html>`);
  }

  async function exportHistory() {
    const localRows = await localHistorySummary();
    const rows = localRows.length ? localRows : await summaryRows();
    if (!rows.length) throw new Error('还没有本地历史快照。先在官网查询相应日期，再点击“采集当前页”。');
    const headers = ['日期', '时点', '模块', '曲面', '序列', '数值', '日变动', '历史分位(%)', '样本数', '来源链接'];
    const body = rows.map((r) => [r.date, r.time, r.dataset, r.surface, r.series, r.value, r.change, r.percentile, r.samples, r.source_url]);
    const table = `<table><thead><tr>${headers.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((x) => `<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    download(`中国货币网外汇历史汇总_${today()}.xls`, `<html><meta charset="utf-8"><body>${table}</body></html>`);
  }

  async function renderHistory(container) {
    const localRows = await localHistorySummary();
    const rows = localRows.length ? localRows : await summaryRows();
    if (!rows.length) { container.innerHTML = ''; return 0; }
    container.innerHTML = `<table><thead><tr><th>日期</th><th>序列</th><th>数值</th><th>分位</th></tr></thead><tbody>${rows.slice(0, 12).map((r) => `<tr><td>${escapeHtml(r.date)}</td><td title="${escapeHtml(r.series)}">${escapeHtml(r.series).slice(-18)}</td><td>${escapeHtml(r.value)}</td><td>${escapeHtml(r.percentile)}%</td></tr>`).join('')}</tbody></table>`;
    return rows.length;
  }

  function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]; const next = text[index + 1];
      if (char === '"' && quoted && next === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
      else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && next === '\n') index += 1; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
      else cell += char;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const [headers, ...data] = rows;
    return data.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
  }

  function githubDashboard() {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url: `${DASHBOARD_URL}?t=${Date.now()}`,
      onload: (response) => response.status === 200 ? resolve(parseCsv(response.responseText)) : reject(new Error(`GitHub 历史文件尚未生成（HTTP ${response.status}）`)),
      onerror: () => reject(new Error('无法连接 GitHub 历史数据文件。')),
    }));
  }

  async function syncGithubHistory() {
    const rows = await githubDashboard();
    await GM_setValue(CLOUD_STORE, rows);
    return rows.length;
  }

  async function officialJson(url) {
    // Use the page realm's fetch, not Tampermonkey's sandbox fetch. This is
    // the same request shape captured from ChinaMoney's own pages: same
    // origin, same Referer, cookies included and XMLHttpRequest header.
    const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    const target = new URL(url, page.location.href);
    if (target.origin !== page.location.origin) throw new Error('只允许请求当前中国货币网页面的同源接口。');
    const requestUrl = `${target.pathname}${target.search}`;
    if (typeof page.fetch === 'function') {
      let response;
      try {
        response = await page.fetch(requestUrl, {
          method: 'POST', credentials: 'include',
          headers: { accept: 'application/json, text/javascript, */*; q=0.01', 'x-requested-with': 'XMLHttpRequest' },
        });
      } catch (error) { throw new Error(`官网页面请求连接失败：${error.message}`); }
      if (!response.ok) throw new Error(`官网页面请求失败：HTTP ${response.status}`);
      try { return await response.json(); }
      catch { throw new Error('官网页面未返回 JSON 数据。'); }
    }
    throw new Error('官网页面尚未加载完毕。请等待 3 秒后重试。');
  }

  function isoDate(value) {
    const matched = String(value || '').match(/(20\d{2})\D+(\d{1,2})\D+(\d{1,2})/);
    return matched ? `${matched[1]}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}` : today();
  }

  function directSnapshot(dataset, sourceDate, sourceTime, surface, headers, records, sourceUrl) {
    return {
      captured_at: new Date().toISOString(), source_url: sourceUrl, dataset, source_date: sourceDate, source_time: sourceTime, surface, headers,
      rows: records.map((values) => ({ source_date: sourceDate, source_time: sourceTime, dataset, surface, values: values.map((value) => clean(value)) })),
    };
  }

  async function collectFourOfficialSources() {
    const root = 'https://www.chinamoney.com.cn';
    const requestedOptionTime = sourceType() === 'options' ? optionTime() || '16:00' : '16:00';
    const requestedOptionDate = sourceType() === 'options' ? dateOnPage() : today();
    const [fixing, swapConfig, implied, optionConfig] = await Promise.all([
      officialJson(`${root}/r/cms/www/chinamoney/data/fx/ccpr.json`),
      officialJson(`${root}/ags/ms/cm-u-bk-fx/FxSwapCp`),
      officialJson(`${root}/ags/ms/cm-u-bk-fx/IuirCurv?rmbRateSrc=24&bpSrc=26&spotrateSrc=29&ccyPair=USD.CNY`),
      officialJson(`${root}/ags/ms/cm-u-bk-fx/FoivltltyCurv?ccyPair=USD.CNY&volatilitySurface=0&ccyTime=${encodeURIComponent(requestedOptionTime)}&ccyDate=${encodeURIComponent(requestedOptionDate)}`),
    ]);
    const collected = [];
    const fixingDate = isoDate(fixing.data?.lastDate);
    collected.push(directSnapshot('fixing', fixingDate, '09:15', '', ['货币对', '中间价', '变动(BP)'], (fixing.records || []).map((r) => [r.vrtEName || r.vrtName, r.price, r.bp]), `${root}/chinese/bkccpr/`));

    const swapPair = swapConfig.data?.cplist?.[0] || 'USD.CNY';
    const swap = await officialJson(`${root}/r/cms/www/chinamoney/data/fx/fx-sw-curv-${swapPair}.json`);
    const swapDate = isoDate(swap.data?.showDateCN || swap.data?.showDate);
    collected.push(directSnapshot('swaps', swapDate, swap.data?.time || '', '', ['期限品种', '掉期点(Pips)', '掉期点数据源', '全价汇率', '远端起息日'], (swap.data?.voArray || []).map((r) => [r.tenor, r.points, r.source || r.sourceCN, r.swapAllPrc, r.valueDate || r.valueDateCN]), `${root}/chinese/bkcurvfsw/`));

    const impliedDate = isoDate(implied.data?.showDateCN);
    collected.push(directSnapshot('implied_rates', impliedDate, implied.data?.time || '16:50', '', ['期限', '隐含利率(%)', '人民币利率(%)', '即期汇率', '远/掉期点(Pips)'], (implied.records || []).map((r) => [r.tl, r.dollarRateDes || r.dollarRate, r.rmbRate || r.rmbRateStr, r.spotPrice || r.spotrateStr, r.bp || r.bpSrcStr]), `${root}/chinese/bkcurvuir/`));

    const optionData = optionConfig.data || {};
    const optionDate = isoDate(optionData.ccyDate);
    const selectedTime = optionData.ccyTime || requestedOptionTime;
    const surfaces = (optionData.volatilitySurfaceList || []).filter((item) => /ATM|25D\s*RR|10D\s*BF|25D\s*BF/i.test(`${item.cnLabel || ''} ${item.enLabel || ''}`));
    for (const item of (surfaces.length ? surfaces : optionData.volatilitySurfaceList || [])) {
      const result = await officialJson(`${root}/ags/ms/cm-u-bk-fx/FoivltltyCurv?ccyPair=${encodeURIComponent(optionData.ccyPair || 'USD.CNY')}&volatilitySurface=${encodeURIComponent(item.value)}&ccyTime=${encodeURIComponent(selectedTime)}&ccyDate=${encodeURIComponent(optionData.ccyDate || '')}`);
      const surface = item.cnLabel || item.enLabel || item.value;
      collected.push(directSnapshot('options', optionDate, selectedTime, surface, ['货币对', '波动率类型', '关键期限点', '波动率(%)', '波动率报买(%)', '波动率报卖(%)'], (result.records || []).map((r) => [r.ccyPair || optionData.ccyPair, r.volatilityType || surface, r.tenor, r.midVolatilityStr, r.bidVolatilityStr, r.askVolatilityStr]), `${root}/chinese/bkcurvfqq/`));
    }
    return collected;
  }

  async function saveMany(snapshotsToSave) {
    const saved = await snapshots();
    const map = new Map(saved.map((item) => [`${item.dataset}|${item.source_date}|${item.source_time}|${item.surface}|${item.source_url}`, item]));
    snapshotsToSave.forEach((item) => map.set(`${item.dataset}|${item.source_date}|${item.source_time}|${item.surface}|${item.source_url}`, item));
    const next = [...map.values()].sort((a, b) => b.captured_at.localeCompare(a.captured_at)).slice(0, MAX_SNAPSHOTS);
    await GM_setValue(STORE, next);
    await putHistoryPoints(snapshotsToSave.flatMap(snapshotPoints));
    return snapshotsToSave.reduce((total, item) => total + item.rows.length, 0);
  }

  const OPTION_SURFACES = [
    { value: '0', label: 'ATM' }, { value: '7', label: '25D RR' },
    { value: 'a', label: '10D BF' }, { value: '8', label: '25D BF' },
  ];
  const OPTION_TIMES = ['10:00', '11:00', '14:00', '15:00', '16:00'];

  function optionBackfillJobs(startDate, endDate) {
    const jobs = [];
    const cursor = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    while (cursor <= end) {
      // The endpoint returns no curve on weekends. Skipping them materially
      // reduces the backfill without omitting any published ChinaMoney curves.
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
        const date = cursor.toISOString().slice(0, 10);
        OPTION_TIMES.forEach((time) => OPTION_SURFACES.forEach((surface) => jobs.push({ date, time, ...surface })));
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return jobs;
  }

  async function backfillOptionCurves(startDate, progress) {
    const root = 'https://www.chinamoney.com.cn';
    const concurrency = 4;
    const endDate = today();
    const jobs = optionBackfillJobs(startDate, endDate);
    const savedState = await GM_getValue(OPTION_BACKFILL_STORE, {});
    let index = savedState.startDate === startDate && savedState.endDate === endDate ? Number(savedState.index || 0) : 0;
    let savedPoints = Number(savedState.savedPoints || 0);
    for (; index < jobs.length; index += concurrency) {
      const batch = jobs.slice(index, index + concurrency);
      // A batch commits only after all its requests return. If a request is
      // interrupted, the saved index remains at this batch's first item, so
      // clicking again simply re-runs at most four idempotent data writes.
      const responses = await Promise.all(batch.map(async (job) => {
        const parameters = new URLSearchParams({ ccyPair: 'USD.CNY', volatilitySurface: job.value, ccyTime: job.time, ccyDate: job.date });
        const result = await officialJson(`${root}/ags/ms/cm-u-bk-fx/FoivltltyCurv?${parameters}`);
        if (result.head?.rep_code && String(result.head.rep_code) !== '200') throw new Error(`期权曲线接口返回 ${result.head.rep_code}（${job.date} ${job.time} ${job.label}）`);
        return { job, records: result.records || [] };
      }));
      const points = responses.flatMap(({ job, records }) => records.flatMap((record) => [
        point(job.date, job.time, 'options', job.label, record.tenor, 'implied_vol_mid', record.midVolatilityStr, 'pct'),
        point(job.date, job.time, 'options', job.label, record.tenor, 'implied_vol_bid', record.bidVolatilityStr, 'pct'),
        point(job.date, job.time, 'options', job.label, record.tenor, 'implied_vol_ask', record.askVolatilityStr, 'pct'),
      ])).filter(Boolean);
      await putHistoryPoints(points); savedPoints += points.length;
      const completed = index + batch.length;
      await GM_setValue(OPTION_BACKFILL_STORE, { startDate, endDate, index: completed, savedPoints });
      if (completed % 12 === 0 || completed === jobs.length) {
        const last = batch.at(-1);
        progress(`期权回填：${completed}/${jobs.length} 请求（4 路并发）；已保存 ${savedPoints} 条，${last.date} ${last.time} ${last.label}`);
      }
      await pause(60);
    }
    await GM_setValue(OPTION_BACKFILL_STORE, { startDate, endDate, index: 0, savedPoints, completedAt: new Date().toISOString() });
    return savedPoints;
  }

  function officialDownload() {
    const button = [...document.querySelectorAll('a,button,input[type="button"]')].find((node) => /导出\s*Excel|下载|Save to Excel/i.test(clean(node.value || node.textContent)));
    if (!button) throw new Error('此页面未找到官网“导出 Excel”按钮。请先在官网选择日期/曲面后手工导出。');
    button.click();
  }

  function mount() {
    const host = document.createElement('section');
    host.id = 'cmfx-assistant';
    host.innerHTML = `
      <button class="cmfx-toggle">FX</button>
      <div class="cmfx-card" hidden>
        <strong>中国货币网外汇助手 <small>v0.5.2</small></strong>
        <span class="cmfx-note">四类最新均走官网接口；期权历史按日期、时点、曲面逐笔回填</span>
        <button data-action="all">一键抓取四类官网最新</button>
        <button data-action="backfill">期权回填 2023 至今（可续跑）</button>
        <button data-action="save">自动采集全部页</button>
        <button data-action="current">导出当前 Excel</button>
        <button data-action="official">官网下载 Excel</button>
        <button data-action="history">展示 / 导出历史</button>
        <button data-action="clear" class="cmfx-danger">清空本地历史</button>
        <p class="cmfx-status">当前模块：${sourceType()}</p>
        <div class="cmfx-preview"></div>
      </div>`;
    document.body.append(host);
    const card = $('.cmfx-card', host); const status = $('.cmfx-status', host); const preview = $('.cmfx-preview', host);
    $('.cmfx-toggle', host).onclick = () => { card.hidden = !card.hidden; };
    host.addEventListener('click', async (event) => {
      const action = event.target.dataset.action;
      if (!action) return;
      try {
        if (action === 'save') { const saved = await saveCurrent(); status.textContent = `已自动采集：${saved.source_date}，${saved.rows.length} 行`; }
        if (action === 'all') { status.textContent = '正在从四类官网接口抓取…'; const count = await saveMany(await collectFourOfficialSources()); await renderHistory(preview); status.textContent = `四类官网数据已保存：${count} 行`; }
        if (action === 'backfill') {
          const startDate = '2023-01-01';
          if (!confirm('将通过 FoivltltyCurv 按每个交易日、5 个时点、ATM/25D RR/10D BF/25D BF 逐笔回填。使用 4 路并发，需保持此页面打开；中断后再次点击会从断点继续。是否开始？')) return;
          const saved = await backfillOptionCurves(startDate, (message) => { status.textContent = message; });
          const count = await renderHistory(preview); status.textContent = `期权历史回填完成，累计 ${saved} 条；已生成 ${count} 个最新序列分位`; }
        if (action === 'current') { await exportCurrent(); status.textContent = '已下载当前全部页表格'; }
        if (action === 'official') { officialDownload(); status.textContent = '已调用官网导出'; }
        if (action === 'history') { const count = await renderHistory(preview); status.textContent = `本地历史：${count} 条数值记录，已下载汇总 Excel（含分位数）`; await exportHistory(); }
        if (action === 'clear' && confirm('确认清空本浏览器保存的所有中国货币网历史快照？')) { await GM_setValue(STORE, []); await GM_setValue(OPTION_BACKFILL_STORE, {}); await clearHistoryPoints(); preview.innerHTML = ''; status.textContent = '本地历史与回填断点已清空'; }
      } catch (error) { status.textContent = `未完成：${error.message}`; }
    });
  }

  GM_addStyle(`
    #cmfx-assistant{position:fixed;right:18px;bottom:18px;z-index:2147483647;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif}
    #cmfx-assistant button{border:0;border-radius:7px;padding:8px 10px;background:#f27822;color:#fff;cursor:pointer;margin:4px 0;font:inherit}
    #cmfx-assistant .cmfx-toggle{border-radius:50%;width:48px;height:48px;font-weight:700;float:right;box-shadow:0 4px 14px #0004}
    #cmfx-assistant .cmfx-card{clear:both;width:260px;background:#fff;border-radius:10px;box-shadow:0 8px 28px #0004;padding:14px;margin-bottom:10px;color:#222}
    #cmfx-assistant strong,#cmfx-assistant .cmfx-note{display:block}.cmfx-note{color:#777;font-size:11px;margin:3px 0 8px}
    #cmfx-assistant .cmfx-card button{display:block;width:100%;text-align:left}.cmfx-danger{background:#777!important}.cmfx-status{font-size:11px;color:#555;margin:8px 0 0}#cmfx-assistant .cmfx-preview{max-height:200px;overflow:auto;margin-top:7px}#cmfx-assistant .cmfx-preview table{font-size:10px;border-collapse:collapse;width:100%}#cmfx-assistant .cmfx-preview td,#cmfx-assistant .cmfx-preview th{border-bottom:1px solid #eee;padding:3px;text-align:left;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  `);
  mount();
})();
