require('dotenv').config();
const path = require('path');
const express = require('express');

const { startPolling } = require('./poller');
const {
  getLatestReading,
  getReadingsSinceAggregated,
  getReadingsInRange,
  getAggregate,
  getAlwaysOnFloor,
  getHourCoverageCount,
  getHourlySummaryRange,
} = require('./db');
const { energyForRange, energyForHourRange } = require('./energySummary');
const { startRollup } = require('./rollup');
const { loadSettings, saveSettings } = require('./settings');

const ROLLUP_INTERVAL_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const NEURIO_IP = process.env.NEURIO_IP;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 10000;
const PORT = Number(process.env.PORT) || 3000;
// .env only ever supplies the *initial* rate - once saved via the Settings
// page, settings.json takes over as the source of truth (see effectiveRate()).
const ENV_ELECTRICITY_RATE_USD_PER_KWH = process.env.ELECTRICITY_RATE_USD_PER_KWH
  ? Number(process.env.ELECTRICITY_RATE_USD_PER_KWH)
  : null;

if (!NEURIO_IP) {
  console.error('NEURIO_IP is not set. Copy .env.example to .env and fill in your sensor\'s IP.');
  process.exit(1);
}

function effectiveRate() {
  const settings = loadSettings();
  return typeof settings.electricityRateUsdPerKwh === 'number'
    ? settings.electricityRateUsdPerKwh
    : ENV_ELECTRICITY_RATE_USD_PER_KWH;
}

// Utilities often pay less for exported power than they charge for it, so
// the buyback rate is a distinct, optional setting - falling back to the
// regular electricity rate (not the env default directly) when unset, since
// that's the rate actually in effect right now.
function effectiveBuybackRate() {
  const settings = loadSettings();
  return typeof settings.gridBuybackRateUsdPerKwh === 'number'
    ? settings.gridBuybackRateUsdPerKwh
    : effectiveRate();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  res.json({
    billingCycleStartDay: settings.billingCycleStartDay,
    electricityRateUsdPerKwh: effectiveRate(),
    // Unlike electricityRateUsdPerKwh, these two are returned raw (not
    // resolved against a fallback) so the settings form shows blank -
    // meaning "no override" - rather than silently pre-filling and locking
    // in whatever the electricity rate happens to be right now.
    gridBuybackRateUsdPerKwh: settings.gridBuybackRateUsdPerKwh,
    fixedCostPerBillingPeriodUsd: settings.fixedCostPerBillingPeriodUsd,
  });
});

app.put('/api/settings', (req, res) => {
  const current = loadSettings();
  const updated = { ...current };

  if (req.body.billingCycleStartDay !== undefined) {
    const day = Number(req.body.billingCycleStartDay);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      return res.status(400).json({ error: 'billingCycleStartDay must be an integer between 1 and 28' });
    }
    updated.billingCycleStartDay = day;
  }

  if (req.body.electricityRateUsdPerKwh !== undefined) {
    const raw = req.body.electricityRateUsdPerKwh;
    if (raw === null || raw === '') {
      updated.electricityRateUsdPerKwh = null;
    } else {
      const rate = Number(raw);
      if (!Number.isFinite(rate) || rate < 0) {
        return res.status(400).json({ error: 'electricityRateUsdPerKwh must be a non-negative number' });
      }
      updated.electricityRateUsdPerKwh = rate;
    }
  }

  if (req.body.gridBuybackRateUsdPerKwh !== undefined) {
    const raw = req.body.gridBuybackRateUsdPerKwh;
    if (raw === null || raw === '') {
      updated.gridBuybackRateUsdPerKwh = null;
    } else {
      const rate = Number(raw);
      if (!Number.isFinite(rate) || rate < 0) {
        return res.status(400).json({ error: 'gridBuybackRateUsdPerKwh must be a non-negative number' });
      }
      updated.gridBuybackRateUsdPerKwh = rate;
    }
  }

  if (req.body.fixedCostPerBillingPeriodUsd !== undefined) {
    const raw = req.body.fixedCostPerBillingPeriodUsd;
    if (raw === null || raw === '') {
      updated.fixedCostPerBillingPeriodUsd = null;
    } else {
      const cost = Number(raw);
      if (!Number.isFinite(cost) || cost < 0) {
        return res.status(400).json({ error: 'fixedCostPerBillingPeriodUsd must be a non-negative number' });
      }
      updated.fixedCostPerBillingPeriodUsd = cost;
    }
  }

  saveSettings(updated);
  res.json({
    billingCycleStartDay: updated.billingCycleStartDay,
    electricityRateUsdPerKwh: effectiveRate(),
    gridBuybackRateUsdPerKwh: updated.gridBuybackRateUsdPerKwh,
    fixedCostPerBillingPeriodUsd: updated.fixedCostPerBillingPeriodUsd,
  });
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Local-time calendar-day boundaries, `offset` days back from today (0 = today).
function dayBounds(offset) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return {
    date: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
    startTs: start.getTime(),
    endTs: end.getTime(),
  };
}

