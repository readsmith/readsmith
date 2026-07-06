import { h } from "hastscript";
import { describe, expect, it } from "vitest";
import { parse } from "../src/parse.js";
import {
  type ComponentRegistry,
  type RenderCache,
  type RenderContext,
  type RenderResult,
  render,
} from "../src/render.js";

/** A small stand-in component library (the real one is a separate spec). */
const registry: ComponentRegistry = {
  Callout: {
    render: ({ props, children }) =>
      h("aside", { className: ["callout", `callout-${props.type ?? "note"}`] }, children),
  },
  Tabs: {
    island: true,
    render: ({ children }) => h("div", { className: ["tabs"] }, children),
  },
  Boom: {
    render: () => {
      throw new Error("kaboom");
    },
  },
  Widget: { island: true },
};

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return { path: "page.mdx", trust: "owner", registry, ...overrides };
}

function bodyOf(raw: string, kind: "md" | "mdx" = "mdx") {
  return parse({ path: `page.${kind}`, raw }).body;
}

// P6 AC-1 (FR-2, FR-3): a page using components renders correct static HTML.
describe("component binding", () => {
  it("binds a static component and renders its children", async () => {
    const r = await render(bodyOf('<Callout type="warning">Careful now.</Callout>\n'), ctx());
    expect(r.html).toContain("callout-warning");
    expect(r.html).toContain("Careful now.");
    expect(r.diagnostics).toEqual([]);
  });

  it("lets an author use an allowed raw HTML element", async () => {
    const r = await render(bodyOf('<div className="box">hi</div>\n'), ctx());
    expect(r.html).toContain("<div");
    expect(r.html).toContain("hi");
  });
});

// P6 AC-2 (FR-5): an unknown component yields a diagnostic and a fallback, page still renders.
describe("unknown component", () => {
  it("emits a diagnostic and a placeholder without blanking the page", async () => {
    const r = await render(bodyOf("# Title\n\n<Sparkle />\n\nAfter.\n"), ctx());
    expect(r.diagnostics.some((d) => d.code === "unknown-component")).toBe(true);
    expect(r.html).toContain("rs-render-error");
    expect(r.html).toContain("Title");
    expect(r.html).toContain("After.");
  });

  it("can drop unknown components through to their children", async () => {
    const r = await render(
      bodyOf("<Sparkle>kept</Sparkle>\n"),
      ctx({ unknownComponent: "passthrough" }),
    );
    expect(r.html).toContain("kept");
    expect(r.html).not.toContain("rs-render-error");
  });
});

// P6 AC-3 (FR-4): interactive components produce a manifest; prose ships zero JS.
describe("islands / partial hydration", () => {
  it("emits a mount and a manifest entry for an interactive component", async () => {
    const r = await render(bodyOf("<Tabs>tab body</Tabs>\n"), ctx());
    expect(r.html).toContain('data-island="Tabs"');
    expect(r.html).toContain("tab body");
    expect(r.hydration.islands).toHaveLength(1);
    expect(r.hydration.islands[0]?.component).toBe("Tabs");
  });

  it("ships no islands for a pure-prose page", async () => {
    const r = await render(bodyOf("# Just prose\n\nNothing interactive here.\n"), ctx());
    expect(r.hydration.islands).toEqual([]);
  });
});

// P6 AC-4 (FR-6): {expr} resolves against scope; ambient globals do not.
describe("expression scope", () => {
  it("resolves a scope value in prose", async () => {
    const r = await render(bodyOf("Hello {name}.\n"), ctx({ scope: { name: "Ada" } }));
    expect(r.html).toContain("Hello Ada.");
  });

  it("fails closed for process/window/fetch with a diagnostic", async () => {
    const r = await render(bodyOf("{process} {window} {fetch}\n"), ctx({ scope: {} }));
    expect(r.diagnostics.filter((d) => d.code === "unresolved-expression")).toHaveLength(3);
    expect(r.html).not.toContain("process");
  });

  it("cannot reach inherited prototype members", async () => {
    const r = await render(bodyOf("{constructor}\n"), ctx({ scope: {} }));
    expect(r.diagnostics.some((d) => d.code === "unresolved-expression")).toBe(true);
  });
});

