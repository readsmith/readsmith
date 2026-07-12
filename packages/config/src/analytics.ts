import type { AnalyticsConfig } from "./schema.js";

/**
 * Bring-your-own analytics: one provider table drives both halves of the
 * feature - the script tags the compile bakes into the bundle, and the CSP
 * sources the policy must admit for them. Keeping both here means a provider
 * can never be emitted without its CSP (a silently-blocked tag) or vice versa.
 * Identifier fields are charset-validated at the schema, and every
 * interpolation is attribute-escaped anyway: belt and braces, because these
 * strings land inside executable HTML.
 */
const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";
const PLAUSIBLE_DEFAULT_SRC = "https://plausible.io/js/script.js";
const FATHOM_SRC = "https://cdn.usefathom.com/script.js";

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The CSP sources each configured provider needs, deduplicated by the policy. */
export function analyticsCspSources(analytics: AnalyticsConfig | undefined): {
  scriptSrc: string[];
  connectSrc: string[];
} {
  const scriptSrc: string[] = [];
  const connectSrc: string[] = [];
  if (!analytics) return { scriptSrc, connectSrc };
  if (analytics.ga4) {
    scriptSrc.push("https://www.googletagmanager.com");
    connectSrc.push("https://www.googletagmanager.com", "https://*.google-analytics.com");
  }
  if (analytics.posthog) {
    const origin = originOf(analytics.posthog.host ?? POSTHOG_DEFAULT_HOST);
    if (origin) {
      scriptSrc.push(origin);
      connectSrc.push(origin);
    }
  }
  if (analytics.plausible) {
    const origin = originOf(analytics.plausible.src ?? PLAUSIBLE_DEFAULT_SRC);
    if (origin) {
      scriptSrc.push(origin);
      connectSrc.push(origin);
    }
  }
  if (analytics.fathom) {
    const origin = originOf(FATHOM_SRC);
    if (origin) {
      scriptSrc.push(origin);
      connectSrc.push(origin);
    }
  }
  return { scriptSrc, connectSrc };
}

/**
 * The provider tags, as one deterministic HTML string (fixed provider order),
 * or undefined when nothing is configured - the bundle omits the field
 * entirely, keeping unconfigured sites byte-identical. All loaders are async
 * or deferred: analytics never blocks a docs page.
 */
export function analyticsHeadHtml(analytics: AnalyticsConfig | undefined): string | undefined {
  if (!analytics) return undefined;
  const parts: string[] = [];
  if (analytics.ga4) {
    const id = esc(analytics.ga4.measurementId);
    parts.push(
      `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>`,
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`,
    );
  }
  if (analytics.posthog) {
    const host = esc(analytics.posthog.host ?? POSTHOG_DEFAULT_HOST);
    const key = esc(analytics.posthog.apiKey);
    parts.push(
      `<script async src="${host}/static/array.js" onload="window.posthog&&posthog.init('${key}',{api_host:'${host}'})"></script>`,
    );
  }
  if (analytics.plausible) {
    const src = esc(analytics.plausible.src ?? PLAUSIBLE_DEFAULT_SRC);
    const domain = esc(analytics.plausible.domain);
    parts.push(`<script defer data-domain="${domain}" src="${src}"></script>`);
  }
  if (analytics.fathom) {
    const siteId = esc(analytics.fathom.siteId);
    parts.push(`<script src="${FATHOM_SRC}" data-site="${siteId}" defer></script>`);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
