import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import { useChannelRoster } from "../../features/relay/react";
import type { Task } from "./model";
import { type Place, readPlaces } from "./places";
import { type TasksState, type TasksView, watchTasks } from "./store";

const loading: TasksView = {
  snapshot: () => ({ status: "loading", tasks: [] }) satisfies TasksState,
  subscribe: () => () => {},
  dispose: () => {},
};

/** One live view per session, shared by the page, panels and task links,
 * and closed when the last of them unmounts. */
const shared = new WeakMap<RelaySession, { view: TasksView; users: number }>();

function acquire(session: RelaySession) {
  const entry = shared.get(session) ?? { view: watchTasks(session), users: 0 };
  entry.users += 1;
  shared.set(session, entry);
  return {
    view: entry.view,
    release() {
      entry.users -= 1;
      if (entry.users > 0) return;
      shared.delete(session);
      entry.view.dispose();
    },
  };
}

/** Every current task the viewer can read, live while mounted. */
export function useTasks(session: RelaySession | undefined): TasksState {
  const [view, setView] = useState<TasksView>(loading);
  useEffect(() => {
    if (!session) {
      setView(loading);
      return;
    }
    const held = acquire(session);
    setView(held.view);
    return held.release;
  }, [session]);
  return useSyncExternalStore(view.subscribe, view.snapshot, view.snapshot);
}

/** Tasks from the live view, with this device's saves shown until the
 * relay's copy has them: the same revision, or a strictly newer one. A tie
 * keeps the save, the newest this device knows of. */
export function useTasksWithSaved(session: RelaySession) {
  const state = useTasks(session);
  const [saved, setSavedMap] = useState<ReadonlyMap<string, Task>>(new Map());
  const setSaved = useCallback(
    (task: Task) =>
      setSavedMap((current) => new Map(current).set(task.id, task)),
    [],
  );
  const tasks = useMemo(() => {
    if (!saved.size) return state.tasks;
    const live = new Map(state.tasks.map((task) => [task.id, task]));
    for (const task of saved.values()) {
      const current = live.get(task.id);
      if (
        !current ||
        (current.revision !== task.revision &&
          current.updatedAt <= task.updatedAt)
      )
        live.set(task.id, task);
    }
    return [...live.values()];
  }, [state.tasks, saved]);
  return { ...state, tasks, setSaved };
}

/** Names, kinds and projects of `ids`, read once per distinct set. Places
 * not yet read are absent; a failed read leaves them unnamed. */
export function usePlaces(
  session: RelaySession,
  ids: readonly string[],
): ReadonlyMap<string, Place> {
  const key = [...new Set(ids)].sort().join(",");
  const [places, setPlaces] = useState<ReadonlyMap<string, Place>>(new Map());
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    readPlaces(session, key.split(","), controller.signal).then(
      (read) =>
        !controller.signal.aborted &&
        setPlaces((current) => new Map([...current, ...read])),
      () => {},
    );
    return () => controller.abort();
  }, [session, key]);
  return places;
}

/** Where the viewer can make or move a task: channels and chats in their
 * list they can post in. DMs hold no tasks. */
export const isTaskHome = (channel: ChannelSummary) =>
  !channel.archived &&
  !channel.readOnly &&
  !channel.pending &&
  !channel.huddle &&
  channel.viewerRole !== "guest" &&
  channel.viewerRole !== undefined &&
  (channel.channelType === "stream" ||
    channel.channelType === "forum" ||
    channel.channelType === "solo");

export function useTaskHomes(session: RelaySession) {
  const { channels } = useChannelRoster(session.channels);
  return useMemo(() => channels.filter(isTaskHome), [channels]);
}

/** Whether the viewer may edit tasks in `home`, as far as this device
 * knows: a guest or read-only place is view only. A place the viewer reads
 * through its project isn't in their list; the relay decides there. */
export function useCanEdit(session: RelaySession, home: string) {
  const { channels } = useChannelRoster(session.channels);
  const channel = channels.find((item) => item.id === home);
  return !channel || (!channel.readOnly && channel.viewerRole !== "guest");
}
