# AOMC Map

A web map for a Minecraft server, built from [Xaero's World Map](https://modrinth.com/mod/xaeros-world-map) exports. Players upload exported images, the server stitches them into tiles, and everyone can browse the map, add pins, lines and areas, and travel back through the map's history. Logins are via Discord.

- Every upload is a **revision**: browse any past state on the time line, and delete a bad upload (your own for a day, any as a moderator), which erases it from the map and from all of its history.
- **Layers** of pins, lines and areas with their own history, optional private layers, JSON import/export.
- Invite links and roles (viewer, editor, moderator, owner) for the people who help maintain it.
- One TypeScript codebase on [Bun](https://bun.sh): Hono API, SQLite (Drizzle), sharp for images, and a Preact UI over a hand-written canvas map renderer.

```
server/    Hono API, SQLite schema + migrations, tile pipeline, job worker
shared/    zod schemas and the coordinate / projection math used by both sides
web/       Vite + Preact app; the map engine in web/src/map is framework-free canvas2D
scripts/   backup, blob garbage collection, v1 importer
```

## Quick start with Docker

1. **Create a Discord application** at <https://discord.com/developers/applications>. Under _OAuth2_ add the redirect URI `<PUBLIC_URL>/auth/discord/callback` (for example `http://localhost:3000/auth/discord/callback`) and note the client id and secret.
2. **Configure**:

   ```bash
   cp .env.example .env
   # fill in DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, PUBLIC_URL, a random SESSION_SECRET
   # (required: the container refuses to start with the dev default),
   # and SETUP_OWNER_DISCORD_IDS (your own Discord user id)
   mkdir -p data && chown 1000:1000 data   # the container runs as uid 1000
   ```

   To get your Discord user id: enable _Developer Mode_ in Discord's settings, then right-click yourself and choose _Copy User ID_.
3. **Run**:

   ```bash
   docker compose up -d --build
   docker compose logs -f
   ```
4. Open `PUBLIC_URL`, log in with Discord, and you are an owner of the map (**Manage** appears in the hotbar at the bottom). Upload some exports with **Upload**.

The first start creates the map with the dimensions Overworld, Nether and The End. Everything lives in `./data` (`db.sqlite` and `blobs/`), which is the only thing you need to back up. Migrations run automatically on boot, so upgrading is `git pull && docker compose up -d --build`.

> The `:z` on the volume in `docker-compose.yml` relabels the directory for SELinux hosts and is harmless elsewhere.

### Behind a reverse proxy

Set a long random `SESSION_SECRET` (the container runs with `NODE_ENV=production`, so the server refuses to start with the built-in dev value). Terminate TLS in front of the container and set `PUBLIC_URL` to the public `https://` address (cookies are only marked `Secure` for https, and the CSRF check compares the `Origin` header to `PUBLIC_URL`). Two proxy settings matter:

- Allow request bodies of at least `MAX_UPLOAD_BYTES` (200 MB by default). For nginx: `client_max_body_size 200m;`.
- Do not buffer server-sent events (`/api/revisions/<id>/events`). For nginx: `proxy_buffering off;` on that location (or the whole server).

## Local development

```bash
bun install
cp .env.example .env      # Discord credentials are only needed to log in
bun run dev               # API on :3000, restarts on change
bun run dev:web           # Vite dev server with hot reload; proxies /api, /auth, /blobs and /scalar to :3000 (set `BACKEND_URL` to proxy elsewhere)
```

| Command               | What it does                                                 |
| --------------------- | ------------------------------------------------------------ |
| `bun test`            | all tests (server, shared, web logic, scripts)               |
| `bun run lint`        | Biome (formatting and lint)                                  |
| `bun run typecheck`   | `tsc` for every package                                      |
| `bun run build`       | production web build into `web/dist` (served by the server)  |
| `bun run db:generate` | generate a migration after editing `server/src/db/schema.ts` |

Coming from Node: `npm install` is `bun install`, `npm run x` is `bun run x`, `npx tool` is `bunx tool`, and `npm test` is `bun test`.

## Configuration

All settings are environment variables (see `.env.example`).

| Variable                                     | Default                       | Meaning                                                                                                                                                          |
| -------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |                               | Discord OAuth credentials                                                                                                                                        |
| `SESSION_SECRET`                             | dev value                     | signs the OAuth state cookie (at least 16 characters); required when `PUBLIC_URL` is https and in Docker (`NODE_ENV=production`), where the dev value is refused |
| `PUBLIC_URL`                                 | `http://localhost:3000`       | public address; used for cookies, the Origin check, invite links and previews                                                                                    |
| `SETUP_MAP_NAME`                             | `AOMC`                        | name of the map created on first boot                                                                                                                            |
| `SETUP_OWNER_DISCORD_IDS`                    |                               | comma-separated Discord ids that become owners when they first log in; only read on the first boot, when the map is created (use _Manage → Members_ later)       |
| `PORT`                                       | `3000`                        | listen port; `docker-compose.yml` publishes the same port on the host                                                                                            |
| `DATA_DIR`                                   | `./data`                      | database, blobs, preview cache (`/data` in Docker)                                                                                                               |
| `WEB_DIST`                                   | `web/dist`                    | built web app the server serves                                                                                                                                  |
| `BACKEND_URL`                                | `http://localhost:3000`       | only for `bun run dev:web`: where the Vite dev server proxies to                                                                                                 |
| `DEFAULT_TILE_SIZE`                          | `512`                         | blocks per tile edge; fixed when the map is created on first boot                                                                                                |
| `MAX_ZOOM`                                   | `8`                           | zoom-out levels above 1:1; set it before the first upload and keep it, as existing tiles' zoom-out levels are not rebuilt when it changes                        |
| `MAX_UPLOAD_BYTES`                           | 200 MB                        | per upload request                                                                                                                                               |
| `MAX_IMAGE_DIM`                              | `4096`                        | longest edge of one uploaded image                                                                                                                               |
| `MAX_FILES_PER_UPLOAD`                       | `2000`                        | files per request                                                                                                                                                |
| `UPLOAD_RATE_LIMIT`                          | `30`                          | upload requests per user per minute                                                                                                                              |
| `SELF_DELETE_WINDOW_HOURS`                   | `24`                          | hours after uploading that the uploader may delete their own upload (`0`: moderators only)                                                                       |
| `PREVIEW_CACHE_MAX`                          | `500`                         | link-preview images kept on disk                                                                                                                                 |
| `MOD_USER_AGENTS`                            | `AOMC Webmapper,AOMC Visited` | User-Agents (comma separated, `*` wildcard) that mark an upload as sent by the in-game mod                                                                       |

## Using the map

**Viewer.** `/?dim=<slug>&x=&z=&zoom=&rev=` is kept in the address bar, so every view is a shareable link (`rev` is omitted at the latest revision). `embed=1` hides all UI for iframes. Zoom 0 is one block per pixel, negative zooms in (down to -8, 256 pixels per block), positive zooms out. Drag or touch to pan, wheel or pinch to zoom, double-click to zoom in, arrow keys and `+`/`-`. The hotbar at the bottom holds _Layers_, _History_, _Measure_ (click points to measure a path; Shift snaps to straight lines, Esc clears), _Upload_, _Share_ (a short link `/s/<code>` to the place, zoom, dimension, revision and layers you are looking at) and, for moderators, _Manage_; the number keys 1 to 6 select them. A `layers=1,2,3` parameter shows only those layers of the dimension (`layers=` shows none); short links use it. Double-click the current dimension's tab to go back to 0, 0. Right-click (or long-press) the map for a menu to copy the coordinates or a waypoint, measure from there, or drop a pin into a new or existing layer; clicking or right-clicking a feature opens its popup, which has the same copy and measure actions. _Copy waypoint_ copies Xaero's Minimap chat text (`xaero-waypoint:Name:N:x:~:z:colour:false:0:Internal-dim%0`); pasted in Minecraft chat it becomes a waypoint others can click. The height is `~` since the map only knows x and z.

**Uploading.** Use _Upload_ in the hotbar, or the API (below). In Xaero's World Map: turn resource packs off, drag with the right mouse button over an area, export as PNG with **Multiple Unscaled Images** on, then upload the images (or a ZIP of them). File names contain `_x<X>_z<Z>` (the block coordinates of the top-left corner). Pure black pixels mean "no data" and never overwrite anything. Processing runs in a background queue, one job at a time; you can close the dialog while it works. Uploads from the in-game mod (AOMC Webmapper, or AOMC Visited in older versions) are recognised by its `User-Agent` header (see `MOD_USER_AGENTS`) and counted in one separate statistic as well as in the normal ones. Anyone can send that header, so treat the number as a statistic, not proof; uploads made before this was tracked are not marked.

**Old exports.** Xaero names every export with the time it was made (`2026-02-10_15.06.41_x-384_z-3776.png`, or a folder `2026-02-10_15.06.41/` holding the tiles). The upload reads that date from the file or folder name (the dialog accepts whole folders, and ZIPs with folders inside), makes one revision per export, and layers the exports by date: where they overlap, the newest export is on top however late it was uploaded, so importing an old export only fills in what is missing and never covers newer data. Files with no date count as made at upload time. The history panel shows the export date next to the upload time. Dates are used as written in the name (no time zone), and one from the future counts as now.

**Layers and features.** The _Layers_ panel toggles visibility and creates layers. "Add feature" opens the editor: click the map to place points, drag a point to move it, Enter or _Finish_ to complete, Esc to cancel. Popups support `**bold**`, `[links](https://…)` and line breaks, and are rendered as text, never HTML. Layers can be exported and imported as JSON (an array of `{type, name, popup, color, geometry}`; pins have `[x, z]`, lines and areas `[[x, z], …]`, integers within ±30,000,000, at most 5000 features per layer).

**History.** The _History_ panel shows the uploads of the dimension being viewed: a time line (tiles and features both follow it) and the upload log below it, grouped by day. The time line places each upload at its export date (or its upload date if the files carry none), squeezing long quiet stretches; click or drag on it to look at the map as of that moment, use the wheel or _+_/_−_ to zoom and drag the dates to pan, and step with the arrow keys (Home/End for the first upload and the latest, Esc for the latest). The map at a point always contains every upload published before it, so an old export uploaded after newer ones is marked _late_: looking at it also shows those newer exports. _Everything_ lists all of the dimension's uploads, _In view_ only those whose area overlaps what the camera sees, and _Mine_ only your own. Hover a marker or an entry to highlight the other and outline its area; click an entry to look at it. While looking at the past editing is off. Every upload in the log has an **Isolate** button that shows only what that upload added, with the rest of the map hidden ; _Show everything_, or moving on the time line, goes back. You can **Delete** your own uploads for `SELF_DELETE_WINDOW_HOURS` (24 by default) after uploading them, and moderators can delete any upload. This is permanent: the upload disappears from the current map, from every past revision on the time slider and from the log, and it cannot be restored (upload the files again to bring it back). Other uploads keep their revision numbers, so there is a gap (or, if it was the newest, the head moves back). Most deletes are of a recent mistake and touch few tiles, because only the tiles the upload covered are rewritten, and only from its revision onwards. Deleting runs in the background queue; the entry shows _deleting…_ until it is done. Uploads that were reverted by older versions of the server stay hidden and can be deleted too. Feature popups have a _History_ button, and moderators can restore an earlier version of a feature (to bring back a deleted one, slide to a revision where it existed, open its popup, and restore).

**Dimensions and scale.** A dimension's scale is how many overworld blocks one of its blocks covers: 1 for the Overworld, 8 for the Nether, and none for the End, whose coordinates don't correspond to anything. Switching between dimensions that have a scale keeps showing the same place (Overworld → Nether divides the coordinates by 8 and zooms in three levels), and the coordinate readout shows the overworld equivalent of the cursor while you are in a scaled dimension. Switching to or from a dimension without a scale can't map anything, so the view returns to wherever you last were in that dimension (its origin the first time). Scales are set in _Manage → Dimensions_; existing installs get the usual values for the standard dimension names when they upgrade.

**Roles.** The map is public. Anonymous visitors can look; anyone logged in is an _editor_ and can upload and edit. _Moderators_ can also delete anyone's uploads, restore features, manage dimensions and see every private layer; _owners_ can also manage members, invites and settings. Moderators and owners are granted explicitly (members panel, invite link or `SETUP_OWNER_DISCORD_IDS`). There is exactly one map, created on first boot.

**Managing the map** (_Manage_ in the hotbar):

- _Settings_: the map name.
- _Dimensions_: add, rename, reorder, archive, and set the theme (Overworld, Nether or End), which picks the dimension's block icon and the interface colours while it is shown, and the _Xaero id_ used in copied waypoints (`dim%0` Overworld, `dim%-1` Nether, `dim%1` End; guessed from the theme). Archived dimensions keep their tiles and history.
- _Members_: make someone a moderator or owner by Discord user id (they must have logged in once), change roles, or remove people. The last owner can't be demoted or removed.
- _Invites_: links that make the person a moderator, with an expiry and an optional use limit. The link is shown once and only a hash is stored. `/invite/<token>` shows who invited you, asks you to log in, and lands you on the map. Accepting never lowers anyone's role.

**Private layers** (a layer's visibility setting) are only visible to map moderators and the layer's members. The layer's creator and moderators get a _Sharing_ button for members and layer invite links.

## API

The full reference is rendered by [Scalar](https://scalar.com) at `/scalar`, with a selector for two documents:

- **HTTP API**, an OpenAPI 3.1 document generated from the routes and their zod schemas: `GET /api/openapi.json`.
- **Events**, an AsyncAPI 3 document for the server-sent progress events of `GET /api/revisions/:id/events`: `GET /api/asyncapi.json`.

Scalar's browser bundle is served from `node_modules` (`/scalar/standalone.js`), so the page makes no requests to third parties. Both documents can also be imported into Postman, a client generator and the like. The sections below are an overview.

Authentication is a session cookie (browser) or `Authorization: Bearer aomc_…` (scripts). Generate one on the **Settings** page (`/settings`), or with `POST /api/tokens {"name": "…", "expiresInDays": 180}` while logged in with a session (a token cannot create or revoke tokens). It is shown once, expires after 180 days unless you pick another period (`null` = never) and each user can hold 25. A token has `scopes` (default `["read", "upload", "features"]`) and can never do more than its user: `read` shows what the user sees (without it, GETs are answered as to an anonymous visitor, except `GET /api/me`); `upload` allows uploads and deleting your own; `features` allows writing layers, features, layer sharing and accepting invites; `moderate` allows moderator powers (deleting any upload, restoring features, dimensions); `manage` allows owner powers (members, map invites, map settings) and implies `moderate`. A write outside the token's scopes answers 403; tokens created before scopes existed have all of them. Writes made with a cookie must come from `PUBLIC_URL` (CSRF), Bearer requests need no such check. Errors are JSON `{"error": "…"}`; resources you may not see answer 404. A request that fails validation answers 400 `{"error": "invalid request", "issues": [{"path": […], "message": "…"}]}` (the request itself is never echoed back); malformed JSON is a 400 `{"error"}` too. JSON bodies over 16 MiB are refused with 413 (uploads have their own limit, `MAX_UPLOAD_BYTES`).

```bash
# Upload
curl -H "Authorization: Bearer aomc_…" \
  -F 'files[]=@Overworld_x-512_z0.png' -F 'files[]=@Overworld_x0_z0.png' \
  http://localhost:3000/api/dimensions/overworld/uploads
# -> {"revisionId": 1, "revisionIds": [1]}   poll GET /api/revisions/1, or stream GET /api/revisions/1/events (SSE)
```

The in-game mod is recognised by its `User-Agent` header (`MOD_USER_AGENTS`; by default `AOMC Webmapper`, and `AOMC Visited` for older versions). Such uploads are flagged `viaMod` on their revision and counted together in one statistic (`modUploads`), besides the normal ones. An upload may also carry `coords`, a JSON array of `{x, z}` aligned with the files (after ZIP expansion), which overrides the file names. ZIP entries are read by base name only for coordinates. The export date comes from the file name, from the path of an entry inside a ZIP, or from `paths`, a JSON array of strings aligned with the uploaded files (before ZIP expansion) naming where each came from, e.g. `"2026-02-10_15.06.41/0_0_x-1248_z-1472.png"`. Xaero names exports by the local time of the player's computer, so send `timeZone`, its IANA name (e.g. `Europe/Berlin`); the web client does this automatically, and without it the dates are read as UTC. An upload with several export dates creates one revision per date, oldest first (`revisionIds`, in order; `revisionId` is the last).

| Area      | Endpoints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session   | `GET /auth/discord`, `GET /auth/discord/callback`, `POST /auth/logout`, `GET /api/me`, `GET/POST/DELETE /api/tokens`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Map       | `GET/PATCH /api/map`, `POST /api/dimensions`, `PATCH /api/dimensions/:dim`, `/api/members`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Tiles     | `GET /api/dimensions/:dim/tiles/:zoom/:x/:y?rev=R` → 302 to the tile image, or 204 if empty (`?only=<upload revision id>` gives that upload's own tile instead, for finished uploads only: anything else is 404; `?format=` picks the image format, see [Tile formats](#tile-formats)); zoom 0 is 1:1 and a tile index is `floor(block / tileSize)`. `GET /api/dimensions/:dim/tiles/:zoom/hashes?minX=&minY=&maxX=&maxY=&rev=R` → `{ tiles: [{ x, y, hash }] }` for up to 4096 tiles at once (unlisted = empty), to load `/blobs/<hash>.webp` directly without a redirect per tile. Responses for `?rev=` or `?only=` are cached as immutable only when the request also carries `v=<epoch>` (`epoch` from `GET /api/map`) and it matches the current one; otherwise they are cached for a minute, because deleting an upload rewrites history and revision numbers can be reused afterwards |
| Revisions | `GET /api/revisions?dimension=&before=&limit=`, `GET /api/revisions/:id`, `…/events` (SSE), `DELETE /api/revisions/:id` (moderators, or the author within `SELF_DELETE_WINDOW_HOURS`; 202, erased in the background; `deleting` is true on the revision while the delete is queued or running, and the first SSE event of such a revision is `processing` with message `queued`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Layers    | `GET /api/layers?dim=&at=<rev>`, `POST /api/layers`, `PATCH/DELETE /api/layers/:id`, `POST /api/layers/:id/features`, `GET /export`, `POST /import[?replace=1]` (`replace=1` needs the layer's creator or a moderator)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Features  | `PATCH/DELETE /api/features/:id` (send `baseRevisionId`, the `revisionId` you last saw, to avoid overwriting someone else's edit: if the feature has a newer revision the answer is 409 `{error, feature}` with its current state), `GET …/history?limit=&before=` → `{history, nextBefore}` (newest first; pass `nextBefore` as `before` for the next page, it is null after the last), `POST …/restore/:revisionId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Sharing   | `GET/POST /api/invites` (map), `/api/layers/:id/invites`, `GET /api/invites/:token`, `POST …/accept` (a map invite is refused with 403 for a token without the `manage` scope; 410 when the invite is expired, revoked, used up, or its creator has lost the right to make it), `DELETE /api/invites/:id`, `…/layers/:id/members` (the layer's creator always has editor access, so removing or changing them is 409)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Stats     | `GET /api/stats?range=all\|30d\|7d` (public): your stats, everyone's combined, the leaderboard and the mapped area over time, including what the in-game mod sent (`modUploads`, `modUploadedBlocks`, `modAreaBlocks`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Admin     | `GET /api/admin/stats?range=1h\|6h\|24h\|7d\|30d\|90d\|all` (owners): storage over time, network traffic by kind and by requesting domain, and a server overview                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Images    | `GET /blobs/<hash>.webp` and the other [tile formats](#tile-formats), `GET /api/preview.png`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Tile formats

Tiles are stored as lossless WebP. For tools that cannot read it, or that would rather have smaller files, the tile endpoint can serve other formats, picked with `?format=`:

| `format=`        | Image                                                                    | Redirects to               |
| ---------------- | ------------------------------------------------------------------------ | -------------------------- |
| `webp` (default) | Lossless WebP, exactly as stored                                         | `/blobs/<hash>.webp`       |
| `png`            | Lossless PNG; larger than the WebP                                       | `/blobs/<hash>.png`        |
| `jpg-95`         | JPEG, quality 95, full colour resolution                                 | `/blobs/<hash>.95.jpg`     |
| `jpg-80`         | JPEG, quality 80; about a third of the WebP's size                       | `/blobs/<hash>.80.jpg`     |
| `webp-lossy`     | Lossy WebP, quality 80; the smallest, about a quarter of the WebP's size | `/blobs/<hash>.lossy.webp` |

```
/api/dimensions/overworld/tiles/0/3/-2?format=png
/api/dimensions/overworld/tiles/0/3/-2?format=jpg-80&rev=120
```

- Zoom runs the other way from usual web map tiles: 0 is the most detailed level (one pixel per block), and each level above halves the detail, up to `MAX_ZOOM`.
- JPEG has no transparency, so unexplored areas are black instead of transparent.
- `rev` and `only` work with every format.
- A tile is converted the first time it is asked for in a format (a few milliseconds, up to about 30 for lossy WebP) and the result is kept on disk next to the WebP, so later requests cost the same as the WebP. Like the WebP, the image a redirect points to never changes and can be cached for good.

## Link previews

Pasting a link to the map into Discord, Slack and similar shows a card with a picture of that spot. The server renders it: `GET /api/preview.png?dim=&x=&z=&zoom=&rev=` composites the tiles around the point into a 1200×630 PNG with a marker in the middle (no headless browser), and `/` carries the matching Open Graph and Twitter tags. Rules:

- The image contains tiles only (no layers or features, so nothing from private layers can show up in it), and the map is public, so anyone may request it.
- All values in the tags are HTML-escaped, and the URLs are rebuilt from validated numbers rather than echoing the query string.
- Images are cached on disk (`DATA_DIR/preview-cache`, newest `PREVIEW_CACHE_MAX` kept), keyed by dimension, position, zoom and revision. Identical concurrent requests share one render and at most two renders run at once.

## Operations

### Data layout

```
data/db.sqlite     SQLite (WAL mode)
data/blobs/ab/cd/<sha256>.webp    tile images, content-addressed and immutable
data/blobs/ab/cd/<sha256>.png     the same tile in other formats (also .95.jpg, .80.jpg, .lossy.webp),
                                  made on first request; not backed up, as they can be made again
data/incoming/     uploads waiting to be processed (deleted when the job finishes)
data/preview-cache/
data/gc-quarantine/  only while gc-blobs --delete runs (see below)
```

### Backups

```bash
docker compose exec aomc-map bun scripts/backup.ts /data/backups     # or: bun run backup <dir> --data ./data
```

This writes a consistent `db-<UTC timestamp>.sqlite` (SQLite's `VACUUM INTO`, safe while the server runs) and copies any blobs the destination doesn't have yet. Blobs never change once written, so the copy only ever grows and repeated runs are cheap. `--keep N` (default 14, at least 1) prunes old database snapshots. Put it in cron, then sync the destination off the machine with whatever you already use (rsync, restic, rclone, …). Litestream also works for continuous database replication, if you want it; the blobs still need the copy above.

**Restore:** stop the server, copy the snapshot to `data/db.sqlite` (delete any `db.sqlite-wal` and `db.sqlite-shm` next to it), merge the backed-up `blobs/` into `data/blobs/`, start the server.

### Cleaning up blobs

Failed or superseded work can leave blobs that nothing references. The collector is a dry run unless you pass `--delete`:

```bash
docker compose exec aomc-map bun scripts/gc-blobs.ts            # report only
docker compose exec aomc-map bun scripts/gc-blobs.ts --delete
```

Copies in other [tile formats](#tile-formats) are removed together with their WebP. It keeps everything referenced by a tile version or an upload patch, keeps files younger than an hour (`--min-age-minutes`, a positive number; the blob store refreshes a file's age whenever an upload reuses it), and refuses to delete while jobs are pending, because a running job writes blobs before the database row that points to them. A scan can outlast a job starting, so `--delete` first moves the candidates into `data/gc-quarantine/`, reads the database again, puts back whatever became referenced or young (all of it, with an error, if a job has appeared) and only then deletes. A run that was killed halfway leaves files there; the next `--delete` run puts them back and judges them again.

### Importing the old (v1) map

The importer uses only the public API, so it works against any running server. v1 stored tiles as `<dimension>/<zoom>/<x>_<z>.png` where x and z are the block coordinates of the tile's top-left corner; only zoom 0 is imported (the other levels are rebuilt by the server).

```bash
export AOMC_TOKEN=aomc_…          # an editor's token, from POST /api/tokens
bun scripts/import-v1.ts --url https://map.example.com \
    --src /path/to/v1/data/output --state import-state.json
```

It uploads in batches (`--batch`, default 200; also capped by the server's `MAX_FILES_PER_UPLOAD` and `MAX_UPLOAD_BYTES`, which it reads from `/api/map`) with explicit coordinates, waits for each batch to finish, and records finished files in the state file, so an interrupted run resumes where it stopped (run the same command again). Each tile is sent with an export date, so the import layers under newer real exports like any [old export](#using-the-map): by default the file's modified time, cut back to its UTC day (one revision per day), or `--date 2026-01-31` for all tiles. `--dims overworld,nether` limits the dimensions and `--dim-map old=slug` renames one. The dimensions must already exist on the map (all are checked before anything is uploaded). Tiles that are entirely black have nothing to import and are skipped. Check the result on a copy of your data first: a moderator can delete an import batch by batch from the upload log, but nothing deletes a whole import in one go.

### Rate limits and quotas

All limits are counted in memory per process and reset on restart.

- **Uploads:** `UPLOAD_RATE_LIMIT` requests per user per minute (429), bounded by `MAX_UPLOAD_BYTES`, `MAX_IMAGE_DIM` and `MAX_FILES_PER_UPLOAD`. There is no storage quota.
- **JSON bodies:** at most 16 MiB (413); uploads are exempt, as they have their own limit.
- **Layers:** a user may have at most 50 live (not deleted) layers; creating more answers 409. Moderators are exempt.
- **Writes:** 120 requests per user per minute across layer and feature changes (`/api/layers/*`, `/api/features/*`, including sharing and imports), then 429. Reads are not counted.
- **Link previews:** 30 renders per client per minute (429); previews already in the cache are free. At most two renders run at once with up to 20 waiting, and a full queue answers 503 with `Retry-After`. The view is snapped before rendering (zoom to half levels, position to about 16 screen pixels), so nearby links share one picture. Clients are told apart by the address your reverse proxy saw: the **last** entry of `X-Forwarded-For` (the one a proxy appends), else the connection address. Run behind a proxy that sets or appends it; if the server is reachable directly, a client can send its own header and dodge the limit, so keep it behind the proxy.

### Health

The container has a health check (`/api/me`). Jobs interrupted by a crash or restart are retried on the next boot (a job that has been interrupted three times is marked failed instead); a revision only becomes visible when it is fully written, so a half-finished upload never shows.

## How it works

- **Tiles.** An upload is cut into one patch per touched tile (black pixels become transparent), the patch is composited over the tile's current image (or, if a newer export already covers the tile, the tile is replayed from every patch in export-date order), and the zoom-out pyramid above it is rebuilt. Tile images are lossless WebP stored by content hash. A tile's history is a list of `(tile, rev, blob)` rows, so "the map at revision R" is the newest row at or before R for each tile. All of a revision's rows are committed in one transaction together with the new head revision.
- **Deleting** an upload does rewrite history, on purpose. For each tile the upload touched, the server replays, at every revision from the upload's own onwards, the uploads that were live then (oldest export first) without it, and stores a row wherever the result differs from the revision before. The zoomed-out tiles above are rebuilt from the rewritten rows, the upload and its patches are removed, and everything is swapped in by one transaction. The map's `epoch` is bumped and is part of the tile URLs and the preview cache key, so browsers and previews don't keep serving the old immutable tiles. Run `gc-blobs` afterwards to reclaim the files nothing refers to any more.
- **Features** are append-only: a feature row only gives an identity; every edit, deletion and restore is a new revision. "The layer at revision R" is read by timestamp.
- **Permissions** live in one module (`server/src/permissions.ts`) as pure functions with table-driven tests; routes ask it rather than comparing roles themselves.
- **The map renderer** (`web/src/map`) keeps one cache slot per tile and revalidates it in place when the revision changes, so scrubbing the slider doesn't blank the screen. The tile level is chosen so tiles are never upscaled.

## Security notes

- Sessions are random values stored hashed; API tokens and invite tokens are shown once and stored hashed.
- The map and its tile images are public: `GET /blobs/<hash>.webp` and the tile endpoints need no login. Only layers can be private, and their features are never part of the tiles.
- Cookie-authenticated writes require a matching `Origin` header. Popups and share tags are escaped or rendered as text.
- Anyone who can log in via Discord can edit the main map as an editor; moderators and owners are granted explicitly.

## Conventions

- Authorization goes through `permissions.ts`; private resources answer 404 to people who can't see them.
- Input is validated with zod at the route boundary through `validate` (`server/src/validate.ts`, a wrapper around `validator` from `hono-openapi` that answers 400 `{error, issues}`), and the types are shared with the client (`shared/` and the Hono client types).
- Durations (`SECOND`, `MINUTE`, `HOUR`, `DAY`) come from `shared/src/time.ts`, and the data directory's layout from `server/src/paths.ts`.
- Every route carries a `doc({...})` (`server/src/openapi.ts`) giving its tag, summary and status codes; the request shapes come from the validators. A test fails if a route is missing from the spec. The event channel is described by hand in `server/src/asyncapi.ts`, typed against `ProgressEvent`.
- No raw SQL string building: Drizzle, or `sql` template tags.
- Images always go through the blob store; client file names are never used as paths.
- Keep dependencies few: ask whether it's under ~50 lines of our own code first.
