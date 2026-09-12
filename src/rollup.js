// Populates hourly_summary and daily_summary from raw readings, so long-range
// charts never have to re-integrate raw samples. Runs at startup (to catch up
// on anything missed while the server was down) and on a timer afterwards.
//
// Hours are only ever rolled up once they're fully in the past (hour_start +
// 1h <= now), and days once every hour within them has been rolled up - the
// day summary is built by summing its hours rather than re-reading raw rows,
// so the cost of a day rollup doesn't depend on the poll interval.

const {
  getReadingsInRange,
  getAggregate,
  getEarliestReadingTs,
  upsertHourlySummary,
  upsertDailySummary,
  getHourlySummaryRange,
  getMaxHourlySummaryStart,
  getMaxDailySummaryEnd,
} = require('./db');
const { integrateKwh, integrateSolarSplit } = require('./energy');

const HOUR_MS = 60 * 60 * 1000;

function startOfLocalDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dateStringFor(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function summarizeHour(hourStart) {
  const rows = getReadingsInRange(hourStart, hourStart + HOUR_MS);
  const split = integrateSolarSplit(rows);
  const agg = getAggregate(hourStart, hourStart + HOUR_MS);
  return {
    hourStart,
    consumptionKwh: integrateKwh(rows, 'consumption_w'),
    generationKwh: integrateKwh(rows, 'generation_w'),
    usedFromSolarKwh: split.usedFromSolarKwh,
    exportedKwh: split.exportedKwh,
    importedKwh: split.importedKwh,
    minConsumptionW: agg.minConsumption,
    maxConsumptionW: agg.maxConsumption,
    avgConsumptionW: agg.avgConsumption,
    minGenerationW: agg.minGeneration,
    maxGenerationW: agg.maxGeneration,
    avgGenerationW: agg.avgGeneration,
    sampleCount: agg.count,
  };
}

// Rolls up every hour that has fully elapsed and isn't in hourly_summary yet.
function rollupCompletedHours(now = Date.now()) {
  const earliest = getEarliestReadingTs();
  if (earliest == null) return;

  const maxDone = getMaxHourlySummaryStart();
  let hourStart = maxDone != null ? maxDone + HOUR_MS : Math.floor(earliest / HOUR_MS) * HOUR_MS;
  const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS;

  while (hourStart < currentHourStart) {
    upsertHourlySummary(summarizeHour(hourStart));
    hourStart += HOUR_MS;
  }
}

function combineHourSummaries(dateStr, startTs, endTs, hours) {
  const totalSamples = hours.reduce((sum, h) => sum + (h.sampleCount || 0), 0);
  const sumField = (key) => hours.reduce((sum, h) => sum + (h[key] || 0), 0);
  const weightedAvg = (key) =>
    totalSamples > 0 ? hours.reduce((sum, h) => sum + (h[key] || 0) * (h.sampleCount || 0), 0) / totalSamples : null;
  const minField = (key) => {
    const vals = hours.map((h) => h[key]).filter((v) => typeof v === 'number');
    return vals.length ? Math.min(...vals) : null;
  };
  const maxField = (key) => {
    const vals = hours.map((h) => h[key]).filter((v) => typeof v === 'number');
    return vals.length ? Math.max(...vals) : null;
  };

  return {
    date: dateStr,
    startTs,
    endTs,
    consumptionKwh: sumField('consumptionKwh'),
    generationKwh: sumField('generationKwh'),
    usedFromSolarKwh: sumField('usedFromSolarKwh'),
    exportedKwh: sumField('exportedKwh'),
    importedKwh: sumField('importedKwh'),
    minConsumptionW: minField('minConsumptionW'),
    maxConsumptionW: maxField('maxConsumptionW'),
    avgConsumptionW: weightedAvg('avgConsumptionW'),
    minGenerationW: minField('minGenerationW'),
    maxGenerationW: maxField('maxGenerationW'),
    avgGenerationW: weightedAvg('avgGenerationW'),
    sampleCount: totalSamples,
  };
}

// Rolls up every calendar day that has fully elapsed and isn't in
// daily_summary yet. Must run after rollupCompletedHours() so the hours it
// sums from are up to date.
function rollupCompletedDays(now = Date.now()) {
  const earliest = getEarliestReadingTs();
  if (earliest == null) return;

  const maxDoneEnd = getMaxDailySummaryEnd();
  let cursor = maxDoneEnd != null ? new Date(maxDoneEnd) : startOfLocalDay(earliest);
  const todayStart = startOfLocalDay(now);

  while (cursor.getTime() < todayStart.getTime()) {
    const start = cursor;
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    const hours = getHourlySummaryRange(start.getTime(), end.getTime());
    upsertDailySummary(combineHourSummaries(dateStringFor(start), start.getTime(), end.getTime(), hours));
    cursor = end;
  }
}

function runRollup(now = Date.now()) {
  rollupCompletedHours(now);
  rollupCompletedDays(now);
}

function startRollup(intervalMs) {
  runRollup();
  return setInterval(() => runRollup(), intervalMs);
}

module.exports = { HOUR_MS, runRollup, rollupCompletedHours, rollupCompletedDays, startRollup };
