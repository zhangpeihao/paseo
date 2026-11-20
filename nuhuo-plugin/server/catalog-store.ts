import { readFile, stat } from "node:fs/promises";
import { hostCatalogSchema, type HostCatalog } from "../shared/catalog";
import { isMissingFile, writeFileAtomic } from "./files";

export type CatalogState =
  | { state: "ready"; path: string; catalog: HostCatalog }
  | { state: "missing" | "invalid" | "expired"; path: string; message: string; detail?: string };

type ParsedFile = { ok: true; catalog: HostCatalog } | { ok: false; detail: string };

interface CachedFile {
  mtimeMs: number;
  size: number;
  parsed: ParsedFile;
}

/**
 * The last good catalog, which create and open decide from. A failed pull leaves it in place until
 * it expires, so a Nuhuo outage stops no work.
 */
export class CatalogStore {
  private cached: CachedFile | null = null;

  constructor(
    readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(): Promise<CatalogState> {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(this.filePath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.cached = null;
      return {
        state: "missing",
        path: this.filePath,
        message:
          "This host has not imported its settings from Nuhuo yet. Open the Nuhuo screen and press Import.",
      };
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
          "This host's Nuhuo settings are unreadable. Open the Nuhuo screen and press Import.",
        detail: parsed.detail,
      };
    }

    const { expiresAt } = parsed.catalog;
    if (Date.parse(expiresAt) <= this.now().getTime()) {
      return {
        state: "expired",
        path: this.filePath,
        message: `This host's Nuhuo settings expired at ${expiresAt} because it could not reach Nuhuo. Press Import on the Nuhuo screen once Nuhuo is reachable.`,
      };
    }

    return { state: "ready", path: this.filePath, catalog: parsed.catalog };
  }

  async write(catalog: HostCatalog): Promise<void> {
    await writeFileAtomic(this.filePath, `${JSON.stringify(catalog, null, 2)}\n`);
  }

  private async parse(mtimeMs: number, size: number): Promise<ParsedFile> {
    const parsed = parseCatalog(await readFile(this.filePath, "utf8"));
    this.cached = { mtimeMs, size, parsed };
    return parsed;
  }
}

export function parseCatalog(text: string): ParsedFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      detail: `Not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return validateCatalog(json);
}

export function validateCatalog(json: unknown): ParsedFile {
  const result = hostCatalogSchema.safeParse(json);
  if (result.success) return { ok: true, catalog: result.data };
  const detail = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, detail };
}
