import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type BundleStore, StorageError, StorageKeyError } from "./port.js";

// A deterministic per-process temp-name source. The determinism rule forbids
// Date.now()/Math.random() in build/render paths, so a temp file is named from
// the process id plus a monotonic counter - unique without wall-clock or RNG.
let tmpCounter = 0;

/**
 * A local filesystem BundleStore rooted at a directory. Every key resolves under
 * `root` and is asserted to stay within it (path-traversal sandbox); writes are
 * atomic (temp file in the same directory, then rename) so a reader never
 * observes a half-written blob. The driver holds no content cache - read-once
 * memoization is the caller's concern.
 */
export function createLocalStore(root: string): BundleStore {
  const rootResolved = resolve(root);

  function resolveKey(operation: string, key: string): string {
    if (key.length === 0) {
      throw new StorageKeyError(operation, key, "key is empty");
    }
    if (key.includes("\0")) {
      throw new StorageKeyError(operation, key, "key contains a null byte");
    }
    const target = resolve(rootResolved, key);
    if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
      throw new StorageKeyError(operation, key, "key escapes the storage root");
    }
    return target;
  }

  return {
    async get(key): Promise<Buffer | null> {
      const target = resolveKey("get", key);
      try {
        return await readFile(target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new StorageError("get", key, { cause });
      }
    },

    async has(key): Promise<boolean> {
      const target = resolveKey("has", key);
      try {
        await access(target);
        return true;
      } catch {
        return false;
      }
    },

    async put(key, data): Promise<void> {
      const target = resolveKey("put", key);
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}-${tmpCounter++}`;
      try {
        await writeFile(tmp, data);
        await rename(tmp, target);
      } catch (cause) {
        await unlink(tmp).catch(() => {});
        throw new StorageError("put", key, { cause });
      }
    },

    async list(prefix = ""): Promise<string[]> {
      try {
        const entries = await readdir(rootResolved, { recursive: true, withFileTypes: true });
        const keys: string[] = [];
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const key = relative(rootResolved, join(entry.parentPath, entry.name))
            .split(sep)
            .join("/");
          // Never surface an in-flight atomic-write temp file as a key.
          if (key.includes(".tmp-")) continue;
          if (key.startsWith(prefix)) keys.push(key);
        }
        return keys.sort();
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new StorageError("list", undefined, { cause });
      }
    },
  };
}
