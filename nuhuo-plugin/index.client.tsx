import type { PluginClientContext } from "@getpaseo/plugin/client";
import { StatusScreen } from "./client/status-screen";
import { WorkerPicker } from "./client/worker-picker";

export default function contribute(client: PluginClientContext) {
  client.addComposerItem({ id: "worker", Component: WorkerPicker });
  client.addSettingsScreen({
    id: "status",
    title: "Nuhuo",
    icon: "BadgeCheck",
    Component: StatusScreen,
  });
  client.addCommandCenterItem({
    id: "status",
    title: "Nuhuo: show assigned Workers",
    icon: "BadgeCheck",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("status");
    },
  });
  return () => {};
}
