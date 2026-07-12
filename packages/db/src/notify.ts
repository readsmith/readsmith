import pg from "pg";
import type { DbConfig } from "./config.js";
import type { Logger } from "./log.js";

/**
 * Cross-instance deployment signals over Postgres LISTEN/NOTIFY: no Redis, no
 * broker. Every `is_current` flip (publish and rollback) NOTIFYs this channel
 * with the site id from inside the flip transaction, so delivery happens on
 * commit and never for a rolled-back flip. Listeners drop their pointer caches
 * for that site; the payload is a hint, not a contract - a missed notification
 * only means falling back to the pointer TTL.
 */
export const DEPLOYMENT_PUBLISHED_CHANNEL = "readsmith_deployment_published";

export interface DeploymentListener {
  close(): Promise<void>;
}

/**
 * Hold a dedicated connection LISTENing for pointer flips and invoke the
 * handler with the site id. Reconnects with a fixed backoff on connection loss
 * (a gap only degrades to TTL freshness); `close()` ends it for good.
 */
export async function listenForDeploymentPublishes(
  config: DbConfig,
  handler: (siteId: string) => void,
  logger?: Logger,
): Promise<DeploymentListener> {
  let closed = false;
  let client: pg.Client | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  async function connect(): Promise<void> {
    if (closed) return;
    const next = new pg.Client({ connectionString: config.databaseUrl });
    next.on("notification", (message) => {
      if (message.channel !== DEPLOYMENT_PUBLISHED_CHANNEL) return;
      const siteId = message.payload;
      if (siteId) handler(siteId);
    });
    next.on("error", (err) => {
      logger?.warn("deployment listener connection lost", { err: String(err) });
      scheduleReconnect();
    });
    await next.connect();
    await next.query(`LISTEN ${DEPLOYMENT_PUBLISHED_CHANNEL}`);
    client = next;
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    client?.end().catch(() => {});
    client = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((err) => {
        logger?.warn("deployment listener reconnect failed", { err: String(err) });
        scheduleReconnect();
      });
    }, 5000);
    reconnectTimer.unref?.();
  }

  await connect();

  return {
    async close(): Promise<void> {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      await client?.end().catch(() => {});
      client = null;
    },
  };
}
