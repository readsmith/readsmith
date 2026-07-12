import { describe } from "vitest";
import { createS3Store } from "../src/s3.js";
import { EMPTY_PAYLOAD_HASH, amzDateNow, signRequest } from "../src/sigv4.js";
import { runBundleStoreConformance } from "./conformance.js";

/**
 * The port conformance suite against a real S3 implementation. Runs when a
 * disposable MinIO is available:
 *   TEST_S3_ENDPOINT=http://localhost:9000
 *   TEST_S3_ACCESS_KEY_ID=... TEST_S3_SECRET_ACCESS_KEY=...
 * Each test gets its own freshly-created bucket, so stores start empty exactly
 * like the local driver's mkdtemp root (bucket creation itself exercises the
 * signer against the real server).
 */
const ENDPOINT = process.env.TEST_S3_ENDPOINT;
const ACCESS = process.env.TEST_S3_ACCESS_KEY_ID ?? "minioadmin";
const SECRET = process.env.TEST_S3_SECRET_ACCESS_KEY ?? "minioadmin";
const REGION = process.env.TEST_S3_REGION ?? "auto";

let bucketSeq = 0;

async function createBucket(name: string): Promise<void> {
  const endpoint = (ENDPOINT ?? "").replace(/\/$/, "");
  const headers = signRequest(
    { accessKeyId: ACCESS, secretAccessKey: SECRET, region: REGION },
    {
      method: "PUT",
      path: `/${name}`,
      host: new URL(endpoint).host,
      payloadHash: EMPTY_PAYLOAD_HASH,
      amzDate: amzDateNow(Date.now()),
    },
  );
  const res = await fetch(`${endpoint}/${name}`, { method: "PUT", headers });
  if (!res.ok) throw new Error(`could not create test bucket ${name}: HTTP ${res.status}`);
  await res.arrayBuffer().catch(() => {});
}

describe.skipIf(!ENDPOINT)("s3 BundleStore - port conformance (MinIO)", () => {
  runBundleStoreConformance(async () => {
    const name = `rs-conf-${process.pid}-${Date.now()}-${bucketSeq++}`;
    await createBucket(name);
    return createS3Store({
      endpoint: ENDPOINT ?? "",
      bucket: name,
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      region: REGION,
    });
  });
});
