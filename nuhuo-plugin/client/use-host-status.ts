import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { importRpc, statusRpc, type HostStatus } from "../shared/rpc";

export type HostStatusState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; host: HostStatus };

export interface HostStatusHandle {
  state: HostStatusState;
  importing: boolean;
  refresh(): void;
  /** Pulls from Nuhuo now; resolves to the error message, or null when the pull succeeded. */
  importNow(): Promise<string | null>;
}

/** Reads this host's Nuhuo status from its daemon each time a surface mounts or refreshes. */
export function useHostStatus(): HostStatusHandle {
  const getStatus = useRpc(statusRpc);
  const runImport = useRpc(importRpc);
  const [state, setState] = useState<HostStatusState>({ status: "loading" });
  const [importing, setImporting] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const host = await getStatus({});
        if (active) setState({ status: "ready", host });
      } catch (error) {
        if (active) setState({ status: "error", message: describe(error) });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [getStatus, generation]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  const importNow = useCallback(async () => {
    setImporting(true);
    try {
      const host = await runImport({});
      setState({ status: "ready", host });
      return host.sync.lastError;
    } catch (error) {
      return describe(error);
    } finally {
      setImporting(false);
    }
  }, [runImport]);

  return { state, importing, refresh, importNow };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
