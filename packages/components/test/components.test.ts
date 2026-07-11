import type { ComponentRegistry } from "@readsmith/mdx";
import type { Element, ElementContent } from "hast";
import { h } from "hastscript";
import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/registry/index.js";

const registry: ComponentRegistry = createRegistry();

function txt(value: string): ElementContent {
  return { type: "text", value };
}

function classes(el: Element): string[] {
  return (el.properties?.className as string[]) ?? [];
}

function renderOf(
  name: string,
  props: Record<string, unknown>,
  children: ElementContent[],
): Element {
  const entry = registry[name];
  if (!entry?.render) throw new Error(`no component ${name}`);
  return entry.render({ name, props, children }) as Element;
}

describe("cards", () => {
  it("renders a card as a link when href is set, else a div", () => {
    const link = renderOf("Card", { title: "Guide", href: "/guide" }, [txt("go")]);
    expect(link.tagName).toBe("a");
    expect(link.properties?.href).toBe("/guide");
    expect(classes(renderOf("Card", {}, [txt("x")]))).toContain("rs-card");
    expect(renderOf("Card", {}, [txt("x")]).tagName).toBe("div");
  });

  it("lays out a card group with a column count", () => {
    const group = renderOf("CardGroup", { cols: "3" }, [renderOf("Card", {}, [])]);
    expect(group.properties?.dataCols).toBe("3");
  });

  it("unwraps paragraph-wrapped inline cards (authored with no blank lines)", () => {
    const a = renderOf("Card", { title: "A" }, [txt("x")]);
    const b = renderOf("Card", { title: "B" }, [txt("y")]);
    const wrapped = h("p", {}, [a, txt("\n"), b]);
    const group = renderOf("CardGroup", {}, [wrapped]);
    expect(group.children).toHaveLength(2);
    expect(classes(group.children[0] as Element)).toContain("rs-card");
    expect(classes(group.children[1] as Element)).toContain("rs-card");
  });
});

describe("steps", () => {
  it("renders an ordered list of step items", () => {
    const one = renderOf("Step", { title: "First" }, [txt("do a")]);
    const two = renderOf("Step", { title: "Second" }, [txt("do b")]);
    const el = renderOf("Steps", {}, [one, two]);
    expect(el.tagName).toBe("ol");
    expect(el.children).toHaveLength(2);
    expect(classes(el.children[0] as Element)).toContain("rs-step");
  });
});

describe("accordion", () => {
  it("uses native details/summary and honors open", () => {
    const el = renderOf("Accordion", { title: "More", open: true }, [txt("body")]);
    expect(el.tagName).toBe("details");
    expect(el.properties?.open).toBe(true);
    expect((el.children[0] as Element).tagName).toBe("summary");
  });
});

describe("frame", () => {
  it("wraps media with a caption and reserves aspect-ratio", () => {
    const el = renderOf("Frame", { caption: "A diagram", ratio: "16/9" }, [
      h("img", { src: "/x.png", alt: "x" }),
    ]);
    expect(el.tagName).toBe("figure");
    const media = el.children[0] as Element;
    expect(String(media.properties?.style)).toContain("aspect-ratio:16 / 9");
    expect((el.children[1] as Element).tagName).toBe("figcaption");
  });
});

describe("changelog update", () => {
  it("stamps a date and gives the title a deep-linkable id", () => {
    const el = renderOf("Update", { label: "2026-07-06", title: "Big Release" }, [txt("notes")]);
    const title = (el.children[1] as Element).children[0] as Element;
    expect(title.tagName).toBe("h3");
    expect(title.properties?.id).toBe("big-release");
  });
});

describe("inline", () => {
  it("renders kbd, badge, and an accessible tooltip", () => {
    expect(renderOf("Kbd", {}, [txt("Ctrl")]).tagName).toBe("kbd");
    expect(classes(renderOf("Badge", { variant: "new" }, [txt("Beta")]))).toContain(
      "rs-badge--new",
    );
    const tip = renderOf("Tooltip", { tip: "the assay office" }, [txt("term")]);
    expect(tip.properties?.ariaLabel).toBe("the assay office");
    expect(tip.properties?.tabIndex).toBe(0);
  });
});

