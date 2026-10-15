import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { publicOrigin } from "@/lib/config";
import { verifyAccessToken } from "@/lib/mcp-auth";
import { registerTools } from "@/lib/tools";
import packageJson from "@/package.json";

const INSTRUCTIONS =
  "These tools read and change the signed-in person's Google Tasks. " +
  "Dates are YYYY-MM-DD. Google Tasks keeps no time of day, so don't send or expect times. " +
  "A task's due is its date in Google Tasks, the day it should be done and the day it shows on the calendar. " +
  "The separate deadline set in the Tasks app can't be read or set through the API, " +
  "so a deadline that differs from the date goes in the notes. " +
  "Use list_task_lists to find list ids, or pass a list's title as list. " +
  "The tools that act on one task search every list when task_list_id and list are left out.";

const mcpHandler = createMcpHandler((server) => registerTools(server), {
  serverInfo: { name: "google-tasks-mcp", version: packageJson.version },
  instructions: INSTRUCTIONS,
});

async function handler(req: Request): Promise<Response> {
  // Built per request so the resource_metadata URL in a 401 uses the same
  // public origin as the rest of the server, PUBLIC_URL included.
  const authed = withMcpAuth(mcpHandler, verifyAccessToken, {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
    resourceUrl: publicOrigin(req),
  });
  return authed(req);
}

export { handler as DELETE, handler as GET, handler as POST };

export const maxDuration = 60;
