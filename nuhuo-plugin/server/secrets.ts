import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory, isMissingFile, writeFileAtomic } from "./files";
import { NuhuoPolicyError } from "./errors";

/** A `secretRef` is stored as a file of that name, so it never contains a path separator. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type SecretReader = (name: string) => Promise<string>;

/**
 * Makes the secrets directory hold exactly `values`. Files are `0600` in a `0700` directory.
 * Returns the names it refused.
 */
export async function writeSecrets(
  directory: string,
  values: Readonly<Record<string, string>>,
): Promise<string[]> {
  await ensurePrivateDirectory(directory);
  const refused: string[] = [];
  const wanted = new Set<string>();
  for (const [name, value] of Object.entries(values)) {
    if (!SECRET_NAME_PATTERN.test(name)) {
      refused.push(name);
      continue;
    }
    wanted.add(name);
    const filePath = path.join(directory, name);
    if ((await readExisting(filePath)) !== value) await writeFileAtomic(filePath, value);
  }
  for (const entry of await readdir(directory)) {
    if (!wanted.has(entry)) await rm(path.join(directory, entry), { force: true });
  }
  return refused;
}

/** Reads `secretRef` files at open time, so their values never reach saved agent configuration. */
export function createSecretReader(directory: string): SecretReader {
  return async function readSecret(name) {
    if (!SECRET_NAME_PATTERN.test(name)) {
      throw new NuhuoPolicyError(`Secret "${name}" has an invalid name.`);
    }
    const value = await readExisting(path.join(directory, name));
    if (value === null) {
      throw new NuhuoPolicyError(
        `Secret "${name}" is missing on this host. Add it in Nuhuo, then press Import on the Nuhuo screen.`,
      );
    }
    return value;
  };
}

async function readExisting(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}
