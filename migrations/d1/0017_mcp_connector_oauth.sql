-- 0017_mcp_connector_oauth — remote connectors (Claude app, ChatGPT) sign in
-- with OAuth; the authorize step is the owner's passkey page.
--
-- Clients register themselves (RFC 7591 dynamic registration, public clients
-- only). Codes and tokens are stored HASHED and are live security state:
-- none of this is exported by recovery, and a recovered brain simply has its
-- connectors re-authorize. Tokens remember the session generation they were
-- born under, so "Sign out everywhere" revokes connectors too.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scope TEXT,
  session_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
