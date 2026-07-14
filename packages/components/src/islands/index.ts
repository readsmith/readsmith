import { enhanceCodeGroup } from "./codegroup.js";
import { mountCopyButtons } from "./copy.js";
import { initMermaid } from "./mermaid.js";
import { enhancePlayground } from "./playground.js";
import { initReference } from "./reference.js";
import { initShell } from "./shell.js";
import { enhanceTabs } from "./tabs.js";

export { mountCopyButtons } from "./copy.js";
export { enhanceTabs } from "./tabs.js";
export { enhanceCodeGroup } from "./codegroup.js";
export { enhancePlayground } from "./playground.js";
export { initShell } from "./shell.js";
export { initMermaid } from "./mermaid.js";
export { initReference } from "./reference.js";

/** Enhancers keyed by the island component name emitted in `data-island`. */
const ENHANCERS: Record<string, (mount: HTMLElement) => void> = {
  Tabs: enhanceTabs,
  CodeGroup: enhanceCodeGroup,
  Playground: enhancePlayground,
};

/**
 * Hydrate the interactive parts of a rendered page. Static prose ships no JS; the
 * serving shell calls this once. Copy controls are enhanced everywhere; each
 * island mount (a `data-island` element from the P6 manifest) is dispatched to
 * its enhancer by name. Unknown or already-hydrated mounts are skipped.
 */
export function hydrate(root: ParentNode = document): void {
  initShell(root);
  void initMermaid(root);
  initReference(root);
  mountCopyButtons(root);
  for (const mount of root.querySelectorAll<HTMLElement>("[data-island]")) {
    if (mount.dataset.rsHydrated === "true") continue;
    const enhancer = ENHANCERS[mount.dataset.island ?? ""];
    if (enhancer) {
      enhancer(mount);
      mount.dataset.rsHydrated = "true";
    }
  }
}
