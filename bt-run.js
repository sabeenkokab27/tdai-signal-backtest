#!/usr/bin/env node
/* ============================================================
 *  bt-run.js — replay the live strategy code on real data
 *
 *  Replays the three rule-based strategies of the Digital Assets
 *  Institute radar (S1 ICT 6-candle, S2 hidden-bullish RSI
 *  divergence, V1 RSI-55 + Smoothed Heikin Ashi) candle-by-candle
 *  over the data downloaded by bt-fetch.js.
 *
 *  Rules (each strategy's exact conditions):
 *    S1: 6-candle sequence R-G-R-G-R-G with the two green candles
 *        closing >= +1%, inside a flat C1->C5 trendline (±0.4%)
 *        with price within 2% of the 1H EMA50, no body touching
 *        the trendline, C6 (last closed) green, C7 open green.
 *        Entry = C7 open. (Fires only on the hour roll.)
 *    S2: fresh swing low (<=12 candles old, >=2 apart from the
 *        previous low) that is lower-or-equal in price while RSI
 *        makes a HIGHER low, with RSI in the 30-40 zone and the
 *        1H trend UP (price > EMA20 +0.15%, EMA20 6h slope > +0.10%).
 *        24h per-coin cooldown. Entry = signal candle close.
 *    V1: RSI-14 crosses 55 from below on the last closed 1H candle,
 *        1H trend UP, 1D trend UP (EMA20 +0.8%, 6d slope +0.7%),
 *        Smoothed Heikin Ashi (10/10) GREEN — or FLAT after RED —
 *        on 1H, and RSI >= 55 + same HA state on 30m.
 *        Entry = signal candle close.
 *
 *  TP simulation: +1% checked on the HIGH of each subsequent
 *  candle, up to 72h. Primary sample = signals with >=72h of
 *  forward data. MAE/MFE measured over the 72h window.
 *
 *  Portfolio simulation: start 100 units; each signal deploys 10%
 *  of current capital; max 5 concurrent positions; a position
 *  exits at +1% target or 72h expiry (market close); marked to
 *  market hourly on real closes.
 *
 *  NO future data: at decision time t only candles with
 *  t_close <= t are visible.
 *
 *  Usage:  node bt-fetch.js && node bt-run.js
 *  Output: data/results-data.json + console summary
 * ============================================================ */
const fs = require("fs");
const path = require("path");
const E = require("./engine.js");

const DATA = path.join(__dirname, "data", "bt-data.json");
const OUT = path.join(__dirname, "data", "results-data.json");
if (!fs.existsSync(DATA)) {
  console.error("data/bt-data.json not found — run `node bt-fetch.js` first");
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(DATA, "utf8"));

const H = E.HOUR_MS, D = 86400000;
const TP_PCT = E.TP_PCT;
const HORIZON = 72 * H;

// per-coin lookup (hourly grid)
for (const cd of Object.values(data.coins)) {
  if (!cd) continue;
  const m = new Map();
  cd.k1h.forEach((c, i) => m.set(c.t, c));
  cd.k1h._idx = t => { for (let d = 0; d < 8; d++) { const k = m.get(t - d * H); if (k) return k; } return null; };
}

const signals = [];
const v1f = { crosses: 0, t1h: 0, t1d: 0, ha: 0, full: 0 };

