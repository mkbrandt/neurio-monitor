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

const netGenStmt = db.prepare(
  'SELECT ts, net_w, generation_w FROM readings WHERE ts >= ? AND ts < ? AND net_w IS NOT NULL'
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

function getNetPlusGeneration(startTs, endTsExclusive) {
  return netGenStmt.all(startTs, endTsExclusive);
}

module.exports = {
  insertReading,
  getLatestReading,
  getReadingsSince,
  getReadingsSinceAggregated,
  getReadingsInRange,
  getAggregate,
  getNetPlusGeneration,
};
