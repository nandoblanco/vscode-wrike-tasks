# Changelog

## 1.7.0 (2026-10-26)

- Split the Wrike sidebar into two views: `Recent & Starred (20)` (`wrikeTasks.recentView`, flat list of up to 20 recently modified active tasks with starred tasks pinned first) and `Clients` (`wrikeTasks.view`, `Client -> Workflow Status -> Task` tree with starred clients at the top).
- Added task and client starring (`wrikeTasks.starTask`, `wrikeTasks.unstarTask`, `wrikeTasks.starClient`, `wrikeTasks.unstarClient`) in the sidebar and a `★ Starred` / `☆ Star Task` toggle button in the Task Detail pane.
- Added in-flight request deduplication (`inflightLoadPromise`) so both sidebar views share a single Wrike API load.
- Added Marketplace extension icon (`media/icon.png`) and `CHANGELOG.md`.

## 1.6.2 (2026-10-26)

- Updated `@mention` autocomplete and comment parser to keep the popup open across spaces for multi-word contact names (`@FirstName LastName`) and resolve typed full names case-insensitively when not clicked from the dropdown.

## 1.6.1 (2026-10-26)

- Decoded HTML entities (`&#64;` -> `@`) inside Wrike `<a class="stream-user-id">` tags in the Task Detail webview and exported Markdown.
- Renamed Markdown export button and command to `Copy in Markdown` and fixed multi-task state tracking on the reusable Task Detail webview panel.

## 1.6.0 (2026-10-26)

- Added `Copy in Markdown` (`wrikeTasks.copyMarkdown`) in the Task Detail pane and sidebar tree items to copy task metadata, HTML description, and comments as Markdown.

## 1.5.0 (2026-10-26)

- Added custom workflow status selector (`PUT /tasks/{id}`) and comment composer (`POST /tasks/{id}/comments`) with `@mention` autocomplete (`@FirstName LastName`, `@assignees`, `@followers`).

## 1.4.0 (2026-10-26)

- Added stem- and typo-tolerant fuzzy search (plural/singular stemming, bounded Damerau-Levenshtein edit distance, and subsequence matching) indexing task title, immediate client, ancestor folders, workflow status, and brief description.

## 1.3.0 (2026-10-26)

- Added QuickPick task search (`wrikeTasks.search`), live sidebar filtering (`wrikeTasks.filterTree`), and persistent task/client sorting (`wrikeTasks.sortTasks`).

## 1.2.0 (2026-10-26)

- Grouped tasks into a 3-level `Client (Project / Folder) -> Workflow Status -> Assigned Tasks` hierarchy using `GET /folders/{folderIds}`.

## 1.1.0 (2026-10-26)

- Added Wrike OAuth 2.0 (`https://localhost` redirect URI + automatic `refresh_token` rotation) for users who sign in with Google or company SSO.

## 1.0.0 (2026-10-26)

- Initial release with Wrike API v4 integration, assigned task filtering, workflow status grouping, and Task Detail webview showing description and comments.
