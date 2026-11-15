import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import { useChannelReference } from "../../features/conversation/channel-reference";
import { DOCUMENT_PROFILE } from "../../features/markdown/document-profile";
import {
  MarkdownDocument,
  sharedComponents,
} from "../../features/markdown/MarkdownDocument";
import { AttachmentImage } from "../../features/messages/AttachmentImage";
import { useIdentityNames } from "../../features/identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  ChatCircleIcon,
  HashIcon,
  ImageIcon,
  LinkIcon,
  LockIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import {
  statuses,
  statusLabels,
  type Task,
  type TaskFields,
  type TaskImage,
  type TaskStatus,
} from "./model";
import { StatusIcon } from "./StatusIcon";
import { saveTask } from "./store";
import type { ChatShareOutcome } from "../../features/solo/share-requests";
import styles from "./Tasks.module.css";

const empty: TaskFields = {
  title: "",
  description: "",
  status: "open",
  images: [],
  links: [],
};
/** An open edit: the text, the revision it builds on, and the task's id. */
export type TaskDraft = Readonly<{
  fields: TaskFields;
  base: Task | undefined;
  id: string;
}>;

/** A save, or why it stopped before writing: a link the owner didn't share. */
type ViewSave =
  | Awaited<ReturnType<typeof saveTask>>
  | Readonly<{ status: "declined"; outcome: "cancelled" | "unavailable" }>;
const declined = "Only this chat’s owner can link it to a task.";

const fieldsOf = (task: Task): TaskFields => ({
  title: task.title,
  description: task.description,
  status: task.status,
  images: task.images,
  links: task.links,
});

export type TaskViewProps = {
  session: RelaySession;
  /** The tasks channel. */
  channel: string;
  /** The task's current revision; undefined starts a new task. */
  task: Task | undefined;
  /** The conversation this view sits beside, which "Link this chat" links. */
  currentChat?: string | undefined;
  /** Resolves "shared" once `channelId` may be linked; a private Solo chat
   * first asks its owner to make it View only. */
  readyToLink(channelId: string): Promise<ChatShareOutcome>;
  openConversation(channelId: string): void;
  onSaved(task: Task): void;
  /** Conversations a new task starts linked to, already cleared to link. */
  newLinks?: readonly string[] | undefined;
  /** Unsaved edits the list keeps while another task is open. */
  draft?: TaskDraft | undefined;
  onDraftChange?: ((draft: TaskDraft | undefined) => void) | undefined;
  /** Leaves a new task without saving it. */
  onDiscard?: (() => void) | undefined;
};

/** One task: read by default, with an explicit edit mode. Every save names the
 * revision it started from, so a concurrent edit is reported, never lost. */
