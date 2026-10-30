#!/usr/bin/env node
/* ============================================================
 *  bt-fetch.js — download real market data for the backtest
 *
 *  60 liquid USDT pairs (the same universe the radar scans;
 *  stablecoins excluded) x 45 days of 1H candles, plus 30m
 *  (with 12h warmup for RSI) and 120 days of 1D (the 1D trend
 *  gate needs 66+ closed candles of history).
 *
 *  Source: data-api.binance.vision (public market data, no key).
 *  Output: data/bt-data.json (cached — re-run to refresh).
 *
 *  Usage:  node bt-fetch.js        (Node 18+ for global fetch)
 * ============================================================ */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const CACHE = path.join(DATA_DIR, "bt-data.json");
const H = 3600000;
const DAYS = 45;

const COINS = [
  // top / large-cap
  "BTC","ETH","BNB","SOL","XRP","DOGE","ADA","TRX","AVAX","LINK",
  "DOT","LTC","BCH","NEAR","UNI","AAVE","ICP","ETC","XLM","FIL",
  "ATOM","HBAR","ALGO","VET","SUI","TON","TAO","HYPE","ARB","OP",
  // meme
  "SHIB","PEPE","BONK","FLOKI","WIF","TRUMP","DOGS","PENGU","MEME",
  // defi / web3
  "MKR","CRV","COMP","SNX","SUSHI","LDO","RUNE","DYDX","JUP","JTO",
  // ai / infrastructure
  "RENDER","FET","GRT","AR","AKT","INJ",
  // layer-1 / layer-2
  "APT","SEI","POL","STX",
];
const BASE = "https://data-api.binance.vision/api/v3/klines";

async function klines(sym, interval, limit, endTime) {
  const url = `${BASE}?symbol=${sym}USDT&interval=${interval}&limit=${limit}${endTime ? `&endTime=${endTime}` : ""}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${sym} ${interval}: HTTP ${r.status}`);
  return (await r.json()).map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

// chunked fetch, oldest -> newest (Binance caps at 1000 candles/request)
async function klinesFull(sym, interval, startMs, endMs) {
  const step = { "1h": H, "30m": 1800000, "1d": 86400000 }[interval];
  const total = Math.ceil((endMs - startMs) / step);
  const out = [];
  let cur = startMs;
  while (cur < endMs) {
    const chunk = await klines(sym, interval, 1000, cur + 1000 * step);
    if (!chunk.length) break;
    for (const k of chunk) {
      if (!out.length) { if (k.t >= startMs && k.t < endMs) out.push(k); }
      else if (k.t > out[out.length - 1].t) out.push(k);
    }
    const last = chunk[chunk.length - 1].t;
    if (last <= cur) break;
    cur = last + step;
    if (out.length >= total + 5) break;
    await new Promise(r => setTimeout(r, 120)); // be gentle with rate limits
  }
  return out;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const end = Date.now() - (Date.now() % H); // last closed 1H boundary
  const start1h = end - DAYS * 24 * H;
  const start30m = start1h - 12 * H;
  const start1d = end - 120 * 86400000;

  console.log(`fetching ${COINS.length} coins · 1H ${DAYS}d, 30m +12h warmup, 1D 120d …`);
  const data = { end, start1h, coins: {} };
  let done = 0;
  const q = [...COINS];
  async function worker() {
    while (q.length) {
      const c = q.shift();
      try {
        const [k1h, k30m, k1d] = await Promise.all([
          klinesFull(c, "1h", start1h, end),
          klinesFull(c, "30m", start30m, end),
          klinesFull(c, "1d", start1d, end),
        ]);
        if (k1h.length < 200) throw new Error(`thin data: ${k1h.length} 1h candles`);
        data.coins[c] = { k1h, k30m, k1d };
        console.log(`  ${c}: 1H ${k1h.length} · 30m ${k30m.length} · 1D ${k1d.length}`);
      } catch (e) {
        console.log(`  ${c}: SKIP (${e.message})`);
        data.coins[c] = null;
      }
      done++;
      if (done % 10 === 0) console.log(`  …${done}/${COINS.length}`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  fs.writeFileSync(CACHE, JSON.stringify(data));
  const ok = Object.values(data.coins).filter(Boolean).length;
  console.log(`done: ${ok} coins with data. saved → ${CACHE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
