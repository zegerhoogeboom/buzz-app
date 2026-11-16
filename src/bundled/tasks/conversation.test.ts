import { expect, it, vi } from "vitest";
import type { ChannelReachState } from "../../features/relay/channel-reach";
import type { RelaySession } from "../../features/relay/session";
import { postComment } from "./conversation";
import type { Task } from "./model";

const conversation = "33333333-3333-8333-8333-333333333333";
const task = { id: "11111111-1111-4111-8111-111111111111" } as Task;

/** A session whose relay answers `state` and settles each send as `delivery`. */
function setup(state: ChannelReachState, delivery: "accepted" | "failed") {
  const listeners = new Set<() => void>();
  let items: { event: { id: string }; delivery: string }[] = [];
  const release = vi.fn();
  const send = vi.fn((_id: string, _text: string) => {
    items = [{ event: { id: "m1" }, delivery: "sending" }];
    queueMicrotask(() => {
      items = [{ event: { id: "m1" }, delivery }];
      for (const listener of listeners) listener();
    });
    return "m1";
  });
  const session = {
    artifacts: { openConversation: vi.fn(async () => conversation) },
    channels: {
      reach: () => ({
        snapshot: () => state,
        subscribe: () => () => {},
        retry() {},
        release,
      }),
    },
    messages: { send },
    outbox: {
      snapshot: () => items,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  return { session, send, release };
}
const signal = () => new AbortController().signal;

it("opens the task's conversation and waits for the relay to accept the comment", async () => {
  const t = setup({ status: "open", post: true, joined: false }, "accepted");
  await postComment(t.session, task, "Shipped.", signal());
  expect(t.session.artifacts.openConversation).toHaveBeenCalledWith(
    task.id,
    expect.anything(),
  );
  expect(t.send).toHaveBeenCalledWith(conversation, "Shipped.");
  expect(t.release).toHaveBeenCalled();
});

it("never sends where the relay says the person can only read", async () => {
  const t = setup({ status: "open", post: false, joined: false }, "accepted");
  await expect(postComment(t.session, task, "Hi", signal())).rejects.toThrow(
    "only read",
  );
  expect(t.send).not.toHaveBeenCalled();
  expect(t.release).toHaveBeenCalled();
});

it("tells apart couldn't-check from no access", async () => {
  for (const [reason, message] of [
    ["failed", "Try again"],
    ["unavailable", "aren’t available to you"],
  ] as const) {
    const t = setup({ status: "unavailable", reason }, "accepted");
    await expect(postComment(t.session, task, "Hi", signal())).rejects.toThrow(
      message,
    );
    expect(t.send).not.toHaveBeenCalled();
  }
});

it("reports a comment the relay refused", async () => {
  const t = setup({ status: "open", post: true, joined: false }, "failed");
  await expect(postComment(t.session, task, "Hi", signal())).rejects.toThrow(
    "didn’t post",
  );
  expect(t.release).toHaveBeenCalled();
});
