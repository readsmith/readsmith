/**
 * The dependency contract the API is constructed with. Routes talk to these
 * ports, never to a concrete driver, so the same routes run under any host that
 * can satisfy them (a Node server, an edge runtime). Each host wires its own
 * implementations. This is the seam that keeps the API runtime-agnostic.
 */

/**
 * The minimal query surface the API needs. Deliberately narrower than any one
 * driver: a Node Postgres client satisfies it structurally, and so can an
 * edge-compatible client, without the API depending on either.
 */
export interface ApiDatabase {
  query<T = Record<string, unknown>>(q: {
    text: string;
    values: readonly unknown[];
  }): Promise<T[]>;
}

/** Everything a host injects when constructing the API. Grows with M3 (search, AI, jobs). */
export interface ApiDeps {
  /** The database, or null when the host runs without persistence (docs-only). */
  db: ApiDatabase | null;
}
