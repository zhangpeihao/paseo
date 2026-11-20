import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { planProviders, reconcileProviders, type ProviderProfile } from "./providers";
import { makeCatalog } from "./test-fixtures";

type PaseoApi = PluginHandlerContext["paseo"];

/** Records patches against a saved provider map; only `config.get` and `config.patch` exist. */
function fakeDaemon(saved: Record<string, unknown>) {
  const patches: unknown[] = [];
  const paseo = {
    config: {
      get: async () => ({ requestId: "r", config: { providers: saved } }),
      patch: async (patch: unknown) => {
        patches.push(patch);
        return { requestId: "r", config: {} };
      },
    },
  } as unknown as PaseoApi;
  return { paseo, patches };
}

const CLAUDE: ProviderProfile = {
  extends: "claude",
  label: "My Claude",
  env: { ANTHROPIC_API_KEY: "sk-ant-1" },
};

describe("planProviders", () => {
  it("resolves API keys from secrets and maps the base URL to the provider's variable", () => {
    const catalog = makeCatalog({
      providers: [
        {
          id: "nuhuo-gateway",
          label: "Gateway",
          kind: "codex",
          baseUrl: "https://llm.example.com/v1",
          env: { OPENAI_API_KEY: { secretRef: "provider:nuhuo-gateway:apiKey" } },
          models: ["gpt-5"],
        },
        {
          id: "nuhuo-missing",
          label: "Missing",
          kind: "claude",
          env: { ANTHROPIC_API_KEY: { secretRef: "provider:nuhuo-missing:apiKey" } },
          models: [],
        },
        {
          id: "nuhuo-pi",
          label: "Pi",
          kind: "pi",
          baseUrl: "https://pi.example.com",
          env: { OPENAI_API_KEY: { secretRef: "provider:nuhuo-pi:apiKey" } },
          models: [],
        },
      ],
    });

    const plan = planProviders(catalog.providers, {
      "provider:nuhuo-gateway:apiKey": "sk-1",
      "provider:nuhuo-pi:apiKey": "sk-2",
    });

    expect(plan.profiles).toEqual({
      "nuhuo-gateway": {
        extends: "codex",
        label: "Gateway",
        env: { OPENAI_API_KEY: "sk-1", OPENAI_BASE_URL: "https://llm.example.com/v1" },
        models: [{ id: "gpt-5", label: "gpt-5" }],
      },
    });
    expect(plan.problems).toEqual([
      'Provider "Missing" has no value for ANTHROPIC_API_KEY.',
      'Provider "Pi" sets a base URL, which pi providers do not support.',
    ]);
  });
});

describe("reconcileProviders", () => {
  it("does nothing when the saved profiles already match", async () => {
    const { paseo, patches } = fakeDaemon({ "nuhuo-claude": CLAUDE, claude: { enabled: true } });

    const changes = await reconcileProviders(paseo, { "nuhuo-claude": CLAUDE });

    expect(changes).toEqual({ added: [], updated: [], removed: [] });
    expect(patches).toEqual([]);
  });

  it("adds new profiles and removes stale nuhuo- profiles, leaving the employee's own", async () => {
    const { paseo, patches } = fakeDaemon({ "nuhuo-old": CLAUDE, "my-zai": { extends: "claude" } });

    const changes = await reconcileProviders(paseo, { "nuhuo-claude": CLAUDE });

    expect(changes).toEqual({ added: ["nuhuo-claude"], updated: [], removed: ["nuhuo-old"] });
    expect(patches).toEqual([
      { removeProviders: ["nuhuo-old"] },
      { providers: { "nuhuo-claude": CLAUDE } },
    ]);
  });

  it("updates a rotated key in place and replaces a profile that drops a variable", async () => {
    const rotated = fakeDaemon({
      "nuhuo-claude": { ...CLAUDE, env: { ANTHROPIC_API_KEY: "old" } },
    });
    await reconcileProviders(rotated.paseo, { "nuhuo-claude": CLAUDE });
    expect(rotated.patches).toEqual([{ providers: { "nuhuo-claude": CLAUDE } }]);

    const dropped = fakeDaemon({
      "nuhuo-claude": { ...CLAUDE, env: { ...CLAUDE.env, ANTHROPIC_BASE_URL: "https://old" } },
    });
    await reconcileProviders(dropped.paseo, { "nuhuo-claude": CLAUDE });
    expect(dropped.patches).toEqual([
      { removeProviders: ["nuhuo-claude"] },
      { providers: { "nuhuo-claude": CLAUDE } },
    ]);
  });
});
