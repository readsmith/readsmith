import { allowlistFromServers } from "@readsmith/exec";
import { type ExecServiceLike, createExecService } from "@readsmith/exec/node";
import type { Server } from "@readsmith/model";
import { type Bundle, getBundle, loadBundleForSite } from "./site.js";

/**
 * Resolve a server's templated URL to a concrete URL using each variable's
 * default (the resolve-defaults policy): `https://{region}.api.example.com` with
 * region default `us` becomes `https://us.api.example.com`. A reader who edits a
 * variable to a non-default host is then denied by the allowlist, by design.
 */
export function resolveServerUrl(server: Server): string {
  let url = server.url;
  for (const [name, variable] of Object.entries(server.variables ?? {})) {
    url = url.split(`{${name}}`).join(variable.default);
  }
  return url;
}

/**
 * Build the playground executor for a bundle: the allowlist is the site's own
 * OpenAPI servers (resolved), so "Try It" can only reach hosts the docs declare.
 * A docs-only site (no api reference) yields a disabled service, which turns the
 * `/proxy` route off for that site.
 */
export function execServiceForBundle(bundle: Bundle | null): ExecServiceLike {
  const servers = bundle?.apiReference?.spec.servers ?? [];
  return createExecService({ allowlist: allowlistFromServers(servers.map(resolveServerUrl)) });
}

/** The single-site (self-host) playground executor for `ApiDeps.exec`. */
export async function getExecService(): Promise<ExecServiceLike> {
  return execServiceForBundle(await getBundle().catch(() => null));
}

/** The per-site (multi-tenant) playground executor, keyed by site id. */
export async function getExecServiceForSite(siteId: string): Promise<ExecServiceLike> {
  return execServiceForBundle(await loadBundleForSite(siteId).catch(() => null));
}
