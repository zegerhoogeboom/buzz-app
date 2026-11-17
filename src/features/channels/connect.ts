// Buzz Connect: a channel shared between two communities. The relays mirror
// the channel's messages; the app only reads the relay-signed `connected`
// metadata tag, sends the three admin commands, and marks remote authors.
import type { RelayEvent } from "../relay/events";
import type { ChannelSummary } from "../relay/contracts";
import type { RelayWriter } from "../relay/transport";

/** Relay commands, answered in the OK message and never stored. */
export const CHANNEL_CONNECT_OFFER = 9037;
export const CHANNEL_CONNECT_ACCEPT = 9038;
export const CHANNEL_CONNECT_DISCONNECT = 9039;
export const CHANNEL_CONNECT_KINDS = [
  CHANNEL_CONNECT_OFFER,
  CHANNEL_CONNECT_ACCEPT,
  CHANNEL_CONNECT_DISCONNECT,
] as const;

export type ChannelConnection = Readonly<{
  /** The other community's relay URL. */
  relay: string;
  /** The other community's display name (its host for now). */
  community: string;
}>;

export type ChannelConnectLink = Readonly<{
  /** The offering community's relay, `ws:` or `wss:`. */
  relay: string;
  /** Its host, shown as the community's name. */
  community: string;
  channel: string;
  /** The whole link, as the accepting relay redeems it. */
  link: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The first `["connected", <relay url>, <name>]` on relay-signed kind:39000.
 * A channel has at most one connection in this version. */
export function channelConnection(
  event: RelayEvent,
): ChannelConnection | undefined {
  for (const [name, relay, community] of event.tags) {
    if (name !== "connected" || typeof relay !== "string") continue;
    const host = relayHost(relay);
    if (!host) continue;
    const label =
      typeof community === "string" && community.trim()
        ? community.trim().slice(0, 120)
        : host;
    return Object.freeze({ relay, community: label });
  }
  return undefined;
}

/** `buzz://channel-connect?relay=<ws url>&channel=<uuid>&code=<hex>`. The link
 * grants nothing by itself: the viewer's own relay redeems it, as an admin. */
export function parseChannelConnectLink(
  input: string,
): ChannelConnectLink | null {
  const value = input.trim();
  if (value.length > 4096 || !/^buzz:\/\/channel-connect\/?\?/.test(value))
    return null;
  try {
    const url = new URL(value);
    if (
      url.host !== "channel-connect" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    const one = (key: string) => {
      const values = url.searchParams.getAll(key);
      return values.length === 1 ? values[0] : undefined;
    };
    const relay = one("relay");
    const channel = one("channel");
    const code = one("code");
    const community = relay && relayHost(relay);
    if (
      !relay ||
      !community ||
      !channel ||
      !UUID.test(channel) ||
      !code ||
      code.length > 256 ||
      !/^[0-9a-f]+$/i.test(code)
    )
      return null;
    return Object.freeze({ relay, community, channel, link: value });
  } catch {
    return null;
  }
}

/** A connect command as this app writes it, for hosts that sign or publish
 * on its behalf: one `channel` or `link` tag, nothing else. */
export function validChannelConnectCommand(
  event: Readonly<{ kind?: unknown; content?: unknown; tags?: unknown }>,
) {
  if (event.content !== "" || !Array.isArray(event.tags)) return false;
  const [only, ...rest] = event.tags as unknown[];
  if (rest.length || !Array.isArray(only) || only.length !== 2) return false;
  const [name, value] = only as unknown[];
  if (typeof value !== "string") return false;
  return event.kind === CHANNEL_CONNECT_ACCEPT
    ? name === "link" && parseChannelConnectLink(value)?.link === value
    : (event.kind === CHANNEL_CONNECT_OFFER ||
        event.kind === CHANNEL_CONNECT_DISCONNECT) &&
        name === "channel" &&
        UUID.test(value);
}

/** The three admin commands. The relay checks the signer is a community
 * admin and answers in the OK message; nothing is queued or retried, so a
 * failure is shown and the admin tries again. Undefined when this
 * connection cannot sign them. */
export function createChannelConnect(
  writer: Pick<RelayWriter, "kinds" | "sign" | "publish"> | undefined,
) {
  if (
    !writer ||
    !CHANNEL_CONNECT_KINDS.every((kind) => writer.kinds?.includes(kind))
  )
    return undefined;
  const run = async (kind: number, tags: string[][], signal: AbortSignal) => {
    const event = await writer.sign(
      {
        kind,
        content: "",
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      signal,
    );
    return (await writer.publish(event, signal)) ?? "";
  };
  const channel = (id: string) => {
    if (!UUID.test(id)) throw new Error("Invalid channel");
    return [["channel", id]];
  };
  return Object.freeze({
    /** A one-time link for another community's admin, valid for 24 hours. */
    async offer(channelId: string, signal: AbortSignal) {
      const reply = await run(
        CHANNEL_CONNECT_OFFER,
        channel(channelId),
        signal,
      );
      const link = parseChannelConnectLink(reply);
      if (link?.channel !== channelId)
        throw new Error("The relay returned no valid connection link.");
      return link.link;
    },
    /** Creates the shared channel here; resolves to its id. */
    async accept(link: ChannelConnectLink, signal: AbortSignal) {
      const reply = await run(
        CHANNEL_CONNECT_ACCEPT,
        [["link", link.link]],
        signal,
      );
      return UUID.test(reply.trim()) ? reply.trim() : link.channel;
    },
    /** Ends sharing on both sides; each keeps the history so far. */
    async disconnect(channelId: string, signal: AbortSignal) {
      await run(CHANNEL_CONNECT_DISCONNECT, channel(channelId), signal);
    },
  });
}
export type ChannelConnect = NonNullable<
  ReturnType<typeof createChannelConnect>
>;

/** The other community's name when `author` is someone from there: in a
 * shared channel, a person who is not in this side's roster. Display only;
 * someone who left the channel reads as remote too. */
export function remoteCommunity(
  channel: ChannelSummary | undefined,
  author: string,
): string | undefined {
  return channel?.connected &&
    channel.members &&
    !channel.members.includes(author)
    ? channel.connected.community
    : undefined;
}

/** People from the other community seen in the shared channel's loaded
 * messages: who an @mention there can name without inviting them. */
export function remoteAuthors(
  channel: ChannelSummary | undefined,
  rows: readonly { readonly authorId: string }[] | undefined,
): readonly string[] {
  if (!channel?.connected || !channel.members || !rows) return [];
  const members = new Set(channel.members);
  return [
    ...new Set(
      rows.flatMap((row) =>
        members.has(row.authorId) || !/^[0-9a-f]{64}$/.test(row.authorId)
          ? []
          : [row.authorId],
      ),
    ),
  ];
}

function relayHost(relay: string): string | undefined {
  try {
    const url = new URL(relay);
    return (url.protocol === "wss:" || url.protocol === "ws:") &&
      url.host &&
      !url.username &&
      !url.password
      ? url.host
      : undefined;
  } catch {
    return undefined;
  }
}

export type ChannelConnectRequest = Readonly<{
  link: ChannelConnectLink;
  viewer: string;
}>;

/** The `buzz://channel-connect` link awaiting the viewer's confirmation. The
 * newest link replaces an unconfirmed one, as with other deep links. */
export function createChannelConnectRequests() {
  let pending: ChannelConnectRequest | undefined;
  const listeners = new Set<() => void>();
  const update = (next: ChannelConnectRequest | undefined) => {
    pending = next;
    for (const listener of listeners) listener();
  };
  return Object.freeze({
    open: (link: ChannelConnectLink, viewer: string) =>
      update(Object.freeze({ link, viewer })),
    close: () => update(undefined),
    snapshot: () => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  });
}
export type ChannelConnectRequests = ReturnType<
  typeof createChannelConnectRequests
>;
