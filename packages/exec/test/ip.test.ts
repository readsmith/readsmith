import { describe, expect, it } from "vitest";
import { isForbiddenIp, isIpLiteral, parseIpv4, parseIpv6 } from "../src/ip.js";

describe("parseIpv4", () => {
  it("parses strict dotted-decimal, rejects everything else", () => {
    expect(parseIpv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(parseIpv4("255.255.255.255")).toEqual([255, 255, 255, 255]);
    expect(parseIpv4("256.0.0.1")).toBeNull();
    expect(parseIpv4("1.2.3")).toBeNull();
    expect(parseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseIpv4("0x7f000001")).toBeNull(); // hex is not dotted-decimal
    expect(parseIpv4("example.com")).toBeNull();
  });
});

describe("parseIpv6", () => {
  it("expands :: and embedded IPv4 tails", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("fe80::1")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::ffff:169.254.169.254")).toEqual([0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe]);
    expect(parseIpv6("2001:db8::1")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("not:valid:g")).toBeNull();
    expect(parseIpv6("1:2:3:4:5:6:7")).toBeNull(); // 7 groups, no ::
    expect(parseIpv6("example.com")).toBeNull();
  });
});

describe("isForbiddenIp (SR-4)", () => {
  const forbidden = [
    "0.0.0.0",
    "10.0.0.5",
    "127.0.0.1",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1", // CGNAT
    "192.0.0.1",
    "198.18.0.1",
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
    "255.255.255.255", // broadcast
    "::1",
    "::",
    "fe80::1", // link-local
    "fc00::1", // unique-local
    "fd00::1",
    "ff02::1", // multicast
    "::ffff:169.254.169.254", // IPv4-mapped metadata
    "::ffff:127.0.0.1",
    "garbage", // unparseable -> fail closed
  ];
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34", // example.com
    "172.15.0.1", // just below 172.16/12
    "172.32.0.1", // just above
    "100.63.0.1", // just below CGNAT
    "100.128.0.1", // just above
    "223.255.255.255", // just below multicast
    "2606:4700:4700::1111", // public IPv6 (Cloudflare)
    "::ffff:8.8.8.8", // IPv4-mapped public
  ];

  it.each(forbidden)("denies %s", (ip) => expect(isForbiddenIp(ip)).toBe(true));
  it.each(allowed)("allows %s", (ip) => expect(isForbiddenIp(ip)).toBe(false));
});

describe("isIpLiteral", () => {
  it("distinguishes IP literals from domains", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("api.example.com")).toBe(false);
    expect(isIpLiteral("localhost")).toBe(false);
  });
});
