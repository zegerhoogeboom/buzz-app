import { describe, expect, it, vi } from "vitest";
import {
  channelConnection,
  createChannelConnect,
  createChannelConnectRequests,
  parseChannelConnectLink,
  remoteAuthors,
  remoteCommunity,
  validChannelConnectCommand,
} from "./connect";
import type { RelayEvent } from "../relay/events";
import type { ChannelSummary } from "../relay/contracts";

const uuid = "0b6f3c1e-8f7a-4d2b-9c3e-5a1d2e3f4a5b";
const link = `buzz://channel-connect?relay=wss%3A%2F%2Fa.example&channel=${uuid}&code=ab12`;
const key = (n: number) => n.toString(16).padStart(64, "0");
const metadata = (tags: string[][]) => ({ kind: 39000, tags }) as RelayEvent;

describe("channelConnection", () => {
  it("reads the relay-signed connected tag", () => {
    expect(
      channelConnection(
        metadata([
          ["d", uuid],
          ["connected", "wss://a.example", "Acme"],
        ]),
      ),
    ).toEqual({ relay: "wss://a.example", community: "Acme" });
  });
  it("names the community by its host when the tag has no name", () => {
    expect(
      channelConnection(metadata([["connected", "wss://a.example:8443"]])),
    ).toEqual({ relay: "wss://a.example:8443", community: "a.example:8443" });
  });
  it("ignores channels without one and malformed relays", () => {
    expect(channelConnection(metadata([["d", uuid]]))).toBeUndefined();
    expect(
      channelConnection(metadata([["connected", "https://a.example", "A"]])),
    ).toBeUndefined();
    expect(
      channelConnection(metadata([["connected", "not a url", "A"]])),
    ).toBeUndefined();
  });
});

describe("parseChannelConnectLink", () => {
  it("reads the link the relay mints", () => {
    expect(parseChannelConnectLink(link)).toEqual({
      relay: "wss://a.example",
      community: "a.example",
      channel: uuid,
      link,
    });
  });
  it.each([
    link.replace("channel-connect", "join"),
    link.replace(uuid, "general"),
    link.replace("code=ab12", "code=not-hex"),
    link.replace("&code=ab12", ""),
    `${link}&code=cd34`,
    link.replace("wss%3A%2F%2F", "https%3A%2F%2F"),
    `${link}#x`,
    "https://a.example/channel-connect?relay=wss://a.example",
  ])("refuses %s", (value) => {
    expect(parseChannelConnectLink(value)).toBeNull();
  });
});

describe("validChannelConnectCommand", () => {
  it("admits exactly the shapes the app writes", () => {
    expect(
      validChannelConnectCommand({
        kind: 9037,
        content: "",
        tags: [["channel", uuid]],
      }),
    ).toBe(true);
    expect(
      validChannelConnectCommand({
        kind: 9038,
        content: "",
        tags: [["link", link]],
      }),
    ).toBe(true);
    expect(
      validChannelConnectCommand({
        kind: 9039,
        content: "",
        tags: [["channel", uuid]],
      }),
    ).toBe(true);
  });
  it("refuses anything else", () => {
    for (const event of [
      { kind: 9038, content: "", tags: [["channel", uuid]] },
      { kind: 9037, content: "x", tags: [["channel", uuid]] },
      {
        kind: 9037,
        content: "",
        tags: [
          ["channel", uuid],
          ["p", key(1)],
        ],
      },
      { kind: 9039, content: "", tags: [["channel", "general"]] },
      { kind: 9038, content: "", tags: [["link", "buzz://join?relay=x"]] },
      { kind: 9, content: "", tags: [["channel", uuid]] },
    ])
      expect(validChannelConnectCommand(event)).toBe(false);
  });
});

describe("createChannelConnect", () => {
  const writer = (reply: string) => ({
    kinds: [9037, 9038, 9039],
    sign: vi.fn(async (template) => ({ ...template, id: "e" }) as RelayEvent),
    publish: vi.fn(async () => reply),
  });
  const signal = new AbortController().signal;
  it("is unavailable to a connection that cannot sign the commands", () => {
    expect(createChannelConnect(undefined)).toBeUndefined();
    expect(
      createChannelConnect({ ...writer(""), kinds: [9, 9037] }),
    ).toBeUndefined();
  });
  it("returns the offered link and refuses a reply that is not one", async () => {
    const ok = writer(link);
    await expect(createChannelConnect(ok)?.offer(uuid, signal)).resolves.toBe(
      link,
    );
    expect(ok.sign.mock.calls[0]?.[0]).toMatchObject({
      kind: 9037,
      content: "",
      tags: [["channel", uuid]],
    });
    await expect(
      createChannelConnect(writer("ok"))?.offer(uuid, signal),
    ).rejects.toThrow("no valid connection link");
  });
  it("accepts a link and disconnects a channel", async () => {
    const ok = writer(uuid);
    const connect = createChannelConnect(ok);
    const parsed = parseChannelConnectLink(link);
    if (!parsed) throw new Error("link");
    await expect(connect?.accept(parsed, signal)).resolves.toBe(uuid);
    await connect?.disconnect(uuid, signal);
    expect(ok.sign.mock.calls.map(([event]) => event)).toMatchObject([
      { kind: 9038, tags: [["link", link]] },
      { kind: 9039, tags: [["channel", uuid]] },
    ]);
  });
});

describe("remote authors", () => {
  const shared = {
    id: uuid,
    name: "launch",
    members: [key(1)],
    connected: { relay: "wss://a.example", community: "a.example" },
  } as ChannelSummary;
  const { connected: _, ...local } = shared;
  it("marks people outside this side's roster of a shared channel", () => {
    expect(remoteCommunity(shared, key(2))).toBe("a.example");
    expect(remoteCommunity(shared, key(1))).toBeUndefined();
    expect(remoteCommunity(local, key(2))).toBeUndefined();
  });
  it("lists each remote author of the loaded messages once", () => {
    const rows = [key(2), key(1), key(2), key(3), "bad"].map((authorId) => ({
      authorId,
    }));
    expect(remoteAuthors(shared, rows)).toEqual([key(2), key(3)]);
    expect(remoteAuthors(local, rows)).toEqual([]);
  });
});

it("keeps only the newest link awaiting confirmation", () => {
  const requests = createChannelConnectRequests();
  const listener = vi.fn();
  requests.subscribe(listener);
  const parsed = parseChannelConnectLink(link);
  if (!parsed) throw new Error("link");
  requests.open(parsed, key(1));
  requests.open(parsed, key(2));
  expect(requests.snapshot()?.viewer).toBe(key(2));
  requests.close();
  expect(requests.snapshot()).toBeUndefined();
  expect(listener).toHaveBeenCalledTimes(3);
});
