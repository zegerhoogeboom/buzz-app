// Agent tools: find, create, update and comment. Each runs in the owner's
// app and writes as the owner, the way the owner's own edits do, so the
// relay applies the owner's access. Two rules keep agents' tidying
// trustworthy: create looks for an open task about the same thing first, and
// Done or Cancelled needs evidence, left as a comment.
import type { Agents as AgentsService } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import { postComment } from "./conversation";
import { setLink } from "./links";
import {
  byRecent,
  checkedFields,
  imageOf,
  isChannelId,
  isOpenStatus,
  isPubkey,
  MAX_ASSIGNEES,
  statuses,
  statusLabels,
  type Task,
  type TaskFields,
  type TaskStatus,
} from "./model";
import { type Place, projectOf, readPlaces } from "./places";
import { readTask, readTasks, saveTask } from "./store";
import { holdsWords, sameness } from "./similar";

type Agents = Pick<AgentsService, "addTool" | "relay">;
type Client = { key: string; signal?: AbortSignal | undefined };
type Args = Record<string, unknown>;

/** How many times an agent's change is reapplied over someone else's edit. */
const ATTEMPTS = 3;
const LIST_LIMIT = 50;
/** How long one tool call's relay work may take. */
const STEP_TIMEOUT = 60_000;
/** At or above: the same task. Between this and CLEAR: a person decides. */
const CLEAR_MATCH = 0.8;
const POSSIBLE_MATCH = 0.5;

const deadline = (client: Client) =>
  client.signal
    ? AbortSignal.any([client.signal, AbortSignal.timeout(STEP_TIMEOUT)])
    : AbortSignal.timeout(STEP_TIMEOUT);

const statusOf = (value: unknown): TaskStatus | undefined =>
  statuses.find((status) => status === value);

const textArg = (args: Args, name: string) => {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  return value;
};

