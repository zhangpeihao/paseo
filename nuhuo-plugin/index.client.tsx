import { useCallback } from "react";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { WorkerPicker } from "./client/worker-picker";
import { WorkersScreen } from "./client/workers-screen";

const SCREEN_ID = "workers";

function NuhuoItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: SCREEN_ID }), [openScreen]);
  return (
    <SidebarRow icon="BadgeCheck" active={currentScreen?.screenId === SCREEN_ID} onPress={open} />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: SCREEN_ID, title: "Nuhuo", Component: WorkersScreen });
  client.addSidebarHeaderItem({ id: "nuhuo", title: "Nuhuo", Component: NuhuoItem });
  client.addComposerItem({ id: "worker", Component: WorkerPicker });
  client.addCommandCenterItem({
    id: "workers",
    title: "Nuhuo: import and show Workers",
    icon: "BadgeCheck",
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });
  return () => {};
}
