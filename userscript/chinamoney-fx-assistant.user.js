// ==UserScript==
// @name         中国货币网外汇助手
// @namespace    https://github.com/ttppdavy/chinamoney-fx-daily
// @version      0.1.0
// @description  一键保存中国货币网外汇曲线、查看历史分位数，并导出本地汇总 Excel。
// @author       Yutao
// @match        https://www.chinamoney.com.cn/*
// @match        http://www.chinamoney.com.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(async () => {
  'use strict';

  const STORE = 'cmfx.snapshots.v1';
  const CLOUD_STORE = 'cmfx.github-history.v1';
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
    const rows = await summaryRows();
    if (!rows.length) throw new Error('还没有本地历史快照。先在官网查询相应日期，再点击“采集当前页”。');
    const headers = ['日期', '时点', '模块', '曲面', '序列', '数值', '日变动', '历史分位(%)', '样本数', '来源链接'];
    const body = rows.map((r) => [r.date, r.time, r.dataset, r.surface, r.series, r.value, r.change, r.percentile, r.samples, r.source_url]);
    const table = `<table><thead><tr>${headers.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((x) => `<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    download(`中国货币网外汇历史汇总_${today()}.xls`, `<html><meta charset="utf-8"><body>${table}</body></html>`);
  }

  async function renderHistory(container) {
    const rows = await summaryRows();
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
        <strong>中国货币网外汇助手</strong>
        <span class="cmfx-note">按当前页面时点保存；自动翻页采集</span>
        <button data-action="save">自动采集全部页</button>
        <button data-action="current">导出当前 Excel</button>
        <button data-action="official">官网下载 Excel</button>
        <button data-action="sync">同步 GitHub 长期历史</button>
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
        if (action === 'current') { await exportCurrent(); status.textContent = '已下载当前全部页表格'; }
        if (action === 'official') { officialDownload(); status.textContent = '已调用官网导出'; }
        if (action === 'sync') { const count = await syncGithubHistory(); status.textContent = `已同步 GitHub 长期历史：${count} 行`; }
        if (action === 'history') { const count = await renderHistory(preview); status.textContent = `本地历史：${count} 条数值记录，已下载汇总 Excel（含分位数）`; await exportHistory(); }
        if (action === 'clear' && confirm('确认清空本浏览器保存的所有中国货币网历史快照？')) { await GM_setValue(STORE, []); preview.innerHTML = ''; status.textContent = '本地历史已清空'; }
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
