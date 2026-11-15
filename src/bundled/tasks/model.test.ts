import { expect, it } from "vitest";
import {
  checkedFields,
  filterTasks,
  type Task,
  TASK_TYPE,
  taskContent,
  taskOf,
} from "./model";

const author = "a".repeat(64);
const editor = "b".repeat(64);
const chat = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

const revision = (content: unknown, tags: string[][] = []) => ({
  id: "e".repeat(64),
  pubkey: editor,
  sig: "",
  created_at: 10,
  kind: 45010,
  content: typeof content === "string" ? content : JSON.stringify(content),
  tags: [
    ["ar", "1"],
    ["d", "task-1"],
    ["h", "tasks"],
    ["type", TASK_TYPE],
    ["title", "Fix the header"],
    ["op", "update"],
    ...tags,
  ],
});

it("reads a revision as the task it snapshots", () => {
  const task = taskOf(
    revision({
      version: 1,
      author,
      description: "It clips.",
      status: "in_progress",
      images: [
        { url: "https://example.org/a.png", type: "image/png", dim: "10x20" },
      ],
      links: [chat, chat, other],
    }),
  );
  expect(task).toEqual({
    id: "task-1",
    title: "Fix the header",
    description: "It clips.",
    status: "in_progress",
    images: [
      { url: "https://example.org/a.png", type: "image/png", dim: "10x20" },
    ],
    links: [chat, other],
    author,
    revision: "e".repeat(64),
    editor,
    updatedAt: 10,
  });
});

it("drops what an untrusted record can't safely show", () => {
  const task = taskOf(
    revision({
      author: "not a key",
      status: "deleted",
      images: [
        { url: "http://example.org/a.png" },
        { url: "javascript:alert(1)" },
        { url: "https://example.org/b.png", type: "text/html", dim: "big" },
      ],
      links: ["general", 7, chat],
    }),
  );
  expect(task?.author).toBe(editor);
  expect(task?.status).toBe("open");
  expect(task?.images).toEqual([{ url: "https://example.org/b.png" }]);
  expect(task?.links).toEqual([chat]);
  expect(taskOf(revision("not json"))).toBeUndefined();
  expect(taskOf(revision([]))).toBeUndefined();
  expect(
    taskOf({
      ...revision({}),
      tags: [
        ["d", "x"],
        ["type", "other"],
      ],
    }),
  ).toBeUndefined();
});

it("checks fields before saving, with reasons people can act on", () => {
  const fields = {
    title: "  Fix   the header ",
    description: "",
    status: "open" as const,
    images: [],
    links: [chat, chat],
  };
  expect(checkedFields(fields)).toEqual({
    ...fields,
    title: "Fix the header",
    links: [chat],
  });
  expect(() => checkedFields({ ...fields, title: " " })).toThrow(
    "Give the task a title.",
  );
  expect(() => checkedFields({ ...fields, title: "x".repeat(201) })).toThrow(
    "under 200",
  );
  expect(JSON.parse(taskContent(fields, author))).toEqual({
    version: 1,
    author,
    description: "",
    status: "open",
    images: [],
    links: [chat, chat],
  });
});

it("filters by status and by what's mine, newest first", () => {
  const base = taskOf(revision({ author })) as Task;
  const task = (id: string, extra: Partial<Task>): Task => ({
    ...base,
    id,
    ...extra,
  });
  const tasks = [
    task("mine", { updatedAt: 1 }),
    task("linked", { author: editor, links: [chat], updatedAt: 3 }),
    task("theirs", { author: editor, updatedAt: 2 }),
    task("done", { status: "wont_do", updatedAt: 4 }),
  ];
  const ids = (filter: Parameters<typeof filterTasks>[1]) =>
    filterTasks(tasks, filter, author, new Set([chat])).map((item) => item.id);
  expect(ids({ status: "open", mine: false })).toEqual([
    "linked",
    "theirs",
    "mine",
  ]);
  expect(ids({ status: "open", mine: true })).toEqual(["linked", "mine"]);
  expect(ids({ status: "done", mine: false })).toEqual(["done"]);
});
