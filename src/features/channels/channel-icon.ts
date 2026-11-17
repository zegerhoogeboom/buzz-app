import type { ChannelSummary } from "../relay/contracts";
import {
  ArrowsLeftRightIcon,
  ChatCircleIcon,
  HashIcon,
  LockIcon,
} from "../../shared/design-system/icons/index";

/** What names a channel and chooses how it is shown. */
export type ChannelLabel = Pick<
  ChannelSummary,
  "name" | "private" | "channelType" | "connected"
>;

/** Ordinary channel visibility chooses its icon, as the sidebar shows it;
 * callers retain non-channel type icons. */
export function channelIcon(
  channel:
    | {
        readonly private?: true | undefined;
        readonly channelType?: string | undefined;
        readonly connected?: ChannelSummary["connected"];
      }
    | undefined,
) {
  if (channel?.channelType === "solo" || channel?.channelType === "dm")
    return ChatCircleIcon;
  // Shared with another community (Buzz Connect), public or private.
  if (channel?.connected) return ArrowsLeftRightIcon;
  return channel?.private ? LockIcon : HashIcon;
}

/** What `channelIcon` shows, in words, for readers who can't see it. */
export function channelIconLabel(channel: Parameters<typeof channelIcon>[0]) {
  if (channel?.channelType === "solo") return "Chat";
  if (channel?.channelType === "dm") return "Direct message";
  if (channel?.connected)
    return `Channel shared with ${channel.connected.community}`;
  return channel?.private ? "Private channel" : "Public channel";
}

/** The channel's name as plain text, `#`-prefixed only where its icon is a hash. */
export function channelText(channel: ChannelLabel) {
  return channelIcon(channel) === HashIcon ? `#${channel.name}` : channel.name;
}
