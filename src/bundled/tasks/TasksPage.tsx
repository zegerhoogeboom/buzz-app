import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import type { PageProps } from "../../features/pages/service";
import {
  useChannelRoster,
  useRelayConnection,
} from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { ChatSharing } from "../../features/solo/share-requests";
import {
  ArrowLeftIcon,
  CaretDownIcon,
  ClipboardCheckIcon,
  PlusIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { readyToLink } from "./linking";
import { filterTasks, type TaskFilter } from "./model";
import { useTasksWithSaved } from "./react";
import { StatusIcon } from "./StatusIcon";
import { TasksGate } from "./TasksGate";
import { type TaskDraft, TaskView } from "./TaskView";
import styles from "./Tasks.module.css";

type TasksPageProps = Pick<PageProps, "navigation"> & {
  relay: RelayData;
  navigator: Navigation;
  sharing: ChatSharing | undefined;
};

export function TasksPage({
  relay,
  navigation,
  navigator,
  sharing,
}: TasksPageProps) {
  const connection = useRelayConnection(relay);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  const scope = useMemo<NavigationScope | undefined>(
    () =>
      connection.viewer && connection.scope
        ? {
            viewer: connection.viewer,
            communityOrigin: connection.scope.slice(
              0,
              -(connection.viewer.length + 1),
            ),
          }
        : undefined,
    [connection.viewer, connection.scope],
  );
  // A page opened without a community takes the one it connected to.
  useEffect(() => {
    if (
      request?.target.kind !== "page" ||
      request.target.scope !== undefined ||
      connection.status !== "ready" ||
      !scope
    )
      return;
    request.resolve({ ...request.target, scope });
  }, [request, connection.status, scope]);
  return (
    <Panel aria-label="Tasks">
      <div className={styles.page}>
        <PanelHeader
          title={
            <PanelHeaderLabel
              title="Tasks"
              icon={<ClipboardCheckIcon size="1rem" />}
            />
          }
        />
        {connection.status === "ready" && scope ? (
          <TasksGate
            key={`${connection.scope}:${connection.generation}`}
            session={connection.session}
          >
            {(channel) => (
              <TaskBoard
                session={connection.session}
                channel={channel}
                readyToLink={(channelId) =>
                  readyToLink(connection.session, sharing, channelId)
                }
                openConversation={(channelId) =>
                  void navigator.open({
                    version: 1,
                    kind: "conversation",
                    scope,
                    channelId,
                  })
                }
              />
            )}
          </TasksGate>
        ) : (
          <div className={styles.body}>
            <p role="status" className="text-body-sm text-subtle">
              {connection.status === "connecting"
                ? "Connecting to your community…"
                : "Connect to a community to see its tasks."}
            </p>
            {connection.status === "error" ? (
              <>
                <p role="alert" className="buzz-field-error m-0">
                  {connection.error}
                </p>
                <Button onClick={() => relay.tryAgain()}>
                  Retry connection
                </Button>
              </>
            ) : null}
          </div>
        )}
      </div>
    </Panel>
  );
}

const statusFilterLabels = { open: "Open", done: "Done" } as const;
const allOpen: TaskFilter = { status: "open", mine: false };

/** Tasks I'm in: conversations whose signed roster includes me. */
function useMyChannels(session: RelaySession) {
  const { channels } = useChannelRoster(session.channels);
  return useMemo(
    () =>
      new Set(
        channels
          .filter((item) => item.viewerRole && item.viewerRole !== "guest")
          .map((item) => item.id),
      ),
    [channels],
  );
}

function TaskBoard({
  session,
  channel,
  readyToLink,
  openConversation,
}: {
  session: RelaySession;
  channel: string;
  readyToLink: TaskViewLink;
  openConversation(channelId: string): void;
}) {
  const state = useTasksWithSaved(session, channel);
  const mine = useMyChannels(session);
  const [filter, setFilter] = useState<TaskFilter>(allOpen);
  const [selected, setSelected] = useState<string>();
  const shown = filterTasks(state.tasks, filter, session.viewer ?? "", mine);
  const task =
    selected === "new"
      ? undefined
      : state.tasks.find((item) => item.id === selected);
  const detail = selected === "new" || task !== undefined;
  const back = useCallback(() => setSelected(undefined), []);
  // Unsaved edits survive opening another task (DESIGN.md master/detail).
  const drafts = useRef(new Map<string, TaskDraft>());
  const onDraftChange = useCallback(
    (draft: TaskDraft | undefined) => {
      if (!selected) return;
      if (draft) drafts.current.set(selected, draft);
      else drafts.current.delete(selected);
    },
    [selected],
  );
  return (
    <div className={styles.board} data-detail={detail || undefined}>
      <section className={styles.list} aria-label="Task list">
        <div className={styles.toolbar}>
          <MenuRoot>
            <MenuTrigger
              render={
                <Button size="sm">
                  {statusFilterLabels[filter.status]}
                  {filter.mine ? " · Mine" : ""}
                  <CaretDownIcon size={16} aria-hidden="true" />
                </Button>
              }
            />
            <MenuPopup>
              <MenuGroup>
                <MenuGroupLabel>Status</MenuGroupLabel>
                <MenuRadioGroup
                  value={filter.status}
                  onValueChange={(value) =>
                    setFilter((current) => ({
                      ...current,
                      status: value === "done" ? "done" : "open",
                    }))
                  }
                >
                  <MenuRadioItem selection="highlight" value="open">
                    Open
                  </MenuRadioItem>
                  <MenuRadioItem selection="highlight" value="done">
                    Done
                  </MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Show</MenuGroupLabel>
                <MenuRadioGroup
                  value={filter.mine ? "mine" : "everyone"}
                  onValueChange={(value) =>
                    setFilter((current) => ({
                      ...current,
                      mine: value === "mine",
                    }))
                  }
                >
                  <MenuRadioItem selection="highlight" value="everyone">
                    Everyone’s
                  </MenuRadioItem>
                  <MenuRadioItem selection="highlight" value="mine">
                    Mine
                  </MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
            </MenuPopup>
          </MenuRoot>
          <span className={styles.spacer} />
          <Button
            size="sm"
            variant="prominent"
            onClick={() => setSelected("new")}
          >
            <PlusIcon size={16} aria-hidden="true" />
            New task
          </Button>
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
          {state.status === "loading" ? null : shown.length ? (
            <ul className={styles.rows}>
              {shown.map((item) => (
                <li key={item.id}>
                  <NavigationItem
                    icon={<StatusIcon status={item.status} />}
                    label={item.title || "Untitled task"}
                    trailing={
                      item.links.length
                        ? `${item.links.length} linked`
                        : undefined
                    }
                    selected={item.id === selected}
                    onClick={() => setSelected(item.id)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<ClipboardCheckIcon size={24} />}
              title={
                state.tasks.length
                  ? "No tasks match this filter"
                  : "No tasks yet"
              }
              description={
                state.tasks.length
                  ? "Change the filter to see other tasks."
                  : "A task holds the context for a piece of work and the conversations about it. You can also ask your agent to make one."
              }
              action={
                state.tasks.length ? (
                  <Button onClick={() => setFilter(allOpen)}>
                    Show all open tasks
                  </Button>
                ) : (
                  <Button onClick={() => setSelected("new")}>New task</Button>
                )
              }
            />
          )}
        </LoadingRegion>
      </section>
      {detail ? (
        <section className={styles.detail} aria-label="Task">
          <div className={styles.back}>
            <Button size="sm" variant="ghost" onClick={back}>
              <ArrowLeftIcon size={16} aria-hidden="true" />
              Back
            </Button>
          </div>
          <TaskView
            key={selected}
            session={session}
            channel={channel}
            task={task}
            readyToLink={readyToLink}
            openConversation={openConversation}
            draft={selected ? drafts.current.get(selected) : undefined}
            onDraftChange={onDraftChange}
            onSaved={(next) => {
              state.setSaved(next);
              setSelected(next.id);
            }}
            onDiscard={back}
          />
        </section>
      ) : null}
    </div>
  );
}

type TaskViewLink = Parameters<typeof TaskView>[0]["readyToLink"];
