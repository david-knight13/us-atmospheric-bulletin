// Builds data/cities.json from the GeoNames cities5000 dataset.
//
// Selection rule:
//   - country == US
//   - admin1 ∈ { 50 states + DC }   (PR, GU, VI, MP, AS excluded — Albers-USA cannot project them)
//   - population >= 50_000
//
// GeoNames cities5000.txt is tab-separated with these columns (1-indexed):
//   1  geonameid
//   2  name
//   3  asciiname
//   4  alternatenames
//   5  latitude
//   6  longitude
//   7  feature class
//   8  feature code
//   9  country code
//  10  cc2
//  11  admin1 code     (US uses 2-letter postal code, e.g. "TX")
//  12  admin2 code
//  ...
//  15  population

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const VALID_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
  "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY",
]);

const POP_MIN = 50_000;

function slug(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const txt = await readFile(resolve(__dirname, "cities5000.txt"), "utf8");
const out = [];
const seen = new Set();      // dedupe by (state, slug, rounded lat/lon)
const idCount = new Map();   // disambiguate same-state same-name

for (const line of txt.split("\n")) {
  if (!line) continue;
  const c = line.split("\t");
  if (c.length < 15) continue;
  if (c[8] !== "US") continue;
  const state = c[10];
  if (!VALID_STATES.has(state)) continue;
  const pop = parseInt(c[14], 10);
  if (!Number.isFinite(pop) || pop < POP_MIN) continue;
  const lat = parseFloat(c[4]);
  const lon = parseFloat(c[5]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const name = c[1] || c[2];
  if (!name) continue;

  // dedupe key — guards against the rare case where GeoNames lists the same
  // place twice (e.g., a populated-place feature and an admin feature).
  const dedupeKey = `${state}|${slug(name)}|${lat.toFixed(2)}|${lon.toFixed(2)}`;
  if (seen.has(dedupeKey)) continue;
  seen.add(dedupeKey);

  // Build a stable id; if two different cities in the same state share a slug
  // (e.g., two places named "Franklin" in TN), suffix a counter.
  const baseId = `${state.toLowerCase()}-${slug(name)}`;
  const n = (idCount.get(baseId) || 0) + 1;
  idCount.set(baseId, n);
  const id = n === 1 ? baseId : `${baseId}-${n}`;

  out.push({
    id,
    name,
    state,
    lat: +lat.toFixed(4),
    lon: +lon.toFixed(4),
    population: pop,
  });
}

// Sort by population descending so the most-relevant stations are searched
// first; this makes the dropdown autocomplete feel snappier even though the
// renderer doesn't depend on order.
out.sort((a, b) => b.population - a.population);

// Drop the population field from the on-disk record — front-end doesn't use it
// and keeping it just inflates the file.
const slim = out.map(({ population, ...rest }) => rest);

const outPath = resolve(ROOT, "data", "cities.json");
await writeFile(outPath, JSON.stringify(slim, null, 0));

const byState = {};
for (const c of slim) byState[c.state] = (byState[c.state] || 0) + 1;
console.log(`Wrote ${slim.length} cities → ${outPath}`);
console.log(`States covered: ${Object.keys(byState).length}`);
console.log(`Per-state range: ${Math.min(...Object.values(byState))} – ${Math.max(...Object.values(byState))}`);
const top10 = Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log(`Top 10 by city count:`, top10.map(([s, n]) => `${s}=${n}`).join(", "));
