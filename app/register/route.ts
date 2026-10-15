import { preflight } from "@/lib/http";
import { handleRegister } from "@/lib/oauth/register";

export function POST(req: Request): Promise<Response> {
  return handleRegister(req);
}

export function OPTIONS(): Response {
  return preflight();
}
