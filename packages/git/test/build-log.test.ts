import type { Diagnostic } from "@readsmith/model";
import type { BundleStore } from "@readsmith/storage";
import { describe, expect, it, vi } from "vitest";
import { buildLogText, deploymentLogKey, writeBuildLog } from "../src/site-build.js";

describe("deploymentLogKey", () => {
  it("is site-scoped and per-deployment", () => {
    expect(deploymentLogKey("acme", "dep:acme:3")).toBe("sites/acme/logs/dep:acme:3.txt");
  });
});

describe("buildLogText", () => {
  it("renders a failed build with diagnostics in fixed order (AC-D1)", () => {
    const diagnostics: Diagnostic[] = [
      { severity: "error", code: "build-failed", message: "boom", source: "acme/docs" },
      {
        severity: "warning",
        code: "broken-link",
        message: "no such page",
        source: "guides/intro.mdx",
        pos: { line: 12, col: 3 },
      },
    ];
    const text = buildLogText({
      deploymentId: "dep:acme:2",
      repo: "acme/docs",
      ref: "refs/heads/main",
      commitSha: "abc123",
      status: "failed",
      pageCount: 10,
      rendered: 4,
      wallMs: 1980,
      diagnostics,
    });
    expect(text).toBe(
      [
        "Readsmith build log",
        "deployment: dep:acme:2",
        "repo: acme/docs",
        "ref: refs/heads/main",
        "commit: abc123",
        "status: failed",
        "pages: 10 (rendered 4, cached 6)",
        "duration: 1980ms",
        "",
        "diagnostics (2):",
        "[error] build-failed: boom (acme/docs)",
        "[warning] broken-link: no such page (guides/intro.mdx:12:3)",
        "",
      ].join("\n"),
    );
  });

  it("renders a clean published build as 'diagnostics: none'", () => {
    const text = buildLogText({
      deploymentId: "dep:acme:1",
      repo: "acme/docs",
      ref: "refs/heads/main",
      commitSha: "def456",
      status: "published",
      pageCount: 42,
      rendered: 42,
      wallMs: 3000,
      diagnostics: [],
    });
    expect(text).toContain("status: published");
    expect(text).toContain("pages: 42 (rendered 42, cached 0)");
    expect(text.trimEnd().endsWith("diagnostics: none")).toBe(true);
  });
});

/** A store whose put always rejects, to prove the log write is best-effort. */
function throwingStore(): BundleStore {
  return {
    put: () => Promise.reject(new Error("disk full")),
    get: () => Promise.resolve(null),
    has: () => Promise.resolve(false),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  } as unknown as BundleStore;
}

describe("writeBuildLog (best-effort, AC-D4)", () => {
  it("swallows a store error, warns, and never throws", async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
    await expect(
      writeBuildLog(throwingStore(), "acme", "dep:acme:9", "log body", logger as never),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("build log write failed");
  });

  it("does not throw when no logger is provided", async () => {
    await expect(
      writeBuildLog(throwingStore(), "acme", "dep:acme:9", "log body"),
    ).resolves.toBeUndefined();
  });

  it("writes to the deployment log key on success", async () => {
    const put = vi.fn(() => Promise.resolve());
    const store = { put } as unknown as BundleStore;
    await writeBuildLog(store, "acme", "dep:acme:1", "hello");
    expect(put).toHaveBeenCalledWith("sites/acme/logs/dep:acme:1.txt", "hello");
  });
});
