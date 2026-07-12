import { createHmac, timingSafeEqual } from "node:crypto";
import { type Db, type Logger, listGitConnectionsByRepo, setInstallationId } from "@readsmith/db";
import type { SiteBuildPayload } from "./site-build.js";

/**
 * Webhook authenticity + event routing. Verification is HMAC-SHA256 over the
 * exact raw bytes with a constant-time compare, and happens before any parsing;
 * an unsigned or mis-signed delivery does nothing. The handler itself does
 * minimal work (verify, filter, enqueue) and returns fast; building is the
 * job's business.
 */

export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody)
    .digest("hex");
  const given = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type GitEvent =
  | { kind: "ping" }
  | { kind: "push"; repo: string; branch: string; headSha: string; deleted: boolean }
  | {
      kind: "installation";
      installationId: string;
      /** Repos gaining this installation. */
      reposBound: string[];
      /** Repos losing it (uninstall / repo removed). */
      reposUnbound: string[];
    }
  | { kind: "ignored"; event: string };

function fullNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => (r as { full_name?: unknown }).full_name)
    .filter((n): n is string => typeof n === "string");
}

/** Classify a delivery. Unknown events are acked and ignored, never errors. */
export function parseWebhookEvent(event: string | undefined | null, payload: unknown): GitEvent {
  const body = (payload ?? {}) as Record<string, unknown>;
  if (event === "ping") return { kind: "ping" };

  if (event === "push") {
    const ref = typeof body.ref === "string" ? body.ref : "";
    const repo = (body.repository as { full_name?: unknown } | undefined)?.full_name;
    const after = typeof body.after === "string" ? body.after : "";
    if (!ref.startsWith("refs/heads/") || typeof repo !== "string") {
      return { kind: "ignored", event: "push" };
    }
    return {
      kind: "push",
      repo,
      branch: ref.slice("refs/heads/".length),
      headSha: after,
      deleted: body.deleted === true || /^0+$/.test(after),
    };
  }

  if (event === "installation" || event === "installation_repositories") {
    const installation = body.installation as { id?: unknown } | undefined;
    if (installation?.id === undefined) return { kind: "ignored", event };
    const id = String(installation.id);
    const action = typeof body.action === "string" ? body.action : "";
    const all = fullNames(body.repositories);
    const added = fullNames(body.repositories_added);
    const removed = fullNames(body.repositories_removed);
    const uninstalled = action === "deleted";
    return {
      kind: "installation",
      installationId: id,
      reposBound: uninstalled ? [] : [...all, ...added],
      reposUnbound: uninstalled ? all : removed,
    };
  }

  return { kind: "ignored", event: event ?? "unknown" };
}

export interface WebhookHandlerDeps {
  /** Null when the host runs without persistence: deliveries are acked, nothing enqueues. */
  db: Db | null;
  /** The shared webhook secret; null = misconfigured, deliveries fail loudly. */
  secret: string | null;
  enqueue: (payload: SiteBuildPayload) => Promise<unknown>;
  logger?: Logger;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The webhook endpoint body, host-agnostic (a web Request in, a Response out).
 * Routing is by repository: `ping` acks; `push` enqueues one idempotent,
 * superseding `site.build` for EVERY site connected to that repo and branch
 * (a single-site install has exactly one, a multi-site host fans out);
 * installation events record or clear the installation id on every matching
 * connection; everything else acks and ignores.
 */
export function createWebhookHandler(
  deps: WebhookHandlerDeps,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (!deps.secret) {
      return json(503, { error: "webhook received but no webhook secret is configured" });
    }
    const raw = Buffer.from(await request.arrayBuffer());
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifyWebhookSignature(raw, signature, deps.secret)) {
      return json(401, { error: "invalid webhook signature" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return json(400, { error: "webhook payload is not JSON" });
    }
    const event = parseWebhookEvent(request.headers.get("x-github-event"), payload);

    try {
      switch (event.kind) {
        case "ping":
          return json(200, { ok: true });
        case "ignored":
          return json(200, { ignored: event.event });
        case "installation": {
          if (!deps.db) return json(200, { ignored: "no database" });
          for (const repo of event.reposBound) {
            await setInstallationId(deps.db, {
              repo,
              installationId: event.installationId,
            });
          }
          for (const repo of event.reposUnbound) {
            await setInstallationId(deps.db, { repo, installationId: null });
          }
          deps.logger?.info("installation recorded", {
            installation: event.installationId,
            bound: event.reposBound.length,
            unbound: event.reposUnbound.length,
          });
          return json(200, { ok: true });
        }
        case "push": {
          if (!deps.db) return json(200, { ignored: "no database" });
          if (event.deleted) return json(200, { ignored: "branch deleted" });
          const connections = await listGitConnectionsByRepo(deps.db, event.repo);
          const matching = connections.filter((c) => c.branch === event.branch);
          if (matching.length === 0) {
            return json(202, {
              ignored: connections.length
                ? "not the connected branch"
                : "repository is not connected",
            });
          }
          for (const connection of matching) {
            await deps.enqueue({
              siteId: connection.site_id,
              repo: connection.repo,
              ref: `refs/heads/${event.branch}`,
              commitSha: event.headSha,
            });
          }
          deps.logger?.info("push accepted", {
            repo: event.repo,
            commit: event.headSha,
            sites: matching.length,
          });
          return json(202, { queued: matching.length });
        }
      }
    } catch (err) {
      deps.logger?.error("webhook handling failed", { err: String(err) });
      return json(500, { error: "webhook handling failed" });
    }
  };
}
