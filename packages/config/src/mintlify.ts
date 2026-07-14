import type { Diagnostic } from "@readsmith/model";
import type { NavItemInput, NavTabInput } from "./schema.js";

/*
 * Mintlify docs.json compatibility. A genuine Mintlify export differs from our
 * config in two structural ways: it keeps site fields (name/logo/favicon) at the
 * top level rather than under `site`, and it models `navigation` as an object of
 * divisions (tabs/groups/pages/products/dropdowns/anchors) rather than an array.
 * Either would fail our `safeParse`, so this runs between parse and validation
 * and translates the Mintlify shape into our `ConfigInput`. It auto-detects the
 * shape per transform, so a native config (a `site` object + an array
 * `navigation`) passes through untouched. Unsupported divisions are dropped with
 * a warning rather than silently, so a migration is honest about what it lost.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Mintlify icon: a string name, or an object `{ name, library, style }`. */
function iconName(v: unknown): string {
  if (typeof v === "string") return v;
  if (isObj(v) && typeof v.name === "string") return v.name;
  return "";
}

export interface MintlifyCompatResult {
  data: unknown;
  diagnostics: Diagnostic[];
}

export function mintlifyCompat(input: unknown): MintlifyCompatResult {
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

/** Lift Mintlify's top-level site fields under our `site`, when it is missing. */
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
      "mintlify-colors",
      "Mintlify `colors` are not migrated; set `site.theme` to brand the site.",
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
      if (isObj(t) && typeof t.tab === "string") {
        tabs.push({ tab: t.tab, pages: sectionPages(t, t.tab, warn) });
      }
    }
  }
  if (Array.isArray(nav.products)) {
    for (const p of nav.products) {
      if (isObj(p) && typeof p.product === "string") {
        tabs.push({ tab: p.product, pages: sectionPages(p, p.product, warn) });
      }
    }
    warn("mintlify-products", "Mintlify `products` were mapped to top-level tabs.");
  }
  if (Array.isArray(nav.dropdowns)) {
    for (const d of nav.dropdowns) {
      if (isObj(d) && typeof d.dropdown === "string") {
        tabs.push({ tab: d.dropdown, pages: sectionPages(d, d.dropdown, warn) });
      }
    }
    warn("mintlify-dropdowns", "Mintlify `dropdowns` were mapped to top-level tabs.");
  }
  if (Array.isArray(nav.groups)) navigation.push(...mapGroups(nav.groups, warn));
  if (Array.isArray(nav.pages)) navigation.push(...mapPages(nav.pages, warn));

  for (const key of ["anchors", "global", "versions", "languages"]) {
    if (nav[key] !== undefined) {
      warn(
        `mintlify-${key}`,
        `Mintlify \`navigation.${key}\` is not yet supported and was dropped.`,
      );
    }
  }
  return { navigation, tabs };
}

/** The pages of a tab / product / dropdown: its groups then its loose pages. */
function sectionPages(
  section: Obj,
  label: string,
  warn: (c: string, m: string) => void,
): NavItemInput[] {
  const pages: NavItemInput[] = [];
  if (Array.isArray(section.groups)) pages.push(...mapGroups(section.groups, warn));
  if (Array.isArray(section.pages)) pages.push(...mapPages(section.pages, warn));
  if (section.menu !== undefined) {
    warn(
      "mintlify-tab-menu",
      `Tab "${label}" dropdown menu is not yet supported; its destinations were dropped.`,
    );
  }
  return pages;
}

function mapGroups(groups: unknown[], warn: (c: string, m: string) => void): NavItemInput[] {
  const out: NavItemInput[] = [];
  for (const g of groups) {
    if (isObj(g) && typeof g.group === "string") out.push(groupItem(g, warn));
  }
  return out;
}

/** A Mintlify group object -> our group nav item, carrying tag/expanded. */
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
      warn("mintlify-nav-link", "An external navigation link item was dropped.");
    }
  }
  return out;
}
