import type { ReactNode } from "react";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { useTasksChannel } from "./react";
import styles from "./Tasks.module.css";

/** Opens the community's tasks channel before showing `children`, making it
 * on the community's first use. The page and the panel share it. */
export function TasksGate({
  session,
  children,
}: {
  session: RelaySession;
  children(channel: string): ReactNode;
}) {
  const channel = useTasksChannel(session);
  if (channel.status === "found") return children(channel.channelId);
  return (
    <div className={styles.body}>
      <LoadingRegion
        pending={channel.status === "loading"}
        label="Loading tasks…"
        feedback={
          channel.status === "error" ? (
            <div role="alert" className={styles.notice}>
              <p className="text-body-sm">{channel.error}</p>
              <Button size="sm" onClick={channel.retry}>
                Try again
              </Button>
            </div>
          ) : undefined
        }
      >
        {null}
      </LoadingRegion>
    </div>
  );
}
