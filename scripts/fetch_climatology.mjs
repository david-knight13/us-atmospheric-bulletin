// Fetches 10 years (2014-2023) of daily ERA5 reanalysis data from Open-Meteo
// archive for every city in data/cities.json, then condenses each variable
// into a 365-element climatology of (mean, std, count) keyed by day-of-year.
// Writes data/climatology.json (also copied to public/data/).
//
// ERA5 is ECMWF's flagship reanalysis, the standard reference for retrospective
// atmospheric data. Open-Meteo proxies it without an API key.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const START = "2014-01-01";
const END = "2023-12-31";

const VARS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "temperature_2m_mean",
  "precipitation_sum",
  "wind_speed_10m_max",
];

const VAR_KEY = {
  temperature_2m_max: "tmax",
  temperature_2m_min: "tmin",
  temperature_2m_mean: "tmean",
  precipitation_sum: "precip",
  wind_speed_10m_max: "wind",
};

// 365-slot day-of-year, skipping Feb 29 to stay seasonal across leap years.
const CUMULATIVE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
function doyNonLeap(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (m === 2 && d === 29) return -1;
  return CUMULATIVE[m - 1] + (d - 1);
}

function urlFor(city) {
  const params = new URLSearchParams({
    latitude: city.lat.toString(),
    longitude: city.lon.toString(),
    start_date: START,
    end_date: END,
    daily: VARS.join(","),
    temperature_unit: "fahrenheit",
    precipitation_unit: "inch",
    wind_speed_unit: "mph",
    timezone: "auto",
  });
  return `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, attempts = 4) {
  let lastErr;
  // Generous waits — Open-Meteo's free-tier sliding window can take several
  // minutes to clear once burst-limited. Better to sleep long once than spam.
  const backoffs = [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000];
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get("retry-after") || "0", 10);
        const wait = Math.max(retryAfter * 1000, backoffs[i] || 30 * 60_000);
        process.stdout.write(`    429, cooling off ${(wait / 60_000).toFixed(1)}min\n`);
        await sleep(wait);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await sleep(3000 * (i + 1));
    }
  }
  throw lastErr || new Error("retry exhausted");
}

function condense(daily) {
  const out = {};
  for (const v of VARS) {
    out[VAR_KEY[v]] = {
      sum: new Float64Array(365),
      sumSq: new Float64Array(365),
      count: new Uint16Array(365),
    };
  }
  const dates = daily.time;
  for (let i = 0; i < dates.length; i++) {
    const doy = doyNonLeap(dates[i]);
    if (doy < 0) continue;
    for (const v of VARS) {
      const x = daily[v]?.[i];
      if (x == null || Number.isNaN(x)) continue;
      const slot = out[VAR_KEY[v]];
      slot.sum[doy] += x;
      slot.sumSq[doy] += x * x;
      slot.count[doy] += 1;
    }
  }
  // collapse to mean/std arrays
  const result = {};
  for (const v of VARS) {
    const k = VAR_KEY[v];
    const slot = out[k];
    const mean = new Array(365).fill(null);
    const std = new Array(365).fill(null);
    for (let d = 0; d < 365; d++) {
      const n = slot.count[d];
      if (n === 0) continue;
      const m = slot.sum[d] / n;
      mean[d] = +m.toFixed(2);
      // population std
      const variance = Math.max(0, slot.sumSq[d] / n - m * m);
      std[d] = +Math.sqrt(variance).toFixed(2);
    }
    result[k] = { mean, std };
  }
  return result;
}

async function processCity(city) {
  const url = urlFor(city);
  const json = await fetchWithRetry(url);
  if (!json.daily) {
    throw new Error(`no daily payload for ${city.id}`);
  }
  const climate = condense(json.daily);
  return { ...city, climate };
}

// Sequential map with paced delay between requests; respects existing data.
async function smap(items, fn, intervalMs = 6000) {
  const results = new Array(items.length);
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const t0 = Date.now();
    try {
      results[idx] = await fn(item);
      const ms = Date.now() - t0;
      process.stdout.write(`  [${idx + 1}/${items.length}] ${item.id} (${ms}ms)\n`);
    } catch (e) {
      process.stdout.write(`  [${idx + 1}/${items.length}] ${item.id} FAILED: ${e.message}\n`);
      results[idx] = { ...item, climate: null, error: e.message };
    }
    await sleep(intervalMs);
  }
  return results;
}

async function readExisting() {
  try {
    const raw = await readFile(resolve(ROOT, "data", "climatology.json"), "utf8");
    const j = JSON.parse(raw);
    const map = new Map();
    for (const c of j.cities || []) {
      if (c.climate) map.set(c.id, c);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function main() {
  const citiesPath = resolve(ROOT, "data", "cities.json");
  const cities = JSON.parse(await readFile(citiesPath, "utf8"));

  const existing = await readExisting();
  const todo = cities.filter((c) => !existing.has(c.id));
  console.log(`Resuming: ${existing.size} cached, ${todo.length} to fetch (${START} → ${END})`);

  let pending = todo;
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await flush(cities, existing);
      } catch (e) { console.warn("autosave fail", e.message); }
    }, 5000);
  };

  const fetched = await smap(pending, async (city) => {
    const r = await processCity(city);
    if (r.climate) {
      existing.set(r.id, r);
      scheduleSave();
    }
    return r;
  });

  const failed = fetched.filter((c) => !c.climate);
  if (failed.length) {
    console.warn(`!! ${failed.length} cities failed: ${failed.map((c) => c.id).join(", ")}`);
  }

  await flush(cities, existing);
}

async function flush(cities, existing) {
  const ordered = cities.map((c) => existing.get(c.id)).filter(Boolean);
  const payload = {
    meta: {
      source: "Open-Meteo archive (ECMWF ERA5 reanalysis)",
      attribution: "https://open-meteo.com/ - ERA5 by ECMWF / Copernicus",
      period: `${START}/${END}`,
      variables: {
        tmax: { label: "Daily High Temperature", unit: "°F" },
        tmin: { label: "Daily Low Temperature", unit: "°F" },
        tmean: { label: "Daily Mean Temperature", unit: "°F" },
        precip: { label: "Daily Precipitation", unit: "in" },
        wind: { label: "Daily Max Wind Speed", unit: "mph" },
      },
      generatedAt: new Date().toISOString(),
    },
    cities: ordered,
  };

  const outPath = resolve(ROOT, "data", "climatology.json");
  await writeFile(outPath, JSON.stringify(payload));
  const pubData = resolve(ROOT, "public", "data");
  await mkdir(pubData, { recursive: true });
  await writeFile(resolve(pubData, "climatology.json"), JSON.stringify(payload));
  await writeFile(resolve(pubData, "cities.json"), JSON.stringify(cities));
  console.log(`Saved ${ordered.length} cities → ${(JSON.stringify(payload).length / 1024).toFixed(0)} KB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
