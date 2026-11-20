import type {
  AgentToolDefinition,
  PluginHookRequests,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import {
  BINDING_KEY,
  WORKER_CHOICE_KEY,
  bindingSchema,
  type HostCatalog,
  type McpServerTemplate,
  type SecretRef,
  type ValueOrSecret,
  type WorkerBinding,
  type WorkerRelease,
} from "../shared/catalog";
import { isSkillReady, readInstructions, skillPath } from "./assets";
import type { CatalogState } from "./catalog-store";
import { NuhuoPolicyError } from "./errors";
import type { NuhuoPaths } from "./paths";
import type { SecretReader } from "./secrets";

type CreateRequest = PluginHookRequests["agent.create.before"];
type SessionConfig = CreateRequest["config"];
type McpServerConfig = PluginSessionOpenRequest["mcpServers"][string];

const OVERRIDABLE_FIELDS = ["model", "modeId", "thinkingOptionId"] as const;

export type CreateDecision =
  | { kind: "apply"; release: WorkerRelease }
  | { kind: "ordinary" }
  | { kind: "unknown"; workerId: string }
  | { kind: "reject"; message: string };

export function usableCatalog(state: CatalogState): HostCatalog {
  if (state.state === "ready") return state.catalog;
  throw new NuhuoPolicyError(state.message);
}

/** Decides what a new agent becomes from its `nuhuo.worker` choice and the host's catalog. */
export function decideCreate(catalog: HostCatalog, choice: unknown): CreateDecision {
  if (choice !== undefined && choice !== null && typeof choice !== "string") {
    return { kind: "reject", message: `Metadata "${WORKER_CHOICE_KEY}" must be a Worker ID.` };
  }
  const workerId = typeof choice === "string" ? choice : catalog.defaultWorkerId;
  if (workerId === undefined) {
    return catalog.policy.requireWorker
      ? {
          kind: "reject",
          message: "Choose a Nuhuo Worker for this agent. This host runs only your Workers.",
        }
      : { kind: "ordinary" };
  }
  const release = catalog.workers.find((worker) => worker.workerId === workerId);
  if (release) return { kind: "apply", release };
  const peer = catalog.peerWorkers.find((worker) => worker.workerId === workerId);
  if (peer) {
    const host = catalog.hosts.find((candidate) => candidate.hostId === peer.hostId);
    return {
      kind: "reject",
      message: `Worker "${peer.name}" runs on ${host?.name ?? peer.hostId}. Start it on that host.`,
    };
  }
  return { kind: "unknown", workerId };
}

/**
 * Applies the chosen or default Worker to a new agent. A Worker this host has not heard of yet
 * triggers one pull, so a Worker created minutes ago works without waiting for the next poll.
 */
export async function applyWorkerOnCreate(input: {
  request: CreateRequest;
  readCatalog: () => Promise<CatalogState>;
  refresh: () => Promise<void>;
}): Promise<CreateRequest> {
  const { request, readCatalog, refresh } = input;
  const choice = request.metadata?.[WORKER_CHOICE_KEY];
  let catalog = usableCatalog(await readCatalog());
  let decision = decideCreate(catalog, choice);
  if (decision.kind === "unknown") {
    await refresh();
    catalog = usableCatalog(await readCatalog());
    decision = decideCreate(catalog, choice);
  }

  // The binding is written here only; a caller cannot supply one.
  const metadata = { ...request.metadata };
  delete metadata[WORKER_CHOICE_KEY];
  delete metadata[BINDING_KEY];

  switch (decision.kind) {
    case "reject":
      throw new NuhuoPolicyError(decision.message);
    case "unknown":
      throw new NuhuoPolicyError(
        `Worker "${decision.workerId}" is not one of your Workers on this host. Choose another Worker.`,
      );
    case "ordinary":
      return { ...request, metadata };
    case "apply": {
      const { release } = decision;
      const binding: WorkerBinding = {
        workerId: release.workerId,
        workerName: release.name,
        releaseDigest: release.digest,
      };
      return {
        ...request,
        config: applyLaunch(request.config, release),
        metadata: { ...metadata, [BINDING_KEY]: binding },
      };
    }
  }
}

function applyLaunch(config: SessionConfig, release: WorkerRelease): SessionConfig {
  const { launch } = release;
  const sameProvider = config.provider === release.providerId;
  const next: SessionConfig = { ...config, provider: release.providerId };
  if (!sameProvider) {
    // Options and selections belong to the provider they were chosen for.
    delete next.providerOptions;
    delete next.featureValues;
  }
  const wanted = {
    model: launch.model === "" ? undefined : launch.model,
    modeId: launch.modeId,
    thinkingOptionId: launch.thinkingOptionId,
  };
  for (const field of OVERRIDABLE_FIELDS) {
    const keepCaller =
      sameProvider && launch.allowedOverrides[field] && config[field] !== undefined;
    const value = keepCaller ? config[field] : wanted[field];
    if (value === undefined) {
      delete next[field];
    } else {
      next[field] = value;
    }
  }
  return next;
}

/**
 * Adds the bound Worker's instructions, MCP servers, environment, and the Worker tools to an
 * interactive open. An ordinary agent on a host that allows them gets the tools only.
 */
export async function contributeOnOpen(input: {
  catalog: HostCatalog;
  request: PluginSessionOpenRequest;
  readSecret: SecretReader;
  paths: Pick<NuhuoPaths, "instructions" | "skills">;
  tools: readonly AgentToolDefinition[];
}): Promise<PluginSessionOpenRequest> {
  const { catalog, request, readSecret, paths, tools } = input;
  const withTools = [...request.tools, ...tools];
  const binding = readBinding(request.metadata);
  if (binding === null) {
    if (catalog.policy.requireWorker) {
      throw new NuhuoPolicyError(
        "This agent was not started as a Nuhuo Worker, and this host runs only your Workers. Start a new agent and choose a Worker.",
      );
    }
    return { ...request, tools: withTools };
  }

  const release = catalog.workers.find((worker) => worker.workerId === binding.workerId);
  if (!release) {
    throw new NuhuoPolicyError(
      `Worker "${binding.workerName}" is no longer on this host. Start a new agent with another Worker.`,
    );
  }
  if (release.providerId !== request.provider) {
    throw new NuhuoPolicyError(
      `Worker "${release.name}" now runs on provider ${release.providerId}. Start a new agent for this Worker.`,
    );
  }
  for (const skill of release.skills) {
    if (!(await isSkillReady(paths.skills, skill))) {
      throw new NuhuoPolicyError(
        `Skill "${skill.name}" of Worker "${release.name}" has not reached this host. Press Import on the Nuhuo screen.`,
      );
    }
  }

  const mcpServers = { ...request.mcpServers };
  for (const [name, template] of Object.entries(release.mcpServers)) {
    mcpServers[name] = await resolveMcpServer(template, readSecret);
  }
  const instructions = [
    (await readInstructions(paths.instructions, release)).trim(),
    describeSkillPaths(paths.skills, release),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  return {
    ...request,
    env: {
      ...request.env,
      ...release.launch.env,
      ...(await resolveSecrets(release.launch.secretEnv, readSecret)),
    },
    mcpServers,
    tools: withTools,
    appendSystemPrompt: [...(request.appendSystemPrompt ?? []), instructions],
  };
}

function describeSkillPaths(directory: string, release: WorkerRelease): string {
  if (release.skills.length === 0) return "";
  const lines = release.skills.map(
    (skill) => `- ${skill.name} ${skill.version}: ${skillPath(directory, skill)}`,
  );
  return ["## Skill files on this host", ...lines].join("\n");
}

function readBinding(metadata: PluginSessionOpenRequest["metadata"]): WorkerBinding | null {
  const value = metadata[BINDING_KEY];
  if (value === undefined || value === null) return null;
  const parsed = bindingSchema.safeParse(value);
  if (!parsed.success) {
    throw new NuhuoPolicyError(
      "This agent's Nuhuo Worker record is unreadable. Start a new agent and choose a Worker.",
    );
  }
  return parsed.data;
}

async function resolveSecrets(
  refs: Readonly<Record<string, SecretRef>>,
  readSecret: SecretReader,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, { secretRef }] of Object.entries(refs)) {
    resolved[key] = await readSecret(secretRef);
  }
  return resolved;
}

async function resolveValues(
  values: Readonly<Record<string, ValueOrSecret>>,
  readSecret: SecretReader,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = typeof value === "string" ? value : await readSecret(value.secretRef);
  }
  return resolved;
}

async function resolveMcpServer(
  template: McpServerTemplate,
  readSecret: SecretReader,
): Promise<McpServerConfig> {
  if (template.type === "stdio") {
    const { env, ...server } = template;
    return env === undefined ? server : { ...server, env: await resolveValues(env, readSecret) };
  }
  const { headers, ...server } = template;
  return headers === undefined
    ? server
    : { ...server, headers: await resolveValues(headers, readSecret) };
}
