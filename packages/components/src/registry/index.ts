import type { ComponentRegistry } from "@readsmith/mdx";
import type { NormalizedSpec } from "@readsmith/model";
import { accordion, accordionGroup } from "./accordion.js";
import { callout, calloutOfKind } from "./callout.js";
import { card, cardGroup } from "./card.js";
import { update } from "./changelog.js";
import { codeGroup } from "./codegroup.js";
import { frame } from "./frame.js";
import { badge, kbd, tooltip } from "./inline.js";
import { operationEmbed } from "./operation.js";
import { step, steps } from "./steps.js";
import { tab, tabs } from "./tabs.js";

export interface RegistryOptions {
  /** The site's normalized API spec; powers `<Operation op="GET /x" />` embeds. */
  apiSpec?: NormalizedSpec | null;
}

/**
 * Build the Readsmith component registry for the P6 render pipeline. Each entry
 * maps a component name to a hast-producing render. Static components ship zero
 * JS; islands (tabs, code groups) are marked so the pipeline lists them in the
 * hydration manifest and the client runtime enhances them.
 */
export function createRegistry(options: RegistryOptions = {}): ComponentRegistry {
  return {
    // API reference embeds
    Operation: { render: operationEmbed(options.apiSpec) },
    // callouts
    Callout: { render: callout },
    Note: { render: calloutOfKind("note") },
    Info: { render: calloutOfKind("info") },
    Tip: { render: calloutOfKind("tip") },
    Warning: { render: calloutOfKind("warning") },
    Danger: { render: calloutOfKind("danger") },
    Check: { render: calloutOfKind("check") },
    // cards
    Card: { render: card },
    CardGroup: { render: cardGroup },
    // steps
    Steps: { render: steps },
    Step: { render: step },
    // frame
    Frame: { render: frame },
    // accordion (native details, static)
    Accordion: { render: accordion },
    AccordionGroup: { render: accordionGroup },
    // changelog
    Update: { render: update },
    // inline
    Kbd: { render: kbd },
    Badge: { render: badge },
    Tooltip: { render: tooltip },
    // islands
    Tabs: { render: tabs, island: true },
    Tab: { render: tab },
    CodeGroup: { render: codeGroup, island: true },
  };
}

export { callout } from "./callout.js";
export type { ComponentArgs } from "./util.js";
