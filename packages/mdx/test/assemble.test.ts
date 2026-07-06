import { h } from "hastscript";
import { describe, expect, it } from "vitest";
import {
  type AssembleInput,
  type NavNode,
  type SiteConfig,
  assembleSite,
} from "../src/assemble.js";
import type { ComponentRegistry, RenderCache, RenderResult } from "../src/render.js";

const registry: ComponentRegistry = {
  Callout: { render: ({ children }) => h("aside", { className: ["callout"] }, children) },
};

function makeCache(): RenderCache {
  const store = new Map<string, RenderResult>();
  return {
    get: (k) => store.get(k),
    set: (k, v) => {
      store.set(k, v);
    },
  };
}

interface Fixture {
  config: SiteConfig;
  files: Record<string, string>;
  snippets?: Record<string, string>;
}

/** A small multi-page fixture site with a group, a hidden page, and links. */
function fixture(): Fixture {
  const pages = [
    { path: "index.md", slug: "" },
    { path: "guide/setup.md", slug: "guide/setup" },
    { path: "guide/usage.md", slug: "guide/usage" },
    { path: "secret.md", slug: "secret" },
  ];
  const nav: NavNode[] = [
    { type: "page", slug: "" },
    {
      type: "group",
      label: "Guide",
      children: [
        { type: "page", slug: "guide/setup" },
        { type: "page", slug: "guide/usage" },
      ],
    },
    { type: "page", slug: "secret" },
  ];
  const config: SiteConfig = {
    site: { name: "Docs", description: "The docs." },
    variables: { product: "Readsmith" },
    pages,
    nav,
  };
  const files: Record<string, string> = {
    "index.md": "---\ntitle: Home\n---\n\n# Home\n\nWelcome to {{product}}.\n",
    "guide/setup.md":
      "---\ntitle: Setup\ndescription: Get started.\n---\n\n# Setup\n\n## Install\n\nSee [usage](usage.md#run).\n",
    "guide/usage.md": "---\ntitle: Usage\n---\n\n# Usage\n\n## Run\n\nRun it.\n",
    "secret.md": "---\ntitle: Secret\nhidden: true\n---\n\n# Secret\n\nHidden.\n",
  };
  return { config, files };
}

function inputOf(f: Fixture, extra: Partial<AssembleInput> = {}): AssembleInput {
  return {
    config: f.config,
    readPage: (p) => {
      const src = f.files[p];
      if (src === undefined) throw new Error(`no file ${p}`);
      return src;
    },
    registry,
    snippets: f.snippets,
    ...extra,
  };
}

// P7 AC-1 (FR-1,3,5,6,7): a fixture repo builds to a correct SiteBuild.
describe("assembleSite", () => {
  it("builds pages, nav, sitemap, and agent outputs", async () => {
    const build = await assembleSite(inputOf(fixture()));
    expect(build.pages).toHaveLength(4);
    const home = build.pages.find((p) => p.slug === "");
    expect(home?.title).toBe("Home");
    expect(home?.html).toContain("Welcome to Readsmith."); // {{var}} interpolated
    expect(build.sitemap).toContain("<loc>/guide/setup</loc>");
    expect(build.llmsTxt).toContain("# Docs");
    expect(build.llmsTxt).toContain("[Setup](/guide/setup)");
    expect(build.llmsFullTxt).toContain("# Usage");
    expect(build.skillMd).toContain("name: Docs");
    expect(build.searchChunks.length).toBeGreaterThan(0);
  });
});

// P7 AC-2 (FR-3, AG-7, AG-8): nav prev/next + breadcrumbs; hidden pages excluded.
describe("nav finalization", () => {
  it("computes prev/next and breadcrumbs and drops hidden pages", async () => {
    const build = await assembleSite(inputOf(fixture()));
    const setup = build.pages.find((p) => p.slug === "guide/setup");
    expect(setup?.next?.slug).toBe("guide/usage");
    expect(setup?.prev?.slug).toBe("");
    expect(setup?.breadcrumbs.map((b) => b.label)).toEqual(["Guide", "Setup"]);

    // The hidden page is excluded from nav and from the sitemap.
    const navSlugs = flattenNavSlugs(build.nav);
    expect(navSlugs).not.toContain("secret");
    expect(build.sitemap).not.toContain("/secret");
  });
});

