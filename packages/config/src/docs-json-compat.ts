import type { Diagnostic } from "@readsmith/model";
import type { NavItemInput, NavTabInput, TabMenuItemInput } from "./schema.js";

/*
 * Compatibility for the `docs.json` config shape. A `docs.json` export differs
 * from our native config in two structural ways: it keeps site fields
 * (name/logo/favicon) at the top level rather than under `site`, and it models
 * `navigation` as an object of divisions (tabs/groups/pages/products/dropdowns/
 * anchors) rather than an array. Either would fail our `safeParse`, so this runs
 * between parse and validation and translates the `docs.json` shape into our
 * `ConfigInput`. It auto-detects the shape per transform, so a native config (a
 * `site` object + an array `navigation`) passes through untouched. Unsupported
 * divisions are dropped with a warning rather than silently, so an import is
 * honest about what it lost.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A `docs.json` icon: a string name, or an object `{ name, library, style }`. */
function iconName(v: unknown): string {
  if (typeof v === "string") return v;
  if (isObj(v) && typeof v.name === "string") return v.name;
  return "";
}

export interface DocsJsonCompatResult {
  data: unknown;
  diagnostics: Diagnostic[];
}

export function docsJsonCompat(input: unknown): DocsJsonCompatResult {
  if (!isObj(input)) return { data: input, diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  const warn = (code: string, message: string): void => {
    diagnostics.push({ severity: "warning", code, message, source: "docs.json" });
  };
  const data: Obj = { ...input };

  liftSite(data, warn);
  if (isObj(data.navigation)) {
    const { navigation, tabs } = mapNavigation(data.navigation, warn);
    data.navigation = navigation.length > 0 ? navigation : undefined;
    if (tabs.length > 0) data.tabs = tabs;
  }

  return { data, diagnostics };
}

/** Lift a `docs.json`'s top-level site fields under our `site`, when it is missing. */
function liftSite(data: Obj, warn: (c: string, m: string) => void): void {
  if (typeof data.name !== "string" || isObj(data.site)) return;
  const site: Obj = { name: data.name };
  if (typeof data.url === "string") site.url = data.url;
  if (typeof data.description === "string") site.description = data.description;
  if (data.logo !== undefined) site.logo = data.logo; // string | { light, dark }, our shape too
  if (data.favicon !== undefined) site.favicon = data.favicon;
  data.site = site;
  data.name = undefined;
  if (data.colors !== undefined) {
    data.colors = undefined;
    warn(
      "compat-colors",
      "docs.json `colors` are not migrated; set `site.theme` to brand the site.",
    );
  }
  if (typeof data.theme === "string") data.theme = undefined; // preset name, not ours
}

function mapNavigation(
  nav: Obj,
  warn: (c: string, m: string) => void,
): { navigation: NavItemInput[]; tabs: NavTabInput[] } {
  const navigation: NavItemInput[] = [];
  const tabs: NavTabInput[] = [];

  if (Array.isArray(nav.tabs)) {
    for (const t of nav.tabs) {
      if (isObj(t) && typeof t.tab === "string") tabs.push(tabItem(t.tab, t, warn));
    }
  }
  if (Array.isArray(nav.products)) {
    for (const p of nav.products) {
      if (isObj(p) && typeof p.product === "string") tabs.push(tabItem(p.product, p, warn));
    }
    warn("compat-products", "docs.json `products` were mapped to top-level tabs.");
  }
  if (Array.isArray(nav.dropdowns)) {
    for (const d of nav.dropdowns) {
      if (isObj(d) && typeof d.dropdown === "string") tabs.push(tabItem(d.dropdown, d, warn));
    }
    warn("compat-dropdowns", "docs.json `dropdowns` were mapped to top-level tabs.");
  }
  if (Array.isArray(nav.groups)) navigation.push(...mapGroups(nav.groups, warn));
  if (Array.isArray(nav.pages)) navigation.push(...mapPages(nav.pages, warn));

  for (const key of ["anchors", "global", "versions", "languages"]) {
    if (nav[key] !== undefined) {
      warn(
        `compat-${key}`,
        `docs.json \`navigation.${key}\` is not yet supported and was dropped.`,
      );
    }
  }
  return { navigation, tabs };
}

/** A `docs.json` tab / product / dropdown -> our tab, carrying its icon and menu. */
function tabItem(label: string, source: Obj, warn: (c: string, m: string) => void): NavTabInput {
  const item: NavTabInput = { tab: label, pages: sectionPages(source, warn) };
  const icon = iconName(source.icon);
  if (icon) item.icon = icon;
  if (Array.isArray(source.menu)) {
    const menu = source.menu.filter(isObj).map((m) => menuItem(m, warn));
    if (menu.length > 0) item.menu = menu;
  }
  return item;
}

/** A `docs.json` tab menu destination -> our menu item, flattening its groups/pages. */
function menuItem(m: Obj, warn: (c: string, m: string) => void): TabMenuItemInput {
  const item: TabMenuItemInput = {
    item: str(m.item) || str(m.dropdown) || str(m.tab),
    pages: sectionPages(m, warn),
  };
  const icon = iconName(m.icon);
  if (icon) item.icon = icon;
  return item;
}

/** The pages of a tab / product / dropdown / menu item: its groups then its pages. */
function sectionPages(section: Obj, warn: (c: string, m: string) => void): NavItemInput[] {
  const pages: NavItemInput[] = [];
  if (Array.isArray(section.groups)) pages.push(...mapGroups(section.groups, warn));
  if (Array.isArray(section.pages)) pages.push(...mapPages(section.pages, warn));
  return pages;
}

function mapGroups(groups: unknown[], warn: (c: string, m: string) => void): NavItemInput[] {
  const out: NavItemInput[] = [];
  for (const g of groups) {
    if (isObj(g) && typeof g.group === "string") out.push(groupItem(g, warn));
  }
  return out;
}

/** A `docs.json` group object -> our group nav item, carrying icon/tag/expanded. */
function groupItem(g: Obj, warn: (c: string, m: string) => void): NavItemInput {
  const item: Extract<NavItemInput, { group: string }> = {
    group: g.group as string,
    pages: Array.isArray(g.pages) ? mapPages(g.pages, warn) : [],
  };
  const icon = iconName(g.icon);
  if (icon) item.icon = icon;
  if (typeof g.tag === "string") item.tag = g.tag;
  if (typeof g.expanded === "boolean") item.expanded = g.expanded;
  return item;
}

function mapPages(items: unknown[], warn: (c: string, m: string) => void): NavItemInput[] {
  const out: NavItemInput[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      out.push(item);
    } else if (isObj(item) && typeof item.group === "string") {
      out.push(groupItem(item, warn));
    } else if (isObj(item) && Array.isArray(item.pages)) {
      out.push(...mapPages(item.pages, warn)); // a bare { pages } wrapper: inline it
    }
    // else: an external { page, href } or an unrecognized item — dropped.
    else if (isObj(item) && str(item.page) === "" && str(item.href) !== "") {
      warn("compat-nav-link", "An external navigation link item was dropped.");
    }
  }
  return out;
}