const channelArg = (args: Args, name: string) => {
  const value = textArg(args, name);
  if (value !== undefined && !isChannelId(value))
    throw new Error(`${name} must be a channel id`);
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

/** Assignees by pubkey, people only: an agent never answers for a task. */
function assigneesArg(args: Args, session: RelaySession) {
  if (args.assignees === undefined) return undefined;
  const list = args.assignees;
  if (!Array.isArray(list) || !list.every(isPubkey))
    throw new Error("assignees must be a list of people's hex pubkeys");
  if (list.length > MAX_ASSIGNEES)
    throw new Error(`A task has up to ${MAX_ASSIGNEES} assignees`);
  const profiles = session.profiles.snapshot();
  if (list.some((pubkey) => profiles.get(pubkey)?.isAgent))
    throw new Error("Only people can be assigned, never agents");
  return list;
}

const nameOf = (session: RelaySession, pubkey: string) =>
  session.profiles.snapshot().get(pubkey)?.name ?? pubkey;

/** Where it lives and who can see it, in words an agent can pass on. */
function whereabouts(task: Task, places: ReadonlyMap<string, Place>) {
  const home = places.get(task.home);
  const project = projectOf(task, places);
  const place = home ? `${home.name} (${home.kind}, ${home.id})` : task.home;
  const inProject =
    project.id && project.id !== task.home
      ? ` in the ${project.name ?? "private"} project`
      : "";
  return `Lives in ${place}${inProject}. Anyone who can open ${home?.name ?? "that place"} can see it.`;
}

function describe(
  task: Task,
  session: RelaySession,
  places: ReadonlyMap<string, Place>,
) {
  return [
    `# ${task.title}`,
    `id: ${task.id}`,
    `status: ${statusLabels[task.status]}`,
    `assignees: ${task.assignees.map((pubkey) => nameOf(session, pubkey)).join(", ") || "nobody"}`,
    `created by: ${nameOf(session, task.author)}`,
    `updated: ${new Date(task.updatedAt * 1000).toISOString()} by ${nameOf(session, task.editor)}`,
    whereabouts(task, places),
    "",
    task.description || "(No description.)",
    ...(task.images.length
      ? ["", "## Images", ...task.images.map((image) => `- ${image.url}`)]
      : []),
  ].join("\n");
}

const summary = (task: Task, session: RelaySession) =>
  `- ${task.id}: ${task.title} (${statusLabels[task.status]}; ${
    task.assignees.length
      ? task.assignees.map((pubkey) => nameOf(session, pubkey)).join(", ")
      : "nobody has it"
  })`;

export function addTaskTools(agents: Agents) {
  /** The owner's session for this agent's community. */
  function sessionOf(client: Client) {
    const relay = agents.relay(client.key)?.snapshot();
    if (relay?.status !== "ready")
      throw new Error("Tasks need this conversation's community");
    return relay.session;
  }

  async function current(
    session: RelaySession,
    id: string,
    signal: AbortSignal,
  ) {
    const task = await readTask(session, id, signal);
    if (!task) throw new Error(`No task ${id} that you can read`);
    return task;
  }

  /** Applies `edit` to the newest revision, again over anyone else's save. */
  async function change(
    session: RelaySession,
    id: string,
    edit: (task: Task) => TaskFields,
    signal: AbortSignal,
    home?: string,
  ) {
    let task = await current(session, id, signal);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      signal.throwIfAborted();
      const target =
        home && home !== task.home
          ? { op: "move" as const, base: task, home }
          : { op: "update" as const, base: task };
      const result = await saveTask(session, edit(task), target, signal);
      if (result.status === "saved") return result.task;
      task = result.current;
    }
    throw new Error("Others keep changing this task. Try again.");
  }

  agents.addTool({
    name: "tasks_find",
    description:
      'Finds tasks you can see, newest activity first. Use it to answer "what should I work on?": first assignee "me" (the person you work for), then open tasks nobody has taken. Searching a project covers everything filed in it. With id, reads one task in full.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Read this one task" },
        words: {
          type: "string",
          description: "Words in the title or description",
        },
        place: {
          type: "string",
          description:
            "A project, channel or chat id: its tasks, and for a project everything filed in it",
        },
        status: {
          type: "string",
          enum: ["open", "closed", "all"],
          description:
            "Open (To do, In progress; the default), closed (Done, Cancelled), or all",
        },
        assignee: {
          type: "string",
          description: '"me", "nobody", or a person\'s hex pubkey',
        },
      },
      additionalProperties: false,
    },
    async call(client, _context, args) {
      const session = sessionOf(client);
      const signal = deadline(client);
      const id = textArg(args, "id");
      if (id) {
        const task = await current(session, id, signal);
        return describe(
          task,
          session,
          await readPlaces(session, [task.home], signal),
        );
      }
      const words = (textArg(args, "words") ?? "").trim();
      const place = channelArg(args, "place");
      const which =
        args.status === "closed" || args.status === "all"
          ? args.status
          : "open";
      const assignee = textArg(args, "assignee");
      if (
        assignee &&
        assignee !== "me" &&
        assignee !== "nobody" &&
        !isPubkey(assignee)
      )
        throw new Error('assignee must be "me", "nobody" or a hex pubkey');
      const who = assignee === "me" ? session.viewer : assignee;
      const all = await readTasks(session, signal);
      const places = place
        ? await readPlaces(
            session,
            all.map((task) => task.home),
            signal,
          )
        : undefined;
      const tasks = all
        .filter(
          (task) =>
            (which === "all" ||
              isOpenStatus(task.status) === (which === "open")) &&
            (!who ||
              (who === "nobody"
                ? task.assignees.length === 0
                : task.assignees.includes(who))) &&
            (!place ||
              task.home === place ||
              (places && projectOf(task, places).id === place)) &&
            (!words || holdsWords(words, `${task.title} ${task.description}`)),
        )
        .sort(byRecent);
      if (!tasks.length) return "No tasks match.";
      return tasks
        .slice(0, LIST_LIMIT)
        .map((task) => summary(task, session))
        .concat(
          tasks.length > LIST_LIMIT
            ? [`…and ${tasks.length - LIST_LIMIT} more`]
            : [],
        )
        .join("\n");
    },
  });

  agents.addTool({
    name: "tasks_create",
    description:
      "Creates a task from what you're working on, without asking first: a short title, a Markdown description that makes sense to someone who can't read this conversation, and image links. It lives in place (default: this conversation), and everyone who can open that place can see it. It first looks for an open task about the same thing there: a clear match is returned instead, so comment on it with tasks_comment; a possible match is returned for the person to decide, and only then create with new_anyway. If you can't post in place, nothing is created: say so, never put it somewhere else. Reply with the task's id, where it lives and who can see it.",
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
        place: {
          type: "string",
          description:
            "Project, channel or chat id to put it in (default: this conversation)",
        },
        link: {
          type: "boolean",
          description:
            "Link this conversation to it (default true). Only people who can read this conversation see the link.",
        },
        new_anyway: {
          type: "boolean",
          description:
            "Create even though a possible match exists, once the person said so",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async call(client, context, args) {
      const session = sessionOf(client);
      const signal = deadline(client);
      const home = channelArg(args, "place") ?? context.channel;
      if (!isChannelId(home))
        throw new Error("Say which project, channel or chat it goes in");
      const fields = checkedFields({
        title: textArg(args, "title") ?? "",
        description: textArg(args, "description") ?? "",
        status: "todo",
        images: imagesArg(args) ?? [],
        assignees: [],
      });
      const open = (await readTasks(session, signal)).filter(
        (task) => task.home === home && isOpenStatus(task.status),
      );
      const scored = open
        .map((task) => ({ task, score: sameness(fields.title, task.title) }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best && best.score >= CLEAR_MATCH)
        return `Not created: open task ${best.task.id} is about the same thing. Comment on it with tasks_comment instead.\n\n${summary(best.task, session)}`;
      const possible = scored.filter((item) => item.score >= POSSIBLE_MATCH);
      if (possible.length && args.new_anyway !== true)
        return `Not created yet: these open tasks may be about the same thing. Ask the person whether one of them is it; if not, call tasks_create again with new_anyway.\n\n${possible
          .slice(0, 5)
          .map((item) => summary(item.task, session))
          .join("\n")}`;
      // Named before saving, so a retry after an unclear outcome can check.
      const id = crypto.randomUUID();
      const result = await saveTask(
        session,
        fields,
        { op: "create", home, id },
        signal,
      ).catch((reason: unknown) => {
        throw new Error(
          `${reason instanceof Error ? reason.message : "Couldn't create the task."} It may still have been saved as task ${id}: read it with tasks_find before creating it again.`,
        );
      });
      if (result.status !== "saved")
        throw new Error("Couldn't create the task");
      const chat = context.channel;
      const linked =
        args.link !== false && isChannelId(chat) && chat !== home
          ? await setLink(session, id, chat, true, signal).then(
              () =>
                "\nLinked this conversation; only people who can read it see that.",
              () => "\nCouldn't link this conversation.",
            )
          : "";
      const places = await readPlaces(session, [home], signal);
      return `Created task ${id}.${linked}\n\n${describe(result.task, session, places)}`;
    },
  });

  agents.addTool({
    name: "tasks_update",
    description:
      "Changes a task: title, description, images, assignees, status, or place (moving it changes who can see it and its comments). Omitted fields stay. Set In progress when work starts; that assigns the person you work for. Set Done or Cancelled only with evidence, such as a merged pull request or someone saying it's finished, and give it as evidence: it's left as a comment. Otherwise comment on progress instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        description: { type: "string", description: "Markdown" },
        images: {
          type: "array",
          items: { type: "string" },
          description: "https media links; replaces the whole list",
        },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "People's hex pubkeys, up to four; replaces the list",
        },
        status: { type: "string", enum: [...statuses] },
        evidence: {
          type: "string",
          description: "Required for done or cancelled: one line saying why",
        },
        place: {
          type: "string",
          description: "Move it to this project, channel or chat id",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    async call(client, _context, args) {
      const session = sessionOf(client);
      const id = textArg(args, "id") ?? "";
      const title = textArg(args, "title");
      const description = textArg(args, "description");
      const images = imagesArg(args);
      const assignees = assigneesArg(args, session);
      const place = channelArg(args, "place");
      const status =
        args.status === undefined ? undefined : statusOf(args.status);
      if (args.status !== undefined && !status)
        throw new Error(`status must be one of ${statuses.join(", ")}`);
      const evidence = textArg(args, "evidence")?.trim();
      const closing = status === "done" || status === "cancelled";
      if (closing && !evidence)
        throw new Error(
          "Done or Cancelled needs evidence: say in one line why, such as the merged pull request or who said it's finished",
        );
      const signal = deadline(client);
      const viewer = session.viewer;
      const task = await change(
        session,
        id,
        (base) => {
          const people = assignees ?? base.assignees;
          // Starting work assigns the person the agent works for.
          const starting =
            status === "in_progress" &&
            base.status !== "in_progress" &&
            !!viewer &&
            !people.includes(viewer) &&
            people.length < MAX_ASSIGNEES;
          return {
            ...base,
            ...(title !== undefined && { title }),
            ...(description !== undefined && { description }),
            ...(images && { images }),
            ...(status && { status }),
            assignees: starting && viewer ? [...people, viewer] : people,
          };
        },
        signal,
        place,
      );
      const noted =
        closing && evidence
          ? await postComment(
              session,
              task,
              `${statusLabels[task.status]}: ${evidence}`,
              signal,
            ).then(
              () => "",
              () =>
                "\nThe evidence comment didn't post; add it with tasks_comment.",
            )
          : "";
      const places = await readPlaces(session, [task.home], signal);
      return `Updated.${noted}\n\n${describe(task, session, places)}`;
    },
  });

  agents.addTool({
    name: "tasks_comment",
    description:
      "Comments on a task, such as progress, a summary of a thread about it, or the answer to a question in it. Everyone who can see the task reads it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task's id" },
        text: { type: "string", description: "Markdown" },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
    async call(client, _context, args) {
      const session = sessionOf(client);
      const signal = deadline(client);
      const text = (textArg(args, "text") ?? "").trim();
      if (!text) throw new Error("text must not be empty");
      const task = await current(session, textArg(args, "id") ?? "", signal);
      await postComment(session, task, text, signal);
      return `Commented on ${task.id}.`;
    },
  });
}
