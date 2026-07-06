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
