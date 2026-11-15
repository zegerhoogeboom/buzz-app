import type { ReactNode } from "react";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { type TasksChannel, useTasksChannel } from "./react";
import styles from "./Tasks.module.css";

/** Looks up the community's tasks channel before showing `children`. The
 * page and the panel share it; the first save makes it. */
export function TasksGate({
  session,
  children,
}: {
  session: RelaySession;
  children(channel: TasksChannel): ReactNode;
}) {
  const channel = useTasksChannel(session);
  if (channel.status === "ready") return children(channel.channel);
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