const ALWAYS_ON_MIN_SAMPLES_PER_MINUTE = 30;

// The always-on floor is a trailing-24h statistic - it barely moves within
// a few seconds, but computing it isn't free (it aggregates a full day of
// raw samples), so /api/current can't afford to redo it on every call. The
// "live" 10-minute chart view polls /api/current every second, and without
// this cache each of those polls degrades every request until it comes
// back around.
const ALWAYS_ON_CACHE_MS = 15000;
let alwaysOnCache = { value: null, computedAt: 0 };

function getCachedAlwaysOnW() {
  const now = Date.now();
  if (now - alwaysOnCache.computedAt < ALWAYS_ON_CACHE_MS) return alwaysOnCache.value;

  const dayAgo = now - 24 * 60 * 60 * 1000;
  let alwaysOnW = getAlwaysOnFloor(dayAgo, now + 1, ALWAYS_ON_MIN_SAMPLES_PER_MINUTE);
  if (alwaysOnW === null) {
    // No net/solar metering on this sensor at all - fall back to the
    // plain consumption minimum (already the true house-load reading).
    alwaysOnW = getAggregate(dayAgo, now + 1).minConsumption;
  }

  alwaysOnCache = { value: alwaysOnW, computedAt: now };
  return alwaysOnW;
}

app.get('/api/current', (req, res) => {
  const latest = getLatestReading();

  if (!latest) {
    return res.json({ ts: null, consumption: null, generation: null, net: null, alwaysOnW: null });
  }

  const alwaysOnW = getCachedAlwaysOnW();

  res.json({
    ts: latest.ts,
    consumption: latest.consumption_w,
    generation: latest.generation_w,
    net: latest.net_w,
    alwaysOnW: typeof alwaysOnW === 'number' ? alwaysOnW : null,
  });
});

// Target point count for the history chart, regardless of range - keeps
// rendering fast (SVG path length, mousemove nearest-point scan) whether the
// underlying poll interval is 1s or 10s. Buckets narrower than the actual
// poll interval just come back as one raw sample each (no-op averaging).
const HISTORY_TARGET_POINTS = 180;

// Beyond this, the raw-sample GROUP BY (below) stops being a reasonable way
// to build a chart: it can't use the ts index (it groups by a computed
// expression), so past some row count SQLite spills the sort to a temp file
// and the query falls off a cliff - 24h (~86k rows at a 1s poll interval)
// takes well under a second, but 7d (~600k rows) was observed taking over
// 30 SECONDS, blocking the whole (single-threaded) server the entire time.
// Past this threshold we instead read one point per hour straight out of
// hourly_summary, which stays small (a handful of rows per day) forever
// regardless of how much raw history has piled up.
const HISTORY_RAW_LIMIT_MINUTES = 1440;

function historyFromHourlySummary(sinceTs) {
  const currentHourStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const points = getHourlySummaryRange(sinceTs, currentHourStart)
    .filter((h) => h.sampleCount > 0)
    .map((h) => ({ ts: h.hourStart, consumption: h.avgConsumptionW, generation: h.avgGenerationW, net: null }));

  // The current hour isn't in hourly_summary yet (it's still in progress) -
  // append it from raw samples so the chart includes the latest data.
  const currentAgg = getAggregate(currentHourStart, Date.now() + 1);
  if (currentAgg.count > 0) {
    points.push({ ts: currentHourStart, consumption: currentAgg.avgConsumption, generation: currentAgg.avgGeneration, net: null });
  }
  return points;
}

