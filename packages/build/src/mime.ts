import { extname } from "node:path";

/**
 * Content types for served assets, by extension. Small on purpose: these are
 * the file kinds documentation actually ships. Anything unknown streams as
 * octet-stream, which downloads rather than renders; that is the safe default
 * for a type we have not reasoned about.
 */
const MIME: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function assetContentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}
