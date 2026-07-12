import { type BundleStore, StorageError, StorageKeyError } from "./port.js";
import {
  EMPTY_PAYLOAD_HASH,
  amzDateNow,
  canonicalQuery,
  encodeKeyPath,
  hashPayload,
  signRequest,
} from "./sigv4.js";

/**
 * An S3-compatible BundleStore over plain fetch + SigV4: Cloudflare R2 for the
 * hosted path, MinIO (or any S3) for self-host. Path-style addressing
 * (`{endpoint}/{bucket}/{key}`), which both require or accept. Same key
 * discipline as the local driver, same conformance suite; objects here are
 * small (bundles, render-cache entries), so requests are single-shot buffers -
 * no multipart, no streams, and no presigning (a hosted concern layered above
 * the port).
 */
export interface S3StoreOptions {
  /** Scheme + host (+ port), e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** SigV4 region; R2 uses "auto", MinIO accepts anything. */
  region: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms) for request signing. */
  now?: () => number;
}

/** The same traversal discipline as the local driver, minus host-path concerns. */
function assertKey(operation: string, key: string): string {
  if (key.length === 0) throw new StorageKeyError(operation, key, "key is empty");
  if (key.includes("\0")) throw new StorageKeyError(operation, key, "key contains a null byte");
  if (key.startsWith("/") || key.includes("\\")) {
    throw new StorageKeyError(operation, key, "key escapes the storage root");
  }
  if (key.split("/").some((segment) => segment === "..")) {
    throw new StorageKeyError(operation, key, "key escapes the storage root");
  }
  return key;
}

/** Decode the five XML entities S3 list responses may carry in keys. */
function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function textOf(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1] ?? null;
}

export function createS3Store(options: S3StoreOptions): BundleStore {
  const endpoint = options.endpoint.replace(/\/$/, "");
  const host = new URL(endpoint).host;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const credentials = {
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    region: options.region,
  };

  async function request(input: {
    operation: string;
    method: string;
    key?: string;
    query?: Record<string, string>;
    body?: string | Uint8Array;
  }): Promise<Response> {
    const keyPath = input.key !== undefined ? `/${encodeKeyPath(input.key)}` : "";
    const path = `/${encodeKeyPath(options.bucket)}${keyPath}`;
    const payload =
      input.body === undefined
        ? undefined
        : typeof input.body === "string"
          ? Buffer.from(input.body)
          : Buffer.from(input.body);
    const headers = signRequest(credentials, {
      method: input.method,
      path,
      query: input.query,
      host,
      payloadHash: payload === undefined ? EMPTY_PAYLOAD_HASH : hashPayload(payload),
      amzDate: amzDateNow(now()),
    });
    // The URL must carry the query encoded exactly as it was signed.
    const canonical = input.query ? canonicalQuery(input.query) : "";
    const queryString = canonical ? `?${canonical}` : "";
    try {
      return await fetchImpl(`${endpoint}${path}${queryString}`, {
        method: input.method,
        headers,
        // Buffer satisfies fetch's body type at runtime; DOM lib types are not
        // loaded in this tsconfig, so the parameter type does the narrowing.
        body: payload as Parameters<typeof fetch>[1] extends { body?: infer B } ? B : never,
      });
    } catch (cause) {
      throw new StorageError(input.operation, input.key, { cause });
    }
  }

  return {
    async get(key): Promise<Buffer | null> {
      assertKey("get", key);
      const res = await request({ operation: "get", method: "GET", key });
      if (res.status === 404) return null;
      if (!res.ok) throw new StorageError("get", key, { cause: `HTTP ${res.status}` });
      return Buffer.from(await res.arrayBuffer());
    },

    async has(key): Promise<boolean> {
      assertKey("has", key);
      const res = await request({ operation: "has", method: "HEAD", key });
      if (res.status === 404) return false;
      if (!res.ok) throw new StorageError("has", key, { cause: `HTTP ${res.status}` });
      return true;
    },

    async put(key, data): Promise<void> {
      assertKey("put", key);
      const res = await request({ operation: "put", method: "PUT", key, body: data });
      if (!res.ok) throw new StorageError("put", key, { cause: `HTTP ${res.status}` });
      // Drain so the connection returns to the pool.
      await res.arrayBuffer().catch(() => {});
    },

    async list(prefix = ""): Promise<string[]> {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const query: Record<string, string> = { "list-type": "2" };
        if (prefix) query.prefix = prefix;
        if (continuationToken) query["continuation-token"] = continuationToken;
        const res = await request({ operation: "list", method: "GET", query });
        if (!res.ok) throw new StorageError("list", undefined, { cause: `HTTP ${res.status}` });
        const xml = await res.text();
        for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
          keys.push(decodeXml(match[1] ?? ""));
        }
        continuationToken =
          textOf(xml, "IsTruncated") === "true"
            ? (decodeXml(textOf(xml, "NextContinuationToken") ?? "") ?? undefined)
            : undefined;
      } while (continuationToken);
      return keys.sort();
    },

    async delete(key): Promise<void> {
      assertKey("delete", key);
      const res = await request({ operation: "delete", method: "DELETE", key });
      // 204 on success, and S3 deletes are idempotent (absent key is still 204);
      // some implementations answer 404, which the port also treats as a no-op.
      if (!res.ok && res.status !== 404) {
        throw new StorageError("delete", key, { cause: `HTTP ${res.status}` });
      }
      await res.arrayBuffer().catch(() => {});
    },
  };
}