app.get('/api/history', (req, res) => {
  const minutes = Math.min(Number(req.query.minutes) || 60, 10080);
  const since = Date.now() - minutes * 60 * 1000;

  if (minutes > HISTORY_RAW_LIMIT_MINUTES) {
    return res.json(historyFromHourlySummary(since));
  }

  const bucketMs = (minutes * 60 * 1000) / HISTORY_TARGET_POINTS;
  const rows = getReadingsSinceAggregated(since, bucketMs);
  res.json(
    rows.map((r) => ({
      ts: r.ts,
      consumption: r.consumption_w,
      generation: r.generation_w,
      net: r.net_w,
    }))
  );
});

// Clamps a day-of-month to whatever the given month actually has (e.g. a
// billing day of 31 becomes Feb 28/29 in February).
function clampDayOfMonth(year, month, day) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return Math.min(day, daysInMonth);
}

// Bounds of one billing cycle, `offset` cycles back from the current one
// (0 = the cycle we're in right now).
function billingCycleBounds(startDay, offset) {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
  let cycleStart = new Date(year, month, clampDayOfMonth(year, month, startDay));
  if (cycleStart > now) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    cycleStart = new Date(year, month, clampDayOfMonth(year, month, startDay));
  }
  for (let i = 0; i < offset; i++) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
    cycleStart = new Date(year, month, clampDayOfMonth(year, month, startDay));
  }
  let endMonth = month + 1;
  let endYear = year;
  if (endMonth > 11) { endMonth = 0; endYear += 1; }
  const cycleEnd = new Date(endYear, endMonth, clampDayOfMonth(endYear, endMonth, startDay));
  return { start: cycleStart, end: cycleEnd };
}

// Bounds of the period a given granularity's pager steps through:
// hour -> one calendar day, day -> one calendar month, month -> one
// calendar year, billing -> one billing cycle (configurable start day).
function periodBounds(granularity, offset) {
  const now = new Date();
  if (granularity === 'month') {
    const start = new Date(now.getFullYear() - offset, 0, 1);
    return { start, end: new Date(start.getFullYear() + 1, 0, 1) };
  }
  if (granularity === 'billing') {
    return billingCycleBounds(loadSettings().billingCycleStartDay, offset);
  }
  if (granularity === 'day') {
    const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) };
}

