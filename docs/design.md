# How it works

google-tasks-mcp is a remote MCP server that gives Claude (or any MCP client that speaks OAuth) read and write access to one person's Google Tasks. You deploy your own copy to Vercel with your own Google OAuth client, so your tasks go through a server you run.

This document describes how the code works, and a change to one should update the other.

## The pieces

```
Claude ──OAuth──> this server (its own small OAuth server) ──OAuth──> Google
Claude ──MCP────> /mcp ──Google access token──> Google Tasks API
```

Claude can't use Google as the authorization server directly, because Google only issues a refresh token when the request carries `access_type=offline`, which a generic OAuth client doesn't send, so access would end after an hour. So this server runs its own OAuth server. Claude signs in to it, the server sends the person on to Google, keeps Google's refresh token, and gives Claude its own tokens.

There is no database. Every client id, code and token this server issues is a sealed blob, which is an encrypted JWT (`lib/crypto.ts`, JWE with `dir` + `A256GCM`) that only this server can open, with a `t` claim saying what kind of blob it is. The payloads are in `lib/types.ts`, and each holds only what a later step checks or uses. None of them holds a scope, because `tasks` is the only one this server grants. Claude's refresh token carries the Google refresh token inside it.

## Settings

| Setting | Required | What it is |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | OAuth client id of a Google "Web application" client |
| `GOOGLE_CLIENT_SECRET` | yes | That client's secret |
| `ALLOWED_EMAILS` | yes | Comma-separated Google accounts allowed to sign in |
| `TOKEN_SECRET` | no | Key material for sealing. Defaults to the Google client secret |
| `PUBLIC_URL` | no | Fixes the public origin, such as `https://tasks.example.com`. Defaults to the request's host |

`GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_REVOKE_URL` and `GOOGLE_TASKS_API_URL` point the server at a stand-in Google for local end-to-end testing. Never set them in production.

When a required setting is missing, the home page lists it, `/authorize` and the Google callback show an error page with status 503, `/token` and `/register` answer `503 temporarily_unavailable`, and `/mcp` answers 401.

## Routes

`origin` below is the public origin from `publicOrigin()` in `lib/config.ts`. The MCP resource identifier is `origin + "/mcp"`.

