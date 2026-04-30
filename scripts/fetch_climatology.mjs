// Fetches 43 years (1981-2023) of daily reanalysis data from NASA POWER
// (sources: MERRA-2 + POWER), condenses each variable into a 365-element
// (mean, std) climatology by day-of-year, writes data/climatology.json
// (mirrored to docs/data/).
//
// We switched to NASA POWER from the original Open-Meteo / ECMWF ERA5
// pull because the free Open-Meteo tier has a 10 000-call daily quota
// that is easy to exhaust at this dataset size. POWER has no daily quota
// and is the canonical NASA proxy for MERRA-2 reanalysis.
//
// Units returned by POWER are SI metric — we convert to imperial (°F, in,
// mph) here so the front-end can stay unit-agnostic.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// MERRA-2 begins 1981-01-01 with the full set of variables we need; n=43 per
// day-of-year sits well above the 30-year WMO normal and the 35-year floor.
const START = "19810101";
const END = "20231231";
const PERIOD = `${START.slice(0, 4)}-${START.slice(4, 6)}-${START.slice(6, 8)}/${END.slice(0, 4)}-${END.slice(4, 6)}-${END.slice(6, 8)}`;

// POWER name → our short key
const POWER_PARAMS = {
  T2M_MAX: "tmax",
  T2M_MIN: "tmin",
  T2M: "tmean",
  PRECTOTCORR: "precip",
  WS10M_MAX: "wind",
};
const PARAM_LIST = Object.keys(POWER_PARAMS).join(",");

// Conversion: SI → imperial
const FILL = -999;
function convert(short, val) {
  if (val == null || val === FILL) return null;
  switch (short) {
    case "tmax":
    case "tmin":
    case "tmean":
      return val * 9 / 5 + 32;          // °C → °F
    case "precip":
      return val / 25.4;                // mm → inches
    case "wind":
      return val * 2.2369362920544;     // m/s → mph
    default:
      return val;
  }
}

// 365-slot day-of-year, skip Feb 29.
const CUMULATIVE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
function doyNonLeap(yyyymmdd) {
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  if (m === 2 && d === 29) return -1;
  return CUMULATIVE[m - 1] + (d - 1);
}

