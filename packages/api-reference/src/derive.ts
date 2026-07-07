import type { Operation } from "@readsmith/model";

/**
 * Derived artifacts computed from a normalized operation. The searchable text an
 * endpoint is indexed by lives here (ingest persists it). The HAR request seed
 * and code-sample generation are a rendering concern and live in the components
 * package, so this package stays free of anything a renderer pulls in.
 */

/** The searchable text for an endpoint (feeds api_endpoints.search_text, later embeddings). */
export function endpointSearchText(op: Operation): string {
  const parts = [op.method.toUpperCase(), op.path];
  if (op.summary) parts.push(op.summary);
  if (op.description) parts.push(op.description);
  parts.push(...op.tags);
  return parts.join(" ").trim();
}
