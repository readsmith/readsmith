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
import type { ReactNode } from "react";

// Set the theme before first paint from the persisted choice, so there is no flash.
const THEME_INIT =
  "(function(){try{var t=localStorage.getItem('rs-theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted inline theme init */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
