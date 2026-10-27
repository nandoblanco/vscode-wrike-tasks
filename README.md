# Wrike Tasks

**Wrike REST API v4 task manager extension for VS Code**: browse your assigned tasks in a split Activity Bar (`Recent & Starred (20)` and `Clients`), star tasks and client folders, run stem- and typo-tolerant fuzzy searches, update custom workflow statuses, post `@mention` comments, and copy any task's description and comment thread as Markdown.

## Background

When your tasks live in Wrike and your code lives in VS Code, managing daily project work across both tools introduces three recurring friction points:

1. **Constant editor-to-browser context switching**: Checking a due date, reading a technical spec in a task description, or catching up on a comment thread requires leaving VS Code and hunting through open browser tabs.
2. **Noisy shared folder trees and buried subtasks**: Shared client folders in Wrike mix your assigned tasks with items owned by other teammates, completed work, and subtasks nested several levels below the parent client project folder (`WsRoot` in `parentIds`).
3. **SSO authentication barriers and HTML copy noise**: Teams that sign in to Wrike via Google or corporate SSO cannot use Wrike's password-gated *Obtain token* button, and copying task descriptions or `@mention` comment threads out of the web UI loses formatting and context.

`wrike-tasks` brings your assigned Wrike queue directly into VS Code:

1. **Assigned-only queue with ancestor client resolution**: Queries `GET /tasks?responsibles=[me.id]` and walks `parentIds` and `superParentIds` so every task and nested subtask is grouped under its real client project folder in a split Activity Bar (`Recent & Starred (20)` and `Clients`).
2. **OAuth 2.0 (Google / SSO) and OS keychain storage**: Supports both Wrike OAuth 2.0 (`https://localhost` redirect flow with automatic `refresh_token` rotation) and Permanent Access Tokens stored in `context.secrets`.
3. **In-editor triage and 1-click Markdown export**: Update custom workflow statuses (`PUT /tasks/{id}`), post comments with `@mention` autocomplete (`POST /tasks/{id}/comments`), or copy the full task metadata, description, and comment thread to your clipboard as GitHub-flavored Markdown.

## Features

| Feature | Details |
| :--- | :--- |
| Assigned tasks only (`loadMyTasks`) | Queries `GET /tasks?responsibles=[me.id]&status=Active&subTasks=true` and verifies `task.responsibleIds` so only tasks and subtasks assigned to you appear. |
| Split sidebar: `Recent & Starred (20)` + `Clients` | Top pane lists up to 20 recently modified active tasks (`Client • Status` inline) with starred tasks pinned first; bottom pane groups all tasks into `Client -> Workflow Status -> Task` with starred clients at the top. |
| Task & client starring | Star or unstar any task or client from its hover icon, right-click menu, or the `★ Starred` / `☆ Star Task` button in the Task Detail pane. Persisted in `context.globalState`. |
| Stem- & typo-tolerant fuzzy search | Searches task titles, immediate client names, ancestor folder titles (`parentIds` + `superParentIds`), workflow status names, and brief descriptions. Matches singular/plural stems (`alerts` <-> `alert`), multi-word queries (`butte alerts`), and 1-2 character typos. |
| Task & client sorting | Sort tasks by Due Date, Updated Date, Importance, Title, or Created Date, and sort client folders alphabetically, by soonest due date, or by task count. |
| Custom workflow status updates | Change a task's status (`PUT /tasks/{id}`) from the Task Detail dropdown or from the sidebar tree item actions. |
| Comment composer with `@mentions` | Post comments (`POST /tasks/{id}/comments`) with `@mention` autocomplete for workspace contacts (`@FirstName LastName`), `@assignees`, and `@followers` using Wrike's `<a class="stream-user-id avatar" rel="...">` syntax. |
| `Copy in Markdown` (`copyTaskMarkdownById`) | Copies task metadata, HTML description, and all comments (with decoded `@mentions`, links, lists, code blocks, blockquotes, and tables) to the clipboard as GitHub-flavored Markdown. |
| OAuth 2.0 & Permanent Token auth | Supports Wrike OAuth 2.0 (`https://localhost` redirect flow with automatic `refresh_token` rotation) and Permanent Access Tokens stored in the OS keychain (`context.secrets`). |

