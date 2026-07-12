import { getGitRuntime } from "./git.js";

/**
 * Server-only helpers for the one-time GitHub App setup pages. These pages
 * exist only while git credentials are absent: the moment `GITHUB_APP_ID` or
 * `GITHUB_PAT` is configured they 404, so a live site never exposes a setup
 * surface. Responses are never cached (the callback shows a private key once).
 */
export function setupAvailable(): boolean {
  return getGitRuntime() === null;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A minimal, self-contained operator page (no site bundle, no assets). */
export function setupPage(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.6; color: #1e2528; background: #fbfaf7; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
  code, pre { font-family: ui-monospace, monospace; font-size: 0.85em; background: #efece4; border-radius: 4px; }
  code { padding: 0.1em 0.35em; }
  pre { padding: 0.9rem 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  button { font: inherit; padding: 0.55rem 1.1rem; border: 1px solid #0f6b62; background: #0f6b62; color: #fff; border-radius: 6px; cursor: pointer; }
  .note { border-left: 3px solid #c28e3f; padding: 0.25rem 0 0.25rem 0.9rem; color: #4d5559; }
</style>
</head>
<body>
${body}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
