import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { GoogleTask, GoogleTaskList } from "@/lib/google/tasks";
import { addDays, isCalendarDate } from "@/lib/tools/dates";
import { registerTools } from "@/lib/tools";

const BASE = "https://tasks.googleapis.com/tasks/v1";

type Call = { method: string; path: string; params: URLSearchParams; body: unknown };

/** An in-memory Google Tasks that answers the REST calls the client makes. */
class FakeGoogle {
  lists: GoogleTaskList[] = [];
  tasks = new Map<string, GoogleTask[]>();
  calls: Call[] = [];
  /** When set, every request gets this status. */
  failWith?: number;
  private nextId = 1;

  addList(id: string, title: string): void {
    this.lists.push({ id, title, updated: "2026-10-01T00:00:00.000Z" });
    this.tasks.set(id, []);
  }

  addTask(listId: string, task: Partial<GoogleTask> & { id: string }): void {
    this.tasks.get(listId)?.push({ status: "needsAction", updated: "2026-10-01T00:00:00.000Z", ...task });
  }

  fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = await request.text();
    const path = decodeURIComponent(url.pathname.replace("/tasks/v1", ""));
    const call = { method: request.method, path, params: url.searchParams, body: text ? JSON.parse(text) : undefined };
    this.calls.push(call);
    expect(request.headers.get("authorization")).toBe("Bearer g-token");
    if (this.failWith) return error(this.failWith, "Failed on purpose");
    return this.route(call);
  });

  private route({ method, path, params, body }: Call): Response {
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "users") {
      if (parts.length === 3 && method === "GET") return ok({ items: this.lists });
      if (parts.length === 3 && method === "POST") {
        const list = { id: `list${this.nextId++}`, title: (body as { title: string }).title, updated: "2026-10-15T12:00:00.000Z" };
        this.addList(list.id, list.title);
        return ok(list);
      }
      const id = parts[3] === "@default" ? this.lists[0]?.id : parts[3];
      const list = this.lists.find((candidate) => candidate.id === id);
      return list ? ok(list) : error(404, "Not Found");
    }

    const listId = parts[1] === "@default" ? this.lists[0].id : parts[1];
    const tasks = this.tasks.get(listId);
    if (!tasks) return error(404, "Not Found");
    if (parts.length === 3 && method === "GET") {
      const showCompleted = params.get("showCompleted") !== "false";
      const showHidden = params.get("showHidden") === "true";
      const dueMin = params.get("dueMin");
      const dueMax = params.get("dueMax");
      return ok({
        items: tasks.filter(
          (task) =>
            (showCompleted || task.status !== "completed") &&
            (showHidden || !task.hidden) &&
            (!dueMin || (task.due !== undefined && task.due >= dueMin)) &&
            (!dueMax || (task.due !== undefined && task.due < dueMax)),
        ),
      });
    }
    if (parts.length === 3 && method === "POST") {
      const task: GoogleTask = { id: `task${this.nextId++}`, status: "needsAction", ...(body as object) };
      const parent = params.get("parent");
      if (parent) task.parent = parent;
      task.updated = "2026-10-15T12:00:00.000Z";
      tasks.push(task);
      return ok(task);
    }
    const task = tasks.find((candidate) => candidate.id === parts[3]);
    if (!task) return error(404, "Task not found");
    if (method === "GET") return ok(task);
    if (method === "DELETE") {
      tasks.splice(tasks.indexOf(task), 1);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH") {
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (value === null) delete (task as Record<string, unknown>)[key];
        else (task as Record<string, unknown>)[key] = value;
      }
      if (task.status === "completed" && !task.completed) task.completed = "2026-10-15T12:00:00.000Z";
      return ok(task);
    }
    return error(405, "Method not allowed");
  }
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function error(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), { status });
}

type Registered = {
  config: { title: string; description: string; inputSchema: z.ZodType; annotations: Record<string, boolean> };
  callback: (args: unknown, ctx: ServerContext) => Promise<CallToolResult>;
};

let google: FakeGoogle;
let tools: Map<string, Registered>;

function contextWith(googleAccessToken?: string): ServerContext {
  const extra = googleAccessToken ? { googleAccessToken, email: "owner@example.com" } : {};
  return { http: { authInfo: { token: "t", clientId: "c", scopes: ["tasks"], extra } } } as unknown as ServerContext;
}

async function callRaw(name: string, args: unknown = {}, token = "g-token"): Promise<CallToolResult> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.callback(tool.config.inputSchema.parse(args), contextWith(token));
}

