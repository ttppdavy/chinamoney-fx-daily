# China Money FX Daily

每天从中国货币网官方页面取得外汇市场数据，并把**原始响应、标准化长表和运行质量报告**提交到本仓库。设计目标是让后续窗口直接按日期、期限和波动率类型做比较，而不是重新读取网页。

## 采集内容

| 模块 | 官方页面 | 保存字段 |
|---|---|---|
| 汇率中间价 | `bkccpr` | USD/CNY 中间价、变动 |
| 人民币外汇参考汇率 | `RefRateHis` | USD/CNY **14:00** 参考汇率 |
| 掉期曲线 | `bkcurvfsw` | 1M、3M、6M、1Y及完整期限的掉期点、全价、数据源 |
| 期权曲线 | `bkcurvfqq` | 中国货币网页面当时默认的 ATM、25D RR、10D BF、25D BF；完整期限的中间/买/卖隐波 |
| 外币隐含利率 | `bkcurvuir` | 美元隐含利率曲线及页面披露的参数组合、期限和原始字段 |

中国货币网说明：外币隐含利率曲线在每个工作日 16:50 发布，外汇掉期曲线在 17:00 发布；工作流安排在北京时间 17:20 运行。期权页面当日最新可得时点一并留存。

## 数据结构

```text
data/
├── raw/YYYY-MM-DD/*.json.gz   # 页面调用的 JSON 响应；无 JSON 时保留完整表格快照
├── observations.csv           # 可直接导入 Excel / pandas 的历史长表
├── daily_market_dashboard.csv # 每个指标的日变动、1年及3年历史分位数
└── latest_run.json            # 当天来源日期、时点、行数和质量结果
```

`observations.csv` 的唯一键为 `source_date + source_time + dataset + instrument + surface + tenor + metric + value`，重复运行同一天不会重复追加。`daily_market_dashboard.csv` 中的分位数采用“当前值及此前滚动窗口内数据中，不高于当前值的占比”；同时列出实际样本数，方便识别历史长度不足的情况。

## 部署到 GitHub

1. 新建一个**私有** GitHub 仓库，例如 `chinamoney-fx-daily`，将本目录全部上传到仓库根目录。
2. 在仓库 `Settings → Actions → General` 中将 *Workflow permissions* 设为 **Read and write permissions**。
3. 进入 `Actions → Collect China Money FX data → Run workflow`，先手工运行一次；生成 `data/latest_run.json` 后再等待每日任务。
4. 每个工作日北京时间 17:20，任务会在数据完整校验通过后自动提交一笔 `data:` 提交记录。
5. 首次补历史时，进入 `Actions → Backfill China Money FX history → Run workflow`，默认回填 2023-01-01 起的人民币外汇参考汇率、期权全部官方时点、掉期曲线和美元隐含利率曲线。回填工作流只需运行一次；日常任务仍只补当天。

GitHub 定时任务可能有数分钟排队延迟，工作流以中国货币网页面回传的“日期/时刻”为准，不以任务启动时间冒充行情时点。

## 本地运行

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/playwright install chromium
PYTHONPATH=src python -m chinamoney_fx.collect
PYTHONPATH=src pytest -q
```

## 采集原则

- 每个页面只加载一次完整的官方曲线，并截取该页面自身调用的 JSON 响应；不按行、按期限反复请求网页。
- 期权的四类曲面通过页面已提供的查询控件读取，保留中国货币网默认时点的完整期限表和买/中/卖三档报价；历史回填覆盖官网可提供的全部时点。
- 原始文件保留 SHA-256；任何字段调整都可回到当日快照复核。
- 页面结构或字段改变时，校验会失败并阻止写入，不会悄悄把错位数据混入历史库。

数据仅用于公开市场研究，不包含客户、账户、成交、授信或内部报价数据。
