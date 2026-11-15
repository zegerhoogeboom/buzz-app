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
   * cannot share it. Never rejects. Aborting `signal` withdraws the request
   * until the viewer chooses Share; from then on only the viewer ends it.
   * `reason` is one sentence the dialog shows as the caller's own words.
   */
  requestShare(
    session: RelaySession,
    channelId: string,
    options?: ShareRequestOptions,
  ): Promise<ChatShareOutcome>;
}>;

export type ShareRequestOptions = Readonly<{
  signal?: AbortSignal | undefined;
  reason?: string | undefined;
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
  /** The asking plugin's name, as the app knows it. */
  requester: string;
  /** The caller's own one-sentence reason, if it gave one. */
  reason?: string | undefined;
}>;

/** Who asks and why, as the dialog shows them. */
type Asker = Readonly<{ requester: string; reason?: string | undefined }>;

const MAX_REASON = 200;
const reasonOf = (reason: string | undefined) =>
  reason?.replace(/\s+/g, " ").trim().slice(0, MAX_REASON) || undefined;

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
  // Requests the viewer chose Share on: their caller can no longer withdraw
  // them, since the chat may already be View only.
  const confirming = new Set<string>();
  const settle = (id: string, outcome: ChatShareOutcome) => {
    const item = pending.find((entry) => entry.id === id);
    if (!item) return;
    pending = pending.filter((entry) => entry !== item);
    confirming.delete(id);
    item.controller.abort();
    item.resolve(outcome);
    notify();
  };

  async function request(
    session: RelaySession,
    channelId: string,
    asker: Asker,
    lifetime?: (end: () => void) => () => void,
    signal?: AbortSignal,
  ): Promise<ChatShareOutcome> {
    if (signal?.aborted) return "cancelled";
    const same = pending.find(
      (entry) =>
        entry.session === session && entry.details.channelId === channelId,
    );
    if (same) return same.done;
    const controller = new AbortController();
    const stop = lifetime?.(() => controller.abort());
    const withdraw = () => controller.abort();
    signal?.addEventListener("abort", withdraw, { once: true });
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
        {
          id,
          session,
          details,
          requester: asker.requester,
          reason: reasonOf(asker.reason),
          done,
          resolve,
          controller,
        },
      ];
      controller.signal.addEventListener(
        "abort",
        () => {
          if (!confirming.has(id)) settle(id, "cancelled");
        },
        { once: true },
      );
      notify();
      return await done;
    } finally {
      stop?.();
      signal?.removeEventListener("abort", withdraw);
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
    /** The viewer chose Share: from now on only `settle` ends the request. */
    confirm(id: string) {
      if (pending.some((entry) => entry.id === id)) confirming.add(id);
    },
  };
}

/** Provide `chatSharing`, tying each request to its caller's lifetime. */
export function createChatSharingService(
  ctx: Context,
  requests: ShareRequests,
  /** A plugin's display name from its id. */
  pluginName: (id: string) => string,
): ChatSharing {
  class ChatSharingService extends Service implements ChatSharing {
    constructor() {
      super(ctx, "chatSharing");
    }

    // A method, so Cordis supplies the caller's context for its lifetime.
    requestShare(
      session: RelaySession,
      channelId: string,
      options?: ShareRequestOptions,
    ) {
      const caller = this.ctx;
      const owner = caller.pluginOwner?.id;
      return requests.request(
        session,
        channelId,
        {
          requester: owner ? pluginName(owner) : "The app",
          reason: options?.reason,
        },
        (end) => {
          const stop = caller.effect(() => end);
          return () => void stop();
        },
        options?.signal,
      );
    }
  }
  return new ChatSharingService();
}
