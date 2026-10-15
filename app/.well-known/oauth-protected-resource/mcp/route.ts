import { publicOrigin } from "@/lib/config";
import { json, preflight } from "@/lib/http";
import { protectedResourceMetadata } from "@/lib/oauth/metadata";

/** RFC 9728 path-aware location for the /mcp resource, which clients try first. */
export function GET(req: Request): Response {
  return json(protectedResourceMetadata(publicOrigin(req)));
}

export function OPTIONS(): Response {
  return preflight();
}
