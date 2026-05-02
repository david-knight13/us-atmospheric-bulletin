// =========================================================================
// U.S. ATMOSPHERIC BULLETIN — front-end controller
// Loads climatology + topology, renders heatmap (canvas IDW + SVG borders)
// and station-lookup dashboard. No build step; ES modules + d3 from esm.sh.
// =========================================================================

import * as d3 from "https://esm.sh/d3@7";
import * as topojson from "https://esm.sh/topojson-client@3";

// ---------- data ----------
const [climaPayload, usTopo] = await Promise.all([
  fetch("./data/climatology.json", { cache: "no-store" }).then((r) => r.json()),
  fetch("./data/us-states-10m.json", { cache: "no-store" }).then((r) => r.json()),
]);

const META = climaPayload.meta;
const CITIES = climaPayload.cities;

// ---------- date helpers (skip Feb 29) ----------
const CUMULATIVE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June",
                    "July", "August", "September", "October", "November", "December"];

function doyFromMonthDay(m1, d1) {
  // m1 = 1..12, d1 = 1..31
  if (m1 === 2 && d1 === 29) return 59; // collapse Feb 29 to Feb 28
  return CUMULATIVE[m1 - 1] + (d1 - 1);
}
function monthDayFromDoy(doy) {
  let m = 0;
  while (m < 11 && CUMULATIVE[m + 1] <= doy) m++;
  return { m: m + 1, d: doy - CUMULATIVE[m] + 1 };
}
function todayDoy() {
  const t = new Date();
  return doyFromMonthDay(t.getMonth() + 1, t.getDate());
}
function formatMonthDay(doy) {
  const { m, d } = monthDayFromDoy(doy);
  return `${MONTH_SHORT[m - 1]} ${d}`;
}

// ---------- variable scales ----------
// Custom interpolators tuned for the paper-stock palette, not the usual
// viridis. The design intent is for the heatmap to read as a printed bulletin
// — saturated reds/blues, cream midtones, no neon.
const COLOR_RAMPS = {
  // Diverging cool→cream→hot for temperature variables.
  tmax: d3.interpolateRgbBasis([
    "#1d3557", "#3d6a8a", "#7ea7be", "#cfdbe2",
    "#f3eada", "#f0c47a", "#e6814b", "#c4291f", "#7a1a13",
  ]),
  tmin: d3.interpolateRgbBasis([
    "#0f2d57", "#3d6a8a", "#7ea7be", "#cfdbe2",
    "#f3eada", "#e7b878", "#c97a45", "#a02a1c",
  ]),
  tmean: d3.interpolateRgbBasis([
    "#1d3557", "#3d6a8a", "#7ea7be", "#cfdbe2",
    "#f3eada", "#f0c47a", "#e6814b", "#c4291f", "#7a1a13",
  ]),
  dewpoint: d3.interpolateRgbBasis([
    "#1d3557", "#3d6a8a", "#7ea7be", "#cfdbe2",
    "#f3eada", "#f0c47a", "#e6814b", "#c4291f", "#7a1a13",
  ]),
  // Sequential cream → deep blue for precipitation / humidity.
  precip: d3.interpolateRgbBasis([
    "#f3eada", "#dfd4b1", "#a9c1c9", "#5d8aa3", "#27466e", "#0e2748",
  ]),
  humidity: d3.interpolateRgbBasis([
    "#f3eada", "#dfd8b9", "#a6c3c7", "#5a89a3", "#27466e", "#0e2748",
  ]),
  // Sequential cream → plum for wind.
  wind: d3.interpolateRgbBasis([
    "#f3eada", "#dcc7a8", "#c1986b", "#894d57", "#3a1f3d",
  ]),
  // Sequential cream → ember for UV index (low → high).
  uv: d3.interpolateRgbBasis([
    "#f3eada", "#f0d18e", "#e89a4a", "#c4291f", "#7a1a13", "#3a0a07",
  ]),
  // Sequential cream → solar gold → ember for surface irradiance.
  solar: d3.interpolateRgbBasis([
    "#f3eada", "#dfd4b1", "#e6c478", "#c97a45", "#7a1a13",
  ]),
  // Diverging blue (low) ↔ red (high) for surface pressure.
  pressure: d3.interpolateRgbBasis([
    "#27466e", "#5d8aa3", "#a9c1c9",
    "#f3eada",
    "#dcc7a8", "#a86846", "#7a1a13",
  ]),
  // Sequential cream → overcast slate for cloud cover.
  cloud: d3.interpolateRgbBasis([
    "#f3eada", "#dccbb1", "#a9b1b8", "#5a6770", "#2a333b",
  ]),
};

// Static per-variable display knobs — short label for chips, decimals for
// formatting. Anything unknown gets a neutral fallback below.
const VAR_DISPLAY = {
  tmax:     { short: "T-MAX",  decimals: 0 },
  tmin:     { short: "T-MIN",  decimals: 0 },
  tmean:    { short: "T-MEAN", decimals: 0 },
  precip:   { short: "PRECIP", decimals: 2 },
  wind:     { short: "WIND",   decimals: 0 },
  humidity: { short: "RH",     decimals: 0 },
  dewpoint: { short: "DEW",    decimals: 0 },
  uv:       { short: "UV",     decimals: 1 },
  solar:    { short: "SOLAR",  decimals: 1 },
  pressure: { short: "PRESS",  decimals: 0 },
  cloud:    { short: "CLOUD",  decimals: 0 },
};

// Build VAR_CONFIG from whatever variables the loaded climatology actually
// exposes — that way new fields (humidity, UV, …) light up automatically once
// the fetch script regenerates the file, and old payloads don't crash.
const VAR_CONFIG = {};
for (const [k, vmeta] of Object.entries(META.variables)) {
  const disp = VAR_DISPLAY[k] || {};
  VAR_CONFIG[k] = {
    label: vmeta.label,
    short: disp.short ?? k.toUpperCase(),
    unit: vmeta.unit,
    decimals: disp.decimals ?? 1,
    ramp: COLOR_RAMPS[k] || COLOR_RAMPS.tmean,
  };
}

// Compute a stable global domain per variable across ALL cities and all days.
// This keeps the legend invariant as the user moves the slider.
const VAR_DOMAINS = {};
for (const v of Object.keys(VAR_CONFIG)) {
  let lo = Infinity, hi = -Infinity;
  for (const c of CITIES) {
    const arr = c.climate[v]?.mean;
    if (!arr) continue;
    for (const x of arr) {
      if (x == null) continue;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  VAR_DOMAINS[v] = [lo, hi];
}

function valueAt(city, variable, doy, sigmaOn, sigmaSign, sigmaN) {
  const arr = city.climate[variable];
  if (!arr) return null;
  const mu = arr.mean[doy];
  const sd = arr.std[doy];
  if (mu == null) return null;
  if (!sigmaOn || sd == null) return mu;
  return mu + sigmaSign * sigmaN * sd;
}

function colorFor(variable, value) {
  const [lo, hi] = VAR_DOMAINS[variable];
  if (value == null || isNaN(value)) return "transparent";
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  return VAR_CONFIG[variable].ramp(t);
}

// ---------- app state ----------
const state = {
  view: "map",

  // map view
  variable: "tmax",
  doy: todayDoy(),
  sigmaOn: false,
  sigmaSign: -1,
  sigmaN: 1,

  // lookup view
  selectedCityId: null,
  lookupMode: "day", // "day" | "month" | "year"
  lookupDoy: todayDoy(),
  lookupVariable: "tmax",
  lookupSigmaN: 1,

  // compare view
  compareAId: null,
  compareBId: null,
  compareMode: "month",
  compareDoy: todayDoy(),
  compareVariable: "tmax",
  compareSigmaN: 1,
};

// ============================================================
//   MASTHEAD / DATESTAMP
// ============================================================
function fmtDateStamp() {
  const t = new Date();
  return t.toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  }).toUpperCase();
}
document.getElementById("datestamp").textContent = fmtDateStamp();
document.getElementById("cityCount").textContent = `${CITIES.length} stations`;
document.getElementById("footStations").textContent = `${CITIES.length} stations`;
const mapStationCountEl = document.getElementById("mapStationCount");
if (mapStationCountEl) mapStationCountEl.textContent = CITIES.length.toLocaleString();
document.getElementById("periodCell").textContent = `PERIOD ${META.period.replace("/", " — ")}`;

