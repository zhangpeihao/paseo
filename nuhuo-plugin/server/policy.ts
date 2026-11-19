import type { PluginHookRequests, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import {
  BINDING_KEY,
  WORKER_CHOICE_KEY,
  bindingSchema,
  type HostBundle,
  type McpServerTemplate,
  type WorkerBinding,
  type WorkerRelease,
} from "../shared/bundle";
import type { HostStatus } from "../shared/rpc";
import type { BundleState } from "./bundle-store";
import type { SecretReader } from "./secrets";

type CreateRequest = PluginHookRequests["agent.create.before"];
type SessionConfig = CreateRequest["config"];
type McpServerConfig = PluginSessionOpenRequest["mcpServers"][string];
/**
 * `appendSystemPrompt` ships in the first Paseo release after 0.16.2 (paseo#9781), which the
 * manifest requires. Drop this alias once the published `@getpaseo/plugin` types include it.
 */
export type OpenRequest = PluginSessionOpenRequest & { appendSystemPrompt?: string[] };

const OVERRIDABLE_FIELDS = ["model", "modeId", "thinkingOptionId"] as const;

/** A refusal shown to the person creating or opening the agent. */
export class NuhuoPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NuhuoPolicyError";
  }
}

export function usableBundle(state: BundleState): HostBundle {
  if (state.state === "ready") return state.bundle;
  throw new NuhuoPolicyError(state.message);
}

/** Applies the chosen or default Worker to a new agent's saved configuration. */
export function applyWorkerOnCreate(bundle: HostBundle, request: CreateRequest): CreateRequest {
  const metadata = { ...request.metadata };
  const choice = metadata[WORKER_CHOICE_KEY];
  // The binding is written here only; a caller cannot supply one.
  delete metadata[WORKER_CHOICE_KEY];
  delete metadata[BINDING_KEY];

  if (choice !== undefined && choice !== null && typeof choice !== "string") {
    throw new NuhuoPolicyError(`Metadata "${WORKER_CHOICE_KEY}" must be a Worker ID.`);
  }
  const workerId = typeof choice === "string" ? choice : bundle.defaultWorkerId;
  if (workerId === undefined) {
    if (bundle.requireWorker) {
      throw new NuhuoPolicyError(
        "Choose a Nuhuo Worker for this agent. This host runs only the Workers assigned to you.",
      );
    }
    return { ...request, metadata };
  }

  const release = bundle.workers.find((worker) => worker.workerId === workerId);
  if (!release) {
    throw new NuhuoPolicyError(
      `Worker "${workerId}" is not assigned to this host. Choose another Worker.`,
    );
  }
  const binding: WorkerBinding = {
    centerId: bundle.centerId,
    workerId: release.workerId,
    workerName: release.name,
    releaseDigest: release.releaseDigest,
  };
  return {
    ...request,
    config: applyRelease(request.config, release),
    metadata: { ...metadata, [BINDING_KEY]: binding },
  };
}

function applyRelease(config: SessionConfig, release: WorkerRelease): SessionConfig {
  const sameProvider = config.provider === release.provider;
  const next: SessionConfig = { ...config, provider: release.provider };
  if (!sameProvider) {
    // Options and selections belong to the provider they were chosen for.
    delete next.providerOptions;
    delete next.featureValues;
  }
  for (const field of OVERRIDABLE_FIELDS) {
    const keepCaller =
      sameProvider && release.allowedOverrides.includes(field) && config[field] !== undefined;
    const value = keepCaller ? config[field] : release[field];
    if (value === undefined) {
      delete next[field];
    } else {
      next[field] = value;
    }
  }
  return next;
}

/**
 * Adds the bound Worker's Role, MCP servers, and environment to an interactive open. Returns
 * `undefined` for an ordinary agent on a host that allows them.
 */
export async function contributeOnOpen(input: {
  bundle: HostBundle;
  request: OpenRequest;
  readSecret: SecretReader;
}): Promise<OpenRequest | undefined> {
  const { bundle, request, readSecret } = input;
  const binding = readBinding(request.metadata);
  if (binding === null) {
    if (bundle.requireWorker) {
      throw new NuhuoPolicyError(
        "This agent was not started as a Nuhuo Worker, and this host runs only assigned Workers. Start a new agent and choose a Worker.",
      );
    }
    return undefined;
  }
  if (binding.centerId !== bundle.centerId) {
    throw new NuhuoPolicyError(
      `Worker "${binding.workerName}" belongs to a different Nuhuo Center. Start a new agent with a Worker assigned to this host.`,
    );
  }
  const release = bundle.workers.find((worker) => worker.workerId === binding.workerId);
  if (!release) {
    throw new NuhuoPolicyError(
      `Worker "${binding.workerName}" is no longer assigned to this host. Start a new agent with another Worker.`,
    );
  }
  if (release.provider !== request.provider) {
    throw new NuhuoPolicyError(
      `Worker "${release.name}" now runs on ${release.provider}. Start a new agent for this Worker.`,
    );
  }

  const mcpServers = { ...request.mcpServers };
  for (const [name, template] of Object.entries(release.mcpServers)) {
    mcpServers[name] = await resolveMcpServer(template, readSecret);
  }
  const instructions = release.instructions.trim();
  return {
    ...request,
    env: {
      ...request.env,
      ...release.env,
      ...(await resolveSecrets(release.secretEnv, readSecret)),
    },
    mcpServers,
    appendSystemPrompt:
      instructions === ""
        ? request.appendSystemPrompt
        : [...(request.appendSystemPrompt ?? []), instructions],
  };
}

function readBinding(metadata: OpenRequest["metadata"]): WorkerBinding | null {
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
  refs: Record<string, { secretRef: string }>,
  readSecret: SecretReader,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, { secretRef }] of Object.entries(refs)) {
    resolved[key] = await readSecret(secretRef);
  }
  return resolved;
}

async function resolveMcpServer(
  template: McpServerTemplate,
  readSecret: SecretReader,
): Promise<McpServerConfig> {
  if (template.type === "stdio") {
    const { secretEnv, env, ...server } = template;
    const merged = { ...env, ...(await resolveSecrets(secretEnv ?? {}, readSecret)) };
    return Object.keys(merged).length === 0 ? server : { ...server, env: merged };
  }
  const { secretHeaders, headers, ...server } = template;
  const merged = { ...headers, ...(await resolveSecrets(secretHeaders ?? {}, readSecret)) };
  return Object.keys(merged).length === 0 ? server : { ...server, headers: merged };
}

/** The status the app shows. Never includes instructions, environment values, or MCP details. */
export function describeStatus(state: BundleState): HostStatus {
  if (state.state !== "ready") {
    return {
      state: state.state,
      bundlePath: state.path,
      message: state.message,
      ...(state.detail === undefined ? {} : { detail: state.detail }),
    };
  }
  const { bundle } = state;
  return {
    state: "ready",
    bundlePath: state.path,
    centerId: bundle.centerId,
    hostId: bundle.hostId,
    employee: bundle.employee,
    issuedAt: bundle.issuedAt,
    expiresAt: bundle.expiresAt,
    requireWorker: bundle.requireWorker,
    defaultWorkerId: bundle.defaultWorkerId,
    workers: bundle.workers.map((worker) => ({
      workerId: worker.workerId,
      name: worker.name,
      description: worker.description,
      displayVersion: worker.displayVersion,
      provider: worker.provider,
      model: worker.model,
      modeId: worker.modeId,
      thinkingOptionId: worker.thinkingOptionId,
    })),
  };
}
