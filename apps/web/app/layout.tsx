// Self-hosted faces (Fontsource bundles the woff2; no external CDN). These
// declare the families the design tokens reference. Imported before the design
// stylesheet.
import "@fontsource/spectral/400.css";
import "@fontsource/spectral/500.css";
import "@fontsource/spectral/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@readsmith/components/styles.css";
import { getSite } from "@/lib/site";
import { themeInitScript } from "@readsmith/components";
import type { ReactNode } from "react";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { themeCss, appearance } = await getSite();
  return (
    <html lang="en" suppressHydrationWarning>
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
      <body>{children}</body>
    </html>
  );
}
