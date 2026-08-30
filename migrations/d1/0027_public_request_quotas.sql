-- 0027_public_request_quotas

CREATE TABLE IF NOT EXISTS public_request_quotas (
  key_hash          TEXT NOT NULL,
  route_class       TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count     INTEGER NOT NULL DEFAULT 1,
  expires_at        INTEGER NOT NULL,
  PRIMARY KEY (key_hash, route_class, window_started_at),
  CHECK (length(key_hash) = 64),
  CHECK (route_class GLOB '[a-z0-9_]*' AND route_class NOT GLOB '*[^a-z0-9_]*'),
  CHECK (request_count >= 1)
);

CREATE INDEX IF NOT EXISTS idx_public_request_quotas_expiry
  ON public_request_quotas (expires_at);
