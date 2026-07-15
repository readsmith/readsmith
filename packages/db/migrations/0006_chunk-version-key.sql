-- Multi-version search: a chunk id is derived from a page's slug/anchor, so the
-- same id repeats across versions (v1 and v2 both have "guide"). The chunk row
-- must therefore key on the version and locale too, or one version's upsert
-- would clobber another's row. Move the primary key off `id` alone onto
-- (site_id, version_id, locale, id). No inbound foreign key references
-- doc_chunks.id, and existing 'current'/'en' rows already satisfy the new key,
-- so this is safe in place.
ALTER TABLE app.doc_chunks
  DROP CONSTRAINT doc_chunks_pkey,
  ADD PRIMARY KEY (site_id, version_id, locale, id);
