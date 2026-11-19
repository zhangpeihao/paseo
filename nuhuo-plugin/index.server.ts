import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BundleStore, resolveBundlePath, secretsDirectoryFor } from "./server/bundle-store";
import {
  applyWorkerOnCreate,
  contributeOnOpen,
  describeStatus,
  usableBundle,
} from "./server/policy";
import { createSecretReader } from "./server/secrets";
import { statusRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const store = new BundleStore(resolveBundlePath());
  const readSecret = createSecretReader(secretsDirectoryFor(store.filePath));

  server.addHook("agent.create.before", async ({ request }) =>
    applyWorkerOnCreate(usableBundle(await store.read()), request),
  );

  server.addHook("agent.open.before", async ({ request }) => {
    // Reading history never starts the provider, so it never needs a Worker.
    if (request.purpose === "history") return undefined;
    return contributeOnOpen({ bundle: usableBundle(await store.read()), request, readSecret });
  });

  server.handle(statusRpc, async () => describeStatus(await store.read()));

  return () => {};
}
