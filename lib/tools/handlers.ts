/** What each tool does, given a Tasks client and its parsed arguments. */
import {
  TasksApiError,
  type GoogleTask,
  type GoogleTaskList,
  type TaskFields,
  type TaskStatus,
  type TasksClient,
} from "@/lib/google/tasks";
import { addDays, fromGoogleDue, toGoogleDue } from "@/lib/tools/dates";
import { ToolError } from "@/lib/tools/errors";
import type {
  CompleteTaskArgs,
  CreateTaskArgs,
  CreateTaskListArgs,
  DeleteTaskArgs,
  ListTasksArgs,
  UpdateTaskArgs,
} from "@/lib/tools/schemas";

export type Task = {
  id: string;
  task_list_id: string;
  task_list: string;
  title: string;
  notes?: string;
  due?: string;
  status: TaskStatus;
  completed?: string;
  parent?: string;
  web_view_link?: string;
  updated?: string;
};

export type TaskListSummary = { id: string; title: string; updated?: string };

type ListRef = { id: string; title: string };

/** The two ways a tool can be told which list to use. */
type ListChoice = { task_list_id?: string; list?: string };

export function toTask(task: GoogleTask, list: ListRef): Task {
  const out: Task = {
    id: task.id,
    task_list_id: list.id,
    task_list: list.title,
    title: task.title ?? "",
    status: task.status ?? "needsAction",
  };
  if (task.notes) out.notes = task.notes;
  if (task.due) out.due = fromGoogleDue(task.due);
  if (task.completed) out.completed = task.completed;
  if (task.parent) out.parent = task.parent;
  if (task.webViewLink) out.web_view_link = task.webViewLink;
  if (task.updated) out.updated = task.updated;
  return out;
}

function summarize(list: GoogleTaskList): TaskListSummary {
  return { id: list.id, title: list.title, updated: list.updated };
}

export async function listTaskLists(client: TasksClient): Promise<{ task_lists: TaskListSummary[] }> {
  const lists = await client.listTaskLists();
  return { task_lists: lists.map(summarize) };
}

export async function createTaskList(client: TasksClient, args: CreateTaskListArgs): Promise<TaskListSummary> {
  return summarize(await client.insertTaskList(args.title));
}

export async function listTasks(
  client: TasksClient,
  args: ListTasksArgs,
): Promise<{ tasks: Task[]; count: number; truncated: boolean }> {
  const { due_after: after, due_before: before } = args;
  if (after && before && after > before) {
    throw new ToolError(`due_after (${after}) is later than due_before (${before}), so no task can match.`);
  }

  const taskListId = await listId(client, args);
  const lists = taskListId ? [await client.getTaskList(taskListId)] : await client.listTaskLists();
  const pages = await Promise.all(
    lists.map((list) =>
      client.listTasks(list.id, {
        showCompleted: args.include_completed,
        showHidden: args.include_completed || undefined,
        // Padded a day each way so Google's bound never drops a match whether it
        // is inclusive or not; the exact, inclusive filter runs below.
        dueMin: after ? toGoogleDue(addDays(after, -1)) : undefined,
        dueMax: before ? toGoogleDue(addDays(before, 1)) : undefined,
      }),
    ),
  );

  const matched = pages
    .flatMap((page, index) => page.items.map((task) => ({ task, list: lists[index] })))
    .filter(({ task }) => {
      if (task.deleted) return false;
      if (!args.include_completed && task.status === "completed") return false;
      if (!after && !before) return true;
      if (!task.due) return false;
      const due = fromGoogleDue(task.due);
      return (!after || due >= after) && (!before || due <= before);
    })
    .sort(compareRows);

  const tasks = matched.slice(0, args.max_results).map(({ task, list }) => toTask(task, list));
  const truncated = matched.length > tasks.length || pages.some((page) => !page.complete);
  return { tasks, count: tasks.length, truncated };
}

export async function createTask(client: TasksClient, args: CreateTaskArgs): Promise<Task> {
  // Resolves "@default" to the real list, so the result names it.
  const list = await client.getTaskList((await listId(client, args)) ?? "@default");
  const fields: TaskFields = { title: args.title };
  if (args.notes) fields.notes = args.notes;
  if (args.due !== undefined) fields.due = toGoogleDue(args.due);
  const task = await client.insertTask(list.id, fields, { parent: args.parent_id });
  return toTask(task, list);
}

