// Reading and saving tasks. Each task lives in its home; reads ask the relay
// for every task the viewer can read, wherever it lives, and the relay alone
// decides that. Saves are compare-and-set on the revision the editor opened,
// so a concurrent edit is reported, never overwritten.
import {
  ARTIFACT_KIND,
  deliver,
} from "../../features/agents/agent-config-artifacts";
import type { RelayEvent } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import {
  checkedFields,
  TASK_TYPE,
  type Task,
  type TaskFields,
  taskContent,
  taskOf,
} from "./model";

export type TasksState = Readonly<{
  status: "loading" | "live" | "error";
  tasks: readonly Task[];
  error?: string | undefined;
}>;

export type TasksView = Readonly<{
  snapshot(): TasksState;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}>;

/** The session reader's cap on one finite read. */
const READ_LIMIT = 500;

const taskFilter = { kinds: [ARTIFACT_KIND], "#type": [TASK_TYPE] };

const toTasks = (events: readonly RelayEvent[]) =>
  events.flatMap((event) => taskOf(event) ?? []);

/** Every current task the viewer can read, kept current while subscribed. */
export function watchTasks(session: RelaySession): TasksView {
  const listeners = new Set<() => void>();
  let state: TasksState = { status: "loading", tasks: [] };
  const set = (next: TasksState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const sync = session.artifacts.sync({
    artifact: "current" as const,
    ...taskFilter,
  });
  let fallback: AbortController | undefined;
  // A relay without sync gets one finite read; saves on this device still
  // show through `saved`.
  const readOnce = () => {
    if (fallback) return;
    if (!session.snapshotRead) {
      set({
        status: "error",
        tasks: [],
        error: "Tasks aren’t available in this community.",
      });
      return;
    }
    const controller = new AbortController();
    fallback = controller;
    readTasks(session, controller.signal)
      .then((tasks) => {
        if (!controller.signal.aborted) set({ status: "live", tasks });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          set({
            status: "error",
            tasks: state.tasks,
            error:
              reason instanceof Error ? reason.message : "Couldn’t load tasks.",
          });
      });
  };
  const apply = () => {
    const current = sync.snapshot();
    switch (current.status) {
      case "unsupported":
        readOnce();
        return;
      case "live":
      case "stale":
        set({ status: "live", tasks: toTasks(current.events) });
        return;
      case "restricted":
      case "error":
        set({
          status: "error",
          tasks: toTasks(current.events),
          error: current.error ?? "Couldn’t load tasks.",
        });
        return;
      case "loading":
        return;
    }
  };
  const stop = sync.subscribe(apply);
  apply();
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispose() {
      stop();
      sync.dispose();
      fallback?.abort();
      listeners.clear();
    },
  };
}

/** One finite read of every current task the viewer can read. */
export async function readTasks(
  session: RelaySession,
  signal: AbortSignal,
): Promise<readonly Task[]> {
  const read = session.snapshotRead;
  if (!read) throw new Error("Tasks aren’t available in this community.");
  return toTasks(
    await read([{ artifact: "current", ...taskFilter, limit: READ_LIMIT }], {
      signal,
    }),
  );
}

/** Task `id`'s current revision, or undefined when the viewer can't read it
 * or it was deleted. `home`, when known, names its home, so a task readable
 * only by naming its home is found too. */
export async function readTask(
  session: RelaySession,
  id: string,
  signal: AbortSignal,
  home?: string,
): Promise<Task | undefined> {
  const read = session.snapshotRead;
  if (!read) throw new Error("Tasks aren’t available in this community.");
  const events = await read(
    [
      {
        artifact: "current",
        ...taskFilter,
        "#d": [id],
        ...(home ? { "#h": [home] } : {}),
        limit: 2,
      },
    ],
    { signal },
  );
  const tasks = toTasks(events).filter((task) => task.id === id);
  // A moved task named by its old home reads as missing; ask without it.
  if (!tasks.length && home) return readTask(session, id, signal);
  return tasks.length === 1 ? tasks[0] : undefined;
}

export type SaveResult =
  | Readonly<{ status: "saved"; task: Task }>
  /** Someone else saved first; `current` is their version, the next base. */
  | Readonly<{ status: "conflict"; current: Task }>;

/** What a save does: create task `id` in `home`, update `base` where it
 * lives, or move `base` to `home` with `fields` as its snapshot. */
export type SaveTarget =
  | Readonly<{ op: "create"; home: string; id: string }>
  | Readonly<{ op: "update"; base: Task }>
  | Readonly<{ op: "move"; base: Task; home: string }>;

/** Saves one revision. A new task's caller keeps one `id` across retries, so
 * a create that landed unseen is found, not made twice. */
export async function saveTask(
  session: RelaySession,
  fields: TaskFields,
  target: SaveTarget,
  signal: AbortSignal = AbortSignal.timeout(20_000),
): Promise<SaveResult> {
  const writer = session.configArtifactWriter;
  const viewer = session.viewer;
  if (!session.snapshotRead || !writer || !viewer)
    throw new Error("This community connection can’t save tasks.");
  const checked = checkedFields(fields);
  const base = target.op === "create" ? undefined : target.base;
  const id = base?.id ?? (target.op === "create" ? target.id : "");
  const home = target.op === "update" ? target.base.home : target.home;
  const event = await writer.sign(
    {
      kind: ARTIFACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: taskContent(checked, base?.author ?? viewer),
      tags: [
        ["ar", "1"],
        ["d", id],
        ["h", home],
        ["type", TASK_TYPE],
        ["title", checked.title],
        ["op", target.op],
        ...(base ? [["prev", base.revision]] : []),
      ],
    },
    signal,
  );
  const delivery = await deliver(writer, event, signal);
  if (delivery.status === "accepted") {
    const task = taskOf(event);
    if (!task) throw new Error("Couldn’t read the saved task.");
    return { status: "saved", task };
  }
  if (
    (delivery.status === "refused" && delivery.refusal === "conflict") ||
    delivery.status === "uncertain"
  ) {
    // The head shows whether this revision landed, or whose did instead.
    const current = await readTask(session, id, signal, home).catch(
      () => undefined,
    );
    if (current?.revision === event.id)
      return { status: "saved", task: current };
    if (delivery.status === "refused" && current)
      return { status: "conflict", current };
    if (delivery.status === "refused")
      throw new Error("Someone else changed this task. Try again.");
  }
  throw new Error(
    delivery.status === "refused" && delivery.refusal === "permission"
      ? target.op === "move"
        ? "You can only move a task between places you can post in."
        : "You can only view tasks here."
      : delivery.status === "refused" && delivery.refusal === "too-large"
        ? "This task is too large to save. Shorten the description."
        : "Couldn’t save the task. Try again.",
  );
}
