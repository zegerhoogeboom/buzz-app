import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { Task } from "./model";
import { type TasksState, type TasksView, watchTasks } from "./store";
import { openTasksChannel } from "./tasks-channel";

const loadingState: TasksState = { status: "loading", tasks: [] };
const loading: TasksView = {
  snapshot: () => loadingState,
  subscribe: () => () => {},
  dispose: () => {},
};

/** Every current task in `channel`, live while mounted. The watch starts in
 * an effect so each mount owns, and disposes, exactly the one it opened. */
export function useTasks(session: RelaySession, channel: string) {
  const [view, setView] = useState<TasksView>(loading);
  useEffect(() => {
    const next = watchTasks(session, channel);
    setView(next);
    return next.dispose;
  }, [session, channel]);
  return useSyncExternalStore(view.subscribe, view.snapshot, view.snapshot);
}

/** Tasks from the live view, with this device's saves shown until the
 * relay's copy has them: the same revision, or a strictly newer one. A tie
 * keeps the save, the newest this device knows of. */
export function useTasksWithSaved(session: RelaySession, channel: string) {
  const state = useTasks(session, channel);
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

export type TasksChannelState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; error: string; retry(): void }>
  | Readonly<{ status: "found"; channelId: string }>;

/** The community's tasks channel, made on its first use. */
export function useTasksChannel(session: RelaySession): TasksChannelState {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<
    { channelId: string } | { error: string } | undefined
  >();
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry is a new attempt.
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    openTasksChannel(session, controller.signal).then(
      (channelId) => !controller.signal.aborted && setResult({ channelId }),
      (reason: unknown) =>
        !controller.signal.aborted &&
        setResult({
          error:
            reason instanceof Error ? reason.message : "Couldn’t open Tasks.",
        }),
    );
    return () => controller.abort();
  }, [session, attempt]);
  if (!result) return { status: "loading" };
  if ("error" in result) return { status: "error", error: result.error, retry };
  return { status: "found", channelId: result.channelId };
}
