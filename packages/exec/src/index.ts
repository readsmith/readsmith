// @readsmith/exec - SSRF-safe request-execution primitive.
// Slice 0: the pure target-validation core (no network). The pinned-connect
// transport, request construction, auth injection, and the proxy route compose
// on top of this in later slices (see specs/playground/exec-proxy.spec.md).

export {
  EXEC_ERROR_CODES,
  type ExecError,
  type ExecErrorCode,
  execError,
  isExecError,
} from "./errors.js";
export { isForbiddenIp, isIpLiteral, parseIpv4, parseIpv6 } from "./ip.js";
export { buildRequest, redactHeaders } from "./request.js";
export { type ProxyRequestWire, parseProxyRequest, proxyRequestSchema } from "./schema.js";
export type {
  AuthInjection,
  ExecBody,
  ExecPolicy,
  ExecRequest,
  ExecResult,
  MultipartPart,
  PreparedRequest,
} from "./types.js";
export { type ParsedTarget, parseTarget } from "./url.js";
export {
  type AllowlistEntry,
  type TargetAllowlist,
  allowlistFromServers,
  checkResolvedIp,
  checkTarget,
} from "./validate.js";
