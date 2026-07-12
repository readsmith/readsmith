import { describe, expect, it } from "vitest";
import { StorageError, StorageKeyError } from "../src/port.js";
import { createS3Store } from "../src/s3.js";
import { EMPTY_PAYLOAD_HASH, signRequest } from "../src/sigv4.js";

/**
 * The two S3 GET examples from AWS's "Authenticating Requests (AWS Signature
 * Version 4)" documentation, which sign exactly the header set this driver
 * uses (host + x-amz-content-sha256 + x-amz-date). Pinning to the published
 * vectors proves the algorithm; the MinIO conformance run proves it end to end.
 */
const AWS_DOC_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};

describe("sigv4", () => {
  it("matches the AWS documentation vector: GET bucket lifecycle", () => {
    const headers = signRequest(AWS_DOC_CREDENTIALS, {
      method: "GET",
      path: "/",
      query: { lifecycle: "" },
      host: "examplebucket.s3.amazonaws.com",
      payloadHash: EMPTY_PAYLOAD_HASH,
      amzDate: "20130524T000000Z",
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    );
  });

  it("matches the AWS documentation vector: list objects", () => {
    const headers = signRequest(AWS_DOC_CREDENTIALS, {
      method: "GET",
      path: "/",
      query: { "max-keys": "2", prefix: "J" },
      host: "examplebucket.s3.amazonaws.com",
      payloadHash: EMPTY_PAYLOAD_HASH,
      amzDate: "20130524T000000Z",
    });
    expect(headers.authorization).toContain(
      "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function storeWith(handler: Handler) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    return handler(url, init ?? {});
  }) as typeof fetch;
  const store = createS3Store({
    endpoint: "http://localhost:9000",
    bucket: "test-bucket",
    accessKeyId: "ak",
    secretAccessKey: "super-secret-value",
    region: "auto",
    fetchImpl,
  });
  return { store, calls };
}

describe("createS3Store", () => {
  it("maps 404 to null/false/no-op, never a throw", async () => {
    const { store } = storeWith(() => new Response("nope", { status: 404 }));
    expect(await store.get("missing.json")).toBeNull();
    expect(await store.has("missing.json")).toBe(false);
    await store.delete("missing.json"); // idempotent
  });

  it("round-trips bytes and drains write responses", async () => {
    const objects = new Map<string, Buffer>();
    const { store } = storeWith(async (url, init) => {
      const key = decodeURIComponent(new URL(url).pathname.replace("/test-bucket/", ""));
      if (init.method === "PUT") {
        objects.set(key, Buffer.from(await new Request(url, init).arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      const body = objects.get(key);
      return body
        ? new Response(new Uint8Array(body), { status: 200 })
        : new Response(null, { status: 404 });
    });
    const payload = Buffer.from([0, 1, 2, 250, 251]);
    await store.put("bundles/x.json", payload);
    expect(await store.get("bundles/x.json")).toEqual(payload);
  });

  it("paginates list responses and decodes XML entities", async () => {
    let page = 0;
    const { store, calls } = storeWith(() => {
      page += 1;
      if (page === 1) {
        return new Response(
          `<ListBucketResult><IsTruncated>true</IsTruncated>
           <Contents><Key>render/a&amp;b.json</Key></Contents>
           <NextContinuationToken>tok+with/специальные=chars</NextContinuationToken>
           </ListBucketResult>`,
          { status: 200 },
        );
      }
      return new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated>
         <Contents><Key>render/z.json</Key></Contents></ListBucketResult>`,
        { status: 200 },
      );
    });
    expect(await store.list("render/")).toEqual(["render/a&b.json", "render/z.json"]);
    // The continuation token must be carried, canonically encoded.
    expect(calls[1]?.url).toContain("continuation-token=");
    expect(calls[1]?.url).not.toContain("+with"); // '+' must be %2B, not form-encoded
  });

  it("enforces the shared key discipline", async () => {
    const { store } = storeWith(() => new Response(null, { status: 200 }));
    for (const bad of ["../escape", "/etc/passwd", "a/../../b", ""]) {
      await expect(store.put(bad, "x")).rejects.toBeInstanceOf(StorageKeyError);
      await expect(store.get(bad)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(store.delete(bad)).rejects.toBeInstanceOf(StorageKeyError);
    }
  });

  it("surfaces faults as typed errors that never carry the secret", async () => {
    const { store } = storeWith(() => new Response("denied", { status: 403 }));
    const err = await store.get("bundles/x.json").then(
      () => null,
      (e) => e as StorageError,
    );
    expect(err).toBeInstanceOf(StorageError);
    expect(String(err)).toContain("get");
    expect(String(err)).not.toContain("super-secret-value");
    expect(String(err?.cause ?? "")).not.toContain("super-secret-value");
  });
});
