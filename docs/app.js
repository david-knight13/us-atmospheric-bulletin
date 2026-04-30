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
// Custom interpolators tuned for paper-stock palette, not the usual viridis.
const COLOR_RAMPS = {
  // Diverging cool→cream→hot for temperatures (high)
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
  // Sequential cream → deep blue for precipitation
  precip: d3.interpolateRgbBasis([
    "#f3eada", "#dfd4b1", "#a9c1c9", "#5d8aa3", "#27466e", "#0e2748",
  ]),
  // Sequential cream → plum for wind
  wind: d3.interpolateRgbBasis([
    "#f3eada", "#dcc7a8", "#c1986b", "#894d57", "#3a1f3d",
  ]),
};

// Per-variable display config (domain set after data load).
const VAR_CONFIG = {
  tmax:   { label: META.variables.tmax.label,   short: "T-MAX",  unit: "°F", decimals: 0, ramp: COLOR_RAMPS.tmax },
  tmin:   { label: META.variables.tmin.label,   short: "T-MIN",  unit: "°F", decimals: 0, ramp: COLOR_RAMPS.tmin },
  tmean:  { label: META.variables.tmean.label,  short: "T-MEAN", unit: "°F", decimals: 0, ramp: COLOR_RAMPS.tmean },
  precip: { label: META.variables.precip.label, short: "PRECIP", unit: "in", decimals: 2, ramp: COLOR_RAMPS.precip },
  wind:   { label: META.variables.wind.label,   short: "WIND",   unit: "mph", decimals: 0, ramp: COLOR_RAMPS.wind },
};

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
  variable: "tmax",
  doy: todayDoy(),
  sigmaOn: false,
  sigmaSign: -1,
  sigmaN: 1,

  // lookup
  selectedCityId: null,
  lookupMode: "day", // "day" | "month"
  lookupDoy: todayDoy(),
  lookupVariable: "tmax",
  lookupSigmaN: 1,
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
document.getElementById("periodCell").textContent = `PERIOD ${META.period.replace("/", " — ")}`;

// ============================================================
//   TAB SWITCHING
// ============================================================
const viewMap = document.getElementById("view-map");
const viewLookup = document.getElementById("view-lookup");
document.querySelectorAll(".tabbar .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabbar .tab").forEach((b) => {
      b.classList.toggle("is-active", b === btn);
      b.setAttribute("aria-selected", b === btn);
    });
    state.view = btn.dataset.view;
    viewMap.hidden = state.view !== "map";
    viewLookup.hidden = state.view !== "lookup";
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
  // Project cities into the mask's coord system (same projection scaled).
  const lowCityXY = CITIES
    .map((c) => {
      const xy = tmpProj([c.lon, c.lat]);
      return xy ? { x: xy[0], y: xy[1] } : null;
    });

  const K = 8;
  const indices = new Int16Array(W * H * K);
  const weights = new Float32Array(W * H * K);

  // scratch arrays for top-K
  const dists = new Float32Array(CITIES.length);
  const order = new Int16Array(CITIES.length);

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      // alpha = mask[i*4+3]; we filled with opaque black for inside US
      if (mask[i * 4 + 3] < 200) {
        // outside US — mark with index -1
        indices[i * K] = -1;
        continue;
      }
      // compute distances to all cities
      for (let c = 0; c < CITIES.length; c++) {
        const cp = lowCityXY[c];
        if (!cp) { dists[c] = Infinity; continue; }
        const dx = cp.x - px, dy = cp.y - py;
        dists[c] = dx * dx + dy * dy;
        order[c] = c;
      }
      // partial sort: select top K (indices with smallest dists)
      // simple selection sort for K iterations
      for (let s = 0; s < K; s++) {
        let bestI = s;
        for (let j = s + 1; j < CITIES.length; j++) {
          if (dists[order[j]] < dists[order[bestI]]) bestI = j;
        }
        const tmp = order[s]; order[s] = order[bestI]; order[bestI] = tmp;
      }
      // compute weights = 1 / d^2 (cap d²>=1 to avoid blow-up)
      let wSum = 0;
      for (let s = 0; s < K; s++) {
        const idx = order[s];
        const d2 = Math.max(1, dists[idx]);
        const w = 1 / d2;
        indices[i * K + s] = idx;
        weights[i * K + s] = w;
        wSum += w;
      }
      // normalize
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
    .attr("r", 2.2)
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

document.querySelectorAll(".mode-toggle .mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-toggle .mode")
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

