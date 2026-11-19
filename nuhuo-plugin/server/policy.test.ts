import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginHookRequests } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BINDING_KEY, WORKER_CHOICE_KEY, type HostBundle } from "../shared/bundle";
import { BundleStore, parseBundle } from "./bundle-store";
import {
  applyWorkerOnCreate,
  contributeOnOpen,
  NuhuoPolicyError,
  type OpenRequest,
} from "./policy";
import { createSecretReader } from "./secrets";

type CreateRequest = PluginHookRequests["agent.create.before"];

function bundle(overrides: Partial<HostBundle> = {}): HostBundle {
  const parsed = parseBundle(
    JSON.stringify({
      schema: 1,
      centerId: "center-1",
      hostId: "host-ada",
      employee: { id: "ada", displayName: "Ada" },
      issuedAt: "2026-11-19T00:00:00Z",
      requireWorker: true,
      workers: [
        {
          workerId: "reviewer",
          name: "Code reviewer",
          releaseDigest: "sha256:aaa",
          displayVersion: "1.2.0",
          provider: "claude",
          model: "opus",
          modeId: "plan",
          allowedOverrides: ["modeId"],
          instructions: "You review code.",
          mcpServers: {
            tickets: {
              type: "http",
              url: "https://tickets.example.com/mcp",
              secretHeaders: { Authorization: { secretRef: "tickets-token" } },
            },
          },
          env: { TEAM: "platform" },
          secretEnv: { GATEWAY_KEY: { secretRef: "gateway-key" } },
        },
        {
          workerId: "builder",
          name: "Builder",
          releaseDigest: "sha256:bbb",
          displayVersion: "0.4.0",
          provider: "codex",
          instructions: "",
        },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.detail);
  return { ...parsed.bundle, ...overrides };
}

function createRequest(
  config: Partial<CreateRequest["config"]>,
  metadata: CreateRequest["metadata"] = {},
): CreateRequest {
  return { config: { provider: "claude", cwd: "/repo", ...config }, metadata };
}

function openRequest(overrides: Partial<OpenRequest> = {}): OpenRequest {
  return {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    provider: "claude",
    cwd: "/repo",
    reason: "resume",
    purpose: "interactive",
    title: null,
    background: false,
    labels: {},
    metadata: {
      [BINDING_KEY]: {
        centerId: "center-1",
        workerId: "reviewer",
        workerName: "Code reviewer",
        releaseDigest: "sha256:aaa",
      },
    },
    tools: [],
    env: { EXISTING: "1" },
    mcpServers: {},
    ...overrides,
  };
}

const secrets: Record<string, string> = { "tickets-token": "Bearer t", "gateway-key": "k" };
async function readSecret(name: string) {
  const value = secrets[name];
  if (value === undefined) throw new NuhuoPolicyError(`missing ${name}`);
  return value;
}

describe("applyWorkerOnCreate", () => {
  it("applies the chosen Worker and records the binding", () => {
    const result = applyWorkerOnCreate(
      bundle(),
      createRequest(
        { provider: "codex", model: "gpt-5.5", providerOptions: { plan_mode: true } },
        { [WORKER_CHOICE_KEY]: "reviewer", other: 1 },
      ),
    );
    expect(result.config).toEqual({
      provider: "claude",
      cwd: "/repo",
      model: "opus",
      modeId: "plan",
    });
    expect(result.metadata).toEqual({
      other: 1,
      [BINDING_KEY]: {
        centerId: "center-1",
        workerId: "reviewer",
        workerName: "Code reviewer",
        releaseDigest: "sha256:aaa",
      },
    });
  });

  it("keeps an allowed override on the same provider and replaces the others", () => {
    const result = applyWorkerOnCreate(
      bundle(),
      createRequest(
        { model: "sonnet", modeId: "acceptEdits" },
        { [WORKER_CHOICE_KEY]: "reviewer" },
      ),
    );
    expect(result.config.model).toBe("opus");
    expect(result.config.modeId).toBe("acceptEdits");
  });

  it("uses the default Worker when none is chosen", () => {
    const result = applyWorkerOnCreate(
      bundle({ defaultWorkerId: "builder" }),
      createRequest({ model: "opus" }),
    );
    expect(result.config).toEqual({ provider: "codex", cwd: "/repo" });
    expect(result.metadata?.[BINDING_KEY]).toMatchObject({ workerId: "builder" });
  });

  it("rejects an agent without a Worker when the host requires one", () => {
    expect(() => applyWorkerOnCreate(bundle(), createRequest({}))).toThrow(
      "Choose a Nuhuo Worker for this agent.",
    );
  });

  it("leaves an ordinary agent ordinary and strips a forged binding", () => {
    const result = applyWorkerOnCreate(
      bundle({ requireWorker: false }),
      createRequest({ model: "sonnet" }, { [BINDING_KEY]: { workerId: "reviewer" } }),
    );
    expect(result.config).toEqual({ provider: "claude", cwd: "/repo", model: "sonnet" });
    expect(result.metadata).toEqual({});
  });

  it("rejects a Worker that is not assigned", () => {
    expect(() =>
      applyWorkerOnCreate(bundle(), createRequest({}, { [WORKER_CHOICE_KEY]: "intruder" })),
    ).toThrow('Worker "intruder" is not assigned to this host.');
  });
});

describe("contributeOnOpen", () => {
  it("adds the Role, MCP servers, and resolved secrets", async () => {
    const result = await contributeOnOpen({ bundle: bundle(), request: openRequest(), readSecret });
    expect(result?.appendSystemPrompt).toEqual(["You review code."]);
    expect(result?.env).toEqual({ EXISTING: "1", TEAM: "platform", GATEWAY_KEY: "k" });
    expect(result?.mcpServers).toEqual({
      tickets: {
        type: "http",
        url: "https://tickets.example.com/mcp",
        headers: { Authorization: "Bearer t" },
      },
    });
  });

  it("blocks a Worker that is no longer assigned", async () => {
    const assigned = bundle();
    const withoutReviewer = { ...assigned, workers: assigned.workers.slice(1) };
    await expect(
      contributeOnOpen({ bundle: withoutReviewer, request: openRequest(), readSecret }),
    ).rejects.toThrow('Worker "Code reviewer" is no longer assigned to this host.');
  });

  it("blocks a Worker whose release moved to another provider", async () => {
    await expect(
      contributeOnOpen({
        bundle: bundle(),
        request: openRequest({ provider: "codex" }),
        readSecret,
      }),
    ).rejects.toThrow('Worker "Code reviewer" now runs on claude.');
  });

  it("blocks an unbound agent only when the host requires Workers", async () => {
    const unbound = openRequest({ metadata: {} });
    await expect(
      contributeOnOpen({ bundle: bundle(), request: unbound, readSecret }),
    ).rejects.toThrow("This agent was not started as a Nuhuo Worker");
    await expect(
      contributeOnOpen({ bundle: bundle({ requireWorker: false }), request: unbound, readSecret }),
    ).resolves.toBeUndefined();
  });

  it("blocks when a secret is missing", async () => {
    await expect(
      contributeOnOpen({
        bundle: bundle(),
        request: openRequest(),
        readSecret: async (name) => (name === "gateway-key" ? "k" : readSecret("absent")),
      }),
    ).rejects.toThrow("missing absent");
  });
});

describe("bundle files and secrets", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "nuhuo-plugin-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reports missing, invalid, expired, and ready bundles", async () => {
    const file = path.join(directory, "host-bundle.json");
    const store = new BundleStore(file, () => new Date("2026-11-20T00:00:00Z"));
    expect((await store.read()).state).toBe("missing");

    await writeFile(file, JSON.stringify({ schema: 1 }));
    const invalid = await store.read();
    expect(invalid.state).toBe("invalid");

    const valid = bundle();
    await writeFile(file, JSON.stringify({ ...valid, expiresAt: "2026-11-19T12:00:00Z" }));
    await utimes(file, new Date(), new Date(Date.now() + 5_000));
    expect((await store.read()).state).toBe("expired");

    await writeFile(file, JSON.stringify(valid));
    await utimes(file, new Date(), new Date(Date.now() + 10_000));
    expect((await store.read()).state).toBe("ready");
  });

  it("reads secrets from files and rejects missing ones", async () => {
    await writeFile(path.join(directory, "gateway-key"), "k\n");
    const reader = createSecretReader(directory);
    await expect(reader("gateway-key")).resolves.toBe("k");
    await expect(reader("absent")).rejects.toThrow('Secret "absent" is missing on this host.');
    await expect(reader("../escape")).rejects.toThrow('Secret "../escape" has an invalid name.');
  });
});
