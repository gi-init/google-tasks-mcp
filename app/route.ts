import { loadConfig, publicOrigin } from "@/lib/config";
import { COPY_SCRIPT_HASH, htmlResponse, landingPage } from "@/lib/ui";

/** GET /: the home page. */
export function GET(req: Request): Response {
  const loaded = loadConfig();
  const missing = loaded.ok ? [] : loaded.missing;
  return htmlResponse(landingPage({ origin: publicOrigin(req), missing }), { scriptHashes: [COPY_SCRIPT_HASH] });
}
