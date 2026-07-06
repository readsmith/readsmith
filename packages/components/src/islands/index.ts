import { mountCopyButtons } from "./copy.js";

export { mountCopyButtons } from "./copy.js";

/**
 * Hydrate the interactive parts of a rendered page. Static prose ships no JS;
 * the serving shell calls this once to enhance the islands that are present.
 * More island types (tabs, accordions, code groups) register here as they land.
 */
export function hydrate(root: ParentNode = document): void {
  mountCopyButtons(root);
}
