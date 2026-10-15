import { handleAuthorizeGet, handleAuthorizePost } from "@/lib/oauth/authorize";

export function GET(req: Request): Promise<Response> {
  return handleAuthorizeGet(req);
}

export function POST(req: Request): Promise<Response> {
  return handleAuthorizePost(req);
}
