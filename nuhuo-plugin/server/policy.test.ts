import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentToolDefinition,
  PluginHookRequests,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BINDING_KEY, WORKER_CHOICE_KEY, type HostCatalog } from "../shared/catalog";
import { ensureInstructions, ensureSkill } from "./assets";
import type { CatalogState } from "./catalog-store";
import { NuhuoPolicyError } from "./errors";
import { applyWorkerOnCreate, contributeOnOpen } from "./policy";
import { createSecretReader, writeSecrets } from "./secrets";
import { INSTRUCTIONS, SKILL_FILES, SKILL_DIGEST, makeCatalog, makeRelease } from "./test-fixtures";

type CreateRequest = PluginHookRequests["agent.create.before"];

function ready(catalog: HostCatalog): () => Promise<CatalogState> {
  return async () => ({ state: "ready", path: "catalog.json", catalog });
}

function createRequest(
  config: Partial<CreateRequest["config"]>,
  metadata: CreateRequest["metadata"] = {},
): CreateRequest {
  return { config: { provider: "claude", cwd: "/srv/app", ...config }, metadata };
}

const noRefresh = async () => {
  throw new Error("Unexpected pull");
};

describe("agent.create.before", () => {
  it("applies the chosen Worker's launch settings and records the binding", async () => {
    const result = await applyWorkerOnCreate({
      request: createRequest(
        { provider: "codex", model: "gpt-5", modeId: "full-access", providerOptions: { a: 1 } },
        { [WORKER_CHOICE_KEY]: "reviewer", [BINDING_KEY]: { forged: true } },
      ),
      readCatalog: ready(makeCatalog()),
      refresh: noRefresh,
    });

    expect(result.config).toEqual({
      provider: "nuhuo-claude",
      cwd: "/srv/app",
      model: "claude-sonnet-4-5",
      modeId: "default",
      thinkingOptionId: "high",
    });
    expect(result.metadata).toEqual({
      [BINDING_KEY]: {
        workerId: "reviewer",
        workerName: "Code reviewer",
        releaseDigest: makeRelease().digest,
      },
    });
  });

  it("keeps the caller's value only for fields the release allows on the same provider", async () => {
    const result = await applyWorkerOnCreate({
      request: createRequest(
        { provider: "nuhuo-claude", model: "other", modeId: "plan", thinkingOptionId: "low" },
        { [WORKER_CHOICE_KEY]: "reviewer" },
      ),
      readCatalog: ready(makeCatalog()),
      refresh: noRefresh,
    });

    expect(result.config.model).toBe("claude-sonnet-4-5");
    expect(result.config.modeId).toBe("plan");
    expect(result.config.thinkingOptionId).toBe("high");
  });

  it("rejects a Worker on another host and names that host", async () => {
    await expect(
      applyWorkerOnCreate({
        request: createRequest({}, { [WORKER_CHOICE_KEY]: "writer" }),
        readCatalog: ready(makeCatalog()),
        refresh: noRefresh,
      }),
    ).rejects.toThrow('Worker "Docs writer" runs on build-b. Start it on that host.');
  });

  it("pulls once for a Worker it has not heard of, then applies it", async () => {
    let catalog = makeCatalog({ workers: [] });
    const refresh = vi.fn(async () => {
      catalog = makeCatalog();
    });

    const result = await applyWorkerOnCreate({
      request: createRequest({}, { [WORKER_CHOICE_KEY]: "reviewer" }),
      readCatalog: async () => ({ state: "ready", path: "catalog.json", catalog }),
      refresh,
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.config.provider).toBe("nuhuo-claude");
  });

  it("rejects a Worker still unknown after the pull", async () => {
    await expect(
      applyWorkerOnCreate({
        request: createRequest({}, { [WORKER_CHOICE_KEY]: "ghost" }),
        readCatalog: ready(makeCatalog()),
        refresh: async () => {},
      }),
    ).rejects.toThrow('Worker "ghost" is not one of your Workers on this host.');
  });

  it("applies the default Worker, requires one when the host does, and otherwise stays ordinary", async () => {
    const withDefault = await applyWorkerOnCreate({
      request: createRequest({}),
      readCatalog: ready(makeCatalog({ defaultWorkerId: "reviewer" })),
      refresh: noRefresh,
    });
    expect(withDefault.config.provider).toBe("nuhuo-claude");

    await expect(
      applyWorkerOnCreate({
        request: createRequest({}),
        readCatalog: ready(makeCatalog({ policy: { requireWorker: true } })),
        refresh: noRefresh,
      }),
    ).rejects.toBeInstanceOf(NuhuoPolicyError);

    const ordinary = await applyWorkerOnCreate({
      request: createRequest({ provider: "codex" }, { [BINDING_KEY]: { forged: true } }),
      readCatalog: ready(makeCatalog()),
      refresh: noRefresh,
    });
    expect(ordinary).toEqual(createRequest({ provider: "codex" }));
  });

  it("blocks creation while the catalog is expired", async () => {
    await expect(
      applyWorkerOnCreate({
        request: createRequest({}),
        readCatalog: async () => ({ state: "expired", path: "catalog.json", message: "Expired." }),
        refresh: noRefresh,
      }),
    ).rejects.toThrow("Expired.");
  });
});

describe("agent.open.before", () => {
  let home: string;
  const tool: AgentToolDefinition = {
    name: "nuhuo_list_workers",
    description: "Lists Workers",
    input: z.object({}),
    execute: () => ({ text: "" }),
  };

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "nuhuo-open-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function paths() {
    return {
      instructions: path.join(home, "instructions"),
      skills: path.join(home, "skills"),
      secrets: path.join(home, "secrets"),
    };
  }

  async function installWorkerFiles() {
    const release = makeRelease();
    const fetchAsset = async (digest: string) =>
      digest === SKILL_DIGEST
        ? { digest, kind: "skill", name: "review", version: "1.0.0", files: SKILL_FILES }
        : { digest, kind: "instructions", name: "reviewer.md", content: INSTRUCTIONS };
    await ensureInstructions({ directory: paths().instructions, release, fetchAsset });
    await ensureSkill({ directory: paths().skills, skill: release.skills[0]!, fetchAsset });
    await writeSecrets(paths().secrets, { "github-token": "ghp_1", "tracker-token": "Bearer t" });
  }

  function openRequest(
    overrides: Partial<PluginSessionOpenRequest> = {},
  ): PluginSessionOpenRequest {
    return {
      agentId: "agent_1",
      workspaceId: null,
      provider: "nuhuo-claude",
      cwd: "/srv/app",
      reason: "resume",
      purpose: "interactive",
      title: null,
      background: false,
      labels: {},
      metadata: {
        [BINDING_KEY]: { workerId: "reviewer", workerName: "Code reviewer", releaseDigest: "x" },
      },
      tools: [],
      env: { EXISTING: "1" },
      mcpServers: {},
      ...overrides,
    };
  }

  it("adds the Worker's instructions, Skill paths, environment, secrets, MCP servers, and tools", async () => {
    await installWorkerFiles();
    const result = await contributeOnOpen({
      catalog: makeCatalog(),
      request: openRequest(),
      readSecret: createSecretReader(paths().secrets),
      paths: paths(),
      tools: [tool],
    });

    expect(result.env).toEqual({ EXISTING: "1", REVIEW_DEPTH: "full", GITHUB_TOKEN: "ghp_1" });
    expect(result.mcpServers).toEqual({
      tracker: {
        type: "http",
        url: "https://tracker.example.com/mcp",
        headers: { Authorization: "Bearer t", "X-Team": "core" },
      },
    });
    expect(result.tools).toEqual([tool]);
    expect(result.appendSystemPrompt).toEqual([
      `# Reviewer\r\nReview carefully.\n\n## Skill files on this host\n- review 1.0.0: ${path.join(home, "skills", "review", "1.0.0")}`,
    ]);
  });

  it("blocks a Worker that left this host, changed provider, or lacks its Skill", async () => {
    const readSecret = createSecretReader(paths().secrets);
    await expect(
      contributeOnOpen({
        catalog: makeCatalog({ workers: [] }),
        request: openRequest(),
        readSecret,
        paths: paths(),
        tools: [],
      }),
    ).rejects.toThrow('Worker "Code reviewer" is no longer on this host.');

    await expect(
      contributeOnOpen({
        catalog: makeCatalog(),
        request: openRequest({ provider: "claude" }),
        readSecret,
        paths: paths(),
        tools: [],
      }),
    ).rejects.toThrow("now runs on provider nuhuo-claude");

    await expect(
      contributeOnOpen({
        catalog: makeCatalog(),
        request: openRequest(),
        readSecret,
        paths: paths(),
        tools: [],
      }),
    ).rejects.toThrow('Skill "review" of Worker "Code reviewer" has not reached this host.');
  });

  it("gives an ordinary agent the tools, and blocks it when the host requires Workers", async () => {
    const readSecret = createSecretReader(paths().secrets);
    const ordinary = await contributeOnOpen({
      catalog: makeCatalog(),
      request: openRequest({ metadata: {} }),
      readSecret,
      paths: paths(),
      tools: [tool],
    });
    expect(ordinary.tools).toEqual([tool]);
    expect(ordinary.appendSystemPrompt).toBeUndefined();

    await expect(
      contributeOnOpen({
        catalog: makeCatalog({ policy: { requireWorker: true } }),
        request: openRequest({ metadata: {} }),
        readSecret,
        paths: paths(),
        tools: [tool],
      }),
    ).rejects.toThrow("not started as a Nuhuo Worker");
  });
});
