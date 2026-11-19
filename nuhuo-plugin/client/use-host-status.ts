import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { statusRpc, type HostStatus } from "../shared/rpc";

export type HostStatusState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; host: HostStatus };

/** Reads this host's Nuhuo status from the daemon each time a surface mounts or refreshes. */
export function useHostStatus(): { state: HostStatusState; refresh(): void } {
  const getStatus = useRpc(statusRpc);
  const [state, setState] = useState<HostStatusState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const host = await getStatus({});
        if (active) setState({ status: "ready", host });
      } catch (error) {
        if (active) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [getStatus, generation]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return { state, refresh };
}