// P7 AC-3 (FR-4, AG-2): broken link + anchor reported; a valid one is not.
describe("top-level tabs", () => {
  it("finalizes each tab and scopes prev/next within its own tab", async () => {
    const f = fixture();
    f.config.tabs = [
      {
        label: "Guide",
        nav: [
          { type: "page", slug: "guide/setup" },
          { type: "page", slug: "guide/usage" },
        ],
      },
      { label: "Home", nav: [{ type: "page", slug: "" }] },
    ];
    const build = await assembleSite(inputOf(f));

    expect(build.tabs?.map((t) => t.label)).toEqual(["Guide", "Home"]);
    // A tab's landing URL is its first page.
    expect(build.tabs?.[0]?.url).toBe("/guide/setup");
    expect(build.tabs?.[1]?.url).toBe("/");

    // prev/next stay inside the tab: the last Guide page has no next, and the
    // lone Home page has neither, even though other pages exist site-wide.
    const usage = build.pages.find((p) => p.slug === "guide/usage");
    expect(usage?.prev?.slug).toBe("guide/setup");
    expect(usage?.next).toBeUndefined();
    const home = build.pages.find((p) => p.slug === "");
    expect(home?.prev).toBeUndefined();
    expect(home?.next).toBeUndefined();
  });

  it("leaves build.tabs undefined when no tabs are configured", async () => {
    const build = await assembleSite(inputOf(fixture()));
    expect(build.tabs).toBeUndefined();
  });
});

describe("cross-page link validation", () => {
  it("reports a broken page link and a broken anchor, not a valid link", async () => {
    const f = fixture();
    f.files["guide/setup.md"] =
      "# Setup\n\n[ok](usage.md#run)\n\n[bad page](/nope)\n\n[bad anchor](/guide/usage#missing)\n";
    const build = await assembleSite(inputOf(f));
    const setup = build.pages.find((p) => p.slug === "guide/setup");
    const codes = setup?.diagnostics.map((d) => d.code) ?? [];
    expect(codes).toContain("broken-link");
    expect(codes).toContain("broken-anchor");
    // The valid link to usage#run is not flagged.
    const brokenForRun = setup?.diagnostics.filter((d) => d.message.includes("#run")) ?? [];
    expect(brokenForRun).toHaveLength(0);
  });
});

// P7 AC-4 / AC-5 (FR-2, AG-1): dependency-aware incremental rebuild.
describe("incremental / dependency-aware caching", () => {
  it("re-renders every page that uses a changed snippet, and only those", async () => {
    const f = fixture();
    f.snippets = { "note.md": "Shared note about {{product}}." };
    f.files["guide/setup.md"] = '# Setup\n\n<Snippet file="note.md" />\n';
    f.files["guide/usage.md"] = '# Usage\n\n<Snippet file="note.md" />\n';
    // index.md and secret.md do not use the snippet.
    const cache = makeCache();

    const first = await assembleSite(inputOf(f, { renderCache: cache }));
    expect(first.rebuilt.sort()).toEqual(
      ["guide/setup.md", "guide/usage.md", "index.md", "secret.md"].sort(),
    );

    // Change the shared snippet; both dependents must re-render, nothing else.
    f.snippets["note.md"] = "Shared note, revised.";
    const second = await assembleSite(inputOf(f, { renderCache: cache }));
    expect(second.rebuilt.sort()).toEqual(["guide/setup.md", "guide/usage.md"]);
  });

  it("re-renders only the edited page when its prose changes", async () => {
    const f = fixture();
    const cache = makeCache();
    await assembleSite(inputOf(f, { renderCache: cache }));

    f.files["guide/usage.md"] = "---\ntitle: Usage\n---\n\n# Usage\n\n## Run\n\nEdited prose.\n";
    const second = await assembleSite(inputOf(f, { renderCache: cache }));
    expect(second.rebuilt).toEqual(["guide/usage.md"]);
  });
});

