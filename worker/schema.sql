CREATE TABLE IF NOT EXISTS visits (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT    NOT NULL,
  ip        TEXT    NOT NULL,
  country   TEXT,
  region    TEXT,
  city      TEXT,
  referrer  TEXT,
  is_bot    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
CREATE INDEX IF NOT EXISTS idx_visits_country ON visits(country);
CREATE INDEX IF NOT EXISTS idx_visits_referrer ON visits(referrer);
