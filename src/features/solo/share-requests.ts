import { Service, type Context } from "@deepseek-ai/cordis";
import type { ChannelDetails } from "../relay/channel-details-protocol";
import type { RelaySession } from "../relay/session";
import { shareSoloChatAccess } from "./share";

export type ChatShareOutcome = "shared" | "cancelled" | "unavailable";

/** The handle plugins read with `ctx.reflect.get("chatSharing")`. */
export type ChatSharing = Readonly<{
  /**
   * Ask the viewer to make one of their own Solo chats View only. The app
   * shows its "Share this chat?" confirmation; nothing changes unless the
   * viewer confirms. Resolves `"shared"` once the chat is View only or public
   * (at once, without a dialog, when it already is), `"cancelled"` when the
   * viewer declines or the caller stops, and `"unavailable"` when the viewer
   * cannot share it. Never rejects.
   */
  requestShare(
    session: RelaySession,
    channelId: string,
  ): Promise<ChatShareOutcome>;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Read with `ctx.reflect.get("chatSharing")` for old-host compatibility. */
    chatSharing?: ChatSharing;
  }
}

/** A confirmation waiting for the viewer, with the access it was asked about. */
export type ShareRequest = Readonly<{
  id: string;
  session: RelaySession;
  details: ChannelDetails;
}>;

type Pending = ShareRequest & {
  readonly done: Promise<ChatShareOutcome>;
  readonly resolve: (outcome: ChatShareOutcome) => void;
  readonly controller: AbortController;
};

// Each request holds a dialog open for the viewer, so callers cannot queue
// without bound.
const PENDING_MAX = 16;

export type ShareRequests = ReturnType<typeof createShareRequests>;

/** The app-owned queue behind `chatSharing`: one confirmation at a time. */
export function createShareRequests() {
  let pending: readonly Pending[] = [];
  let next = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const settle = (id: string, outcome: ChatShareOutcome) => {
    const item = pending.find((entry) => entry.id === id);
    if (!item) return;
    pending = pending.filter((entry) => entry !== item);
    item.controller.abort();
    item.resolve(outcome);
    notify();
  };

  async function request(
    session: RelaySession,
    channelId: string,
    lifetime?: (end: () => void) => () => void,
  ): Promise<ChatShareOutcome> {
    const same = pending.find(
      (entry) =>
        entry.session === session && entry.details.channelId === channelId,
    );
    if (same) return same.done;
    const controller = new AbortController();
    const stop = lifetime?.(() => controller.abort());
    try {
      // The same check both share dialogs make: only the viewer's own Solo
      // chat, with its current signed access.
      let details: ChannelDetails | undefined;
      try {
        details = await shareSoloChatAccess(session, channelId, {
          signal: controller.signal,
          attempts: new Map(),
        });
      } catch {
        return controller.signal.aborted ? "cancelled" : "unavailable";
      }
      if (!details || details.visibility === "public") return "shared";
      if (pending.length >= PENDING_MAX) return "unavailable";
      const raced = pending.find(
        (entry) =>
          entry.session === session && entry.details.channelId === channelId,
      );
      if (raced) return await raced.done;
      let resolve!: (outcome: ChatShareOutcome) => void;
      const done = new Promise<ChatShareOutcome>((settled) => {
        resolve = settled;
      });
      const id = `share-${++next}`;
      pending = [
        ...pending,
        { id, session, details, done, resolve, controller },
      ];
      controller.signal.addEventListener(
        "abort",
        () => settle(id, "cancelled"),
        { once: true },
      );
      notify();
      return await done;
    } finally {
      stop?.();
    }
  }

  return {
    request,
    /** The confirmations waiting for the viewer, oldest first. */
    snapshot: (): readonly ShareRequest[] => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    settle,
  };
}

/** Provide `chatSharing`, tying each request to its caller's lifetime. */
export function createChatSharingService(
  ctx: Context,
  requests: ShareRequests,
): ChatSharing {
  class ChatSharingService extends Service implements ChatSharing {
    constructor() {
      super(ctx, "chatSharing");
    }

    // A method, so Cordis supplies the caller's context for its lifetime.
    requestShare(session: RelaySession, channelId: string) {
      const caller = this.ctx;
      return requests.request(session, channelId, (end) => {
        const stop = caller.effect(() => end);
        return () => void stop();
      });
    }
  }
  return new ChatSharingService();
}
