import { defineConfig } from "vitest/config";

// Stops Vitest from using the repository's root config, which needs the workspace dependencies.
export default defineConfig({
  test: { include: ["server/**/*.test.ts"] },
});