for (const [coin, cd] of Object.entries(data.coins)) {
  if (!cd) continue;
  const k1h = cd.k1h, k30m = cd.k30m, k1d = cd.k1d;
  const closes = k1h.map(c => c.c);
  const rs = E.rsiSeries(closes, 14);
  const n = k1h.length - 1;
  const lastS2 = { t: -Infinity };

  let p30 = 0;
  function c30UpTo1h(i) { // 30m candles closed by the close of 1H candle i
    const limit = k1h[i].t + H;
    while (p30 < k30m.length && k30m[p30].t < limit) p30++;
    return k30m.slice(0, p30);
  }
  const dClosedCache = new Map();
  function dClosedUpTo1h(i) {
    const key = k1h[i].t - (k1h[i].t % D);
    if (!dClosedCache.has(key)) dClosedCache.set(key, k1d.filter(d => d.t < key));
    return dClosedCache.get(key);
  }

  for (let i = 70; i <= n - 1; i++) {
    const closed = k1h.slice(0, i + 1);
    const C = k1h[i];

    // ---------- S2: HIDDEN BULLISH ----------
    try {
      const hb = E.evalHiddenBullish(closed, C.c);
      if (hb && hb.pass && (C.t - lastS2.t > 24 * H)) {
        lastS2.t = C.t;
        signals.push({ tEntry: C.t, coin, strat: "S2", entry: C.c, idx: i });
      }
    } catch (e) {}

    // ---------- S1: ICT (hour roll: C6 closed green + C7 green open) ----------
    try {
      const N = k1h[i + 1];
      const ck = E.evalPattern(closed, { t: N.t, o: N.o, price: C.c }, 1, 0);
      if (ck && ck.all && C.c > C.o && N.o >= C.c) {
        signals.push({ tEntry: N.t, coin, strat: "S1", entry: N.o, idx: i + 1 });
      }
    } catch (e) {}

    // ---------- V1: RSI-55 cross + 1H/1D UP + HA + 30m ----------
    try {
      if (rs[i-1] != null && rs[i] != null && rs[i-1] < E.V1_RSI_LINE && rs[i] >= E.V1_RSI_LINE) {
        v1f.crosses++;
        const t1h = E.evalTrend(closed, C.c, E.TF_TREND["1h"].pos, E.TF_TREND["1h"].slope);
        if (t1h && t1h.kind === "UP") {
          v1f.t1h++;
          const t1d = E.evalTrend(dClosedUpTo1h(i), C.c, E.TF_TREND["1d"].pos, E.TF_TREND["1d"].slope);
          if (t1d && t1d.kind === "UP") {
            v1f.t1d++;
            const h1 = E.v1LastStates(closed);
            if (E.v1HaOk(h1.cur, h1.prev)) {
              v1f.ha++;
              const c30 = c30UpTo1h(i);
              if (c30.length > 60) {
                const r30 = E.rsiSeries(c30.map(c => c.c), 14);
                const h30 = E.v1LastStates(c30);
                if (r30[r30.length - 1] != null && r30[r30.length - 1] >= E.V1_RSI_LINE && E.v1HaOk(h30.cur, h30.prev)) {
                  v1f.full++;
                  signals.push({ tEntry: C.t, coin, strat: "V1", entry: C.c, idx: i });
                }
              }
            }
          }
        }
      }
    } catch (e) {}
  }
}

// ---------- TP SIMULATION ----------
for (const s of signals) {
  const k1h = data.coins[s.coin].k1h;
  const from = (s.strat === "S1") ? s.idx : s.idx + 1;
  const tp = s.entry * (1 + TP_PCT / 100);
  let hit = false, hitT = null, mae = 0, mfe = 0;
  for (let j = from; j < k1h.length && k1h[j].t - s.tEntry < HORIZON; j++) {
    const K = k1h[j];
    if (K.h >= tp && !hit) { hit = true; hitT = K.t; }
    if (K.l / s.entry - 1 < mae) mae = K.l / s.entry - 1;
    if (K.h / s.entry - 1 > mfe) mfe = K.h / s.entry - 1;
  }
  s.hit = hit;
  s.ttpH = hitT ? (hitT - s.tEntry) / H : null;
  s.mae = mae * 100; s.mfe = mfe * 100;
  s.fwdH = (k1h[k1h.length - 1].t + H - s.tEntry) / H;
  s.lastClose = k1h[k1h.length - 1].c;
}
signals.sort((a, b) => a.tEntry - b.tEntry);

// ---------- AGGREGATE ----------
const pct = x => Math.round(x * 1000) / 10;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
function stats(list, minFwd = 72) {
  const inS = list.filter(s => s.fwdH >= minFwd);
  const hit48 = inS.filter(s => s.hit && s.ttpH <= 48).length;
  const hit72 = inS.filter(s => s.hit).length;
  const ttps = inS.filter(s => s.ttpH != null).map(s => s.ttpH).sort((a, b) => a - b);
  return {
    total: list.length,
    inSample: inS.length,
    hit48: pct(hit48 / Math.max(1, inS.length)),
    hit72: pct(hit72 / Math.max(1, inS.length)),
    medianTtpH: ttps.length ? Math.round(ttps[Math.floor(ttps.length / 2)]) : null,
    meanMae: mean(inS.map(s => s.mae)),
    meanMfe: mean(inS.map(s => s.mfe)),
    worstMae: inS.length ? Math.min(...inS.map(s => s.mae)) : null,
    coins: new Set(inS.map(s => s.coin)).size,
  };
}
const byStrat = { S1: [], S2: [], V1: [] };
signals.forEach(s => byStrat[s.strat].push(s));
const perStrat = { S1: stats(byStrat.S1), S2: stats(byStrat.S2), V1: stats(byStrat.V1) };
const combined = stats(signals);

