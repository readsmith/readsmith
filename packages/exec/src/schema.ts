import { z } from "zod";
import { type ExecError, execError } from "./errors.js";
import type { ExecRequest, MultipartPart } from "./types.js";

/**
 * The wire schema for a proxy request from the browser. This is the trust
 * boundary (spec "validate at boundaries"): the JSON is validated here before
 * anything reaches the executor. It is JSON-friendly (file bytes arrive as
 * base64 `dataBase64`, decoded into the in-process `Uint8Array`).
 */
const authSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("apiKey"),
    in: z.enum(["header", "query", "cookie"]),
    name: z.string().min(1),
    value: z.string(),
  }),
  z.object({ kind: z.literal("bearer"), token: z.string() }),
  z.object({ kind: z.literal("basic"), username: z.string(), password: z.string() }),
]);

const multipartPartSchema = z.union([
  z.object({ name: z.string().min(1), value: z.string() }),
  z.object({
    name: z.string().min(1),
    filename: z.string(),
    contentType: z.string().optional(),
    dataBase64: z.string(),
  }),
]);

const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), value: z.unknown() }),
  z.object({
    kind: z.literal("form"),
    value: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  }),
  z.object({ kind: z.literal("multipart"), parts: z.array(multipartPartSchema).max(50) }),
  z.object({ kind: z.literal("raw"), value: z.string(), contentType: z.string().optional() }),
]);

export const proxyRequestSchema = z.object({
  method: z.string().min(1).max(20),
  url: z.string().min(1).max(4000),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  body: bodySchema.optional(),
  auth: authSchema.optional(),
});
export type ProxyRequestWire = z.infer<typeof proxyRequestSchema>;

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}

function toExecRequest(wire: ProxyRequestWire): ExecRequest {
  let body: ExecRequest["body"];
  if (wire.body?.kind === "multipart") {
    const parts: MultipartPart[] = wire.body.parts.map((p) =>
      "dataBase64" in p
        ? {
            name: p.name,
            filename: p.filename,
            contentType: p.contentType,
            data: decodeBase64(p.dataBase64),
          }
        : { name: p.name, value: p.value },
    );
    body = { kind: "multipart", parts };
  } else if (wire.body) {
    body = wire.body;
  }
  return {
    method: wire.method,
    url: wire.url,
    headers: wire.headers,
    query: wire.query,
    body,
    auth: wire.auth,
  };
}

/**
 * Validate the browser's JSON proxy request into an `ExecRequest`, or a typed
 * `DENIED_MALFORMED_URL` on any shape/base64 failure. Never throws. This is the
 * only place untrusted client JSON crosses into the executor.
 */
export function parseProxyRequest(json: unknown): ExecRequest | ExecError {
  const parsed = proxyRequestSchema.safeParse(json);
  if (!parsed.success)
    return execError("DENIED_MALFORMED_URL", "The playground request is malformed.");
  try {
    return toExecRequest(parsed.data);
  } catch {
    return execError("DENIED_MALFORMED_URL", "A file attachment is not valid base64.");
  }
}