function urlFor(city) {
  const params = new URLSearchParams({
    parameters: PARAM_LIST,
    community: "AG",
    longitude: city.lon.toString(),
    latitude: city.lat.toString(),
    start: START,
    end: END,
    format: "JSON",
  });
  return `https://power.larc.nasa.gov/api/temporal/daily/point?${params.toString()}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, attempts = 5) {
  let lastErr;
  const backoffs = [4_000, 12_000, 30_000, 90_000, 300_000];
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status === 503) {
        const wait = backoffs[i] ?? 300_000;
        process.stdout.write(`    ${r.status}, sleeping ${(wait / 1000).toFixed(0)}s\n`);
        await sleep(wait);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await sleep(2000 * (i + 1));
    }
  }
  throw lastErr || new Error("retry exhausted");
}

function condense(parameter) {
  // For each variable, accumulate sum and sum-of-squares per doy.
  const out = {};
  for (const short of Object.values(POWER_PARAMS)) {
    out[short] = {
      sum: new Float64Array(365),
      sumSq: new Float64Array(365),
      count: new Uint16Array(365),
    };
  }
  for (const [powerKey, short] of Object.entries(POWER_PARAMS)) {
    const series = parameter[powerKey];
    if (!series) continue;
    for (const dateKey of Object.keys(series)) {
      const doy = doyNonLeap(dateKey);
      if (doy < 0) continue;
      const v = convert(short, series[dateKey]);
      if (v == null || Number.isNaN(v)) continue;
      const slot = out[short];
      slot.sum[doy] += v;
      slot.sumSq[doy] += v * v;
      slot.count[doy] += 1;
    }
  }
  // Collapse to mean/std arrays.
  const result = {};
  for (const short of Object.values(POWER_PARAMS)) {
    const slot = out[short];
    const mean = new Array(365).fill(null);
    const std = new Array(365).fill(null);
    for (let d = 0; d < 365; d++) {
      const n = slot.count[d];
      if (n === 0) continue;
      const m = slot.sum[d] / n;
      mean[d] = +m.toFixed(2);
      const variance = Math.max(0, slot.sumSq[d] / n - m * m);
      std[d] = +Math.sqrt(variance).toFixed(2);
    }
    result[short] = { mean, std };
  }
  return result;
}

async function processCity(city) {
  const url = urlFor(city);
  const json = await fetchWithRetry(url);
  if (!json?.properties?.parameter) {
    throw new Error(`no parameter payload for ${city.id}`);
  }
  const climate = condense(json.properties.parameter);
  return { ...city, climate };
}

// Limited-concurrency map.
async function pmap(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  let done = 0;
  const startTs = Date.now();
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      const item = items[idx];
      const t0 = Date.now();
      try {
        results[idx] = await fn(item);
        done++;
        const ms = Date.now() - t0;
        const elapsed = ((Date.now() - startTs) / 1000).toFixed(0);
        process.stdout.write(`  [${idx + 1}/${items.length} · done ${done} · ${elapsed}s elapsed] ${item.id} (${ms}ms)\n`);
      } catch (e) {
        results[idx] = { ...item, climate: null, error: e.message };
        process.stdout.write(`  [${idx + 1}/${items.length}] ${item.id} FAILED: ${e.message}\n`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function readExisting() {
  try {
    const raw = await readFile(resolve(ROOT, "data", "climatology.json"), "utf8");
    const j = JSON.parse(raw);
    if (j.meta?.period !== PERIOD) {
      console.log(`existing data is for period ${j.meta?.period}, want ${PERIOD} — discarding`);
      return new Map();
    }
    const map = new Map();
    for (const c of j.cities || []) if (c.climate) map.set(c.id, c);
    return map;
  } catch {
    return new Map();
  }
}

async function flush(cities, existing) {
  const ordered = cities.map((c) => existing.get(c.id)).filter(Boolean);
  const payload = {
    meta: {
      source: "NASA POWER (MERRA-2 reanalysis)",
      attribution: "https://power.larc.nasa.gov/ — NASA Langley / GMAO MERRA-2",
      period: PERIOD,
      sampleYears: 43,
      variables: {
        tmax:   { label: "Daily High Temperature",  unit: "°F" },
        tmin:   { label: "Daily Low Temperature",   unit: "°F" },
        tmean:  { label: "Daily Mean Temperature",  unit: "°F" },
        precip: { label: "Daily Precipitation",     unit: "in" },
        wind:   { label: "Daily Max Wind Speed",    unit: "mph" },
      },
      generatedAt: new Date().toISOString(),
    },
    cities: ordered,
  };
  const outPath = resolve(ROOT, "data", "climatology.json");
  await writeFile(outPath, JSON.stringify(payload));
  const pubData = resolve(ROOT, "docs", "data");
  await mkdir(pubData, { recursive: true });
  await writeFile(resolve(pubData, "climatology.json"), JSON.stringify(payload));
  await writeFile(resolve(pubData, "cities.json"), JSON.stringify(cities));
  console.log(`Saved ${ordered.length} cities → ${(JSON.stringify(payload).length / 1024 / 1024).toFixed(2)} MB`);
}

async function main() {
  const citiesPath = resolve(ROOT, "data", "cities.json");
  const cities = JSON.parse(await readFile(citiesPath, "utf8"));

  const existing = await readExisting();
  const todo = cities.filter((c) => !existing.has(c.id));
  console.log(`Resuming: ${existing.size} cached, ${todo.length} to fetch (${PERIOD})`);

  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try { await flush(cities, existing); } catch (e) { console.warn("autosave fail", e.message); }
    }, 8000);
  };

  await pmap(todo, 3, async (city) => {
    const r = await processCity(city);
    if (r.climate) { existing.set(r.id, r); scheduleSave(); }
    return r;
  });

  await flush(cities, existing);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