// ============================================================
//   TAB SWITCHING
// ============================================================
const viewMap = document.getElementById("view-map");
const viewLookup = document.getElementById("view-lookup");
const viewCompare = document.getElementById("view-compare");
document.querySelectorAll(".tabbar .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabbar .tab").forEach((b) => {
      b.classList.toggle("is-active", b === btn);
      b.setAttribute("aria-selected", b === btn);
    });
    state.view = btn.dataset.view;
    viewMap.hidden = state.view !== "map";
    viewLookup.hidden = state.view !== "lookup";
    viewCompare.hidden = state.view !== "compare";
    if (state.view === "map") {
      // ensure map sizes correctly when revealed
      requestAnimationFrame(resizeMap);
    }
  });
});

// ============================================================
//   CONTROL DECK — variable picker
// ============================================================
const varList = document.getElementById("varList");
function renderVarList() {
  varList.innerHTML = "";
  for (const [k, cfg] of Object.entries(VAR_CONFIG)) {
    const row = document.createElement("div");
    row.className = "varitem" + (k === state.variable ? " is-active" : "");
    row.dataset.var = k;
    row.innerHTML = `
      <span class="varhole" aria-hidden="true"></span>
      <span class="varlabel">${cfg.label}</span>
      <span class="varunit">${cfg.unit}</span>
    `;
    row.addEventListener("click", () => {
      state.variable = k;
      renderVarList();
      renderLegend();
      renderHeatmap();
      updateMapTitle();
    });
    varList.appendChild(row);
  }
}
renderVarList();

// ============================================================
//   CONTROL DECK — date slider
// ============================================================
const slider = document.getElementById("daySlider");
const dateLabel = document.getElementById("dateLabel");
const doyLabel = document.getElementById("doyLabel");
slider.value = state.doy;

function updateDateLabel() {
  dateLabel.textContent = formatMonthDay(state.doy);
  doyLabel.textContent = `DOY ${String(state.doy + 1).padStart(3, "0")}`;
}
updateDateLabel();

slider.addEventListener("input", () => {
  state.doy = +slider.value;
  updateDateLabel();
  renderHeatmap();
  updateMapTitle();
});

// month-axis tick svg under slider
function renderSliderAxis() {
  const svg = document.getElementById("sliderAxis");
  svg.innerHTML = "";
  const W = svg.clientWidth || 280;
  const H = 22;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const ns = "http://www.w3.org/2000/svg";
  for (let m = 0; m < 12; m++) {
    const x = (CUMULATIVE[m] / 364) * W;
    const tick = document.createElementNS(ns, "line");
    tick.setAttribute("x1", x); tick.setAttribute("x2", x);
    tick.setAttribute("y1", 0); tick.setAttribute("y2", 5);
    tick.setAttribute("stroke", "rgba(31,23,20,0.55)");
    tick.setAttribute("stroke-width", "1");
    svg.appendChild(tick);
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", x + 1);
    label.setAttribute("y", 16);
    label.setAttribute("class", "slider-axis-label");
    label.textContent = MONTH_SHORT[m].toUpperCase();
    svg.appendChild(label);
  }
}

// ============================================================
//   CONTROL DECK — sigma block
// ============================================================
const sigmaToggle = document.getElementById("sigmaToggle");
sigmaToggle.addEventListener("change", () => {
  state.sigmaOn = sigmaToggle.checked;
  renderHeatmap();
  updateMapTitle();
});
document.querySelectorAll(".sigma-sign").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.sigmaSign = +btn.dataset.sign;
    document.querySelectorAll(".sigma-sign").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.sign === btn.dataset.sign));
    if (state.sigmaOn) { renderHeatmap(); updateMapTitle(); }
  });
});
const sigmaN = document.getElementById("sigmaN");
sigmaN.addEventListener("input", () => {
  const v = parseFloat(sigmaN.value);
  if (!Number.isFinite(v)) return;
  state.sigmaN = v;
  if (state.sigmaOn) { renderHeatmap(); updateMapTitle(); }
});

// ============================================================
//   LEGEND
// ============================================================
function renderLegend() {
  const cfg = VAR_CONFIG[state.variable];
  const [lo, hi] = VAR_DOMAINS[state.variable];
  const stops = [];
  for (let i = 0; i <= 10; i++) stops.push(cfg.ramp(i / 10));
  document.getElementById("legendStrip").style.background =
    `linear-gradient(90deg, ${stops.join(", ")})`;
  const ticks = document.getElementById("legendTicks");
  ticks.innerHTML = "";
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * (i / 4);
    const span = document.createElement("span");
    span.textContent = `${v.toFixed(cfg.decimals)}`;
    ticks.appendChild(span);
  }
}
renderLegend();

// ============================================================
//   MAP — projection, borders, IDW heatmap
// ============================================================
const mapWrap = document.getElementById("mapCanvasWrap");
const heatCanvas = document.getElementById("heatCanvas");
const mapSvg = d3.select("#mapSvg");
const hoverCard = document.getElementById("hoverCard");

const projection = d3.geoAlbersUsa();
const path = d3.geoPath(projection);

const usStatesGeo = topojson.feature(usTopo, usTopo.objects.states);
const usOutlineGeo = topojson.feature(usTopo, usTopo.objects.nation);

let heatGrid = null; // precomputed per-pixel weights
let mapW = 0, mapH = 0;
let cityProjected = []; // [{x,y,city}, ...] in canvas pixel coords

function fitProjection() {
  // Compute outer dimensions of map-canvas-wrap
  const rect = mapWrap.getBoundingClientRect();
  mapW = Math.max(400, Math.floor(rect.width));
  mapH = Math.max(280, Math.floor(rect.height));
  projection.fitSize([mapW, mapH], usOutlineGeo);
}

function projectCities() {
  cityProjected = [];
  for (const c of CITIES) {
    const xy = projection([c.lon, c.lat]);
    if (!xy) continue;
    cityProjected.push({ x: xy[0], y: xy[1], city: c });
  }
}

