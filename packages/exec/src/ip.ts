/**
 * IP classification for SSRF defense (spec SR-4). Pure and self-contained (no
 * `node:net`, so the core stays portable across Node and edge runtimes). Parsers
 * are strict; anything unparseable as an IP is treated as "not an IP literal",
 * and `isForbiddenIp` fails closed on an unparseable IP string.
 *
 * Forbidden = loopback, private (RFC 1918), link-local incl. the cloud metadata
 * address 169.254.169.254, CGNAT, unspecified, multicast, and reserved ranges,
 * for IPv4, IPv6, and IPv4-mapped/compatible IPv6.
 */

/** Strict dotted-decimal IPv4 -> 4 octets, or null. No hex/octal (the URL parser normalizes those to decimal before we see them). */
export function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function forbiddenIpv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255 broadcast
  return false;
}

/** IPv6 (with `::`, hex hextets, or an embedded dotted IPv4 tail) -> 8 hextets, or null. */
export function parseIpv6(value: string): number[] | null {
  if (typeof value !== "string" || !value.includes(":")) return null;

  // An embedded IPv4 tail (e.g. ::ffff:1.2.3.4) becomes its two hextets.
  let str = value;
  const lastColon = str.lastIndexOf(":");
  const tail = str.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    str = `${str.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = str.split("::");
  if (halves.length > 2) return null;

  const toHextets = (segment: string): number[] | null => {
    if (segment === "") return [];
    const out: number[] = [];
    for (const piece of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };

  const head = toHextets(halves[0] ?? "");
  if (head === null) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null; // no "::" -> must be exactly 8
  }
  const back = toHextets(halves[1] ?? "");
  if (back === null) return null;
  const fill = 8 - head.length - back.length;
  if (fill < 1) return null; // "::" must stand for at least one zero group
  return [...head, ...new Array<number>(fill).fill(0), ...back];
}

function forbiddenIpv6(h: number[]): boolean {
  const g = (i: number): number => h[i] ?? 0;
  if (h.every((x) => x === 0)) return true; // :: unspecified
  if (h.slice(0, 7).every((x) => x === 0) && g(7) === 1) return true; // ::1 loopback
  if ((g(0) & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g(0) & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g(0) & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  const v4Of = (): number[] => [g(6) >> 8, g(6) & 0xff, g(7) >> 8, g(7) & 0xff];
  // IPv4-mapped ::ffff:a.b.c.d
  if (h.slice(0, 5).every((x) => x === 0) && g(5) === 0xffff) return forbiddenIpv4(v4Of());
  // IPv4-compatible ::a.b.c.d (deprecated) - first six groups zero, and not :: / ::1
  if (h.slice(0, 6).every((x) => x === 0) && (g(6) !== 0 || g(7) > 1)) return forbiddenIpv4(v4Of());
  return false;
}

/** Whether a host string is an IP literal (v4 or v6), as opposed to a domain name. */
export function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

/** SR-4: is this IP in a forbidden range? Fails closed (true) on an unparseable IP. */
export function isForbiddenIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return forbiddenIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6) return forbiddenIpv6(v6);
  return true;
}
