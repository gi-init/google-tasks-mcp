import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "@/app/mcp/route";
import { deriveKey, loadConfig } from "@/lib/config";
import { seal, type SealedType } from "@/lib/crypto";

const ORIGIN = "https://tasks.example.com";
const MCP_URL = `${ORIGIN}/mcp`;
const METADATA = `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`;

function tokenKey(): Uint8Array {
  const loaded = loadConfig();
  if (!loaded.ok) throw new Error("test settings are missing");
  return loaded.config.tokenKey;
}

function accessToken(
  overrides: Record<string, unknown> = {},
  options: { ttl?: number; type?: SealedType; key?: Uint8Array } = {},
): Promise<string> {
  return seal(
    options.type ?? "access",
    {
      client_id: "https://claude.ai/oauth/claude-code-client-metadata",
      scope: "tasks",
      resource: MCP_URL,
      sub: "google-sub-1",
      email: "owner@example.com",
      g_access: "g-token",
      ...overrides,
    },
    options.key ?? tokenKey(),
    options.ttl ?? 3000,
  );
}

const handlers: Record<string, (req: Request) => Promise<Response>> = {
  GET: route.GET,
  POST: route.POST,
  DELETE: route.DELETE,
};

/** Sends the MCP client's requests straight to the route's exported handlers. */
async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin + url.pathname !== MCP_URL) throw new Error(`unexpected request to ${request.url}`);
  const handler = handlers[request.method];
  return handler ? handler(request) : new Response(null, { status: 405 });
}

function initializeRequest(headers: Record<string, string> = {}): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    }),
  });
}

async function expectChallenge(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  const challenge = response.headers.get("www-authenticate") ?? "";
  expect(challenge).toMatch(/^Bearer /);
  expect(challenge).toContain(METADATA);
}

type GoogleCall = { method: string; path: string; params: URLSearchParams; body: unknown; auth: string | null };

let googleCalls: GoogleCall[];
let googleResponses: Record<string, unknown>;

/** Stubs Google's Tasks API: answers "METHOD /path" from googleResponses and records each call. */
function stubGoogle(): void {
  googleCalls = [];
  googleResponses = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== "https://tasks.googleapis.com") throw new Error(`unexpected request to ${request.url}`);
      const path = decodeURIComponent(url.pathname.replace("/tasks/v1", ""));
      const text = await request.text();
      googleCalls.push({
        method: request.method,
        path,
        params: url.searchParams,
        body: text ? JSON.parse(text) : undefined,
        auth: request.headers.get("authorization"),
      });
      const key = `${request.method} ${path}`;
      if (!(key in googleResponses)) {
        return new Response(JSON.stringify({ error: { code: 404, message: "Not Found" } }), { status: 404 });
      }
      const body = googleResponses[key];
      if (body instanceof Response) return body;
      if (body === null) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