function buildMaskAndGrid() {
  // Render at half resolution for speed; canvas scales up via image-rendering.
  const W = Math.max(200, Math.floor(mapW / 2));
  const H = Math.max(140, Math.floor(mapH / 2));
  const sx = W / mapW, sy = H / mapH;

  // 1. Build mask via offscreen path render of US outline.
  const mc = document.createElement("canvas");
  mc.width = W; mc.height = H;
  const mctx = mc.getContext("2d");
  mctx.fillStyle = "#000";
  // draw nation polygon scaled to W,H
  const tmpProj = d3.geoAlbersUsa().fitSize([W, H], usOutlineGeo);
  const tmpPath = d3.geoPath(tmpProj, mctx);
  mctx.beginPath();
  tmpPath(usOutlineGeo);
  mctx.fill();
  const mask = mctx.getImageData(0, 0, W, H).data; // RGBA

  // 2. Precompute per-pixel top-K cities (k=8) and inverse-distance weights.
  // Pack the city projection into flat typed arrays (one indirection avoided
  // per inner-loop iteration vs. an array of objects). Cities that fail to
  // project (rare with Albers-USA) are skipped.
  const cxArr = new Float32Array(CITIES.length);
  const cyArr = new Float32Array(CITIES.length);
  const cvalid = new Uint8Array(CITIES.length);
  let projCount = 0;
  for (let c = 0; c < CITIES.length; c++) {
    const xy = tmpProj([CITIES[c].lon, CITIES[c].lat]);
    if (xy) {
      cxArr[c] = xy[0];
      cyArr[c] = xy[1];
      cvalid[c] = 1;
      projCount++;
    }
  }

  const K = 8;
  const indices = new Int16Array(W * H * K);
  const weights = new Float32Array(W * H * K);

  // Per-pixel top-K via insertion into a sorted buffer of size K. Cost:
  // O(N + K²) per pixel instead of O(N·K) with the previous selection sort —
  // roughly 7× faster at N ≈ 975, which keeps the precompute under ~1 s.
  const kIdx = new Int16Array(K);
  const kDist = new Float64Array(K);

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      if (mask[i * 4 + 3] < 200) {
        indices[i * K] = -1;
        continue;
      }

      // Seed top-K with the first K projecting cities, then insertion-sort.
      let seeded = 0;
      let c0 = 0;
      while (seeded < K && c0 < CITIES.length) {
        if (cvalid[c0]) {
          const dx = cxArr[c0] - px, dy = cyArr[c0] - py;
          const d2 = dx * dx + dy * dy;
          let j = seeded - 1;
          while (j >= 0 && kDist[j] > d2) {
            kDist[j + 1] = kDist[j]; kIdx[j + 1] = kIdx[j];
            j--;
          }
          kDist[j + 1] = d2; kIdx[j + 1] = c0;
          seeded++;
        }
        c0++;
      }
      let worst = kDist[K - 1];

      // Stream the remaining cities; only those beating `worst` are inserted.
      for (let c = c0; c < CITIES.length; c++) {
        if (!cvalid[c]) continue;
        const dx = cxArr[c] - px, dy = cyArr[c] - py;
        const d2 = dx * dx + dy * dy;
        if (d2 >= worst) continue;
        let j = K - 1;
        while (j > 0 && kDist[j - 1] > d2) {
          kDist[j] = kDist[j - 1]; kIdx[j] = kIdx[j - 1];
          j--;
        }
        kDist[j] = d2; kIdx[j] = c;
        worst = kDist[K - 1];
      }

      // Inverse-distance weights, cap d² ≥ 1 to avoid blow-up at a hit.
      let wSum = 0;
      for (let s = 0; s < K; s++) {
        const w = 1 / Math.max(1, kDist[s]);
        indices[i * K + s] = kIdx[s];
        weights[i * K + s] = w;
        wSum += w;
      }
      for (let s = 0; s < K; s++) weights[i * K + s] /= wSum;
    }
  }

  heatGrid = { W, H, K, mask, indices, weights };
}

function renderHeatmap() {
  if (!heatGrid) return;
  const { W, H, K, indices, weights } = heatGrid;
  // collect current values for all cities
  const vals = new Float32Array(CITIES.length);
  for (let i = 0; i < CITIES.length; i++) {
    const v = valueAt(CITIES[i], state.variable, state.doy,
                      state.sigmaOn, state.sigmaSign, state.sigmaN);
    vals[i] = v == null ? NaN : v;
  }
  // Render to a low-res canvas, then drawImage onto display canvas (smoothed)
  const lowCanvas = document.createElement("canvas");
  lowCanvas.width = W; lowCanvas.height = H;
  const lctx = lowCanvas.getContext("2d");
  const img = lctx.createImageData(W, H);
  const data = img.data;

  const cfg = VAR_CONFIG[state.variable];
  const [lo, hi] = VAR_DOMAINS[state.variable];
  const span = hi - lo || 1;

  for (let i = 0; i < W * H; i++) {
    if (indices[i * K] < 0) {
      data[i * 4 + 3] = 0;
      continue;
    }
    let acc = 0, wSum = 0;
    for (let s = 0; s < K; s++) {
      const idx = indices[i * K + s];
      const v = vals[idx];
      if (Number.isNaN(v)) continue;
      const w = weights[i * K + s];
      acc += v * w;
      wSum += w;
    }
    if (wSum === 0) { data[i * 4 + 3] = 0; continue; }
    const value = acc / wSum;
    const t = Math.max(0, Math.min(1, (value - lo) / span));
    const rgb = cfg.ramp(t);
    // rgb is "rgb(r, g, b)" string — parse
    const m = rgb.match(/\d+/g);
    if (!m) continue;
    data[i * 4]     = +m[0];
    data[i * 4 + 1] = +m[1];
    data[i * 4 + 2] = +m[2];
    data[i * 4 + 3] = 215; // partly translucent so paper grain shows through
  }
  lctx.putImageData(img, 0, 0);

  // Display canvas
  heatCanvas.width = mapW;
  heatCanvas.height = mapH;
  const ctx = heatCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, mapW, mapH);
  ctx.drawImage(lowCanvas, 0, 0, mapW, mapH);
}

function renderBorders() {
  mapSvg.attr("viewBox", `0 0 ${mapW} ${mapH}`);
  mapSvg.selectAll("*").remove();

  // state borders (faint)
  mapSvg.append("g")
    .attr("class", "states-layer")
    .selectAll("path")
    .data(usStatesGeo.features)
    .enter()
    .append("path")
    .attr("class", "state")
    .attr("d", path);

  // outer nation border (slightly stronger)
  mapSvg.append("path")
    .attr("class", "state-overlay")
    .attr("d", path(usOutlineGeo));

  // city dots
  const dots = mapSvg.append("g").attr("class", "cities-layer");
  dots.selectAll("circle")
    .data(cityProjected)
    .enter()
    .append("circle")
    .attr("class", "city-dot city-marker")
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y)
    .attr("r", 1.6)
    .on("mousemove", (ev, d) => showHover(ev, d))
    .on("mouseleave", () => hideHover())
    .on("click", (ev, d) => {
      // jump to lookup view with this station selected
      state.selectedCityId = d.city.id;
      state.lookupVariable = state.variable;
      state.lookupDoy = state.doy;
      document.querySelector('.tab[data-view="lookup"]').click();
      const idx = CITIES.findIndex((c) => c.id === d.city.id);
      if (idx >= 0) selectStation(CITIES[idx]);
    });
}

// hover card
function showHover(ev, d) {
  const cfg = VAR_CONFIG[state.variable];
  const mu = d.city.climate[state.variable].mean[state.doy];
  const sd = d.city.climate[state.variable].std[state.doy];
  const v = valueAt(d.city, state.variable, state.doy,
                    state.sigmaOn, state.sigmaSign, state.sigmaN);
  const muStr = mu == null ? "—" : mu.toFixed(cfg.decimals);
  const sdStr = sd == null ? "—" : sd.toFixed(cfg.decimals === 0 ? 1 : 2);
  const vStr = v == null ? "—" : v.toFixed(cfg.decimals);
  hoverCard.hidden = false;
  hoverCard.innerHTML = `
    <div class="hc-name">${d.city.name}</div>
    <div class="hc-state">${d.city.state} · ${d.city.lat.toFixed(2)}°, ${d.city.lon.toFixed(2)}°</div>
    <div class="hc-rule"></div>
    <div class="hc-val">${vStr}<span style="font-size:13px;color:var(--ink-faint)">&nbsp;${cfg.unit}</span></div>
    <div class="hc-stats">μ ${muStr} · σ ${sdStr} · ${formatMonthDay(state.doy)}</div>
  `;
  // position relative to map-canvas-wrap
  const rect = mapWrap.getBoundingClientRect();
  const x = ev.clientX - rect.left + 12;
  const y = ev.clientY - rect.top + 12;
  hoverCard.style.left = `${Math.min(x, rect.width - 200)}px`;
  hoverCard.style.top = `${Math.min(y, rect.height - 110)}px`;
}
function hideHover() { hoverCard.hidden = true; }

