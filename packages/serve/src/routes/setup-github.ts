import { buildAppManifest } from "@readsmith/git";
import { escapeHtml, setupAvailable, setupPage } from "../setup.js";

/**
 * The GitHub App manifest-flow on-ramp: one form post creates an App with the
 * right permissions, events, and this instance's webhook URL already filled in.
 * Only exists while no GitHub credentials are configured.
 */

export function GET(request: Request): Response {
  if (!setupAvailable()) return new Response(null, { status: 404 });
  const origin = new URL(request.url).origin;
  const host = new URL(request.url).hostname;
  const manifest = buildAppManifest({
    appName: `readsmith-${host.split(".")[0] ?? "docs"}`,
    siteUrl: origin,
    webhookUrl: `${origin}/_readsmith/api/git/webhook`,
    redirectUrl: `${origin}/_readsmith/setup/github/callback`,
  });
  const body = `
<h1>Connect GitHub: create the App</h1>
<p>Readsmith deploys your docs on push through a GitHub App you own. This form
creates that App on your account with read-only <code>contents</code> and
<code>metadata</code> permissions, the <code>push</code> event, and this
instance's webhook URL (<code>${escapeHtml(`${origin}/_readsmith/api/git/webhook`)}</code>)
already configured. You can adjust the name on the next screen.</p>
<form action="https://github.com/settings/apps/new" method="post">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <button type="submit">Create the GitHub App on github.com</button>
</form>
<p class="note">After GitHub creates the App it sends you back here with a
one-hour code, and the next page shows the three environment variables to set.
Prefer the two-variable PAT mode, or on GitHub Enterprise Server? See the
self-host guide under <code>/docs</code> for the manual steps.</p>`;
  return setupPage("Connect GitHub", body);
}
