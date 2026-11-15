// The community's tasks live in one open NIP-CL system channel: hidden from
// channel lists, readable and writable by everyone in the community. The
// first person to use Tasks creates it, and its creator owns it. Concurrent
// first uses can each create one; everyone uses the oldest (NIP-CL "Choosing
// one channel"), so they converge before any task is saved.
import {
  channelIdentity,
  compareChannelAge,
} from "../../features/relay/channel-labels";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";

export const TASKS_LABEL = "buzz.tasks";
const TASKS_CHANNEL_NAME = "Tasks";
/** One page of open system channels; a community has few. */
const SYSTEM_CHANNELS_READ = 500;
/** Different creators only happen when first uses race. */
const MAX_CREATORS = 8;

const isTasksChannel = (channel: ChannelSummary) =>
  channel.channelType === "system" &&
  !channel.private &&
  !channel.archived &&
  !!channel.labels?.includes(TASKS_LABEL);

// Once found, a community's tasks channel stays put for that connection, so
// each panel and tool call doesn't look it up again.
const found = new WeakMap<RelaySession, string>();

/** The community's tasks channel, or undefined when nobody has made one.
 * Throws when it can't tell. */
export async function findTasksChannel(
  session: RelaySession,
  signal: AbortSignal,
): Promise<string | undefined> {
  const known = found.get(session);
  if (known) return known;
  const findLabeled = session.channels.findLabeled;
  const read = session.snapshotRead;
  const author = session.relayAuthor;
  if (!findLabeled || !read || !author)
    throw new Error("Tasks aren’t available in this community.");
  // A label alone never returns system channels, and its creator isn't
  // known yet: ask for system channels, then keep the labeled ones' creators.
  const events = await read(
    [
      {
        kinds: [39000],
        authors: [author],
        "#t": ["system"],
        limit: SYSTEM_CHANNELS_READ,
        consistency: "strong",
      },
    ],
    { signal },
  );
  const creators = [
    ...new Set(
      events.flatMap((event) => {
        const identity = channelIdentity(event);
        return event.pubkey === author &&
          identity.type === "system" &&
          identity.labels.includes(TASKS_LABEL) &&
          identity.creator
          ? [identity.creator]
          : [];
      }),
    ),
  ].slice(0, MAX_CREATORS);
  // findLabeled verifies each channel's relay-signed creator and labels.
  const oldest = (
    await Promise.all(
      creators.map((creator) =>
        findLabeled(
          { creator, label: TASKS_LABEL },
          { consistency: "strong", signal },
        ),
      ),
    )
  )
    .flat()
    .filter(isTasksChannel)
    .sort(compareChannelAge)[0];
  if (oldest) found.set(session, oldest.id);
  return oldest?.id;
}

/** The tasks channel, created when this is the community's first use. */
export async function openTasksChannel(
  session: RelaySession,
  signal: AbortSignal,
): Promise<string> {
  const existing = await findTasksChannel(session, signal);
  if (existing) return existing;
  await session.channelCreation.create({
    name: TASKS_CHANNEL_NAME,
    visibility: "open",
    labels: [TASKS_LABEL],
    system: true,
  });
  signal.throwIfAborted();
  // Find again rather than trust the create: a concurrent first use may own
  // the older channel.
  const created = await findTasksChannel(session, signal);
  if (!created) throw new Error("Tasks isn’t ready yet. Try again.");
  return created;
}