function updateMapTitle() {
  const cfg = VAR_CONFIG[state.variable];
  const sigmaTag = state.sigmaOn
    ? ` · μ ${state.sigmaSign > 0 ? "+" : "−"} ${state.sigmaN}σ`
    : ` · μ`;
  document.getElementById("mapTitle").textContent =
    `${cfg.label.toUpperCase()} ${formatMonthDay(state.doy).toUpperCase()}${sigmaTag}`;
  document.getElementById("mapMeta").innerHTML =
    `DOMAIN ${VAR_DOMAINS[state.variable][0].toFixed(cfg.decimals)} – ${VAR_DOMAINS[state.variable][1].toFixed(cfg.decimals)} ${cfg.unit}`;
}

function resizeMap() {
  fitProjection();
  projectCities();
  renderBorders();
  buildMaskAndGrid();
  renderHeatmap();
  renderSliderAxis();
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeMap, 180);
});

// initial size
resizeMap();
updateMapTitle();

// ============================================================
//   STATION LOOKUP VIEW
// ============================================================
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const searchSuffix = document.getElementById("searchSuffix");
const lookupDateInput = document.getElementById("lookupDate");
const lookupVarSelect = document.getElementById("lookupVar");
const lookupDashboard = document.getElementById("lookupDashboard");
const lookupSigmaN = document.getElementById("lookupSigmaN");

// populate variable select
for (const [k, cfg] of Object.entries(VAR_CONFIG)) {
  const opt = document.createElement("option");
  opt.value = k;
  opt.textContent = `${cfg.label} (${cfg.unit})`;
  lookupVarSelect.appendChild(opt);
}
lookupVarSelect.value = state.lookupVariable;

// init date input — today, formatted YYYY-MM-DD
function setLookupDateInput(doy) {
  const { m, d } = monthDayFromDoy(doy);
  const year = 2025; // arbitrary non-leap year for the picker UI
  lookupDateInput.value = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
setLookupDateInput(state.lookupDoy);

lookupDateInput.addEventListener("change", () => {
  const v = lookupDateInput.value;
  if (!v) return;
  const [, mm, dd] = v.split("-").map(Number);
  state.lookupDoy = doyFromMonthDay(mm, dd);
  renderDashboard();
});

lookupVarSelect.addEventListener("change", () => {
  state.lookupVariable = lookupVarSelect.value;
  renderDashboard();
});

// Wire up the lookup-view mode toggle (DAY / MONTH / YEAR). Compare-view
// toggle is wired separately below so the two stay independent.
const lookupModeToggle = document.querySelector('.mode-toggle[data-target="lookup"]');
lookupModeToggle.querySelectorAll(".mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    lookupModeToggle.querySelectorAll(".mode")
      .forEach((b) => b.classList.toggle("is-active", b === btn));
    state.lookupMode = btn.dataset.mode;
    renderDashboard();
  });
});

lookupSigmaN.addEventListener("input", () => {
  const v = parseFloat(lookupSigmaN.value);
  if (!Number.isFinite(v)) return;
  state.lookupSigmaN = v;
  renderDashboard();
});

// ----- generic station search helper -----
// Wires an <input>, a results <ul>, and an optional suffix element together
// so callers can plug it into multiple panels (lookup, compare A, compare B).
function fuzzyMatch(q, c) {
  return `${c.name} ${c.state}`.toLowerCase().includes(q);
}
function bindSearch({ input, results, suffix, onPick }) {
  function run() {
    const q = input.value.toLowerCase().trim();
    if (!q) {
      results.hidden = true;
      results.innerHTML = "";
      if (suffix) suffix.textContent = "";
      return;
    }
    const matches = CITIES.filter((c) => fuzzyMatch(q, c)).slice(0, 12);
    results.innerHTML = matches.map((c) =>
      `<li data-id="${c.id}"><span>${c.name}</span><span class="li-state">${c.state}</span></li>`
    ).join("");
    results.hidden = matches.length === 0;
    if (suffix) suffix.textContent = matches.length
      ? `${matches.length} match${matches.length === 1 ? "" : "es"}`
      : "no matches";
    results.querySelectorAll("li").forEach((li) => {
      li.addEventListener("mousedown", (e) => e.preventDefault());
      li.addEventListener("click", () => {
        const c = CITIES.find((x) => x.id === li.dataset.id);
        if (!c) return;
        input.value = `${c.name}, ${c.state}`;
        results.hidden = true;
        onPick(c);
      });
    });
  }
  input.addEventListener("input", run);
  input.addEventListener("focus", run);
  document.addEventListener("click", (e) => {
    if (!results.contains(e.target) && e.target !== input) results.hidden = true;
  });
}

bindSearch({
  input: searchInput,
  results: searchResults,
  suffix: searchSuffix,
  onPick: (c) => selectStation(c),
});

function selectStation(c) {
  state.selectedCityId = c.id;
  searchInput.value = `${c.name}, ${c.state}`;
  renderDashboard();
}

// ----- dashboard -----
function getSelectedCity() {
  return CITIES.find((c) => c.id === state.selectedCityId);
}

function renderDashboard() {
  const c = getSelectedCity();
  if (!c) {
    lookupDashboard.innerHTML = `
      <div class="dash-empty">
        <span class="dash-empty-glyph">⌖</span>
        <p>Pick a station to begin.</p>
        <p class="dash-empty-hint">Type a city or state in the search box — for example, <em>Denver, CO</em> or <em>Miami</em>. The dashboard will populate with daily normals, statistical context, and (in <em>Month</em> or <em>Year</em> mode) a time-series chart with a confidence band.</p>
      </div>`;
    return;
  }
  lookupDashboard.innerHTML = "";
  lookupDashboard.appendChild(buildSnapshotCard(c));
  lookupDashboard.appendChild(buildStatsCard(c));
  if (state.lookupMode === "month" || state.lookupMode === "year") {
    lookupDashboard.appendChild(buildTimeseriesCard(c, state.lookupMode));
  }
}

function buildSnapshotCard(c) {
  const card = document.createElement("div");
  card.className = "dash-card snapshot";

  const variable = state.lookupVariable;
  const cfg = VAR_CONFIG[variable];
  const dec = cfg.decimals;
  const mu = c.climate[variable].mean[state.lookupDoy];
  const sd = c.climate[variable].std[state.lookupDoy];
  const muStr = mu == null ? "—" : mu.toFixed(dec);
  const sdStr = sd == null ? "—" : sd.toFixed(dec === 0 ? 1 : 2);
  const lo = mu == null ? null : mu - state.lookupSigmaN * sd;
  const hi = mu == null ? null : mu + state.lookupSigmaN * sd;

  // grid of quick reads of the 4 other variables
  const others = Object.keys(VAR_CONFIG).filter((k) => k !== variable);
  const otherCells = others.map((k) => {
    const oc = VAR_CONFIG[k];
    const m2 = c.climate[k].mean[state.lookupDoy];
    const s2 = c.climate[k].std[state.lookupDoy];
    return `
      <div class="snapshot-cell">
        <span class="sc-label">${oc.short}</span>
        <span class="sc-val">${m2 == null ? "—" : m2.toFixed(oc.decimals)}<span class="sc-unit">${oc.unit}</span></span>
        <span class="sc-band">μ ± 1σ&nbsp;= <code>${m2 == null ? "—" : (m2 - s2).toFixed(oc.decimals)} … ${m2 == null ? "—" : (m2 + s2).toFixed(oc.decimals)}</code></span>
      </div>`;
  }).join("");

  card.innerHTML = `
    <header class="dc-head">
      <div>
        <span class="dc-kicker">SNAPSHOT</span>
        <span class="dc-title">${formatMonthDay(state.lookupDoy)} — Climatological Day</span>
      </div>
      <div class="dc-meta">DOY ${String(state.lookupDoy + 1).padStart(3, "0")} · n=43 yr</div>
    </header>
    <div class="snapshot-station">
      <div>
        <div class="ss-name">${c.name}</div>
        <div class="ss-coord">${c.lat.toFixed(3)}° N · ${(-c.lon).toFixed(3)}° W</div>
      </div>
      <div class="ss-state">${c.state}</div>
    </div>
    <div class="snapshot-grid">
      <div class="snapshot-cell featured">
        <span class="sc-label">${cfg.short} · μ</span>
        <span class="sc-val">${muStr}<span class="sc-unit">${cfg.unit}</span></span>
        <span class="sc-band">σ = <b>${sdStr}</b> ${cfg.unit}
         &nbsp;·&nbsp; μ ± ${state.lookupSigmaN}σ&nbsp;= <code>${lo == null ? "—" : lo.toFixed(dec)} … ${hi == null ? "—" : hi.toFixed(dec)}</code></span>
      </div>
      ${otherCells}
    </div>`;

  return card;
}

