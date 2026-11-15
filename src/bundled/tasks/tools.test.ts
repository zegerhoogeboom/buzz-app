import { expect, it, vi } from "vitest";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { TASK_TYPE } from "./model";
import { addTaskTools } from "./tools";

vi.mock("./tasks-channel", () => ({
  openTasksChannel: async () => "tasks",
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
