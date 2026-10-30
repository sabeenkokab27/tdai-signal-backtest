// ============================================================
//  Digital Assets Institute — Signal Radar Engine Functions
//  (vendored, unmodified)
//
//  These are the EXACT evaluation functions that run live on
//  thedigitalassetsinstitute.vercel.app (radar engine, common.js).
//  This repo backtests them on real market data with no
//  modification — the same code, replayed candle-by-candle.
//
//  License: MIT (see LICENSE)
// ============================================================
"use strict";

const TP_PCT = 1.0;               // fixed target: +1%
const HOUR_MS = 3600000;
const ICT_PUMP_MIN = 1.0;         // S1: pump candle must close >= +1%
const ICT_CONS_BAND = 0.004;      // S1: consolidation band (flat trendline)
const ICT_NEAR_EMA = 0.02;        // S1: price within 2% of 1H EMA50
const ICT_TOUCH_EPS = 0.0005;     // S1: trendline touch tolerance
const WINDOW_MIN = 50;            // S1: READY display window (live only)
const HB_MIN_GAP = 2;             // S2: min candles between swing lows
const HB_MAX_AGE = 12;            // S2: fresh low within 12 candles
const TF_TREND = {                // trend thresholds (pos, slope)
  "1h": { pos: 0.0015, slope: 0.0010 },
  "4h": { pos: 0.0035, slope: 0.0025 },
  "1d": { pos: 0.0080, slope: 0.0070 },
};
const V1_RSI_LINE = 55;           // V1: RSI horizontal line
const V1_HA_LEN = 10;             // V1: Smoothed HA "Len"
const V1_HA_LEN2 = 10;            // V1: Smoothed HA "Len2"
const V1_FLAT_EPS = 0.0015;       // V1: "transparent" body threshold

function fmtPct(x){ return (x >= 0 ? "+" : "") + x.toFixed(2) + "%"; }
function fmtP(x){ return x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toFixed(6); }