function buildStatsCard(c) {
  const card = document.createElement("div");
  card.className = "dash-card stats";
  const variable = state.lookupVariable;
  const cfg = VAR_CONFIG[variable];
  const dec = cfg.decimals;

  // Annual extrema for this city, this variable
  const arr = c.climate[variable].mean;
  let yMax = -Infinity, yMin = Infinity, yMaxIdx = 0, yMinIdx = 0, yMean = 0, yCount = 0;
  for (let i = 0; i < 365; i++) {
    const v = arr[i];
    if (v == null) continue;
    yCount++;
    yMean += v;
    if (v > yMax) { yMax = v; yMaxIdx = i; }
    if (v < yMin) { yMin = v; yMinIdx = i; }
  }
  yMean = yMean / Math.max(1, yCount);

  // sigma at this day, average sigma annually
  const sdNow = c.climate[variable].std[state.lookupDoy];
  let sdSum = 0, sdN = 0;
  for (const s of c.climate[variable].std) {
    if (s == null) continue;
    sdSum += s; sdN++;
  }
  const sdMean = sdN > 0 ? sdSum / sdN : null;

  // Z-score: today's mean vs annual mean
  const todayMean = c.climate[variable].mean[state.lookupDoy];
  const anomaly = todayMean == null ? null : todayMean - yMean;

  card.innerHTML = `
    <header class="dc-head">
      <div>
        <span class="dc-kicker">CLIMATOLOGY</span>
        <span class="dc-title">${cfg.label}</span>
      </div>
      <div class="dc-meta">${cfg.unit}</div>
    </header>
    <div class="stats-readout">
      <div class="stats-readout-row">
        <span class="sr-label">Annual mean (μ̄)</span>
        <span class="sr-val">${yMean.toFixed(dec)}</span>
      </div>
      <div class="stats-readout-row">
        <span class="sr-label">Annual peak</span>
        <span class="sr-val">${yMax.toFixed(dec)}<small>${formatMonthDay(yMaxIdx)}</small></span>
      </div>
      <div class="stats-readout-row">
        <span class="sr-label">Annual trough</span>
        <span class="sr-val">${yMin.toFixed(dec)}<small>${formatMonthDay(yMinIdx)}</small></span>
      </div>
      <div class="stats-readout-row">
        <span class="sr-label">Annual amplitude</span>
        <span class="sr-val">${(yMax - yMin).toFixed(dec)}</span>
      </div>
      <div class="stats-readout-row">
        <span class="sr-label">σ (this day)</span>
        <span class="sr-val">${sdNow == null ? "—" : sdNow.toFixed(dec === 0 ? 1 : 2)}</span>
      </div>
      <div class="stats-readout-row">
        <span class="sr-label">σ̄ (annual mean)</span>
        <span class="sr-val">${sdMean == null ? "—" : sdMean.toFixed(dec === 0 ? 1 : 2)}</span>
      </div>
      <div class="stats-readout-row">
        <span class="sr-label">Anomaly vs annual μ̄</span>
        <span class="sr-val">${anomaly == null ? "—" : (anomaly >= 0 ? "+" : "") + anomaly.toFixed(dec)}</span>
      </div>
    </div>
    <div class="stats-band">
      Population standard deviation taken over the 43-year sample (n=43) for each calendar day, after merging Feb 29 into Feb 28. The annual mean is the arithmetic mean of all 365 daily normals.
    </div>`;
  return card;
}

// =====================================================================
// Generic time-series chart
// =====================================================================
const SVG_NS = "http://www.w3.org/2000/svg";

const SERIES_PALETTE = {
  A: { color: "#1f1714", bandColor: "rgba(196,41,31,0.20)", bandColor2: "rgba(196,41,31,0.09)" },
  B: { color: "#1d3557", bandColor: "rgba(29,53,87,0.20)",  bandColor2: "rgba(29,53,87,0.09)" },
};

function climSamples(city, variable, doyStart, count) {
  const arr = city.climate[variable];
  const out = [];
  for (let i = 0; i < count; i++) {
    const doy = (doyStart + i) % 365;
    out.push({ x: i + 1, doy, mu: arr.mean[doy], sd: arr.std[doy] });
  }
  return out;
}

function dayTicks(days) {
  const out = [];
  if (days <= 14) {
    for (let d = 1; d <= days; d++) out.push({ x: d, label: String(d) });
  } else {
    for (let d = 1; d <= days; d++) {
      if (d === 1 || d === days || d % 5 === 0) out.push({ x: d, label: String(d) });
    }
  }
  return out;
}

function monthTicks() {
  // x = 1..365, ticks at the 1st of each month
  return CUMULATIVE.map((c, i) => ({ x: c + 1, label: MONTH_SHORT[i] }));
}

function rangeForMode(mode, anchorDoy) {
  if (mode === "year") {
    return { start: 0, count: 365, ticks: monthTicks(), title: "Annual" };
  }
  // month
  const { m: month } = monthDayFromDoy(anchorDoy);
  return {
    start: CUMULATIVE[month - 1],
    count: DAYS_IN_MONTH[month - 1],
    ticks: dayTicks(DAYS_IN_MONTH[month - 1]),
    title: MONTH_LONG[month - 1],
    monthIdx: month - 1,
  };
}

function bandPath(samples, sx, sy, sigN, mult) {
  if (!samples.length) return "";
  let d = `M ${sx(samples[0].x)} ${sy(samples[0].mu + mult * sigN * samples[0].sd)}`;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    d += ` L ${sx(s.x)} ${sy(s.mu + mult * sigN * s.sd)}`;
  }
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    d += ` L ${sx(s.x)} ${sy(s.mu - mult * sigN * s.sd)}`;
  }
  return d + " Z";
}

function meanPath(samples, sx, sy) {
  if (!samples.length) return "";
  let d = `M ${sx(samples[0].x)} ${sy(samples[0].mu)}`;
  for (let i = 1; i < samples.length; i++) {
    d += ` L ${sx(samples[i].x)} ${sy(samples[i].mu)}`;
  }
  return d;
}

function el(name, attrs = {}, children = []) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(c);
  return e;
}