// P7 AC-6 (FR-7, FR-8): agent outputs from the same content; chunks handed off.
describe("agent readiness and search handoff", () => {
  it("derives llms.txt, llms-full.txt, skill.md, and chunks from the pages", async () => {
    const build = await assembleSite(inputOf(fixture()));
    // Hidden page excluded from every projection.
    expect(build.llmsTxt).not.toContain("Secret");
    expect(build.llmsFullTxt).not.toContain("Hidden.");
    expect(build.skillMd).not.toContain("Secret");
    expect(build.searchChunks.every((c) => c.page_id !== "secret.md")).toBe(true);
  });

  it("uses absolute URLs across sitemap and agent outputs when a base URL is set", () => {
    return assembleSite(inputOf(fixture(), { baseUrl: "https://docs.example.com/" })).then(
      (build) => {
        expect(build.sitemap).toContain("<loc>https://docs.example.com/guide/setup</loc>");
        expect(build.llmsTxt).toContain("(https://docs.example.com/guide/setup)");
        expect(build.llmsFullTxt).toContain("URL: https://docs.example.com/guide/setup");
        expect(build.rss).toContain("xmlns:atom");
      },
    );
  });
});

// P7 AC-7 (FR-6, AG-9): RSS reflects dated entries newest-first.
describe("rss", () => {
  it("orders changelog entries by date, newest first", async () => {
    const f = fixture();
    f.config.pages.push(
      { path: "news/old.md", slug: "news/old" },
      { path: "news/new.md", slug: "news/new" },
    );
    f.config.nav.push({ type: "page", slug: "news/old" }, { type: "page", slug: "news/new" });
    f.files["news/old.md"] = "---\ntitle: Old\ndate: 2024-01-01\n---\n\n# Old\n";
    f.files["news/new.md"] = "---\ntitle: New\ndate: 2025-06-01\n---\n\n# New\n";
    const build = await assembleSite(inputOf(f));
    expect(build.rss.indexOf("New")).toBeLessThan(build.rss.indexOf("Old"));
    expect(build.rss).toContain("2025-06-01");
  });
});

// P7 AC-8 (FR-1, AG-4): a failing page does not break the build, unless failOnError.
describe("partial failure policy", () => {
  it("isolates a page read failure and still builds the site", async () => {
    const f = fixture();
    const input = inputOf(f);
    input.readPage = (p) => {
      if (p === "guide/usage.md") throw new Error("disk gone");
      const src = f.files[p];
      if (src === undefined) throw new Error(`no file ${p}`);
      return src;
    };
    const build = await assembleSite(input);
    expect(build.pages).toHaveLength(4);
    expect(build.diagnostics.some((d) => d.code === "page-build-error")).toBe(true);
    expect(build.ok).toBe(true);

    const strict = await assembleSite({ ...input, failOnError: true });
    expect(strict.ok).toBe(false);
  });
});

// P7 AC-9 (AG-3): identical inputs produce an identical bundle hash.
describe("deterministic bundle", () => {
  it("produces the same bundle hash across runs", async () => {
    const a = await assembleSite(inputOf(fixture()));
    const b = await assembleSite(inputOf(fixture()));
    expect(a.bundleHash).toBe(b.bundleHash);
  });

  it("changes the bundle hash when content changes", async () => {
    const a = await assembleSite(inputOf(fixture()));
    const f = fixture();
    f.files["index.md"] = "---\ntitle: Home\n---\n\n# Home\n\nDifferent.\n";
    const b = await assembleSite(inputOf(f));
    expect(a.bundleHash).not.toBe(b.bundleHash);
  });
});

function flattenNavSlugs(nav: import("../src/assemble.js").FinalNavNode[]): string[] {
  const out: string[] = [];
  for (const node of nav) {
    if (node.type === "page") out.push(node.slug);
    else out.push(...flattenNavSlugs(node.children));
  }
  return out;
}
