import os from "node:os";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { WORKER_CHOICE_KEY, type HostCatalog } from "../shared/catalog";
import { NuhuoPolicyError } from "./errors";

type PaseoApi = PluginHandlerContext["paseo"];

export interface StartedWorker {
  serverId: string;
  agentId: string;
}

/**
 * Creates an idle agent for a Worker on the host it belongs to. The create hook on that host applies
 * the release; this only names the Worker. A parent makes the agent its subagent.
 */
export async function startWorker(input: {
  paseo: PaseoApi;
  catalog: HostCatalog;
  workerId: string;
  parentAgentId?: string;
}): Promise<StartedWorker> {
  const { paseo, catalog, workerId, parentAgentId } = input;
  const { self } = await paseo.hosts.list();
  const metadata = { [WORKER_CHOICE_KEY]: workerId };

  const local = catalog.workers.find((worker) => worker.workerId === workerId);
  if (local) {
    const agent = await paseo.agents.create({
      config: { provider: providerModel(local.providerId, local.launch.model) },
      cwd: local.launch.cwd ?? os.homedir(),
      title: local.name,
      metadata,
      ...(parentAgentId === undefined ? {} : { parent: parentAgentId }),
    });
    return { serverId: self.serverId, agentId: agent.id };
  }

  const peer = catalog.peerWorkers.find((worker) => worker.workerId === workerId);
  if (!peer) {
    throw new NuhuoPolicyError(
      `Worker "${workerId}" is not one of your Workers. Press Import on the Nuhuo screen if you just created it.`,
    );
  }
  const host = catalog.hosts.find((candidate) => candidate.hostId === peer.hostId);
  if (!host) {
    throw new NuhuoPolicyError(`Worker "${peer.name}" is on a host that is not ready.`);
  }
  if (peer.cwd === undefined) {
    throw new NuhuoPolicyError(`Worker "${peer.name}" has no working directory. Set one in Nuhuo.`);
  }
  const remote = await paseo.hosts.client(host.serverId);
  try {
    const agent = await remote.agents.create({
      config: { provider: providerModel(peer.providerId, peer.model) },
      cwd: peer.cwd,
      title: peer.name,
      metadata,
      ...(parentAgentId === undefined
        ? {}
        : { parent: { serverId: self.serverId, agentId: parentAgentId } }),
    });
    return { serverId: host.serverId, agentId: agent.id };
  } finally {
    await remote.dispose();
  }
}

function providerModel(providerId: string, model: string): string {
  return model === "" ? providerId : `${providerId}/${model}`;
}