// series: [{ name, samples, color, bandColor, bandColor2 }]
// target: { x, mu, color } | null  — vertical marker at the selected day
//
// Returns an HTMLElement (a positioned wrapper containing the SVG plus a
// floating hover tooltip). The wrapper handles its own crosshair / focus-dot
// behavior; callers just append it.
function renderTimeseriesSvg({ series, sigN, dec, unit, xRange, xTicks, target, height = 320 }) {
  const W = 880, H = height, M = { l: 60, r: 24, t: 24, b: 36 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  // y range across all series, including the outer 2σ extents
  const allVals = [];
  for (const ser of series) {
    for (const p of ser.samples) {
      if (p.mu == null) continue;
      allVals.push(p.mu - 2 * sigN * p.sd, p.mu + 2 * sigN * p.sd);
    }
  }
  const yLo = allVals.length ? Math.min(...allVals) : 0;
  const yHi = allVals.length ? Math.max(...allVals) : 1;
  const yPad = (yHi - yLo) * 0.06 || 1;
  const yMin = yLo - yPad, yMax = yHi + yPad;

  const sx = (x) => M.l + ((x - xRange.min) / Math.max(1e-6, xRange.max - xRange.min)) * innerW;
  const sy = (v) => M.t + (1 - (v - yMin) / Math.max(1e-6, yMax - yMin)) * innerH;

  const svg = el("svg", {
    "class": "timeseries-svg",
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "xMidYMid meet",
  });

  // Y gridlines + labels
  const grid = el("g", { "class": "ts-grid" });
  for (let i = 0; i <= 4; i++) {
    const yv = yMin + (yMax - yMin) * (i / 4);
    const y = sy(yv);
    grid.appendChild(el("line", {
      x1: M.l, x2: W - M.r, y1: y, y2: y,
      stroke: "rgba(31,23,20,0.18)",
    }));
    const t = el("text", {
      x: M.l - 6, y: y + 3, "text-anchor": "end",
      "font-size": "10", fill: "rgba(31,23,20,0.55)",
    });
    t.textContent = yv.toFixed(dec);
    grid.appendChild(t);
  }
  svg.appendChild(grid);

  // Bands (sigma) — render from last to first so series A sits on top.
  if (sigN > 0) {
    for (let i = series.length - 1; i >= 0; i--) {
      const s = series[i];
      svg.appendChild(el("path", {
        d: bandPath(s.samples, sx, sy, sigN, 2),
        fill: s.bandColor2, stroke: "none",
      }));
      svg.appendChild(el("path", {
        d: bandPath(s.samples, sx, sy, sigN, 1),
        fill: s.bandColor, stroke: "none",
      }));
    }
  }
  // Mean lines (last to first so A sits on top)
  for (let i = series.length - 1; i >= 0; i--) {
    const s = series[i];
    svg.appendChild(el("path", {
      d: meanPath(s.samples, sx, sy),
      fill: "none", stroke: s.color, "stroke-width": "1.7",
    }));
  }

  // Target marker (vertical guide + dot + label)
  if (target && target.mu != null && target.x >= xRange.min && target.x <= xRange.max) {
    const tx = sx(target.x), ty = sy(target.mu);
    svg.appendChild(el("line", {
      x1: tx, x2: tx, y1: M.t, y2: M.t + innerH,
      stroke: "rgba(196,41,31,0.55)", "stroke-dasharray": "2 3",
    }));
    svg.appendChild(el("circle", {
      cx: tx, cy: ty, r: 4.5,
      fill: target.color || "#c4291f",
      stroke: "#1f1714", "stroke-width": "0.7",
    }));
    const lbl = el("text", {
      x: tx + 8, y: ty - 8,
      "class": "ts-target-text",
      "font-size": "11", fill: "#1f1714",
    });
    lbl.textContent = `${target.mu.toFixed(dec)} ${unit}`;
    svg.appendChild(lbl);
  }

  // X-axis line + ticks
  const axisG = el("g", { "class": "ts-axis" });
  const xAxisY = M.t + innerH;
  axisG.appendChild(el("line", {
    x1: M.l, x2: W - M.r, y1: xAxisY, y2: xAxisY,
    stroke: "rgba(31,23,20,0.6)",
  }));
  for (const t of xTicks) {
    axisG.appendChild(el("line", {
      x1: sx(t.x), x2: sx(t.x), y1: xAxisY, y2: xAxisY + 4,
      stroke: "rgba(31,23,20,0.55)",
    }));
    const txt = el("text", {
      x: sx(t.x), y: xAxisY + 16, "text-anchor": "middle",
      "font-size": "10", fill: "rgba(31,23,20,0.55)",
    });
    txt.textContent = t.label;
    axisG.appendChild(txt);
  }
  svg.appendChild(axisG);

  // ----- Interactive hover overlay -------------------------------------
  // A guide line + a focus dot per series + a floating HTML tooltip. The
  // overlay <rect> sits on top of every plot element so it gets first crack
  // at mouse events; pointer-events: all keeps the hit test alive even
  // though the rect is fully transparent.
  const guide = el("line", {
    "class": "ts-guide",
    x1: M.l, x2: M.l, y1: M.t, y2: M.t + innerH,
    visibility: "hidden",
  });
  const focusDots = series.map((s) => el("circle", {
    "class": "ts-focus-dot",
    r: 4.2, cx: 0, cy: 0,
    fill: s.color,
    visibility: "hidden",
  }));
  svg.appendChild(guide);
  for (const d of focusDots) svg.appendChild(d);

  const overlay = el("rect", {
    "class": "ts-overlay",
    x: M.l, y: M.t, width: innerW, height: innerH,
  });
  svg.appendChild(overlay);

  // Wrap so the absolutely-positioned tooltip has a stacking context.
  const wrap = document.createElement("div");
  wrap.className = "ts-wrap";
  wrap.appendChild(svg);

  const tip = document.createElement("div");
  tip.className = "ts-tip";
  tip.hidden = true;
  wrap.appendChild(tip);

  // Map a screen-space mouse position onto the SVG's viewBox coords.
  // We deliberately render with preserveAspectRatio="xMidYMid meet", so the
  // SVG can be letterboxed inside the wrapper. Account for the letterbox
  // offsets so a click on the visible plot actually lands on the plot in
  // viewBox coordinates.
  function pointerToViewBox(ev) {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const meet = Math.min(rect.width / W, rect.height / H);
    if (meet <= 0) return null;
    const renderedW = W * meet;
    const renderedH = H * meet;
    const offX = (rect.width - renderedW) / 2;
    const offY = (rect.height - renderedH) / 2;
    return {
      x: (ev.clientX - rect.left - offX) / meet,
      y: (ev.clientY - rect.top - offY) / meet,
      rect,
    };
  }

  function nearestSampleIndex(samples, dataX) {
    if (!samples.length) return 0;
    // samples are at x = i+1 for i = 0..N-1, so dataX-1 ≈ index.
    const idx = Math.round(dataX - 1);
    return Math.max(0, Math.min(samples.length - 1, idx));
  }

  // Build the tooltip body (date header + one row per series). Returns the
  // x-coordinate of the snapped sample in viewBox units, or null if there is
  // nothing valid to show at this x.
  function updateAt(ev) {
    const p = pointerToViewBox(ev);
    if (!p) return null;
    if (p.x < M.l - 0.5 || p.x > M.l + innerW + 0.5) return null;

    const dataX = xRange.min + ((p.x - M.l) / innerW) * (xRange.max - xRange.min);
    const idx = nearestSampleIndex(series[0].samples, dataX);
    const ref = series[0].samples[idx];
    if (!ref) return null;
    const gx = sx(ref.x);
    guide.setAttribute("x1", gx);
    guide.setAttribute("x2", gx);
    guide.setAttribute("visibility", "visible");

    // Build tooltip rows
    const dateLabel = ref.doy != null
      ? formatMonthDay(ref.doy)
      : (xTicks.find((t) => t.x === ref.x)?.label || `x=${ref.x}`);

    let tipHtml = `<div class="ts-tip-date">${dateLabel}</div>`;
    for (let i = 0; i < series.length; i++) {
      const s = series[i].samples[idx];
      const dot = focusDots[i];
      if (!s || s.mu == null) {
        dot.setAttribute("visibility", "hidden");
        continue;
      }
      dot.setAttribute("cx", sx(s.x));
      dot.setAttribute("cy", sy(s.mu));
      dot.setAttribute("visibility", "visible");

      const muStr = s.mu.toFixed(dec);
      const sdStr = s.sd == null ? null : s.sd.toFixed(dec === 0 ? 1 : 2);
      const lo = (s.sd != null && sigN > 0) ? (s.mu - sigN * s.sd).toFixed(dec) : null;
      const hi = (s.sd != null && sigN > 0) ? (s.mu + sigN * s.sd).toFixed(dec) : null;

      tipHtml += `
        <div class="ts-tip-row">
          <span class="ts-tip-sw" style="background:${series[i].color}"></span>
          <span class="ts-tip-name">${series[i].name || ""}</span>
          <span class="ts-tip-val">${muStr} <span style="opacity:.62">${unit}</span></span>
        </div>
        ${sdStr ? `<div class="ts-tip-band">σ ${sdStr}${lo != null ? ` · μ±${sigN}σ ${lo}…${hi}` : ""}</div>` : ""}
      `;
    }
    tip.innerHTML = tipHtml;
    tip.hidden = false;

    // Position tooltip relative to the wrapper. Clamp to the visible width
    // so it doesn't escape the right edge.
    const wrapRect = wrap.getBoundingClientRect();
    const cx = ev.clientX - wrapRect.left;
    const cy = ev.clientY - wrapRect.top;
    const tipW = tip.offsetWidth || 180;
    const tipH = tip.offsetHeight || 70;
    let left = cx + 14;
    if (left + tipW > wrapRect.width - 4) left = cx - tipW - 14;
    if (left < 4) left = 4;
    let top = cy - tipH - 12;
    if (top < 4) top = cy + 16;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;

    return gx;
  }

  function hideHover() {
    guide.setAttribute("visibility", "hidden");
    for (const d of focusDots) d.setAttribute("visibility", "hidden");
    tip.hidden = true;
  }

  overlay.addEventListener("mousemove", (ev) => { updateAt(ev); });
  overlay.addEventListener("mouseleave", hideHover);

  return wrap;
}

// =====================================================================
// Single-station time-series card (lookup view, month or year mode)
// =====================================================================
function buildTimeseriesCard(c, mode) {
  const card = document.createElement("div");
  card.className = "dash-card timeseries";
  const variable = state.lookupVariable;
  const cfg = VAR_CONFIG[variable];
  const dec = cfg.decimals;
  const sigN = state.lookupSigmaN;

  const range = rangeForMode(mode, state.lookupDoy);
  const samples = climSamples(c, variable, range.start, range.count);
  const series = [{
    name: c.name, samples, ...SERIES_PALETTE.A,
  }];

  // target marker
  let target = null;
  if (mode === "year") {
    const s = samples[state.lookupDoy];
    target = s ? { x: s.x, mu: s.mu, color: SERIES_PALETTE.A.color } : null;
  } else {
    const md = monthDayFromDoy(state.lookupDoy);
    if (md.m - 1 === range.monthIdx) {
      const s = samples[md.d - 1];
      target = s ? { x: s.x, mu: s.mu, color: SERIES_PALETTE.A.color } : null;
    }
  }

  const svg = renderTimeseriesSvg({
    series, sigN, dec, unit: cfg.unit,
    xRange: { min: 1, max: range.count },
    xTicks: range.ticks,
    target,
  });

  const titleSuffix = mode === "year"
    ? "Annual normals"
    : `${range.title} normals`;
  card.innerHTML = `
    <header class="dc-head">
      <div>
        <span class="dc-kicker">${mode === "year" ? "ANNUAL CYCLE" : "MONTHLY CYCLE"}</span>
        <span class="dc-title">${titleSuffix} (μ ± ${sigN}σ band)</span>
      </div>
      <div class="dc-meta">${cfg.label} · ${cfg.unit}</div>
    </header>`;
  card.appendChild(svg);

  const cap = document.createElement("div");
  cap.className = "stats-band";
  if (mode === "year") {
    cap.innerHTML = `Daily climatological mean across the calendar year for <b style="color:var(--ink);font-style:normal">${c.name}, ${c.state}</b>. Inner band is μ ± ${sigN}σ; outer band is μ ± ${2 * sigN}σ. The dashed guide marks the selected day.`;
  } else {
    cap.innerHTML = `Daily climatological mean for ${range.title} at <b style="color:var(--ink);font-style:normal">${c.name}, ${c.state}</b>. Inner band is μ ± ${sigN}σ; outer band is μ ± ${2 * sigN}σ. The dashed guide marks the selected day.`;
  }
  card.appendChild(cap);

  return card;
}

// =====================================================================
// Two-station overlay time-series card (compare view)
// =====================================================================
function buildCompareTimeseriesCard(cA, cB, mode) {
  const card = document.createElement("div");
  card.className = "dash-card timeseries";
  const variable = state.compareVariable;
  const cfg = VAR_CONFIG[variable];
  const dec = cfg.decimals;
  const sigN = state.compareSigmaN;

  const range = rangeForMode(mode, state.compareDoy);
  const samplesA = climSamples(cA, variable, range.start, range.count);
  const samplesB = climSamples(cB, variable, range.start, range.count);
  const series = [
    { name: cA.name, samples: samplesA, ...SERIES_PALETTE.A },
    { name: cB.name, samples: samplesB, ...SERIES_PALETTE.B },
  ];

  // target on station A's curve at the selected day (if visible in range)
  let target = null;
  if (mode === "year") {
    const s = samplesA[state.compareDoy];
    target = s ? { x: s.x, mu: s.mu, color: SERIES_PALETTE.A.color } : null;
  } else {
    const md = monthDayFromDoy(state.compareDoy);
    if (md.m - 1 === range.monthIdx) {
      const s = samplesA[md.d - 1];
      target = s ? { x: s.x, mu: s.mu, color: SERIES_PALETTE.A.color } : null;
    }
  }

  const svg = renderTimeseriesSvg({
    series, sigN, dec, unit: cfg.unit,
    xRange: { min: 1, max: range.count },
    xTicks: range.ticks,
    target,
  });

  const kicker = mode === "year" ? "ANNUAL OVERLAY" : "MONTHLY OVERLAY";
  card.innerHTML = `
    <header class="dc-head">
      <div>
        <span class="dc-kicker">${kicker}</span>
        <span class="dc-title">${mode === "year" ? "Annual normals" : range.title + " normals"} (μ ± ${sigN}σ band)</span>
      </div>
      <div class="dc-meta">${cfg.label} · ${cfg.unit}</div>
    </header>
    <div class="ts-legend">
      <span class="ts-swatch" style="background:${SERIES_PALETTE.A.color}"></span>
      <span class="ts-legend-label"><b>${cA.name}, ${cA.state}</b> &nbsp;<i>(Station A)</i></span>
      <span class="ts-swatch" style="background:${SERIES_PALETTE.B.color};margin-left:18px"></span>
      <span class="ts-legend-label"><b>${cB.name}, ${cB.state}</b> &nbsp;<i>(Station B)</i></span>
    </div>`;
  card.appendChild(svg);

  const cap = document.createElement("div");
  cap.className = "stats-band";
  cap.innerHTML = `Two-station overlay. Solid line is each station's daily climatological mean; the surrounding band is μ ± ${sigN}σ (and faintly, μ ± ${2 * sigN}σ). The dashed guide marks the selected day on Station A's curve.`;
  card.appendChild(cap);

  return card;
}

// ============================================================
//   COMPARE VIEW — search, controls, dashboard
// ============================================================
const compareDashboard = document.getElementById("compareDashboard");
const compareDateInput = document.getElementById("compareDate");
const compareVarSelect = document.getElementById("compareVar");
const compareSigmaInput = document.getElementById("compareSigmaN");

// Variable selector
for (const [k, cfg] of Object.entries(VAR_CONFIG)) {
  const opt = document.createElement("option");
  opt.value = k;
  opt.textContent = `${cfg.label} (${cfg.unit})`;
  compareVarSelect.appendChild(opt);
}
compareVarSelect.value = state.compareVariable;

function setCompareDateInput(doy) {
  const { m, d } = monthDayFromDoy(doy);
  const year = 2025;
  compareDateInput.value = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
setCompareDateInput(state.compareDoy);

compareDateInput.addEventListener("change", () => {
  const v = compareDateInput.value;
  if (!v) return;
  const parts = v.split("-").map(Number);
  if (parts.length < 3) return;
  state.compareDoy = doyFromMonthDay(parts[1], parts[2]);
  renderCompareDashboard();
});

compareVarSelect.addEventListener("change", () => {
  state.compareVariable = compareVarSelect.value;
  renderCompareDashboard();
});

compareSigmaInput.addEventListener("input", () => {
  const v = parseFloat(compareSigmaInput.value);
  if (!Number.isFinite(v)) return;
  state.compareSigmaN = v;
  renderCompareDashboard();
});

const compareModeToggle = document.querySelector('.mode-toggle[data-target="compare"]');
compareModeToggle.querySelectorAll(".mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    compareModeToggle.querySelectorAll(".mode")
      .forEach((b) => b.classList.toggle("is-active", b === btn));
    state.compareMode = btn.dataset.mode;
    renderCompareDashboard();
  });
});

