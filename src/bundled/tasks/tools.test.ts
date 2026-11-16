import { expect, it, vi } from "vitest";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { TASK_TYPE } from "./model";
import { addTaskTools } from "./tools";

const viewer = "a".repeat(64);
const agent = "9".repeat(64);
const person = "b".repeat(64);
const id = "11111111-1111-4111-8111-111111111111";
const chat = "22222222-2222-4222-8222-222222222222";
const home = "33333333-3333-4333-8333-333333333333";

const head = (
  revision: string,
  content: object,
  extra: { d?: string; title?: string } = {},
) => ({
  id: revision,
  pubkey: viewer,
  sig: "",
  created_at: 5,
  kind: 45010,
  content: JSON.stringify({ version: 2, author: viewer, ...content }),
  tags: [
    ["d", extra.d ?? id],
    ["h", home],
    ["type", TASK_TYPE],
    ["title", extra.title ?? "Fix the header"],
  ],
});

type Signed = { kind: number; content: string; tags: string[][] };

function setup(publish: () => Promise<string>, heads: () => object[]) {
  const signed: Signed[] = [];
  const session = {
    viewer,
    profiles: {
      snapshot: () =>
        new Map([
          [agent, { name: "Fizz", isAgent: true }],
          [person, { name: "Riley" }],
        ]),
    },
    snapshotRead: vi.fn(async (filters: { kinds?: number[] }[]) =>
      filters[0]?.kinds?.includes(45010) ? heads() : [],
    ),
    configArtifactWriter: {
      sign: vi.fn(async (template: Signed) => {
        signed.push(template);
        return {
          ...template,
          id: `${signed.length}`.padStart(64, "f"),
          pubkey: viewer,
          sig: "",
        };
      }),
      publish: vi.fn(publish),
    },
  } as unknown as RelaySession;
  const tools = new Map<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  >();
  addTaskTools({
    relay: () => ({ snapshot: () => ({ status: "ready", session }) }) as never,
    addTool: (tool) => {
      tools.set(tool.name, (args) =>
        tool.call(
          { key: "agent", signal: new AbortController().signal } as never,
          { channel: chat },
          args,
        ),
      );
    },
  });
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no ${name}`);
    return tool(args);
  };
  return { call, signed };
}
const artifacts = (signed: Signed[]) =>
  signed.filter((event) => event.kind === 45010);
const typeOf = (event: Signed | undefined) =>
  event?.tags.find((tag) => tag[0] === "type")?.[1];

it("offers exactly find, create, update and comment", () => {
  const names: string[] = [];
  addTaskTools({
    relay: () => undefined as never,
    addTool: (tool) => void names.push(tool.name),
  });
  expect(names).toEqual([
    "tasks_find",
    "tasks_create",
    "tasks_update",
    "tasks_comment",
  ]);
});

it("creates in the named place and links this chat, posting nothing", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [],
  );
  const reply = await call("tasks_create", {
    title: "Fix the header",
    place: home,
    images: ["https://example.org/a.png"],
  });
  expect(reply).toContain("Created task");
  const [task, link] = artifacts(signed);
  expect(task?.tags).toContainEqual(["h", home]);
  expect(JSON.parse(task?.content ?? "")).toMatchObject({
    images: [{ url: "https://example.org/a.png" }],
    assignees: [],
  });
  // The link lives with the chat, so only its readers learn of it.
  expect(typeOf(link)).toBe("buzz.task-link");
  expect(link?.tags).toContainEqual(["h", chat]);
  expect(signed.every((event) => event.kind === 45010)).toBe(true);
});

it("returns a clear match instead of creating a duplicate", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), { status: "todo" })],
  );
  const reply = await call("tasks_create", {
    title: "Fix the header",
    place: home,
  });
  expect(reply).toContain(`Not created: open task ${id}`);
  expect(signed).toHaveLength(0);
});

it("leaves a possible match for the person, then creates when told", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), { status: "todo" })],
  );
  const args = { title: "Fix the header spacing on mobile", place: home };
  expect(await call("tasks_create", args)).toContain("Not created yet");
  expect(signed).toHaveLength(0);
  await call("tasks_create", { ...args, new_anyway: true, link: false });
  expect(artifacts(signed)).toHaveLength(1);
});

it("finds what's mine and what nobody has taken", async () => {
  const other = "44444444-4444-4444-8444-444444444444";
  const { call } = setup(
    async () => "",
    () => [
      head("d".repeat(64), { assignees: [viewer] }),
      head("c".repeat(64), {}, { d: other, title: "Nobody's" }),
    ],
  );
  const mine = await call("tasks_find", { assignee: "me" });
  expect(mine).toContain(id);
  expect(mine).not.toContain(other);
  const nobody = await call("tasks_find", { assignee: "nobody" });
  expect(nobody).toContain(other);
  expect(nobody).not.toContain(id);
});

it("needs evidence to close a task, and assigns whoever starts it", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), { status: "todo" })],
  );
  await expect(call("tasks_update", { id, status: "done" })).rejects.toThrow(
    "needs evidence",
  );
  expect(signed).toHaveLength(0);
  await call("tasks_update", { id, status: "in_progress" });
  expect(JSON.parse(signed[0]?.content ?? "")).toMatchObject({
    status: "in_progress",
    assignees: [viewer],
  });
});

it("assigns people only, never agents", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), {})],
  );
  await expect(
    call("tasks_update", { id, assignees: [person, agent] }),
  ).rejects.toThrow("never agents");
  await call("tasks_update", { id, assignees: [person] });
  expect(JSON.parse(signed[0]?.content ?? "")).toMatchObject({
    assignees: [person],
  });
});

it("moves a task when given a new place", async () => {
  const { call, signed } = setup(
    async () => "",
    () => [head("d".repeat(64), {})],
  );
  await call("tasks_update", { id, place: chat });
  expect(signed[0]?.tags).toContainEqual(["op", "move"]);
  expect(signed[0]?.tags).toContainEqual(["h", chat]);
});

it("reapplies an update over someone else's newer save", async () => {
  let current = head("d".repeat(64), { description: "Theirs." });
  let calls = 0;
  const { call, signed } = setup(
    async () => {
      if (calls++ === 0) {
        current = head("c".repeat(64), { description: "Newer." });
        throw new PublishRejected("rejected", "conflict: stale prev");
      }
      return "";
    },
    () => [current],
  );
  await call("tasks_update", { id, status: "in_progress" });
  expect(signed[1]?.tags).toContainEqual(["prev", "c".repeat(64)]);
  expect(JSON.parse(signed[1]?.content ?? "")).toMatchObject({
    description: "Newer.",
    status: "in_progress",
  });
});

it("tells the agent which id to check after an unclear create", async () => {
  const { call, signed } = setup(
    async () => {
      throw new Error("network");
    },
    () => [],
  );
  const failed = call("tasks_create", { title: "Fix", link: false });
  await expect(failed).rejects.toThrow(/saved as task [0-9a-f-]{36}/);
  const made = signed[0]?.tags.find((tag) => tag[0] === "d")?.[1];
  await expect(failed).rejects.toThrow(made);
});
