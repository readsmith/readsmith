-- 0004_analytics: the reader-signal tables (search gaps + page feedback).
-- Forward-only. Query text and paths only: no reader identity, no headers,
-- matching the ai_queries posture. ai_queries (0002) already logs Ask-AI;
-- these complete the trio.

CREATE TABLE app.search_queries (
  id            text PRIMARY KEY,
  site_id       text NOT NULL REFERENCES app.sites (id),
  query         text NOT NULL,
  results_count integer NOT NULL,
  zero_result   boolean NOT NULL,
  version_id    text NOT NULL DEFAULT 'current',
  locale        text NOT NULL DEFAULT 'en',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX search_queries_site_time ON app.search_queries (site_id, created_at);
CREATE INDEX search_queries_gaps ON app.search_queries (site_id, zero_result);

CREATE TABLE app.page_feedback (
  id         text PRIMARY KEY,
  site_id    text NOT NULL REFERENCES app.sites (id),
  path       text NOT NULL,
  helpful    boolean NOT NULL,
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX page_feedback_site_time ON app.page_feedback (site_id, created_at);
CREATE INDEX page_feedback_site_path ON app.page_feedback (site_id, path);
