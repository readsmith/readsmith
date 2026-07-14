/*
 * Normalize a raw Lucide SVG string for inline use in the reading shell (nav
 * icons). The raw asset carries a license comment and a `lucide lucide-x` class;
 * this strips those and stamps our class plus `aria-hidden` (nav icons are
 * decorative, the label carries the meaning). Size and color come from CSS
 * (the SVG keeps `stroke="currentColor"`). The input is always one of our own
 * bundled Lucide files (the name is charset-guarded upstream), so the result is
 * trusted markup safe to inline.
 */
export function normalizeIconSvg(raw: string, className = "rs-nav__icon"): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg\b/, `<svg class="${className}" aria-hidden="true"`)
    .replace(/\s+class="lucide[^"]*"/, "")
    .trim();
}
