/*
 * Per-site brand theme → CSS. Turns a site's `theme` block (from docs.json) into
 * a small stylesheet that overrides the base `--rs-*` design tokens, so a site
 * reskins itself without forking tokens.css. The serving shell injects the
 * result into <head>, layered over the base tokens.
 *
 * Two properties matter and are enforced here:
 *   1. Precedence. The overrides win over the base tokens regardless of
 *      stylesheet source order (Next may inline the base sheet before or after
 *      our <style>), achieved with a `:root:root:root` specificity bump while
 *      still mirroring the base cascade — light default, dark via media query,
 *      then the explicit data-theme the shell persists.
 *   2. Safety. Values land inside a <style>, so each is sanitized to a
 *      conservative color allowlist; anything that could close the declaration
 *      or smuggle an at-rule/url() is dropped rather than emitted.
 */

/** A brand color: one value for both themes, or a per-theme pair. */
export type ModalColor = string | { light?: string; dark?: string };

/** The subset of tokens a site may override. Mirrors `SiteTheme` in @readsmith/config. */
export interface SiteThemeInput {
  accent?: ModalColor;
  accentHover?: ModalColor;
  accentWash?: ModalColor;
  paper?: ModalColor;
  surface?: ModalColor;
  surface2?: ModalColor;
  ink?: ModalColor;
  inkMuted?: ModalColor;
  inkFaint?: ModalColor;
  rule?: ModalColor;
  ruleStrong?: ModalColor;
  /** Font stacks — theme-agnostic, so they apply in both light and dark. */
  fontSans?: string;
  fontHeading?: string;
  fontMono?: string;
  fontWordmark?: string;
}

const COLOR_MAP = {
  accent: "--rs-accent",
  accentHover: "--rs-accent-hover",
  accentWash: "--rs-accent-wash",
  paper: "--rs-paper",
  surface: "--rs-surface",
  surface2: "--rs-surface-2",
  ink: "--rs-ink",
  inkMuted: "--rs-ink-muted",
  inkFaint: "--rs-ink-faint",
  rule: "--rs-rule",
  ruleStrong: "--rs-rule-strong",
} as const;

const FONT_MAP = {
  fontSans: "--rs-font-sans",
  fontHeading: "--rs-font-serif",
  fontMono: "--rs-font-mono",
  fontWordmark: "--rs-font-wordmark",
} as const;

// hex, rgb()/hsl()/oklch()/color-mix() expressions, and color keywords are all
// covered by this character set; the guard below rejects break-out attempts.
const SAFE_CHARS = /^[#a-z0-9(),.%/\s-]+$/i;

function safeColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 64) return null;
  if (!SAFE_CHARS.test(s)) return null;
  if (/url|expression|import|javascript/i.test(s)) return null;
  return s;
}

// A font stack: family names (quoted or bare), commas, and hyphens. The banned
// characters (;{}()<>@/\) rule out declaration break-out and url()/at-rules.
const SAFE_FONT = /^[a-z0-9 ,"'-]+$/i;
function safeFont(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 200) return null;
  if (!SAFE_FONT.test(s)) return null;
  return s;
}

function pick(c: ModalColor | undefined): { light: string | null; dark: string | null } {
  if (c == null) return { light: null, dark: null };
  if (typeof c === "string") {
    const v = safeColor(c);
    return { light: v, dark: v };
  }
  return { light: safeColor(c.light), dark: safeColor(c.dark) };
}

/**
 * Compile a site theme to a CSS string. Returns "" when nothing valid is set, so
 * the caller can skip emitting an empty <style>.
 */
export function themeToCss(theme: SiteThemeInput | null | undefined): string {
  if (!theme || typeof theme !== "object") return "";

  const light: string[] = [];
  const dark: string[] = [];
  for (const key of Object.keys(COLOR_MAP) as (keyof typeof COLOR_MAP)[]) {
    const { light: l, dark: d } = pick(theme[key]);
    if (l) light.push(`${COLOR_MAP[key]}:${l}`);
    if (d) dark.push(`${COLOR_MAP[key]}:${d}`);
  }

  const accent = pick(theme.accent);
  // Derive the accent wash from the accent unless the site set one, so link and
  // active-item backgrounds tint with the brand rather than the default hue.
  if (!theme.accentWash) {
    if (accent.light)
      light.push(`--rs-accent-wash:color-mix(in srgb, ${accent.light} 9%, transparent)`);
    if (accent.dark)
      dark.push(`--rs-accent-wash:color-mix(in srgb, ${accent.dark} 15%, transparent)`);
  }
  // The focus ring follows the accent, so keyboard focus stays on-brand.
  if (accent.light) light.push(`--rs-focus:${accent.light}`);
  if (accent.dark) dark.push(`--rs-focus:${accent.dark}`);

  // Fonts are theme-agnostic, so they live in the base block and apply in both
  // modes (the per-mode blocks only override colors, never these).
  const fonts: string[] = [];
  for (const key of Object.keys(FONT_MAP) as (keyof typeof FONT_MAP)[]) {
    const v = safeFont(theme[key]);
    if (v) fonts.push(`${FONT_MAP[key]}:${v}`);
  }

  // The API-reference "console" panel is deliberately always dark, so its brand
  // accent tracks the DARK accent in both page themes (not the light one).
  const constant: string[] = [];
  if (accent.dark) constant.push(`--rs-con-accent:${accent.dark}`);

  const base = [...fonts, ...constant, ...light];
  if (base.length === 0 && dark.length === 0) return "";

  const L = light.join(";");
  const D = dark.join(";");
  const out: string[] = [];
  if (base.length) out.push(`:root:root:root{${base.join(";")}}`);
  if (D) out.push(`@media (prefers-color-scheme:dark){:root:root:root{${D}}}`);
  if (D) out.push(`:root:root[data-theme="dark"]{${D}}`);
  if (L) out.push(`:root:root[data-theme="light"]{${L}}`);
  return out.join("");
}
