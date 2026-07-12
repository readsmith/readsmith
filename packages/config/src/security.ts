/**
 * The Content-Security-Policy and the security headers that travel with it.
 *
 * A note on `'unsafe-inline'` in `script-src`. Next injects inline bootstrap
 * scripts on every page, and the reading shell injects an inline theme script to
 * avoid a flash of the wrong theme. Replacing those with a nonce would force
 * every page to render dynamically, which trades away the static-first serving
 * this project is built on. Hashes are not workable either: Next's inline
 * payloads differ per page and per build.
 *
 * So the policy keeps `'unsafe-inline'` for scripts and drops `'unsafe-eval'`
 * outside development. The consequence has to be stated plainly: **this CSP does
 * not contain an inline-script injection.** Anything we interpolate into a
 * `<script>` must be escaped at the source, which is why the JSON-LD payload is
 * serialized with `<` rather than trusting the policy to catch it.
 */

/** Extra source tokens an operator or a site may admit, by directive. */
export interface CspExtensions {
  imgSrc?: string[];
  /** External script hosts (analytics providers add theirs automatically). */
  scriptSrc?: string[];
  connectSrc?: string[];
  fontSrc?: string[];
  frameSrc?: string[];
  frameAncestors?: string[];
}

export interface SecurityHeaderOptions {
  csp?: CspExtensions;
  /** Development relaxes the policy for HMR (eval, websockets) and drops HSTS. */
  development?: boolean;
}

export interface HttpHeader {
  key: string;
  value: string;
}

/**
 * A CSP source token is a bare word, a scheme, a host, or a quoted keyword. It
 * may never contain a semicolon, a comma, or whitespace: those end a directive,
 * so an unvalidated token from `docs.yaml` could append `script-src *` to the
 * policy. Tokens that fail this are dropped rather than sanitized, because a
 * half-understood source is not a source anyone meant to allow.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_\-.:/*'[\]%?=+~]+$/;

export function isSafeCspToken(token: string): boolean {
  return SAFE_TOKEN.test(token) && !token.includes(";") && !token.includes(",");
}

function clean(tokens: string[] | undefined): string[] {
  return (tokens ?? []).map((t) => t.trim()).filter((t) => t !== "" && isSafeCspToken(t));
}

/** Preserve order, drop duplicates. Determinism matters: this lands in a manifest. */
function unique(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

export function buildContentSecurityPolicy(options: SecurityHeaderOptions = {}): string {
  const dev = options.development ?? false;
  const ext = options.csp ?? {};

  const frameAncestors = clean(ext.frameAncestors);
  const frameSrc = clean(ext.frameSrc);

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", frameAncestors.length > 0 ? frameAncestors : ["'none'"]],
    // See the module header: inline is required, eval is not.
    [
      "script-src",
      ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), ...clean(ext.scriptSrc)],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", ...clean(ext.imgSrc)]],
    ["font-src", ["'self'", "data:", ...clean(ext.fontSrc)]],
    ["connect-src", ["'self'", ...(dev ? ["ws:"] : []), ...clean(ext.connectSrc)]],
    ["frame-src", frameSrc.length > 0 ? frameSrc : ["'none'"]],
    ["manifest-src", ["'self'"]],
  ];
  if (!dev) directives.push(["upgrade-insecure-requests", []]);

  return directives
    .map(([name, values]) => {
      const tokens = unique(values);
      return tokens.length > 0 ? `${name} ${tokens.join(" ")}` : name;
    })
    .join("; ");
}

export function securityHeaders(options: SecurityHeaderOptions = {}): HttpHeader[] {
  const dev = options.development ?? false;
  const headers: HttpHeader[] = [
    { key: "Content-Security-Policy", value: buildContentSecurityPolicy(options) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
  // Never pin HSTS from a local http dev server.
  if (!dev) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    });
  }
  return headers;
}

/** Split a space or comma separated env value into tokens. */
function envTokens(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).filter(Boolean);
}

/**
 * The operator's environment adds to the site's `security.csp`, it does not
 * replace it. The person holding the server may not control the docs repository,
 * and the docs author may need a badge host the operator has never heard of.
 */
export function mergeCspFromEnv(
  csp: CspExtensions,
  env: Record<string, string | undefined>,
): CspExtensions {
  return {
    imgSrc: [...(csp.imgSrc ?? []), ...envTokens(env.READSMITH_CSP_IMG_SRC)],
    connectSrc: [...(csp.connectSrc ?? []), ...envTokens(env.READSMITH_CSP_CONNECT_SRC)],
    fontSrc: [...(csp.fontSrc ?? []), ...envTokens(env.READSMITH_CSP_FONT_SRC)],
    frameSrc: [...(csp.frameSrc ?? []), ...envTokens(env.READSMITH_CSP_FRAME_SRC)],
    frameAncestors: [
      ...(csp.frameAncestors ?? []),
      ...envTokens(env.READSMITH_CSP_FRAME_ANCESTORS),
    ],
  };
}
