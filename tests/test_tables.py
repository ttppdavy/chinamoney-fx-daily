from chinamoney_fx.tables import normalise_table, option_observations, swap_observations


def test_option_table_to_observations():
    headers, records = normalise_table([
        ["货币对", "波动率类型", "关键期限点", "波动率(%)", "波动率报买(%)", "波动率报卖(%)"],
        ["USD.CNY", "25D RR", "1M", "0.1200", "0.1000", "0.1400"],
    ])
    assert headers[0] == "货币对"
    assert option_observations(records) == [
        {"instrument": "USD.CNY", "surface": "25D RR", "tenor": "1M", "metric": "implied_vol_mid", "value": 0.12, "unit": "pct"},
        {"instrument": "USD.CNY", "surface": "25D RR", "tenor": "1M", "metric": "implied_vol_bid", "value": 0.1, "unit": "pct"},
        {"instrument": "USD.CNY", "surface": "25D RR", "tenor": "1M", "metric": "implied_vol_ask", "value": 0.14, "unit": "pct"},
    ]


def test_swap_table_to_two_metrics():
    _, records = normalise_table([
        ["期限品种", "掉期点(Pips)", "掉期点数据源", "全价汇率", "远端起息日"],
        ["1Y", "-1771.00", "交易数据", "6.5429", "2027-08-31"],
    ])
    result = swap_observations(records)
    assert {x["metric"] for x in result} == {"swap_points", "forward_all_in"}
    assert result[0]["value"] == -1771.0
