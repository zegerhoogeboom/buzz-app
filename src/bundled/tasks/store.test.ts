import { expect, it, vi } from "vitest";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { TASK_TYPE, type Task, type TaskFields, taskOf } from "./model";
import { saveTask } from "./store";

const viewer = "a".repeat(64);
const fields: TaskFields = {
  title: "Fix the header",
  description: "It clips.",
  status: "open",
  images: [],
  links: [],
};
const head = (id: string, content: object) => ({
  id,
  pubkey: "b".repeat(64),
  sig: "",
  created_at: 5,
  kind: 45010,
  content: JSON.stringify({ version: 1, author: viewer, ...content }),
  tags: [
    ["ar", "1"],
    ["d", "task-1"],
    ["h", "tasks"],
    ["type", TASK_TYPE],
    ["title", "Fix the header"],
    ["op", "update"],
  ],
});

function session(publish: () => Promise<string>, heads: object[] = []) {
  const sign = vi.fn(async (template: object) => ({
    ...template,
    id: "f".repeat(64),
    pubkey: viewer,
    sig: "",
  }));
  return {
    sign,
    session: {
      viewer,
      snapshotRead: vi.fn(async () => heads),
      configArtifactWriter: { sign, publish: vi.fn(publish) },
    } as unknown as RelaySession,
  };
}

it("creates a task, then edits only the revision it opened", async () => {
  const { session: relay, sign } = session(async () => "");
  const created = await saveTask(relay, "tasks", fields, undefined);
  expect(created.status).toBe("saved");
  const tags = sign.mock.calls[0]?.[0] as unknown as { tags: string[][] };
  expect(tags.tags).toContainEqual(["op", "create"]);
  expect(tags.tags.some(([name]) => name === "prev")).toBe(false);
  if (created.status !== "saved") return;
  await saveTask(relay, "tasks", { ...fields, status: "done" }, created.task);
  const update = sign.mock.calls[1]?.[0] as unknown as { tags: string[][] };
  expect(update.tags).toContainEqual(["op", "update"]);
  expect(update.tags).toContainEqual(["prev", created.task.revision]);
  expect(update.tags).toContainEqual(["d", created.task.id]);
});

it("reports someone else's save as a conflict with their version", async () => {
  const theirs = head("c".repeat(64), { description: "Theirs." });
  const { session: relay } = session(async () => {
    throw new PublishRejected("rejected", "conflict: stale prev");
  }, [theirs]);
  const base = taskOf(head("d".repeat(64), {})) as Task;
  const result = await saveTask(relay, "tasks", fields, base);
  expect(result).toEqual({ status: "conflict", current: taskOf(theirs) });
});

it("confirms an uncertain save from the head, else says it failed", async () => {
  const base = taskOf(head("d".repeat(64), {})) as Task;
  const landed = session(async () => {
    throw new Error("socket closed");
  }, [head("f".repeat(64), {})]);
  expect((await saveTask(landed.session, "tasks", fields, base)).status).toBe(
    "saved",
  );
  const lost = session(async () => {
    throw new Error("socket closed");
  }, [head("d".repeat(64), {})]);
  await expect(saveTask(lost.session, "tasks", fields, base)).rejects.toThrow(
    "Couldn’t save the task. Try again.",
  );
  const refused = session(async () => {
    throw new PublishRejected("rejected", "restricted: not a member");
  });
  await expect(
    saveTask(refused.session, "tasks", fields, base),
  ).rejects.toThrow("You can’t edit tasks in this community.");
});

it("finds a create that landed unseen instead of making a second task", async () => {
  const { session: relay, sign } = session(async () => {
    throw new Error("socket closed");
  }, [
    {
      ...head("f".repeat(64), {}),
      tags: [
        ["d", "chosen"],
        ["type", TASK_TYPE],
        ["title", "Fix the header"],
      ],
    },
  ]);
  const result = await saveTask(
    relay,
    "tasks",
    fields,
    undefined,
    undefined,
    "chosen",
  );
  expect(result.status).toBe("saved");
  const template = sign.mock.calls[0]?.[0] as unknown as { tags: string[][] };
  expect(template.tags).toContainEqual(["d", "chosen"]);
});
