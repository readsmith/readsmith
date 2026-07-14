import type { FinalNavNode } from "@readsmith/mdx";
import { esc } from "./util.js";

const CHEVRON =
  '<svg class="rs-nav__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

/**
 * Render the left navigation from the finalized nav tree. Groups become
 * collapsible sections with a stamped label; pages become links, the current
 * page marked with `is-active` and `aria-current`. Keyboard-navigable by
 * default (links and native disclosure).
 */
export function renderNav(nav: FinalNavNode[], currentSlug: string): string {
  return `<nav class="rs-nav" aria-label="Documentation navigation">${navItems(nav, currentSlug)}</nav>`;
}

function navItems(nodes: FinalNavNode[], current: string): string {
  return nodes
    .map((node) => {
      if (node.type === "page") {
        const active = node.slug === current;
        // Hybrid API-operation pages carry a method badge, the apinav grammar.
        const label = node.method
          ? `<span class="rs-method rs-method--sm rs-method--${esc(
              node.method.toLowerCase(),
            )}">${esc(node.method)}</span><span class="rs-apinav__label">${esc(node.title)}</span>`
          : esc(node.title);
        return `<a class="rs-nav__link${node.method ? " rs-nav__link--api" : ""}${
          active ? " is-active" : ""
        }" href="${esc(node.url)}"${active ? ' aria-current="page"' : ""}>${label}</a>`;
      }
      // Groups default open and stay open across navigations (the state is not
      // recomputed per page), so a section never collapses on its own; a reader
      // can still collapse one by hand. An authored `expanded: false` starts it
      // collapsed. A `tag` renders a stamped badge beside the label.
      const open = node.expanded === false ? "" : " open";
      const tag = node.tag ? `<span class="rs-nav__tag">${esc(node.tag)}</span>` : "";
      // node.icon is a pre-resolved, trusted inline SVG (from our bundled set).
      const icon = node.icon ?? "";
      return `<details class="rs-nav__group"${open}><summary class="rs-nav__label">${CHEVRON}${icon}<span>${esc(
        node.label,
      )}</span>${tag}</summary><div class="rs-nav__children">${navItems(node.children, current)}</div></details>`;
    })
    .join("");
}
