# U.S. Atmospheric Bulletin

Static, single-page **U.S. weather climatology viewer** styled as a printed
scientific bulletin. Two views:

1. **Spatial Distribution** — a heatmap of the continental U.S. (Alaska and
   Hawaii in inset) for a chosen variable on a chosen day-of-year, with an
   optional ±n·σ statistical overlay.
2. **Station Lookup** — search for a city and see day or month detail:
   snapshot card, full climatology stats, and (in month mode) a daily time
   series with confidence band.

## Data

- **Source:** ECMWF [ERA5](https://www.ecmwf.int/en/forecasts/dataset/ecmwf-reanalysis-v5)
  reanalysis, accessed through the [Open-Meteo](https://open-meteo.com/) free
  archive API (no key required).
- **Period:** 2014-01-01 through 2023-12-31 (10 years of daily values).
- **Stations:** ~140 representative cities across all 50 states + DC. Daily
  normals are computed per calendar day after collapsing Feb 29 into Feb 28.
- **Variables:** daily high / low / mean temperature (°F), precipitation (in),
  daily max wind speed (mph). Each is stored as a 365-element `mean[]` and
  `std[]` array per station.

The published `data/climatology.json` may contain a subset of cities depending
on what the throttled free-tier fetcher was able to retrieve.

## Local development

```bash
node scripts/fetch_climatology.mjs   # populates data/climatology.json (resumable)
cd docs
python -m http.server 8765           # then open http://127.0.0.1:8765
```

The fetcher is **resumable** — re-running it fills in any cities that failed
during a previous attempt. Open-Meteo's free tier is rate-limited per minute
and per hour; the script paces requests at ~6 s/req with up-to-30-minute
backoffs on `HTTP 429`.

## Deployment

The site is published from the `/docs` folder of `main` via GitHub Pages
(Settings → Pages → Source: Deploy from a branch · main · /docs).

## Visual notes

Stylesheet is intentionally **not** the usual flat dashboard look. It borrows
from printed scientific bulletins and weather-bureau broadsides:
restricted cream-paper / signal-red / ink palette, condensed display
type combined with monospace UI labels, registration marks at the
viewport corners, hand-stamped editorial accents, asymmetric grid.
