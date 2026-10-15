import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/lib/config";
import { TasksApiError, TasksClient } from "@/lib/google/tasks";

type Call = { method: string; url: URL; headers: Headers; body: unknown };

const BASE = "https://tasks.googleapis.com/tasks/v1";

/** A fetch that records each request and answers from `respond`. */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const call = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    return respond(call);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function client(fetchFn: typeof fetch, timeoutMs?: number): TasksClient {
  return new TasksClient({ accessToken: "g-token", baseUrl: BASE, fetch: fetchFn, timeoutMs });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TasksClient", () => {
  it("defaults to the base URL in Config.tasksApiUrl", () => {
    const loaded = loadConfig();
    expect(loaded.ok && loaded.config.tasksApiUrl).toBe(BASE);
  });

  it("pages through task lists with the bearer token", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.searchParams.get("pageToken")
        ? json({ items: [{ id: "b", title: "B" }] })
        : json({ items: [{ id: "a", title: "A" }], nextPageToken: "next" }),
    );
    const lists = await client(fetch).listTaskLists();
    expect(lists.map((list) => list.id)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(`${BASE}/users/@me/lists`);
    expect(calls[0].url.searchParams.get("maxResults")).toBe("100");
    expect(calls[0].headers.get("authorization")).toBe("Bearer g-token");
    expect(calls[1].url.searchParams.get("pageToken")).toBe("next");
  });

  it("gets one task list, keeping @default readable in the path", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: "real", title: "My Tasks" }));
    const list = await client(fetch).getTaskList("@default");
    expect(list).toEqual({ id: "real", title: "My Tasks" });
    expect(calls[0].url.pathname).toBe("/tasks/v1/users/@me/lists/@default");
  });

  it("creates a task list", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: "new", title: "Errands", updated: "2026-10-15T12:00:00.000Z" }));
    await client(fetch).insertTaskList("Errands");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/tasks/v1/users/@me/lists");
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(calls[0].body).toEqual({ title: "Errands" });
  });

  it("lists tasks without completed ones unless asked", async () => {
    const { fetch, calls } = fakeFetch(() => json({ items: [{ id: "t1" }] }));
    const result = await client(fetch).listTasks("list 1");
    expect(result).toEqual({ items: [{ id: "t1" }], complete: true });
    expect(calls[0].url.pathname).toBe("/tasks/v1/lists/list%201/tasks");
    const params = calls[0].url.searchParams;
    expect(params.get("showCompleted")).toBe("false");
    expect(params.has("showHidden")).toBe(false);
    expect(params.get("showAssigned")).toBe("true");
    expect(params.has("dueMin")).toBe(false);
    expect(params.has("dueMax")).toBe(false);
  });

  it("passes showCompleted, showHidden, dueMin and dueMax, and pages", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.searchParams.get("pageToken") === "p2"
        ? json({ items: [{ id: "t2" }] })
        : json({ items: [{ id: "t1" }], nextPageToken: "p2" }),
    );
    const result = await client(fetch).listTasks("l1", {
      showCompleted: true,
      showHidden: true,
      dueMin: "2026-10-01T00:00:00.000Z",
      dueMax: "2026-10-31T00:00:00.000Z",
    });
    expect(result.items.map((task) => task.id)).toEqual(["t1", "t2"]);
    expect(result.complete).toBe(true);
    const params = calls[0].url.searchParams;
    expect(params.get("showCompleted")).toBe("true");
    expect(params.get("showHidden")).toBe("true");
    expect(params.get("dueMin")).toBe("2026-10-01T00:00:00.000Z");
    expect(params.get("dueMax")).toBe("2026-10-31T00:00:00.000Z");
    expect(params.get("maxResults")).toBe("100");
    expect(calls[1].url.searchParams.get("dueMin")).toBe("2026-10-01T00:00:00.000Z");
  });

  it("stops after maxPages and says the result is incomplete", async () => {
    let page = 0;
    const { fetch, calls } = fakeFetch(() => json({ items: [{ id: `t${page}` }], nextPageToken: `p${++page}` }));
    const result = await client(fetch).listTasks("l1", { maxPages: 3 });
    expect(calls).toHaveLength(3);
    expect(result.items).toHaveLength(3);
    expect(result.complete).toBe(false);
  });

  it("gets a task", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: "t/1", title: "x" }));
    await client(fetch).getTask("l1", "t/1");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/tasks/v1/lists/l1/tasks/t%2F1");
  });

  it("inserts a task, with a parent when given", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: "t1" }));
    await client(fetch).insertTask("l1", { title: "Sub", due: "2026-10-20T00:00:00.000Z" }, { parent: "p1" });
    await client(fetch).insertTask("l1", { title: "Top" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/tasks/v1/lists/l1/tasks");
    expect(calls[0].url.searchParams.get("parent")).toBe("p1");
    expect(calls[0].body).toEqual({ title: "Sub", due: "2026-10-20T00:00:00.000Z" });
    expect(calls[1].url.searchParams.has("parent")).toBe(false);
  });

  it("patches a task and sends null to clear fields", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: "t1" }));
    await client(fetch).patchTask("l1", "t1", { status: "needsAction", completed: null, due: null });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url.pathname).toBe("/tasks/v1/lists/l1/tasks/t1");
    expect(calls[0].body).toEqual({ status: "needsAction", completed: null, due: null });
  });

  it("deletes a task and accepts an empty 204", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await expect(client(fetch).deleteTask("l1", "t1")).resolves.toBeUndefined();
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url.pathname).toBe("/tasks/v1/lists/l1/tasks/t1");
  });

  it("uses the global fetch when none is injected", async () => {
    const { fetch, calls } = fakeFetch(() => json({ items: [] }));
    vi.stubGlobal("fetch", fetch);
    await new TasksClient({ accessToken: "g", baseUrl: `${BASE}/` }).listTaskLists();
    expect(calls[0].url.toString()).toBe(`${BASE}/users/@me/lists?maxResults=100`);
  });

  it("turns Google's error body into a TasksApiError", async () => {
    const { fetch } = fakeFetch(() => json({ error: { code: 404, message: "Task not found.", status: "NOT_FOUND" } }, 404));
    const error = await client(fetch).getTask("l1", "t1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TasksApiError);
    expect(error).toMatchObject({ status: 404, message: "Task not found." });
  });

  it("reads OAuth-style errors and bodies that aren't JSON", async () => {
    const oauth = fakeFetch(() => json({ error: "invalid_token", error_description: "Token expired" }, 401));
    await expect(client(oauth.fetch).listTaskLists()).rejects.toMatchObject({ status: 401, message: "Token expired" });

    const html = fakeFetch(() => new Response("<html>oops</html>", { status: 503, statusText: "Service Unavailable" }));
    await expect(client(html.fetch).listTaskLists()).rejects.toMatchObject({
      status: 503,
      message: "Service Unavailable",
    });
  });

  it("reports a network failure as a 502", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(client(fetchFn).listTaskLists()).rejects.toMatchObject({
      name: "TasksApiError",
      status: 502,
      message: "Could not reach Google Tasks: fetch failed",
    });
  });

  it("gives up on a slow answer with a 504", async () => {
    const fetchFn = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    await expect(client(fetchFn, 20).listTaskLists()).rejects.toMatchObject({ status: 504 });
  });

  it("refuses a success body that isn't JSON", async () => {
    const { fetch } = fakeFetch(() => new Response("not json", { status: 200 }));
    await expect(client(fetch).listTaskLists()).rejects.toMatchObject({ status: 502 });
  });
});
