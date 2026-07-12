import {
  type Db,
  type GitConnectionRow,
  type Logger,
  getGitConnection,
  listDeployments,
  upsertGitConnection,
} from "@readsmith/db";
import type { GitHubProvider } from "./github.js";
import type { SiteBuildPayload } from "./site-build.js";

export interface BindDeps {
  db: Db;
  provider: GitHubProvider;
  enqueue: (payload: SiteBuildPayload) => Promise<unknown>;
  logger?: Logger;
}

export interface BindInput {
  siteId: string;
  /** `owner/name` from config. */
  repo: string;
  /** Branch override; null resolves the repo's default branch. */
  branch: string | null;
}

/**
 * Declarative connection binding (boot-time, from env/CLI config): resolve the
 * branch (defaulting to the repo's default), upsert the connection row, and,
 * when the site has no deployment history at all, enqueue an initial build at
 * the branch head so a freshly-connected site is live immediately rather than
 * blank until the first push. Subsequent builds are push-driven.
 */
export async function ensureGitConnection(
  deps: BindDeps,
  input: BindInput,
): Promise<GitConnectionRow> {
  const existing = await getGitConnection(deps.db, input.siteId);
  const sameRepo = existing?.repo.toLowerCase() === input.repo.toLowerCase();
  const resolved = await deps.provider.resolveBranch(
    { repo: input.repo, installationId: sameRepo ? existing?.installation_id : null },
    input.branch ?? (sameRepo ? existing?.branch : null) ?? null,
  );
  const row = await upsertGitConnection(deps.db, {
    id: `conn:${input.siteId}:${input.repo.toLowerCase()}`,
    siteId: input.siteId,
    provider: "github",
    installationId: sameRepo ? (existing?.installation_id ?? null) : null,
    repo: input.repo,
    branch: resolved.branch,
  });
  const history = await listDeployments(deps.db, { siteId: input.siteId, limit: 1 });
  if (history.length === 0) {
    await deps.enqueue({
      siteId: input.siteId,
      repo: row.repo,
      ref: `refs/heads/${resolved.branch}`,
      commitSha: resolved.headSha,
    });
    deps.logger?.info("initial build enqueued", { repo: row.repo, commit: resolved.headSha });
  }
  return row;
}
