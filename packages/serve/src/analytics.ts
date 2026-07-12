import { randomUUID } from "node:crypto";
import type { AnalyticsService } from "@readsmith/api";
import { insertPageFeedback, insertSearchQuery } from "@readsmith/db";
import { getDb } from "./db.js";

/**
 * Server-only reader-signal persistence: page feedback for the API route, and
 * fire-and-forget search logging for the search service. Everything degrades
 * to a no-op without a database, and a logging failure is swallowed - signals
 * are diagnostics, never load-bearing.
 */
export function getAnalyticsService(siteId = "default"): AnalyticsService | null {
  const db = getDb();
  if (!db) return null;
  return {
    async pageFeedback(input) {
      await insertPageFeedback(db, {
        id: randomUUID(),
        siteId,
        path: input.path,
        helpful: input.helpful,
      });
    },
  };
}

/** Log an answered search; never awaited on the response path, never throws. */
export function logSearchQuery(input: {
  siteId?: string;
  query: string;
  resultsCount: number;
  version?: string;
  locale?: string;
}): void {
  const db = getDb();
  if (!db) return;
  insertSearchQuery(db, {
    id: randomUUID(),
    siteId: input.siteId ?? "default",
    query: input.query,
    resultsCount: input.resultsCount,
    versionId: input.version,
    locale: input.locale,
  }).catch(() => {});
}
