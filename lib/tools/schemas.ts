import { z } from "zod";
import { DATE_PATTERN, isCalendarDate } from "@/lib/tools/dates";

// Google's own limits for a task's title and notes.
const TITLE_MAX = 1024;
const NOTES_MAX = 8192;

// A full page of tasks stays well under Claude's limit of about 150,000 characters
// per tool result. A row runs about 360 to 430 characters with short notes.
const MAX_RESULTS = 250;

function date(description: string) {
  return z
    .string()
    .regex(DATE_PATTERN, { message: "Use a YYYY-MM-DD date.", abort: true })
    .refine(isCalendarDate, "Not a real calendar date.")
    .describe(description);
}

const taskId = z.string().min(1).describe("The task's id, from list_tasks or create_task.");

const findTaskListId = z
  .string()
  .min(1)
  .optional()
  .describe("The id of the list the task is in. Leave this and list out to search every list for the task.");

const list = z
  .string()
  .min(1)
  .optional()
  .describe("The list's title, in place of task_list_id. Case doesn't matter. Don't pass both.");

const title = z.string().min(1).max(TITLE_MAX);

const notes = z.string().max(NOTES_MAX);

export const listTaskListsInput = z.strictObject({});

export const listTasksInput = z.strictObject({
  task_list_id: z.string().min(1).optional().describe("Read only this list. Leave this and list out to read every list."),
  list,
  due_before: date("Only tasks whose due is on or before this date, YYYY-MM-DD.").optional(),
  due_after: date("Only tasks whose due is on or after this date, YYYY-MM-DD.").optional(),
  include_completed: z.boolean().default(false).describe("Also return completed tasks."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS)
    .default(200)
    .describe(`The most tasks to return, 1 to ${MAX_RESULTS}.`),
});

export const createTaskInput = z.strictObject({
  title: title.describe("The task's title."),
  notes: notes.optional().describe("Plain text notes."),
  due: date(
    "The task's date in Google Tasks, YYYY-MM-DD. It's the day the task should be done and the day it shows on the calendar. " +
      "A deadline that differs from it goes in notes.",
  ).optional(),
  task_list_id: z
    .string()
    .min(1)
    .optional()
    .describe('The list to add the task to. Leave this and list out, or pass "@default", for the person\'s default list.'),
  list,
  parent_id: z.string().min(1).optional().describe("Make this a subtask of the task with this id, in the same list."),
});

export const updateTaskInput = z.strictObject({
  task_id: taskId,
  task_list_id: findTaskListId,
  list,
  title: title.optional().describe("The new title."),
  notes: notes
    .optional()
    .describe("New notes. Replaces the whole notes field, so include anything to keep; an empty string clears it."),
  due: date("The task's new date, YYYY-MM-DD.")
    .nullable()
    .optional()
    .describe("The task's new date, YYYY-MM-DD, or null to remove it."),
  status: z
    .enum(["needsAction", "completed"])
    .optional()
    .describe('"completed" marks the task done; "needsAction" reopens it.'),
});

export const completeTaskInput = z.strictObject({
  task_id: taskId,
  task_list_id: findTaskListId,
  list,
});

export const deleteTaskInput = z.strictObject({
  task_id: taskId,
  task_list_id: findTaskListId,
  list,
});

export const createTaskListInput = z.strictObject({
  title: title.describe("The new list's title."),
});

export type ListTasksArgs = z.output<typeof listTasksInput>;
export type CreateTaskArgs = z.output<typeof createTaskInput>;
export type UpdateTaskArgs = z.output<typeof updateTaskInput>;
export type CompleteTaskArgs = z.output<typeof completeTaskInput>;
export type DeleteTaskArgs = z.output<typeof deleteTaskInput>;
export type CreateTaskListArgs = z.output<typeof createTaskListInput>;