## Installation

### Option 1: Install from VSIX (Recommended)

```bash
code --install-extension wrike-tasks-1.7.0.vsix
```

For VS Code Insiders:

```bash
code-insiders --install-extension wrike-tasks-1.7.0.vsix
```

### Option 2: Package from Source

```bash
cd wrike-tasks
npx @vscode/vsce package
code --install-extension wrike-tasks-1.7.0.vsix
```

## Step-by-Step Setup

First, create a Wrike API app in your Wrike workspace under **Apps & Integrations -> API -> Create new**. You can then sign in with OAuth 2.0 (recommended for Google or SSO accounts) or a Permanent Access Token.

### Method 1: Wrike OAuth 2.0 (Google / SSO) (Recommended)

1. On your Wrike API app page under **OAuth**, set **Redirect URI** to `https://localhost` and click **Save**.
2. Copy your app's **Client ID** and **Secret key**. You can optionally save your Client ID in VS Code Settings (`wrikeTasks.oauthClientId`) so it is pre-filled next time.
3. Open the **Wrike Tasks** sidebar in VS Code and click the **Sign In with OAuth (Google / SSO)** icon in the sidebar header (or run `Wrike: Sign In with OAuth (Google / SSO)` from the Command Palette).
4. Enter your **Client ID** and paste your **Secret key**.
5. Your browser opens `https://login.wrike.com/oauth2/authorize/v4?...`. Sign in with Google or SSO and click **Accept**.
6. Wrike redirects the browser to `https://localhost/?code=...`. Because no local server needs to run on port 443, the browser will show `This site can't be reached` (that is expected). Copy the `https://localhost/?code=...` URL from the address bar (or just the `code` parameter) and paste it into the VS Code input box.
7. The extension exchanges the code for an `access_token` and `refresh_token`, saves them in `context.secrets`, and refreshes expired tokens automatically.

### Method 2: Permanent Access Token

1. On your Wrike API app page, scroll to **Permanent Access Token** and click **Obtain token**.
2. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), run `Wrike: Set Permanent Access Token`, and paste the token.

## Usage

### 1. Split Sidebar (`Recent & Starred (20)` and `Clients`)

**Recent & Starred (20)** sits at the top of the Wrike sidebar. It lists up to 20 active (non-completed, non-cancelled) tasks assigned to you, with starred tasks pinned at the top and the remaining slots filled by your most recently updated active tasks (`updatedDate` descending). Each row shows `Client • Workflow Status • Due Date` inline so you can scan recent work without expanding folders.

**Clients** sits below it and groups your full queue into a 3-level tree: `Client (Project / Folder) -> Workflow Status -> Task`. Starred clients float to the top of the client list, and starred tasks float to the top of their status group.

To star or unstar a task or client, click the star icon (`☆` / `★`) that appears on hover in either sidebar pane, use the right-click context menu, or click **☆ Star Task** / **★ Starred** in the top bar of the Task Detail pane.

### 2. Searching, Filtering, and Sorting

Click the magnifying glass (`$(search)`) in the sidebar header to run `Wrike: Search My Tasks`. The QuickPick matches singular and plural stems (`alerts` matches `alert`), client + keyword queries (`butte alerts`), status names (`in progress`), and 1-2 character typos (`navgation`). Pressing `Enter` opens the selected task.

To filter the sidebar tree in place, click the funnel icon (`$(filter)`) and type a query; click `$(clear-all)` (or the filter banner at the top of the tree) to clear the filter. Click `$(list-ordered)` (`Wrike: Sort Tasks & Clients`) to change the task sort order (Due Date, Last Updated, Importance, Title A-Z, Created Date) or the client folder sort order (Alphabetical A-Z, Soonest Task Due Date, Most Assigned Tasks).

### 3. Updating Status & Posting `@mention` Comments

