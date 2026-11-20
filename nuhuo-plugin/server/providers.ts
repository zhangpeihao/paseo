import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { PROVIDER_PREFIX, type CatalogProvider, type ProviderKind } from "../shared/catalog";

type PaseoApi = PluginHandlerContext["paseo"];

/** The variable each built-in provider reads its endpoint from. */
const BASE_URL_ENV: Partial<Record<ProviderKind, string>> = {
  claude: "ANTHROPIC_BASE_URL",
  codex: "OPENAI_BASE_URL",
};

export interface ProviderProfile {
  extends: ProviderKind;
  label: string;
  env: Record<string, string>;
  models?: { id: string; label: string }[];
}

export interface ProviderPlan {
  profiles: Record<string, ProviderProfile>;
  problems: string[];
}

export interface ProviderChanges {
  added: string[];
  updated: string[];
  removed: string[];
}

const savedProfileSchema = z
  .object({
    extends: z.string().optional(),
    label: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    models: z.array(z.object({ id: z.string(), label: z.string() }).passthrough()).optional(),
  })
  .passthrough();
type SavedProfile = z.infer<typeof savedProfileSchema>;

/** Turns the catalog's providers into Paseo profiles with their API keys resolved. */
export function planProviders(
  providers: readonly CatalogProvider[],
  secrets: Readonly<Record<string, string>>,
): ProviderPlan {
  const profiles: Record<string, ProviderProfile> = {};
  const problems: string[] = [];
  for (const provider of providers) {
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const [name, { secretRef }] of Object.entries(provider.env)) {
      const value = secrets[secretRef];
      if (value === undefined) missing.push(name);
      else env[name] = value;
    }
    if (missing.length > 0) {
      problems.push(`Provider "${provider.label}" has no value for ${missing.join(", ")}.`);
      continue;
    }
    if (provider.baseUrl !== undefined) {
      const variable = BASE_URL_ENV[provider.kind];
      if (variable === undefined) {
        problems.push(
          `Provider "${provider.label}" sets a base URL, which ${provider.kind} providers do not support.`,
        );
        continue;
      }
      env[variable] = provider.baseUrl;
    }
    profiles[provider.id] = {
      extends: provider.kind,
      label: provider.label,
      env,
      ...(provider.models.length === 0
        ? {}
        : { models: provider.models.map((id) => ({ id, label: id })) }),
    };
  }
  return { profiles, problems };
}

/**
 * Makes the daemon's `nuhuo-` provider profiles match `profiles`. Profiles without the prefix are
 * the employee's and stay as they are.
 */
export async function reconcileProviders(
  paseo: PaseoApi,
  profiles: Readonly<Record<string, ProviderProfile>>,
): Promise<ProviderChanges> {
  const { config } = await paseo.config.get();
  const saved: Record<string, SavedProfile> = {};
  for (const [id, value] of Object.entries(config.providers ?? {})) {
    if (!id.startsWith(PROVIDER_PREFIX)) continue;
    const parsed = savedProfileSchema.safeParse(value);
    saved[id] = parsed.success ? parsed.data : {};
  }

  const removed = Object.keys(saved).filter((id) => !(id in profiles));
  const added: string[] = [];
  const updated: string[] = [];
  const replaced: string[] = [];
  for (const [id, profile] of Object.entries(profiles)) {
    const current = saved[id];
    if (current === undefined) {
      added.push(id);
    } else if (!sameProfile(current, profile)) {
      updated.push(id);
      // A patch merges into the saved profile, so a variable or model list it drops needs a removal.
      if (dropsFields(current, profile)) replaced.push(id);
    }
  }

  if (removed.length > 0 || replaced.length > 0) {
    await paseo.config.patch({ removeProviders: [...removed, ...replaced] });
  }
  const changed = [...added, ...updated];
  if (changed.length > 0) {
    await paseo.config.patch({
      // A spread copy has an implicit index signature, which the patch's provider records need.
      providers: Object.fromEntries(changed.map((id) => [id, { ...profiles[id] }])),
    });
  }
  return { added, updated, removed };
}

function sameProfile(saved: SavedProfile, wanted: ProviderProfile): boolean {
  return (
    saved.extends === wanted.extends &&
    saved.label === wanted.label &&
    sameRecord(saved.env ?? {}, wanted.env) &&
    sameModels(saved.models, wanted.models)
  );
}

function dropsFields(saved: SavedProfile, wanted: ProviderProfile): boolean {
  const droppedVariable = Object.keys(saved.env ?? {}).some((name) => !(name in wanted.env));
  return droppedVariable || (saved.models !== undefined && wanted.models === undefined);
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function sameModels(saved: SavedProfile["models"], wanted: ProviderProfile["models"]): boolean {
  if (saved === undefined || wanted === undefined) return saved === wanted;
  return (
    saved.length === wanted.length &&
    saved.every(
      (model, index) => model.id === wanted[index]?.id && model.label === wanted[index]?.label,
    )
  );
}