// ----- search -----
function fuzzyMatch(q, c) {
  const text = `${c.name} ${c.state}`.toLowerCase();
  return text.includes(q);
}
function doSearch(q) {
  q = q.toLowerCase().trim();
  if (!q) { searchResults.hidden = true; searchResults.innerHTML = ""; searchSuffix.textContent = ""; return; }
  const matches = CITIES.filter((c) => fuzzyMatch(q, c)).slice(0, 12);
  searchResults.innerHTML = matches.map((c) =>
    `<li data-id="${c.id}"><span>${c.name}</span><span class="li-state">${c.state}</span></li>`
  ).join("");
  searchResults.hidden = matches.length === 0;
  searchSuffix.textContent = `${matches.length} hit${matches.length === 1 ? "" : "s"}`;
  searchResults.querySelectorAll("li").forEach((li) => {
    li.addEventListener("mousedown", (e) => e.preventDefault());
    li.addEventListener("click", () => {
      const c = CITIES.find((x) => x.id === li.dataset.id);
      if (c) {
        searchInput.value = `${c.name}, ${c.state}`;
        searchResults.hidden = true;
        selectStation(c);
      }
    });
  });
}
searchInput.addEventListener("input", () => doSearch(searchInput.value));
searchInput.addEventListener("focus", () => {
  if (searchInput.value) doSearch(searchInput.value);
});
document.addEventListener("click", (e) => {
  if (!searchResults.contains(e.target) && e.target !== searchInput) {
    searchResults.hidden = true;
  }
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
        <p>SELECT A STATION TO BEGIN.</p>
        <p class="dash-empty-hint">Search by city or state above.</p>
      </div>`;
    return;
  }
  lookupDashboard.innerHTML = "";
  lookupDashboard.appendChild(buildSnapshotCard(c));
  lookupDashboard.appendChild(buildStatsCard(c));
  if (state.lookupMode === "month") {
    lookupDashboard.appendChild(buildTimeseriesCard(c));
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

function buildTimeseriesCard(c) {
  const card = document.createElement("div");
  card.className = "dash-card timeseries";
  const variable = state.lookupVariable;
  const cfg = VAR_CONFIG[variable];
  const dec = cfg.decimals;

  // determine month from lookupDoy
  const { m: month } = monthDayFromDoy(state.lookupDoy);
  const dStart = CUMULATIVE[month - 1];
  const days = DAYS_IN_MONTH[month - 1];
  const samples = [];
  for (let i = 0; i < days; i++) {
    const doy = dStart + i;
    const mu = c.climate[variable].mean[doy];
    const sd = c.climate[variable].std[doy];
    samples.push({ d: i + 1, doy, mu, sd });
  }

  // SVG plot
  const W = 880, H = 320, M = { l: 56, r: 24, t: 20, b: 36 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  const xs = samples.map((s) => s.d);
  const xMin = 1, xMax = days;

  const sigN = state.lookupSigmaN;
  const upper = samples.map((s) => s.mu == null ? null : s.mu + sigN * s.sd);
  const lower = samples.map((s) => s.mu == null ? null : s.mu - sigN * s.sd);
  const upper2 = samples.map((s) => s.mu == null ? null : s.mu + 2 * sigN * s.sd);
  const lower2 = samples.map((s) => s.mu == null ? null : s.mu - 2 * sigN * s.sd);
  const allVals = samples.flatMap((s) =>
    s.mu == null ? [] : [s.mu - 2 * sigN * s.sd, s.mu + 2 * sigN * s.sd]);
  const yLo = Math.min(...allVals);
  const yHi = Math.max(...allVals);
  const yPad = (yHi - yLo) * 0.06 || 1;
  const yMin = yLo - yPad, yMax = yHi + yPad;

  const sx = (d) => M.l + ((d - xMin) / Math.max(1, xMax - xMin)) * innerW;
  const sy = (v) => M.t + (1 - (v - yMin) / Math.max(0.0001, yMax - yMin)) * innerH;

  // build SVG
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "timeseries-svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // grid (horizontal)
  const gridG = document.createElementNS(ns, "g");
  gridG.setAttribute("class", "ts-grid");
  for (let i = 0; i <= 4; i++) {
    const yv = yMin + (yMax - yMin) * (i / 4);
    const y = sy(yv);
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", M.l); ln.setAttribute("x2", W - M.r);
    ln.setAttribute("y1", y); ln.setAttribute("y2", y);
    gridG.appendChild(ln);
    const tx = document.createElementNS(ns, "text");
    tx.setAttribute("x", M.l - 6);
    tx.setAttribute("y", y + 3);
    tx.setAttribute("text-anchor", "end");
    tx.setAttribute("font-size", "10");
    tx.setAttribute("fill", "rgba(31,23,20,0.55)");
    tx.textContent = yv.toFixed(dec);
    gridG.appendChild(tx);
  }
  svg.appendChild(gridG);

  // outer 2σ band
  const outerArea = `M ${sx(samples[0].d)} ${sy(upper2[0])} ` +
    samples.slice(1).map((s, i) => `L ${sx(s.d)} ${sy(upper2[i + 1])}`).join(" ") +
    " " + samples.slice().reverse().map((s, i) =>
      `L ${sx(s.d)} ${sy(lower2[lower2.length - 1 - i])}`).join(" ") + " Z";
  const outer = document.createElementNS(ns, "path");
  outer.setAttribute("class", "ts-band-2");
  outer.setAttribute("d", outerArea);
  svg.appendChild(outer);

  // inner sigma band
  const area = `M ${sx(samples[0].d)} ${sy(upper[0])} ` +
    samples.slice(1).map((s, i) => `L ${sx(s.d)} ${sy(upper[i + 1])}`).join(" ") +
    " " + samples.slice().reverse().map((s, i) =>
      `L ${sx(s.d)} ${sy(lower[lower.length - 1 - i])}`).join(" ") + " Z";
  const band = document.createElementNS(ns, "path");
  band.setAttribute("class", "ts-band");
  band.setAttribute("d", area);
  svg.appendChild(band);

  // mean line
  const meanD = samples.map((s, i) => `${i === 0 ? "M" : "L"} ${sx(s.d)} ${sy(s.mu)}`).join(" ");
  const mean = document.createElementNS(ns, "path");
  mean.setAttribute("class", "ts-mean");
  mean.setAttribute("d", meanD);
  svg.appendChild(mean);

  // dots
  for (const s of samples) {
    if (s.mu == null) continue;
    const c1 = document.createElementNS(ns, "circle");
    c1.setAttribute("class", "ts-mean-dot");
    c1.setAttribute("cx", sx(s.d));
    c1.setAttribute("cy", sy(s.mu));
    c1.setAttribute("r", 2);
    svg.appendChild(c1);
  }

  // target indicator (if selected day in this month)
  const targetMD = monthDayFromDoy(state.lookupDoy);
  if (targetMD.m === month) {
    const t = samples.find((s) => s.d === targetMD.d);
    if (t && t.mu != null) {
      const tx = sx(t.d), ty = sy(t.mu);
      const tg = document.createElementNS(ns, "g");
      tg.innerHTML = `
        <line x1="${tx}" y1="${M.t}" x2="${tx}" y2="${M.t + innerH}" stroke="rgba(196,41,31,0.55)" stroke-dasharray="2 3"></line>
        <circle class="ts-target" cx="${tx}" cy="${ty}" r="4.5"></circle>
        <text class="ts-target-text" x="${tx + 8}" y="${ty - 8}">${t.mu.toFixed(dec)} ${cfg.unit}</text>`;
      svg.appendChild(tg);
    }
  }

  // x-axis ticks
  const axisG = document.createElementNS(ns, "g");
  axisG.setAttribute("class", "ts-axis");
  const xAxisY = M.t + innerH;
  const xAxis = document.createElementNS(ns, "line");
  xAxis.setAttribute("x1", M.l); xAxis.setAttribute("x2", W - M.r);
  xAxis.setAttribute("y1", xAxisY); xAxis.setAttribute("y2", xAxisY);
  xAxis.setAttribute("stroke", "rgba(31,23,20,0.6)");
  axisG.appendChild(xAxis);
  for (let d = 1; d <= days; d++) {
    if (days > 14 && d !== 1 && d !== days && d % 2 !== 0) continue;
    const tk = document.createElementNS(ns, "line");
    tk.setAttribute("x1", sx(d)); tk.setAttribute("x2", sx(d));
    tk.setAttribute("y1", xAxisY); tk.setAttribute("y2", xAxisY + 4);
    tk.setAttribute("stroke", "rgba(31,23,20,0.55)");
    axisG.appendChild(tk);
    const txt = document.createElementNS(ns, "text");
    txt.setAttribute("x", sx(d));
    txt.setAttribute("y", xAxisY + 16);
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("font-size", "10");
    txt.setAttribute("fill", "rgba(31,23,20,0.55)");
    txt.textContent = d;
    axisG.appendChild(txt);
  }
  svg.appendChild(axisG);

  card.innerHTML = `
    <header class="dc-head">
      <div>
        <span class="dc-kicker">TIME SERIES</span>
        <span class="dc-title">${MONTH_LONG[month - 1]} — Daily Normals (μ ± ${state.lookupSigmaN}σ band)</span>
      </div>
      <div class="dc-meta">${cfg.label} · ${cfg.unit}</div>
    </header>`;
  card.appendChild(svg);

  // legend / caption
  const cap = document.createElement("div");
  cap.className = "stats-band";
  cap.innerHTML = `
    Solid line traces the climatological daily mean for ${MONTH_LONG[month - 1]} at <b style="color:var(--ink);font-style:normal">${c.name}, ${c.state}</b>.
    Inner shaded band is μ ± ${state.lookupSigmaN}σ; outer band is μ ± ${2 * state.lookupSigmaN}σ. Vertical guide marks the selected day.`;
  card.appendChild(cap);

  return card;
}