async function connect(token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: routeFetch,
    requestInit: { headers: { Authorization: `Bearer ${token ?? (await accessToken())}` } },
  });
  const client = new Client({ name: "compat-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function resultJson(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = (result.content as { type: string; text: string }[])[0];
  expect(content.type).toBe("text");
  return JSON.parse(content.text);
}

beforeEach(() => {
  stubGoogle();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/mcp authentication", () => {
  it("answers 401 with a resource_metadata challenge when there is no token", async () => {
    await expectChallenge(await route.POST(initializeRequest()));
    await expectChallenge(await route.GET(new Request(MCP_URL)));
    await expectChallenge(await route.DELETE(new Request(MCP_URL, { method: "DELETE" })));
  });

  it("refuses a forged token", async () => {
    await expectChallenge(await route.POST(initializeRequest({ Authorization: "Bearer not-a-token" })));
    const otherKey = await accessToken({}, { key: deriveKey("some other secret") });
    await expectChallenge(await route.POST(initializeRequest({ Authorization: `Bearer ${otherKey}` })));
  });

  it("refuses an expired token", async () => {
    const expired = await accessToken({}, { ttl: -60 });
    await expectChallenge(await route.POST(initializeRequest({ Authorization: `Bearer ${expired}` })));
  });

  it("refuses a token for another resource", async () => {
    const other = await accessToken({ resource: "https://elsewhere.example.com/mcp" });
    await expectChallenge(await route.POST(initializeRequest({ Authorization: `Bearer ${other}` })));
  });

  it("refuses other kinds of sealed blob", async () => {
    const refresh = await accessToken({ g_refresh: "r" }, { type: "refresh" });
    await expectChallenge(await route.POST(initializeRequest({ Authorization: `Bearer ${refresh}` })));
  });

  it("refuses a token whose email is no longer allowed", async () => {
    const removed = await accessToken({ email: "someone@example.com" });
    await expectChallenge(await route.POST(initializeRequest({ Authorization: `Bearer ${removed}` })));
  });

  it("answers 401 while required settings are missing", async () => {
    const token = await accessToken();
    const saved = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      await expectChallenge(await route.POST(initializeRequest({ Authorization: `Bearer ${token}` })));
    } finally {
      process.env.GOOGLE_CLIENT_ID = saved;
    }
  });

  it("uses the request's host when PUBLIC_URL isn't set", async () => {
    const saved = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    try {
      const request = new Request("http://internal:3000/mcp", {
        method: "POST",
        headers: { "x-forwarded-host": "tasks.other.dev", "x-forwarded-proto": "https" },
      });
      const response = await route.POST(request);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        'resource_metadata="https://tasks.other.dev/.well-known/oauth-protected-resource/mcp"',
      );

      const token = await accessToken({ resource: "https://tasks.other.dev/mcp" });
      const accepted = await route.POST(
        new Request("http://internal:3000/mcp", {
          method: "POST",
          headers: {
            "x-forwarded-host": "tasks.other.dev",
            "x-forwarded-proto": "https",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: initializeRequest().body,
          duplex: "half",
        } as RequestInit),
      );
      expect(accepted.status).toBe(200);
    } finally {
      process.env.PUBLIC_URL = saved;
    }
  });

  it("accepts a valid token", async () => {
    const response = await route.POST(initializeRequest({ Authorization: `Bearer ${await accessToken()}` }));
    expect(response.status).toBe(200);
  });

  it("exports maxDuration 60", () => {
    expect(route.maxDuration).toBe(60);
  });
});

