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
        return `<a class="rs-nav__link${active ? " is-active" : ""}" href="${esc(node.url)}"${
          active ? ' aria-current="page"' : ""
        }>${esc(node.title)}</a>`;
      }
      // Groups render open by default and stay open across navigations (the state
      // is not recomputed per page), so a section never collapses on its own. The
      // reader can still collapse a group by hand via the native disclosure.
      return `<details class="rs-nav__group" open><summary class="rs-nav__label">${CHEVRON}<span>${esc(
        node.label,
      )}</span></summary><div class="rs-nav__children">${navItems(node.children, current)}</div></details>`;
    })
    .join("");
}