function emaSeries(arr, p){
  const out = new Array(arr.length).fill(null);
  if (arr.length < p) return out;
  let seed = 0;
  for (let i = 0; i < p; i++) seed += arr[i];
  out[p - 1] = seed / p;
  const k = 2 / (p + 1);
  for (let i = p; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}

function emaSkip(arr, p){
  const out = new Array(arr.length).fill(null);
  let start = -1;
  for (let i = 0; i < arr.length; i++){ if (arr[i] != null){ start = i; break; } }
  if (start + p > arr.length) return out;
  let seed = 0;
  for (let i = start; i < start + p; i++) seed += arr[i];
  let prev = seed / p;
  out[start + p - 1] = prev;
  const k = 2 / (p + 1);
  for (let i = start + p; i < arr.length; i++){ prev = arr[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function rsiSeries(closes, p = 14){
  const out = new Array(closes.length).fill(null);
  if (closes.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++){
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  let ag = g / p, al = l / p;
  out[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < closes.length; i++){
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function evalTrend(closed, priceNow, posTol, slopeTol){
  if (posTol == null) posTol = TF_TREND["1h"].pos;
  if (slopeTol == null) slopeTol = TF_TREND["1h"].slope;
  const closes = closed.map(c => c.c);
  if (closes.length < 66) return null;
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const n = closes.length - 1;
  const e20 = ema20[n], e50 = ema50[n], e20p6 = ema20[n - 6];
  if (!e20 || !e50 || !e20p6) return null;
  const pos = priceNow / e20 - 1;      // price vs EMA20
  const slope = e20 / e20p6 - 1;       // EMA20 ka 6h slope
  let kind = "SIDEWAYS";
  if (pos > posTol && slope > slopeTol) kind = "UP";
  else if (pos < -posTol && slope < -slopeTol) kind = "DOWN";
  const last24 = closed.slice(-24);
  const hi24 = Math.max(...last24.map(c => c.h));
  const lo24 = Math.min(...last24.map(c => c.l));
  return {
    kind,
    pos: pos * 100,                    // % vs EMA20
    slope: slope * 100,                // EMA20 6h slope %
    e20, e50,
    ema50pos: (priceNow / e50 - 1) * 100,
    hi24, lo24,
    hist: closed.slice(-48).map(c => c.c),
  };
}

function evalPattern(closed, cur, offset, nowMin){
  if (closed.length < 30 + offset) return null;
  const n = closed.length - 1;
  const i5 = n - offset, i1 = i5 - 4;
  if (i1 < 1) return null;
  const C1 = closed[i1], C2 = closed[i1 + 1], C3 = closed[i1 + 2], C4 = closed[i1 + 3], C5 = closed[i5];
  const C6 = offset ? closed[n] : { t: cur.t, o: cur.o, c: cur.price }; // current (live) ya just-closed
  const E  = offset ? { t: cur.t, o: cur.o, c: cur.price } : null;      // entry candle (agli, C7)

  const isRed   = c => c.c < c.o;
  const isGreen = c => c.c > c.o;
  const pump    = c => (c.c - c.o) / c.o * 100; // pump = candle ke open se close tak ka move

  // ① TREND = sirf CONSOLIDATION (aap ki rule — UP/DOWNTREND mein signal NAHI)
  //    Consolidation = trendline flat (±0.4% band) + price EMA50(1h) ke aas paas (±2%)
  const closes = closed.map(c => c.c);
  const ema50 = emaSeries(closes, 50)[n];
  const priceNow = cur.price;
  const lineMove = (C5.l - C1.l) / C1.l;                       // trendline ka move (C1 se C5 tak)
  const isCons = Math.abs(lineMove) <= ICT_CONS_BAND;          // flat = consolidation
  const nearEma = ema50 ? Math.abs(priceNow / ema50 - 1) <= ICT_NEAR_EMA : true;
  const trendKind = isCons ? "CONS" : (lineMove > 0 ? "UP" : "DOWN");
  const trendOk = isCons && nearEma;

  // ⑥ TRENDLINE: C1 ki low wick → C5 ki low wick (C5 close ho rahi hai us time tak)
  const line = { t1: C1.t, p1: C1.l, t2: C5.t + HOUR_MS, p2: C5.l };
  const slopePct = (line.p2 - line.p1) / line.p1 * 100;
  const at = t => line.p1 + (line.p2 - line.p1) * ((t - line.t1) / (line.t2 - line.t1));
  // ⑦ body touch/cross? (⑧ wick sirf ho to nahi) — anchors C1/C5 nahi check (line unki wicks par hai)
  const bodyHit = cd => {
    const L1 = at(cd.t), L2 = at(cd.t + HOUR_MS);
    const lo = Math.min(cd.o, cd.c), hi = Math.max(cd.o, cd.c);
    const minL = Math.min(L1, L2), maxL = Math.max(L1, L2);
    return (lo <= maxL + ICT_TOUCH_EPS) || (hi < minL - ICT_TOUCH_EPS);
  };
  let touchedBy = null;
  for (const [nm, cd] of [["C2", C2], ["C3", C3], ["C4", C4], ["C6", C6]]){
    if (bodyHit(cd)){ touchedBy = nm; break; }
  }
  if (!touchedBy && E && bodyHit(E)) touchedBy = "C7";

  const c1ok  = isRed(C1);
  const c2ok  = isGreen(C2) && pump(C2) >= ICT_PUMP_MIN;
  const c3ok  = isRed(C3);
  const c4ok  = isGreen(C4) && pump(C4) >= ICT_PUMP_MIN;
  const c5ok  = isRed(C5);
  const curOk = isGreen(C6);
  const tlOk  = isCons && !touchedBy;

  const wick1 = C1.c - C1.l; // C1 red → lower wick = close - low
  const checks = {
    trend: { id: "trend", label: "① Trend = CONSOLIDATION", pass: trendOk,
             detail: trendOk ? "CONS ✓ (flat range)" : (trendKind === "UP" ? "UP — CONS only" : trendKind === "DOWN" ? "DOWN — CONS only" : "price too far from EMA50") },
    c1:    { id: "c1", label: "⑥ C1 RED + wick", pass: c1ok,
             detail: isRed(C1) ? (wick1 > 0 ? "wick " + fmtPct(wick1 / C1.l * 100, 2) : "no wick") : "not red" },
    c2:    { id: "c2", label: "⑤ C2 GREEN ≥1% pump", pass: c2ok,
             detail: isGreen(C2) ? fmtPct(pump(C2)) + (pump(C2) >= ICT_PUMP_MIN ? "" : " (below 1%)") : "not green" },
    c3:    { id: "c3", label: "④ C3 RED (beech)", pass: c3ok,
             detail: isRed(C3) ? "red OK" : (isGreen(C3) ? "green ✗" : "doji") },
    c4:    { id: "c4", label: "③ C4 GREEN ≥1% pump", pass: c4ok,
             detail: isGreen(C4) ? fmtPct(pump(C4)) + (pump(C4) >= ICT_PUMP_MIN ? "" : " (below 1%)") : "not green" },
    c5:    { id: "c5", label: "② C5 RED (before current)", pass: c5ok,
             detail: isRed(C5) ? "red OK" : (isGreen(C5) ? "green ✗" : "doji") },
    tl:    { id: "tl", label: "⑦⑧ Trendline clean (bodies)", pass: tlOk,
             detail: touchedBy ? touchedBy + " body touch ✗" : (isCons ? "clean · flat " + slopePct.toFixed(2) + "%" : "line rising/steep — flat only") },
    cur:   { id: "cur", label: "② Current GREEN", pass: curOk,
             detail: isGreen(C6) ? fmtPct(pump(C6)) : (C6.c < C6.o ? "red ✗" : "doji") },
  };
  const all = Object.values(checks).every(x => x.pass);
  return {
    checks, all, line, inWindow: nowMin >= WINDOW_MIN,
    c2pump: pump(C2), c4pump: pump(C4), lineSlope: slopePct,
    trendKind, ema50,
    C1, C2, C3, C4, C5, C6,
    closedEnd: C5,
  };
}

function evalHiddenBullish(closed, priceNow){
  if (closed.length < 60) return { pass:false, noDivergence:true };
  const closes = closed.map(c => c.c);
  const rsi = rsiSeries(closes, 14);
  const n = closed.length - 1;
  const rsiNow = rsi[n];
  // Swing lows (fractal lows, K=2 candles each side) last ~48 candles mein
  const K = 2, LOOKBACK = 48;
  const start = Math.max(K + 1, n - LOOKBACK);
  const swingLows = [];
  for (let i = start; i <= n - K; i++){
    let isLow = true;
    for (let j = i - K; j <= i + K; j++){
      if (j === i) continue;
      if (closed[j].l <= closed[i].l){ isLow = false; break; }
    }
    if (isLow) swingLows.push(i);
  }
  if (swingLows.length < 2) return { pass:false, noDivergence:true, rsiNow };
  const i2 = swingLows[swingLows.length - 1]; // naya low
  const i1 = swingLows[swingLows.length - 2]; // purana low
  const low1 = closed[i1].l, low2 = closed[i2].l;
  const rsi1 = rsi[i1], rsi2 = rsi[i2];
  const age = n - i2, gap = i2 - i1;
  // price lower/equal low (0.05% tolerance — higher low divergence NAHI ginta)
  const priceLower = low2 <= low1 * 1.0005;
  const rsiHigher = rsi2 > rsi1 + 0.5;          // RSI higher low
  const fresh = age <= HB_MAX_AGE && gap >= HB_MIN_GAP;
  const inZone = rsi2 >= 30 && rsi2 <= 40;      // Aap ki rule: hidden bullish SIRF RSI 30-40 zone mein = signal
  // Aap ki rule (updated): S2 signal SIRF UPTREND mein — 1H trend UP (price EMA20 ke upar + EMA20 rising)
  const trend = evalTrend(closed, priceNow);
  const trendUp = !!(trend && trend.kind === "UP");
  const pass = priceLower && rsiHigher && fresh && inZone && trendUp;
  const isReal = inZone;                        // pass hone par zone hamesha REAL (gate ke baad)
  return {
    pass, isReal, fresh, gap, age, rsiNow,
    low1, low2, rsi1, rsi2,
    rsiSwing: rsi2,              // naye swing low par RSI (dashboard card par "RSI @ swing low")
    swingLow: low2,              // naye swing low ki price
    trendKind: trend ? trend.kind : null,  // signal ke waqt 1H trend (sirf UP par signal aata hai)
    zone: inZone ? "REAL" : "STANDARD",
    low1T: closed[i1].t, low2T: closed[i2].t,
    noDivergence: false,
  };
}

function smoothedHA(candles, len, len2){
  const n = candles.length;
  const o1 = emaSeries(candles.map(c => c.o), len);
  const c1 = emaSeries(candles.map(c => c.c), len);
  const h1 = emaSeries(candles.map(c => c.h), len);
  const l1 = emaSeries(candles.map(c => c.l), len);
  const haC = new Array(n).fill(null), haO = new Array(n).fill(null);
  let seeded = false;
  for (let i = 0; i < n; i++){
    if (o1[i] == null || c1[i] == null || h1[i] == null || l1[i] == null) continue;
    haC[i] = (o1[i] + h1[i] + l1[i] + c1[i]) / 4;
    haO[i] = seeded ? (haO[i - 1] + haC[i - 1]) / 2 : (o1[i] + c1[i]) / 2;
    seeded = true;
  }
  const o2 = emaSkip(haO, len2), c2 = emaSkip(haC, len2);
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++){
    if (o2[i] == null || c2[i] == null) continue;
    const diff = (c2[i] - o2[i]) / o2[i];
    out[i] = diff > V1_FLAT_EPS ? "GREEN" : diff < -V1_FLAT_EPS ? "RED" : "FLAT";
  }
  return out;
}

function v1HaOk(cur, prev){ // rule ④+⑤: green, or flat after a red candle
  return cur === "GREEN" || (cur === "FLAT" && prev === "RED");
}

function v1LastStates(candles){
  const ha = smoothedHA(candles, V1_HA_LEN, V1_HA_LEN2);
  return { cur: ha[ha.length - 1], prev: ha[ha.length - 2] };
}

module.exports = {
  TP_PCT, HOUR_MS, ICT_PUMP_MIN, ICT_CONS_BAND, ICT_NEAR_EMA, ICT_TOUCH_EPS,
  WINDOW_MIN, HB_MIN_GAP, HB_MAX_AGE, TF_TREND,
  V1_RSI_LINE, V1_HA_LEN, V1_HA_LEN2, V1_FLAT_EPS,
  fmtP, fmtPct,
  emaSeries, emaSkip, rsiSeries, evalTrend, evalPattern,
  evalHiddenBullish, smoothedHA, v1HaOk, v1LastStates,
};