Clicking a task opens the **Task Detail** webview pane. Use the **Workflow Status** `<select>` dropdown in the metadata grid (or click the status icon on a task row in the sidebar) to update the task's custom status in Wrike (`PUT /tasks/{id}`).

To post a comment, type in the **Add a comment** box at the bottom of the pane. Typing `@` opens an autocomplete popup for workspace contacts (`@FirstName LastName`), `@assignees`, and `@followers`. Use `Up`/`Down` and `Enter`/`Tab` to pick a contact, or type the full `@FirstName LastName` directly; the parser resolves matching full names even if you do not select from the popup. Press `Ctrl+Enter` (`Cmd+Enter`) or click **Post Comment** to send.

### 4. Exporting Tasks with `Copy in Markdown`

Click **Copy in Markdown** in the top bar of the Task Detail pane (or click the Markdown icon `$(markdown)` on any task row in the sidebar) to copy the task metadata, description, and comment thread to your clipboard:

```markdown
# Wrike Task: Task Title

- **Client / Project:** Client Name
- **Status:** In Progress (Active)
- **Importance:** High
- **Assigned To:** Your Name
- **Start Date:** Oct 20
- **Due Date:** Oct 28
- **Updated:** Oct 25, 2026, 2:15 PM
- **Permalink:** https://www.wrike.com/open.htm?id=...

## Description

Full task description converted from Wrike HTML to Markdown...

## Comments (1)

### 1. Author Name (Oct 25, 2026, 2:15 PM)

**@FirstName LastName** Please check the mobile navigation breakpoint...
```

## Commands Reference

| Command | ID | UI Location | Description |
| :--- | :--- | :--- | :--- |
| `Wrike: Search My Tasks` | `wrikeTasks.search` | Sidebar Header, Command Palette | Opens a fuzzy-search QuickPick across task titles, client/ancestor folders, statuses, and descriptions. |
| `Wrike: Filter Sidebar Tasks` | `wrikeTasks.filterTree` | Sidebar Header, Command Palette | Filters both sidebar views in place using the cached task list. |
| `Wrike: Clear Sidebar Filter` | `wrikeTasks.clearFilter` | Sidebar Header, Command Palette | Clears the active sidebar filter. |
| `Wrike: Sort Tasks & Clients` | `wrikeTasks.sortTasks` | Sidebar Header, Command Palette | Sets task sort order and client folder sort order (`context.globalState`). |
| `Wrike: Star Task` | `wrikeTasks.starTask` | Tree Item Inline, Context Menu | Pins a task to the top of `Recent & Starred (20)` and its status group. |
| `Wrike: Unstar Task` | `wrikeTasks.unstarTask` | Tree Item Inline, Context Menu | Removes the star from a task. |
| `Wrike: Star Client` | `wrikeTasks.starClient` | Tree Item Inline, Context Menu | Pins a client project/folder to the top of the `Clients` pane. |
| `Wrike: Unstar Client` | `wrikeTasks.unstarClient` | Tree Item Inline, Context Menu | Removes the star from a client project/folder. |
| `Wrike: Copy in Markdown` | `wrikeTasks.copyMarkdown` | Detail Pane, Tree Item Inline & Context Menu | Copies task metadata, description, and comments to the clipboard as Markdown. |
| `Wrike: Change Task Status` | `wrikeTasks.changeStatus` | Detail Pane, Tree Item Inline & Context Menu | Updates the task's custom workflow status in Wrike (`PUT /tasks/{id}`). |
| `Wrike: Add Comment to Task` | `wrikeTasks.addComment` | Detail Pane, Tree Item Context Menu | Posts a comment with `@mention` support to the task (`POST /tasks/{id}/comments`). |
| `Wrike: View Task Details` | `wrikeTasks.openTaskDetail` | Tree Item Click, Command Palette | Opens the Task Detail webview pane. |
| `Wrike: Open Task in Browser` | `wrikeTasks.openInBrowser` | Detail Pane, Tree Item Inline & Context Menu | Opens the task's Wrike permalink in your default browser. |
| `Wrike: Copy Task Permalink` | `wrikeTasks.copyLink` | Detail Pane, Tree Item Inline & Context Menu | Copies the task's Wrike permalink to the clipboard. |
| `Wrike: Refresh My Tasks` | `wrikeTasks.refresh` | Sidebar Header, Command Palette | Reloads contacts, workflows, folders, and assigned tasks from Wrike API v4. |
| `Wrike: Sign In with OAuth (Google / SSO)` | `wrikeTasks.signInOAuth` | Sidebar Header, Command Palette | Runs the Wrike OAuth 2.0 authorization-code flow and saves credentials in `SecretStorage`. |
| `Wrike: Set Permanent Access Token` | `wrikeTasks.setToken` | Sidebar Menu, Command Palette | Saves a Wrike Permanent Access Token in `SecretStorage`. |
| `Wrike: Clear API Token` | `wrikeTasks.clearToken` | Sidebar Menu, Command Palette | Clears stored Wrike credentials from `SecretStorage`. |

