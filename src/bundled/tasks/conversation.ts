// A task's comments live in its own hidden conversation (NIP-AR): the relay
// makes it on the first comment, under the task's home, and who reads and
// posts there always comes from the home. The app holds it open by name with
// `channels.reach`, since it is never in the viewer's list.
import type {
  ChannelReach,
  ChannelReachState,
} from "../../features/relay/channel-reach";
import type { RelaySession } from "../../features/relay/session";
import type { Task } from "./model";

/** The first answer that is not `loading`. */
export function settled(
  handle: ChannelReach,
  signal: AbortSignal,
): Promise<ChannelReachState> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const state = handle.snapshot();
      if (state.status === "loading") return;
      stop();
      resolve(state);
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    const unsubscribe = handle.subscribe(check);
    const stop = () => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

/** Resolves once the relay accepts message `id`; rejects if it fails. */
function delivered(session: RelaySession, id: string, signal: AbortSignal) {
  const outbox = session.outbox;
  if (!outbox) return Promise.reject(new Error("Couldn’t post the comment."));
  return new Promise<void>((resolve, reject) => {
    let seen = false;
    const check = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      if (item) seen = true;
      const delivery = item?.delivery;
      if (delivery === "sending" || delivery === "unknown") return;
      if (!item && !seen) return;
      stop();
      if (delivery === "failed")
        reject(new Error("The comment didn’t post. Try again."));
      else resolve();
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    const unsubscribe = outbox.subscribe(check);
    const stop = () => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
}

/** Opens `task`'s conversation if nobody has, then posts `text` there and
 * waits for the relay to accept it. */
export async function postComment(
  session: RelaySession,
  task: Task,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const open = session.artifacts.openConversation;
  const reach = session.channels.reach;
  if (!open || !reach)
    throw new Error("Comments aren’t available in this community yet.");
  const id = await open(task.id, signal);
  const handle = reach(id);
  try {
    const state = await settled(handle, signal);
    if (state.status !== "open")
      throw new Error(
        state.status === "unavailable" && state.reason === "failed"
          ? "Couldn’t reach the community to comment. Try again."
          : "This task’s comments aren’t available to you.",
      );
    if (!state.post) throw new Error("You can only read this task’s comments.");
    await delivered(session, session.messages.send(id, text), signal);
  } finally {
    handle.release();
  }
}
