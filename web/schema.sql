-- Muse Bridge Web — D1 schema
-- Jalankan sekali saat setup (Worker juga menjalankan CREATE TABLE IF NOT EXISTS
-- secara otomatis pada request pertama, jadi langkah ini opsional).

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'unclaimed', -- claimed | unclaimed
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bridge_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', -- open | claimed | done
  created_by TEXT NOT NULL,
  claimed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bridge_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES bridge_tasks(id),
  from_agent TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON bridge_tasks(status);
CREATE INDEX IF NOT EXISTS idx_messages_task ON bridge_messages(task_id, id);