## How It Works (Architecture & Internals)

### 1. Keychain Storage & OAuth 2.0 Token Refresh (`getValidAuth`, `refreshOAuthToken`, `wrikeRequest`)

Credentials live in VS Code's OS keychain (`context.secrets`) under two keys: `wrikeTasks.oauth` (JSON containing `{ accessToken, refreshToken, expiresAt, host, clientId, clientSecret }`) and `wrikeTasks.token` (plain Permanent Access Token fallback).

Before each API call, `getValidAuth()` checks the stored OAuth session. When an `accessToken` is saved, `expiresAt` is set with a 60-second safety buffer (`Date.now() + Number(data.expires_in || 3600) * 1000 - 60000`). Once `Date.now() >= oauth.expiresAt`, `refreshOAuthToken(oauth)` posts `grant_type=refresh_token` to `https://${tokenHost}/oauth2/token` (deduplicated behind `inflightRefreshPromise`), writes the rotated `access_token` and `refresh_token` back to `context.secrets`, and continues the request. If `wrikeRequest()` hits an unexpected `HTTP 401` mid-session, it runs one `refreshOAuthToken()` retry automatically before failing.

### 2. Metadata Caching, Ancestor Client Resolution & Inflight Deduplication (`ensureMetadata`, `loadMyTasks`, `resolveClientInfo`)

Both `wrikeTasks.recentView` and `wrikeTasks.view` call `loadMyTasks()` when the sidebar opens. An `inflightLoadPromise` lock deduplicates concurrent calls so startup and manual refreshes trigger a single API load cycle:

1. `ensureMetadata()` fetches `GET /contacts` and `GET /workflows` in parallel once per session, finds the authenticated user via `contact.me === true`, populates `contactsById` (`Map<userId, fullName>`), and builds `activeContactsList` (active `Person` contacts with `id`, `name`, `email`) for `@mention` autocomplete. It also indexes every custom status into `statusesById` (`id`, `name`, `group`, `color`, `workflowId`, `workflowName`, `hidden`, `order`).
2. `loadMyTasks()` queries:
   ```text
   GET /tasks?responsibles=["<me.id>"]&status=Active&subTasks=true&sortField=UpdatedDate&sortOrder=Desc&fields=["responsibleIds","briefDescription","parentIds","superParentIds","superTaskIds"]
   ```
   Each returned task is verified against `task.responsibleIds.includes(cachedMe.id)`.
3. In Wrike, subtasks often list the workspace root (`WsRoot`, title `"Root"`) in `parentIds` while the parent task's client project folder sits in `superParentIds`. `ensureFoldersForTasks()` collects all unique IDs from both `parentIds` and `superParentIds` and fetches uncached folders in batches of 100 via `GET /folders/{id1,id2,...}`. `resolveClientInfo(task)` then picks the first non-root, non-space folder across `parentIds` and `superParentIds`, falls back to any non-root space folder, and defaults to `"Other / Unfiled"`.

### 3. Split Sidebar Providers & Star Pinning (`WrikeRecentTreeProvider`, `WrikeTreeProvider`, `getRecentAndStarredTasks`)

