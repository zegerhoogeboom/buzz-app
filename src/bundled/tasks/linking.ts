// Linking records a conversation's id on a task; it never adds anyone to the
// conversation. Only a private Solo chat needs the owner's consent first: its
// owner makes it View only through the app's "Share this chat?" confirmation.
import type { RelaySession } from "../../features/relay/session";
import type {
  ChatShareOutcome,
  ChatSharing,
} from "../../features/solo/share-requests";

/** Whether `channelId` may be linked now, asking to share it when needed. */
export async function readyToLink(
  session: RelaySession,
  sharing: ChatSharing | undefined,
  channelId: string,
): Promise<ChatShareOutcome> {
  const channel = session.channels
    .list()
    .channels.find((item) => item.id === channelId);
  // Unknown visibility is not public: ask, and let the app's check decide.
  if (channel?.channelType !== "solo" || channel.visibility === "public")
    return "shared";
  return sharing ? sharing.requestShare(session, channelId) : "unavailable";
}
