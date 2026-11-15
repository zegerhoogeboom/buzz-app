import { expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { readyToLink } from "./linking";

const session = (channels: Partial<ChannelSummary>[]) =>
  ({ channels: { list: () => ({ channels }) } }) as unknown as RelaySession;

it("asks the owner only before linking a Solo chat that isn't public", async () => {
  const requestShare = vi.fn(async () => "cancelled" as const);
  const sharing = { requestShare };
  const relay = session([
    { id: "solo", channelType: "solo", visibility: "private" },
    { id: "shared", channelType: "solo", visibility: "public" },
    { id: "unknown", channelType: "solo" },
    { id: "channel", channelType: "stream", visibility: "private" },
  ]);
  expect(await readyToLink(relay, sharing, "channel", { task: "T" })).toBe(
    "shared",
  );
  expect(await readyToLink(relay, sharing, "shared", { task: "T" })).toBe(
    "shared",
  );
  expect(await readyToLink(relay, sharing, "elsewhere", { task: "T" })).toBe(
    "shared",
  );
  expect(requestShare).not.toHaveBeenCalled();
  expect(await readyToLink(relay, sharing, "solo", { task: "T" })).toBe(
    "cancelled",
  );
  expect(await readyToLink(relay, sharing, "unknown", { task: "T" })).toBe(
    "cancelled",
  );
  expect(requestShare).toHaveBeenCalledTimes(2);
  expect(await readyToLink(relay, undefined, "solo", { task: "T" })).toBe(
    "unavailable",
  );
});
