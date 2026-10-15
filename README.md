# google-tasks-mcp

A Google Tasks connector for Claude. It's a remote MCP server you deploy to your own Vercel account.

## What it does

It gives Claude seven tools for your Google Tasks.

| Tool | What it does |
| --- | --- |
| `list_task_lists` | Lists your task lists. |
| `list_tasks` | Lists tasks from one list or from all of them. It can keep to tasks dated before or after a given day, and leaves out completed tasks unless asked. Open tasks come first, sorted by date, then completed ones, most recently completed first. |
| `create_task` | Adds a task with a title and, if given, notes, a date, a list and a parent task. |
| `update_task` | Changes a task's title, notes, date or status. Passing `null` as the date clears it. |
| `complete_task` | Marks a task completed. |
| `delete_task` | Deletes a task. A task assigned from Google Docs or Chat is deleted there too. |
| `create_task_list` | Adds a task list. |

Dates are `YYYY-MM-DD`. A list can be given by its id (`task_list_id`) or its title (`list`). When a tool that acts on one task isn't told which list it's in, the server looks in every list. `list_tasks` also returns tasks assigned to you from Google Docs and Chat.

It also works in scheduled and unattended Claude runs. The server keeps the Google sign-in and renews Google's access on its own, so nobody has to sign in again as long as Claude uses the connector at least once every 180 days.

## How it works

Claude signs in to this server with OAuth, and the server sends you on to Google to sign in there. It asks Google for offline access and puts Google's refresh token, encrypted, inside the token it gives Claude. There is no database. Every code and token the server hands out is encrypted with a key only the server has, and the server opens them again when Claude makes a request. A tool call becomes a call to the Google Tasks API with your Google access token. The full design is in [docs/design.md](docs/design.md).

## Set it up (your own copy)

You run your own copy, and it only lets in the Google accounts you list. Below, `YOUR-DOMAIN` is the domain your copy will run on, such as `tasks.example.com` or `your-project.vercel.app`. Once it's deployed, its home page shows the connector URL and the Google redirect URI for that domain.

You need a Google account, a Vercel account, a GitHub account, Node 22, and the Vercel and GitHub CLIs (`npm install --global vercel`, and `gh` from https://cli.github.com). Start by forking this repository, or pushing a copy of it to a repository of your own, and cloning that.

### 1. Google Cloud

1. In https://console.cloud.google.com, create a project.
2. Under APIs & Services, Library, find the Google Tasks API and enable it.
3. Under APIs & Services, OAuth consent screen (Google Auth Platform), set up the consent screen. Give it a name, such as Google Tasks for Claude, and your email. Choose External as the audience.
4. Under Audience, choose Publish app, so the publishing status is In production. In Testing, Google expires the sign-in every 7 days. As the only user you don't need Google's verification, but when you sign in Google will warn that it hasn't verified the app. Choose Advanced, then Go to (your app's name).
5. Under Clients, create a client of type Web application. Add `https://YOUR-DOMAIN/oauth/google/callback` under Authorized redirect URIs. Save the client ID and the client secret.

If Google asks for a home page and a privacy policy, use `https://YOUR-DOMAIN/` and `https://YOUR-DOMAIN/privacy`.

### 2. Vercel

In your clone's folder, create the Vercel project without connecting Git:

```bash
vercel login
vercel link
```

Choose Create new project, give it a name, keep the default settings, and answer no when it asks to connect the Git repository. Don't pass `--yes` to `vercel link`, because that connects the repository. Deploys come from GitHub Actions instead. If the project did get connected, disconnect it in the project's Settings, under Git.

Set the three required settings for Production. Each command asks for the value:

```bash
vercel env add GOOGLE_CLIENT_ID production
vercel env add GOOGLE_CLIENT_SECRET production
vercel env add ALLOWED_EMAILS production
```

To use your own domain, add it in the project's Settings, under Domains, and follow the DNS instructions there. Claude has to reach the server without Vercel's own sign-in. Vercel's default Deployment Protection leaves a custom domain public. If you use the `.vercel.app` domain and it asks you to log in to Vercel, turn off Vercel Authentication under Settings, Deployment Protection.

