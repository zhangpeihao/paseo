import { createHash } from "node:crypto";
import type { AssetFile } from "../shared/catalog";

// These mirror Nuhuo's `src/core/nuhuo/release.ts`; a digest that differs refuses the download.

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record)
    .filter((candidate) => record[candidate] !== undefined)
    .sort((a, b) => a.localeCompare(b))) {
    sorted[key] = canonicalize(record[key]);
  }
  return sorted;
}

export function canonicalJsonDigest(value: unknown): string {
  return `sha256:${sha256(JSON.stringify(canonicalize(value)))}`;
}

export function textDigest(content: string): string {
  return `sha256:${sha256(content.replace(/\r\n/g, "\n"))}`;
}

/** The digest Nuhuo gives a Skill or tool directory: its sorted file manifest. */
export function filesDigest(files: readonly AssetFile[]): string {
  const manifest = files
    .map((file) =>
      file.mode === "symlink"
        ? { path: file.relativePath, mode: file.mode, linkTarget: file.linkTarget }
        : {
            path: file.relativePath,
            mode: file.mode,
            digest: `sha256:${sha256(Buffer.from(file.contentBase64, "base64"))}`,
          },
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  return canonicalJsonDigest({ files: manifest });
}

/** A short, stable name for a value that must not be stored, such as a pairing offer. */
export function fingerprint(value: string): string {
  return sha256(value).slice(0, 16);
}