Starred task IDs (`wrikeTasks.starredTaskIds`) and starred client folder IDs (`wrikeTasks.starredClientIds`) are stored in `context.globalState` and mirrored in `Set` instances (`starredTaskIds`, `starredClientIds`).

`WrikeRecentTreeProvider` calls `getRecentAndStarredTasks(tasks, 20)`, which filters out `Completed` and `Cancelled` status groups (`isTaskActiveNotCompleted`), applies any active sidebar filter query, sorts starred tasks first (`updatedDate` descending within starred and unstarred buckets), and slices the first 20 items. Each item sets `contextValue` to `wrikeTaskStarred` or `wrikeTask` so the inline hover action switches between `$(star-full)` and `$(star-empty)`.

`WrikeTreeProvider` builds the `Client -> Workflow Status -> Task` tree. `groupTasksByClientAndStatus(tasks)` sorts starred clients to the top before applying the chosen client sort mode (`alpha`, `soonestDue`, `mostTasks`), and `compareTasks(a, b)` sorts starred tasks to the top of each status group before applying the task sort mode (`dueDate`, `updatedDate`, `importance`, `title`, `createdDate`). Toggling a star, changing sort order, or filtering the tree calls `rerenderLocal()`, which fires `onDidChangeTreeData` on both views from `cachedTasks` in memory without hitting the network.

### 4. Stem- & Typo-Tolerant Fuzzy Search (`stemWord`, `boundedEditDistance`, `scoreSingleTerm`, `scoreTaskMatch`)

The search engine indexes four fields per task (`getTaskSearchFields`, cached in `taskSearchIndexCache`): task title (`title`), immediate client and ancestor folder titles (`clientText` via `getAllFolderTitles`), workflow status label (`statusName`), and `briefDescription` (`brief`), plus tokenized words (`words`) and stems (`wordStems`).

`stemWord()` strips common English plural and verb suffixes (`-ies` -> `-y`, `-ing`, `-ed`, `-es`, `-s`) so `alerts` and `alert` reduce to the same stem. `boundedEditDistance(a, b, maxDist)` computes Damerau-Levenshtein distance with adjacent character transpositions (`ab` <-> `ba`) and row-minimum early exit, allowing distance `<= 1` on 4-5 character words and `<= 2` on 6+ character words.

When scoring a query, `scoreTaskMatch(task, query)` tokenizes the query with `tokenizeWords(rawQuery)`. Every query term must match at least one indexed field on the task (`termScore > 0`), so `butte alerts` matches when `butte` is in the client folder name and `alerts` is in the task title:

| Match Tier | Score (`scoreSingleTerm`) | Condition |
| :--- | :--- | :--- |
| Exact substring in Title or Client/Folder | `120` | `fields.title` or `fields.clientText` contains `qTerm` |
| Stem substring in Title or Client/Folder | `105` | `qStem.length >= 2` and `fields.title` or `fields.clientText` contains `qStem` |
| Exact substring in Status or Brief Description | `95` | `fields.statusName` or `fields.brief` contains `qTerm` |
| Tokenized word stem match | `90` | `wStem === qStem` or stem containment (`wStem.length >= 3`) |
| Stem substring in Status or Brief Description | `85` | `qStem.length >= 2` and `fields.statusName` or `fields.brief` contains `qStem` |
| Typo-tolerant edit distance | `65` | Damerau-Levenshtein distance `<= 1` (4-5 chars) or `<= 2` (6+ chars) on word, stem, or prefix |
| Ordered character subsequence | `45` | `isSubsequence(qTerm, w)` when `qTerm.length >= 3` |

### 5. Task Detail Webview & `@mention` Serialization (`buildTaskDetailHtml`, `buildCommentHtmlFromText`)

Opening a task creates or reuses a single `vscode.WebviewPanel` (`wrikeTasks.taskDetail`) with a per-render nonce (`crypto.randomBytes(16).toString("hex")`) and Content-Security-Policy `default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; script-src 'nonce-...'`.

