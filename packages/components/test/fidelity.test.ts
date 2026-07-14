// @vitest-environment happy-dom
import type { Element } from "hast";
import { beforeEach, describe, expect, it } from "vitest";
import { initBanners } from "../src/islands/banner.js";
import { createLucideResolver } from "../src/lucide/resolve.js";
import { createRegistry } from "../src/registry/index.js";

const ROCKET_SVG = `<!-- @license lucide-static v1 - ISC -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 4h1" /></svg>`;

const resolver = createLucideResolver((n) => (n === "rocket" ? ROCKET_SVG : undefined));
const registry = createRegistry({ resolveIcon: resolver });

function txt(value: string): Element["children"][number] {
  return { type: "text", value };
}
function classes(el: Element): string[] {
  return (el.properties?.className as string[]) ?? [];
}
function render(name: string, props: Record<string, unknown>, children: Element["children"] = []) {
  const entry = registry[name];
  if (!entry?.render) throw new Error(`no component ${name}`);
  return entry.render({ name, props, children }) as Element;
}

describe("Badge", () => {
  it("is a neutral pill with no variant, tinted for a known variant, neutral for an unknown one", () => {
    expect(classes(render("Badge", {}, [txt("v1")]))).toEqual(["rs-badge"]);
    expect(classes(render("Badge", { variant: "warning" }, [txt("x")]))).toContain(
      "rs-badge--warning",
    );
    expect(classes(render("Badge", { variant: "totally-made-up" }, [txt("x")]))).toEqual([
      "rs-badge",
    ]);
  });

  it("accepts `color` as an alias for the variant", () => {
    expect(classes(render("Badge", { color: "danger" }, [txt("x")]))).toContain("rs-badge--danger");
  });

  it("prepends a resolved icon before the label and composes the Icon keystone", () => {
    const el = render("Badge", { icon: "rocket" }, [txt("Beta")]);
    const first = el.children[0] as Element;
    expect(first.tagName).toBe("svg");
    expect(classes(first)).toContain("rs-badge__icon");
    // the label text still follows the icon
    expect(el.children[1]).toEqual(txt("Beta"));
  });

  it("degrades an unknown icon to the missing glyph, never throwing", () => {
    const el = render("Badge", { icon: "nope" }, [txt("x")]);
    expect(classes(el.children[0] as Element)).toContain("rs-icon--missing");
  });
});

describe("Expandable", () => {
  it("renders a native <details> with a summary title and a body, closed by default", () => {
    const el = render("Expandable", { title: "properties" }, [txt("nested")]);
    expect(el.tagName).toBe("details");
    expect(el.properties?.open).toBeUndefined();
    const summary = el.children[0] as Element;
    expect(summary.tagName).toBe("summary");
    const title = summary.children.find(
      (c) => c.type === "element" && classes(c).includes("rs-expandable__title"),
    ) as Element;
    expect(title.children[0]).toEqual(txt("properties"));
  });

  it("opens when defaultOpen is set (bare or true), stays closed for false", () => {
    expect(render("Expandable", { defaultOpen: true }).properties?.open).toBe(true);
    expect(render("Expandable", { defaultOpen: "true" }).properties?.open).toBe(true);
    expect(render("Expandable", { open: true }).properties?.open).toBe(true);
    expect(render("Expandable", { defaultOpen: false }).properties?.open).toBeUndefined();
  });

  it("is deterministic: same input yields identical hast", () => {
    expect(render("Expandable", { title: "x" }, [txt("y")])).toEqual(
      render("Expandable", { title: "x" }, [txt("y")]),
    );
  });
});

describe("Banner", () => {
  it("renders a static aside with the content and no dismiss control by default", () => {
    const el = render("Banner", {}, [txt("We shipped v2.")]);
    expect(el.tagName).toBe("aside");
    expect(classes(el)).toEqual(["rs-banner"]);
    expect(el.properties?.dataDismissible).toBeUndefined();
    const hasButton = el.children.some((c) => c.type === "element" && c.tagName === "button");
    expect(hasButton).toBe(false);
  });

  it("applies a known variant tint and a leading icon", () => {
    const el = render("Banner", { variant: "warning", icon: "rocket" }, [txt("x")]);
    expect(classes(el)).toContain("rs-banner--warning");
    expect((el.children[0] as Element).tagName).toBe("svg");
    expect(classes(el.children[0] as Element)).toContain("rs-banner__icon");
  });

  it("carries a dismiss button and a stable content-derived key when dismissible", () => {
    const a = render("Banner", { dismissible: true }, [txt("Migrate by July.")]);
    expect(a.properties?.dataDismissible).toBe("true");
    const key = a.properties?.dataBannerKey as string;
    expect(key).toBeTruthy();
    const button = a.children.find(
      (c) => c.type === "element" && c.tagName === "button",
    ) as Element;
    expect(button.properties?.ariaLabel).toBe("Dismiss");

    // same content -> same key; different content -> different key (deterministic)
    const same = render("Banner", { dismissible: true }, [txt("Migrate by July.")]);
    expect(same.properties?.dataBannerKey).toBe(key);
    const other = render("Banner", { dismissible: true }, [txt("A new notice.")]);
    expect(other.properties?.dataBannerKey).not.toBe(key);
  });
});

describe("initBanners", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    try {
      localStorage.clear();
    } catch {
      // ignore
    }
  });

  function mount(key = "abc"): HTMLElement {
    document.body.innerHTML = `<aside class="rs-banner" data-dismissible="true" data-banner-key="${key}"><div class="rs-banner__content">Notice</div><button class="rs-banner__dismiss" aria-label="Dismiss"></button></aside>`;
    return document.querySelector<HTMLElement>(".rs-banner") as HTMLElement;
  }

  it("hides the banner and persists the key when the dismiss button is clicked", () => {
    const el = mount("k1");
    initBanners();
    expect(el.hidden).toBe(false);
    el.querySelector<HTMLButtonElement>(".rs-banner__dismiss")?.click();
    expect(el.hidden).toBe(true);
    expect(localStorage.getItem("rs-banner-dismissed:k1")).toBe("1");
  });

  it("starts hidden on load when its key was already dismissed", () => {
    localStorage.setItem("rs-banner-dismissed:k2", "1");
    const el = mount("k2");
    initBanners();
    expect(el.hidden).toBe(true);
  });

  it("is idempotent and ignores non-dismissible banners", () => {
    const el = mount("k3");
    initBanners();
    initBanners(); // second pass must not re-wire
    document.body.insertAdjacentHTML("beforeend", '<aside class="rs-banner">plain</aside>');
    initBanners();
    const plain = document.body.querySelectorAll(".rs-banner")[1] as HTMLElement;
    expect(plain.hidden).toBe(false);
    expect(el.dataset.rsBannerInit).toBe("true");
  });
});
