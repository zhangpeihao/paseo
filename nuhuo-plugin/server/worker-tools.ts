import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { HostCatalog } from "../shared/catalog";
import type { CatalogState } from "./catalog-store";
import { describeError } from "./files";
import { startWorker } from "./start-worker";

/** The tools every agent the plugin opens gets, for delegating to the employee's Workers. */
export function createWorkerTools(readCatalog: () => Promise<CatalogState>): AgentToolDefinition[] {
  async function catalogOrError(): Promise<HostCatalog | string> {
    const state = await readCatalog();
    return state.state === "ready" ? state.catalog : state.message;
  }

  const listWorkers = defineAgentTool({
    name: "nuhuo_list_workers",
    title: "List Nuhuo Workers",
    description:
      "Lists your Nuhuo Workers on all your hosts: ID, name, Role, host, provider, and model. Start one with nuhuo_start_worker.",
    input: z.object({}),
    async execute() {
      const catalog = await catalogOrError();
      if (typeof catalog === "string") return { text: catalog, isError: true };
      const workers = listCatalogWorkers(catalog);
      return {
        text:
          workers.length === 0
            ? "You have no Nuhuo Workers."
            : workers
                .map(
                  (worker) =>
                    `${worker.workerId}: ${worker.name} (Role ${worker.roleId}) on ${worker.hostName}, ${worker.providerId}${worker.model ? `/${worker.model}` : ""}`,
                )
                .join("\n"),
        structuredContent: { workers },
      };
    },
  });

  const startWorkerTool = defineAgentTool({
    name: "nuhuo_start_worker",
    title: "Start a Nuhuo Worker",
    description:
      "Starts an idle subagent for one of your Nuhuo Workers on its host and returns its serverId and agentId. Send it the task with send_agent_prompt, passing that serverId.",
    input: z.object({
      workerId: z.string().min(1).describe("A Worker ID from nuhuo_list_workers"),
    }),
    async execute({ workerId }, { agent, paseo }) {
      const catalog = await catalogOrError();
      if (typeof catalog === "string") return { text: catalog, isError: true };
      try {
        const started = await startWorker({ paseo, catalog, workerId, parentAgentId: agent.id });
        return {
          text: `Started Worker "${workerId}" as agent ${started.agentId} on server ${started.serverId}. Send it the task with send_agent_prompt, passing serverId "${started.serverId}".`,
          structuredContent: started,
        };
      } catch (error) {
        return { text: describeError(error), isError: true };
      }
    },
  });

  return [listWorkers, startWorkerTool];
}

export interface CatalogWorker {
  workerId: string;
  name: string;
  roleId: string;
  hostId: string;
  hostName: string;
  onThisHost: boolean;
  providerId: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
}

/** This host's Workers first, then the Workers on the employee's other hosts. */
export function listCatalogWorkers(catalog: HostCatalog): CatalogWorker[] {
  const hostName = (hostId: string) =>
    catalog.hosts.find((host) => host.hostId === hostId)?.name ?? hostId;
  return [
    ...catalog.workers.map((worker) => ({
      workerId: worker.workerId,
      name: worker.name,
      roleId: worker.role.id,
      hostId: worker.hostId,
      hostName: hostName(worker.hostId),
      onThisHost: true,
      providerId: worker.providerId,
      model: worker.launch.model,
      modeId: worker.launch.modeId,
      ...(worker.launch.thinkingOptionId === undefined
        ? {}
        : { thinkingOptionId: worker.launch.thinkingOptionId }),
    })),
    ...catalog.peerWorkers.map((worker) => ({
      workerId: worker.workerId,
      name: worker.name,
      roleId: worker.roleId,
      hostId: worker.hostId,
      hostName: hostName(worker.hostId),
      onThisHost: false,
      providerId: worker.providerId,
      model: worker.model,
    })),
  ];
}