// Two parallel station searches (Station A / Station B)
for (const slot of ["A", "B"]) {
  const input = document.querySelector(`.compare-input[data-slot="${slot}"]`);
  const results = document.querySelector(`.lookup-results[data-slot="${slot}"]`);
  const suffix = document.querySelector(`.lookup-suffix[data-slot="${slot}"]`);
  bindSearch({
    input, results, suffix,
    onPick: (c) => {
      if (slot === "A") state.compareAId = c.id;
      else state.compareBId = c.id;
      renderCompareDashboard();
    },
  });
}

function getCompareCity(slot) {
  const id = slot === "A" ? state.compareAId : state.compareBId;
  return CITIES.find((c) => c.id === id);
}

function renderCompareDashboard() {
  const A = getCompareCity("A");
  const B = getCompareCity("B");
  if (!A || !B) {
    compareDashboard.innerHTML = `
      <div class="dash-empty">
        <span class="dash-empty-glyph">⇌</span>
        <p>Pick two stations to compare.</p>
        <p class="dash-empty-hint">Useful for sanity-checking intuitions — for example, <em>Phoenix, AZ</em> versus <em>Death Valley, CA</em>, or <em>Seattle, WA</em> versus <em>San Diego, CA</em>. Snapshot, difference, and overlaid time-series will appear below.</p>
      </div>`;
    return;
  }
  compareDashboard.innerHTML = "";
  compareDashboard.appendChild(buildCompareSnapshotCard(A, "A"));
  compareDashboard.appendChild(buildCompareSnapshotCard(B, "B"));
  compareDashboard.appendChild(buildDifferenceCard(A, B));
  if (state.compareMode === "month" || state.compareMode === "year") {
    compareDashboard.appendChild(buildCompareTimeseriesCard(A, B, state.compareMode));
  }
}