Inside the webview script, `checkMentionTrigger()` tests the text before the cursor against `/(?:^|\s)@([^\r\n@]{0,45})$/`. Permitting spaces inside the capture group keeps the popup open while typing `"@FirstName LastName"`; the popup closes once the query contains more than two spaces or ends with two trailing spaces. When the user submits a comment (`POST /tasks/{taskId}/comments` with `plainText=false`), `buildCommentHtmlFromText(rawText, mentionsList)` merges contacts chosen from the popup with `activeContactsList`, sorts names longest-first, and converts `@Name`, `@assignees`, and `@followers` into Wrike's HTML anchor format while escaping surrounding text:

- Contact: `<a class="stream-user-id avatar" rel="USER_ID">@FirstName LastName</a>`
- Assignees: `<a class="stream-user-id avatar quasi-contact" rel="@assignees">@assignees</a>`
- Followers: `<a class="stream-user-id avatar quasi-contact" rel="@followers">@followers</a>`

### 6. Entity Decoding & HTML-to-Markdown Conversion (`sanitizeWrikeHtml`, `decodeHtmlEntities`, `wrikeHtmlToMarkdown`, `buildTaskMarkdown`)

Wrike's API encodes `@` as `&#64;` inside comment mention tags (`<a class="stream-user-id" rel="KUA...">&#64;FirstName LastName</a>`). `sanitizeWrikeHtml()` strips inner tags and runs `decodeHtmlEntities()` before `escapeHtml(resolvedName)` so `&#64;` and `&amp;#64;` render as `@FirstName LastName` inside `<span class="mention">` badges.

For clipboard export, `wrikeHtmlToMarkdown()` resolves `<a class="stream-user-id" rel="USER_ID">` mentions against `contactsById` and converts `<pre>`, `<code>`, `<h1>`-`<h6>`, `<strong>`, `<em>`, `<a href="...">`, `<blockquote>`, `<ul>`/`<ol>`/`<li>`, and `<table>` elements into GitHub-flavored Markdown. `buildTaskMarkdown()` combines the task metadata header (using `formatShortDate` so `YYYY-MM-DD` strings do not shift by local timezone offset), description, and numbered comment history, then writes the string to `vscode.env.clipboard.writeText()`.

## Configuration Options

```json
{
  "wrikeTasks.apiBaseUrl": "https://www.wrike.com/api/v4",
  "wrikeTasks.includeDeferred": false,
  "wrikeTasks.oauthClientId": ""
}
```

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `wrikeTasks.apiBaseUrl` | `string` | `"https://www.wrike.com/api/v4"` | Base URL for Wrike API v4 (`https://www.wrike.com/api/v4`, `https://app-eu.wrike.com/api/v4`, or `https://app-us2.wrike.com/api/v4`). OAuth 2.0 sign-in automatically uses the regional `host` returned by Wrike. |
| `wrikeTasks.includeDeferred` | `boolean` | `false` | Include Deferred (on-hold) tasks assigned to you alongside Active tasks. |
| `wrikeTasks.oauthClientId` | `string` | `""` | Default Wrike OAuth 2.0 Client ID pre-filled when running `Wrike: Sign In with OAuth (Google / SSO)`. |

## Troubleshooting

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| Wrike asks for a password when clicking *Obtain token*, but you sign in with Google/SSO | Wrike's Permanent Access Token generator requires a native Wrike password. | Use `Wrike: Sign In with OAuth (Google / SSO)` and set Redirect URI to `https://localhost` in your Wrike API app. |
| Browser shows `This site can't be reached` on `https://localhost/?code=...` during OAuth | Wrike redirects to `https://localhost` so you can copy the `code` parameter from the address bar; no local HTTPS server is needed. | Copy the `https://localhost/?code=...` URL from your browser's address bar and paste it into the VS Code prompt. |
| A task is visible in Wrike's web UI but not in the extension | The extension only loads tasks where you are in `responsibleIds` and status is `Active` (or `Deferred` when `wrikeTasks.includeDeferred` is enabled). | Assign the task to yourself in Wrike, or enable `wrikeTasks.includeDeferred` in Settings if the task is Deferred. |

## License

MIT
