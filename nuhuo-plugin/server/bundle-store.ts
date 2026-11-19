import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostBundleSchema, type HostBundle } from "../shared/bundle";

export const BUNDLE_PATH_ENV = "NUHUO_PASEO_BUNDLE";
const DEFAULT_BUNDLE_PATH = path.join(".nuhuo", "paseo", "host-bundle.json");

export type BundleState =
  | { state: "ready"; path: string; bundle: HostBundle }
  | { state: "missing" | "invalid" | "expired"; path: string; message: string; detail?: string };

type ParsedFile = { ok: true; bundle: HostBundle } | { ok: false; detail: string };

interface CachedFile {
  mtimeMs: number;
  size: number;
  parsed: ParsedFile;
}

export function resolveBundlePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[BUNDLE_PATH_ENV]?.trim();
  if (!configured) return path.join(os.homedir(), DEFAULT_BUNDLE_PATH);
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
  return path.resolve(configured);
}

/** The directory Nuhuo writes `secretRef` files into, next to the bundle. */
export function secretsDirectoryFor(bundlePath: string): string {
  return path.join(path.dirname(bundlePath), "secrets");
}

/**
 * Reads the host bundle on demand. Nuhuo replaces the file atomically, so every read sees a whole
 * file; the cache only skips re-parsing an unchanged one.
 */
export class BundleStore {
  private cached: CachedFile | null = null;

  constructor(
    readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(): Promise<BundleState> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(this.filePath);
    } catch (error) {
      if (isMissingFile(error)) {
        this.cached = null;
        return {
          state: "missing",
          path: this.filePath,
          message:
            "Nuhuo has not set up this host yet. Ask your Nuhuo administrator to provision it.",
        };
      }
      throw error;
    }

    const cached = this.cached;
    const parsed =
      cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size
        ? cached.parsed
        : await this.parse(info.mtimeMs, info.size);

    if (!parsed.ok) {
      return {
        state: "invalid",
        path: this.filePath,
        message:
          "This host's Nuhuo configuration is invalid. Ask your Nuhuo administrator to reprovision it.",
        detail: parsed.detail,
      };
    }

    const { expiresAt } = parsed.bundle;
    if (expiresAt !== undefined && Date.parse(expiresAt) <= this.now().getTime()) {
      return {
        state: "expired",
        path: this.filePath,
        message: `This host's Nuhuo configuration expired at ${expiresAt}. Ask your Nuhuo administrator to refresh it.`,
      };
    }

    return { state: "ready", path: this.filePath, bundle: parsed.bundle };
  }

  private async parse(mtimeMs: number, size: number): Promise<ParsedFile> {
    const parsed = parseBundle(await readFile(this.filePath, "utf8"));
    this.cached = { mtimeMs, size, parsed };
    return parsed;
  }
}

export function parseBundle(text: string): ParsedFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      detail: `Not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = hostBundleSchema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, detail };
  }
  return { ok: true, bundle: result.data };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
