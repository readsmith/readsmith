import type { Diagnostic } from "@readsmith/model";
import { describe, expect, it } from "vitest";
import { makeResolveAsset, makeResolveOutsidePage } from "../src/assemble.js";
import { parse } from "../src/parse.js";
import { transform } from "../src/transform.js";

/**
 * Item 6 (FR-4). Relative image URLs used to pass through untouched and resolve
 * against the page URL, which is not where the asset lives. Relative `.md` links
 * that escaped the content root died as warnings, even when they pointed at a
 * real repository file.
 */

const MOUNTS = [{ from: "../media", to: "media" }];

/** Transform one page and hand back its rewritten urls plus diagnostics. */
function run(
  path: string,
  source: string,
  opts: {
    assets?: { from: string; to: string }[];
    repo?: string;
    contentRel?: string;
    basePath?: string;
  } = {},
) {
  const parsed = parse({ path, raw: source });
  const diagnostics: Diagnostic[] = [];
  const result = transform(parsed.body, {
    path,
    basePath: opts.basePath,
    resolvePage: (target) => (target === "policy" ? "policy" : null),
    resolveAsset: makeResolveAsset(opts.assets ?? []),
    resolveOutsidePage: makeResolveOutsidePage(
      opts.repo ? { repo: opts.repo, branch: "main" } : undefined,
      opts.contentRel ?? ".",
    ),
  });
  diagnostics.push(...result.diagnostics);

  const images: string[] = [];
  const links: string[] = [];
  const walk = (node: { type: string; url?: string; children?: unknown[] }): void => {
    if (node.type === "image" && node.url) images.push(node.url);
    if (node.type === "link" && node.url) links.push(node.url);
    for (const child of (node.children ?? []) as (typeof node)[]) walk(child);
  };
  walk(result.body as unknown as { type: string; children?: unknown[] });
  return { images, links, diagnostics };
}

describe("resolveImages", () => {
  // AC-6.1
  it("AC-6.1: a co-located image resolves to its public URL", () => {
    const { images, diagnostics } = run("guide/setup.md", "![x](./img/a.gif)");
    expect(images).toEqual(["/guide/img/a.gif"]);
    expect(diagnostics).toEqual([]);
  });

  it("resolves an image beside the page without a ./ prefix", () => {
    const { images } = run("guide/setup.md", "![x](a.png)");
    expect(images).toEqual(["/guide/a.png"]);
  });

  // AC-6.2: an image kept beside the code, not beside the prose.
  it("AC-6.2: an out-of-root image resolves through its declared mount", () => {
    const { images, diagnostics } = run("cli.md", "![shot](../media/screenshot.gif)", {
      assets: MOUNTS,
    });
    expect(images).toEqual(["/media/screenshot.gif"]);
    expect(diagnostics).toEqual([]);
  });

  it("resolves a nested path inside a mount", () => {
    const { images } = run("cli.md", "![x](../media/nested/b.gif)", { assets: MOUNTS });
    expect(images).toEqual(["/media/nested/b.gif"]);
  });

  // AC-6.3
  it("AC-6.3: an absolute URL is left untouched", () => {
    const badge = "https://img.shields.io/badge/license-Apache%202.0-blue";
    const { images, diagnostics } = run("index.md", `![License](${badge})`);
    expect(images).toEqual([badge]);
    expect(diagnostics).toEqual([]);
  });

  it("leaves a root-absolute path untouched", () => {
    const { images } = run("index.md", "![logo](/logo.svg)");
    expect(images).toEqual(["/logo.svg"]);
  });

  it("warns, and does not guess, when an out-of-root image has no mount", () => {
    const { images, diagnostics } = run("cli.md", "![shot](../media/screenshot.gif)"); // no mounts
    expect(images).toEqual(["../media/screenshot.gif"]); // untouched
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("broken-asset");
    expect(diagnostics[0]?.severity).toBe("warning");
  });
});

describe("base path on root-relative links and images (subpath hosting)", () => {
  it("prefixes a root-relative internal link with the base path", () => {
    const { links } = run("index.md", "[Guide](/guide) and [anchored](/guide#top)", {
      basePath: "/docs",
    });
    expect(links).toEqual(["/docs/guide", "/docs/guide#top"]);
  });

  it("prefixes a root-relative image with the base path", () => {
    const { images } = run("index.md", "![logo](/logo.svg)", { basePath: "/docs" });
    expect(images).toEqual(["/docs/logo.svg"]);
  });

  it("also prefixes a resolved relative link (unchanged behavior)", () => {
    const { links } = run("index.md", "[Policy](policy)", { basePath: "/docs" });
    expect(links).toEqual(["/docs/policy"]);
  });

  it("does not double-prefix a link already under the base path", () => {
    const { links } = run("index.md", "[Guide](/docs/guide)", { basePath: "/docs" });
    expect(links).toEqual(["/docs/guide"]);
  });

  it("leaves protocol-relative and external URLs untouched", () => {
    const { links } = run("index.md", "[cdn](//cdn.example/x) and [ext](https://a.dev)", {
      basePath: "/docs",
    });
    expect(links).toEqual(["//cdn.example/x", "https://a.dev"]);
  });

  it("is a no-op at the root (no base path)", () => {
    const { links, images } = run("index.md", "[Guide](/guide) ![logo](/logo.svg)");
    expect(links).toEqual(["/guide"]);
    expect(images).toEqual(["/logo.svg"]);
  });
});

