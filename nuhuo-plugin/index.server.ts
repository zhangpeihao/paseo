import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CatalogStore } from "./server/catalog-store";
import { applyWorkerOnCreate, contributeOnOpen, usableCatalog } from "./server/policy";
import { resolveNuhuoPaths } from "./server/paths";
import { createSecretReader } from "./server/secrets";
import { startWorker } from "./server/start-worker";
import { describeStatus } from "./server/status";
import { NuhuoSync } from "./server/sync";
import { createWorkerTools } from "./server/worker-tools";
import { importRpc, startWorkerRpc, statusRpc } from "./shared/rpc";

const PULL_INTERVAL_MS = 5 * 60 * 1000;
/** A create waits this long for a pull on an unknown Worker, inside the 30-second hook timeout. */
const CREATE_PULL_TIMEOUT_MS = 10_000;

export default function contribute(server: PluginServerContext) {
  const paths = resolveNuhuoPaths();
  const store = new CatalogStore(paths.catalog);
  const sync = new NuhuoSync({ paths, store, log: (message) => console.warn(message) });
  const readSecret = createSecretReader(paths.secrets);
  const readCatalog = () => store.read();
  const tools = createWorkerTools(readCatalog);

  void sync.pull();
  const timer = setInterval(() => void sync.pull(), PULL_INTERVAL_MS);

  server.addHook("agent.create.before", async ({ request }, { paseo }) => {
    sync.attach(paseo);
    return applyWorkerOnCreate({
      request,
      readCatalog,
      refresh: async () => {
        await Promise.race([sync.pullFresh(), delay(CREATE_PULL_TIMEOUT_MS)]);
      },
    });
  });

  server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    sync.attach(paseo);
    // Reading history never starts the provider, so it never needs a Worker.
    if (request.purpose === "history") return undefined;
    return contributeOnOpen({
      catalog: usableCatalog(await readCatalog()),
      request,
      readSecret,
      paths,
      tools,
    });
  });

  server.handle(statusRpc, async (_input, { paseo }) => {
    sync.attach(paseo);
    return describeStatus({ state: await readCatalog(), sync: sync.getStatus(), paseo });
  });

  server.handle(importRpc, async (_input, { paseo }) => {
    sync.attach(paseo);
    const status = await sync.pullFresh();
    return describeStatus({ state: await readCatalog(), sync: status, paseo });
  });

  server.handle(startWorkerRpc, async ({ workerId }, { paseo }) => {
    sync.attach(paseo);
    return startWorker({ paseo, catalog: usableCatalog(await readCatalog()), workerId });
  });

  return () => clearInterval(timer);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
