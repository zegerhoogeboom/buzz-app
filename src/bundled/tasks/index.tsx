import { useSyncExternalStore } from "react";
import type {
  ChannelLauncherProps,
  PanelProps,
} from "../../features/panels/service";
import type { RelaySnapshot } from "../../features/relay/service";
import type { ChatSharing } from "../../features/solo/share-requests";
import type { PluginModule } from "../../plugins/api";
import { ClipboardCheckIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { readyToLink } from "./linking";
import { TasksGate } from "./TasksGate";
import { TasksPage } from "./TasksPage";
import { TasksPanel } from "./TasksPanel";
import { addTaskTools } from "./tools";

export const inject = ["pages", "panels", "relay", "navigation", "agents"];

const scopeOf = (state: RelaySnapshot) =>
  state.viewer && state.scope
    ? {
        viewer: state.viewer,
        communityOrigin: state.scope.slice(0, -(state.viewer.length + 1)),
      }
    : undefined;

export const apply: PluginModule["apply"] = (ctx) => {
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });
  // Read when used, so a host without it degrades to "can't link Solo chats".
  const sharing = () =>
    ctx.reflect.get("chatSharing") as ChatSharing | undefined;

  ctx.pages.register({
    id: "tasks",
    title: "Tasks",
    layout: "workspace",
    primary: true,
    placement: "dock",
    component: (props) => (
      <TasksPage
        {...props}
        relay={ctx.relay}
        navigator={ctx.navigation}
        sharing={sharing()}
      />
    ),
  });

  function Launcher({
    context,
    toggle,
    pressed,
    available,
  }: ChannelLauncherProps) {
    return (
      <IconButton
        size="sm"
        variant="ghost"
        data-channel-panel-toggle=""
        icon={<ClipboardCheckIcon size={16} aria-hidden="true" />}
        aria-label="Toggle tasks"
        title="Tasks"
        aria-expanded={pressed}
        onClick={(event) => {
          event.currentTarget.focus();
          if (active && available()) toggle(context.channelId);
        }}
      />
    );
  }
  function Panel({ channelContext }: PanelProps) {
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const scope = scopeOf(state);
    if (
      !channelContext ||
      !scope ||
      state.status !== "ready" ||
      state.scope !== channelContext.scope
    )
      return (
        <p role="status">Connect to this conversation to see its tasks.</p>
      );
    const session = state.session;
    return (
      <TasksGate
        key={`${state.scope}:${state.generation}:${channelContext.channelId}`}
        session={session}
      >
        {(channel) => (
          <TasksPanel
            session={session}
            channel={channel}
            chat={channelContext.channelId}
            readyToLink={(channelId, task) =>
              readyToLink(session, sharing(), channelId, { task })
            }
            openConversation={(channelId) =>
              void ctx.navigation.open({
                version: 1,
                kind: "conversation",
                scope,
                channelId,
              })
            }
          />
        )}
      </TasksGate>
    );
  }
  ctx.panels.register({
    id: "tasks",
    title: "Tasks",
    matches: () => false,
    channelLauncher: Launcher,
    channelPlacement: "side",
    component: Panel,
  });

  addTaskTools(ctx.agents, sharing);
};
