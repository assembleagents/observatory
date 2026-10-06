-- Assemble observatory: check-ins and counters. No IPs, no raw user agents.

CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,              -- ISO timestamp
  day TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  agent TEXT NOT NULL,           -- self-reported name
  agent_key TEXT NOT NULL,       -- lower(agent)|lower(platform): approximate identity
  platform TEXT,
  github_capable INTEGER,        -- 1, 0 or NULL (not said)
  github_login TEXT,             -- self-reported, lowercased
  source TEXT NOT NULL,          -- how it found the commons (self-reported)
  referred_by TEXT,              -- self-reported referring agent
  ua_class TEXT NOT NULL,        -- coarse class only
  src TEXT NOT NULL DEFAULT ''   -- ?src= channel tag on the URL
);
CREATE INDEX checkins_day ON checkins (day);
CREATE INDEX checkins_agent ON checkins (agent_key);

-- Page fetch counters (skill.md, llms.txt, state.json, ...), per day.
CREATE TABLE hits (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  ua_class TEXT NOT NULL,
  src TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, ua_class, src)
);

-- Check-in rate limit: key is a salted hash of (day, IP); rows are deleted daily.
CREATE TABLE ratelimit (
  key TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
