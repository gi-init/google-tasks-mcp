import type { CallToolResult, McpServer, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import { loadConfig } from "@/lib/config";
import { TasksApiError, TasksClient } from "@/lib/google/tasks";
import { describeError, RECONNECT_MESSAGE, ToolError } from "@/lib/tools/errors";
import {
  completeTask,
  createTask,
  createTaskList,
  deleteTask,
  listTaskLists,
  listTasks,
  updateTask,
} from "@/lib/tools/handlers";
import {
  completeTaskInput,
  createTaskInput,
  createTaskListInput,
  deleteTaskInput,
  listTaskListsInput,
  listTasksInput,
  updateTaskInput,
} from "@/lib/tools/schemas";

export type RegisterToolsOptions = {
  /** Defaults to Config.tasksApiUrl. */
  tasksApiUrl?: string;
  fetch?: typeof fetch;
};

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export function registerTools(server: McpServer, options: RegisterToolsOptions = {}): void {
  const run = (ctx: ServerContext, operation: (client: TasksClient) => Promise<unknown>) =>
    runTool(ctx, options, operation);

  server.registerTool(
    "list_task_lists",
    {
      title: "List task lists",
      description:
        "List the person's Google Tasks lists. Returns each list's id, title and when it last changed. " +
        "Use an id as task_list_id, or a title as list, in the other tools.",
      inputSchema: listTaskListsInput,
      annotations: READ_ONLY,
    },
    (_args, ctx) => run(ctx, (client) => listTaskLists(client)),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List tasks from one list, or from every list when task_list_id and list are left out. " +
        "Completed tasks are left out unless include_completed is true. " +
        "due_after and due_before are inclusive YYYY-MM-DD bounds on due; when either is given, undated tasks are left out. " +
        "Open tasks come first, sorted by due (undated last), then list title, then position in the list. " +
        "Completed tasks come after them, most recently completed first. " +
        "At most max_results tasks come back, and truncated is true when more matched.",
      inputSchema: listTasksInput,
      annotations: READ_ONLY,
    },
    (args, ctx) => run(ctx, (client) => listTasks(client, args)),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task and return it. It goes in the default list unless task_list_id or list is given. " +
        "due is the task's date in Google Tasks (YYYY-MM-DD), the day it should be done and the day it shows on the calendar. " +
        "Google Tasks keeps no time of day. The separate deadline set in the Tasks app can't be read or set through the API, " +
        "so a deadline that differs from the date goes in the notes. " +
        "parent_id makes it a subtask of another task in the same list.",
      inputSchema: createTaskInput,
      annotations: WRITE,
    },
    (args, ctx) => run(ctx, (client) => createTask(client, args)),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Change a task's title, notes, date (due) or status, and return the updated task. Fields you leave out stay as they are. " +
        "notes replaces the whole notes field, so include any existing notes you want to keep. " +
        "due is the task's date in Google Tasks (YYYY-MM-DD), or null to remove it. status needsAction reopens a completed task. " +
        "Without task_list_id or list, every list is searched for the task.",
      inputSchema: updateTaskInput,
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    (args, ctx) => run(ctx, (client) => updateTask(client, args)),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description:
        "Mark a task as completed and return it. Without task_list_id or list, every list is searched for the task.",
      inputSchema: completeTaskInput,
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args, ctx) => run(ctx, (client) => completeTask(client, args)),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
      description:
        "Delete a task for good. To mark a task done, use complete_task instead. " +
        "Deleting a task assigned from Google Docs or Chat also deletes it there. " +
        "Without task_list_id or list, every list is searched for the task.",
      inputSchema: deleteTaskInput,
      annotations: DESTRUCTIVE,
    },
    (args, ctx) => run(ctx, (client) => deleteTask(client, args)),
  );

  server.registerTool(
    "create_task_list",
    {
      title: "Create task list",
      description: "Create a new task list and return its id, title and when it was made.",
      inputSchema: createTaskListInput,
      annotations: WRITE,
    },
    (args, ctx) => run(ctx, (client) => createTaskList(client, args)),
  );
}

async function runTool(
  ctx: ServerContext,
  options: RegisterToolsOptions,
  operation: (client: TasksClient) => Promise<unknown>,
): Promise<CallToolResult> {
  // withMcpAuth put the verified access token's contents here (lib/mcp-auth.ts).
  const accessToken = ctx.http?.authInfo?.extra?.googleAccessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) return toolError(RECONNECT_MESSAGE);

  let tasksApiUrl = options.tasksApiUrl;
  if (!tasksApiUrl) {
    const loaded = loadConfig();
    if (!loaded.ok) return toolError(`The server is missing settings: ${loaded.missing.join(", ")}.`);
    tasksApiUrl = loaded.config.tasksApiUrl;
  }

  try {
    const result = await operation(new TasksClient({ accessToken, baseUrl: tasksApiUrl, fetch: options.fetch }));
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    if (!(error instanceof ToolError) && !(error instanceof TasksApiError)) {
      console.error("Tool failed:", error);
    }
    return toolError(describeError(error));
  }
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
