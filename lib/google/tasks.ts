/**
 * A small client for the Google Tasks REST API (v1). It speaks Google's own
 * field names; lib/tools turns them into what the MCP tools return.
 */

export type TaskStatus = "needsAction" | "completed";

export type GoogleTaskList = {
  id: string;
  title: string;
  updated?: string;
};

export type GoogleTask = {
  id: string;
  title?: string;
  notes?: string;
  status?: TaskStatus;
  /** RFC 3339, always midnight UTC: the API keeps the date and drops the time. */
  due?: string;
  completed?: string;
  parent?: string;
  position?: string;
  updated?: string;
  webViewLink?: string;
  deleted?: boolean;
  hidden?: boolean;
};

/** Writable task fields. On a patch, null clears a field and a missing key leaves it alone. */
export type TaskFields = {
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  due?: string | null;
  completed?: string | null;
};

export type ListTasksOptions = {
  showCompleted?: boolean;
  showHidden?: boolean;
  /** RFC 3339 timestamps. */
  dueMin?: string;
  dueMax?: string;
  /** Stop after this many pages of 100 tasks. */
  maxPages?: number;
};

export type ListTasksResult = {
  items: GoogleTask[];
  /** False when maxPages ran out before the last page. */
  complete: boolean;
};

export class TasksApiError extends Error {
  /** The HTTP status Google answered with, or 502/504 when it couldn't be reached. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TasksApiError";
    this.status = status;
  }
}

export type TasksClientOptions = {
  accessToken: string;
  /** Config.tasksApiUrl, e.g. https://tasks.googleapis.com/tasks/v1 */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type Query = Record<string, string | number | boolean | undefined>;

// Google's per-page maximum for tasks.list. tasklists.list allows up to 1000, but 100 is plenty.
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_TIMEOUT_MS = 15_000;

export class TasksClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: TasksClientOptions) {
    this.accessToken = options.accessToken;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    // Looked up on every call so tests can stub the global after construction.
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listTaskLists(): Promise<GoogleTaskList[]> {
    const lists: GoogleTaskList[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < DEFAULT_MAX_PAGES; page++) {
      const body = await this.request<{ items?: GoogleTaskList[]; nextPageToken?: string }>(
        "GET",
        "/users/@me/lists",
        { query: { maxResults: PAGE_SIZE, pageToken } },
      );
      lists.push(...(body.items ?? []));
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    return lists;
  }

  /** Accepts "@default" and answers with the list's real id. */
  getTaskList(taskListId: string): Promise<GoogleTaskList> {
    return this.request("GET", `/users/@me/lists/${segment(taskListId)}`);
  }

  insertTaskList(title: string): Promise<GoogleTaskList> {
    return this.request("POST", "/users/@me/lists", { body: { title } });
  }

  async listTasks(taskListId: string, options: ListTasksOptions = {}): Promise<ListTasksResult> {
    const items: GoogleTask[] = [];
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.request<{ items?: GoogleTask[]; nextPageToken?: string }>(
        "GET",
        `/lists/${segment(taskListId)}/tasks`,
        {
          query: {
            maxResults: PAGE_SIZE,
            // Google returns completed tasks unless told not to, so the flag is always sent.
            showCompleted: options.showCompleted ?? false,
            showHidden: options.showHidden,
            // Google leaves out tasks assigned from Docs or Chat unless asked.
            showAssigned: true,
            dueMin: options.dueMin,
            dueMax: options.dueMax,
            pageToken,
          },
        },
      );
      items.push(...(body.items ?? []));
      pageToken = body.nextPageToken;
      if (!pageToken) return { items, complete: true };
    }
    return { items, complete: false };
  }

  getTask(taskListId: string, taskId: string): Promise<GoogleTask> {
    return this.request("GET", `/lists/${segment(taskListId)}/tasks/${segment(taskId)}`);
  }

  insertTask(taskListId: string, fields: TaskFields, options: { parent?: string } = {}): Promise<GoogleTask> {
    return this.request("POST", `/lists/${segment(taskListId)}/tasks`, {
      query: { parent: options.parent },
      body: fields,
    });
  }

  patchTask(taskListId: string, taskId: string, fields: TaskFields): Promise<GoogleTask> {
    return this.request("PATCH", `/lists/${segment(taskListId)}/tasks/${segment(taskId)}`, { body: fields });
  }

  async deleteTask(taskListId: string, taskId: string): Promise<void> {
    await this.request<void>("DELETE", `/lists/${segment(taskListId)}/tasks/${segment(taskId)}`);
  }

  private async request<T>(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new TasksApiError(504, `Google Tasks did not answer within ${this.timeoutMs / 1000} seconds.`);
      }
      throw new TasksApiError(502, `Could not reach Google Tasks: ${error instanceof Error ? error.message : String(error)}`);
    }

    const text = await response.text();
    if (!response.ok) throw new TasksApiError(response.status, googleMessage(text, response));
    if (response.status === 204 || text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TasksApiError(502, "Google Tasks sent a response that isn't JSON.");
    }
  }
}

/** Encodes an id for a URL path. "@" is legal in a path segment and keeps "@default" readable. */
function segment(id: string): string {
  return encodeURIComponent(id).replace(/%40/g, "@");
}

/** Google's errors look like { error: { code, message, status } }; OAuth failures carry a string. */
function googleMessage(text: string, response: Response): string {
  let message: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    if (body.error && typeof body.error === "object" && "message" in body.error) {
      const inner = (body.error as { message?: unknown }).message;
      if (typeof inner === "string") message = inner;
    } else if (typeof body.error_description === "string") {
      message = body.error_description;
    } else if (typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    // Not JSON, so fall through to the status line.
  }
  message = message?.trim() || response.statusText || `HTTP ${response.status}`;
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}
