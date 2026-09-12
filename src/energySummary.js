// Read-side counterpart to rollup.js: answers "how much energy in
// [startTs, endTsExclusive)" by summing pre-integrated daily/hourly summary
// rows wherever they're available, and only falling back to integrating raw
// samples for the sliver of the range that summaries can't cover yet - the
// still-in-progress day or hour, plus any not-yet-rolled-up gap right after
// startup. This keeps month/billing/year views and N-day totals independent
// of how many raw samples have piled up.

const { getReadingsInRange, getDailySummaryRange, getHourlySummaryRange } = require('./db');
const { integrateKwh, integrateSolarSplit } = require('./energy');

const HOUR_MS = 60 * 60 * 1000;

const EMPTY = { consumptionKwh: 0, generationKwh: 0, usedFromSolarKwh: 0, exportedKwh: 0, importedKwh: 0 };

function add(a, b) {
  return {
    consumptionKwh: a.consumptionKwh + b.consumptionKwh,
    generationKwh: a.generationKwh + b.generationKwh,
    usedFromSolarKwh: a.usedFromSolarKwh + b.usedFromSolarKwh,
    exportedKwh: a.exportedKwh + b.exportedKwh,
    importedKwh: a.importedKwh + b.importedKwh,
  };
}

function fromRawRows(rows) {
  const split = integrateSolarSplit(rows);
  return {
    consumptionKwh: integrateKwh(rows, 'consumption_w'),
    generationKwh: integrateKwh(rows, 'generation_w'),
    usedFromSolarKwh: split.usedFromSolarKwh,
    exportedKwh: split.exportedKwh,
    importedKwh: split.importedKwh,
  };
}

function startOfDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function nextDayStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

// Energy in [startTs, endTsExclusive), using daily_summary for every
// complete calendar day and raw integration only for today's sliver (or any
// past day rollup hasn't reached yet).
function energyForRange(startTs, endTsExclusive) {
  const todayStart = startOfDay(Date.now());
  const summaryEnd = Math.min(endTsExclusive, todayStart);
  let result = { ...EMPTY };

  if (startTs < summaryEnd) {
    const days = getDailySummaryRange(startTs, summaryEnd);
    const covered = new Set(days.map((d) => d.startTs));
    for (const d of days) result = add(result, d);

    let cursor = startTs;
    while (cursor < summaryEnd) {
      const dayStart = startOfDay(cursor);
      const dayEnd = Math.min(nextDayStart(dayStart), summaryEnd);
      if (!covered.has(dayStart)) {
        result = add(result, fromRawRows(getReadingsInRange(Math.max(cursor, dayStart), dayEnd)));
      }
      cursor = dayEnd;
    }
  }

  if (endTsExclusive > summaryEnd) {
    const rawStart = Math.max(startTs, summaryEnd);
    result = add(result, fromRawRows(getReadingsInRange(rawStart, endTsExclusive)));
  }

  return result;
}

// Same idea as energyForRange but at hour granularity, for the single-day
// "hour" view - complete hours come from hourly_summary, only the current
// hour (or an un-rolled-up gap) is integrated from raw.
function energyForHourRange(startTs, endTsExclusive) {
  const currentHourStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const summaryEnd = Math.min(endTsExclusive, currentHourStart);
  let result = { ...EMPTY };

  if (startTs < summaryEnd) {
    const hours = getHourlySummaryRange(startTs, summaryEnd);
    const covered = new Set(hours.map((h) => h.hourStart));
    for (const h of hours) result = add(result, h);

    let cursor = startTs;
    while (cursor < summaryEnd) {
      const hourStart = Math.floor(cursor / HOUR_MS) * HOUR_MS;
      const hourEnd = Math.min(hourStart + HOUR_MS, summaryEnd);
      if (!covered.has(hourStart)) {
        result = add(result, fromRawRows(getReadingsInRange(Math.max(cursor, hourStart), hourEnd)));
      }
      cursor = hourEnd;
    }
  }

  if (endTsExclusive > summaryEnd) {
    const rawStart = Math.max(startTs, summaryEnd);
    result = add(result, fromRawRows(getReadingsInRange(rawStart, endTsExclusive)));
  }

  return result;
}

module.exports = { energyForRange, energyForHourRange };
