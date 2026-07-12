import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

/**
 * Minimal, guarded extraction of the provider tarball (ustar/pax, as `git
 * archive` produces). Deliberately hand-rolled and read-only: regular files and
 * directories materialize, nothing else does (no symlinks, no hardlinks, no
 * device nodes), every path is confined to the destination directory, and hard
 * caps bound entries and total bytes so a hostile-but-authorized repo cannot
 * exhaust the worker. Supports the header extensions GitHub tarballs actually
 * use: pax extended headers (`x`, for long paths), the pax global header (`g`,
 * skipped), and GNU longname (`L`).
 */
export interface TarLimits {
  /** Maximum entries (files + directories + skipped kinds). */
  maxEntries: number;
  /** Maximum total uncompressed file bytes. */
  maxTotalBytes: number;
}

export interface TarExtractResult {
  files: number;
  bytes: number;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

const BLOCK = 512;

function str(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
}

function octal(block: Buffer, offset: number, length: number): number {
  const text = str(block, offset, length).trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value) || value < 0) throw new TarError("invalid numeric field in tar header");
  return value;
}

/** Parse pax records (`"<len> key=value\n"` repeated); return the path override, if any. */
function paxPath(content: Buffer): string | null {
  const text = content.toString("utf8");
  let i = 0;
  let path: string | null = null;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space === -1) break;
    const len = Number.parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, i + len - 1); // trailing \n dropped
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") path = record.slice(eq + 1);
    i += len;
  }
  return path;
}

/**
 * Strip leading path components (the tarball's `{owner}-{repo}-{sha}/` root)
 * and validate what remains: no absolute paths, no `..` segments, forward
 * slashes only. Returns null when the entry dissolves entirely (the root dir).
 */
function safeRelativePath(name: string, stripComponents: number): string | null {
  if (name.startsWith("/") || name.includes("\\")) {
    throw new TarError(`tar entry escapes the destination: ${name}`);
  }
  const segments = name.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new TarError(`tar entry escapes the destination: ${name}`);
  }
  const rest = segments.slice(stripComponents);
  if (rest.length === 0) return null;
  return rest.join("/");
}

interface PendingOverrides {
  path: string | null;
}

/**
 * Extract a (already-decompressed) tar stream into `destDir`. The destination
 * must exist and be caller-owned; a resolved write target outside it is a
 * `TarError`, never a write.
 */
export async function extractTar(
  input: Readable | AsyncIterable<Buffer | Uint8Array>,
  destDir: string,
  options: { stripComponents: number; limits: TarLimits },
): Promise<TarExtractResult> {
  const root = resolve(destDir);
  const { stripComponents, limits } = options;
  let pending = Buffer.alloc(0);
  let entries = 0;
  let files = 0;
  let bytes = 0;
  let ended = false;
  const overrides: PendingOverrides = { path: null };

  const iterator = input[Symbol.asyncIterator]();

  async function need(n: number): Promise<Buffer | null> {
    while (pending.length < n) {
      const { value, done } = await iterator.next();
      if (done) return null;
      pending = Buffer.concat([pending, Buffer.from(value)]);
    }
    const out = pending.subarray(0, n);
    pending = pending.subarray(n);
    return Buffer.from(out);
  }

  async function writeEntryFile(rel: string, content: Buffer): Promise<void> {
    const target = resolve(join(root, rel));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new TarError(`tar entry escapes the destination: ${rel}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  while (!ended) {
    const header = await need(BLOCK);
    if (header === null) break; // truncated end is tolerated after content
    if (header.every((b) => b === 0)) {
      ended = true;
      break;
    }
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = octal(header, 124, 12);
    const prefix = str(header, 345, 155);
    const shortName = str(header, 0, 100);
    const headerName = prefix ? `${prefix}/${shortName}` : shortName;
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    // Meta entries modify the next real entry and are not counted or capped.
    if (typeflag === "x" || typeflag === "g" || typeflag === "L") {
      const content = size > 0 ? await need(padded) : Buffer.alloc(0);
      if (content === null) throw new TarError("truncated tar stream");
      const body = content.subarray(0, size);
      if (typeflag === "x") overrides.path = paxPath(body) ?? overrides.path;
      if (typeflag === "L") overrides.path = str(body, 0, body.length) || overrides.path;
      continue;
    }

    entries += 1;
    if (entries > limits.maxEntries) {
      throw new TarError(`tar exceeds the entry cap (${limits.maxEntries})`);
    }

    const name = overrides.path ?? headerName;
    overrides.path = null;
    const rel = safeRelativePath(name, stripComponents);

    if (typeflag === "5") {
      if (size > 0) {
        if ((await need(padded)) === null) throw new TarError("truncated tar stream");
      }
      if (rel !== null) {
        const target = resolve(join(root, rel));
        if (target !== root && !target.startsWith(root + sep)) {
          throw new TarError(`tar entry escapes the destination: ${rel}`);
        }
        await mkdir(target, { recursive: true });
      }
      continue;
    }

    if (typeflag === "0" || typeflag === "\0") {
      bytes += size;
      if (bytes > limits.maxTotalBytes) {
        throw new TarError(`tar exceeds the size cap (${limits.maxTotalBytes} bytes)`);
      }
      const content = size > 0 ? await need(padded) : Buffer.alloc(0);
      if (content === null) throw new TarError("truncated tar stream");
      if (rel !== null) {
        await writeEntryFile(rel, content.subarray(0, size));
        files += 1;
      }
      continue;
    }

    // Everything else (symlinks, hardlinks, fifos, devices) is skipped, never
    // materialized; its content blocks are consumed and discarded.
    if (size > 0) {
      if ((await need(padded)) === null) throw new TarError("truncated tar stream");
    }
  }

  return { files, bytes };
}
