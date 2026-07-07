-- 0002_ai: the M3 search/AI substrate. Forward-only. pgvector was enabled in
-- 0001, so no image/infra change is needed here. Embeddings are half-precision
-- (halfvec) and a fixed 1024 dimensions: the model is configurable but its output
-- is normalized to 1024, so switching models is a re-embed, never a migration.

-- One row per retrievable chunk: docs AND API operations, unified so a single
-- HNSW index, a single FTS index, and a single retrieval path serve both. The
-- metadata columns ARE the citation (path + anchor + header_path reconstruct a
-- deep link and breadcrumb). `embedding` is null when no embedding provider is
-- configured (FTS-only degradation rung); such rows are simply absent from the
-- vector index.
CREATE TABLE app.doc_chunks (
  id           text PRIMARY KEY,
  site_id      text NOT NULL REFERENCES app.sites (id),
  kind         text NOT NULL DEFAULT 'doc',
  endpoint_id  text REFERENCES app.api_endpoints (id) ON DELETE CASCADE,
  page_id      text,
  path         text NOT NULL,
  header_path  text[] NOT NULL DEFAULT '{}',
  anchor       text,
  method       text,
  version_id   text NOT NULL DEFAULT 'current',
  locale       text NOT NULL DEFAULT 'en',
  content_hash text NOT NULL,
  text         text NOT NULL,
  search_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED,
  embedding    halfvec(1024),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Vector arm (cosine); FTS arm (GIN); the hard filter (site/version/locale/kind)
-- kept cheap; the incremental-diff basis (site + content_hash).
CREATE INDEX doc_chunks_hnsw ON app.doc_chunks USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX doc_chunks_search_tsv ON app.doc_chunks USING GIN (search_tsv);
CREATE INDEX doc_chunks_filter ON app.doc_chunks (site_id, version_id, locale, kind);
CREATE INDEX doc_chunks_content_hash ON app.doc_chunks (site_id, content_hash);

-- Ask-AI query log: search-gap analytics, eval, and "what readers ask" at once.
-- No key, no headers, no reader identity: only the query text and derived
-- analytics. Retention is enforced by a purge job (default 90 days); the
-- operator is the data controller.
CREATE TABLE app.ai_queries (
  id                  text PRIMARY KEY,
  site_id             text NOT NULL REFERENCES app.sites (id),
  query               text NOT NULL,
  filters             jsonb NOT NULL DEFAULT '{}'::jsonb,
  retrieved_chunk_ids text[] NOT NULL DEFAULT '{}',
  answer              text,
  cited_ids           text[] NOT NULL DEFAULT '{}',
  model               jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms          integer,
  feedback            smallint,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_queries_site_created ON app.ai_queries (site_id, created_at);
