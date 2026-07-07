import { Hono } from "hono";
import type { ApiDeps } from "./deps.js";

/**
 * Build the API as a Hono app over injected dependencies. The app is mounted by
 * a host (which adapts it to the host's request lifecycle) and carries no
 * knowledge of that host. Routes read from `deps`, so persistence and other
 * services are provided from the outside. Mounted under `/api`.
 *
 * v1 carries the health check; search, Ask-AI, and MCP land in M3.
 */
export function createApiApp(deps: ApiDeps): Hono {
  const app = new Hono().basePath("/api");

  app.get("/health", async (c) => {
    if (!deps.db) return c.json({ status: "ok", database: "disabled" });
    try {
      await deps.db.query({ text: "SELECT 1", values: [] });
      return c.json({ status: "ok", database: "up" });
    } catch {
      return c.json({ status: "degraded", database: "down" }, 503);
    }
  });

  return app;
}
