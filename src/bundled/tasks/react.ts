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
import {
  findTasksChannel,
  setUpTasksChannel,
  type TasksChannel,
} from "./tasks-channel";

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
  | Readonly<{ status: "found"; channelId: string }>
  | Readonly<{
      status: "missing";
      canSetUp: boolean;
      settingUp: boolean;
      setUp(): void;
    }>;

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : "Couldn’t open Tasks.";

/** The community's tasks channel, and the admin's one-time setup. */
export function useTasksChannel(session: RelaySession): TasksChannelState {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<
    TasksChannel | { status: "error"; error: string } | undefined
  >();
  const [settingUp, setSettingUp] = useState(false);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry is a new attempt.
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    findTasksChannel(session, controller.signal).then(
      (found) => !controller.signal.aborted && setResult(found),
      (reason: unknown) =>
        !controller.signal.aborted &&
        setResult({ status: "error", error: message(reason) }),
    );
    return () => controller.abort();
  }, [session, attempt]);
  const setUp = useCallback(() => {
    setSettingUp(true);
    setUpTasksChannel(session, AbortSignal.timeout(30_000))
      .then(setResult, (reason: unknown) =>
        setResult({ status: "error", error: message(reason) }),
      )
      .finally(() => setSettingUp(false));
  }, [session]);
  if (!result) return { status: "loading" };
  if (result.status === "error") return { ...result, retry };
  if (result.status === "found") return result;
  return { ...result, settingUp, setUp };
}