// P6 AC-5 (FR-8): an unchanged page (same cacheKey) is not re-rendered.
describe("caching", () => {
  it("returns the cached result and skips re-render on a hit", async () => {
    let calls = 0;
    const counting: ComponentRegistry = {
      Counter: {
        render: () => {
          calls++;
          return h("span", "x");
        },
      },
    };
    const store = new Map<string, RenderResult>();
    const cache: RenderCache = {
      get: (k) => store.get(k),
      set: (k, v) => {
        store.set(k, v);
      },
    };
    const body = bodyOf("<Counter />\n");
    await render(body, ctx({ registry: counting, cacheKey: "k1", cache }));
    await render(body, ctx({ registry: counting, cacheKey: "k1", cache }));
    expect(calls).toBe(1);
  });
});

// P6 AC-6 (IS-3): a top-level import is never executed.
describe("imports", () => {
  it("does not execute an import and reports it", async () => {
    const r = await render(bodyOf('import fs from "node:fs"\n\nBody.\n'), ctx());
    expect(r.diagnostics.some((d) => d.code === "import-ignored")).toBe(true);
    expect(r.html).toContain("Body.");
    expect(r.html).not.toContain("import");
  });
});

// P6 AC-9 / AC-10 (IS-5, IS-7): trust-tiered sanitization of raw HTML.
describe("trust-tiered sanitization", () => {
  it("strips script and event handlers for a contributor", async () => {
    const raw = '<script>alert(1)</script>\n\n<div onclick="steal()">hi</div>\n';
    const r = await render(bodyOf(raw, "md"), ctx({ trust: "contributor" }));
    expect(r.html).not.toContain("<script>");
    expect(r.html.toLowerCase()).not.toContain("onclick");
    expect(r.html).toContain("hi");
    expect(r.diagnostics.some((d) => d.code === "sanitized-html")).toBe(true);
  });

  it("passes owner raw HTML through untouched", async () => {
    const raw = '<div class="custom">owner html</div>\n';
    const r = await render(bodyOf(raw, "md"), ctx({ trust: "owner" }));
    expect(r.html).toContain("owner html");
    expect(r.html).toContain("custom");
  });
});

// P6 AC-11 (IS-8): serialized island props carry no non-serializable/server-only data.
describe("hydration prop safety", () => {
  it("drops non-serializable props from the client payload", async () => {
    const scope = { onLoad: () => "secret-closure", label: "Save" };
    const r = await render(bodyOf("<Widget onLoad={onLoad} label={label} />\n"), ctx({ scope }));
    const props = r.hydration.islands[0]?.props ?? {};
    expect(props.label).toBe("Save");
    expect("onLoad" in props).toBe(false);
  });
});

// P6 AC-12 (IS-10): a throwing component is contained; the rest of the page renders.
describe("per-component isolation", () => {
  it("catches a component error and still renders the page", async () => {
    const r = await render(bodyOf("Before.\n\n<Boom />\n\nAfter.\n"), ctx());
    expect(r.diagnostics.some((d) => d.code === "component-render-error")).toBe(true);
    expect(r.html).toContain("rs-render-error");
    expect(r.html).toContain("Before.");
    expect(r.html).toContain("After.");
  });
});

// P6 AC-13 (NFR-1): same input renders byte-identical HTML.
describe("determinism", () => {
  it("renders identical HTML for identical input", async () => {
    const src = "# Title\n\n<Callout>text</Callout>\n\n```js\nconst x = 1;\n```\n";
    const a = await render(bodyOf(src), ctx());
    const b = await render(bodyOf(src), ctx());
    expect(a.html).toBe(b.html);
    expect(a.cacheable).toBe(true);
  });

  it("highlights code blocks inside the rendered HTML", async () => {
    const r = await render(bodyOf("```js\nconst x = 1;\n```\n"), ctx());
    expect(r.html).toContain("shiki");
  });
});

// P6 + component-library code-block chrome (figure wrapper, title bar from meta).
describe("code block chrome", () => {
  it("wraps code in a figure and shows a title bar from the fence meta", async () => {
    const r = await render(bodyOf('```ts title="build.ts"\nconst x = 1;\n```\n'), ctx());
    expect(r.html).toContain('class="rs-code"');
    expect(r.html).toContain("rs-code__bar");
    expect(r.html).toContain("build.ts");
    expect(r.html).toContain('data-lang="ts"');
    expect(r.html).toContain("shiki");
  });

  it("wraps a plain code block in a figure with no title bar", async () => {
    const r = await render(bodyOf("```js\nconst x = 1;\n```\n"), ctx());
    expect(r.html).toContain('class="rs-code"');
    expect(r.html).not.toContain("rs-code__bar");
  });
});
