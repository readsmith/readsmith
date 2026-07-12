/**
 * The GitHub App manifest flow: the 5-minute on-ramp for App-mode self-host.
 * The instance renders a form that posts a manifest to GitHub; the operator
 * clicks "Create"; GitHub redirects back with a one-hour code; exchanging it
 * returns the App id, private key, and an auto-generated webhook secret, which
 * the operator lands in env. Nothing here is stored: credentials pass through
 * the operator's browser exactly once.
 */
export interface ManifestInput {
  /** Proposed App name (globally unique on GitHub; the operator can edit it there). */
  appName: string;
  /** The docs site's public URL (shown on the App page). */
  siteUrl: string;
  /** Where GitHub delivers webhooks: `<origin>/_readsmith/api/git/webhook`. */
  webhookUrl: string;
  /** Where GitHub redirects with the temporary code after creation. */
  redirectUrl: string;
}

/** The manifest GitHub expects, with exactly the permissions the build needs. */
export function buildAppManifest(input: ManifestInput): Record<string, unknown> {
  return {
    name: input.appName,
    url: input.siteUrl,
    hook_attributes: { url: input.webhookUrl },
    redirect_url: input.redirectUrl,
    public: false,
    default_permissions: { contents: "read", metadata: "read" },
    default_events: ["push"],
  };
}

export interface ManifestCredentials {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  /** The App's page; `<htmlUrl>/installations/new` starts the install. */
  htmlUrl: string;
}

/**
 * Exchange the redirect's temporary code (valid one hour, single use) for the
 * App credentials. Unauthenticated by design (the code is the credential).
 */
export async function exchangeManifestCode(
  code: string,
  options: { apiBase?: string; fetchImpl?: typeof fetch } = {},
): Promise<ManifestCredentials> {
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "readsmith" },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub manifest-code exchange failed: HTTP ${res.status} (codes are single-use and expire after one hour)`,
    );
  }
  const body = (await res.json()) as {
    id?: number | string;
    slug?: string;
    pem?: string;
    webhook_secret?: string;
    html_url?: string;
  };
  if (body.id === undefined || !body.pem || !body.webhook_secret || !body.html_url) {
    throw new Error("GitHub manifest-code exchange returned an incomplete App");
  }
  return {
    appId: String(body.id),
    slug: body.slug ?? "",
    privateKey: body.pem,
    webhookSecret: body.webhook_secret,
    htmlUrl: body.html_url,
  };
}
