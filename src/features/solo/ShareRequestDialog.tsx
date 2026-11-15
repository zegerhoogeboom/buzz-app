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
  // Made in the effect, so a remount (StrictMode) never keeps an aborted one.
  const controller = useRef<AbortController>(undefined);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    return () => active.abort();
  }, []);
  const decline = () => requests.settle(request.id, "cancelled");
  const confirm = async () => {
    const signal = controller.current?.signal;
    if (busy || !signal || signal.aborted) return;
    setBusy(true);
    setError("");
    // The chat may become View only from here, so its caller can't withdraw.
    requests.confirm(request.id);
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
  // A chat without a name is told apart by its id.
  const chat = request.details.name
    ? `“${request.details.name}”`
    : `chat ${request.details.channelId.slice(0, 8)}`;
  return (
    <AlertDialog
      title={`Share ${chat}?`}
      description={
        <>
          {request.requester} asked to change {chat} from Private to View only.
          {request.reason ? (
            <span className="mt-3 block">Reason given: {request.reason}</span>
          ) : null}
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
