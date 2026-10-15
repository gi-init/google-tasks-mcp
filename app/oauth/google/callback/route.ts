import { handleGoogleCallback } from "@/lib/oauth/callback";

export function GET(req: Request): Promise<Response> {
  return handleGoogleCallback(req);
}
