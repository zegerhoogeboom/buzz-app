// Agent tools. Each runs in the owner's app and writes as the owner, the way
// the owner's own edits do. Linking a private Solo chat still waits for the
// owner to confirm the app's "Share this chat?" dialog; an agent can't skip it.
import {
  ARTIFACT_KIND,
  readHead,
} from "../../features/agents/agent-config-artifacts";
import type { Agents as AgentsService } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChatSharing } from "../../features/solo/share-requests";
import { readyToLink } from "./linking";
import {
  checkedFields,
  imageOf,
  isChannelId,
  isOpenStatus,
  statuses,
  statusLabels,
  TASK_TYPE,
  type Task,
  type TaskFields,
  type TaskStatus,
  taskOf,
} from "./model";
import { saveTask } from "./store";
import { findTasksChannel } from "./tasks-channel";

type Agents = Pick<AgentsService, "addTool" | "relay">;
type Args = Record<string, unknown>;

/** How many times an agent's change is reapplied over someone else's edit. */
const ATTEMPTS = 3;
const LIST_LIMIT = 50;

const statusOf = (value: unknown): TaskStatus | undefined =>
  statuses.find((status) => status === value);

const textArg = (args: Args, name: string) => {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  return value;
};

function imagesArg(args: Args) {
  if (args.images === undefined) return undefined;
  if (!Array.isArray(args.images))
    throw new Error("images must be a list of https media links");
  return args.images.map((item) => {
    const image = imageOf(typeof item === "string" ? { url: item } : item);
    if (!image) throw new Error("Each image must be an https media link");
    return image;
  });
}

function describe(task: Task, session: RelaySession) {
  const channels = session.channels.list().channels;
  const links = task.links.map((id) => {
    const channel = channels.find((item) => item.id === id);
    return channel
      ? `- ${channel.name} (${channel.channelType ?? "channel"}, ${id})`
      : `- A conversation you can't read (${id})`;
  });
  return [
    `# ${task.title}`,
    `id: ${task.id}`,
    `status: ${statusLabels[task.status]}`,
    `author: ${task.author}`,
    `updated: ${new Date(task.updatedAt * 1000).toISOString()} by ${task.editor}`,
    "",
    task.description || "(No description.)",
    ...(task.images.length
      ? ["", "## Images", ...task.images.map((image) => `- ${image.url}`)]
      : []),
    "",
    "## Linked conversations",
    ...(links.length ? links : ["(None.)"]),
  ].join("\n");
}

