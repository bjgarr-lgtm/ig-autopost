CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  ig_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  access_token TEXT NOT NULL,
  token_expires_at TEXT,
  connected_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  media_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY,
  caption TEXT NOT NULL DEFAULT '',
  media_asset_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (media_asset_id) REFERENCES media_assets(id)
);

CREATE TABLE IF NOT EXISTS scheduled_post_accounts (
  id TEXT PRIMARY KEY,
  scheduled_post_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  published_media_id TEXT,
  published_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (scheduled_post_id) REFERENCES scheduled_posts(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS publish_logs (
  id TEXT PRIMARY KEY,
  scheduled_post_id TEXT,
  account_id TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due
  ON scheduled_posts (status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_scheduled_post_accounts_post
  ON scheduled_post_accounts (scheduled_post_id);

CREATE INDEX IF NOT EXISTS idx_publish_logs_created
  ON publish_logs (created_at DESC);
