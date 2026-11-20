import os from "node:os";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { HostCatalog, ProviderKind } from "../shared/catalog";
import type { ProviderProfile } from "./providers";

type PaseoApi = PluginHandlerContext["paseo"];

interface Option {
  id: string;
  label?: string;
}

export interface ProviderInventory {
  available: boolean;
  models?: Option[];
  modes?: Option[];
  thinkingOptions?: Option[];
}

/** The body of `PUT /inventory`: what Nuhuo's Worker form offers for this host. */
export interface InventoryReport {
  serverId: string;
  hostname: string;
  platform: "linux" | "darwin";
  arch: "x64" | "arm64";
  providers: Partial<Record<ProviderKind, ProviderInventory>>;
  appliedCatalogDigest: string;
  appliedWorkerReleases: Record<string, string>;
}

/**
 * Lists the models, modes, and thinking options each installed provider kind reports here. Nuhuo
 * keys them by kind, so the first profile of each kind speaks for it.
 */
export async function buildInventory(input: {
  paseo: PaseoApi;
  catalog: HostCatalog;
  profiles: Readonly<Record<string, ProviderProfile>>;
}): Promise<InventoryReport> {
  const { paseo, catalog, profiles } = input;
  const { self } = await paseo.hosts.list();
  const profileByKind = new Map<ProviderKind, string>();
  for (const [id, profile] of Object.entries(profiles)) {
    if (!profileByKind.has(profile.extends)) profileByKind.set(profile.extends, id);
  }

  const providers: Partial<Record<ProviderKind, ProviderInventory>> = {};
  for (const [kind, profileId] of profileByKind) {
    providers[kind] = await describeProvider(paseo, profileId);
  }

  return {
    serverId: self.serverId,
    hostname: os.hostname(),
    platform: hostPlatform(),
    arch: hostArch(),
    providers,
    appliedCatalogDigest: catalog.digest,
    appliedWorkerReleases: Object.fromEntries(
      catalog.workers.map((worker) => [worker.workerId, worker.digest]),
    ),
  };
}

async function describeProvider(paseo: PaseoApi, profileId: string): Promise<ProviderInventory> {
  const [models, modes] = await Promise.all([
    paseo.providers.listModels(profileId),
    paseo.providers.listModes(profileId),
  ]);
  if (models.error || modes.error) return { available: false };
  const thinking = new Map<string, Option>();
  for (const model of models.models ?? []) {
    for (const option of model.thinkingOptions ?? []) {
      if (!thinking.has(option.id)) thinking.set(option.id, { id: option.id, label: option.label });
    }
  }
  return {
    available: true,
    models: (models.models ?? []).map((model) => ({ id: model.id, label: model.label })),
    modes: (modes.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label })),
    thinkingOptions: [...thinking.values()],
  };
}

function hostPlatform(): InventoryReport["platform"] {
  if (process.platform === "linux" || process.platform === "darwin") return process.platform;
  throw new Error(`Nuhuo supports Linux and macOS hosts, not ${process.platform}`);
}

function hostArch(): InventoryReport["arch"] {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  throw new Error(`Nuhuo supports x64 and arm64 hosts, not ${process.arch}`);
}
