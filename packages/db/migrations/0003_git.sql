-- 0003_git: git connections and deployments. Forward-only.
--
-- A deployment is an immutable compiled snapshot (the bundle, stored content-
-- addressed in the artifact store); publish flips `is_current`, rollback
-- repoints it. `build_seq` is a per-site monotonic sequence allocated at
-- insert: the publish transaction only ever moves the pointer to a strictly
-- newer sequence, so a stale build that finishes late can never flip the
-- pointer backward.

-- One row per connected repository (v1: one). Credentials never live here:
-- the App key, webhook secret, or PAT stay in the environment.
-- `installation_id` is null for PAT connections.
CREATE TABLE app.git_connections (
  id              text PRIMARY KEY,
  site_id         text NOT NULL REFERENCES app.sites (id),
  provider        text NOT NULL DEFAULT 'github',
  installation_id text,
  repo            text NOT NULL,
  branch          text NOT NULL,
  last_synced_sha text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX git_connections_site_repo ON app.git_connections (site_id, repo);
CREATE UNIQUE INDEX git_connections_install_repo
  ON app.git_connections (installation_id, repo) WHERE installation_id IS NOT NULL;

-- Immutable once ready. `bundle_ref` points at the content-addressed artifact;
-- identical content dedupes to the same ref across rows.
CREATE TABLE app.deployments (
  id           text PRIMARY KEY,
  site_id      text NOT NULL REFERENCES app.sites (id),
  version_id   text NOT NULL DEFAULT 'current',
  kind         text NOT NULL DEFAULT 'production',
  git_ref      text,
  commit_sha   text NOT NULL,
  build_seq    integer NOT NULL,
  bundle_ref   text,
  bundle_hash  text,
  url          text,
  status       text NOT NULL DEFAULT 'building',
  is_current   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  expires_at   timestamptz
);

-- One current deployment per (site, version); two deploys can never both win.
CREATE UNIQUE INDEX deployments_current
  ON app.deployments (site_id, version_id) WHERE is_current;
CREATE UNIQUE INDEX deployments_seq ON app.deployments (site_id, build_seq);
CREATE INDEX deployments_history ON app.deployments (site_id, created_at);