function bucketStarts(granularity, start, end) {
  const starts = [];
  let cur = new Date(start);
  while (cur.getTime() < end.getTime()) {
    starts.push(new Date(cur));
    if (granularity === 'hour') cur = new Date(cur.getTime() + 60 * 60 * 1000);
    else if (granularity === 'day' || granularity === 'billing') {
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
    } else cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return starts;
}

function periodLabel(granularity, offset, start, end) {
  if (granularity === 'month') return offset === 0 ? 'This Year' : String(start.getFullYear());
  if (granularity === 'billing') {
    if (offset === 0) return 'Current Billing Period';
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${fmt(start)} – ${fmt(new Date(end.getTime() - 86400000))}`;
  }
  if (granularity === 'day') {
    return offset === 0 ? 'This Month' : start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Yesterday';
  return start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

app.get('/api/history-buckets', (req, res) => {
  const granularity = ['hour', 'day', 'month', 'billing'].includes(req.query.granularity)
    ? req.query.granularity
    : 'hour';
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { start, end } = periodBounds(granularity, offset);
  const starts = bucketStarts(granularity, start, end);
  const now = Date.now();

  const rate = effectiveRate();
  const { fixedCostPerBillingPeriodUsd } = loadSettings();
  const fixedCost = typeof fixedCostPerBillingPeriodUsd === 'number' ? fixedCostPerBillingPeriodUsd : 0;

  // Cost of a net amount of grid energy (imported minus exported): only net
  // draw is charged, at the standard rate - this is how basic net metering
  // actually bills (excess export rolls into a credit, it isn't a separate
  // paid-out sale), so it's deliberately independent of the grid buyback
  // rate, which only prices the Solar Savings card's separate "Buyback"
  // figure. Net export (negative) floors at zero: overproducing doesn't
  // turn into a negative bill.
  const netEnergyCostUsd = (netKwh) => (rate ? Math.max(0, netKwh) * rate : null);

  // Projects a period's full cost from its pace so far: a period already
  // fully elapsed (elapsed fraction 1) reduces to its actual net cost; one
  // still in progress has its net energy so far extrapolated to the full
  // period. A period that hasn't started yet has nothing to project from.
  function projectPeriodCostUsd(periodStart, periodEnd, importedKwh, exportedKwh) {
    const elapsedMs = Math.min(now, periodEnd) - periodStart;
    const totalMs = periodEnd - periodStart;
    const elapsedFraction = totalMs > 0 ? elapsedMs / totalMs : 0;
    if (elapsedFraction <= 0) return null;
    const cost = netEnergyCostUsd((importedKwh - exportedKwh) / elapsedFraction);
    return cost !== null ? cost + fixedCost : null;
  }

  const buckets = starts.map((bucketStart, i) => {
    const bucketStartTs = bucketStart.getTime();
    const bucketEnd = i + 1 < starts.length ? starts[i + 1].getTime() : end.getTime();
    const energy = granularity === 'hour'
      ? energyForHourRange(bucketStartTs, bucketEnd)
      : energyForRange(bucketStartTs, bucketEnd);
    return {
      ts: bucketStartTs,
      end: bucketEnd,
      consumptionKwh: energy.consumptionKwh,
      generationKwh: energy.generationKwh,
      importedKwh: energy.importedKwh,
      exportedKwh: energy.exportedKwh,
    };
  });

  // Stats exclude the current/future bucket - it's necessarily partial and
  // would otherwise drag the minimum down to whatever an unfinished period
  // has managed so far - and, for day-sized buckets, any past day the sensor
  // wasn't actually reporting for all 24 hours (e.g. the day data collection
  // started, or an outage), since a partial day's total isn't a real daily
  // minimum either.
  const isDayGranularity = granularity === 'day' || granularity === 'billing';
  const statsBuckets = buckets.filter((b) => {
    if (b.ts >= now) return false;
    if (isDayGranularity) {
      const expectedHours = Math.round((b.end - b.ts) / HOUR_MS);
      if (getHourCoverageCount(b.ts, b.end) < expectedHours) return false;
    }
    return true;
  });

  const consumptionValues = statsBuckets.map((b) => b.consumptionKwh);
  const generationValues = statsBuckets.map((b) => b.generationKwh);
  const avg = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
  const min = (values) => (values.length ? Math.min(...values) : null);
  const max = (values) => (values.length ? Math.max(...values) : null);

  // A month with exactly zero consumption AND generation wasn't actually
  // monitored (no sensor data exists for it yet, e.g. it's before this app
  // started collecting) rather than a real month of net-zero usage - real
  // households don't draw exactly 0.000 kWh over a full month. Showing a
  // cost for it would look like a real bill estimate when there's nothing
  // behind it.
  const hasData = (b) => b.consumptionKwh > 0 || b.generationKwh > 0;

  const result = {
    granularity,
    offset,
    label: periodLabel(granularity, offset, start, end),
    canGoForward: offset > 0,
    // Only the year view (month granularity) gets a per-bucket cost, shown
    // as a "$X" label above each bar: a completed month's actual net cost,
    // or - for the month still in progress - its pace-so-far projected to
    // the full month, so the current month isn't shown as an understated
    // partial total. A month that hasn't started yet, or has no data, has
    // no label. Other granularities don't show per-bar costs.
    buckets: buckets.map((b) => ({
      ts: b.ts,
      consumptionKwh: b.consumptionKwh,
      generationKwh: b.generationKwh,
      costUsd: granularity === 'month' && hasData(b) ? projectPeriodCostUsd(b.ts, b.end, b.importedKwh, b.exportedKwh) : null,
    })),
    stats: {
      consumption: { min: min(consumptionValues), max: max(consumptionValues), avg: avg(consumptionValues) },
      generation: { min: min(generationValues), max: max(generationValues), avg: avg(generationValues) },
    },
  };

  if (granularity === 'billing' && rate) {
    // Net energy for the whole period (imported minus exported, summed
    // across all its buckets) - NOT a sum of each day's already-floored
    // cost, which would ignore an exporting day's ability to offset an
    // importing day elsewhere in the same period.
    const importedSoFar = buckets.reduce((sum, b) => sum + b.importedKwh, 0);
    const exportedSoFar = buckets.reduce((sum, b) => sum + b.exportedKwh, 0);
    result.projectedCostUsd = projectPeriodCostUsd(start.getTime(), end.getTime(), importedSoFar, exportedSoFar);
  }

  res.json(result);
});

app.get('/api/day', (req, res) => {
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { date, startTs, endTs } = dayBounds(offset);
  const rows = getReadingsInRange(startTs, endTs);
  const agg = getAggregate(startTs, endTs);

  res.json({
    date,
    offset,
    canGoForward: offset > 0,
    samples: rows.map((r) => ({ ts: r.ts, consumption: r.consumption_w, generation: r.generation_w })),
    stats: {
      consumption: { min: agg.minConsumption, max: agg.maxConsumption, avg: agg.avgConsumption },
      generation: { min: agg.minGeneration, max: agg.maxGeneration, avg: agg.avgGeneration },
    },
  });
});

app.get('/api/energy-summary', (req, res) => {
  const { start, end } = billingCycleBounds(loadSettings().billingCycleStartDay, 0);
  const startTs = start.getTime();
  const endTsExclusive = Math.min(end.getTime(), Date.now() + 1);

  const { consumptionKwh, generationKwh, ...split } = energyForRange(startTs, endTsExclusive);
  const percentFromSolar =
    consumptionKwh > 0 ? (split.usedFromSolarKwh / consumptionKwh) * 100 : generationKwh > 0 ? 100 : 0;

  const result = {
    label: periodLabel('billing', 0, start, end),
    periodStartTs: startTs,
    periodEndTs: end.getTime(),
    consumptionKwh,
    generationKwh,
    percentFromSolar,
    ...split,
  };

  const rate = effectiveRate();
  if (rate) {
    // Kept separate rather than combined into one "savings" figure: solar
    // used directly offsets a retail purchase you'd otherwise have made
    // (valued at the full rate), but exported power is sold back to the
    // grid - a distinct transaction, not an avoided cost.
    result.costSavedUsd = split.usedFromSolarKwh * rate;
  }

  // typeof check, not truthiness - a buyback rate of exactly 0 (you get
  // nothing for exporting) is a real, meaningful setting and should still
  // report $0, not silently disappear the way a falsy check would treat it.
  const buybackRate = effectiveBuybackRate();
  if (typeof buybackRate === 'number') {
    result.gridBuybackUsd = split.exportedKwh * buybackRate;
  }

  const { fixedCostPerBillingPeriodUsd } = loadSettings();
  if (typeof fixedCostPerBillingPeriodUsd === 'number') {
    // The flat/service charge applies once per billing period regardless of
    // usage or how much of the period has elapsed - not prorated.
    result.fixedCostUsd = fixedCostPerBillingPeriodUsd;
  }

  res.json(result);
});

app.get('/api/energy-by-day', (req, res) => {
  const days = clamp(Number(req.query.days) || 7, 1, 90);
  const result = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const { date, startTs, endTs } = dayBounds(offset);
    const energy = energyForRange(startTs, endTs);
    result.push({
      date,
      consumptionKwh: energy.consumptionKwh,
      generationKwh: energy.generationKwh,
    });
  }
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log(`Polling Neurio sensor at ${NEURIO_IP} every ${POLL_INTERVAL_MS}ms`);
  startPolling(NEURIO_IP, POLL_INTERVAL_MS);
  startRollup(ROLLUP_INTERVAL_MS);
});
