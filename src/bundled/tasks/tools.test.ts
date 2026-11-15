import { expect, it, vi } from "vitest";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { TASK_TYPE } from "./model";
import { addTaskTools } from "./tools";

const channel = vi.hoisted(() => ({ id: "tasks" as string | undefined }));
vi.mock("./tasks-channel", () => ({
  findTasksChannel: async () => channel.id,
  openTasksChannel: async () => (channel.id = "tasks"),
}));

const viewer = "a".repeat(64);
const solo = "11111111-1111-4111-8111-111111111111";
const head = (id: string, content: object) => ({
  id,
  pubkey: viewer,
  sig: "",
  created_at: 5,
  kind: 45010,
  content: JSON.stringify({ version: 1, author: viewer, ...content }),
  tags: [
    ["d", "task-1"],
    ["type", TASK_TYPE],
    ["title", "Fix the header"],
  ],
});

function setup(
  publish: () => Promise<string>,
  heads: () => object[],
  share: "shared" | "cancelled" = "shared",
) {
  const signed: { content: string; tags: string[][] }[] = [];
  const session = {
    viewer,
    channels: {
      list: () => ({
        channels: [
          {
            id: solo,
            name: "Header",
            channelType: "solo",
            visibility: "private",
          },
        ],
      }),
    },
    snapshotRead: vi.fn(async () => heads()),
    configArtifactWriter: {
      sign: vi.fn(async (template: { content: string; tags: string[][] }) => {
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
  const requestShare = vi.fn(async () => share);
  addTaskTools(
    {
      relay: () =>
        ({ snapshot: () => ({ status: "ready", session }) }) as never,
      snapshot: () =>
        ({ agents: [{ key: "agent", name: "Fizz" }], running: [] }) as never,
      addTool: (tool) => {
        tools.set(tool.name, (args) =>
          tool.call(
            { key: "agent", signal: new AbortController().signal } as never,
            { channel: solo },
            args,
          ),
        );
      },
    },
    () => ({ requestShare }),
  );
  return { tools, signed, requestShare };
}

it("creates nothing when the owner declines to share the chat", async () => {
  const { tools, signed, requestShare } = setup(
    async () => "",
    () => [],
    "cancelled",
  );
  await expect(
    tools.get("tasks_create")?.({ title: "Fix the header" }),
  ).rejects.toThrow("chose not to share");
  expect(requestShare).toHaveBeenCalledOnce();
  expect(signed).toHaveLength(0);
});

it("creates a task linked to this chat once shared", async () => {
  const { tools, signed } = setup(
    async () => "",
    () => [],
  );
  const reply = await tools.get("tasks_create")?.({
    title: "Fix the header",
    images: ["https://example.org/a.png"],
  });
  expect(reply).toContain("Created task");
  expect(JSON.parse(signed[0]?.content ?? "")).toMatchObject({
    links: [solo],
    images: [{ url: "https://example.org/a.png" }],
  });
});

it("reapplies an update over someone else's newer save", async () => {
  let current = head("d".repeat(64), {
    description: "Theirs.",
    status: "open",
  });
  let calls = 0;
  const { tools, signed } = setup(
    async () => {
      if (calls++ === 0) {
        current = head("c".repeat(64), {
          description: "Newer.",
          status: "open",
        });
        throw new PublishRejected("rejected", "conflict: stale prev");
      }
      return "";
    },
    () => [current],
  );
  await tools.get("tasks_update")?.({ id: "task-1", status: "done" });
  expect(signed[1]?.tags).toContainEqual(["prev", "c".repeat(64)]);
  expect(JSON.parse(signed[1]?.content ?? "")).toMatchObject({
    description: "Newer.",
    status: "done",
  });
});

it("names the agent and the task when it asks to share another chat", async () => {
  const other = "22222222-2222-4222-8222-222222222222";
  const { tools, requestShare } = setup(
    async () => "",
    () => [head("d".repeat(64), { status: "open" })],
  );
  await tools.get("tasks_link")?.({ id: "task-1", channel: solo });
  expect(requestShare).toHaveBeenCalledWith(
    expect.anything(),
    solo,
    expect.objectContaining({
      reason: "Your agent Fizz wants to link it to the task “Fix the header”.",
    }),
  );
  // A conversation that isn't the owner's Solo chat links without asking.
  requestShare.mockClear();
  await tools.get("tasks_link")?.({ id: "task-1", channel: other });
  expect(requestShare).not.toHaveBeenCalled();
});

it("reads without making the tasks channel", async () => {
  channel.id = undefined;
  try {
    const { tools, signed } = setup(
      async () => "",
      () => [],
    );
    expect(await tools.get("tasks_read")?.({})).toBe(
      "No tasks yet in this community.",
    );
    expect(channel.id).toBeUndefined();
    await tools.get("tasks_create")?.({ title: "First", link: false });
    expect(channel.id).toBe("tasks");
    expect(signed).toHaveLength(1);
  } finally {
    channel.id = "tasks";
  }
});

it("tells the agent which id to check after an unclear create", async () => {
  const { tools, signed } = setup(
    async () => {
      throw new Error("network");
    },
    () => [],
  );
  const failed = tools.get("tasks_create")?.({ title: "Fix", link: false });
  await expect(failed).rejects.toThrow(/saved as task [0-9a-f-]{36}/);
  const id = signed[0]?.tags.find((tag) => tag[0] === "d")?.[1];
  await expect(failed).rejects.toThrow(id);
});
