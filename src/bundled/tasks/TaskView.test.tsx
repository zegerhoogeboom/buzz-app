// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { TASK_TYPE, type Task, taskOf } from "./model";
import { TaskView } from "./TaskView";

afterEach(cleanup);

const viewer = "a".repeat(64);
const id = "11111111-1111-4111-8111-111111111111";
const home = "22222222-2222-4222-8222-222222222222";
const revision = (revisionId: string, title: string) => ({
  id: revisionId,
  pubkey: "b".repeat(64),
  sig: "",
  created_at: 5,
  kind: 45010,
  content: JSON.stringify({ version: 2, author: viewer }),
  tags: [
    ["d", id],
    ["h", home],
    ["type", TASK_TYPE],
    ["title", title],
  ],
});
const mine = taskOf(revision("d".repeat(64), "Fix the header")) as Task;
const theirs = revision("c".repeat(64), "Their title");

function setup(
  publish: () => Promise<string>,
  role: ChannelSummary["viewerRole"] = "member",
) {
  const signed: { tags: string[][] }[] = [];
  const channels: ChannelSummary[] = [
    { id: home, name: "design", channelType: "stream", viewerRole: role },
  ];
  const profiles = new Map();
  const list = { status: "ready", channels };
  const session = {
    viewer,
    media: () => undefined,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    channels: {
      ensureList: () => () => {},
      subscribeList: () => () => {},
      list: () => list,
    },
    snapshotRead: vi.fn(async (filters: { kinds?: number[] }[]) =>
      filters[0]?.kinds?.includes(45010) &&
      !(filters[0] as Record<string, unknown>)["#type"]
        ?.toString()
        .includes("link")
        ? [theirs]
        : [],
    ),
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
      task={mine}
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

it("shows a guest the task with no edit controls", () => {
  const { session } = setup(async () => "", "guest");
  render(
    <TaskView
      session={session}
      task={mine}
      openConversation={() => {}}
      onSaved={() => {}}
    />,
  );
  for (const name of ["Edit", "Move…"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.queryByLabelText("Status")).toBeNull();
});

it("creates a new task in the place it started, posting nothing", async () => {
  const { session, signed } = setup(async () => "");
  const onSaved = vi.fn();
  render(
    <TaskView
      session={session}
      task={undefined}
      home={home}
      openConversation={() => {}}
      onSaved={onSaved}
    />,
  );
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "From this chat" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(signed).toHaveLength(1);
  expect(signed[0]?.tags).toContainEqual(["h", home]);
  expect(signed[0]?.tags).toContainEqual(["op", "create"]);
});