// ---------- PORTFOLIO SIM ----------
const grid = data.coins.BTC.k1h.map(c => c.t);
const sigsSorted = [...signals].sort((a, b) => a.tEntry - b.tEntry);
const open = [];
let capital = 100, peak = 100, maxDD = 0;
const curve = [];
const lc = {};
let sp = 0;
for (let g = 0; g < grid.length; g++) {
  const t = grid[g];
  for (let o = open.length - 1; o >= 0; o--) {
    const s = open[o];
    const K = data.coins[s.coin].k1h._idx(t);
    if (!K) continue;
    lc[s.coin] = K.c;
    const tp = s.entry * (1 + TP_PCT / 100);
    if (K.h >= tp) { capital += s.alloc * 1.01; open.splice(o, 1); }
    else if (t - s.tEntry >= 72 * H) { capital += s.alloc * (K.c / s.entry); open.splice(o, 1); }
  }
  while (sp < sigsSorted.length && sigsSorted[sp].tEntry === t) {
    const s = sigsSorted[sp];
    if (open.length < 5) {
      const alloc = capital * 0.10;
      capital -= alloc;
      open.push({ ...s, alloc });
    }
    sp++;
  }
  const eq = capital + open.reduce((a, s) => a + s.alloc * ((lc[s.coin] || s.entry) / s.entry), 0);
  if (g % 6 === 0) curve.push({ t, eq: Math.round(eq * 100) / 100 });
  if (eq > peak) peak = eq;
  const dd = (peak - eq) / peak * 100;
  if (dd > maxDD) maxDD = dd;
}
combined.equityCurve = curve;
combined.maxDrawdown = Math.round(maxDD * 10) / 10;
combined.finalEquity = Math.round((capital + open.reduce((a, s) => a + s.alloc * ((lc[s.coin] || s.entry) / s.entry), 0)) * 100) / 100;
combined.openAtEnd = open.length;

// monthly split
const months = {};
for (const s of signals) {
  const key = new Date(s.tEntry).toISOString().slice(0, 7);
  months[key] = months[key] || { n: 0, hit72: 0, inS: 0 };
  months[key].n++;
  if (s.fwdH >= 72) { months[key].inS++; if (s.hit) months[key].hit72++; }
}
combined.monthly = Object.fromEntries(Object.entries(months).map(([k, v]) => [k, { ...v, hitRate: v.inS ? pct(v.hit72 / v.inS) : null }]));

combined.openSignals = signals.filter(s => s.fwdH < 72).map(s => ({ coin: s.coin, strat: s.strat, t: s.tEntry, entry: +s.entry.toFixed(4), last: +s.lastClose.toFixed(4), pl: pct(s.lastClose / s.entry * 100 - 100) }));
combined.recent = signals.slice(-20).reverse().map(s => ({ coin: s.coin, strat: s.strat, t: s.tEntry, entry: +s.entry.toFixed(4), hit: s.hit, ttpH: s.ttpH ? Math.round(s.ttpH) : null, mae: Math.round(s.mae * 10) / 10, fwdH: Math.round(s.fwdH) }));

for (const k of ["S1", "S2", "V1"]) for (const f of ["meanMae", "meanMfe", "worstMae"]) perStrat[k][f] = perStrat[k][f] != null ? Math.round(perStrat[k][f] * 100) / 100 : null;
for (const f of ["meanMae", "meanMfe", "worstMae"]) combined[f] = combined[f] != null ? Math.round(combined[f] * 100) / 100 : null;

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    windowDays: 45,
    windowStart: new Date(data.start1h).toISOString().slice(0, 10),
    windowEnd: new Date(data.end).toISOString().slice(0, 10),
    coins: Object.values(data.coins).filter(Boolean).length,
    tpPct: TP_PCT,
    note: "Backtest of the live strategy code (engine.js, unmodified) replayed on real Binance klines. Entry = signal candle close (S1 = next candle open). TP +1% on subsequent candle highs, 72h horizon. Primary stats = signals with >=72h of forward data.",
  },
  perStrat, combined, v1funnel: v1f,
  strategyNames: { S1: "ICT 6-Candle Pattern", S2: "Hidden Bullish (RSI Divergence)", V1: "V1 — RSI-55 + Smoothed Heikin Ashi" },
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log("SIGNALS TOTAL:", signals.length);
for (const k of ["S1", "S2", "V1"]) {
  const p = perStrat[k];
  console.log(`${k}: total ${p.total}, inSample ${p.inSample}, hit48 ${p.hit48}%, hit72 ${p.hit72}%, medTtp ${p.medianTtpH}h, MAE ${p.meanMae}%, MFE ${p.meanMfe}%`);
}
const c = combined;
console.log(`COMBINED: inSample ${c.inSample}, hit48 ${c.hit48}%, hit72 ${c.hit72}%, medTtp ${c.medianTtpH}h, maxDD ${c.maxDrawdown}%, finalEq ${c.finalEquity}/100`);
console.log("monthly:", JSON.stringify(c.monthly));
console.log("V1 funnel:", JSON.stringify(v1f));
console.log("saved →", OUT);
