const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'monitor.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    consumption_w REAL,
    generation_w REAL,
    net_w REAL,
    raw_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (ts);

  -- Pre-integrated per-hour/per-day energy totals, populated by src/rollup.js.
  -- Long-range charts (month/billing/year views, N-day summaries) read these
  -- instead of re-integrating potentially millions of raw samples on every
  -- request; only the still-in-progress hour/day is ever computed from raw.
  CREATE TABLE IF NOT EXISTS hourly_summary (
    hour_start INTEGER PRIMARY KEY,
    consumption_kwh REAL,
    generation_kwh REAL,
    used_from_solar_kwh REAL,
    exported_kwh REAL,
    imported_kwh REAL,
    min_consumption_w REAL,
    max_consumption_w REAL,
    avg_consumption_w REAL,
    min_generation_w REAL,
    max_generation_w REAL,
    avg_generation_w REAL,
    sample_count INTEGER
  );

  CREATE TABLE IF NOT EXISTS daily_summary (
    date TEXT PRIMARY KEY,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    consumption_kwh REAL,
    generation_kwh REAL,
    used_from_solar_kwh REAL,
    exported_kwh REAL,
    imported_kwh REAL,
    min_consumption_w REAL,
    max_consumption_w REAL,
    avg_consumption_w REAL,
    min_generation_w REAL,
    max_generation_w REAL,
    avg_generation_w REAL,
    sample_count INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_daily_summary_start_ts ON daily_summary (start_ts);
`);

// Prepared once at module load and reused - repeatedly calling db.prepare()
// for the same query (e.g. in a loop) creates a fresh native statement each
// time, and letting many of those get garbage-collected has been observed to
// crash the process (better-sqlite3 native assertion during cleanup).
const insertStmt = db.prepare(
  'INSERT INTO readings (ts, consumption_w, generation_w, net_w, raw_json) VALUES (?, ?, ?, ?, ?)'
);

const latestStmt = db.prepare('SELECT * FROM readings ORDER BY ts DESC LIMIT 1');

const sinceStmt = db.prepare(
  'SELECT ts, consumption_w, generation_w, net_w FROM readings WHERE ts >= ? ORDER BY ts ASC'
);

const rangeStmt = db.prepare(
  'SELECT ts, consumption_w, generation_w, net_w FROM readings WHERE ts >= ? AND ts < ? ORDER BY ts ASC'
);

// Groups raw readings into fixed-width time buckets and averages each column,
// so charts over long ranges (6h/24h/7d) don't have to draw one point per
// 1s raw sample.
// better-sqlite3 binds plain JS numbers as SQLite REAL, and ts / REAL is a
// floating-point division (SQLite promotes to REAL if either side is REAL) -
// so bucketMs is explicitly cast back to INTEGER to force integer division,
// otherwise every row lands in its own near-unique bucket and nothing groups.
const sinceAggregatedStmt = db.prepare(`
  SELECT
    (CAST(ts AS INTEGER) / CAST(@bucketMs AS INTEGER)) * CAST(@bucketMs AS INTEGER) AS ts,
    AVG(consumption_w) AS consumption_w,
    AVG(generation_w) AS generation_w,
    AVG(net_w) AS net_w
  FROM readings
  WHERE ts >= @since
  GROUP BY CAST(ts AS INTEGER) / CAST(@bucketMs AS INTEGER)
  ORDER BY ts ASC
`);

const aggregateStmt = db.prepare(
  `SELECT
    MIN(consumption_w) AS minConsumption, MAX(consumption_w) AS maxConsumption, AVG(consumption_w) AS avgConsumption,
    MIN(generation_w) AS minGeneration, MAX(generation_w) AS maxGeneration, AVG(generation_w) AS avgGeneration,
    COUNT(*) AS count
  FROM readings WHERE ts >= ? AND ts < ?`
);

// A robust low-end estimate of (grid + solar) - i.e. total house consumption
// - over a window: bucket samples into one-minute windows and take the max
// within each, then use the smallest of those per-minute maxima as the
// household's standby/"always on" floor. A single noisy sample (a brief
// negative/near-zero sensor artifact) simply gets outshone by its own
// minute's real peak, so it can never influence the result - unlike a
// statistic computed directly on raw samples. Minutes with too few samples
// (a polling gap) are discarded entirely via the HAVING clause. Done as one
// aggregate query - rather than pulling every raw sample in the window back
// into JS to group by hand - so a day-long window doesn't mean marshaling
// ~86,400 row objects across the native binding on every call.
const alwaysOnFloorStmt = db.prepare(`
  SELECT MIN(minute_max) AS alwaysOnW FROM (
    SELECT MAX(net_w + COALESCE(generation_w, 0)) AS minute_max, COUNT(*) AS cnt
    FROM readings
    WHERE ts >= ? AND ts < ? AND net_w IS NOT NULL
    GROUP BY CAST(ts AS INTEGER) / 60000
    HAVING cnt >= ?
  )
`);

const earliestReadingStmt = db.prepare('SELECT MIN(ts) AS minTs FROM readings');

const upsertHourlySummaryStmt = db.prepare(`
  INSERT OR REPLACE INTO hourly_summary (
    hour_start, consumption_kwh, generation_kwh, used_from_solar_kwh, exported_kwh, imported_kwh,
    min_consumption_w, max_consumption_w, avg_consumption_w,
    min_generation_w, max_generation_w, avg_generation_w, sample_count
  ) VALUES (
    @hourStart, @consumptionKwh, @generationKwh, @usedFromSolarKwh, @exportedKwh, @importedKwh,
    @minConsumptionW, @maxConsumptionW, @avgConsumptionW,
    @minGenerationW, @maxGenerationW, @avgGenerationW, @sampleCount
  )
`);

const upsertDailySummaryStmt = db.prepare(`
  INSERT OR REPLACE INTO daily_summary (
    date, start_ts, end_ts, consumption_kwh, generation_kwh, used_from_solar_kwh, exported_kwh, imported_kwh,
    min_consumption_w, max_consumption_w, avg_consumption_w,
    min_generation_w, max_generation_w, avg_generation_w, sample_count
  ) VALUES (
    @date, @startTs, @endTs, @consumptionKwh, @generationKwh, @usedFromSolarKwh, @exportedKwh, @importedKwh,
    @minConsumptionW, @maxConsumptionW, @avgConsumptionW,
    @minGenerationW, @maxGenerationW, @avgGenerationW, @sampleCount
  )
`);

const hourlySummaryRangeStmt = db.prepare(`
  SELECT
    hour_start AS hourStart, consumption_kwh AS consumptionKwh, generation_kwh AS generationKwh,
    used_from_solar_kwh AS usedFromSolarKwh, exported_kwh AS exportedKwh, imported_kwh AS importedKwh,
    min_consumption_w AS minConsumptionW, max_consumption_w AS maxConsumptionW, avg_consumption_w AS avgConsumptionW,
    min_generation_w AS minGenerationW, max_generation_w AS maxGenerationW, avg_generation_w AS avgGenerationW,
    sample_count AS sampleCount
  FROM hourly_summary WHERE hour_start >= ? AND hour_start < ? ORDER BY hour_start ASC
`);

const dailySummaryRangeStmt = db.prepare(`
  SELECT
    date, start_ts AS startTs, end_ts AS endTs, consumption_kwh AS consumptionKwh, generation_kwh AS generationKwh,
    used_from_solar_kwh AS usedFromSolarKwh, exported_kwh AS exportedKwh, imported_kwh AS importedKwh,
    min_consumption_w AS minConsumptionW, max_consumption_w AS maxConsumptionW, avg_consumption_w AS avgConsumptionW,
    min_generation_w AS minGenerationW, max_generation_w AS maxGenerationW, avg_generation_w AS avgGenerationW,
    sample_count AS sampleCount
  FROM daily_summary WHERE start_ts >= ? AND start_ts < ? ORDER BY start_ts ASC
`);

const maxHourlySummaryStartStmt = db.prepare('SELECT MAX(hour_start) AS maxHourStart FROM hourly_summary');
const maxDailySummaryEndStmt = db.prepare('SELECT MAX(end_ts) AS maxEndTs FROM daily_summary');

const hourCoverageStmt = db.prepare(
  'SELECT COUNT(*) AS c FROM hourly_summary WHERE hour_start >= ? AND hour_start < ? AND sample_count > 0'
);

function insertReading({ ts, consumption, generation, net, raw }) {
  insertStmt.run(ts, consumption, generation, net, JSON.stringify(raw));
}

function getLatestReading() {
  return latestStmt.get();
}

function getReadingsSince(sinceTs) {
  return sinceStmt.all(sinceTs);
}

function getReadingsSinceAggregated(sinceTs, bucketMs) {
  if (!bucketMs || bucketMs <= 1) return getReadingsSince(sinceTs);
  return sinceAggregatedStmt.all({ since: sinceTs, bucketMs: Math.round(bucketMs) });
}

function getReadingsInRange(startTs, endTsExclusive) {
  return rangeStmt.all(startTs, endTsExclusive);
}

function getAggregate(startTs, endTsExclusive) {
  return aggregateStmt.get(startTs, endTsExclusive);
}

function getAlwaysOnFloor(startTs, endTsExclusive, minSamplesPerMinute) {
  return alwaysOnFloorStmt.get(startTs, endTsExclusive, minSamplesPerMinute).alwaysOnW;
}

function getEarliestReadingTs() {
  return earliestReadingStmt.get().minTs;
}

function upsertHourlySummary(row) {
  upsertHourlySummaryStmt.run(row);
}

function upsertDailySummary(row) {
  upsertDailySummaryStmt.run(row);
}

function getHourlySummaryRange(startTs, endTsExclusive) {
  return hourlySummaryRangeStmt.all(startTs, endTsExclusive);
}

function getDailySummaryRange(startTs, endTsExclusive) {
  return dailySummaryRangeStmt.all(startTs, endTsExclusive);
}

// Exclusive end of the most recently rolled-up hour, or null if none yet.
function getMaxHourlySummaryStart() {
  return maxHourlySummaryStartStmt.get().maxHourStart;
}

// Exclusive end of the most recently rolled-up day, or null if none yet.
function getMaxDailySummaryEnd() {
  return maxDailySummaryEndStmt.get().maxEndTs;
}

// Number of hours in [startTs, endTsExclusive) for which the sensor actually
// reported at least one sample - used to detect partial days (data
// collection just started, or the sensor was offline for part of the day).
function getHourCoverageCount(startTs, endTsExclusive) {
  return hourCoverageStmt.get(startTs, endTsExclusive).c;
}

module.exports = {
  insertReading,
  getLatestReading,
  getReadingsSince,
  getReadingsSinceAggregated,
  getReadingsInRange,
  getAggregate,
  getAlwaysOnFloor,
  getEarliestReadingTs,
  upsertHourlySummary,
  upsertDailySummary,
  getHourlySummaryRange,
  getDailySummaryRange,
  getMaxHourlySummaryStart,
  getMaxDailySummaryEnd,
  getHourCoverageCount,
};
