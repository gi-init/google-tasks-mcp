import { htmlResponse, privacyPage } from "@/lib/ui";

export function GET(): Response {
  return htmlResponse(privacyPage());
}
