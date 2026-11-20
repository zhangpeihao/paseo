import os from "node:os";
import path from "node:path";

export const HOME_ENV = "NUHUO_PASEO_HOME";
const DEFAULT_HOME = path.join(".nuhuo", "paseo");

/** Where Nuhuo's setup writes the credential and the plugin keeps what it pulls. */
export interface NuhuoPaths {
  home: string;
  credential: string;
  catalog: string;
  secrets: string;
  instructions: string;
  skills: string;
}

export function resolveNuhuoPaths(env: NodeJS.ProcessEnv = process.env): NuhuoPaths {
  const home = resolveHome(env[HOME_ENV]?.trim());
  return {
    home,
    credential: path.join(home, "host.json"),
    catalog: path.join(home, "catalog.json"),
    secrets: path.join(home, "secrets"),
    instructions: path.join(home, "instructions"),
    skills: path.join(home, "skills"),
  };
}

function resolveHome(configured: string | undefined): string {
  if (!configured) return path.join(os.homedir(), DEFAULT_HOME);
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
  return path.resolve(configured);
}
