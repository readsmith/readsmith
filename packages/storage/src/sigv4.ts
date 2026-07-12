import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 for the small, fixed S3 surface the store uses
 * (Get/Head/Put/Delete/ListObjectsV2). Hand-rolled rather than pulling the AWS
 * SDK: five operations over simple keys do not justify megabytes of
 * dependency, and the algorithm is deterministic crypto that pins exactly to
 * AWS's published test vector (see the test suite). Nothing here logs; the
 * secret key exists only inside the HMAC chain.
 */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Signing service, always "s3" here. */
  service?: string;
}

export interface SignableRequest {
  method: string;
  /** Absolute path, already RFC3986-encoded per segment (slashes kept). */
  path: string;
  /** Query parameters, raw (encoding happens here). */
  query?: Record<string, string>;
  /** Host header value (with port when non-default). */
  host: string;
  /** SHA-256 hex of the payload ("" hashes for bodyless requests). */
  payloadHash: string;
  /** ISO basic-format timestamp, e.g. 20260712T000000Z. */
  amzDate: string;
}

const sha256hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

export const EMPTY_PAYLOAD_HASH = sha256hex("");

export function hashPayload(data: string | Buffer): string {
  return sha256hex(data);
}

/** Strict RFC3986 encoding (S3 canonical form): unreserved chars only. */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode an object key as a canonical URI path, keeping `/` as the separator. */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(rfc3986).join("/");
}

export function amzDateNow(nowMs: number): string {
  return new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Canonical (and actual) query-string form: sorted keys, strict RFC3986. */
export function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k] ?? "")}`)
    .join("&");
}

/**
 * Compute the Authorization header (plus the headers that must accompany it)
 * for a request. Signed headers are fixed to host + x-amz-content-sha256 +
 * x-amz-date: the store never sends others that need signing.
 */
export function signRequest(
  credentials: SigV4Credentials,
  request: SignableRequest,
): { authorization: string; "x-amz-content-sha256": string; "x-amz-date": string } {
  const service = credentials.service ?? "s3";
  const date = request.amzDate.slice(0, 8);
  const scope = `${date}/${credentials.region}/${service}/aws4_request`;

  const canonicalHeaders =
    `host:${request.host}\n` +
    `x-amz-content-sha256:${request.payloadHash}\n` +
    `x-amz-date:${request.amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    request.method,
    request.path,
    canonicalQuery(request.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    request.amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, date);
  const kRegion = hmac(kDate, credentials.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": request.payloadHash,
    "x-amz-date": request.amzDate,
  };
}
