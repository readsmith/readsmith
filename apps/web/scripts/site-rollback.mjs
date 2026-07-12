// Deployment history + rollback trigger (the v1 admin surface; a dashboard
// route lands later). Rollback repoints the `is_current` pointer at a prior
// ready snapshot: instant in the database, no rebuild; a running server picks
// it up within its pointer TTL plus the route revalidate window (about a
// minute), or immediately on restart.
//
// Usage:
//   pnpm site:rollback --list             show recent deployments
//   pnpm site:rollback <deployment-id>    make that deployment current
import {
  createDb,
  createJobRunner,
  defineJob,
  hasDatabase,
  listDeployments,
  loadDbConfig,
  repointCurrent,
} from "@readsmith/db";
import { z } from "zod";

const SITE_ID = "default";

function usage() {
  console.log("usage: pnpm site:rollback --list | <deployment-id>");
}

async function main() {
  if (!hasDatabase()) {
    console.error("[readsmith] DATABASE_URL is not set; deployments need the database.");
    process.exit(1);
  }
  const arg = process.argv[2];
  if (!arg) {
    usage();
    process.exit(1);
  }
  const db = createDb(loadDbConfig());
  try {
    if (arg === "--list") {
      const rows = await listDeployments(db, { siteId: SITE_ID, limit: 20 });
      if (rows.length === 0) {
        console.log("[readsmith] no deployments yet");
        return;
      }
      for (const d of rows) {
        const marker = d.is_current ? "*" : " ";
        const sha = d.commit_sha.slice(0, 12);
        console.log(
          `${marker} ${d.id}  ${d.status.padEnd(10)}  ${sha}  ${d.created_at.toISOString()}`,
        );
      }
      console.log("\n* = current. Roll back with: pnpm site:rollback <deployment-id>");
      return;
    }
    const row = await repointCurrent(db, { siteId: SITE_ID, deploymentId: arg });
    // Search must converge to the served content: index pruning follows whatever
    // bundle it last indexed, so every pointer flip re-enqueues the index job.
    const embedIndexJob = defineJob({
      name: "embed.index",
      schema: z.object({ siteId: z.string().optional() }).passthrough(),
    });
    const runner = createJobRunner({ config: loadDbConfig() });
    await runner.start();
    await runner.enqueue(embedIndexJob, { siteId: SITE_ID });
    await runner.stop();
    const sha = row.commit_sha.slice(0, 12);
    console.log(
      `[readsmith] current deployment -> ${row.id} (${sha}); a running server reflects it within about a minute (search reindex queued).`,
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("[readsmith] rollback failed:", err.message ?? err);
  process.exit(1);
});