| Route | Purpose |
| --- | --- |
| `GET /` | Home page: what this is, the connector URL, the Google redirect URI, which settings are missing |
| `GET /privacy` | Privacy policy. Google requires one before an OAuth app can be published |
| `GET, POST, DELETE /mcp` | The MCP server (Streamable HTTP), behind bearer auth |
| `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | Protected resource metadata (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |
| `GET /authorize` | Validates the request, shows the consent page |
| `POST /authorize` | Consent form submit, sends the person to Google |
| `GET /oauth/google/callback` | Google sends the person back here |
| `POST /token` | Code exchange and refresh |
| `POST /register` | Dynamic Client Registration (RFC 7591) |

Metadata, token and register routes send permissive CORS headers and answer `OPTIONS` preflights.

### Protected resource metadata

```json
{
  "resource": "<origin>/mcp",
  "authorization_servers": ["<origin>"],
  "scopes_supported": ["tasks"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Google Tasks",
  "resource_documentation": "https://github.com/pdcarlson/google-tasks-mcp"
}
```

### Authorization server metadata

```json
{
  "issuer": "<origin>",
  "authorization_endpoint": "<origin>/authorize",
  "token_endpoint": "<origin>/token",
  "registration_endpoint": "<origin>/register",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
  "scopes_supported": ["tasks", "offline_access"],
  "client_id_metadata_document_supported": true,
  "authorization_response_iss_parameter_supported": true,
  "service_documentation": "https://github.com/pdcarlson/google-tasks-mcp"
}
```

Claude picks a Client ID Metadata Document (CIMD) only when both `client_id_metadata_document_supported: true` and `"none"` in `token_endpoint_auth_methods_supported` are present, and appends `offline_access` because it is listed. This server issues refresh tokens either way.

## Clients

A `client_id` is one of two kinds:

- **CIMD**: an `https` URL with a path and no query or fragment. The server fetches it as the client's metadata document (`lib/oauth/cimd.ts`), with no redirects followed, a 5 second timeout, a 32 KB cap, and JSON only. The document's `client_id` must equal the URL, `redirect_uris` must be valid, and `token_endpoint_auth_method` must be absent or `"none"`. URLs whose host is `localhost` or an IP literal are refused. Results are cached in memory for 5 minutes. CIMD clients are public clients.
- **DCR**: anything else is a sealed `"client"` blob from `/register`.

### Redirect URIs

Allowed in registrations and metadata documents: `https` URLs; `http` URLs whose host is `localhost`, `127.0.0.1` or `[::1]`; and private-use schemes (RFC 8252 section 7.1) other than `javascript`, `data`, `file`, `vbscript`, `about` and `blob`. No fragments.

A requested `redirect_uri` matches when it equals a registered one exactly, or when the registered one is a loopback `http` URL and the requested one has the same scheme, host, path and query on any port (RFC 8252 section 7.3, and Claude Code's port-agnostic loopback redirect).

### POST /register

JSON body, at most 16 KB.

- `redirect_uris`: required, 1 to 10 valid redirect URIs, else `400 invalid_redirect_uri`
- `token_endpoint_auth_method`: `none`, `client_secret_post` or `client_secret_basic`; defaults to `client_secret_basic` (RFC 7591), else `400 invalid_client_metadata`
- `grant_types` must be a subset of `authorization_code`, `refresh_token`; `response_types` a subset of `code`
- `client_name`: optional, a string, trimmed and cut to 100 characters, with control characters removed. It's returned in the response but not kept in the `client_id`, because the consent page doesn't show it.

The response is `201` with `client_id` (a sealed `"client"` blob with no expiry), `client_id_issued_at`, `client_name`, `redirect_uris`, `grant_types`, `response_types` and `token_endpoint_auth_method`, plus `client_secret` (from `clientSecretFor`) and `client_secret_expires_at: 0` for confidential clients.

## The sign-in flow

### GET /authorize

1. Settings missing: error page, 503.
2. Resolve `client_id`. Unknown or invalid: error page, 400.
3. `redirect_uri`: when omitted and the client has exactly one, use it. Otherwise it must match (above), else error page, 400.
4. Every other problem with the request is also an error page, 400. Nothing on this route redirects to the client, because anyone can register any redirect URI, so redirecting errors there would make this server an open redirect. The checks are:
   - `response_type` must be `code`
   - `code_challenge` must be present and well formed, with `code_challenge_method=S256`
   - each `resource`, when present, must be `<origin>/mcp` (a trailing slash is tolerated)
   - the sealed consent request must stay small enough to open later, so a very long `state` or `redirect_uri` is refused
   - `scope` is advisory. Unknown scopes are ignored, and the granted scope is always `tasks`.
5. Show the consent page (`consentPage` in `lib/ui`). It names the app by a host the client can't choose, which is the `client_id` URL's host for a CIMD client and the redirect URI's host for a DCR client, and never by a `client_name`. It shows the redirect URI's host, lists what the app can do ("See your tasks and task lists" and "Add, change and delete your tasks, and add task lists"), and tells anyone who doesn't know that address to close the page, since Cancel also goes there. The page's hidden `request` field is a sealed `"consent"` blob (10 minutes) holding the pending authorization and a random `csrf` value. The response sets `__Host-gtm_csrf=<csrf>` with `SameSite=Strict`, `HttpOnly`, `Secure`, 10 minutes.

### POST /authorize

1. Open `request`. Expired or forged: error page, 400.
2. The `__Host-gtm_csrf` cookie must equal the blob's `csrf`, else error page, 403. A `SameSite=Strict` cookie isn't sent on a cross-site form post, so another site can't skip the consent page.
3. `decision=deny` (Cancel): `303` to the client with `error=access_denied`, `state` and `iss=<origin>`. This, a cancel at Google, and a finished sign-in are the only times the person is sent to the client.
4. Otherwise make a `nonce` and a PKCE verifier, seal them with the pending authorization as `"google_state"` (10 minutes), set `__Host-gtm_nonce=<nonce>` (`SameSite=Lax`, because Google's redirect back is a cross-site navigation), clear the csrf cookie, and answer `303` to Google with: `client_id`, `redirect_uri=<origin>/oauth/google/callback`, `response_type=code`, `scope=openid email https://www.googleapis.com/auth/tasks`, `access_type=offline`, `prompt=consent`, `state`, `code_challenge`, `code_challenge_method=S256`, and `login_hint` when exactly one email is allowed.

### GET /oauth/google/callback

1. Open `state`. Expired or forged: error page, 400.
2. The `__Host-gtm_nonce` cookie must equal the state's `nonce`, else error page, 403.
3. Google sent `error` (the person cancelled at Google): redirect to the client with `error=access_denied`.
4. Google sent no `code`: error page, 400.
5. Exchange the code at Google with the PKCE verifier. Failure: error page, 502.
6. Read the ID token's payload (it came straight from Google over TLS, so its signature isn't checked). `aud` must be our client id, `iss` must be Google, `email_verified` must be true, and the email must be in `ALLOWED_EMAILS`. Otherwise revoke the new Google grant (the refresh token, or the access token when there is none, best effort) and show an error page, 403, naming the person's own email when Google gave one. This runs before the scope checks, so an account that isn't allowed is told so whatever boxes it ticked, and its grant is revoked.
7. The granted scopes must include the Tasks scope, else error page, 400, asking the person to tick the Google Tasks box. A missing `refresh_token` is an error page, 502.
8. Seal a `"code"` (2 minutes) and redirect to the client with `code`, `state` and `iss=<origin>`. A code too long for `/token` to open is an error page, 502.

From step 3 on, every answer clears the nonce cookie.

### POST /token

Form-encoded (JSON is also accepted), at most 16 KB. Every response carries `Cache-Control: no-store`.

