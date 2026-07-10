import type { NormalizedSpec, Operation } from "@readsmith/model";
import { askConsole, header, palette, tabbar } from "../shell/layout.js";
import type { ShellSite } from "../shell/layout.js";
import { esc } from "../shell/util.js";
import { describeScheme, renderOperation, renderOperationConsole, verb } from "./operation.js";

/**
 * The read-only API reference: one continuous page. A front-door overview, then
 * every operation as a section with its detail on the left (schemas rendered by
 * the SchemaViewer) and its own dark "assay console" on the right (code samples
 * plus a response readout). SSR HTML strings; the only interactive parts are the
 * shared Tabs/CodeGroup islands and a scroll-spy that tracks the nav. Each
 * operation is deep-linkable by its id anchor. The operation-level fragments
 * live in operation.ts (shared with the hybrid per-operation pages).
 */

export {
  renderOperation,
  renderOperationBar,
  renderOperationConsole,
  renderOperationMain,
  renderOperationSections,
  type OperationPageApi,
  type OperationPageData,
} from "./operation.js";

export interface ReferenceOptions {
  /** URL prefix the reference is mounted at (for cross-page deep links). */
  basePath?: string;
}

const DEFAULT_BASE = "/api-reference";

/** The stable, deep-linkable URL path for an operation (cross-page). */
export function operationPath(op: Operation, options: ReferenceOptions = {}): string {
  return `${options.basePath ?? DEFAULT_BASE}/${op.id}`;
}

/** The in-page anchor for an operation. */
export function operationAnchor(op: Operation): string {
  return `#${op.id}`;
}

/** Operations grouped by their first tag, tags ordered per the spec then alphabetically. */
export function referenceGroups(spec: NormalizedSpec): { tag: string; operations: Operation[] }[] {
  const order = spec.tags.map((t) => t.name);
  const byTag = new Map<string, Operation[]>();
  for (const op of spec.operations) {
    const tag = op.tags[0] ?? "General";
    const list = byTag.get(tag);
    if (list) list.push(op);
    else byTag.set(tag, [op]);
  }
  const tags = [...byTag.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  return tags.map((tag) => ({ tag, operations: byTag.get(tag) ?? [] }));
}

/** A tag section header in the flow, mirroring the nav's grouping. */
function renderGroupHeader(tag: string, spec: NormalizedSpec): string {
  const description = spec.tags.find((t) => t.name === tag)?.description;
  return `<div class="rs-apigroup"><h2 class="rs-apigroup__title">${esc(tag)}</h2>${
    description ? `<p class="rs-apigroup__desc">${esc(description)}</p>` : ""
  }</div>`;
}

/** The tag-grouped operation navigation (left panel), linking to in-page anchors. */
export function renderApiNav(
  spec: NormalizedSpec,
  activeId?: string,
  _options: ReferenceOptions = {},
): string {
  const groups = referenceGroups(spec)
    .map((group) => {
      const links = group.operations
        .map((op) => {
          const active = op.id === activeId ? " is-active" : "";
          const dep = op.deprecated ? " is-deprecated" : "";
          const aria = op.id === activeId ? ' aria-current="true"' : "";
          return `<a class="rs-apinav__link rs-nav__link${active}${dep}" href="${operationAnchor(
            op,
          )}"${aria}>${verb(op.method, true)}<span class="rs-apinav__label">${esc(
            op.summary ?? op.path,
          )}</span></a>`;
        })
        .join("");
      return `<div class="rs-apinav__group"><div class="rs-apinav__tag rs-eyebrow">${esc(
        group.tag,
      )}</div>${links}</div>`;
    })
    .join("");
  return `<nav class="rs-apinav" aria-label="API reference">${groups}</nav>`;
}

/** One operation section: detail plus console, deep-linkable by anchor. */
function renderOperationSection(op: Operation, spec: NormalizedSpec): string {
  return `<section class="rs-op" id="${esc(op.id)}"><div class="rs-op__grid"><div class="rs-op__detail">${renderOperation(
    op,
    spec,
  )}</div><div class="rs-op__console">${renderOperationConsole(op, spec)}</div></div></section>`;
}

/** The front-door overview: title, base URL, version, auth summary. */
function renderApiIntro(spec: NormalizedSpec): string {
  const info = spec.info;
  const chips: string[] = [];
  const server = spec.servers[0]?.url;
  if (server) chips.push(metachip("Base URL", server));
  chips.push(metachip("Version", info.version));
  const authNames = Object.keys(spec.securitySchemes);
  if (authNames.length > 0) {
    const first = spec.securitySchemes[authNames[0] ?? ""];
    if (first) chips.push(metachip("Auth", describeScheme(first).replace(/\.$/, "")));
  }
  return `<section class="rs-apiintro"><h1 class="rs-apiintro__title">${esc(info.title)}</h1>${
    info.description ? `<p class="rs-apiintro__lede">${esc(info.description)}</p>` : ""
  }<div class="rs-apiintro__meta">${chips.join("")}</div></section>`;
}

function metachip(label: string, value: string): string {
  return `<span class="rs-metachip">${esc(label)} <b>${esc(value)}</b></span>`;
}

/** The full reference body: chrome, nav, and every operation on one page. */
export function renderReferenceBody(
  site: ShellSite,
  spec: NormalizedSpec,
  options: ReferenceOptions = {},
): string {
  const sections = referenceGroups(spec)
    .map((group) => {
      const header = renderGroupHeader(group.tag, spec);
      const ops = group.operations.map((op) => renderOperationSection(op, spec)).join("");
      return `${header}${ops}`;
    })
    .join("");
  return `<a class="rs-skip" href="#rs-content">Skip to content</a>
${header(site)}
${tabbar(site)}
<div class="rs-scrim" data-rs-scrim hidden></div>
<div class="rs-apiref" data-rs-apiref>
  <div class="rs-apinav-col" data-rs-navcol>${renderApiNav(spec, undefined, options)}</div>
  <main class="rs-apiref__main" id="rs-content" tabindex="-1">
    ${renderApiIntro(spec)}
    ${sections}
  </main>
</div>
${palette(site)}
${askConsole(site)}`;
}
