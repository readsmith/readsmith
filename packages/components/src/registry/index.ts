import type { ComponentRegistry } from "@readsmith/mdx";
import { callout, calloutOfKind } from "./callout.js";

/**
 * Build the Readsmith component registry for the P6 render pipeline. Each entry
 * maps a component name to a hast-producing render (static components ship no
 * JS; interactive ones are added as islands as the library grows).
 */
export function createRegistry(): ComponentRegistry {
  return {
    Callout: { render: callout },
    Note: { render: calloutOfKind("note") },
    Info: { render: calloutOfKind("info") },
    Tip: { render: calloutOfKind("tip") },
    Warning: { render: calloutOfKind("warning") },
    Danger: { render: calloutOfKind("danger") },
    Check: { render: calloutOfKind("check") },
  };
}

export { callout } from "./callout.js";
export type { ComponentArgs } from "./callout.js";
