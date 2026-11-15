// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { TASK_TYPE, type Task, taskOf } from "./model";
import { TaskView } from "./TaskView";

afterEach(cleanup);

const viewer = "a".repeat(64);
const chat = "11111111-1111-4111-8111-111111111111";
const revision = (id: string, title: string, content: object = {}) => ({
  id,
  pubkey: "b".repeat(64),
  sig: "",
  created_at: 5,
  kind: 45010,
  content: JSON.stringify({ version: 1, author: viewer, ...content }),
  tags: [
    ["d", "task-1"],
    ["type", TASK_TYPE],
    ["title", title],
  ],
});
const mine = taskOf(revision("d".repeat(64), "Fix the header")) as Task;
const theirs = revision("c".repeat(64), "Their title");

function setup(publish: () => Promise<string>) {
  const signed: { tags: string[][] }[] = [];
  const session = {
    viewer,
    profiles: { snapshot: () => new Map() },
    channels: { list: () => ({ channels: [] }) },
    snapshotRead: vi.fn(async () => [theirs]),
    configArtifactWriter: {
      sign: vi.fn(async (template: { tags: string[][] }) => {
        signed.push(template);
        return { ...template, id: "f".repeat(64), pubkey: viewer, sig: "" };
      }),
      publish: vi.fn(publish),
    },
  } as unknown as RelaySession;
  return { session, signed };
}

it("keeps the person's text on a conflict, then saves over the newer version", async () => {
  let refuse = true;
  const { session, signed } = setup(async () => {
    if (refuse) throw new PublishRejected("rejected", "conflict: stale prev");
    return "";
  });
  const onSaved = vi.fn();
  render(
    <TaskView
      session={session}
      channel="tasks"
      task={mine}
      readyToLink={async () => "shared"}
      openConversation={() => {}}
      onSaved={onSaved}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "My title" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Someone else changed this task. Your text is kept.",
  );
  expect(screen.getByLabelText("Title")).toHaveValue("My title");
  refuse = false;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(signed[1]?.tags).toContainEqual(["prev", theirs.id]);
  expect(signed[1]?.tags).toContainEqual(["title", "My title"]);
});

it("shows their version when asked", async () => {
  const { session } = setup(async () => {
    throw new PublishRejected("rejected", "conflict: stale prev");
  });
  render(
    <TaskView
      session={session}
      channel="tasks"
      task={mine}
      readyToLink={async () => "shared"}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Show their version" }),
  );
  expect(screen.getByLabelText("Title")).toHaveValue("Their title");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("links the current chat only once it may be linked", async () => {
  const { session, signed } = setup(async () => "");
  const readyToLink = vi
    .fn<(id: string) => Promise<"shared" | "cancelled" | "unavailable">>()
    .mockResolvedValueOnce("cancelled")
    .mockResolvedValueOnce("shared");
  const onSaved = vi.fn();
  render(
    <TaskView
      session={session}
      channel="tasks"
      task={mine}
      currentChat={chat}
      readyToLink={readyToLink}
      openConversation={() => {}}
      onSaved={onSaved}
    />,
  );
  const link = screen.getByRole("button", { name: "Link this chat" });
  fireEvent.click(link);
  await vi.waitFor(() => expect(readyToLink).toHaveBeenCalledTimes(1));
  expect(signed).toHaveLength(0);
  fireEvent.click(link);
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(onSaved.mock.calls[0]?.[0].links).toEqual([chat]);
});
