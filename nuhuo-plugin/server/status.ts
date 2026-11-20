import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { PEER_SOURCE_PREFIX } from "../shared/catalog";
import type { HostLink, HostStatus, HostSummary, SyncStatus } from "../shared/rpc";
import type { CatalogState } from "./catalog-store";
import { listCatalogWorkers } from "./worker-tools";

type PaseoApi = PluginHandlerContext["paseo"];

/** What the app shows. Never includes instructions, environment values, secrets, or offers. */
export async function describeStatus(input: {
  state: CatalogState;
  sync: SyncStatus;
  paseo: PaseoApi;
}): Promise<HostStatus> {
  const { state, sync, paseo } = input;
  if (state.state !== "ready") {
    return {
      state: state.state,
      message: state.message,
      ...(state.detail === undefined ? {} : { detail: state.detail }),
      sync,
    };
  }

  const { catalog } = state;
  const links = await readLinks(paseo);
  const hosts: HostSummary[] = catalog.hosts.map((host) => ({
    hostId: host.hostId,
    name: host.name,
    link: host.hostId === catalog.hostId ? "this-host" : (links.get(host.hostId) ?? "not-linked"),
  }));
  if (!hosts.some((host) => host.hostId === catalog.hostId)) {
    hosts.unshift({ hostId: catalog.hostId, name: catalog.hostId, link: "this-host" });
  }

  return {
    state: "ready",
    hostId: catalog.hostId,
    requireWorker: catalog.policy.requireWorker,
    ...(catalog.defaultWorkerId === undefined ? {} : { defaultWorkerId: catalog.defaultWorkerId }),
    issuedAt: catalog.issuedAt,
    expiresAt: catalog.expiresAt,
    providers: catalog.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      models: provider.models,
    })),
    hosts,
    workers: listCatalogWorkers(catalog),
    sync,
  };
}

async function readLinks(paseo: PaseoApi): Promise<Map<string, HostLink>> {
  const links = new Map<string, HostLink>();
  const directory = await paseo.hosts.list();
  for (const entry of directory.hosts) {
    if (!entry.source.key.startsWith(PEER_SOURCE_PREFIX)) continue;
    links.set(entry.source.key.slice(PEER_SOURCE_PREFIX.length), entry.status);
  }
  return links;
}