describe("resolveLinks: links that leave the docs", () => {
  const REPO = "https://github.com/acme/widget";

  it("still resolves a link to a real page", () => {
    const { links, diagnostics } = run("cli.md", "[policy](policy.md)", { repo: REPO });
    expect(links).toEqual(["/policy"]);
    expect(diagnostics).toEqual([]);
  });

  // AC-6.4
  it("AC-6.4: an out-of-root .md link becomes a repo blob URL, with no warning", () => {
    const { links, diagnostics } = run("cli.md", "[sec](../SECURITY.md)", {
      repo: REPO,
      contentRel: "docs",
    });
    expect(links).toEqual([`${REPO}/blob/main/SECURITY.md`]);
    expect(diagnostics).toEqual([]);
  });

  it("preserves the anchor on a rewritten repo link", () => {
    const { links } = run("cli.md", "[sec](../SECURITY.md#reporting)", {
      repo: REPO,
      contentRel: "docs",
    });
    expect(links).toEqual([`${REPO}/blob/main/SECURITY.md#reporting`]);
  });

  it("uses the configured branch", () => {
    const outside = makeResolveOutsidePage({ repo: REPO, branch: "trunk" }, "docs");
    expect(outside?.("../SECURITY.md")).toBe(`${REPO}/blob/trunk/SECURITY.md`);
  });

  // AC-6.5
  it("AC-6.5: without links.repo, behavior is unchanged: warn and leave the href", () => {
    const { links, diagnostics } = run("cli.md", "[sec](../SECURITY.md)", { contentRel: "docs" });
    expect(links).toEqual(["../SECURITY.md"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("broken-link");
  });

  // AC-6.6: a typo inside the docs must stay loud. Pointing it at the repository
  // would bury a genuine broken link.
  it("AC-6.6: an unresolved link inside the content root still warns", () => {
    const { links, diagnostics } = run("cli.md", "[gone](./missing.md)", {
      repo: REPO,
      contentRel: "docs",
    });
    expect(links).toEqual(["./missing.md"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("broken-link");
  });

  it("does not rewrite a link that escapes the repository itself", () => {
    // Content root IS the repo root, so `../x.md` is outside the checkout.
    const outside = makeResolveOutsidePage({ repo: REPO, branch: "main" }, ".");
    expect(outside?.("../x.md")).toBeNull();
  });
});

/**
 * A home page promoted from above the content root (`content.home: ../README.md`)
 * writes its links relative to the repository root, not to `docs/`. Both must land
 * on the same pages and the same assets.
 */
describe("a home page above the content root", () => {
  const REPO = "https://github.com/acme/widget";
  const home = (source: string) => {
    const parsed = parse({ path: "../README.md", raw: source });
    const result = transform(parsed.body, {
      path: "../README.md",
      contentRel: "docs",
      resolvePage: (t) => (t === "cli" ? "cli" : null),
      resolveAsset: makeResolveAsset(MOUNTS),
      resolveOutsidePage: makeResolveOutsidePage({ repo: REPO, branch: "main" }, "docs"),
    });
    const urls: string[] = [];
    const walk = (n: { type: string; url?: string; children?: unknown[] }): void => {
      if (n.url) urls.push(n.url);
      for (const c of (n.children ?? []) as (typeof n)[]) walk(c);
    };
    walk(result.body as unknown as { type: string; children?: unknown[] });
    return { urls, diagnostics: result.diagnostics };
  };

  it("resolves a link down into the content root", () => {
    const { urls, diagnostics } = home("[cli](docs/cli.md)");
    expect(urls).toEqual(["/cli"]); // the same page a sibling reaches via cli.md
    expect(diagnostics).toEqual([]);
  });

  it("resolves an image that sits beside the content root", () => {
    const { urls, diagnostics } = home("![shot](media/screenshot.gif)");
    expect(urls).toEqual(["/media/screenshot.gif"]);
    expect(diagnostics).toEqual([]);
  });

  it("sends a repository file that is not a docs page to the forge", () => {
    const { urls, diagnostics } = home("[sec](SECURITY.md)");
    expect(urls).toEqual([`${REPO}/blob/main/SECURITY.md`]);
    expect(diagnostics).toEqual([]);
  });

  it("canonicalization is a no-op for a page inside the content root", () => {
    const parsed = parse({ path: "guide/setup.md", raw: "[usage](usage.md)" });
    const result = transform(parsed.body, {
      path: "guide/setup.md",
      contentRel: "docs",
      resolvePage: (t) => (t === "guide/usage" ? "guide/usage" : null),
      resolveAsset: makeResolveAsset([]),
    });
    const para = result.body.children[0] as { children: { url?: string }[] };
    expect(para.children[0]?.url).toBe("/guide/usage");
    expect(result.diagnostics).toEqual([]);
  });
});

describe("makeResolveAsset", () => {
  it("prefers a declared mount over the co-located rule", () => {
    const resolve = makeResolveAsset([{ from: "images", to: "static/img" }]);
    expect(resolve("images/a.png")).toBe("/static/img/a.png");
  });

  it("maps the mount root itself", () => {
    expect(makeResolveAsset(MOUNTS)("../media")).toBe("/media");
  });

  it("refuses to publish an undeclared out-of-root path", () => {
    expect(makeResolveAsset([])("../secrets/key.png")).toBeNull();
  });
});
