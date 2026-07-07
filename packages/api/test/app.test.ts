import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/app.js";
import type { ApiDatabase } from "../src/deps.js";

const okDb: ApiDatabase = { query: async () => [] };
const failDb: ApiDatabase = {
  query: async () => {
    throw new Error("unreachable");
  },
};

describe("createApiApp: health", () => {
  it("reports the database disabled when none is injected", async () => {
    const res = await createApiApp({ db: null }).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "disabled" });
  });

  it("reports up when the database answers", async () => {
    const res = await createApiApp({ db: okDb }).request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "up" });
  });

  it("reports degraded (503) when the database errors", async () => {
    const res = await createApiApp({ db: failDb }).request("/api/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", database: "down" });
  });
});
