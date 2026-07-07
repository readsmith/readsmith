import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Blob storage for the large JSON payloads (raw/bundled/normalized specs) that
 * do not belong inline in a row. Content-addressed: the same bytes always map to
 * the same ref, so writes dedupe and reads are deterministic. The filesystem
 * default needs no external service; the interface leaves room for an
 * S3-compatible backend in the hosted phase without touching callers.
 */
export interface Storage {
  /** Store bytes, returning a stable content-addressed reference. */
  put(data: string | Uint8Array): Promise<string>;
  /** Read bytes back by reference. Throws if the ref is unknown. */
  get(ref: string): Promise<Buffer>;
  /** Whether a ref currently resolves to stored bytes. */
  has(ref: string): Promise<boolean>;
}

const REF_PREFIX = "sha256:";

function refFor(data: string | Uint8Array): string {
  return REF_PREFIX + createHash("sha256").update(data).digest("hex");
}

/** Map a content ref to a sharded path under the storage root. */
function pathFor(root: string, ref: string): string {
  const hex = ref.slice(REF_PREFIX.length);
  return join(root, hex.slice(0, 2), hex.slice(2));
}

/** A filesystem-backed, content-addressed Storage rooted at a directory. */
export function createFsStorage(root: string): Storage {
  return {
    async put(data): Promise<string> {
      const ref = refFor(data);
      const target = pathFor(root, ref);
      await mkdir(dirname(target), { recursive: true });
      // Content-addressed, so an existing file already holds identical bytes.
      await writeFile(target, data);
      return ref;
    },
    async get(ref): Promise<Buffer> {
      return readFile(pathFor(root, ref));
    },
    async has(ref): Promise<boolean> {
      try {
        await readFile(pathFor(root, ref));
        return true;
      } catch {
        return false;
      }
    },
  };
}