describe("/mcp tools", () => {
  it("initializes and reports the server's name, version and instructions", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: routeFetch,
      requestInit: { headers: { Authorization: `Bearer ${await accessToken()}` } },
    });
    const client = new Client({ name: "compat-test", version: "1.0.0" });
    await client.connect(transport);
    expect(transport.protocolVersion).toMatch(/^2025-/);
    expect(client.getServerVersion()).toEqual({ name: "google-tasks-mcp", version: "1.0.0" });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getInstructions()).toContain("YYYY-MM-DD");
    await client.close();
  });

  it("lists exactly the seven tools with the right annotations", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))).toEqual({
      list_task_lists: readOnly,
      list_tasks: readOnly,
      create_task: write,
      update_task: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      complete_task: { ...write, idempotentHint: true },
      delete_task: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      create_task_list: write,
    });
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toBeTruthy();
    }
    const listTasks = tools.find((tool) => tool.name === "list_tasks");
    expect(Object.keys(listTasks?.inputSchema.properties ?? {}).sort()).toEqual(
      ["due_after", "due_before", "include_completed", "list", "max_results", "task_list_id"],
    );
    const createTask = tools.find((tool) => tool.name === "create_task");
    expect(createTask?.inputSchema.required).toEqual(["title"]);
    const updateTask = tools.find((tool) => tool.name === "update_task");
    expect(updateTask?.inputSchema.required).toEqual(["task_id"]);
    await client.close();
  });

  it("list_task_lists calls Google with the token from the access token", async () => {
    googleResponses["GET /users/@me/lists"] = {
      items: [{ id: "inbox", title: "My Tasks", updated: "2026-10-01T00:00:00.000Z", etag: "x" }],
    };
    const client = await connect(await accessToken({ g_access: "google-access-123" }));
    const result = await client.callTool({ name: "list_task_lists", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(resultJson(result)).toEqual({
      task_lists: [{ id: "inbox", title: "My Tasks", updated: "2026-10-01T00:00:00.000Z" }],
    });
    expect(googleCalls[0].auth).toBe("Bearer google-access-123");
    await client.close();
  });

  it("list_tasks reads every list and returns sorted tasks", async () => {
    googleResponses["GET /users/@me/lists"] = {
      items: [
        { id: "inbox", title: "My Tasks" },
        { id: "work", title: "Work" },
      ],
    };
    googleResponses["GET /lists/inbox/tasks"] = {
      items: [
        { id: "a", title: "Undated", status: "needsAction", position: "1", updated: "u" },
        { id: "b", title: "Friday", status: "needsAction", due: "2026-10-16T00:00:00.000Z", position: "2", updated: "u" },
      ],
    };
    googleResponses["GET /lists/work/tasks"] = {
      items: [
        {
          id: "c",
          title: "Thursday",
          status: "needsAction",
          due: "2026-10-15T00:00:00.000Z",
          parent: "p",
          webViewLink: "https://tasks.google.com/task/c",
          updated: "u",
        },
      ],
    };
    const client = await connect();
    const result = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(resultJson(result)).toEqual({
      tasks: [
        {
          id: "c",
          task_list_id: "work",
          task_list: "Work",
          title: "Thursday",
          due: "2026-10-15",
          status: "needsAction",
          parent: "p",
          web_view_link: "https://tasks.google.com/task/c",
          updated: "u",
        },
        { id: "b", task_list_id: "inbox", task_list: "My Tasks", title: "Friday", due: "2026-10-16", status: "needsAction", updated: "u" },
        { id: "a", task_list_id: "inbox", task_list: "My Tasks", title: "Undated", status: "needsAction", updated: "u" },
      ],
      count: 3,
      truncated: false,
    });
    const inbox = googleCalls.find((entry) => entry.path === "/lists/inbox/tasks");
    expect(inbox?.params.get("showCompleted")).toBe("false");
    await client.close();
  });

  it("create_task inserts into the default list", async () => {
    googleResponses["GET /users/@me/lists/@default"] = { id: "inbox", title: "My Tasks" };
    googleResponses["POST /lists/inbox/tasks"] = {
      id: "new",
      title: "Call Sam",
      due: "2026-10-22T00:00:00.000Z",
      status: "needsAction",
      updated: "2026-10-15T12:00:00.000Z",
    };
    const client = await connect();
    const result = await client.callTool({ name: "create_task", arguments: { title: "Call Sam", due: "2026-10-22" } });
    expect(resultJson(result)).toEqual({
      id: "new",
      task_list_id: "inbox",
      task_list: "My Tasks",
      title: "Call Sam",
      due: "2026-10-22",
      status: "needsAction",
      updated: "2026-10-15T12:00:00.000Z",
    });
    const insert = googleCalls.find((entry) => entry.method === "POST");
    expect(insert?.body).toEqual({ title: "Call Sam", due: "2026-10-22T00:00:00.000Z" });
    await client.close();
  });

  it("create_task puts the task in the list named by title", async () => {
    googleResponses["GET /users/@me/lists"] = {
      items: [
        { id: "inbox", title: "My Tasks" },
        { id: "school", title: "School" },
      ],
    };
    googleResponses["GET /users/@me/lists/school"] = { id: "school", title: "School" };
    googleResponses["POST /lists/school/tasks"] = { id: "new", title: "HW 5", status: "needsAction", updated: "u" };
    const client = await connect();
    const result = await client.callTool({ name: "create_task", arguments: { title: "HW 5", list: "School" } });
    expect(resultJson(result)).toMatchObject({ id: "new", task_list_id: "school", task_list: "School" });
    expect(googleCalls.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /users/@me/lists",
      "GET /users/@me/lists/school",
      "POST /lists/school/tasks",
    ]);
    await client.close();
  });

  it("update_task patches the named list", async () => {
    googleResponses["GET /users/@me/lists/work"] = { id: "work", title: "Work" };
    googleResponses["PATCH /lists/work/tasks/t1"] = { id: "t1", title: "Report", notes: "New", status: "needsAction", updated: "u" };
    const client = await connect();
    const result = await client.callTool({
      name: "update_task",
      arguments: { task_id: "t1", task_list_id: "work", notes: "New", due: null },
    });
    expect(resultJson(result)).toEqual({
      id: "t1",
      task_list_id: "work",
      task_list: "Work",
      title: "Report",
      notes: "New",
      status: "needsAction",
      updated: "u",
    });
    expect(googleCalls.find((entry) => entry.method === "PATCH")?.body).toEqual({ notes: "New", due: null });
    await client.close();
  });

  it("complete_task searches the lists for the task", async () => {
    googleResponses["GET /users/@me/lists"] = {
      items: [
        { id: "inbox", title: "My Tasks" },
        { id: "work", title: "Work" },
      ],
    };
    googleResponses["GET /lists/work/tasks/t1"] = { id: "t1", title: "Pay rent", status: "needsAction" };
    googleResponses["PATCH /lists/work/tasks/t1"] = {
      id: "t1",
      title: "Pay rent",
      status: "completed",
      completed: "2026-10-15T12:00:00.000Z",
      updated: "u",
    };
    const client = await connect();
    const result = await client.callTool({ name: "complete_task", arguments: { task_id: "t1" } });
    expect(resultJson(result)).toMatchObject({ id: "t1", task_list_id: "work", status: "completed" });
    expect(googleCalls.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /users/@me/lists",
      "GET /lists/inbox/tasks/t1",
      "GET /lists/work/tasks/t1",
      "PATCH /lists/work/tasks/t1",
    ]);
    expect(googleCalls[3].body).toEqual({ status: "completed" });
    await client.close();
  });

  it("delete_task deletes and reports what it deleted", async () => {
    googleResponses["DELETE /lists/work/tasks/t1"] = null;
    const client = await connect();
    const result = await client.callTool({ name: "delete_task", arguments: { task_id: "t1", task_list_id: "work" } });
    expect(resultJson(result)).toEqual({ deleted: true, task_id: "t1", task_list_id: "work" });
    await client.close();
  });

  it("create_task_list creates a list", async () => {
    googleResponses["POST /users/@me/lists"] = { id: "new-list", title: "Errands", updated: "u", kind: "tasks#taskList" };
    const client = await connect();
    const result = await client.callTool({ name: "create_task_list", arguments: { title: "Errands" } });
    expect(resultJson(result)).toEqual({ id: "new-list", title: "Errands", updated: "u" });
    expect(googleCalls[0].body).toEqual({ title: "Errands" });
    await client.close();
  });

  it("turns a Google 401 into a tool error that says to reconnect", async () => {
    googleResponses["GET /users/@me/lists"] = new Response(
      JSON.stringify({ error: { code: 401, message: "Request had invalid authentication credentials." } }),
      { status: 401 },
    );
    const client = await connect();
    const result = await client.callTool({ name: "list_task_lists", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("Reconnect the Google Tasks connector");
    await client.close();
  });

  it("passes the verified token to tools on a 2026-07-28 request too", async () => {
    googleResponses["GET /users/@me/lists"] = { items: [{ id: "inbox", title: "My Tasks", updated: "u" }] };
    const response = await route.POST(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await accessToken({ g_access: "modern-token" })}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "list_task_lists",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "list_task_lists",
            arguments: {},
            _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_META_KEY]: {} },
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(body.result.content[0].text)).toEqual({
      task_lists: [{ id: "inbox", title: "My Tasks", updated: "u" }],
    });
    expect(googleCalls[0].auth).toBe("Bearer modern-token");
  });

  it("turns bad arguments into a tool error", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "create_task", arguments: { title: "x", due: "2026-02-30" } });
    expect(result.isError).toBe(true);
    const unknown = await client.callTool({ name: "create_task", arguments: { title: "x", lists: "Work" } });
    expect(unknown.isError).toBe(true);
    expect((unknown.content as { text: string }[])[0].text).toContain('Unrecognized key: "lists"');
    expect(googleCalls).toHaveLength(0);
    await client.close();
  });
});
