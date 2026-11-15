import { useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  ArrowLeftIcon,
  LinkIcon,
  ClipboardCheckIcon,
  PlusIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { isOpenStatus, type Task } from "./model";
import { useTasksWithSaved } from "./react";
import { saveTask } from "./store";
import { StatusIcon } from "./StatusIcon";
import { TaskView, type TaskViewProps } from "./TaskView";
import styles from "./Tasks.module.css";

/** Open tasks the "Link to a task" menu offers, newest first. */
const LINK_CHOICES = 20;

/** Tasks beside one conversation: those linked to it, and ways to make or
 * link one from here. A task opens in place, with Back. */
export function TasksPanel({
  session,
  channel,
  chat,
  readyToLink,
  openConversation,
}: {
  session: RelaySession;
  /** The tasks channel. */
  channel: string;
  /** The conversation this panel sits beside. */
  chat: string;
} & Pick<TaskViewProps, "readyToLink" | "openConversation">) {
  const state = useTasksWithSaved(session, channel);
  const notify = useToastNotification();
  // A new task carries the links it starts with; consent waits for Create.
  const [open, setOpen] = useState<string | { newLinks: string[] }>();
  const [linking, setLinking] = useState(false);
  const linked = state.tasks
    .filter((task) => task.links.includes(chat))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const choices = state.tasks
    .filter((task) => isOpenStatus(task.status) && !task.links.includes(chat))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, LINK_CHOICES);
  const cleared = async () => {
    const outcome = await readyToLink(chat);
    if (outcome === "unavailable")
      notify("Only this chat’s owner can link it to a task.", "error");
    return outcome === "shared";
  };
  const linkTo = async (task: Task) => {
    if (linking) return;
    setLinking(true);
    try {
      if (!(await cleared())) return;
      const result = await saveTask(
        session,
        channel,
        { ...task, links: [...task.links, chat] },
        task,
      );
      if (result.status === "saved") state.setSaved(result.task);
      else notify("Someone else changed this task. Try again.", "error");
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "Couldn’t link the task.",
        "error",
      );
    } finally {
      setLinking(false);
    }
  };
  const task =
    typeof open === "string"
      ? state.tasks.find((item) => item.id === open)
      : undefined;
  if (open && (typeof open === "object" || task))
    return (
      <div className={styles.body}>
        <div>
          <Button size="sm" variant="ghost" onClick={() => setOpen(undefined)}>
            <ArrowLeftIcon size={16} aria-hidden="true" />
            Back
          </Button>
        </div>
        <TaskView
          key={task?.id ?? "new"}
          session={session}
          channel={channel}
          task={task}
          currentChat={chat}
          newLinks={typeof open === "object" ? open.newLinks : undefined}
          readyToLink={readyToLink}
          openConversation={openConversation}
          onSaved={(next) => {
            state.setSaved(next);
            setOpen(next.id);
          }}
          onDiscard={() => setOpen(undefined)}
        />
      </div>
    );
  return (
    <div className={styles.body}>
      <div className={styles.toolbar}>
        <Button
          size="sm"
          variant="prominent"
          disabled={linking}
          onClick={() => setOpen({ newLinks: [chat] })}
        >
          <PlusIcon size={16} aria-hidden="true" />
          New task from this chat
        </Button>
        <MenuRoot>
          <MenuTrigger
            render={
              <Button size="sm" loading={linking} disabled={!choices.length}>
                <LinkIcon size={16} aria-hidden="true" />
                Link to a task
              </Button>
            }
          />
          <MenuPopup>
            {choices.map((item) => (
              <MenuItem key={item.id} onClick={() => void linkTo(item)}>
                {item.title || "Untitled task"}
              </MenuItem>
            ))}
          </MenuPopup>
        </MenuRoot>
      </div>
      <LoadingRegion
        pending={state.status === "loading"}
        label="Loading tasks…"
        feedback={
          state.status === "error" ? (
            <p role="alert" className="buzz-field-error m-0">
              {state.error}
            </p>
          ) : undefined
        }
      >
        {state.status === "loading" ? null : linked.length ? (
          <ul className={styles.rows} aria-label="Tasks linked here">
            {linked.map((item) => (
              <li key={item.id}>
                <NavigationItem
                  icon={<StatusIcon status={item.status} />}
                  label={item.title || "Untitled task"}
                  onClick={() => setOpen(item.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<ClipboardCheckIcon size={24} />}
            title="No tasks linked here"
            description="Make a task from this chat, or link it to one that already exists."
          />
        )}
      </LoadingRegion>
    </div>
  );
}
