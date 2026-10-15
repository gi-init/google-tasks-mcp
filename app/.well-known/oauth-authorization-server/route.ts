import { publicOrigin } from "@/lib/config";
import { json, preflight } from "@/lib/http";
import { authorizationServerMetadata } from "@/lib/oauth/metadata";

export function GET(req: Request): Response {
  return json(authorizationServerMetadata(publicOrigin(req)));
}

export function OPTIONS(): Response {
  return preflight();
}
