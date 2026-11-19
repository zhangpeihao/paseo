import { readFile } from "node:fs/promises";
import path from "node:path";
import { SECRET_NAME_PATTERN } from "../shared/bundle";
import { NuhuoPolicyError } from "./policy";

export type SecretReader = (name: string) => Promise<string>;

/** Reads `secretRef` files at open time so their values never reach saved agent configuration. */
export function createSecretReader(directory: string): SecretReader {
  return async function readSecret(name) {
    if (!SECRET_NAME_PATTERN.test(name)) {
      throw new NuhuoPolicyError(`Secret "${name}" has an invalid name.`);
    }
    try {
      const value = await readFile(path.join(directory, name), "utf8");
      return value.replace(/\r?\n$/, "");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new NuhuoPolicyError(
          `Secret "${name}" is missing on this host. Ask your Nuhuo administrator to reprovision it.`,
        );
      }
      throw error;
    }
  };
}
