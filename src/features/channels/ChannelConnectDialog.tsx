import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChannelConnectRequest, ChannelConnectRequests } from "./connect";
import type { RelayData } from "../relay/service";
import type { Navigation } from "../navigation/controller";
import { communityDestination } from "../communities/destination";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";

/** Confirms a `buzz://channel-connect` link, then asks this community's relay
 * to accept it and opens the shared channel. The relay checks that the
 * viewer is a community admin and redeems the one-time code. */
export function ChannelConnectDialog({
  requests,
  relay,
  navigation,
}: {
  requests: ChannelConnectRequests;
  relay: RelayData;
  navigation: Pick<Navigation, "open">;
}) {
  const request = useSyncExternalStore(requests.subscribe, requests.snapshot);
  return request ? (
    <Confirmation
      key={`${request.viewer} ${request.link.link}`}
      request={request}
      requests={requests}
      relay={relay}
      navigation={navigation}
    />
  ) : null;
}

function Confirmation({
  request,
  requests,
  relay,
  navigation,
}: {
  request: ChannelConnectRequest;
  requests: ChannelConnectRequests;
  relay: RelayData;
  navigation: Pick<Navigation, "open">;
}) {
  const current = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lifetime = useRef<AbortController>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const { link, viewer } = request;
  const session = current.viewer === viewer ? current.session : undefined;
  const connect = session?.channelConnect;
  const here = current.origin && communityDestination(current.origin).url;
  const accept = async () => {
    const signal = lifetime.current?.signal;
    if (!signal || !connect || !here || busy) return;
    setBusy(true);
    setError("");
    try {
      const channelId = await connect.accept(link, signal);
      signal.throwIfAborted();
      session?.channels.refreshList?.({ consistency: "strong" });
      requests.close();
      void navigation.open({
        version: 1,
        kind: "conversation",
        scope: { viewer, communityOrigin: here },
        channelId,
      });
    } catch (reason) {
      if (signal.aborted) return;
      setBusy(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <Dialog
      size="compact"
      open
      onOpenChange={(open) => {
        if (!open && !busy) requests.close();
      }}
      title={`Share a channel with ${link.community}?`}
      description={
        connect && here
          ? `The channel appears in this community. People from ${link.community} will see its messages and the names and pictures of the people who post. Nobody joins the other community.`
          : "Switch to the community that should receive the channel, as an admin, and open the link again."
      }
      preventClose={busy}
      actions={
        <>
          <Button disabled={busy} onClick={() => requests.close()}>
            Cancel
          </Button>
          {connect && here && (
            <Button
              variant="prominent"
              loading={busy}
              onClick={() => void accept()}
            >
              Add channel
            </Button>
          )}
        </>
      }
    >
      {error ? (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
