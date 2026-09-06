# Neurio Energy Monitor

A small self-hosted dashboard that polls a Neurio energy sensor's local HTTP
API and stores readings in SQLite. It has three pages - a live Dashboard, a
History view, and Settings - styled after Generac's PWRview app (same
teal/amber color language and card layout; no PWRview/Generac branding or
logos are reproduced).

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `NEURIO_IP` to your sensor's LAN IP address (check your
router's DHCP client list, or the Neurio/Generac app's device settings).

## Run

```bash
npm start
```

Then open http://localhost:3000.

The server polls `http://<NEURIO_IP>/current-sample` every `POLL_INTERVAL_MS`
(default 10s) and appends each reading to `data/monitor.db` (SQLite).

## If a reading looks wrong or missing

Neurio/Generac firmware versions differ in their JSON shape. On first
successful poll, the server logs the raw sample to the console:

```
Sample received from Neurio sensor: {...}
```

`src/neurio.js`'s `extractPowerBreakdown()` reads channel types from the
sample's `channels` array:

- `GENERATION` → solar production (defaults to 0 if absent - no solar)
- `NET` → grid draw, positive = importing, negative = exporting
- `consumption` → **total home usage, computed as `net + generation`** -
  whatever the house drew from the grid plus whatever it used from solar.
  This is deliberately not read from the sensor's own `CONSUMPTION`
  channel, since that isn't guaranteed to already combine both sources (on
  some firmware it reflects grid-side/billing consumption only). If your
  sensor has no `NET` channel at all (older, non-solar setups), there's
  nothing to derive from, so it falls back to the sensor's `CONSUMPTION`
  channel, then to summing any `*_CONSUMPTION` phase channels.

Each channel's power field is read as `p_W` (or `p`/`power`/`avgPower`/
`watts` as fallbacks for older sensors). If your sensor uses different type
names or field names, adjust the lookups in `extractPowerBreakdown()` - the
raw JSON for every reading is also kept in the `raw_json` column of the
`readings` table, so nothing is lost even if the parsed values are off.

## Pages

- **Dashboard** (`/`) - current power (consumption/generation/net) with a
  range picker (10m/1h/6h/24h/7d), a Solar Savings gauge (% of usage
  covered by solar over the last 30 days, from actual integrated energy
  totals), a 7-day energy-use bar chart, and an "Always On" card showing
  the household's standby power floor over the last 24 hours. While the
  10-minute window is selected, the live stats and chart refresh every
  second instead of every 5/30 seconds.
- **History** (`/history.html`) - a bar chart of energy (kWh) at one of
  four granularities, each with its own pager: **Day** (hourly bars for
  one calendar day), **Month** (daily bars for one calendar month),
  **Year** (monthly bars for one calendar year), or **Billing** (daily
  bars for one billing cycle, per the start day set on the Settings page -
  cycles don't follow calendar-month boundaries). Below the chart,
  highest/lowest/average stats for consumption and generation, computed
  over whichever bars are shown (e.g. "Highest Hour" in Day view,
  "Highest Month" in Year view).
- **Settings** (`/settings.html`) - the billing cycle start day (1-28,
  used by History's Billing view) and the electricity rate (used to show
  $ figures in the Solar Savings card; leave blank to hide them). Saved to
  `data/settings.json` and take effect immediately, no restart needed.

Energy totals (kWh) are computed by numerically integrating the stored
watt readings over time - there's no separate energy meter. With a short
polling history, kWh figures will be small/incomplete until more data
accumulates; nothing is backfilled or estimated.

**Intentionally not included**, because PWRview's versions depend on data
this app has no source for: a Forecast/budget card (needs a budget target),
an editable "Always On" target with a percentile comparison to other
households (needs a user base to compare against), and account/login UI
(this is a single-user local tool with no accounts).

## API

- `GET /api/current` → `{ ts, consumption, generation, net, alwaysOnW }`
  for the latest stored reading (watts). `alwaysOnW` is the household's
  standby floor over the trailing 24 hours, computed fresh from
  `net`/`generation` (not the stored `consumption` column): samples are
  bucketed into one-minute windows, the max (grid + solar) is taken within
  each, minutes with fewer than 30 samples are discarded (too sparse - a
  polling gap - to trust as a real peak), and the smallest of the
  remaining per-minute maxima is the result. A single noisy sample (a
  brief negative/near-zero sensor artifact) can never influence this,
  since it's outshone by its own minute's genuine peak rather than
  compared directly against other samples.
- `GET /api/history?minutes=60` → `[{ ts, consumption, generation, net }, ...]`
  for the given window (max 10080 minutes / 7 days).
- `GET /api/day?offset=0` → one calendar day of samples plus
  highest/lowest/average stats for consumption and generation. `offset=0`
  is today, `1` is yesterday, etc.
- `GET /api/history-buckets?granularity=hour&offset=0` → bucketed kWh
  totals for the History page. `granularity` is `hour` (buckets = hours of
  one day), `day` (buckets = days of one month), `month` (buckets = months
  of one year), or `billing` (buckets = days of one billing cycle);
  `offset` steps back one period at a time (0 = the current one). Returns
  `{ granularity, offset, label, canGoForward,
  buckets: [{ ts, consumptionKwh, generationKwh }], stats }`.
- `GET /api/energy-summary?days=30` → integrated kWh totals over the given
  window: `consumptionKwh`, `generationKwh`, `usedFromSolarKwh`,
  `exportedKwh`, `importedKwh`, `percentFromSolar`, and `costSavedUsd` if
  an electricity rate is set.
- `GET /api/energy-by-day?days=7` → `[{ date, consumptionKwh, generationKwh }, ...]`
  per calendar day.
- `GET /api/settings` → `{ billingCycleStartDay, electricityRateUsdPerKwh }`.
- `PUT /api/settings` → body may include either or both fields; saves to
  `data/settings.json`. Set `electricityRateUsdPerKwh` to `null` to clear
  it - it then falls back to `ELECTRICITY_RATE_USD_PER_KWH` in `.env` if
  that's set (`.env` only supplies the *initial* rate; once saved here,
  this setting is the source of truth).
