// Linking records a conversation's id on a task; it never adds anyone to the
// conversation. Only a private Solo chat needs the owner's consent first: its
// owner makes it View only through the app's "Share this chat?" confirmation.
import type { RelaySession } from "../../features/relay/session";
import type {
  ChatShareOutcome,
  ChatSharing,
} from "../../features/solo/share-requests";

/** Whether `channelId` may be linked to the task titled `task`, asking to
 * share it when needed. `agent` names the agent asking, if one is. */
export async function readyToLink(
  session: RelaySession,
  sharing: ChatSharing | undefined,
  channelId: string,
  options: Readonly<{
    task: string;
    agent?: string | undefined;
    signal?: AbortSignal | undefined;
  }>,
): Promise<ChatShareOutcome> {
  const channel = session.channels
    .list()
    .channels.find((item) => item.id === channelId);
  // Unknown visibility is not public: ask, and let the app's check decide.
  if (channel?.channelType !== "solo" || channel.visibility === "public")
    return "shared";
  return sharing
    ? sharing.requestShare(session, channelId, {
        signal: options.signal,
        reason: options.agent
          ? `Your agent ${options.agent} wants to link it to the task “${options.task}”.`
          : `To link it to the task “${options.task}”.`,
      })
    : "unavailable";
}
