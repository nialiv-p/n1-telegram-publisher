CREATE TABLE IF NOT EXISTS articles (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  publication_date TEXT NOT NULL,
  section TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('seeded', 'pending', 'sending', 'sent', 'retry', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  telegram_message_id INTEGER,
  last_error TEXT,
  next_attempt_at TEXT,
  discovered_at TEXT NOT NULL,
  sent_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_articles_ready
  ON articles(status, next_attempt_at, publication_date);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
