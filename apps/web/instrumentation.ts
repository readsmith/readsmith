/**
 * Next boot hook. The DB-backed work (migrations + job worker) is imported only
 * inside the Node.js runtime branch, so its Postgres dependencies are excluded
 * from the edge instrumentation bundle. See lib/boot.ts.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { boot } = await import("./lib/boot");
    await boot();
  }
}
