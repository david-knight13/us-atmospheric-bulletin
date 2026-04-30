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

- **Source:** NASA's [MERRA-2](https://gmao.gsfc.nasa.gov/reanalysis/MERRA-2/)
  reanalysis, accessed via the [NASA POWER](https://power.larc.nasa.gov/) free
  daily endpoint (no key required, no daily quota).
- **Period:** 1981-01-01 through 2023-12-31 — **43 years**, *n=43* per
  day-of-year. Comfortably above the WMO's 30-year normal threshold.
- **Stations:** **399** representative cities covering all 50 states + DC,
  with deliberate fill-in across the Mountain West, Great Plains, Alaska, and
  Hawaii. Daily normals are computed per calendar day after collapsing Feb 29
  into Feb 28.
- **Variables:** daily high / low / mean temperature (°F), precipitation (in),
  daily max wind speed at 10 m (mph). Each is stored as a 365-element `mean[]`
  and `std[]` array per station. Population standard deviation, not sample.

## Local development

```bash
node scripts/fetch_climatology.mjs   # populates data/climatology.json (resumable)
cd docs
python -m http.server 8765           # then open http://127.0.0.1:8765
```

The fetcher is **resumable** — re-running it fills in any cities that failed
during a previous attempt. NASA POWER permits modest concurrency without a
daily quota, so the run completes in ~3 minutes for 399 stations × 43 years.

## Deployment

The site is published from the `/docs` folder of `main` via GitHub Pages
(Settings → Pages → Source: Deploy from a branch · main · /docs).

## Visual notes

Stylesheet is intentionally **not** the usual flat dashboard look. It borrows
from printed scientific bulletins and weather-bureau broadsides:
restricted cream-paper / signal-red / ink palette, condensed display
type combined with monospace UI labels, registration marks at the
viewport corners, hand-stamped editorial accents, asymmetric grid.
