# Digital Assets Institute — Signal Radar: Open Backtest

A transparent backtest of the **Digital Assets Institute** signal radar — the same three rule-based
strategies, run on **45 days of real Binance market data** across 60 USDT pairs. No cherry-picked
screenshots, no "90% weekly" promises: the full dataset, the exact code, and the methodology, all
reproducible with two commands.

**The radar:** [thedigitalassetsinstitute.vercel.app](https://thedigitalassetsinstitute.vercel.app) —
[Strategy rules](https://thedigitalassetsinstitute.vercel.app/strategy) ·
[Published results](https://thedigitalassetsinstitute.vercel.app/results) ·
[How the $50 works](https://thedigitalassetsinstitute.vercel.app/pricing)

---

## What is this?

`engine.js` contains the **unmodified evaluation functions** that run live on the radar
(`common.js` on the site). `bt-run.js` replays them candle-by-candle over real 1H/30m/1D klines:
at every decision point, only candles that had already closed were visible — **no future data**.

## The three strategies (as published)

| Strategy | Rules (summary) | Entry |
|---|---|---|
| **S1 — ICT 6-Candle** | R-G-R-G-R-G sequence; the two green candles close ≥ +1%; flat C1→C5 trendline (±0.4%); price within 2% of 1H EMA50; no body touching the trendline; C6 closes green; C7 opens green | C7 open (fires on the hour roll) |
| **S2 — Hidden Bullish** | Fresh swing low (≤12 candles old) lower-or-equal in price while RSI-14 makes a **higher** low; RSI in the 30–40 zone; 1H trend UP; 24h per-coin cooldown | Signal candle close |
| **V1 — RSI-55 + Smoothed HA** | RSI-14 crosses 55 from below on the last closed 1H candle; 1H trend UP **and** 1D trend UP; Smoothed Heikin Ashi (10/10) green (or flat-after-red) on 1H **and** RSI ≥ 55 + same HA state on 30m | Signal candle close |

All signals target a fixed **+1%** (the site's 1:1 discipline). Full rule sets, per strategy, are
published on the [strategies page](https://thedigitalassetsinstitute.vercel.app/strategy).

## Results (45-day window, see `data/` for raw output)

| Strategy | Signals | Completed (≥72h fwd) | Hit +1% ≤48h | Hit +1% ≤72h | Median time-to-TP | Avg adverse (MAE) |
|---|---|---|---|---|---|---|
| S1 — ICT 6-Candle | 0 | 0 | — | — | — | — |
| S2 — Hidden Bullish | 47 | 44 | 84.1% | 84.1% | 1h | -5.9% |
| V1 — RSI-55 + HA | 139 | 138 | 87.0% | 88.4% | 2h | -6.1% |
| **Combined** | **186** | **182** | **86.3%** | **87.4%** | **2h** | — |

**Why S1 is zero:** the six-candle sequence with two ≥1% pumps inside a flat trendline is
*deliberately* rare — the pattern did not complete once in 45 days across 56 coins. That is the
strategy working as designed, not a bug.

**V1 gate funnel (transparency):** 2,918 RSI-55 crosses → 1,885 with 1H trend UP → 1,050 with
1D trend UP → 514 with Smoothed HA ok → **139 full signals**. In a downtrend the 1D gate is the
bottleneck and the strategy goes quiet — that is the point of the gate stack.

**Monthly (two regimes, not one lucky month):** September 90.9% hit rate (rising market) ·
October 83.1% (market turned down).

**Portfolio simulation** (start 100 units · 10% of capital per signal · max 5 concurrent
positions · exit at +1% or 72h market close · marked hourly on real closes):
final equity **102.7**, peak-to-trough drawdown **5.6%**.

## How to reproduce

```bash
# Node 18+ (global fetch). No API keys, no dependencies.
node bt-fetch.js   # downloads 45 days of 1H/30m/1D klines → data/bt-data.json
node bt-run.js     # replays the engine, prints + writes data/results-data.json
```

`bt-fetch.js` downloads from `data-api.binance.vision` (public market data). Coins that do not
trade on Binance USDT (e.g. a few small-caps listed elsewhere) are skipped and reported.

## Methodology (the fine print)

- **Data:** 45 days of 1H candles (plus 30m with 12h warmup and 120 days of 1D so the 1D trend
  gate has 66+ closed candles of history), 60 liquid USDT pairs — the same universe the radar
  scans; stablecoins excluded.
- **Entry:** signal candle close (S1 uses the next candle's open, matching the live hour-roll
  trigger). No slippage or fees are modelled.
- **TP:** +1% checked on the **high** of each subsequent candle, up to 72h.
- **Primary sample:** only signals with ≥72h of forward data count toward hit rates (recent,
  in-flight signals are listed separately).
- **MAE/MFE:** worst/best excursion vs entry over the 72h window.

## What this is *not*

- **Not a promise.** 45 days is a short window covering one rally and one decline. Regimes change;
  hit rates vary. Past performance is not future performance.
- **Not the live signal log.** This is "what the engine would have done". Each user's live signal
  history (with their actual entries) lives on the site's History page.
- **No fees/slippage modelled.** On liquid USDT pairs they are small but real, and they shave the
  edge slightly.
- **The ~6% average adverse move matters.** If you cannot sit through a 6% dip on a position
  while waiting for +1%, this style is not for you. (The site's
  [stop-loss guide](https://thedigitalassetsinstitute.vercel.app/article/stop-loss-spot-trader-1-percent)
  covers exactly this.)

## License

MIT — do whatever helps you learn; the strategy rules were published on the site anyway.
See [LICENSE](LICENSE).

**Note:** educational content, not financial advice. DYOR.
