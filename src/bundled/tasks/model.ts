// A task is one NIP-AR artifact (kind 45010) of type `buzz.task` in the
// community's tasks channel. Its content is the complete snapshot; the relay
// keeps the revision history and refuses an edit whose `prev` is stale.
import { ARTIFACT_KIND } from "../../features/agents/agent-config-artifacts";
import type { EventData } from "../../features/relay/events";

export const TASK_TYPE = "buzz.task";
const CONTENT_VERSION = 1;

export const statuses = ["open", "in_progress", "done", "wont_do"] as const;
export type TaskStatus = (typeof statuses)[number];
export const statusLabels: Readonly<Record<TaskStatus, string>> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
  wont_do: "Won’t do",
};
/** Open includes In progress; Done includes Won't do. */
export const isOpenStatus = (status: TaskStatus) =>
  status === "open" || status === "in_progress";

export type TaskImage = Readonly<{
  url: string;
  type?: string | undefined;
  dim?: string | undefined;
}>;

/** What people edit. Links are channel ids: linkage, never membership. */
export type TaskFields = Readonly<{
  title: string;
  description: string;
  status: TaskStatus;
  images: readonly TaskImage[];
  links: readonly string[];
}>;

export type Task = TaskFields &
  Readonly<{
    /** The artifact's `d`. */
    id: string;
    /** Who created it, as its creator's client recorded. */
    author: string;
    /** The current revision: its id is the next edit's `prev`. */
    revision: string;
    /** Who signed the current revision, and when. */
    editor: string;
    updatedAt: number;
  }>;

const MAX_TITLE = 200;
const MAX_IMAGES = 32;
const MAX_LINKS = 64;
const HEX64 = /^[0-9a-f]{64}$/;
const CHANNEL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tag = (event: EventData, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Only HTTPS links render; anything else in an untrusted record is dropped. */
export function imageOf(value: unknown): TaskImage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { url, type, dim } = value as Record<string, unknown>;
  if (typeof url !== "string") return undefined;
  try {
    if (new URL(url).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return {
    url,
    ...(typeof type === "string" && type.startsWith("image/") ? { type } : {}),
    ...(typeof dim === "string" && /^\d{1,5}x\d{1,5}$/.test(dim)
      ? { dim }
      : {}),
  };
}

export const isChannelId = (value: unknown): value is string =>
  typeof value === "string" && CHANNEL.test(value);

/** A current revision as a task, or undefined when it is not a readable one. */
export function taskOf(event: EventData & { id: string }): Task | undefined {
  if (event.kind !== ARTIFACT_KIND || tag(event, "type") !== TASK_TYPE)
    return undefined;
  const id = tag(event, "d");
  if (!id) return undefined;
  let content: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    content = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const status = statuses.find((item) => item === content.status) ?? "open";
  const author = text(content.author);
  return {
    id,
    title: (tag(event, "title") ?? "").slice(0, MAX_TITLE),
    description: text(content.description),
    status,
    images: (Array.isArray(content.images) ? content.images : [])
      .flatMap((item) => imageOf(item) ?? [])
      .slice(0, MAX_IMAGES),
    links: [
      ...new Set(
        (Array.isArray(content.links) ? content.links : []).filter(isChannelId),
      ),
    ].slice(0, MAX_LINKS),
    author: HEX64.test(author) ? author : event.pubkey,
    revision: event.id,
    editor: event.pubkey,
    updatedAt: event.created_at,
  };
}

/** Fields checked and trimmed for saving; throws with a person-readable reason. */
export function checkedFields(fields: TaskFields): TaskFields {
  const title = fields.title.trim().replace(/\s+/g, " ");
  if (!title) throw new Error("Give the task a title.");
  if (title.length > MAX_TITLE)
    throw new Error(`Keep the title under ${MAX_TITLE} characters.`);
  if (fields.images.length > MAX_IMAGES)
    throw new Error(`A task holds up to ${MAX_IMAGES} images.`);
  if (fields.links.length > MAX_LINKS)
    throw new Error(`A task links up to ${MAX_LINKS} conversations.`);
  return {
    title,
    description: fields.description,
    status: fields.status,
    images: fields.images,
    links: [...new Set(fields.links)],
  };
}

/** The revision's content: the complete snapshot, author preserved. */
export const taskContent = (fields: TaskFields, author: string) =>
  JSON.stringify({
    version: CONTENT_VERSION,
    author,
    description: fields.description,
    status: fields.status,
    images: fields.images,
    links: fields.links,
  });

export type TaskFilter = Readonly<{
  status: "open" | "done";
  mine: boolean;
}>;

/** Mine: tasks I created, or that link a conversation I'm in. */
export function filterTasks(
  tasks: readonly Task[],
  filter: TaskFilter,
  viewer: string,
  myChannels: ReadonlySet<string>,
) {
  return tasks
    .filter(
      (task) =>
        isOpenStatus(task.status) === (filter.status === "open") &&
        (!filter.mine ||
          task.author === viewer ||
          task.links.some((link) => myChannels.has(link))),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
