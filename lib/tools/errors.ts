import { TasksApiError } from "@/lib/google/tasks";

/** A problem with what the tool was asked to do. Its message goes to Claude as written. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export const RECONNECT_MESSAGE =
  "Google no longer accepts this connector's access to Google Tasks. " +
  "Reconnect the Google Tasks connector in Claude (Customize, then Connectors) and try again.";

/** The plain message a tool error carries back to Claude. */
export function describeError(error: unknown): string {
  if (error instanceof ToolError) return error.message;
  if (error instanceof TasksApiError) {
    switch (error.status) {
      case 401:
        return RECONNECT_MESSAGE;
      case 404:
        return "Google Tasks could not find that task or task list. list_task_lists and list_tasks show the current ids.";
      case 429:
        return "Google Tasks is limiting requests right now. Wait a minute and try again.";
      default:
        if (error.status >= 500) {
          return `Google Tasks is not answering properly right now (${error.status}: ${error.message}). Try again in a moment.`;
        }
        return `Google Tasks refused the request (${error.status}): ${error.message}`;
    }
  }
  return "Something went wrong on the Google Tasks connector's server. Try again in a moment.";
}