async function call(name: string, args: unknown = {}): Promise<Record<string, unknown>> {
  const result = await callRaw(name, args);
  const content = result.content[0];
  if (result.isError || content.type !== "text") throw new Error(`tool failed: ${JSON.stringify(result)}`);
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function callError(name: string, args: unknown = {}): Promise<string> {
  const result = await callRaw(name, args);
  const content = result.content[0];
  expect(result.isError).toBe(true);
  return content.type === "text" ? content.text : "";
}

function callsTo(method: string, path: string): Call[] {
  return google.calls.filter((entry) => entry.method === method && entry.path === path);
}

beforeEach(() => {
  google = new FakeGoogle();
  google.addList("inbox", "My Tasks");
  google.addList("work", "Work");
  tools = new Map();
  const server = {
    registerTool: (name: string, config: Registered["config"], callback: Registered["callback"]) => {
      tools.set(name, { config, callback });
    },
  } as unknown as McpServer;
  registerTools(server, { fetch: google.fetch as unknown as typeof fetch, tasksApiUrl: BASE });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerTools", () => {
  it("registers the seven tools with their annotations", () => {
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    expect(Object.fromEntries([...tools].map(([name, tool]) => [name, tool.config.annotations]))).toEqual({
      list_task_lists: readOnly,
      list_tasks: readOnly,
      create_task: write,
      update_task: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      complete_task: { ...write, idempotentHint: true },
      delete_task: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      create_task_list: write,
    });
    for (const tool of tools.values()) {
      expect(tool.config.title.length).toBeGreaterThan(0);
      expect(tool.config.description.length).toBeGreaterThan(20);
    }
  });

  it("refuses arguments the tools don't know", () => {
    const result = tools.get("create_task")?.config.inputSchema.safeParse({ title: "x", lists: "Work" });
    expect(result?.success).toBe(false);
    expect(result?.error?.issues[0].message).toBe('Unrecognized key: "lists"');
    expect(tools.get("list_task_lists")?.config.inputSchema.safeParse({ list: "Work" }).success).toBe(false);
  });
});

describe("dates", () => {
  it("accepts real calendar dates only", () => {
    expect(isCalendarDate("2026-10-15")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-1-5")).toBe(false);
    expect(isCalendarDate("2026-10-15T00:00:00Z")).toBe(false);
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("is enforced by the input schemas", () => {
    const schema = tools.get("create_task")?.config.inputSchema;
    expect(schema?.safeParse({ title: "x", due: "2026-02-30" }).success).toBe(false);
    expect(schema?.safeParse({ title: "x", due: "next friday" }).success).toBe(false);
    expect(schema?.safeParse({ title: "x", due: "2026-02-28" }).success).toBe(true);
    const list = tools.get("list_tasks")?.config.inputSchema;
    expect(list?.safeParse({ due_before: "2026-04-31" }).success).toBe(false);
    expect(list?.safeParse({ max_results: 250 }).success).toBe(true);
    expect(list?.safeParse({ max_results: 251 }).success).toBe(false);
    expect(list?.safeParse({ max_results: 0 }).success).toBe(false);
  });
});

describe("list_task_lists", () => {
  it("returns id, title and updated for each list", async () => {
    expect(await call("list_task_lists")).toEqual({
      task_lists: [
        { id: "inbox", title: "My Tasks", updated: "2026-10-01T00:00:00.000Z" },
        { id: "work", title: "Work", updated: "2026-10-01T00:00:00.000Z" },
      ],
    });
  });
});

describe("list_tasks", () => {
  beforeEach(() => {
    google.addTask("inbox", { id: "undated", title: "Someday", position: "00000000000000000001" });
    google.addTask("inbox", { id: "late", title: "Late", due: "2026-10-20T00:00:00.000Z", position: "00000000000000000002" });
    google.addTask("inbox", { id: "soon-b", title: "Soon B", due: "2026-10-16T00:00:00.000Z", position: "00000000000000000004" });
    google.addTask("inbox", { id: "soon-a", title: "Soon A", due: "2026-10-16T00:00:00.000Z", position: "00000000000000000003" });
    google.addTask("work", { id: "work-soon", title: "Work soon", due: "2026-10-16T00:00:00.000Z", notes: "Bring the slides", position: "00000000000000000001" });
    google.addTask("work", {
      id: "done",
      title: "Done",
      status: "completed",
      completed: "2026-10-14T09:00:00.000Z",
      hidden: true,
      due: "2026-10-14T00:00:00.000Z",
    });
  });

  it("reads every list, leaves out completed tasks and sorts by due, list, then position", async () => {
    const result = await call("list_tasks");
    expect((result.tasks as { id: string }[]).map((task) => task.id)).toEqual([
      "soon-a",
      "soon-b",
      "work-soon",
      "late",
      "undated",
    ]);
    expect(result.count).toBe(5);
    expect(result.truncated).toBe(false);
    for (const listId of ["inbox", "work"]) {
      const [listCall] = callsTo("GET", `/lists/${listId}/tasks`);
      expect(listCall.params.get("showCompleted")).toBe("false");
      expect(listCall.params.has("showHidden")).toBe(false);
    }
  });

  it("returns tasks in the documented shape", async () => {
    const result = await call("list_tasks", { task_list_id: "work" });
    expect(result.tasks).toEqual([
      {
        id: "work-soon",
        task_list_id: "work",
        task_list: "Work",
        title: "Work soon",
        notes: "Bring the slides",
        due: "2026-10-16",
        status: "needsAction",
        updated: "2026-10-01T00:00:00.000Z",
      },
    ]);
    expect(callsTo("GET", "/lists/inbox/tasks")).toHaveLength(0);
  });

  it("filters due dates inclusively and leaves out undated tasks", async () => {
    const result = await call("list_tasks", { due_after: "2026-10-16", due_before: "2026-10-20" });
    expect((result.tasks as { id: string }[]).map((task) => task.id)).toEqual(["soon-a", "soon-b", "work-soon", "late"]);
    const [listCall] = callsTo("GET", "/lists/inbox/tasks");
    expect(listCall.params.get("dueMin")).toBe("2026-10-15T00:00:00.000Z");
    expect(listCall.params.get("dueMax")).toBe("2026-10-21T00:00:00.000Z");

    const onlyBefore = await call("list_tasks", { due_before: "2026-10-16" });
    expect((onlyBefore.tasks as { id: string }[]).map((task) => task.id)).toEqual(["soon-a", "soon-b", "work-soon"]);
  });

  it("includes completed and hidden tasks when asked", async () => {
    const result = await call("list_tasks", { include_completed: true });
    const tasks = result.tasks as { id: string; status: string; completed?: string }[];
    expect(tasks.at(-1)).toMatchObject({ id: "done", status: "completed", completed: "2026-10-14T09:00:00.000Z" });
    const [listCall] = callsTo("GET", "/lists/work/tasks");
    expect(listCall.params.get("showCompleted")).toBe("true");
    expect(listCall.params.get("showHidden")).toBe("true");
  });

  it("puts open tasks first and the newest completions next, so max_results drops old completions", async () => {
    google.addTask("inbox", {
      id: "done-today",
      title: "Done today",
      status: "completed",
      completed: "2026-10-15T08:00:00.000Z",
      due: "2026-10-01T00:00:00.000Z",
    });
    const result = await call("list_tasks", { include_completed: true });
    expect((result.tasks as { id: string }[]).map((task) => task.id)).toEqual([
      "soon-a",
      "soon-b",
      "work-soon",
      "late",
      "undated",
      "done-today",
      "done",
    ]);

    const capped = await call("list_tasks", { include_completed: true, max_results: 6 });
    expect((capped.tasks as { id: string }[]).at(-1)?.id).toBe("done-today");
    expect(capped.truncated).toBe(true);
  });

  it("caps the result at max_results and says so", async () => {
    const result = await call("list_tasks", { max_results: 2 });
    expect((result.tasks as { id: string }[]).map((task) => task.id)).toEqual(["soon-a", "soon-b"]);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("refuses due_after later than due_before", async () => {
    expect(await callError("list_tasks", { due_after: "2026-10-20", due_before: "2026-10-01" })).toContain("later than");
  });

  it("says when a list doesn't exist", async () => {
    expect(await callError("list_tasks", { task_list_id: "nope" })).toContain("could not find");
  });

  it("reads only the list with the given title", async () => {
    const result = await call("list_tasks", { list: "work" });
    expect((result.tasks as { id: string }[]).map((task) => task.id)).toEqual(["work-soon"]);
    expect(callsTo("GET", "/lists/inbox/tasks")).toHaveLength(0);
  });
});

describe("list by title", () => {
  it("matches the title ignoring case and outer spaces", async () => {
    const task = await call("create_task", { title: "HW 5", list: "  WORK " });
    expect(task).toMatchObject({ task_list_id: "work", task_list: "Work" });
    expect(callsTo("GET", "/users/@me/lists/@default")).toHaveLength(0);
    expect(callsTo("POST", "/lists/work/tasks")).toHaveLength(1);
  });

  it("finds the task in the named list for update, complete and delete", async () => {
    google.addTask("work", { id: "t1", title: "Report" });
    expect(await call("update_task", { task_id: "t1", list: "Work", title: "Report v2" })).toMatchObject({ title: "Report v2" });
    expect(await call("complete_task", { task_id: "t1", list: "Work" })).toMatchObject({ status: "completed" });
    expect(await call("delete_task", { task_id: "t1", list: "Work" })).toEqual({
      deleted: true,
      task_id: "t1",
      task_list_id: "work",
    });
    expect(google.calls.filter((entry) => entry.path === "/lists/inbox/tasks/t1")).toHaveLength(0);
  });

  it("refuses list and task_list_id together", async () => {
    expect(await callError("create_task", { title: "x", list: "Work", task_list_id: "work" })).toBe(
      "Pass list or task_list_id, not both.",
    );
    expect(google.calls).toHaveLength(0);
  });

  it("names the lists when no title matches", async () => {
    expect(await callError("create_task", { title: "x", list: "School" })).toBe(
      'No task list is called "School". The lists are "My Tasks" and "Work".',
    );
    expect(google.calls.filter((entry) => entry.method === "POST")).toHaveLength(0);
  });

  it("asks for task_list_id when two lists share the title", async () => {
    google.addList("work2", "work");
    expect(await callError("list_tasks", { list: "Work" })).toContain('2 task lists are called "Work"');
  });
});

describe("create_task", () => {
  it("adds to the default list and sends the due date as midnight UTC", async () => {
    const task = await call("create_task", { title: "Call Sam", notes: "About the trip", due: "2026-10-22" });
    expect(task).toMatchObject({
      task_list_id: "inbox",
      task_list: "My Tasks",
      title: "Call Sam",
      notes: "About the trip",
      due: "2026-10-22",
      status: "needsAction",
    });
    expect(callsTo("GET", "/users/@me/lists/@default")).toHaveLength(1);
    const [insert] = callsTo("POST", "/lists/inbox/tasks");
    expect(insert.body).toEqual({ title: "Call Sam", notes: "About the trip", due: "2026-10-22T00:00:00.000Z" });
    expect(insert.params.has("parent")).toBe(false);
  });

  it("creates a subtask in a named list", async () => {
    google.addTask("work", { id: "parent", title: "Launch" });
    const task = await call("create_task", { title: "Write notes", task_list_id: "work", parent_id: "parent" });
    expect(task).toMatchObject({ task_list_id: "work", task_list: "Work", parent: "parent" });
    expect(callsTo("POST", "/lists/work/tasks")[0].params.get("parent")).toBe("parent");
  });
});

describe("update_task", () => {
  beforeEach(() => {
    google.addTask("work", {
      id: "t1",
      title: "Report",
      notes: "Old notes",
      due: "2026-10-18T00:00:00.000Z",
    });
    google.addTask("work", {
      id: "t2",
      title: "Finished",
      status: "completed",
      completed: "2026-10-10T08:00:00.000Z",
    });
  });

  it("finds the task in any list, replaces notes and clears the due date", async () => {
    const task = await call("update_task", { task_id: "t1", notes: "New notes", due: null, title: "Report v2" });
    expect(task).toMatchObject({ id: "t1", task_list_id: "work", task_list: "Work", title: "Report v2", notes: "New notes" });
    expect(task).not.toHaveProperty("due");
    expect(callsTo("GET", "/lists/inbox/tasks/t1")).toHaveLength(1);
    const [patch] = callsTo("PATCH", "/lists/work/tasks/t1");
    expect(patch.body).toEqual({ title: "Report v2", notes: "New notes", due: null });
  });

  it("clears the notes when given an empty string", async () => {
    const task = await call("update_task", { task_id: "t1", task_list_id: "work", notes: "" });
    expect(task).not.toHaveProperty("notes");
    expect(callsTo("PATCH", "/lists/work/tasks/t1")[0].body).toEqual({ notes: null });
  });

  it("sets a new due date in the named list without searching", async () => {
    const task = await call("update_task", { task_id: "t1", task_list_id: "work", due: "2026-11-01" });
    expect(task.due).toBe("2026-11-01");
    expect(callsTo("GET", "/users/@me/lists")).toHaveLength(0);
    expect(callsTo("PATCH", "/lists/work/tasks/t1")[0].body).toEqual({ due: "2026-11-01T00:00:00.000Z" });
  });

  it("reopens a completed task and clears its completion time", async () => {
    const task = await call("update_task", { task_id: "t2", status: "needsAction" });
    expect(task).toMatchObject({ id: "t2", status: "needsAction" });
    expect(task).not.toHaveProperty("completed");
    expect(callsTo("PATCH", "/lists/work/tasks/t2")[0].body).toEqual({ status: "needsAction", completed: null });
  });

  it("refuses an update with nothing to change", async () => {
    expect(await callError("update_task", { task_id: "t1" })).toContain("Nothing to change");
    expect(google.calls).toHaveLength(0);
  });

  it("says when no list has the task", async () => {
    const message = await callError("update_task", { task_id: "missing", title: "x" });
    expect(message).toContain("No task with id missing");
    expect(google.calls.filter((entry) => entry.method === "PATCH")).toHaveLength(0);
  });
});

describe("complete_task", () => {
  it("marks the task completed", async () => {
    google.addTask("inbox", { id: "t1", title: "Pay rent" });
    const task = await call("complete_task", { task_id: "t1" });
    expect(task).toMatchObject({ id: "t1", status: "completed", completed: "2026-10-15T12:00:00.000Z" });
    expect(callsTo("PATCH", "/lists/inbox/tasks/t1")[0].body).toEqual({ status: "completed" });
  });
});

describe("delete_task", () => {
  it("finds and deletes the task", async () => {
    google.addTask("work", { id: "t1", title: "Old" });
    expect(await call("delete_task", { task_id: "t1" })).toEqual({ deleted: true, task_id: "t1", task_list_id: "work" });
    expect(callsTo("DELETE", "/lists/work/tasks/t1")).toHaveLength(1);
    expect(google.tasks.get("work")).toHaveLength(0);
  });

  it("deletes straight from a named list", async () => {
    google.addTask("work", { id: "t1", title: "Old" });
    expect(await call("delete_task", { task_id: "t1", task_list_id: "work" })).toEqual({
      deleted: true,
      task_id: "t1",
      task_list_id: "work",
    });
    expect(google.calls.map((entry) => entry.method)).toEqual(["DELETE"]);
  });

  it("says when the task isn't in the named list", async () => {
    expect(await callError("delete_task", { task_id: "nope", task_list_id: "work" })).toContain("could not find");
  });
});

describe("create_task_list", () => {
  it("creates the list", async () => {
    expect(await call("create_task_list", { title: "Errands" })).toEqual({
      id: "list1",
      title: "Errands",
      updated: "2026-10-15T12:00:00.000Z",
    });
    expect(callsTo("POST", "/users/@me/lists")[0].body).toEqual({ title: "Errands" });
  });
});

describe("errors", () => {
  it("tells the person to reconnect when Google answers 401", async () => {
    google.failWith = 401;
    const message = await callError("list_task_lists");
    expect(message).toContain("Reconnect the Google Tasks connector in Claude");
  });

  it("passes on other Google errors in plain words", async () => {
    google.failWith = 403;
    expect(await callError("list_task_lists")).toBe("Google Tasks refused the request (403): Failed on purpose");
    google.failWith = 500;
    expect(await callError("list_task_lists")).toContain("Try again in a moment");
  });

  it("asks for a reconnect when the request carries no Google token", async () => {
    const tool = tools.get("list_task_lists");
    const result = await tool?.callback({}, contextWith(undefined));
    expect(result?.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });

  it("uses Config.tasksApiUrl and the global fetch by default", async () => {
    const stub = vi.fn(async () => ok({ items: [{ id: "a", title: "A", updated: "u" }] }));
    vi.stubGlobal("fetch", stub);
    const defaults = new Map<string, Registered>();
    registerTools({
      registerTool: (name: string, config: Registered["config"], callback: Registered["callback"]) => {
        defaults.set(name, { config, callback });
      },
    } as unknown as McpServer);
    const result = await defaults.get("list_task_lists")?.callback({}, contextWith("g-token"));
    expect(result?.isError).toBeFalsy();
    expect(String((stub.mock.calls[0] as unknown[])[0])).toBe(`${BASE}/users/@me/lists?maxResults=100`);
  });
});