describe("tabs", () => {
  it("builds an ARIA tablist with the first tab selected and the rest hidden", () => {
    const a = renderOf("Tab", { title: "Python" }, [txt("py")]);
    const b = renderOf("Tab", { title: "Node" }, [txt("js")]);
    const el = renderOf("Tabs", { group: "lang" }, [a, b]);

    expect(classes(el)).toContain("rs-tabs");
    expect(el.properties?.dataRsGroup).toBe("lang");

    const list = el.children[0] as Element;
    expect(list.properties?.role).toBe("tablist");
    const buttons = list.children as Element[];
    expect(buttons).toHaveLength(2);
    expect((buttons[0]?.children[0] as { value: string }).value).toBe("Python");
    expect(buttons[0]?.properties?.ariaSelected).toBe("true");
    expect(buttons[1]?.properties?.ariaSelected).toBe("false");

    const panels = (el.children[1] as Element).children as Element[];
    expect(panels[0]?.properties?.hidden).toBeUndefined();
    expect(panels[1]?.properties?.hidden).toBe(true);
    expect(registry.Tabs?.island).toBe(true);
  });
});

describe("code group", () => {
  it("labels each sample by its filename and hides all but the first", () => {
    const figure = (file: string, lang: string): Element =>
      h("figure", { className: ["rs-code"], "data-lang": lang }, [
        h("figcaption", { className: ["rs-code__bar"] }, [
          h("span", { className: ["rs-code__file"] }, [txt(file)]),
        ]),
        h("pre", { className: ["shiki"] }, [h("code", [txt("x")])]),
      ]);
    const el = renderOf("CodeGroup", {}, [figure("main.py", "python"), figure("main.js", "js")]);

    const tabs = (el.children[0] as Element).children as Element[];
    expect((tabs[0]?.children[0] as { value: string }).value).toBe("main.py");
    const panels = (el.children[1] as Element).children as Element[];
    expect(panels[1]?.properties?.hidden).toBe(true);
    expect(registry.CodeGroup?.island).toBe(true);
  });
});

describe("operation embeds", () => {
  const spec = {
    specId: "s",
    siteId: "default",
    version: 1,
    sourceHash: "h",
    info: { title: "Pets", version: "1" },
    servers: [{ url: "https://api.example.com/v1" }],
    securitySchemes: {},
    tags: [],
    operations: [
      {
        id: "listPets",
        method: "get" as const,
        path: "/pets",
        summary: "List pets",
        deprecated: false,
        tags: ["Pets"],
        parameters: [
          {
            name: "limit",
            in: "query" as const,
            required: false,
            schema: { type: ["integer" as const] },
          },
        ],
        responses: [{ status: "200", description: "OK" }],
      },
    ],
    schemas: {},
  };

  function embedOf(props: Record<string, unknown>, withSpec = true): Element {
    const reg = createRegistry(withSpec ? { apiSpec: spec } : {});
    const entry = reg.Operation;
    if (!entry?.render) throw new Error("no Operation component");
    return entry.render({ name: "Operation", props, children: [] }) as Element;
  }

  function html(el: Element): string {
    // Enough structure probing for assertions without a serializer.
    return JSON.stringify(el);
  }

  it("renders the bar, sections, and console for a resolved op", () => {
    const el = embedOf({ op: "GET /pets" });
    const s = html(el);
    expect(classes(el)).toContain("rs-op-embed");
    expect(s).toContain("rs-op__id");
    expect(s).toContain("rs-console");
    expect(s).toContain("query parameters");
  });

  it("degrades to a danger callout without a spec or on a miss", () => {
    expect(classes(embedOf({ op: "GET /pets" }, false))).toContain("rs-callout--danger");
    expect(classes(embedOf({ op: "DELETE /nope" }))).toContain("rs-callout--danger");
    expect(classes(embedOf({}))).toContain("rs-callout--danger");
  });
});
