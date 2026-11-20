import { readFile } from "node:fs/promises";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { credentialSchema, secretsResponseSchema, type HostCredential } from "../shared/catalog";
import type { SyncStatus } from "../shared/rpc";
import { ensureInstructions, ensureSkill } from "./assets";
import { validateCatalog, type CatalogStore } from "./catalog-store";
import { describeError, isMissingFile } from "./files";
import { buildInventory } from "./inventory";
import { NuhuoClient, type FetchFunction } from "./nuhuo-client";
import type { NuhuoPaths } from "./paths";
import { reconcilePeers } from "./peer-links";
import { planProviders, reconcileProviders } from "./providers";
import { writeSecrets } from "./secrets";

type PaseoApi = PluginHandlerContext["paseo"];

export interface NuhuoSyncOptions {
  paths: NuhuoPaths;
  store: CatalogStore;
  fetchImpl?: FetchFunction;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * Pulls this host's settings from Nuhuo: catalog, secrets, instructions, and Skills to files, then
 * providers, peer links, and the inventory through the daemon. One pull runs at a time.
 */
export class NuhuoSync {
  private paseo: PaseoApi | null = null;
  private inflight: Promise<SyncStatus> | null = null;
  private status: SyncStatus = {
    pulling: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    problems: [],
    appliedToDaemon: false,
  };

  constructor(private readonly options: NuhuoSyncOptions) {}

  /**
   * Paseo hands a plugin its API only inside hooks and handlers. The first one gives it to the
   * pulls, and a pull that never reached the daemon runs again.
   */
  attach(paseo: PaseoApi): void {
    if (this.paseo !== null) return;
    this.paseo = paseo;
    if (!this.status.appliedToDaemon) void this.pullFresh();
  }

  getStatus(): SyncStatus {
    return { ...this.status, problems: [...this.status.problems] };
  }

  /** Joins the pull in progress, or starts one. */
  pull(): Promise<SyncStatus> {
    this.inflight ??= this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Waits for the pull in progress, then pulls again, so the result reflects Nuhuo now. */
  async pullFresh(): Promise<SyncStatus> {
    if (this.inflight !== null) await this.inflight;
    return this.pull();
  }

  private async run(): Promise<SyncStatus> {
    const now = this.options.now ?? (() => new Date());
    this.status = { ...this.status, pulling: true, lastAttemptAt: now().toISOString() };
    const paseo = this.paseo;
    try {
      const problems = await this.pullOnce(paseo);
      this.status = {
        pulling: false,
        lastAttemptAt: this.status.lastAttemptAt,
        lastSuccessAt: now().toISOString(),
        lastError: null,
        problems,
        appliedToDaemon: paseo !== null,
      };
    } catch (error) {
      const message = describeError(error);
      this.options.log?.(`Nuhuo pull failed: ${message}`);
      this.status = { ...this.status, pulling: false, lastError: message };
    }
    return this.getStatus();
  }

  private async pullOnce(paseo: PaseoApi | null): Promise<string[]> {
    const { paths, store, fetchImpl } = this.options;
    const credential = await readCredential(paths.credential);
    const client = new NuhuoClient(credential, fetchImpl);

    const parsed = validateCatalog(await client.getCatalog());
    if (!parsed.ok)
      throw new Error(`Nuhuo sent a catalog this plugin cannot read: ${parsed.detail}`);
    const { catalog } = parsed;
    if (catalog.hostId !== credential.hostId) {
      throw new Error(
        `Nuhuo sent the catalog of host "${catalog.hostId}" to "${credential.hostId}"`,
      );
    }

    const problems: string[] = [];
    const { secrets } = secretsResponseSchema.parse(await client.getSecrets());
    for (const name of await writeSecrets(paths.secrets, secrets)) {
      problems.push(`Secret "${name}" has a name that cannot be a file name.`);
    }

    // Opens of a Worker whose files are missing are blocked; the other Workers still work.
    const fetchAsset = (digest: string) => client.getAsset(digest);
    for (const release of catalog.workers) {
      try {
        await ensureInstructions({ directory: paths.instructions, release, fetchAsset });
        for (const skill of release.skills) {
          await ensureSkill({ directory: paths.skills, skill, fetchAsset });
        }
      } catch (error) {
        problems.push(`Worker "${release.name}": ${describeError(error)}`);
      }
    }
    await store.write(catalog);

    const plan = planProviders(catalog.providers, secrets);
    problems.push(...plan.problems);
    if (paseo === null) return problems;

    await this.step(problems, "Providers", () => reconcileProviders(paseo, plan.profiles));
    await this.step(problems, "Links to your other hosts", () => reconcilePeers(paseo, catalog));
    await this.step(problems, "Inventory report", async () =>
      client.putInventory(await buildInventory({ paseo, catalog, profiles: plan.profiles })),
    );
    return problems;
  }

  private async step(problems: string[], label: string, run: () => Promise<unknown>) {
    try {
      await run();
    } catch (error) {
      const message = `${label} failed: ${describeError(error)}`;
      this.options.log?.(message);
      problems.push(message);
    }
  }
}

export async function readCredential(filePath: string): Promise<HostCredential> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    throw new Error(
      `Nuhuo has not set up this host: ${filePath} is missing. Ask IT to repair the host in Nuhuo.`,
      { cause: error },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath} is not JSON. Ask IT to repair the host in Nuhuo.`, {
      cause: error,
    });
  }
  const parsed = credentialSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${filePath} is incomplete. Ask IT to repair the host in Nuhuo.`);
  }
  return parsed.data;
}
