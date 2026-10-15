import { publicOrigin } from "@/lib/config";
import { json, preflight } from "@/lib/http";
import { protectedResourceMetadata } from "@/lib/oauth/metadata";

export function GET(req: Request): Response {
  return json(protectedResourceMetadata(publicOrigin(req)));
}

export function OPTIONS(): Response {
  return preflight();
}
