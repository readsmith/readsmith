import { exchangeManifestCode } from "@readsmith/git";
import { escapeHtml, setupAvailable, setupPage } from "../setup.js";

/**
 * The manifest-flow landing: exchange the one-hour code for the App
 * credentials and show them exactly once for the operator to land in env.
 * Nothing is stored anywhere; a refresh cannot replay the exchange (codes are
 * single-use). Only exists while no GitHub credentials are configured.
 */

export async function GET(request: Request): Promise<Response> {
  if (!setupAvailable()) return new Response(null, { status: 404 });
  const code = new URL(request.url).searchParams.get("code");
  if (!code) {
    return setupPage(
      "Connect GitHub",
      `<h1>Missing code</h1><p>GitHub should have redirected here with a
<code>?code=</code> parameter. Start again from
<a href="/_readsmith/setup/github">the setup page</a>.</p>`,
      400,
    );
  }
  try {
    const creds = await exchangeManifestCode(code);
    // The PEM goes into env as a single line with literal \n escapes (the
    // config normalizes them back), which survives every dotenv dialect.
    const envKey = creds.privateKey.trimEnd().replaceAll("\n", "\\n");
    const envBlock = [
      `GITHUB_APP_ID=${creds.appId}`,
      `GITHUB_APP_PRIVATE_KEY="${envKey}"`,
      `GITHUB_WEBHOOK_SECRET=${creds.webhookSecret}`,
      "GITHUB_REPO=owner/name   # the docs repo to serve",
    ].join("\n");
    const body = `
<h1>App created: ${escapeHtml(creds.slug)}</h1>
<p>Copy these into your <code>.env</code> now. <strong>This page shows them
exactly once</strong> and stores nothing; if you lose the key, generate a new
one from the App's settings on GitHub.</p>
<pre>${escapeHtml(envBlock)}</pre>
<h2>Then</h2>
<p>1. <a href="${escapeHtml(creds.htmlUrl)}/installations/new">Install the App
on your docs repository</a>.<br>
2. Restart Readsmith with the new environment. The first build enqueues
automatically; every push to the connected branch deploys after that.</p>`;
    return setupPage("GitHub App created", body);
  } catch (err) {
    return setupPage(
      "Connect GitHub",
      `<h1>Exchange failed</h1><p>${escapeHtml(
        err instanceof Error ? err.message : "unknown error",
      )}</p><p>Start again from <a href="/_readsmith/setup/github">the setup page</a>.</p>`,
      502,
    );
  }
}
