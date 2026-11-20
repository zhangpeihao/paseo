import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { PEER_SOURCE_PREFIX, type HostCatalog } from "../shared/catalog";
import { fingerprint } from "./digest";

type PaseoApi = PluginHandlerContext["paseo"];

const HOST_ID_KEY = "nuhuo.hostId";
/** A fingerprint of the saved offer, so a changed offer is noticed without storing it twice. */
const CONNECTION_KEY = "nuhuo.connection";

export interface PeerChanges {
  added: string[];
  updated: string[];
  removed: string[];
}

/**
 * Saves the employee's other hosts on this daemon, so the app routes to all of them through this
 * one and Workers here can start Workers there. Registrations the employee added are left alone,
 * and a link the employee disabled stays disabled.
 */
export async function reconcilePeers(paseo: PaseoApi, catalog: HostCatalog): Promise<PeerChanges> {
  const directory = await paseo.hosts.list();
  const peers = catalog.hosts.filter(
    (host) => host.hostId !== catalog.hostId && host.serverId !== directory.self.serverId,
  );
  const managed = new Map(
    directory.hosts
      .filter((entry) => entry.source.key.startsWith(PEER_SOURCE_PREFIX))
      .map((entry) => [entry.source.key, entry]),
  );

  const changes: PeerChanges = { added: [], updated: [], removed: [] };
  const wanted = new Set<string>();
  for (const peer of peers) {
    const sourceKey = `${PEER_SOURCE_PREFIX}${peer.hostId}`;
    wanted.add(sourceKey);
    const metadata = { [HOST_ID_KEY]: peer.hostId, [CONNECTION_KEY]: fingerprint(peer.connection) };
    const saved = managed.get(sourceKey);
    if (saved === undefined) {
      await paseo.hosts.add({ connection: peer.connection, label: peer.name, sourceKey, metadata });
      changes.added.push(peer.hostId);
      continue;
    }
    // A host set up again from scratch has a new server ID; the saved identity is pinned.
    const replaceIdentity = saved.serverId !== null && saved.serverId !== peer.serverId;
    if (replaceIdentity || saved.metadata[CONNECTION_KEY] !== metadata[CONNECTION_KEY]) {
      await paseo.hosts.update(saved.registrationId, {
        connection: peer.connection,
        metadata,
        ...(replaceIdentity ? { replaceIdentity: true } : {}),
      });
      changes.updated.push(peer.hostId);
    }
  }

  for (const [sourceKey, saved] of managed) {
    if (wanted.has(sourceKey)) continue;
    await paseo.hosts.remove(saved.registrationId);
    changes.removed.push(saved.metadata[HOST_ID_KEY] ?? sourceKey.slice(PEER_SOURCE_PREFIX.length));
  }
  return changes;
}