function buildCompareSnapshotCard(c, slot) {
  const variable = state.compareVariable;
  const cfg = VAR_CONFIG[variable];
  const dec = cfg.decimals;
  const sigN = state.compareSigmaN;
  const mu = c.climate[variable].mean[state.compareDoy];
  const sd = c.climate[variable].std[state.compareDoy];
  const lo = mu == null ? null : mu - sigN * sd;
  const hi = mu == null ? null : mu + sigN * sd;

  const card = document.createElement("div");
  card.className = `dash-card compare-snapshot compare-snapshot--${slot.toLowerCase()}`;
  card.innerHTML = `
    <header class="dc-head">
      <div>
        <span class="dc-kicker">STATION ${slot}</span>
        <span class="dc-title">${c.name}, ${c.state}</span>
      </div>
      <div class="dc-meta">${formatMonthDay(state.compareDoy)}</div>
    </header>
    <div class="snapshot-cell featured">
      <span class="sc-label">${cfg.label} · μ</span>
      <span class="sc-val">${mu == null ? "—" : mu.toFixed(dec)}<span class="sc-unit">${cfg.unit}</span></span>
      <span class="sc-band">σ = <b>${sd == null ? "—" : sd.toFixed(dec === 0 ? 1 : 2)}</b> ${cfg.unit}
       &nbsp;·&nbsp; μ ± ${sigN}σ&nbsp;= <code>${lo == null ? "—" : lo.toFixed(dec)} … ${hi == null ? "—" : hi.toFixed(dec)}</code></span>
    </div>`;
  return card;
}

function buildDifferenceCard(A, B) {
  const card = document.createElement("div");
  card.className = "dash-card compare-diff";
  const variable = state.compareVariable;
  const cfg = VAR_CONFIG[variable];
  const dec = cfg.decimals;
  const muA = A.climate[variable].mean[state.compareDoy];
  const muB = B.climate[variable].mean[state.compareDoy];
  const sdA = A.climate[variable].std[state.compareDoy];
  const sdB = B.climate[variable].std[state.compareDoy];
  const diff = (muA != null && muB != null) ? muA - muB : null;

  // Standard error of the difference of two independent climatological means.
  // Each sample has n=43 years; SE = sqrt((σA² + σB²) / n).
  const N = META.sampleYears || 43;
  const se = (sdA != null && sdB != null && N > 0)
    ? Math.sqrt((sdA * sdA + sdB * sdB) / N) : null;
  const z = (diff != null && se != null && se > 0) ? diff / se : null;

  // Annual aggregates
  let mxA = -Infinity, mxB = -Infinity, mnA = Infinity, mnB = Infinity;
  let amA = 0, amB = 0, anN = 0;
  for (let d = 0; d < 365; d++) {
    const a = A.climate[variable].mean[d];
    const b = B.climate[variable].mean[d];
    if (a == null || b == null) continue;
    amA += a; amB += b; anN++;
    if (a > mxA) mxA = a;
    if (b > mxB) mxB = b;
    if (a < mnA) mnA = a;
    if (b < mnB) mnB = b;
  }
  if (anN > 0) { amA /= anN; amB /= anN; }

  const fmtSign = (x) => (x == null ? "—" : (x >= 0 ? "+" : "") + x.toFixed(dec));

  card.innerHTML = `
    <header class="dc-head">
      <div>
        <span class="dc-kicker">DIFFERENCE</span>
        <span class="dc-title">A &minus; B</span>
      </div>
      <div class="dc-meta">${cfg.label} · ${cfg.unit}</div>
    </header>
    <div class="snapshot-cell featured" style="border-color:var(--signal)">
      <span class="sc-label">μ_A − μ_B · ${formatMonthDay(state.compareDoy)}</span>
      <span class="sc-val">${fmtSign(diff)}<span class="sc-unit">${cfg.unit}</span></span>
      <span class="sc-band">${z == null ? "&nbsp;" : `effect size ≈ <b>${z.toFixed(2)}σ</b> (pooled, n=${N})`}</span>
    </div>
    <div class="stats-readout">
      <div class="stats-readout-row">
        <span class="sr-label">Annual mean Δ</span>
        <span class="sr-val">${fmtSign(amA - amB)}</span>
      </div>
      <div class="stats-readout-row">
        <span class="sr-label">Peak Δ (A − B)</span>
        <span class="sr-val">${fmtSign(mxA - mxB)}</span>
      </div>
      <div class="stats-readout-row">
        <span class="sr-label">Trough Δ (A − B)</span>
        <span class="sr-val">${fmtSign(mnA - mnB)}</span>
      </div>
    </div>`;
  return card;
}
