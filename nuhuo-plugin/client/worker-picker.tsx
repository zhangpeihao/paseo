import { useCallback, useMemo } from "react";
import { useComposer } from "@getpaseo/plugin/client";
import { Select } from "@getpaseo/plugin/client/ui";
import { BINDING_KEY, WORKER_CHOICE_KEY, bindingSchema } from "../shared/catalog";
import type { WorkerSummary } from "../shared/rpc";
import { useHostStatus } from "./use-host-status";

const NO_WORKER = "";
const NO_WORKERS: readonly WorkerSummary[] = [];

interface WorkerOption {
  value: string;
  label: string;
  description?: string;
}

function ignoreChange() {}

/**
 * Chooses one of this host's Workers for a new agent and shows the bound Worker on a running one.
 * The create hook applies the release again on the daemon; this control only shows the choice.
 */
export function WorkerPicker() {
  const composer = useComposer();
  const { state } = useHostStatus();
  const host = state.status === "ready" ? state.host : null;
  const readyHost = host?.state === "ready" ? host : null;
  const workers = useMemo(
    () => readyHost?.workers.filter((worker) => worker.onThisHost) ?? NO_WORKERS,
    [readyHost],
  );
  const { metadata } = composer.agent;

  const binding = useMemo(() => {
    const parsed = bindingSchema.safeParse(metadata[BINDING_KEY]);
    return parsed.success ? parsed.data : null;
  }, [metadata]);

  const chosen = metadata[WORKER_CHOICE_KEY];
  const value = typeof chosen === "string" ? chosen : (readyHost?.defaultWorkerId ?? NO_WORKER);

  const boundOptions = useMemo<WorkerOption[]>(
    () => (binding ? [{ value: binding.workerId, label: binding.workerName }] : []),
    [binding],
  );

  const unavailableOptions = useMemo<WorkerOption[]>(
    () =>
      host !== null && host.state !== "ready"
        ? [{ value: NO_WORKER, label: "Nuhuo settings unavailable", description: host.message }]
        : [],
    [host],
  );

  const workerOptions = useMemo<WorkerOption[]>(() => {
    if (readyHost === null) return [];
    const options: WorkerOption[] = workers.map((worker) => ({
      value: worker.workerId,
      label:
        worker.workerId === readyHost.defaultWorkerId ? `${worker.name} (default)` : worker.name,
      description: [
        worker.roleId,
        worker.model === "" ? worker.providerId : `${worker.providerId}/${worker.model}`,
      ].join(" · "),
    }));
    if (!readyHost.requireWorker) {
      options.unshift({
        value: NO_WORKER,
        label: "No Worker",
        description: "Start an ordinary agent.",
      });
    } else if (value === NO_WORKER) {
      options.unshift({
        value: NO_WORKER,
        label: "Choose a Worker",
        description: "This host runs only your Workers.",
      });
    }
    return options;
  }, [readyHost, workers, value]);

  const choose = useCallback(
    async ({ value: next }: { value: string }) => {
      if (next === NO_WORKER) {
        await composer.setMetadata({ [WORKER_CHOICE_KEY]: null });
        return;
      }
      const worker = workers.find((candidate) => candidate.workerId === next);
      if (!worker) throw new Error(`Worker "${next}" is not on this host.`);
      await composer.setMetadata({ [WORKER_CHOICE_KEY]: worker.workerId });
      if (composer.agent.provider !== worker.providerId) {
        await composer.setProvider(worker.providerId);
      }
      if (worker.model !== "") await composer.setModel(worker.model);
      if (worker.modeId !== undefined) await composer.setMode(worker.modeId);
      if (worker.thinkingOptionId !== undefined) {
        await composer.setThinking(worker.thinkingOptionId);
      }
    },
    [composer, workers],
  );

  if (composer.context === "agent") {
    if (binding === null) return null;
    return (
      <Select
        title="Worker"
        icon="BadgeCheck"
        disabled
        value={binding.workerId}
        options={boundOptions}
        onValueChange={ignoreChange}
      />
    );
  }

  if (host === null) return null;
  if (readyHost === null) {
    return (
      <Select
        title="Worker"
        icon="TriangleAlert"
        disabled
        value={NO_WORKER}
        options={unavailableOptions}
        onValueChange={ignoreChange}
      />
    );
  }

  return (
    <Select
      title="Worker"
      icon="BadgeCheck"
      value={value}
      options={workerOptions}
      onValueChange={choose}
    />
  );
}
