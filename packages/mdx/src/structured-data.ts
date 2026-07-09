/**
 * JSON-LD structured data, serialized safely.
 *
 * `JSON.stringify` escapes quotes and backslashes. It does not escape `<` or `/`.
 * The payload is injected raw into a `<script type="application/ld+json">`, and
 * its `headline` comes verbatim from author-controlled frontmatter, so a page
 * titled `x</script><img src=x onerror=...>` used to close the script element and
 * execute. That is stored XSS on the first accepted docs pull request, and a
 * tenant break under multi-tenant hosting.
 *
 * The fix is at the serializer, not at the Content-Security-Policy: our policy
 * must allow `'unsafe-inline'` for scripts (see `@readsmith/config`'s security
 * module), so it would not catch this. Escape `<`, `>`, and `&` to their JSON
 * unicode forms. A JSON string containing `<` parses back to `<`, so the
 * payload stays valid JSON-LD while going inert to the HTML parser.
 */

/** Schema.org types a docs page can reasonably claim. `@type` may still be overridden. */
export const JSON_LD_TYPES = ["TechArticle", "Article", "HowTo", "APIReference"] as const;

const SCRIPT_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
};

/**
 * Serialize a value for embedding inside an HTML `<script>` element. Escaping `&`
 * as well as the angle brackets additionally defuses HTML entity tricks.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (c) => SCRIPT_ESCAPES[c] ?? c);
}

export interface JsonLdParty {
  name: string;
  url?: string;
}

export interface JsonLdSite {
  name: string;
  url?: string;
  author?: JsonLdParty;
  publisher?: JsonLdParty;
}

export interface JsonLdPage {
  title: string;
  description?: string;
  /** Root-relative page URL, for example "/guide/setup". */
  url: string;
  /** Hidden pages are unlisted everywhere else; they emit no structured data. */
  hidden: boolean;
  frontmatter: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `patch` over `base`. Base keys keep their position, new patch keys
 * append in patch order, so the output is byte-stable for a given input.
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

/**
 * Build the escaped `application/ld+json` payload for a page, or null when the
 * page should emit none. `base` is the canonical origin, "" when unconfigured.
 */
export function buildJsonLd(site: JsonLdSite, page: JsonLdPage, base = ""): string | null {
  if (page.hidden) return null;

  const doc: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: page.title,
    ...(page.description ? { description: page.description } : {}),
    url: base ? base + page.url : page.url,
    isPartOf: {
      "@type": "WebSite",
      name: site.name,
      ...(site.url ? { url: site.url } : {}),
    },
    ...(site.author ? { author: { "@type": "Person", ...site.author } } : {}),
    ...(site.publisher ? { publisher: { "@type": "Organization", ...site.publisher } } : {}),
  };

  // A page may correct or extend its own structured data. Unknown keys pass
  // through: schema.org is larger than any list we would maintain here.
  const override = page.frontmatter.jsonLd;
  const merged = isPlainObject(override) ? deepMerge(doc, override) : doc;

  return serializeJsonLd(merged);
}
