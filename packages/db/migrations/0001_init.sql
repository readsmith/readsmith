-- 0001_init: extensions, sites, and the API-reference persistence tables.
-- Forward-only. pgvector is enabled now (M4 stores no vectors) so search/embeddings
-- land in a later migration with no image or infra change. FTS is native Postgres.

CREATE EXTENSION IF NOT EXISTS vector;

-- Single-tenant self-host has exactly one site; the row and FK exist for
-- forward-compatibility with the multi-tenant hosted phase.
CREATE TABLE app.sites (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app.sites (id, name) VALUES ('default', 'Readsmith')
ON CONFLICT (id) DO NOTHING;

-- One row per ingested OpenAPI spec version. Large JSON (raw/bundled/normalized)
-- lives in the storage abstraction; rows hold references, not the payloads.
CREATE TABLE app.api_specs (
  id             text PRIMARY KEY,
  site_id        text NOT NULL REFERENCES app.sites (id),
  source_path    text NOT NULL,
  content_hash   text NOT NULL,
  version        integer NOT NULL,
  raw_ref        text,
  bundled_ref    text,
  normalized_ref text,
  info           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: re-ingesting identical bytes for the same spec path is a no-op.
CREATE UNIQUE INDEX api_specs_idempotency
  ON app.api_specs (site_id, source_path, content_hash);

-- One row per operation, denormalized for list/filter and (M3) search. The
-- generated tsvector wires the FTS half now; the vector column arrives later.
CREATE TABLE app.api_endpoints (
  id           text PRIMARY KEY,
  spec_id      text NOT NULL REFERENCES app.api_specs (id) ON DELETE CASCADE,
  site_id      text NOT NULL REFERENCES app.sites (id),
  operation_id text,
  method       text NOT NULL,
  path         text NOT NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  summary      text,
  deprecated   boolean NOT NULL DEFAULT false,
  search_text  text,
  search_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(search_text, ''))) STORED,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_endpoints_spec ON app.api_endpoints (spec_id);
CREATE INDEX api_endpoints_search_tsv ON app.api_endpoints USING GIN (search_tsv);
CREATE INDEX api_endpoints_site_tags ON app.api_endpoints USING GIN (tags);
