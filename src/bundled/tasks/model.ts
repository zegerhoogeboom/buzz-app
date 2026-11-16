// A task is one NIP-AR artifact (kind 45010) of type `buzz.task`. Its `h` is
// its home, a project, channel or chat, and the relay lets read it whoever
// can read that home and edit it whoever can post there. Its content is the
// complete snapshot; the relay keeps the revision history and refuses an
// edit whose `prev` is stale.
import { ARTIFACT_KIND } from "../../features/agents/agent-config-artifacts";
import type { EventData } from "../../features/relay/events";

export const TASK_TYPE = "buzz.task";
const CONTENT_VERSION = 2;

export const statuses = ["todo", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof statuses)[number];
export const statusLabels: Readonly<Record<TaskStatus, string>> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
};
/** To do and In progress; Done and Cancelled are closed. */
export const isOpenStatus = (status: TaskStatus) =>
  status === "todo" || status === "in_progress";

export type TaskImage = Readonly<{
  url: string;
  type?: string | undefined;
  dim?: string | undefined;
}>;

/** What people edit. Assignees are people's pubkeys. */
export type TaskFields = Readonly<{
  title: string;
  description: string;
  status: TaskStatus;
  images: readonly TaskImage[];
  assignees: readonly string[];
}>;

export type Task = TaskFields &
  Readonly<{
    /** The artifact's `d`: stable across edits and moves. */
    id: string;
    /** The artifact's `h`: the project, channel or chat it lives in. */
    home: string;
    /** Who created it, as its creator's client recorded. */
    author: string;
    /** The current revision: its id is the next edit's `prev`. */
    revision: string;
    /** Who signed the current revision, and when. */
    editor: string;
    updatedAt: number;
  }>;

export const MAX_ASSIGNEES = 4;
const MAX_TITLE = 200;
const MAX_IMAGES = 32;
const HEX64 = /^[0-9a-f]{64}$/;
const CHANNEL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tag = (event: EventData, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];

const text = (value: unknown) => (typeof value === "string" ? value : "");

export const isChannelId = (value: unknown): value is string =>
  typeof value === "string" && CHANNEL.test(value);

export const isPubkey = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

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

/** A current revision as a task, or undefined when it is not a readable one. */
export function taskOf(event: EventData & { id: string }): Task | undefined {
  if (event.kind !== ARTIFACT_KIND || tag(event, "type") !== TASK_TYPE)
    return undefined;
  const id = tag(event, "d");
  const home = tag(event, "h");
  if (!isChannelId(id) || !isChannelId(home)) return undefined;
  let content: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    content = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const author = text(content.author);
  return {
    id,
    home,
    title: (tag(event, "title") ?? "").slice(0, MAX_TITLE),
    description: text(content.description),
    status: statuses.find((item) => item === content.status) ?? "todo",
    images: (Array.isArray(content.images) ? content.images : [])
      .flatMap((item) => imageOf(item) ?? [])
      .slice(0, MAX_IMAGES),
    assignees: [
      ...new Set(
        (Array.isArray(content.assignees) ? content.assignees : []).filter(
          isPubkey,
        ),
      ),
    ].slice(0, MAX_ASSIGNEES),
    author: isPubkey(author) ? author : event.pubkey,
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
  const assignees = [...new Set(fields.assignees)];
  if (!assignees.every(isPubkey)) throw new Error("Assign people only.");
  if (assignees.length > MAX_ASSIGNEES)
    throw new Error(`A task has up to ${MAX_ASSIGNEES} assignees.`);
  return {
    title,
    description: fields.description,
    status: fields.status,
    images: fields.images,
    assignees,
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
    assignees: fields.assignees,
  });

/** Newest activity first, then by id, so equal times keep one order. */
export const byRecent = (a: Task, b: Task) =>
  b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/** Assigned to the viewer, or created by them. Created by their agent counts
 * through the author the agent's tools record: the owner. */
export const isMine = (task: Task, viewer: string) =>
  task.author === viewer || task.assignees.includes(viewer);
