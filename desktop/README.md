# 桌面统一数据仓库（Windows）

运行 `初始化并回填.ps1` 后，所有数据统一写到：

```text
桌面\中国货币网外汇数据\
├── 中国货币网外汇历史.xlsx
├── daily_market_dashboard.csv
├── observations.csv
└── raw\
```

首次运行会从 2023-01-01 开始回填，完成后在每个工作日 17:20 自动只补最新一天。Excel 的“每日数据与分位”工作表可直接筛选查看；“全部原始观测”保留每个时点、期限及买/中/卖报价。

首次请直接双击 `desktop\start_setup.bat`。窗口会保留全部运行信息；若失败，截取红色报错即可定位。日后需要马上刷新当天数据时，双击 `desktop\update_today.bat`。
