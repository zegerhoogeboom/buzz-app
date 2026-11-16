// Where tasks live, for presentation only: each home's name and kind, and
// the project it is filed in. Read from relay-signed channel metadata
// (kind 39000) by naming each channel, so places the viewer reads through a
// project resolve too. A place the viewer can't read stays unnamed. None of
// this decides access; the relay does.
import { channelIdentity } from "../../features/relay/channel-labels";
import { metadataName } from "../../features/relay/discovery";
import { tag, type RelayEvent } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { soloLabels } from "../../features/solo/labels";
import { channelVisibility } from "../../features/relay/channel-details-protocol";
import { isChannelId, isPubkey, type Task } from "./model";

export type Place = Readonly<{
  id: string;
  name: string;
  kind: "chat" | "channel";
  /** The channel it is filed under (NIP-29 `parent`), if any. */
  parent?: string | undefined;
  /** Open to everyone in the community. */
  open?: true | undefined;
}>;

/** A project as the Tasks page groups by it. `name` is undefined for a
 * project the viewer can't read. */
export type ProjectGroup = Readonly<{
  id: string | undefined;
  name: string | undefined;
}>;

const METADATA_LIMIT = 500;

function placeOf(event: RelayEvent): Place | undefined {
  const id = tag(event, "d");
  if (!isChannelId(id)) return undefined;
  const parent = tag(event, "parent");
  return {
    id,
    name: metadataName(event) ?? id.slice(0, 8),
    kind: soloLabels(channelIdentity(event).labels) ? "chat" : "channel",
    ...(isChannelId(parent) ? { parent } : {}),
    ...(channelVisibility(event) === "public" ? { open: true as const } : {}),
  };
}

/** A place other places are filed under. */
export const isProject = (id: string, places: ReadonlyMap<string, Place>) =>
  [...places.values()].some((place) => place.parent === id);

/** One name for a place everywhere: a project as "Buzz", a chat by its
 * name, any other channel as "#random". */
export function placeLabel(
  place: Pick<Place, "id" | "name" | "kind">,
  places: ReadonlyMap<string, Place>,
) {
  return place.kind === "chat" || isProject(place.id, places)
    ? place.name
    : `#${place.name}`;
}

/** Who can see what lives in `home`: anyone, when it or a place it is filed
 * under is open; otherwise the members of those places, from their
 * relay-signed rosters. The relay refuses an assignee who can't. */
export async function readReaders(
  session: Pick<RelaySession, "snapshotRead" | "relayAuthor">,
  home: string,
  signal: AbortSignal,
): Promise<Readonly<{ anyone: boolean; people: ReadonlySet<string> }>> {
  const read = session.snapshotRead;
  const author = session.relayAuthor;
  if (!read || !author) return { anyone: false, people: new Set() };
  const places = await readPlaces(session, [home], signal);
  const chain = chainOf(home, places);
  if (chain.some((id) => places.get(id)?.open))
    return { anyone: true, people: new Set() };
  const rosters = await read(
    [{ kinds: [39002], authors: [author], "#d": chain, limit: chain.length }],
    { signal },
  );
  const people = new Set<string>();
  for (const roster of rosters)
    if (roster.pubkey === author && chain.includes(tag(roster, "d") ?? ""))
      for (const [name, value] of roster.tags)
        if (name === "p" && isPubkey(value)) people.add(value);
  return { anyone: false, people };
}

/** The places named by `ids`, and the projects they are filed in. */
export async function readPlaces(
  session: Pick<RelaySession, "snapshotRead" | "relayAuthor">,
  ids: Iterable<string>,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Place>> {
  const read = session.snapshotRead;
  const author = session.relayAuthor;
  const places = new Map<string, Place>();
  if (!read || !author) return places;
  const fetch = async (wanted: readonly string[]) => {
    for (let at = 0; at < wanted.length; at += METADATA_LIMIT) {
      const page = wanted.slice(at, at + METADATA_LIMIT);
      const events = await read(
        [{ kinds: [39000], authors: [author], "#d": page, limit: page.length }],
        { signal },
      );
      for (const event of events) {
        const place = event.pubkey === author ? placeOf(event) : undefined;
        if (place && page.includes(place.id)) places.set(place.id, place);
      }
    }
  };
  await fetch([...new Set(ids)]);
  const parents = [...places.values()].flatMap((place) =>
    place.parent && !places.has(place.parent) ? [place.parent] : [],
  );
  await fetch([...new Set(parents)]);
  return places;
}

/** The project `task` is in: its home's parent, or its home when other
 * places are filed under it. A home neither filed nor holding anything is
 * in no project. */
export function projectOf(
  task: Task,
  places: ReadonlyMap<string, Place>,
): ProjectGroup {
  const home = places.get(task.home);
  if (home?.parent)
    return { id: home.parent, name: places.get(home.parent)?.name };
  const holds = [...places.values()].some(
    (place) => place.parent === task.home,
  );
  return holds
    ? { id: task.home, name: home?.name }
    : { id: undefined, name: undefined };
}

/** `id` and the places it is filed under, nearest first: everyone who can
 * read one of these reads what lives in `id`. */
function chainOf(id: string, places: ReadonlyMap<string, Place>) {
  const chain = [id];
  for (let at = places.get(id)?.parent; at && !chain.includes(at); ) {
    chain.push(at);
    at = places.get(at)?.parent;
  }
  return chain;
}

/** Whose access a move from `from` to `to` changes, by place: the people of
 * `gain` start seeing the task, and those of `lose` stop, unless they also
 * belong to a place in `gain`'s chain. Named places only, never people. */
export function accessChange(
  from: string,
  to: string,
  places: ReadonlyMap<string, Place>,
): Readonly<{ gain: readonly Place[]; lose: readonly Place[] }> {
  const before = chainOf(from, places);
  const after = chainOf(to, places);
  const named = (ids: readonly string[]) =>
    ids.flatMap((id) => places.get(id) ?? []);
  return {
    gain: named(after.filter((id) => !before.includes(id))),
    lose: named(before.filter((id) => !after.includes(id))),
  };
}
