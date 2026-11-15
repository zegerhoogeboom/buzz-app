import type { ReactNode } from "react";
import type { RelaySession } from "../../features/relay/session";
import { ClipboardCheckIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { useTasksChannel } from "./react";
import styles from "./Tasks.module.css";

/** Finds the community's tasks channel before showing `children`, or explains
 * why there is none yet. The page and the panel share it. */
export function TasksGate({
  session,
  children,
}: {
  session: RelaySession;
  children(channel: string): ReactNode;
}) {
  const channel = useTasksChannel(session);
  if (channel.status === "found") return children(channel.channelId);
  if (channel.status === "missing")
    return (
      <div className={styles.body}>
        <EmptyState
          icon={<ClipboardCheckIcon size={24} />}
          title="Tasks isn’t set up yet"
          description={
            channel.canSetUp
              ? "Set up Tasks once for everyone in this community. You’ll own the hidden channel that holds them."
              : "Ask a community admin to set up Tasks."
          }
          action={
            channel.canSetUp ? (
              <Button
                variant="prominent"
                loading={channel.settingUp}
                onClick={channel.setUp}
              >
                Set up Tasks
              </Button>
            ) : undefined
          }
        />
      </div>
    );
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
