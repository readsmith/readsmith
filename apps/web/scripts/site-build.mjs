// The manual build trigger (the v1 admin surface beside site:rollback): build
// and publish a deployment right now, from a branch head or an exact commit.
// Runs the same orchestration the push/poll paths use, inline in this process,
// so it works whether or not the server is up. It is also the recovery path
// when a transient fetch failure marked a build failed: re-run it by hand.
//
// Usage:
//   pnpm site:build              build the connected branch's current head
//   pnpm site:build <branch>     build that branch's current head
//   pnpm site:build <full-sha>   build that exact commit
import { join } from "node:path";
import {
  createDb,
  createJobRunner,
  createLogger,
  defineJob,
  getGitConnection,
  hasDatabase,
  loadDbConfig,
} from "@readsmith/db";
import {
  createGitHubProvider,
  createInProcessExecutor,
  resolveGitConfig,
  runSiteBuild,
} from "@readsmith/git";
import { createBundleStore, resolveStorageConfig } from "@readsmith/storage";
import { z } from "zod";

const SITE_ID = "default";
const FULL_SHA = /^[0-9a-f]{40}$/i;

async function main() {
  if (!hasDatabase()) {
    console.error("[readsmith] DATABASE_URL is not set; deployments need the database.");
    process.exit(1);
  }
  const gitConfig = resolveGitConfig(process.env);
  if (!gitConfig) {
    console.error("[readsmith] no GitHub credentials configured (set the App pair or GITHUB_PAT).");
    process.exit(1);
  }
  const dbConfig = loadDbConfig();
  const db = createDb(dbConfig);
  const log = createLogger(dbConfig.logLevel);
  try {
    const provider = createGitHubProvider({ auth: gitConfig.auth });
    const connection = await getGitConnection(db, SITE_ID);
    const repo = connection?.repo ?? gitConfig.repo;
    if (!repo) {
      console.error("[readsmith] no connected repository (set GITHUB_REPO or bind first).");
      process.exit(1);
    }
    const ref = process.argv[2];
    let commitSha;
    let gitRef;
    if (ref && FULL_SHA.test(ref)) {
      commitSha = ref.toLowerCase();
      gitRef = commitSha;
    } else {
      const resolved = await provider.resolveBranch(
        { repo, installationId: connection?.installation_id ?? null },
        ref ?? connection?.branch ?? gitConfig.branch,
      );
      commitSha = resolved.headSha;
      gitRef = `refs/heads/${resolved.branch}`;
    }

    const store = createBundleStore(
      resolveStorageConfig(process.env, join(process.cwd(), ".readsmith")),
    );
    const keepRaw = Number(process.env.READSMITH_KEEP_DEPLOYMENTS ?? "20");
    const failOnError = ["1", "true", "yes"].includes(
      (process.env.READSMITH_FAIL_ON_ERROR ?? "").toLowerCase(),
    );
    const row = await runSiteBuild(
      {
        db,
        store,
        executor: createInProcessExecutor({ provider, store }),
        logger: log,
        retention: { keepLast: Number.isInteger(keepRaw) && keepRaw >= 0 ? keepRaw : 20 },
        failOnError,
      },
      { siteId: SITE_ID, repo, ref: gitRef, commitSha },
    );

    if (row.status === "ready" && row.is_current) {
      // Search must converge to the served content after every pointer move.
      const embedIndexJob = defineJob({
        name: "embed.index",
        schema: z.object({ siteId: z.string().optional() }).passthrough(),
      });
      const runner = createJobRunner({ config: dbConfig });
      await runner.start();
      await runner.enqueue(embedIndexJob, { siteId: SITE_ID });
      await runner.stop();
      console.log(
        `[readsmith] published ${row.id} (${commitSha.slice(0, 12)}); a running server reflects it within about a minute (search reindex queued).`,
      );
    } else {
      console.error(`[readsmith] build did not publish: ${row.id} is ${row.status}.`);
      process.exit(1);
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("[readsmith] site build failed:", err.message ?? err);
  process.exit(1);
});
