import { z } from "zod";

/**
 * The storage port: a byte-addressed blob store keyed by opaque, forward-slash
 * delimited strings (for example `bundle.json`). It is content-agnostic - it
 * moves bytes, not domain objects - so serialization and Zod validation stay in
 * the caller, keeping the schema-first boundary intact and the store trivially
 * swappable. The local filesystem driver is the only v1 implementation; an
 * S3-compatible driver (Cloudflare R2) can implement this same interface in the
 * hosted phase with no caller changes.
 */
export interface BundleStore {
  /** Read bytes for a key, or null if the key is absent. A miss never throws. */
  get(key: string): Promise<Buffer | null>;
  /** Whether a key currently resolves to stored bytes. */
  has(key: string): Promise<boolean>;
  /** Store bytes under a key, overwriting atomically. */
  put(key: string, data: string | Uint8Array): Promise<void>;
  /** List stored keys, optionally filtered by prefix, sorted for determinism. */
  list(prefix?: string): Promise<string[]>;
  /** Remove a key. Idempotent: deleting an absent key is a no-op, never a throw. */
  delete(key: string): Promise<void>;
}

/** The driver names this build understands (v1: local only). */
export const STORAGE_DRIVERS = ["local"] as const;

/** Driver config. A discriminated union so future drivers add additively. */
export const storageConfigSchema = z.discriminatedUnion("driver", [
  z.object({
    driver: z.literal("local"),
    /** Root directory the local driver sandboxes all keys within. */
    root: z.string().min(1),
  }),
]);

export type StorageConfig = z.infer<typeof storageConfigSchema>;

/**
 * Base storage fault. Carries operation + key context for diagnostics but never
 * the byte payload or any secret in its message.
 */
export class StorageError extends Error {
  readonly operation: string;
  readonly key: string | undefined;

  constructor(operation: string, key: string | undefined, options?: { cause?: unknown }) {
    super(
      key === undefined
        ? `storage ${operation} failed`
        : `storage ${operation} failed for key "${key}"`,
      options,
    );
    this.name = "StorageError";
    this.operation = operation;
    this.key = key;
  }
}

/** A key that is empty or escapes the store root (path traversal). */
export class StorageKeyError extends StorageError {
  constructor(operation: string, key: string, reason: string) {
    super(operation, key);
    this.name = "StorageKeyError";
    this.message = `invalid storage key "${key}": ${reason}`;
  }
}

/** Invalid storage configuration (for example an unknown driver name). */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}
