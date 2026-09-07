require('dotenv').config();
const path = require('path');
const express = require('express');

const { startPolling } = require('./poller');
const {
  getLatestReading,
  getReadingsSinceAggregated,
  getReadingsInRange,
  getAggregate,
  getNetPlusGeneration,
} = require('./db');
const { integrateKwh, integrateSolarSplit } = require('./energy');
const { loadSettings, saveSettings } = require('./settings');

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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  res.json({
    billingCycleStartDay: settings.billingCycleStartDay,
    electricityRateUsdPerKwh: effectiveRate(),
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

  saveSettings(updated);
  res.json({ billingCycleStartDay: updated.billingCycleStartDay, electricityRateUsdPerKwh: effectiveRate() });
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

// A robust low-end estimate of (grid + solar) - i.e. total house
// consumption - over a window: bucket samples into one-minute windows and
// take the max within each, then use the smallest of those per-minute
// maxima as the household's standby/"always on" floor. A single noisy
// sample (a brief negative/near-zero sensor artifact) simply gets
// outshone by its own minute's real peak, so it can never influence the
// result - unlike a statistic computed directly on raw samples. Minutes
// with too few samples (a polling gap) are discarded entirely - a max
// computed from only one or two readings isn't a reliable peak, and could
// itself be a noisy sample masquerading as the whole minute's baseline.
function alwaysOnFromSamples(rows) {
  const perMinute = new Map();
  for (const r of rows) {
    const value = r.net_w + (r.generation_w || 0);
    const minuteKey = Math.floor(r.ts / 60000);
    const entry = perMinute.get(minuteKey);
    if (entry === undefined) {
      perMinute.set(minuteKey, { max: value, count: 1 });
    } else {
      entry.count += 1;
      if (value > entry.max) entry.max = value;
    }
  }

  const maxima = [...perMinute.values()]
    .filter((entry) => entry.count >= ALWAYS_ON_MIN_SAMPLES_PER_MINUTE)
    .map((entry) => entry.max);
  if (maxima.length === 0) return null;
  return Math.min(...maxima);
}

app.get('/api/current', (req, res) => {
  const latest = getLatestReading();

  if (!latest) {
    return res.json({ ts: null, consumption: null, generation: null, net: null, alwaysOnW: null });
  }

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let alwaysOnW = alwaysOnFromSamples(getNetPlusGeneration(dayAgo, Date.now() + 1));
  if (alwaysOnW === null) {
    // No net/solar metering on this sensor at all - fall back to the
    // plain consumption minimum (already the true house-load reading).
    const trailing = getAggregate(dayAgo, Date.now() + 1);
    alwaysOnW = trailing.minConsumption;
  }

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

app.get('/api/history', (req, res) => {
  const minutes = Math.min(Number(req.query.minutes) || 60, 10080);
  const since = Date.now() - minutes * 60 * 1000;
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

  const buckets = starts.map((bucketStart, i) => {
    const bucketEnd = i + 1 < starts.length ? starts[i + 1].getTime() : end.getTime();
    const rows = getReadingsInRange(bucketStart.getTime(), bucketEnd);
    return {
      ts: bucketStart.getTime(),
      consumptionKwh: integrateKwh(rows, 'consumption_w'),
      generationKwh: integrateKwh(rows, 'generation_w'),
    };
  });

  const consumptionValues = buckets.map((b) => b.consumptionKwh);
  const generationValues = buckets.map((b) => b.generationKwh);
  const avg = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

  res.json({
    granularity,
    offset,
    label: periodLabel(granularity, offset, start, end),
    canGoForward: offset > 0,
    buckets,
    stats: {
      consumption: { min: Math.min(...consumptionValues), max: Math.max(...consumptionValues), avg: avg(consumptionValues) },
      generation: { min: Math.min(...generationValues), max: Math.max(...generationValues), avg: avg(generationValues) },
    },
  });
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
  const days = clamp(Number(req.query.days) || 30, 1, 365);
  const startTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const samples = getReadingsInRange(startTs, Date.now() + 1);

  const consumptionKwh = integrateKwh(samples, 'consumption_w');
  const generationKwh = integrateKwh(samples, 'generation_w');
  const split = integrateSolarSplit(samples);
  const percentFromSolar =
    consumptionKwh > 0 ? (split.usedFromSolarKwh / consumptionKwh) * 100 : generationKwh > 0 ? 100 : 0;

  const result = {
    days,
    consumptionKwh,
    generationKwh,
    percentFromSolar,
    ...split,
  };

  const rate = effectiveRate();
  if (rate) {
    result.costSavedUsd = (split.usedFromSolarKwh + split.exportedKwh) * rate;
  }

  res.json(result);
});

app.get('/api/energy-by-day', (req, res) => {
  const days = clamp(Number(req.query.days) || 7, 1, 90);
  const result = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const { date, startTs, endTs } = dayBounds(offset);
    const rows = getReadingsInRange(startTs, endTs);
    result.push({
      date,
      consumptionKwh: integrateKwh(rows, 'consumption_w'),
      generationKwh: integrateKwh(rows, 'generation_w'),
    });
  }
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log(`Polling Neurio sensor at ${NEURIO_IP} every ${POLL_INTERVAL_MS}ms`);
  startPolling(NEURIO_IP, POLL_INTERVAL_MS);
});
