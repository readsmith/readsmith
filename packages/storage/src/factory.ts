import { createLocalStore } from "./local.js";
import {
  type BundleStore,
  STORAGE_DRIVERS,
  type StorageConfig,
  StorageConfigError,
  storageConfigSchema,
} from "./port.js";
import { createS3Store } from "./s3.js";

/** Construct a BundleStore from validated config. One driver per process. */
export function createBundleStore(config: StorageConfig): BundleStore {
  switch (config.driver) {
    case "local":
      return createLocalStore(config.root);
    case "s3":
      return createS3Store(config);
    default: {
      // Exhaustive over the discriminated union.
      const unreachable: never = config;
      throw new StorageConfigError(`unsupported storage driver: ${String(unreachable)}`);
    }
  }
}

/**
 * Environment shape the storage config is resolved from. The index signature lets
 * a full `process.env` be passed directly; the named keys document what is read.
 */
export interface StorageEnv {
  STORAGE_DRIVER?: string | undefined;
  STORAGE_ROOT?: string | undefined;
  [key: string]: string | undefined;
}

/**
 * Resolve and validate storage config from environment, defaulting the driver to
 * `local` and the root to `defaultRoot`. Absent config is a no-op: it yields the
 * local default. An unknown driver fails fast with a clear, secret-free message
 * that names the allowed values.
 */
export function resolveStorageConfig(env: StorageEnv, defaultRoot: string): StorageConfig {
  const driver = env.STORAGE_DRIVER ?? "local";
  if (!(STORAGE_DRIVERS as readonly string[]).includes(driver)) {
    throw new StorageConfigError(
      `unknown STORAGE_DRIVER "${driver}"; allowed: ${STORAGE_DRIVERS.join(", ")}`,
    );
  }
  let candidate: Record<string, unknown>;
  if (driver === "s3") {
    const required = {
      STORAGE_ENDPOINT: env.STORAGE_ENDPOINT,
      STORAGE_BUCKET: env.STORAGE_BUCKET,
      STORAGE_ACCESS_KEY_ID: env.STORAGE_ACCESS_KEY_ID,
      STORAGE_SECRET_ACCESS_KEY: env.STORAGE_SECRET_ACCESS_KEY,
    };
    const missing = Object.entries(required)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new StorageConfigError(
        `STORAGE_DRIVER=s3 needs ${missing.join(", ")} (values never logged)`,
      );
    }
    candidate = {
      driver,
      endpoint: env.STORAGE_ENDPOINT,
      bucket: env.STORAGE_BUCKET,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
      region: env.STORAGE_REGION ?? "auto",
    };
  } else {
    candidate = { driver, root: env.STORAGE_ROOT ?? defaultRoot };
  }
  const parsed = storageConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new StorageConfigError(
      `invalid storage config: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}
