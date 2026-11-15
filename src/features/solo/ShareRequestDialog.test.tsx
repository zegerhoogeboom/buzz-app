// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type {
  ChannelDetails,
  ChannelDetailsDraft,
} from "../relay/channel-details-protocol";
import { ShareRequestDialog } from "./ShareRequestDialog";
import {
  type ChatSharing,
  createChatSharingService,
  createShareRequests,
} from "./share-requests";

afterEach(cleanup);

const id = "11111111-1111-4111-8111-111111111111";
const viewer = "a".repeat(64);
const asker = { requester: "Tasks" };

function fixture(
  visibility: "public" | "private" = "private",
  creator = viewer,
) {
  let base: ChannelDetails = {
    channelId: id,
    version: "version",
    name: "Chat",
    description: "",
    visibility,
    joinRole: "member",
    canEdit: true,
    labels: ["buzz.solo"],
  };
  let fail = false;
  const save = vi.fn(
    async (_base: ChannelDetails, draft: ChannelDetailsDraft) => {
      if (fail) throw new Error("Relay refused the change.");
      base = { ...base, ...draft, version: "saved" };
    },
  );
  const session = {
    viewer,
    channels: {
      list: () => ({
        channels: [{ id, channelType: "solo", creator, members: [creator] }],
      }),
    },
    channelDetails: {
      load: vi.fn(async () => base),
      save,
      check: vi.fn(async () => {}),
      snapshot: () => undefined,
    },
  } as unknown as RelaySession;
  return {
    session,
    save,
    failNext(value: boolean) {
      fail = value;
    },
  };
}

it("shows the app's confirmation and makes the chat View only only when confirmed", async () => {
  const f = fixture();
  const requests = createShareRequests();
  render(<ShareRequestDialog requests={requests} />);
  const outcome = requests.request(f.session, id, asker);
  expect(await screen.findByText("Share “Chat”?")).toBeTruthy();
  expect(
    screen.getByText(
      /full history, Canvas, workspace folders, and agent instructions/,
    ),
  ).toBeTruthy();
  expect(f.save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Share" }));
  expect(await outcome).toBe("shared");
  expect(f.save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ visibility: "private" }),
    expect.objectContaining({ visibility: "public", joinRole: "guest" }),
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(screen.queryByText("Share “Chat”?")).toBeNull();
});

it("changes nothing when the viewer cancels", async () => {
  const f = fixture();
  const requests = createShareRequests();
  render(<ShareRequestDialog requests={requests} />);
  const outcome = requests.request(f.session, id, asker);
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(await outcome).toBe("cancelled");
  expect(f.save).not.toHaveBeenCalled();
});

it("keeps the dialog open with the error so the viewer can retry", async () => {
  const f = fixture();
  f.failNext(true);
  const requests = createShareRequests();
  render(<ShareRequestDialog requests={requests} />);
  const outcome = requests.request(f.session, id, asker);
  await userEvent.click(await screen.findByRole("button", { name: "Share" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Relay refused the change.",
  );
  f.failNext(false);
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await outcome).toBe("shared");
});

it("resolves without a dialog when the chat is already open", async () => {
  const f = fixture("public");
  const requests = createShareRequests();
  render(<ShareRequestDialog requests={requests} />);
  expect(await requests.request(f.session, id, asker)).toBe("shared");
  expect(requests.snapshot()).toEqual([]);
  expect(screen.queryByText("Share “Chat”?")).toBeNull();
});

it("refuses without a dialog for a chat the viewer does not own", async () => {
  const f = fixture("private", "b".repeat(64));
  const requests = createShareRequests();
  expect(await requests.request(f.session, id, asker)).toBe("unavailable");
  expect(requests.snapshot()).toEqual([]);
  expect(f.save).not.toHaveBeenCalled();
});

it("asks once for repeated requests about the same chat", async () => {
  const f = fixture();
  const requests = createShareRequests();
  render(<ShareRequestDialog requests={requests} />);
  const first = requests.request(f.session, id, asker);
  await screen.findByText("Share “Chat”?");
  const second = requests.request(f.session, id, asker);
  expect(requests.snapshot()).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Share" }));
  expect(await first).toBe("shared");
  expect(await second).toBe("shared");
  expect(f.save).toHaveBeenCalledOnce();
});

it("withdraws a plugin's request when the plugin stops", async () => {
  const f = fixture();
  const root = new Context();
  const requests = createShareRequests();
  createChatSharingService(root, requests, (plugin) =>
    plugin === "example.tasks" ? "Tasks" : plugin,
  );
  let sharing: ChatSharing | undefined;
  const fiber = root
    .extend({ pluginOwner: { id: "example.tasks", revision: "one" } })
    .plugin((ctx) => {
      sharing = ctx.reflect.get("chatSharing");
    });
  await fiber.await();
  render(<ShareRequestDialog requests={requests} />);
  if (!sharing) throw new Error("chatSharing is unavailable");
  const outcome = sharing.requestShare(f.session, id);
  await screen.findByText("Share “Chat”?");
  await act(async () => {
    await fiber.dispose();
  });
  expect(await outcome).toBe("cancelled");
  expect(screen.queryByText("Share “Chat”?")).toBeNull();
  expect(f.save).not.toHaveBeenCalled();
});

it("withdraws a request when its caller's signal aborts", async () => {
  const f = fixture();
  const requests = createShareRequests();
  render(<ShareRequestDialog requests={requests} />);
  const controller = new AbortController();
  const outcome = requests.request(
    f.session,
    id,
    asker,
    undefined,
    controller.signal,
  );
  await screen.findByText("Share “Chat”?");
  act(() => controller.abort());
  expect(await outcome).toBe("cancelled");
  expect(screen.queryByText("Share “Chat”?")).toBeNull();
  expect(f.save).not.toHaveBeenCalled();
});

it("still shares after a StrictMode remount", async () => {
  const f = fixture();
  const requests = createShareRequests();
  render(
    <StrictMode>
      <ShareRequestDialog requests={requests} />
    </StrictMode>,
  );
  const outcome = requests.request(f.session, id, asker);
  await userEvent.click(await screen.findByRole("button", { name: "Share" }));
  expect(await outcome).toBe("shared");
  expect(f.save).toHaveBeenCalledOnce();
});

it("names who asks, their reason, and a chat without a name", async () => {
  const f = fixture();
  const requests = createShareRequests();
  render(<ShareRequestDialog requests={requests} />);
  void requests.request(f.session, id, {
    requester: "Tasks",
    reason: "Your agent Fizz wants to link it to the task “Fix the header”.",
  });
  await screen.findByText("Share “Chat”?");
  expect(
    screen.getByText(/Tasks asked to change “Chat” from Private to View only/),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Reason given: Your agent Fizz wants to link it to the task “Fix the header”.",
    ),
  ).toBeTruthy();
});

it("keeps sharing when its caller aborts after the viewer chose Share", async () => {
  const f = fixture();
  let finish!: () => void;
  f.save.mockImplementationOnce(
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  const requests = createShareRequests();
  render(<ShareRequestDialog requests={requests} />);
  const controller = new AbortController();
  const outcome = requests.request(
    f.session,
    id,
    asker,
    undefined,
    controller.signal,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Share" }));
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
  act(() => controller.abort());
  expect(screen.getByText("Share “Chat”?")).toBeTruthy();
  await act(async () => finish());
  expect(await outcome).toBe("shared");
});
