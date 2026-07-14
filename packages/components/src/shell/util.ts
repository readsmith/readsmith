/** Escape text for safe interpolation into the shell's HTML string templates. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The hallmark mark: an assay cartouche with a struck check. Recolored by context. */
export const HALLMARK_SVG =
  '<svg class="rs-mark" viewBox="0 0 32 32" aria-hidden="true">' +
  '<path d="M16 2.5 L27.5 9 V23 L16 29.5 L4.5 23 V9 Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
  '<path d="M11 16.2 L14.6 20 L21.3 11.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  "</svg>";

/**
 * The header lockup's mark: stroked with a gradient whose stops glint in
 * sequence (.rs-ms1-3 in shell.css), so a light travels the hallmark in step
 * with the wordmark's chrome sweep. The gradient id is fixed: render at most
 * one per page (the header brand); the footer badge keeps the plain mark.
 */
export const HALLMARK_SVG_SHIMMER =
  '<svg class="rs-mark" viewBox="0 0 32 32" aria-hidden="true">' +
  '<defs><linearGradient id="rs-mark-metal" x1="0" y1="0" x2="1" y2="0.35">' +
  '<stop class="rs-ms1" offset="0"/><stop class="rs-ms2" offset="0.55"/><stop class="rs-ms3" offset="1"/>' +
  "</linearGradient></defs>" +
  '<path d="M16 2.5 L27.5 9 V23 L16 29.5 L4.5 23 V9 Z" fill="none" stroke="url(#rs-mark-metal)" stroke-width="1.6" stroke-linejoin="round"/>' +
  '<path d="M11 16.2 L14.6 20 L21.3 11.6" fill="none" stroke="url(#rs-mark-metal)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  "</svg>";

/** Small line icons used in the header and menus. */
export const ICONS = {
  search:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4" stroke-linecap="round"/></svg>',
  sparkle:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2l1.7 6.1a3 3 0 0 0 2.2 2.2L22 12l-6.1 1.7a3 3 0 0 0-2.2 2.2L12 22l-1.7-6.1a3 3 0 0 0-2.2-2.2L2 12l6.1-1.7a3 3 0 0 0 2.2-2.2z"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>',
  expand:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4" stroke-linecap="round"/></svg>',
  arrowUp:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M6 11l6-6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  theme:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" stroke-linecap="round"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M3 12h18M3 18h18" stroke-linecap="round"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>',
  kebab:
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>',
  markdown:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 4h11l5 5v11H4z"/><path d="M8 13h8M8 17h5" stroke-linecap="round"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" stroke-linecap="round"/></svg>',
  ai: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a8 8 0 1 1-3.2-6.4" stroke-linecap="round"/><path d="M12 8v4l3 2" stroke-linecap="round"/></svg>',
  install:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v11m0 0 4-4m-4 4-4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke-linecap="round"/></svg>',
  server:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01" stroke-linecap="round"/></svg>',
} as const;

/**
 * Footer social icons by platform key (the docs.json-compatible `footer.socials`
 * shape). Unknown platforms fall back to the generic link icon, so a new
 * network never breaks a site.
 */
const SOCIAL_ICONS: Record<string, string> = {
  github: ICONS.github,
  x: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M17.9 3H21l-6.8 7.8L22.2 21h-6.3l-4.9-6.4L5.4 21H2.3l7.3-8.3L2 3h6.4l4.4 5.9zm-1.1 16.1h1.7L7.6 4.7H5.8z"/></svg>',
  linkedin:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM9 9h3.8v1.7h.1c.5-1 1.8-2 3.7-2 4 0 4.7 2.6 4.7 6V21h-4v-5.5c0-1.3 0-3-1.9-3s-2.2 1.4-2.2 2.9V21H9z"/></svg>',
  discord:
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M19.3 5.3A16.9 16.9 0 0 0 15.1 4l-.5 1a15.6 15.6 0 0 0-5.2 0L8.9 4a16.9 16.9 0 0 0-4.2 1.3C2 9.2 1.3 13 1.6 16.7A17 17 0 0 0 6.8 19l1.1-1.8a11 11 0 0 1-1.7-.8l.4-.3a12.1 12.1 0 0 0 10.8 0l.4.3c-.5.3-1.1.6-1.7.8l1.1 1.8a17 17 0 0 0 5.2-2.3c.4-4.3-.7-8-3.1-11.4zM8.7 14.4c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z"/></svg>',
  youtube:
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8c1.6.4 7.8.4 7.8.4s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15.2V8.8L15.5 12z"/></svg>',
};
SOCIAL_ICONS.twitter = SOCIAL_ICONS.x as string;

export function socialIcon(platform: string): string {
  return SOCIAL_ICONS[platform.toLowerCase()] ?? ICONS.link;
}
