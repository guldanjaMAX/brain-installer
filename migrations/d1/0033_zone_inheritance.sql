-- 0033_zone_inheritance
--
-- Zone authorization is decided by sources.zone. Documents and chunks retain
-- their denormalized zone as a derived projection for diagnostics and any
-- future row-local filtering. Keep new rows aligned at the database boundary
-- so every ingest path, including a future one, inherits the registered
-- source's current zone without having to remember another application field.
--
-- Existing rows are intentionally not rewritten in this migration. A mature
-- brain can have millions of chunks, and Cloudflare D1 requires a rewrite of
-- that size to be resumed in bounded batches. The diagnostic reports legacy
-- projection drift until that separate repair completes. Current access stays
-- source-authoritative throughout, so a stale projection cannot widen access.

CREATE TRIGGER IF NOT EXISTS documents_zone_ai
AFTER INSERT ON documents
BEGIN
  UPDATE documents
     SET zone = (SELECT zone FROM sources WHERE name = NEW.source)
   WHERE doc_uid = NEW.doc_uid
     AND zone IS NOT (SELECT zone FROM sources WHERE name = NEW.source);
END;

-- `content_hash` changes on every accepted document revision. Include it here
-- so a changed old row heals opportunistically after its source receives a
-- zone. An unchanged reingest exits before this trigger, so the zone command's
-- bounded repair page is the convergence path for unchanged legacy rows. The
-- inner UPDATE touches only zone, so it cannot recurse into this trigger.
CREATE TRIGGER IF NOT EXISTS documents_zone_source_au
AFTER UPDATE OF source, content_hash ON documents
BEGIN
  UPDATE documents
     SET zone = (SELECT zone FROM sources WHERE name = NEW.source)
   WHERE doc_uid = NEW.doc_uid
     AND zone IS NOT (SELECT zone FROM sources WHERE name = NEW.source);
END;

-- The existing chunks_ai trigger maintains the external-content FTS table.
-- Replace it in this new migration so its statement order is explicit. The FTS
-- row must exist before the zone UPDATE fires chunks_au; reversing those steps
-- asks FTS to delete an entry it has not inserted yet.
DROP TRIGGER IF EXISTS chunks_ai;

CREATE TRIGGER chunks_ai
AFTER INSERT ON chunks
BEGIN
  INSERT INTO chunks_fts(rowid, text, title)
  VALUES (NEW.id, NEW.text, NEW.title);
  UPDATE chunks
     SET zone = (SELECT zone FROM sources WHERE name = NEW.source)
   WHERE chunk_uid = NEW.chunk_uid
     AND zone IS NOT (SELECT zone FROM sources WHERE name = NEW.source);
END;

CREATE TRIGGER IF NOT EXISTS chunks_zone_source_au
AFTER UPDATE OF source ON chunks
BEGIN
  UPDATE chunks
     SET zone = (SELECT zone FROM sources WHERE name = NEW.source)
   WHERE chunk_uid = NEW.chunk_uid
     AND zone IS NOT (SELECT zone FROM sources WHERE name = NEW.source);
END;
