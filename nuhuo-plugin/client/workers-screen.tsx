import { useCallback, useState } from "react";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { startWorkerRpc, type HostLink, type HostStatus, type WorkerSummary } from "../shared/rpc";
import { useHostStatus } from "./use-host-status";

type ReadyStatus = Extract<HostStatus, { state: "ready" }>;

const STATE_LABELS = {
  missing: "Not imported",
  invalid: "Unreadable",
  expired: "Expired",
} as const;

const LINK_LABELS: Record<HostLink, string> = {
  "this-host": "This host",
  online: "Linked",
  connecting: "Connecting",
  offline: "Offline",
  error: "Link failed",
  disabled: "Link turned off",
  "not-linked": "Not linked yet",
};

/** Imports from Nuhuo and lists the employee's providers and Workers. Both are edited in Nuhuo. */
export function WorkersScreen({ navigation }: PluginScreenProps) {
  const { state, importing, refresh, importNow } = useHostStatus();
  const startWorker = useRpc(startWorkerRpc);
  const toast = useToast();
  const [starting, setStarting] = useState<string | null>(null);

  const onImport = useCallback(() => {
    async function run() {
      const error = await importNow();
      if (error === null) toast.show("Imported from Nuhuo", { variant: "success" });
      else toast.show(error, { variant: "error" });
    }
    void run();
  }, [importNow, toast]);

  const onChat = useCallback(
    async (worker: WorkerSummary) => {
      setStarting(worker.workerId);
      try {
        const started = await startWorker({ workerId: worker.workerId });
        if (navigation) navigation.openAgent(started);
        else toast.show(`Started ${worker.name}. Open it from the agent list.`);
      } catch (error) {
        toast.show(error instanceof Error ? error.message : String(error), { variant: "error" });
      } finally {
        setStarting(null);
      }
    },
    [navigation, startWorker, toast],
  );

  if (state.status === "loading") {
    return (
      <SettingsSection title="Nuhuo">
        <SettingsCard>
          <SettingsRow label="Status" hint="Loading…" />
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (state.status === "error") {
    return (
      <SettingsSection title="Nuhuo">
        <SettingsCard>
          <SettingsRow label="Status" error={state.message} />
          <SettingsAction label="Try again" actionLabel="Refresh" onPress={refresh} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const { host } = state;
  const importAction = (
    <SettingsAction
      label="Import from Nuhuo"
      hint={describeSync(host)}
      error={host.sync.lastError}
      actionLabel={importing ? "Importing…" : "Import"}
      disabled={importing}
      onPress={onImport}
    />
  );

  if (host.state !== "ready") {
    return (
      <SettingsSection title="Nuhuo">
        <SettingsCard>
          <SettingsRow label="Status" hint={STATE_LABELS[host.state]} error={host.message} />
          {host.detail === undefined ? null : <SettingsRow label="Details" hint={host.detail} />}
          {importAction}
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title="Nuhuo">
        <SettingsCard>
          {importAction}
          <SettingsRow
            label="Workers required"
            hint={host.requireWorker ? "Every agent runs as a Worker" : "Ordinary agents allowed"}
          />
          <SettingsRow label="Settings expire" hint={host.expiresAt} />
          {host.sync.problems.map((problem) => (
            <SettingsRow key={problem} label="Needs attention" error={problem} />
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Providers">
        <SettingsCard>
          {host.providers.length === 0 ? (
            <SettingsRow label="No providers" hint="Add a provider with your API key in Nuhuo." />
          ) : (
            host.providers.map((provider) => (
              <SettingsRow
                key={provider.id}
                label={provider.label}
                hint={[provider.kind, ...provider.models].join(" · ")}
              />
            ))
          )}
        </SettingsCard>
      </SettingsSection>
      <HostWorkers host={host} starting={starting} onChat={onChat} />
    </>
  );
}

function HostWorkers(props: {
  host: ReadyStatus;
  starting: string | null;
  onChat(worker: WorkerSummary): Promise<void>;
}) {
  const { host, starting, onChat } = props;
  return host.hosts.map((entry) => {
    const workers = host.workers.filter((worker) => worker.hostId === entry.hostId);
    return (
      <SettingsSection key={entry.hostId} title={`${entry.name} · ${LINK_LABELS[entry.link]}`}>
        <SettingsCard>
          {workers.length === 0 ? (
            <SettingsRow label="No Workers" hint="Create a Worker for this host in Nuhuo." />
          ) : (
            workers.map((worker) => (
              <WorkerRow
                key={worker.workerId}
                worker={worker}
                isDefault={worker.workerId === host.defaultWorkerId}
                starting={starting}
                onChat={onChat}
              />
            ))
          )}
        </SettingsCard>
      </SettingsSection>
    );
  });
}

function WorkerRow(props: {
  worker: WorkerSummary;
  isDefault: boolean;
  starting: string | null;
  onChat(worker: WorkerSummary): Promise<void>;
}) {
  const { worker, isDefault, starting, onChat } = props;
  const chat = useCallback(() => void onChat(worker), [onChat, worker]);
  return (
    <SettingsAction
      label={isDefault ? `${worker.name} (default)` : worker.name}
      hint={describeWorker(worker)}
      actionLabel={starting === worker.workerId ? "Starting…" : "Chat"}
      disabled={starting !== null}
      onPress={chat}
    />
  );
}

function describeWorker(worker: WorkerSummary): string {
  const model = worker.model === "" ? worker.providerId : `${worker.providerId}/${worker.model}`;
  return [worker.roleId, model, worker.modeId].filter(Boolean).join(" · ");
}

function describeSync(host: HostStatus): string {
  const { sync } = host;
  if (sync.pulling) return "Importing now";
  if (sync.lastSuccessAt === null) return "Not imported yet";
  return `Last imported ${sync.lastSuccessAt}`;
}