export function TaskView(props: TaskViewProps) {
  const { session, channel, task } = props;
  const notify = useToastNotification();
  const [editing, setEditing] = useState(!task || !!props.draft);
  const [saving, setSaving] = useState(false);
  // Consent is asked only as a link is saved, so declining or discarding
  // never leaves a chat shared with nothing linked to it.
  const save = async (
    fields: TaskFields,
    base: Task | undefined,
    id?: string,
  ): Promise<ViewSave> => {
    setSaving(true);
    try {
      for (const added of fields.links.filter(
        (link) => !base?.links.includes(link),
      )) {
        const outcome = await props.readyToLink(added);
        if (outcome !== "shared") return { status: "declined", outcome };
      }
      const result = await saveTask(
        session,
        channel,
        fields,
        base,
        undefined,
        id,
      );
      if (result.status === "saved") props.onSaved(result.task);
      return result;
    } finally {
      setSaving(false);
    }
  };
  // Immediate changes in read mode: status and links.
  const change = async (next: Partial<TaskFields>) => {
    if (!task || saving) return false;
    try {
      const result = await save({ ...fieldsOf(task), ...next }, task);
      if (result.status === "saved") return true;
      if (result.status === "conflict")
        notify("Someone else changed this task. Try again.", "error");
      else if (result.outcome === "unavailable") notify(declined, "error");
    } catch (reason) {
      notify(
        reason instanceof Error ? reason.message : "Couldn’t save the task.",
        "error",
      );
    }
    return false;
  };
  if (editing || !task)
    return (
      <TaskEditor
        {...props}
        saving={saving}
        save={save}
        onDone={(saved) => {
          props.onDraftChange?.(undefined);
          setEditing(false);
          if (!saved && !task) props.onDiscard?.();
        }}
      />
    );
  const link = (channelId: string) =>
    change({ links: [...task.links, channelId] });
  const unlink = async (channelId: string) => {
    const solo =
      session.channels.list().channels.find((item) => item.id === channelId)
        ?.channelType === "solo";
    const unlinked = await change({
      links: task.links.filter((item) => item !== channelId),
    });
    // Unlinking never changes access back.
    if (unlinked && solo)
      notify(
        "Unlinked. The chat stays View only. Change that in the chat’s People settings.",
        "success",
      );
  };
  const linkedHere =
    props.currentChat !== undefined && task.links.includes(props.currentChat);
  return (
    <article className={styles.task} aria-label={task.title}>
      <div className={styles.taskHeading}>
        <h2 className="text-title">{task.title}</h2>
        <TaskByline session={session} task={task} />
      </div>
      <div className={styles.taskActions}>
        <Select
          label="Status"
          variant="compact"
          value={task.status}
          leading={<StatusIcon status={task.status} />}
          disabled={saving}
          groups={[
            {
              label: "Status",
              options: statuses.map((status) => ({
                value: status,
                label: statusLabels[status],
                leading: <StatusIcon status={status} />,
              })),
            },
          ]}
          onValueChange={(value) =>
            void change({ status: value as TaskStatus })
          }
        />
        <Button onClick={() => setEditing(true)} disabled={saving}>
          Edit
        </Button>
      </div>
      {task.description.trim() ? (
        <MarkdownDocument
          content={task.description}
          profile={DOCUMENT_PROFILE}
          components={sharedComponents}
          scale="document"
          capabilities={{ session }}
        />
      ) : (
        <p className="text-body-sm text-subtle">No description.</p>
      )}
      {task.images.length > 0 && (
        <TaskImages session={session} images={task.images} />
      )}
      <section className={styles.section} aria-labelledby={`${task.id}-links`}>
        <InlineHeader id={`${task.id}-links`} title="Linked conversations" />
        {task.links.length ? (
          <ul className={styles.rows}>
            {task.links.map((channelId) => (
              <li key={channelId} className={styles.linkRow}>
                <LinkedConversation
                  session={session}
                  channelId={channelId}
                  open={() => props.openConversation(channelId)}
                />
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label="Unlink"
                  icon={<XIcon size={16} aria-hidden="true" />}
                  disabled={saving}
                  onClick={() => void unlink(channelId)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body-sm text-subtle">
            No conversations are linked yet.
          </p>
        )}
        {props.currentChat && !linkedHere ? (
          <div className={styles.actionRow}>
            <Button
              disabled={saving}
              onClick={() => void link(props.currentChat as string)}
            >
              <LinkIcon size={16} aria-hidden="true" />
              Link this chat
            </Button>
          </div>
        ) : null}
      </section>
    </article>
  );
}

function TaskByline({ session, task }: { session: RelaySession; task: Task }) {
  const name = useIdentityNames(session.names);
  const label = (pubkey: string) =>
    pubkey === session.viewer
      ? "you"
      : name(
          pubkey,
          session.profiles.snapshot().get(pubkey)?.name ??
            formatPublicKey(pubkey) ??
            "someone",
        );
  return (
    <p className="text-body-sm text-subtle">
      Created by {label(task.author)} · Updated{" "}
      {relativeTimestamp(task.updatedAt * 1000)} by {label(task.editor)}
    </p>
  );
}

function TaskImages({
  session,
  images,
  remove,
}: {
  session: RelaySession;
  images: readonly TaskImage[];
  remove?: ((image: TaskImage) => void) | undefined;
}) {
  return (
    <ul className={styles.images} aria-label="Images">
      {images.map((image) => {
        const [width, height] = image.dim?.split("x").map(Number) ?? [];
        return (
          <li key={image.url} className={styles.image}>
            <AttachmentImage
              compact
              session={session}
              label="Open image"
              source={session.media(image.url)}
              attachment={{
                url: image.url,
                kind: "image",
                ...(image.type ? { mime: image.type } : {}),
                ...(width && height ? { dimensions: { width, height } } : {}),
              }}
            />
            {remove ? (
              <IconButton
                size="sm"
                variant="ghost"
                aria-label="Remove image"
                icon={<XIcon size={16} aria-hidden="true" />}
                onClick={() => remove(image)}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** A linked conversation as the viewer may see it: its name when readable,
 * "Private channel" with no name when not. */
function LinkedConversation({
  session,
  channelId,
  open,
}: {
  session: RelaySession;
  channelId: string;
  open(): void;
}) {
  const reference = useChannelReference(session.channels, channelId);
  let icon: ReactNode = <HashIcon size={16} aria-hidden="true" />;
  let label = "Loading…";
  let trailing: string | undefined;
  if (reference.state === "found") {
    const solo = reference.channelType === "solo";
    icon = solo ? (
      <ChatCircleIcon size={16} aria-hidden="true" />
    ) : (
      <HashIcon size={16} aria-hidden="true" />
    );
    label = reference.name || (solo ? "Solo chat" : "Channel");
    trailing = solo ? "Solo chat" : "Channel";
  } else if (reference.state === "withheld") {
    icon = <LockIcon size={16} aria-hidden="true" />;
    label = "Private channel";
    trailing = "No access";
  }
  const readable = reference.state === "found" && reference.readable !== false;
  return (
    <NavigationItem
      icon={icon}
      label={label}
      trailing={trailing}
      disabled={!readable}
      onClick={open}
    />
  );
}

function TaskEditor({
  session,
  task,
  newLinks,
  draft: kept,
  onDraftChange,
  saving,
  save,
  onDone,
}: TaskViewProps & {
  saving: boolean;
  save(
    fields: TaskFields,
    base: Task | undefined,
    id?: string,
  ): Promise<ViewSave>;
  onDone(saved: boolean): void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<TaskFields>(
    kept?.fields ??
      (task ? fieldsOf(task) : { ...empty, links: newLinks ?? [] }),
  );
  // The revision this draft builds on; a conflict moves it to theirs.
  const [base, setBase] = useState(kept ? kept.base : task);
  // One id for a new task across retries, so a create that landed unseen
  // is found rather than made twice.
  const [taskId] = useState(() => kept?.id ?? task?.id ?? crypto.randomUUID());
  useEffect(
    () => onDraftChange?.({ fields: draft, base, id: taskId }),
    [draft, base, taskId, onDraftChange],
  );
  const [conflict, setConflict] = useState<{ theirs: Task }>();
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const update = (next: Partial<TaskFields>) =>
    setDraft((current) => ({ ...current, ...next }));
  const submit = async () => {
    setError("");
    try {
      const result = await save(draft, base, taskId);
      if (result.status === "saved") onDone(true);
      else if (result.status === "declined")
        setError(
          result.outcome === "unavailable"
            ? declined
            : "This chat wasn’t shared, so the task wasn’t saved.",
        );
      else {
        // Keep the person's text; the next Save is a deliberate overwrite.
        setConflict({ theirs: result.current });
        setBase(result.current);
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Couldn’t save the task.",
      );
    }
  };
  const upload = async (list: FileList | null) => {
    // Media access is community-wide; the tasks channel's roster need not
    // include the viewer, and saving the task is the guarded write.
    const uploadImage = session.attachments?.uploadForNewChat;
    const chosen = [...(list ?? [])].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!chosen.length) return;
    if (!uploadImage) {
      setError("Images can’t be uploaded in this community.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const uploaded = await Promise.all(
        chosen.map((file) => uploadImage(file, AbortSignal.timeout(120_000))),
      );
      setDraft((current) => ({
        ...current,
        images: [
          ...current.images,
          ...uploaded.map((item) => ({
            url: item.url,
            type: item.type,
            ...(item.dim ? { dim: item.dim } : {}),
          })),
        ],
      }));
    } catch {
      setError("Couldn’t upload the image. Try again.");
    } finally {
      setUploading(false);
      if (files.current) files.current.value = "";
    }
  };
  const busy = saving || uploading;
  return (
    <form
      className={styles.task}
      aria-label={task ? "Edit task" : "New task"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onPaste={(event) => {
        if (event.clipboardData.files.length) {
          event.preventDefault();
          void upload(event.clipboardData.files);
        }
      }}
    >
      {conflict ? (
        <div role="alert" className={styles.notice}>
          <p className="text-body-sm">
            Someone else changed this task. Your text is kept. Saving now
            replaces their version.
          </p>
          <Button
            size="sm"
            onClick={() => {
              setDraft(fieldsOf(conflict.theirs));
              setConflict(undefined);
            }}
          >
            Show their version
          </Button>
        </div>
      ) : null}
      <Field label="Title">
        <Input
          value={draft.title}
          autoFocus
          maxLength={200}
          onChange={(event) => update({ title: event.target.value })}
        />
      </Field>
      <Field
        label="Description"
        description="Markdown. Write down what you noticed and why it matters."
      >
        <Textarea
          rows={8}
          value={draft.description}
          onChange={(event) => update({ description: event.target.value })}
        />
      </Field>
      {draft.images.length > 0 && (
        <TaskImages
          session={session}
          images={draft.images}
          remove={(image) =>
            update({
              images: draft.images.filter((item) => item.url !== image.url),
            })
          }
        />
      )}
      <input
        ref={files}
        id={`${inputId}-files`}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => void upload(event.target.files)}
      />
      {error ? (
        <p role="alert" className="buzz-field-error m-0">
          {error}
        </p>
      ) : null}
      <div className={styles.actionRow}>
        <Button
          disabled={busy}
          loading={uploading}
          onClick={() => files.current?.click()}
        >
          <ImageIcon size={16} aria-hidden="true" />
          Add image
        </Button>
        <span className={styles.spacer} />
        <Button disabled={saving} onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="prominent"
          loading={saving}
          disabled={busy}
        >
          {task ? "Save" : "Create task"}
        </Button>
      </div>
    </form>
  );
}
