import { gzipSync } from "node:zlib";

/**
 * A tiny ustar writer for tests: enough structure to exercise the extractor,
 * including pax path overrides and non-file entry kinds.
 */
export interface TarSpec {
  name: string;
  content?: string;
  type?: string;
  /** Emit a pax extended header carrying this path before the entry. */
  paxPath?: string;
}

function header(name: string, size: number, typeflag: string): Buffer {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, "utf8");
  b.write("0000644\0", 100, "utf8");
  b.write("0000000\0", 108, "utf8");
  b.write("0000000\0", 116, "utf8");
  b.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "utf8");
  b.write("00000000000\0", 136, "utf8");
  b.write("        ", 148, "utf8"); // checksum field counts as spaces
  b.write(typeflag, 156, "utf8");
  b.write("ustar", 257, "utf8");
  b.write("00", 263, "utf8");
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return b;
}

function padTo512(data: Buffer): Buffer {
  const rem = data.length % 512;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem)]);
}

function paxRecord(key: string, value: string): Buffer {
  // "<len> key=value\n" where len counts the whole record including itself.
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return Buffer.from(`${len}${body}`, "utf8");
}

export function makeTar(entries: TarSpec[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.paxPath) {
      const pax = paxRecord("path", entry.paxPath);
      blocks.push(header("./PaxHeaders/entry", pax.length, "x"), padTo512(pax));
    }
    const type = entry.type ?? "0";
    const content = Buffer.from(entry.content ?? "", "utf8");
    const size = type === "0" || type === "x" || type === "g" ? content.length : 0;
    blocks.push(header(entry.name, size, type));
    if (size > 0) blocks.push(padTo512(content));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
}

export function makeTarGz(entries: TarSpec[]): Buffer {
  return gzipSync(makeTar(entries));
}

export async function* asStream(data: Buffer, chunkSize = 1000): AsyncIterable<Buffer> {
  for (let i = 0; i < data.length; i += chunkSize) {
    yield data.subarray(i, i + chunkSize);
  }
}
