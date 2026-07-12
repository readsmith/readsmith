// Self-hosted faces (Fontsource bundles the woff2; no external CDN). These
// declare the families the design tokens reference. Imported before the design
// stylesheet.
import "@fontsource/spectral/400.css";
import { getSite } from "@readsmith/serve";
import "@fontsource/spectral/500.css";
import "@fontsource/spectral/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@readsmith/components/styles.css";
import { themeInitScript } from "@readsmith/components";
import { siteBasePath } from "@readsmith/config";
import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Root metadata: the favicon for every route. A configured `site.favicon`
 * wins (per-theme pairs ride prefers-color-scheme media queries; an in-page
 * toggle cannot swap a favicon without JS, so the OS scheme governs it); the
 * Readsmith hallmark is the default. Page metadata merges over this per field,
 * so pages set titles without re-declaring icons.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { favicon, url } = await getSite();
  // Metadata URLs are not basePath-scoped by Next; prefix explicitly (SP-3).
  const base = siteBasePath(url);
  if (!favicon) return { icons: { icon: `${base}/_readsmith/favicon.svg` } };
  if (favicon.light === favicon.dark) return { icons: { icon: favicon.light } };
  return {
    icons: {
      icon: [
        { url: favicon.light, media: "(prefers-color-scheme: light)" },
        { url: favicon.dark, media: "(prefers-color-scheme: dark)" },
      ],
    },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { themeCss, appearance, url, analyticsHtml } = await getSite();
  return (
    // data-rs-base tells the client islands where the site is mounted (SP-5),
    // so no island hardcodes a root path.
    <html lang="en" suppressHydrationWarning data-rs-base={siteBasePath(url)}>
      <head>
        {/* Per-site brand theme, layered over the base tokens (see themeToCss). */}
        {themeCss ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized color tokens, built at compile time
          <style id="rs-site-theme" dangerouslySetInnerHTML={{ __html: themeCss }} />
        ) : null}
        {/* Sets the theme before first paint (persisted choice, then the site's
            configured default), so there is no flash. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: enum-parameterized inline theme init */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript(appearance?.default) }} />
      </head>
      <body>
        {children}
        {/* Bring-your-own analytics tags, precompiled and escaped at build.
            Script elements in the SSR stream execute regardless of wrapper. */}
        {analyticsHtml ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: compile-time escaped, charset-validated provider tags
          <div hidden dangerouslySetInnerHTML={{ __html: analyticsHtml }} />
        ) : null}
      </body>
    </html>
  );
}
