import { createLocalStore } from "./local.js";
import {
  type BundleStore,
  STORAGE_DRIVERS,
  type StorageConfig,
  StorageConfigError,
  storageConfigSchema,
} from "./port.js";

/** Construct a BundleStore from validated config. One driver per process. */
export function createBundleStore(config: StorageConfig): BundleStore {
  switch (config.driver) {
    case "local":
      return createLocalStore(config.root);
    default: {
      // Exhaustive over the discriminated union; unreachable in v1.
      const unreachable: never = config.driver;
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
  const root = env.STORAGE_ROOT ?? defaultRoot;
  const parsed = storageConfigSchema.safeParse({ driver, root });
  if (!parsed.success) {
    throw new StorageConfigError(
      `invalid storage config: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}