Client authentication: HTTP Basic or `client_id`/`client_secret` in the body. An `https` client id is a public CIMD client. Otherwise it must open as a `"client"` blob, and confidential clients must present the matching secret, else `401 invalid_client`.

- `authorization_code`: `code`, `redirect_uri` and `code_verifier` are required (`invalid_request`). The code must open, belong to this client, have the same `redirect_uri`, and pass PKCE, else `invalid_grant`. A `resource` that doesn't match is `invalid_target`.
- `refresh_token`: the token must open and belong to this client, and its email must still be allowed (removing someone from `ALLOWED_EMAILS` cuts them off at their next refresh), else `invalid_grant`. The server refreshes the Google access token. Google's `invalid_grant` becomes ours, and any other Google failure is `503 temporarily_unavailable`.
- Anything else: `unsupported_grant_type`.

Both grants then issue tokens the same way. If the Google access token they carry has 60 seconds or less left, the answer is `503 temporarily_unavailable` instead. Google's access tokens last an hour, so this only happens if Google shortens them.

A successful response is `{ access_token, token_type: "Bearer", expires_in, refresh_token, scope: "tasks" }`. Every refresh returns a new refresh token.

### Lifetimes

| Blob | Lifetime |
| --- | --- |
| consent, google_state | 10 minutes |
| code | 2 minutes |
| access | Until the Google access token inside it expires, less 60 seconds, at most 1 hour |
| refresh | 180 days, renewed on every refresh |
| client | No expiry |

### Known trade-offs of having no database

- A code can be redeemed more than once within its 2 minutes.
- When a refresh token is rotated, the old one keeps working until it expires.
- To cut off every client at once, rotate `TOKEN_SECRET` (or the Google client secret when `TOKEN_SECRET` isn't set). To cut off Google access, remove the app at https://myaccount.google.com/permissions.

## /mcp

`withMcpAuth` from `mcp-handler` guards the route. A missing or invalid token gets `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`. A valid token is an `"access"` blob whose `resource` equals `<origin>/mcp` and whose email is still in `ALLOWED_EMAILS`. The tools get its Google access token as `authInfo.extra.googleAccessToken`, and the auth info always lists the scope `tasks`.

## Tools

The tool names and arguments match the ones my own Claude skills already use. Dates are `YYYY-MM-DD`, and the Tasks API stores dates only, never times. Every tool returns its result as JSON text.

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_task_lists` | none | `{ task_lists: [{ id, title, updated }] }` |
| `list_tasks` | `task_list_id?` or `list?`, `due_before?`, `due_after?`, `include_completed?` (default false), `max_results?` (default 200, at most 250) | `{ tasks: [Task], count, truncated }` |
| `create_task` | `title`, `notes?`, `due?`, `task_list_id?` or `list?` (default `@default`), `parent_id?` | the new `Task` |
| `update_task` | `task_id`, `task_list_id?` or `list?`, `title?`, `notes?`, `due?` (`null` clears it), `status?` (`needsAction` or `completed`) | the updated `Task` |
| `complete_task` | `task_id`, `task_list_id?` or `list?` | the updated `Task` |
| `delete_task` | `task_id`, `task_list_id?` or `list?` | `{ deleted: true, task_id, task_list_id }` |
| `create_task_list` | `title` | `{ id, title, updated }` |

`Task` is `{ id, task_list_id, task_list, title, notes?, due?, status, completed?, parent?, web_view_link?, updated }`.

- `due` is the task's date in Google Tasks, the day it should be done and the day it shows on the calendar. It isn't the separate deadline the Tasks app can set, which the API can't read or write, so the tool descriptions tell Claude to put a deadline that differs from the date in the notes.
- `list` is a list's title, matched exactly but ignoring case. Passing both `list` and `task_list_id`, a title no list has, or a title two lists share is a tool error.
- Every tool rejects arguments it doesn't know, so a misspelled argument is an error instead of being silently dropped.
- `list_tasks` without `task_list_id` or `list` reads every list, and it asks Google for tasks assigned to the person from Google Docs and Chat too. `due_before` and `due_after` are inclusive and leave out undated tasks.
- `list_tasks` puts open tasks first, sorted by due date with undated ones last, then completed tasks, most recently completed first. Ties go by list title, then position in the list. `max_results` is applied after sorting, so the oldest completed tasks are the first to be cut.
- When `task_list_id` and `list` are both omitted for a single task, the server looks for the task in each list.
- `notes` replaces the whole notes field.
- In the tool annotations, the two list tools have `readOnlyHint: true`. `update_task` and `delete_task` have `destructiveHint: true`, since `update_task` can overwrite or clear fields. `create_task`, `complete_task` and `create_task_list` have `destructiveHint: false`. `update_task` and `complete_task` also have `idempotentHint: true`, and every tool has `openWorldHint: false`.
- A Google API error becomes a tool error (`isError: true`) with a plain message. A 401 from Google says to reconnect the connector in Claude, under Customize, then Connectors.
