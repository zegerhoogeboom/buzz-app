// Reading and saving tasks in one tasks channel. Reads follow the relay's
// NIP-AR sync where it has one; saves are compare-and-set on the head the
// editor opened, so a concurrent edit is reported, never overwritten.
import {
  ARTIFACT_KIND,
  deliver,
  readHead,
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

const toTasks = (events: readonly RelayEvent[]) =>
  events.flatMap((event) => taskOf(event) ?? []);

/** Every current task in `channel`, kept current while subscribed. */
export function watchTasks(session: RelaySession, channel: string): TasksView {
  const listeners = new Set<() => void>();
  let state: TasksState = { status: "loading", tasks: [] };
  const set = (next: TasksState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const filter = {
    artifact: "current" as const,
    kinds: [ARTIFACT_KIND],
    "#h": [channel],
    "#type": [TASK_TYPE],
  };
  const sync = session.artifacts.sync(filter);
  let fallback: AbortController | undefined;
  // A relay without sync gets one finite read; saves on this device still
  // show through `saved`.
  const readOnce = () => {
    if (fallback || !session.snapshotRead) {
      if (!session.snapshotRead)
        set({
          status: "error",
          tasks: [],
          error: "Tasks aren’t available in this community.",
        });
      return;
    }
    const controller = new AbortController();
    fallback = controller;
    session
      .snapshotRead([{ ...filter, limit: READ_LIMIT }], {
        signal: controller.signal,
      })
      .then((events) => {
        if (!controller.signal.aborted)
          set({ status: "live", tasks: toTasks(events) });
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

export type SaveResult =
  | Readonly<{ status: "saved"; task: Task }>
  /** Someone else saved first; `current` is their version when readable. */
  | Readonly<{ status: "conflict"; current?: Task | undefined }>;

/** Creates a task (no `base`) or saves `fields` over the `base` revision. */
export async function saveTask(
  session: RelaySession,
  channel: string,
  fields: TaskFields,
  base: Task | undefined,
  signal: AbortSignal = AbortSignal.timeout(20_000),
): Promise<SaveResult> {
  const read = session.snapshotRead;
  const writer = session.configArtifactWriter;
  const viewer = session.viewer;
  if (!read || !writer || !viewer)
    throw new Error("This community connection can’t save tasks.");
  const checked = checkedFields(fields);
  const event = await writer.sign(
    {
      kind: ARTIFACT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: taskContent(checked, base?.author ?? viewer),
      tags: [
        ["ar", "1"],
        ["d", base?.id ?? crypto.randomUUID()],
        ["h", channel],
        ["type", TASK_TYPE],
        ["title", checked.title],
        ["op", base ? "update" : "create"],
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
  if (delivery.status === "refused" && delivery.refusal === "conflict") {
    const head = base
      ? await readHead(read, channel, base.id, signal).catch(() => undefined)
      : undefined;
    return { status: "conflict", current: head && taskOf(head) };
  }
  if (delivery.status === "uncertain" && base) {
    // The relay accepts a replay of an accepted revision, so the head shows
    // whether this one landed.
    const head = await readHead(read, channel, base.id, signal).catch(
      () => undefined,
    );
    const task = head?.id === event.id ? taskOf(head) : undefined;
    if (task) return { status: "saved", task };
  }
  throw new Error(
    delivery.status === "refused" && delivery.refusal === "permission"
      ? "You can’t edit tasks in this community."
      : delivery.status === "refused" && delivery.refusal === "too-large"
        ? "This task is too large to save. Shorten the description."
        : "Couldn’t save the task. Try again.",
  );
}
