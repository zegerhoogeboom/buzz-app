// A task's comments live in its own hidden conversation: a channel of type
// `artifact` whose id is computed from the task alone, so anyone who can read
// the task finds it with no lookup. The relay makes it on the first comment,
// under the task's home, with no members and no owner; who reads and posts
// there always comes from the home, and a move takes it along.
import type { RelaySession } from "../../features/relay/session";
import type { Task } from "./model";

const encoder = new TextEncoder();

/** The conversation id for task `d`: UUIDv8 of the first 16 bytes of
 * SHA-256("nip-ar-conversation\0" + d), over the UTF-8 bytes of `d`. */
export async function conversationId(d: string) {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`nip-ar-conversation\0${d}`),
    ),
  ).slice(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x80;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Posts `text` in `task`'s conversation, making it first if nobody has.
 * The app can't yet post in a conversation outside the viewer's list, which
 * this one always is; until it can, this fails and says so. */
export async function postComment(
  _session: RelaySession,
  _task: Task,
  _text: string,
  _signal: AbortSignal,
): Promise<void> {
  throw new Error("Comments aren’t available in this version yet.");
}
