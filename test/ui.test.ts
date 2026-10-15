import { afterEach, describe, expect, it } from "vitest";
import { GET } from "@/app/route";
import { consentPage, errorPage, htmlResponse, landingPage, privacyPage } from "@/lib/ui";
import { escapeHtml } from "@/lib/ui/html";

const NASTY = `<script>alert("x")</script> & 'quoted'`;
const NASTY_ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;";

function csp(res: Response): Record<string, string> {
  const header = res.headers.get("content-security-policy") ?? "";
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values.join(" ")];
    }),
  );
}

/** The page as plain text: no markup, line-break hints removed. */
function withoutWbr(page: string): string {
  return page.replaceAll("<wbr>", "");
}

function expectNoScript(page: string) {
  expect(page).not.toMatch(/<script/i);
  expect(page).not.toMatch(/javascript:/i);
  // Escaped input can spell an attribute inside a value; only real attributes count.
  const outsideValues = page.replace(/"[^"]*"/g, '""');
  expect(outsideValues).not.toMatch(/\son[a-z]+\s*=/i);
}

describe("escapeHtml", () => {
  it("escapes the five HTML special characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});

describe("htmlResponse", () => {
  it("sets the content type and security headers", () => {
    const res = htmlResponse("<!doctype html>");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(csp(res)).toEqual({
      "default-src": "'none'",
      "style-src": "'unsafe-inline' https://fonts.googleapis.com",
      "font-src": "https://fonts.gstatic.com",
      "img-src": "'self' data:",
      "form-action": "'self'",
      "frame-ancestors": "'none'",
      "base-uri": "'none'",
    });
  });

  it("uses the status it is given", () => {
    expect(htmlResponse("x", { status: 503 }).status).toBe(503);
  });

  it("keeps the caller's headers, including Set-Cookie", () => {
    const res = htmlResponse("x", { headers: { "Set-Cookie": "__Host-gtm_csrf=abc; Path=/; Secure", "X-Extra": "1" } });
    expect(res.headers.getSetCookie()).toEqual(["__Host-gtm_csrf=abc; Path=/; Secure"]);
    expect(res.headers.get("x-extra")).toBe("1");
  });

  it("keeps more than one Set-Cookie", () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "a=1; Path=/");
    headers.append("Set-Cookie", "b=2; Path=/");
    expect(htmlResponse("x", { headers }).headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("doesn't let the caller loosen the security headers", () => {
    const res = htmlResponse("x", {
      headers: { "Content-Security-Policy": "default-src *", "X-Frame-Options": "ALLOWALL", "Cache-Control": "public" },
    });
    expect(csp(res)["default-src"]).toBe("'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("adds extra form-action origins", () => {
    const res = htmlResponse("x", {
      formActionOrigins: ["https://accounts.google.com", "https://claude.ai", "http://localhost:33418", "cursor:"],
    });
    expect(csp(res)["form-action"]).toBe("'self' https://accounts.google.com https://claude.ai http://localhost:33418 cursor:");
  });

  it("leaves out form-action values that could change the policy", () => {
    const res = htmlResponse("x", {
      formActionOrigins: [
        "https://claude.ai",
        "https://claude.ai",
        "https://evil.example; script-src *",
        "https://evil.example *",
        "*",
        "'unsafe-inline'",
        "https://evil.example/path",
        "",
      ],
    });
    expect(csp(res)["form-action"]).toBe("'self' https://claude.ai");
    expect(csp(res)["script-src"]).toBeUndefined();
  });
});

describe("landingPage", () => {
  it("shows the connector URL and the Google redirect URI", () => {
    const page = withoutWbr(landingPage({ origin: "https://tasks.example.com", missing: [] }));
    expect(page).toContain("https://tasks.example.com/mcp");
    expect(page).toContain("https://tasks.example.com/oauth/google/callback");
  });

  it("says it's ready when nothing is missing", () => {
    const page = landingPage({ origin: "https://tasks.example.com", missing: [] });
    expect(page).toContain("Ready");
    expect(page).not.toContain("Not set up yet");
    expect(page).not.toContain("GOOGLE_CLIENT_ID");
  });

  it("lists the missing settings and where to set them", () => {
    const page = landingPage({ origin: "https://tasks.example.com", missing: ["GOOGLE_CLIENT_ID", "ALLOWED_EMAILS"] });
    expect(page).toContain("Not set up yet");
    expect(page).toContain("<code>GOOGLE_CLIENT_ID</code>");
    expect(page).toContain("<code>ALLOWED_EMAILS</code>");
    expect(page).not.toContain("<code>GOOGLE_CLIENT_SECRET</code>");
    expect(page).toContain("environment variables");
    expect(page).not.toMatch(/>Ready/);
  });

  it("links to the author and the source", () => {
    const page = landingPage({ origin: "https://tasks.example.com", missing: [] });
    expect(page).toContain('href="https://pdcarlson.dev"');
    expect(page).toContain("Made by");
    expect(page).toContain('href="https://github.com/pdcarlson/google-tasks-mcp"');
  });

  it("loads only the Google Fonts stylesheet", () => {
    const page = landingPage({ origin: "https://tasks.example.com", missing: [] });
    const stylesheets = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((match) => match[1]);
    expect(stylesheets).toHaveLength(1);
    expect(stylesheets[0]).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=Fraunces/);
    expect(page).not.toMatch(/<img|<iframe|<object|<embed/i);
  });

  it("escapes the origin and the setting names", () => {
    const page = landingPage({ origin: `https://x.example${NASTY}`, missing: [NASTY] });
    expectNoScript(page);
    expect(page).toContain(NASTY_ESCAPED);
    expect(page).toContain(`<code>${NASTY_ESCAPED}</code>`);
  });

  it("uses no JavaScript", () => {
    expectNoScript(landingPage({ origin: "https://tasks.example.com", missing: ["GOOGLE_CLIENT_ID"] }));
  });
});

describe("consentPage", () => {
  const options = {
    clientName: "claude.ai",
    redirectHost: "claude.ai",
    request: "sealed.request.blob",
    action: "/authorize",
  };

  it("has one POST form with the hidden request and both buttons", () => {
    const page = consentPage(options);
    expect(page.match(/<form\b/g)).toHaveLength(1);
    expect(page).toContain('<form method="post" action="/authorize">');
    expect(page).toContain('<input type="hidden" name="request" value="sealed.request.blob">');
    expect(page).toMatch(/<button[^>]*type="submit" name="decision" value="allow">Continue with Google<\/button>/);
    expect(page).toMatch(/<button[^>]*type="submit" name="decision" value="deny">Cancel<\/button>/);
  });

  it("names the app, where the person goes back to, and what it can do", () => {
    const page = consentPage(options);
    expect(page).toContain("Use your Google Tasks with <em><bdi>claude.ai</bdi></em>?");
    expect(page).toContain(`You'll go back to <bdi class="host">claude.ai</bdi> after signing in. If you don't know that address, close this page.`);
    expect(page).toContain("See your tasks and task lists");
    expect(page).toContain("Add, change and delete your tasks, and add task lists");
  });

  it("is kept out of search results", () => {
    expect(consentPage(options)).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it("escapes every field", () => {
    const page = consentPage({
      clientName: NASTY,
      redirectHost: NASTY,
      request: `"><script>alert(1)</script>`,
      action: `/authorize" onsubmit="alert(1)`,
    });
    expectNoScript(page);
    expect(page).toContain(`<em><bdi>${NASTY_ESCAPED}</bdi></em>`);
    expect(page).toContain(`<bdi class="host">${NASTY_ESCAPED}</bdi>`);
    expect(page).toContain('name="request" value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(page).toContain('action="/authorize&quot; onsubmit=&quot;alert(1)"');
  });
});

describe("errorPage", () => {
  it("shows the title, the message and how to try again", () => {
    const page = errorPage({ title: "This sign-in has expired", message: "The page was open too long." });
    expect(page).toContain("<h1 class=\"title\">This sign-in has expired</h1>");
    expect(page).toContain("The page was open too long.");
    expect(page).toContain("You can close this page and start again from Claude, or from the app you were connecting.");
    expect(page).toContain("<title>This sign-in has expired · Google Tasks for Claude</title>");
  });

  it("escapes the title and the message", () => {
    const page = errorPage({ title: NASTY, message: NASTY });
    expectNoScript(page);
    expect(page).toContain(`<title>${NASTY_ESCAPED} · Google Tasks for Claude</title>`);
    expect(page).toContain(`<h1 class="title">${NASTY_ESCAPED}</h1>`);
    expect(page).toContain(`<p class="lede">${NASTY_ESCAPED}</p>`);
  });
});

describe("privacyPage", () => {
  it("covers Google's Limited Use requirement and how to remove access", () => {
    const page = privacyPage();
    expectNoScript(page);
    expect(page).toContain("Limited Use");
    expect(page).toContain("https://myaccount.google.com/permissions");
  });
});

describe("GET /", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("serves the home page with the public origin", async () => {
    const res = GET(new Request("https://tasks.example.com/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const page = withoutWbr(await res.text());
    expect(page).toContain("https://tasks.example.com/mcp");
    expect(page).toContain("https://tasks.example.com/oauth/google/callback");
    expect(page).toContain("Ready");
  });

  it("uses the request's host when PUBLIC_URL isn't set", async () => {
    delete process.env.PUBLIC_URL;
    const res = GET(new Request("https://preview.example.dev/"));
    expect(withoutWbr(await res.text())).toContain("https://preview.example.dev/mcp");
  });

  it("lists the settings that are missing", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.ALLOWED_EMAILS = " , ";
    const page = await GET(new Request("https://tasks.example.com/")).text();
    expect(page).toContain("<code>GOOGLE_CLIENT_ID</code>");
    expect(page).toContain("<code>ALLOWED_EMAILS</code>");
    expect(page).not.toContain("<code>GOOGLE_CLIENT_SECRET</code>");
  });
});
