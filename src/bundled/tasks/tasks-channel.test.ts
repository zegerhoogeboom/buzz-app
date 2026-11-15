import { expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { openTasksChannel, TASKS_LABEL } from "./tasks-channel";

const relay = "r".repeat(64);
const alice = "a".repeat(64);
const bob = "b".repeat(64);
const metadata = (id: string, creator: string, labels = [TASKS_LABEL]) => ({
  id: id.padEnd(64, "0"),
  pubkey: relay,
  sig: "",
  created_at: 1,
  kind: 39000,
  content: "",
  tags: [
    ["d", id],
    ["t", "system"],
    ...labels.map((label) => ["t", label]),
    ["P", creator],
  ],
});
const channel = (
  id: string,
  creator: string,
  createdAt: number,
  extra: Partial<ChannelSummary> = {},
): ChannelSummary => ({
  id,
  name: "Tasks",
  channelType: "system",
  creator,
  createdAt,
  labels: [TASKS_LABEL],
  ...extra,
});

function fixture(byCreator: Record<string, ChannelSummary[]>) {
  const events = Object.entries(byCreator).flatMap(([creator, list]) =>
    list.map((item) => metadata(item.id, creator)),
  );
  const create = vi.fn(async () => {
    byCreator[alice] = [...(byCreator[alice] ?? []), channel("mine", alice, 9)];
    events.push(metadata("mine", alice));
    return "mine";
  });
  const session = {
    relayAuthor: relay,
    snapshotRead: vi.fn(async () => [
      ...events,
      metadata("config", bob, ["buzz.agent"]),
    ]),
    channels: {
      findLabeled: vi.fn(
        async ({ creator }: { creator: string }) => byCreator[creator] ?? [],
      ),
    },
    channelCreation: { create },
  } as unknown as RelaySession;
  return { session, create };
}

it("uses the community's oldest open tasks channel, whoever made it", async () => {
  const { session, create } = fixture({
    [alice]: [channel("later", alice, 5)],
    [bob]: [
      channel("first", bob, 2),
      channel("archived", bob, 1, { archived: true }),
      channel("locked", bob, 1, { private: true }),
    ],
  });
  expect(await openTasksChannel(session, new AbortController().signal)).toBe(
    "first",
  );
  expect(create).not.toHaveBeenCalled();
});

it("makes the channel on the community's first use", async () => {
  const { session, create } = fixture({});
  expect(await openTasksChannel(session, new AbortController().signal)).toBe(
    "mine",
  );
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      system: true,
      visibility: "open",
      labels: [TASKS_LABEL],
    }),
  );
});
