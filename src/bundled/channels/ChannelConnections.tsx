import { useEffect, useRef, useState } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ChannelConnect } from "../../features/channels/connect";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { ArrowsLeftRightIcon } from "../../shared/design-system/icons/index";
import { writeClipboardText } from "../../shared/clipboard";
import styles from "./ChannelMembersDialog.module.css";

/** Buzz Connect in the members dialog: who the channel is shared with, and
 * for its owners and admins, a one-time link to share it or a disconnect.
 * The relay decides; only community admins and owners succeed. */
export function ChannelConnections({
  connect,
  channel,
}: {
  connect: ChannelConnect | undefined;
  channel: ChannelSummary;
}) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [confirming, setConfirming] = useState(false);
  const lifetime = useRef<AbortController>(undefined);
  const disconnectAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const manage =
    !!connect &&
    (channel.viewerRole === "owner" || channel.viewerRole === "admin") &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    !channel.archived;
  if (!channel.connected && !manage) return null;
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    const signal = lifetime.current?.signal;
    if (!signal || busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await work(signal);
    } catch (reason) {
      if (!signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  const peer = channel.connected?.community;
  return (
    <section
      aria-label="Connected communities"
      className={styles.generalAccess}
    >
      <h3 className={`${styles.groupHeading} pb-2 text-caption text-subtle`}>
        Connected communities
      </h3>
      <div className={styles.accessRow}>
        <span className={styles.accessIcon} aria-hidden="true">
          <Avatar
            alt=""
            fallback=""
            fallbackContent={<ArrowsLeftRightIcon size={24} />}
            shape="squircle"
          />
        </span>
        <div className={styles.accessAudience}>
          <p className="text-body-sm">
            {peer ? `Shared with ${peer}` : "Not shared with another community"}
          </p>
          <p className="text-caption text-subtle">
            {peer
              ? `People from ${peer} read and post here. They don’t join this community.`
              : "Share this channel with one other community. Its people can read and post here without joining."}
          </p>
          {manage && peer && (
            <Button
              ref={disconnectAction}
              variant="destructive"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </Button>
          )}
          {manage && !peer && !link && (
            <Button
              loading={busy}
              onClick={() =>
                void run(async (signal) =>
                  setLink(await connect.offer(channel.id, signal)),
                )
              }
            >
              Connect another community
            </Button>
          )}
          {link && !peer && (
            <>
              <p className="text-caption text-subtle">
                Send this link to an admin of the other community. It works
                once, for 24 hours.
              </p>
              <code className="text-caption break-all">{link}</code>
              <Button
                onClick={() =>
                  void writeClipboardText(link).then(
                    () => setStatus("Link copied."),
                    () => setError("Could not copy the link."),
                  )
                }
              >
                Copy link
              </Button>
            </>
          )}
          {error && !confirming && (
            <p role="alert" className="text-caption text-danger">
              {error}
            </p>
          )}
          <span className="sr-only" role="status">
            {status}
          </span>
        </div>
      </div>
      {confirming && peer && connect && (
        <AlertDialog
          title={`Stop sharing with ${peer}?`}
          description={`New messages stop crossing in both directions. Both communities keep the history so far. Sharing again needs a new link.`}
          pending={busy}
          onClose={() => {
            setConfirming(false);
            setError("");
          }}
          finalFocus={disconnectAction}
          actions={
            <>
              <Button disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={busy}
                onClick={() =>
                  void run(async (signal) => {
                    await connect.disconnect(channel.id, signal);
                    setConfirming(false);
                    setLink("");
                    setStatus(`Stopped sharing with ${peer}.`);
                  })
                }
              >
                Disconnect
              </Button>
            </>
          }
        >
          {error && (
            <p role="alert" className="text-body-sm text-danger">
              {error}
            </p>
          )}
        </AlertDialog>
      )}
    </section>
  );
}
