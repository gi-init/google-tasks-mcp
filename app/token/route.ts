import { preflight } from "@/lib/http";
import { handleToken } from "@/lib/oauth/token";

export function POST(req: Request): Promise<Response> {
  return handleToken(req);
}

export function OPTIONS(): Response {
  return preflight();
}
