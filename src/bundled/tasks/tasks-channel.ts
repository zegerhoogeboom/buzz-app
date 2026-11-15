// The community's tasks live in one open NIP-CL system channel: hidden from
// channel lists, readable and writable by everyone in the community. Its
// creator owns it, so only a channel a community owner or admin created
// counts; the oldest such channel is the community's (NIP-CL "Choosing one
// channel"), so concurrent setups converge.
import {
  MEMBERSHIP_KIND,
  membersFromSnapshot,
} from "../../features/communities/roster";
import { compareChannelAge } from "../../features/relay/channel-labels";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";

export const TASKS_LABEL = "buzz.tasks";
const TASKS_CHANNEL_NAME = "Tasks";
/** Communities have few admins; more than this is not looked through. */
const MAX_ADMINS = 32;

export type TasksChannel =
  | Readonly<{ status: "found"; channelId: string }>
  /** No admin has set Tasks up; `canSetUp` when the viewer may. */
  | Readonly<{ status: "missing"; canSetUp: boolean }>;

/** The community's owners and admins, from the relay-signed roster. */
async function readAdmins(session: RelaySession, signal: AbortSignal) {
  const author = session.relayAuthor;
  if (!author) throw new Error("This community can’t confirm its admins.");
  const events = await session.read(
    [{ kinds: [MEMBERSHIP_KIND], authors: [author], limit: 1 }],
    { fresh: true, signal },
  );
  const latest = [...events].sort(
    (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
  )[0];
  return (latest ? membersFromSnapshot(latest, author) : [])
    .filter((member) => member.role === "owner" || member.role === "admin")
    .map((member) => member.pubkey)
    .slice(0, MAX_ADMINS);
}

const isTasksChannel = (channel: ChannelSummary, admins: Set<string>) =>
  channel.channelType === "system" &&
  !channel.private &&
  !channel.archived &&
  !!channel.creator &&
  admins.has(channel.creator) &&
  !!channel.labels?.includes(TASKS_LABEL);

/** Finds the community's tasks channel. Throws when it can't tell. */
export async function findTasksChannel(
  session: RelaySession,
  signal: AbortSignal,
): Promise<TasksChannel> {
  const findLabeled = session.channels.findLabeled;
  if (!findLabeled)
    throw new Error("Tasks aren’t available in this community.");
  const admins = await readAdmins(session, signal);
  const trusted = new Set(admins);
  const found = (
    await Promise.all(
      admins.map((creator) =>
        findLabeled(
          { creator, label: TASKS_LABEL },
          { consistency: "strong", signal },
        ),
      ),
    )
  )
    .flat()
    .filter((channel) => isTasksChannel(channel, trusted))
    .sort(compareChannelAge)[0];
  if (found) return { status: "found", channelId: found.id };
  return {
    status: "missing",
    canSetUp: !!session.viewer && trusted.has(session.viewer),
  };
}

/** An admin sets Tasks up once for the whole community. */
export async function setUpTasksChannel(
  session: RelaySession,
  signal: AbortSignal,
): Promise<TasksChannel> {
  const existing = await findTasksChannel(session, signal);
  if (existing.status === "found" || !existing.canSetUp) return existing;
  await session.channelCreation.create({
    name: TASKS_CHANNEL_NAME,
    visibility: "open",
    labels: [TASKS_LABEL],
    system: true,
  });
  const created = await findTasksChannel(session, signal);
  if (created.status !== "found")
    throw new Error("The tasks channel isn’t readable yet. Try again.");
  return created;
}
