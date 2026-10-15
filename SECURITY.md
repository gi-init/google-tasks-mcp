# Security

## Reporting a vulnerability

Please report it privately. On GitHub, open this repository's Security tab and choose Report a vulnerability. Don't open a public issue for it.

Say what you found, how to reproduce it, and what someone could do with it. I'll reply as soon as I can, and I'll credit you in the fix unless you'd rather I didn't.

Fixes go to `main`. If you run your own copy, pull them into it and deploy again.

## In scope

The code in this repository:

- the OAuth server: `/authorize`, `/token`, `/register`, the Google callback, and the metadata routes
- how codes, tokens and client ids are sealed and checked
- the `ALLOWED_EMAILS` check, the consent page and its cookies
- the `/mcp` endpoint and its tools
- the GitHub Actions workflows

## Out of scope

- Google, Vercel, Claude and GitHub themselves. Report those to them.
- A copy someone set up with a leaked or weak secret, or with settings the README warns against.
- Anything that needs the server's own secrets to begin with.
- The two known costs of having no database, which [docs/design.md](docs/design.md) lists. An authorization code can be used more than once within its 2 minutes, and a rotated refresh token keeps working until it expires.

## How it's built

There is no database. Every client id, authorization code, access token and refresh token the server issues is an encrypted JWT (JWE, `dir` with `A256GCM`). The key is derived from `TOKEN_SECRET`, or from the Google client secret when that isn't set, and never leaves the server. Each blob says what kind it is, so one kind can't be used as another.

- Only the Google accounts in `ALLOWED_EMAILS` can sign in. The list is checked when Google sends the person back, at every refresh, and on every `/mcp` request. When an account that isn't on the list signs in, the server asks Google to revoke the grant it just gave.
- The person sees a consent page before going to Google. It names the app by a host the app can't choose, and shows the address they'll be sent back to. A `SameSite=Strict` cookie ties the form to that page, so another site can't skip it.
- If a sign-in request has a problem, the server shows an error page instead of sending the person to the app's redirect URI. Anyone can register a redirect URI, so redirecting there would make the server an open redirect.
- PKCE with S256 is required from Claude, and the server uses it again for its own hop to Google. A nonce cookie ties Google's redirect back to the browser that started it.
- Redirect URIs must match a registered one exactly, except that a loopback `http` redirect may use any port.
- Client ID Metadata Documents are fetched with no redirects, a 5 second timeout and a 32 KB cap. URLs with a query, and hosts that are `localhost` or an IP address, are refused.
- Access tokens are bound to this server's `/mcp` resource. The server asks Google only for `openid`, `email` and the Google Tasks scope.

The full design, with every check in order, is in [docs/design.md](docs/design.md).

To cut off Google access, remove the app at https://myaccount.google.com/permissions. To sign every client out at once, set or change `TOKEN_SECRET` and deploy again.
