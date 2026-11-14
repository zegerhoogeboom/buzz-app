import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChannelDetailsDraft } from "../relay/channel-details-protocol";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { soloShareDisclosure } from "./labels";
import { shareSoloChatAccess } from "./share";
import type { ShareRequest, ShareRequests } from "./share-requests";

/** The viewer confirms a `chatSharing` request with the app's own wording. */
export function ShareRequestDialog({ requests }: { requests: ShareRequests }) {
  const pending = useSyncExternalStore(requests.subscribe, requests.snapshot);
  const request = pending[0];
  if (!request) return null;
  return (
    <ShareRequestConfirmation
      key={request.id}
      request={request}
      requests={requests}
    />
  );
}

function ShareRequestConfirmation({
  request,
  requests,
}: {
  request: ShareRequest;
  requests: ShareRequests;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // An uncertain save is checked on retry, never republished.
  const attempts = useRef(new Map<string, ChannelDetailsDraft>());
  const controller = useRef(new AbortController());
  useEffect(() => {
    const active = controller.current;
    return () => active.abort();
  }, []);
  const decline = () => requests.settle(request.id, "cancelled");
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const { signal } = controller.current;
    try {
      await shareSoloChatAccess(request.session, request.details.channelId, {
        signal,
        confirmed: request.details,
        attempts: attempts.current,
      });
      requests.settle(request.id, "shared");
    } catch (reason) {
      if (signal.aborted) return;
      setError(
        reason instanceof Error ? reason.message : "Couldn’t share this chat.",
      );
      setBusy(false);
    }
  };
  return (
    <AlertDialog
      title="Share this chat?"
      description={
        <>
          This changes the chat from Private to View only.{" "}
          <span className="mt-3 block">{soloShareDisclosure()}</span>
        </>
      }
      pending={busy}
      onClose={decline}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} disabled={busy} onClick={decline}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={busy}
            onClick={() => void confirm()}
          >
            {error ? "Retry" : "Share"}
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      ) : null}
    </AlertDialog>
  );
}