export async function updateTask(client: TasksClient, args: UpdateTaskArgs): Promise<Task> {
  const fields: TaskFields = {};
  if (args.title !== undefined) fields.title = args.title;
  if (args.notes !== undefined) fields.notes = args.notes === "" ? null : args.notes;
  if (args.due !== undefined) fields.due = args.due === null ? null : toGoogleDue(args.due);
  if (args.status === "completed") fields.status = "completed";
  if (args.status === "needsAction") {
    // Clearing completed too, so a reopened task carries no stale completion time.
    fields.status = "needsAction";
    fields.completed = null;
  }
  if (Object.keys(fields).length === 0) {
    throw new ToolError("Nothing to change. Pass at least one of title, notes, due or status.");
  }
  return patch(client, args, fields);
}

export async function completeTask(client: TasksClient, args: CompleteTaskArgs): Promise<Task> {
  return patch(client, args, { status: "completed" });
}

export async function deleteTask(
  client: TasksClient,
  args: DeleteTaskArgs,
): Promise<{ deleted: true; task_id: string; task_list_id: string }> {
  const taskListId = (await listId(client, args)) ?? (await findTask(client, args.task_id)).list.id;
  await client.deleteTask(taskListId, args.task_id);
  return { deleted: true, task_id: args.task_id, task_list_id: taskListId };
}

async function patch(client: TasksClient, args: ListChoice & { task_id: string }, fields: TaskFields): Promise<Task> {
  // The list is looked up before anything changes, so a failed lookup leaves the task alone.
  const taskListId = await listId(client, args);
  const list = taskListId ? await client.getTaskList(taskListId) : (await findTask(client, args.task_id)).list;
  const task = await client.patchTask(list.id, args.task_id, fields);
  return toTask(task, list);
}

/** task_list_id as given, or the id of the list whose title is `list`. */
async function listId(client: TasksClient, args: ListChoice): Promise<string | undefined> {
  if (args.list === undefined) return args.task_list_id;
  if (args.task_list_id !== undefined) throw new ToolError("Pass list or task_list_id, not both.");
  const wanted = args.list.trim().toLowerCase();
  const lists = await client.listTaskLists();
  const matches = lists.filter((list) => list.title.trim().toLowerCase() === wanted);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new ToolError(
      `${matches.length} task lists are called "${args.list}", so pass task_list_id instead. list_task_lists shows their ids.`,
    );
  }
  const titles = new Intl.ListFormat("en").format(lists.map((list) => `"${list.title}"`));
  const known = lists.length === 1 ? `The only list is ${titles}.` : `The lists are ${titles}.`;
  throw new ToolError(`No task list is called "${args.list}". ${known}`);
}

/** Looks through each list in turn for a task when the caller didn't say which list it is in. */
async function findTask(client: TasksClient, taskId: string): Promise<{ list: GoogleTaskList; task: GoogleTask }> {
  const lists = await client.listTaskLists();
  for (const list of lists) {
    try {
      const task = await client.getTask(list.id, taskId);
      if (!task.deleted) return { list, task };
    } catch (error) {
      // Google answers 404, or 400 for some ids, when the task is in another list.
      if (error instanceof TasksApiError && (error.status === 404 || error.status === 400)) continue;
      throw error;
    }
  }
  throw new ToolError(
    `No task with id ${taskId} is in any of the ${lists.length} task lists. list_tasks shows the current ids.`,
  );
}

/**
 * Open tasks by due date (undated last), then completed tasks, newest completion first.
 * Ties go by list title, then position in the list.
 */
function compareRows(a: { task: GoogleTask; list: ListRef }, b: { task: GoogleTask; list: ListRef }): number {
  const aDone = a.task.status === "completed";
  const bDone = b.task.status === "completed";
  return (
    Number(aDone) - Number(bDone) ||
    (aDone ? compareRaw(b.task.completed ?? "", a.task.completed ?? "") : compareDue(a.task, b.task)) ||
    compareText(a.list.title, b.list.title) ||
    compareRaw(a.list.id, b.list.id) ||
    compareRaw(a.task.position ?? "", b.task.position ?? "")
  );
}

function compareDue(a: GoogleTask, b: GoogleTask): number {
  if (a.due && b.due) return compareRaw(fromGoogleDue(a.due), fromGoogleDue(b.due));
  if (a.due) return -1;
  if (b.due) return 1;
  return 0;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

function compareRaw(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
