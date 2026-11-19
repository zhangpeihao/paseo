import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useHostStatus } from "./use-host-status";

const STATE_LABELS = {
  ready: "Ready",
  missing: "Not provisioned",
  invalid: "Invalid configuration",
  expired: "Expired",
} as const;

/** Shows what Nuhuo assigned to this host. Workers are edited in Nuhuo, not here. */
export function StatusScreen() {
  const { state, refresh } = useHostStatus();

  if (state.status === "loading") {
    return (
      <SettingsSection title="Host">
        <SettingsCard>
          <SettingsRow label="Status" hint="Loading…" />
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (state.status === "error") {
    return (
      <SettingsSection title="Host">
        <SettingsCard>
          <SettingsRow label="Status" error={state.message} />
          <SettingsAction label="Try again" actionLabel="Refresh" onPress={refresh} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const { host } = state;
  if (host.state !== "ready") {
    return (
      <SettingsSection title="Host">
        <SettingsCard>
          <SettingsRow label="Status" hint={STATE_LABELS[host.state]} error={host.message} />
          {host.detail === undefined ? null : <SettingsRow label="Details" hint={host.detail} />}
          <SettingsRow label="Configuration file" hint={host.bundlePath} />
          <SettingsAction label="Check again" actionLabel="Refresh" onPress={refresh} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title="Host">
        <SettingsCard>
          <SettingsRow label="Status" hint={STATE_LABELS.ready} />
          <SettingsRow label="Assigned to" hint={host.employee.displayName} />
          <SettingsRow label="Host" hint={host.hostId} />
          <SettingsRow
            label="Workers required"
            hint={host.requireWorker ? "Every agent runs as a Worker" : "Ordinary agents allowed"}
          />
          <SettingsRow
            label="Updated"
            hint={host.expiresAt ? `${host.issuedAt}, expires ${host.expiresAt}` : host.issuedAt}
          />
          <SettingsAction label="Check for changes" actionLabel="Refresh" onPress={refresh} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Workers">
        <SettingsCard>
          {host.workers.length === 0 ? (
            <SettingsRow
              label="No Workers"
              hint="Nuhuo has not assigned any Workers to this host."
            />
          ) : (
            host.workers.map((worker) => (
              <SettingsRow
                key={worker.workerId}
                label={
                  worker.workerId === host.defaultWorkerId
                    ? `${worker.name} (default)`
                    : worker.name
                }
                hint={[
                  worker.description,
                  [worker.displayVersion, worker.provider, worker.model]
                    .filter(Boolean)
                    .join(" · "),
                ]
                  .filter(Boolean)
                  .join("\n")}
              />
            ))
          )}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