### 3. GitHub

In a fork, open the Actions tab once and enable workflows.

Then add a token from https://vercel.com/account/settings/tokens as the secret `VERCEL_TOKEN`, and the two ids from `.vercel/project.json` (written by `vercel link`) as variables. Run these in your clone's folder. If `gh` asks which repository you mean, choose your own.

```bash
gh secret set VERCEL_TOKEN
gh variable set VERCEL_ORG_ID --body "$(node -p "require('./.vercel/project.json').orgId")"
gh variable set VERCEL_PROJECT_ID --body "$(node -p "require('./.vercel/project.json').projectId")"
```

Optionally, set the variable `PUBLIC_URL` to `https://YOUR-DOMAIN`. After each deploy the workflow then checks that the server answers there, and prints the connector URL on the run's summary page.

```bash
gh variable set PUBLIC_URL --body https://YOUR-DOMAIN
```

Every push to `main` runs the checks and then deploys. To deploy without a new commit, open Actions, Deploy, Run workflow, or run `gh workflow run deploy.yml --ref main`. When it's done, open `https://YOUR-DOMAIN/`. The home page says whether every setting has a value.

### 4. Claude

1. In Claude, open Customize, then Connectors, and choose Add custom connector.
2. Give it a name, such as Google Tasks, and paste `https://YOUR-DOMAIN/mcp` as the server URL.
3. Under Authentication, keep Sign in now. Under OAuth client, keep Use Claude's published identity. Claude marks both Detected. Leave Request headers empty and choose Add. If your dialog shows Advanced settings instead of these choices, leave the OAuth client ID and secret empty.
4. Choose Connect. The server's page shows the address it will send you back to. Choose Continue with Google.
5. Sign in with Google. If Google says it hasn't verified the app, choose Advanced, then the Go to link. Leave the Google Tasks box ticked and choose Continue.

## Settings

Set these as environment variables in the Vercel project, for Production. A change takes effect at the next deploy.

| Setting | Required | What it is |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | OAuth client id of a Google "Web application" client |
| `GOOGLE_CLIENT_SECRET` | yes | That client's secret |
| `ALLOWED_EMAILS` | yes | Comma-separated Google accounts allowed to sign in |
| `TOKEN_SECRET` | no | Key material for sealing. Defaults to the Google client secret |
| `PUBLIC_URL` | no | Fixes the public origin, such as `https://tasks.example.com`. Defaults to the request's host |

`GOOGLE_AUTH_URL`, `GOOGLE_TOKEN_URL`, `GOOGLE_REVOKE_URL` and `GOOGLE_TASKS_API_URL` point the server at a stand-in Google for local end-to-end testing. Never set them in production.

## Security

- Only the Google accounts in `ALLOWED_EMAILS` can sign in. Removing an address and deploying again cuts that account off.
- Before sending you to Google, the server shows a consent page with the address it will send you back to. The page names the app by a host name, not by a name the app picked for itself. If you don't know the address, close the page, because Cancel also sends you to that address.
- Nothing is stored. Every client id, code and token the server issues is encrypted with a key only the server has, and Google's refresh token only exists inside the token Claude holds.
- To cut off Google access, remove the app at https://myaccount.google.com/permissions. To sign every client out at once, set or change `TOKEN_SECRET` and deploy again.
- Having no database has two costs. An authorization code can be used more than once in its 2 minutes, and an old refresh token keeps working until it expires after a new one replaces it.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limits

- The Google Tasks API stores a task's date with no time of day.
- The separate deadline that the Google Tasks app shows isn't available through the API, so a deadline that differs from a task's date goes in its notes.
- Recurring tasks can't be created through the API.

## Local development

```bash
npm ci
cp .env.example .env.local
```

Fill in `.env.local`. Add `http://localhost:3000/oauth/google/callback` to the Google client's Authorized redirect URIs. Then:

```bash
npm run dev
npm test
```

The server runs at http://localhost:3000. The tests never call Google. To try a full sign-in, add the local server to Claude Code with `claude mcp add --transport http google-tasks http://localhost:3000/mcp` and sign in from `/mcp`.

## License

MIT. See [LICENSE](LICENSE).