export function addTaskTools(
  agents: Agents,
  sharing: () => ChatSharing | undefined,
) {
  /** The owner's session for this agent's community, and its tasks channel. */
  async function open(client: { key: string; signal?: AbortSignal }) {
    const relay = agents.relay(client.key)?.snapshot();
    if (relay?.status !== "ready")
      throw new Error("Tasks need this conversation's community");
    const signal = client.signal ?? AbortSignal.timeout(60_000);
    const found = await findTasksChannel(relay.session, signal);
    if (found.status !== "found")
      throw new Error(
        found.canSetUp
          ? "Tasks isn't set up in this community. Ask your owner to open Tasks and set it up."
          : "Tasks isn't set up in this community. A community admin needs to set it up.",
      );
    return { session: relay.session, channel: found.channelId, signal };
  }

  async function current(
    session: RelaySession,
    channel: string,
    id: string,
    signal: AbortSignal,
  ) {
    const read = session.snapshotRead;
    if (!read) throw new Error("This community can't read tasks");
    const head = await readHead(read, channel, id, signal);
    const task = head && taskOf(head);
    if (!task) throw new Error(`No task ${id} here`);
    return task;
  }

  /** Applies `edit` to the newest revision, again over anyone else's save. */
  async function change(
    session: RelaySession,
    channel: string,
    id: string,
    edit: (task: Task) => TaskFields,
    signal: AbortSignal,
  ) {
    let task = await current(session, channel, id, signal);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      const result = await saveTask(session, channel, edit(task), task, signal);
      if (result.status === "saved") return result.task;
      task = result.current ?? (await current(session, channel, id, signal));
    }
    throw new Error("Others keep changing this task. Try again.");
  }

  async function cleared(
    session: RelaySession,
    chat: string,
    signal: AbortSignal,
  ) {
    const outcome = await readyToLink(session, sharing(), chat, signal);
    signal.throwIfAborted();
    if (outcome === "cancelled")
      throw new Error(
        "Your owner chose not to share this chat, so it wasn't linked.",
      );
    if (outcome === "unavailable")
      throw new Error("Only this chat's owner can link it to a task.");
  }

  agents.addTool({
    name: "tasks_create",
    description:
      "Creates a task in this community's Tasks: a title, a Markdown description of what was noticed and why, and image links. Links this conversation unless link is false. Linking a private Solo chat makes it View only for the community, so your owner sees a confirmation first; nothing is created if they decline.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title" },
        description: {
          type: "string",
          description: "Markdown: the context someone needs to pick this up",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "https media links of images, as messages attach them",
        },
        link: {
          type: "boolean",
          description: "Link this conversation (default true)",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async call(client, context, args) {
      const chat = args.link === false ? undefined : context.channel;
      // Checked before the owner is asked, so a bad call never shares a chat.
      const fields = checkedFields({
        title: textArg(args, "title") ?? "",
        description: textArg(args, "description") ?? "",
        status: "open",
        images: imagesArg(args) ?? [],
        links: chat ? [chat] : [],
      });
      const { session, channel, signal } = await open(client);
      if (chat) await cleared(session, chat, signal);
      const result = await saveTask(
        session,
        channel,
        fields,
        undefined,
        signal,
      );
      if (result.status !== "saved")
        throw new Error("Couldn't create the task");
      return `Created task ${result.task.id}.\n\n${describe(result.task, session)}`;
    },
  });

  agents.addTool({
    name: "tasks_read",
    description:
      "Reads one task with its description, images and linked conversations, or without id lists tasks (open by default).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task's id" },
        status: {
          type: "string",
          enum: ["open", "done", "all"],
          description: "Without id: which tasks to list",
        },
        linked_here: {
          type: "boolean",
          description: "Without id: only tasks linked to this conversation",
        },
      },
      additionalProperties: false,
    },
    async call(client, context, args) {
      const { session, channel, signal } = await open(client);
      const id = textArg(args, "id");
      if (id)
        return describe(await current(session, channel, id, signal), session);
      const read = session.snapshotRead;
      if (!read) throw new Error("This community can't read tasks");
      const which =
        args.status === "done" || args.status === "all" ? args.status : "open";
      const here = args.linked_here === true ? context.channel : undefined;
      const tasks = (
        await read(
          [
            {
              artifact: "current",
              kinds: [ARTIFACT_KIND],
              "#h": [channel],
              "#type": [TASK_TYPE],
              limit: 500,
            },
          ],
          { signal },
        )
      )
        .flatMap((event) => taskOf(event) ?? [])
        .filter(
          (task) =>
            (which === "all" ||
              isOpenStatus(task.status) === (which === "open")) &&
            (!here || task.links.includes(here)),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (!tasks.length) return "No tasks match.";
      return tasks
        .slice(0, LIST_LIMIT)
        .map(
          (task) =>
            `- ${task.id}: ${task.title} (${statusLabels[task.status]}, ${task.links.length} linked)`,
        )
        .concat(
          tasks.length > LIST_LIMIT
            ? [`…and ${tasks.length - LIST_LIMIT} more`]
            : [],
        )
        .join("\n");
    },
  });

  agents.addTool({
    name: "tasks_update",
    description:
      "Changes a task's title, description, status or images. Omitted fields stay as they are; images replaces the whole list.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        description: { type: "string", description: "Markdown" },
        status: { type: "string", enum: [...statuses] },
        images: {
          type: "array",
          items: { type: "string" },
          description: "https media links",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async call(client, _context, args) {
      const id = textArg(args, "id") ?? "";
      const title = textArg(args, "title");
      const description = textArg(args, "description");
      const status =
        args.status === undefined ? undefined : statusOf(args.status);
      if (args.status !== undefined && !status)
        throw new Error(`status must be one of ${statuses.join(", ")}`);
      const images = imagesArg(args);
      const { session, channel, signal } = await open(client);
      const task = await change(
        session,
        channel,
        id,
        (base) => ({
          ...base,
          ...(title !== undefined && { title }),
          ...(description !== undefined && { description }),
          ...(status && { status }),
          ...(images && { images }),
        }),
        signal,
      );
      return `Updated.\n\n${describe(task, session)}`;
    },
  });

  agents.addTool({
    name: "tasks_link",
    description:
      "Links a conversation to a task, or unlinks it. Defaults to this conversation. Linking never adds anyone to it. Linking a private Solo chat makes it View only for the community, so your owner sees a confirmation first. Unlinking never changes access back.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task's id" },
        channel: {
          type: "string",
          description: "The conversation's channel id (default: this one)",
        },
        unlink: { type: "boolean", description: "Unlink instead" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async call(client, context, args) {
      const id = textArg(args, "id") ?? "";
      const chat = textArg(args, "channel") ?? context.channel;
      if (!isChannelId(chat)) throw new Error("channel must be a channel id");
      const unlink = args.unlink === true;
      const { session, channel, signal } = await open(client);
      if (!unlink) {
        // The task must exist before the owner is asked to share for it.
        await current(session, channel, id, signal);
        await cleared(session, chat, signal);
      }
      const task = await change(
        session,
        channel,
        id,
        (base) => ({
          ...base,
          links: unlink
            ? base.links.filter((link) => link !== chat)
            : [...base.links, chat],
        }),
        signal,
      );
      return `${unlink ? "Unlinked. Its access is unchanged." : "Linked."}\n\n${describe(task, session)}`;
    },
  });
}
