# AOMC Map

A web map for a Minecraft server, built from [Xaero's World Map](https://modrinth.com/mod/xaeros-world-map) exports. Players upload exported images, the server stitches them into tiles, and everyone can browse the map, add pins, lines and areas, and travel back through the map's history. Logins are via Discord.

- Every upload is a **revision**: browse any past state with the time slider, and moderators can revert or restore uploads without losing history.
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
   # fill in DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, PUBLIC_URL, a random SESSION_SECRET,
   # and SETUP_OWNER_DISCORD_IDS (your own Discord user id)
   ```

   To get your Discord user id: enable _Developer Mode_ in Discord's settings, then right-click yourself and choose _Copy User ID_.
3. **Run**:

   ```bash
   docker compose up -d --build
   docker compose logs -f
   ```
4. Open `PUBLIC_URL`, log in with Discord, and you are an owner of the main map (**Manage** appears in the toolbar). Upload some exports with **Upload**.

The first start creates the main map with the dimensions Overworld, Overworld Caves, Nether and The End. Everything lives in `./data` (`db.sqlite` and `blobs/`), which is the only thing you need to back up. Migrations run automatically on boot, so upgrading is `git pull && docker compose up -d --build`.

> The `:z` on the volume in `docker-compose.yml` relabels the directory for SELinux hosts and is harmless elsewhere.

### Behind a reverse proxy

Terminate TLS in front of the container and set `PUBLIC_URL` to the public `https://` address (cookies are only marked `Secure` for https, and the CSRF check compares the `Origin` header to `PUBLIC_URL`). Two proxy settings matter:

- Allow request bodies of at least `MAX_UPLOAD_BYTES` (200 MB by default). For nginx: `client_max_body_size 200m;`.
- Do not buffer server-sent events (`/api/revisions/<id>/events`). For nginx: `proxy_buffering off;` on that location (or the whole server).

## Local development

```bash
bun install
cp .env.example .env      # Discord credentials are only needed to log in
bun run dev               # API on :3000, restarts on change
bun run dev:web           # Vite dev server with hot reload; proxies /api, /auth, /blobs to :3000
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

| Variable                                     | Default                 | Meaning                                                                       |
| -------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |                         | Discord OAuth credentials                                                     |
| `SESSION_SECRET`                             | dev value               | signs the OAuth state cookie; set a long random string                        |
| `PUBLIC_URL`                                 | `http://localhost:3000` | public address; used for cookies, the Origin check, invite links and previews |
| `SETUP_MAP_NAME`, `SETUP_MAP_SLUG`           | `AOMC`, `aomc`          | the main map created on first boot                                            |
| `SETUP_OWNER_DISCORD_IDS`                    |                         | comma-separated Discord ids that become owners when they first log in         |
| `PORT`                                       | `3000`                  | listen port                                                                   |
| `DATA_DIR`                                   | `./data`                | database, blobs, preview cache (`/data` in Docker)                            |
| `DEFAULT_TILE_SIZE`                          | `512`                   | blocks per tile edge for the main map; locked after the first upload          |
| `MAX_ZOOM`                                   | `8`                     | zoom-out levels above 1:1                                                     |
| `MAX_UPLOAD_BYTES`                           | 200 MB                  | per upload request                                                            |
| `MAX_IMAGE_DIM`                              | `4096`                  | longest edge of one uploaded image                                            |
| `MAX_FILES_PER_UPLOAD`                       | `2000`                  | files per request                                                             |
| `UPLOAD_RATE_LIMIT`                          | `30`                    | upload requests per user per minute                                           |
| `PREVIEW_CACHE_MAX`                          | `500`                   | link-preview images kept on disk                                              |

## Using the map

**Viewer.** `/?map=<slug>&dim=<slug>&x=&z=&zoom=&rev=` is kept in the address bar, so every view is a shareable link (`rev` is omitted at the latest revision). `embed=1` hides all UI for iframes. Zoom 0 is one block per pixel, negative zooms in (down to -4), positive zooms out. Drag or touch to pan, wheel or pinch to zoom, double-click to zoom in, arrow keys and `+`/`-`. The toolbar has _Measure_ (two clicks, Esc clears) and _Copy coords_ (click to build a list on the clipboard).

**Uploading.** Use _Upload_ in the toolbar, or the API (below). In Xaero's World Map: turn resource packs off, drag with the right mouse button over an area, export as PNG with **Multiple Unscaled Images** on, then upload the images (or a ZIP of them). File names contain `_x<X>_z<Z>` (the block coordinates of the top-left corner). Pure black pixels mean "no data" and never overwrite anything. Processing runs in a background queue, one job at a time; you can close the dialog while it works.

**Layers and features.** The _Layers_ panel toggles visibility and creates layers. "Add feature" opens the editor: click the map to place points, drag a point to move it, Enter or _Finish_ to complete, Esc to cancel. Popups support `**bold**`, `[links](https://…)` and line breaks, and are rendered as text, never HTML. Layers can be exported and imported as JSON (an array of `{type, name, popup, color, geometry}`; pins have `[x, z]`, lines and areas `[[x, z], …]`, integers within ±30,000,000, at most 5000 features per layer).

**History.** The _History_ panel has the time slider (tiles and features both follow it) and the upload log. Hover or click an entry to outline its area. While looking at the past editing is off. Moderators can **Revert** an upload and **Restore** it again; this publishes a new revision, so older revisions still show what was there. Feature popups have a _History_ button, and moderators can restore an earlier version of a feature (to bring back a deleted one, slide to a revision where it existed, open its popup, and restore).

**Roles.** _viewer_ can look, _editor_ can upload and edit, _moderator_ can also revert uploads and restore features (and manage dimensions on the main map), _owner_ can also manage members, invites and settings. Logged-in visitors of the public main map are implicit editors; anonymous visitors are viewers.

**Managing the map** (_Manage_ in the toolbar):

- _Settings_: name, and tile size (until the first upload).
- _Dimensions_: add, rename, reorder, archive. Archived dimensions keep their tiles and history.
- _Members_: change roles, remove people, or add someone by Discord user id (they must have logged in once). The last owner can't be demoted or removed.
- _Invites_: links with a role (viewer, editor, moderator), an expiry and an optional use limit. The link is shown once and only a hash is stored. `/invite/<token>` shows who invited you, asks you to log in, and lands you on the map. Accepting never lowers anyone's role.

**Private layers** (a layer's visibility setting) are only visible to map moderators and the layer's members. The layer's creator and moderators get a _Sharing_ button for members and layer invite links. Layer access never opens a private map by itself; people need access to the map first.

## API

Authentication is a session cookie (browser) or `Authorization: Bearer aomc_…` (scripts). Create a token with `POST /api/tokens {"name": "…"}` while logged in; it is shown once. Writes made with a cookie must come from `PUBLIC_URL` (CSRF), Bearer requests need no such check. Errors are JSON `{"error": "…"}`; resources you may not see answer 404.

```bash
# Upload
curl -H "Authorization: Bearer aomc_…" \
  -F 'files[]=@Overworld_x-512_z0.png' -F 'files[]=@Overworld_x0_z0.png' \
  http://localhost:3000/api/maps/aomc/dimensions/overworld/uploads
# -> {"revisionId": 1}   poll GET /api/revisions/1, or stream GET /api/revisions/1/events (SSE)
```

An upload may also carry `coords`, a JSON array of `{x, z}` aligned with the files (after ZIP expansion), which overrides the file names. ZIP entries are read by base name only.

| Area      | Endpoints                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session   | `GET /auth/discord`, `GET /auth/discord/callback`, `POST /auth/logout`, `GET /api/me`, `GET/POST/DELETE /api/tokens`                                                                |
| Maps      | `GET /api/maps`, `GET/PATCH /api/maps/:slug`, `…/dimensions` (`POST`, `PATCH /:dim`), `…/members`                                                                                   |
| Tiles     | `GET /api/maps/:map/dimensions/:dim/tiles/:zoom/:x/:y?rev=R` → 302 to `/blobs/<hash>.webp`, or 204 if empty; zoom 0 is 1:1 and a tile index is `floor(block / tileSize)`            |
| Revisions | `GET /api/maps/:map/revisions`, `GET /api/revisions/:id`, `…/events` (SSE), `POST …/revert`, `POST …/unrevert`                                                                      |
| Layers    | `GET /api/maps/:map/layers?dim=&at=<rev>`, `POST /api/maps/:map/layers`, `PATCH/DELETE /api/layers/:id`, `POST /api/layers/:id/features`, `GET /export`, `POST /import[?replace=1]` |
| Features  | `PATCH/DELETE /api/features/:id`, `GET …/history`, `POST …/restore/:revisionId`                                                                                                     |
| Sharing   | `…/invites` (map and layer), `GET /api/invites/:token`, `POST …/accept`, `DELETE /api/invites/:id`, `…/layers/:id/members`                                                          |
| Images    | `GET /blobs/<hash>.webp`, `GET /api/preview.png`                                                                                                                                    |

## Link previews

Pasting a link to the map into Discord, Slack and similar shows a card with a picture of that spot. The server renders it: `GET /api/preview.png?map=&dim=&x=&z=&zoom=&rev=` composites the tiles around the point into a 1200×630 PNG with a marker in the middle (no headless browser), and `/` carries the matching Open Graph and Twitter tags. Rules:

- Only **public** maps get a preview and a title. Crawlers are anonymous, so private maps return 404 for the image and the page keeps its generic title; nothing about them leaks. Logged-in members can still request the image for their private maps.
- All values in the tags are HTML-escaped, and the URLs are rebuilt from validated numbers rather than echoing the query string.
- Images are cached on disk (`DATA_DIR/preview-cache`, newest `PREVIEW_CACHE_MAX` kept), keyed by map, dimension, position, zoom and revision. Identical concurrent requests share one render and at most two renders run at once.

## Operations

### Data layout

```
data/db.sqlite     SQLite (WAL mode)
data/blobs/ab/cd/<sha256>.webp    tile images, content-addressed and immutable
data/incoming/     uploads waiting to be processed (deleted when the job finishes)
data/preview-cache/
```

### Backups

```bash
docker compose exec aomc-map bun scripts/backup.ts /data/backups     # or: bun run backup <dir> --data ./data
```

This writes a consistent `db-YYYYMMDD-HHMMSS.sqlite` (SQLite's `VACUUM INTO`, safe while the server runs) and copies any blobs the destination doesn't have yet. Blobs never change once written, so the copy only ever grows and repeated runs are cheap. `--keep N` (default 14) prunes old database snapshots. Put it in cron, then sync the destination off the machine with whatever you already use (rsync, restic, rclone, …). Litestream also works for continuous database replication, if you want it; the blobs still need the copy above.

**Restore:** stop the server, copy the snapshot to `data/db.sqlite` (delete any `db.sqlite-wal` and `db.sqlite-shm` next to it), merge the backed-up `blobs/` into `data/blobs/`, start the server.

### Cleaning up blobs

Failed or superseded work can leave blobs that nothing references. The collector is a dry run unless you pass `--delete`:

```bash
docker compose exec aomc-map bun scripts/gc-blobs.ts            # report only
docker compose exec aomc-map bun scripts/gc-blobs.ts --delete
```

It keeps everything referenced by a tile version or an upload patch, keeps files younger than an hour (`--min-age-minutes`), and refuses to delete while jobs are pending, because a running job writes blobs before the database row that points to them.

### Importing the old (v1) map

The importer uses only the public API, so it works against any running server. v1 stored tiles as `<dimension>/<zoom>/<x>_<z>.png` where x and z are the block coordinates of the tile's top-left corner; only zoom 0 is imported (the other levels are rebuilt by the server).

```bash
export AOMC_TOKEN=aomc_…          # an editor's token, from POST /api/tokens
bun scripts/import-v1.ts --url https://map.example.com --map aomc \
    --src /path/to/v1/data/output --state import-state.json
```

It uploads in batches (`--batch`, default 200) with explicit coordinates, waits for each batch to finish, and records finished files in the state file, so an interrupted run resumes where it stopped (run the same command again). `--dims overworld,nether` limits the dimensions and `--dim-map old=slug` renames one. The dimensions must already exist on the map. Tiles that are entirely black have nothing to import and are skipped. Check the result on a copy of your data first: a revert undoes an import batch by batch, but nothing deletes a whole import.

### Rate limits and quotas

Upload requests are limited per user (`UPLOAD_RATE_LIMIT` per minute, in memory), and uploads are bounded by `MAX_UPLOAD_BYTES`, `MAX_IMAGE_DIM` and `MAX_FILES_PER_UPLOAD`. There is no per-map storage quota.

### Health

The container has a health check (`/api/me`). Jobs interrupted by a crash or restart are retried on the next boot; a revision only becomes visible when it is fully written, so a half-finished upload never shows.

## How it works

- **Tiles.** An upload is cut into one patch per touched tile (black pixels become transparent), the patch is composited over the tile's current image, and the zoom-out pyramid above it is rebuilt. Tile images are lossless WebP stored by content hash. A tile's history is a list of `(tile, rev, blob)` rows, so "the map at revision R" is the newest row at or before R for each tile. All of a revision's rows are committed in one transaction together with the new head revision.
- **Reverting** never rewrites history. For each tile the upload touched, the server replays every upload that is currently not reverted, in order, and publishes the result as a new revision. Because replay starts from nothing, reverting an upload can't resurrect something that was reverted earlier.
- **Features** are append-only: a feature row only gives an identity; every edit, deletion and restore is a new revision. "The layer at revision R" is read by timestamp.
- **Permissions** live in one module (`server/src/permissions.ts`) as pure functions with table-driven tests; routes never check roles themselves.
- **The map renderer** (`web/src/map`) keeps one cache slot per tile and revalidates it in place when the revision changes, so scrubbing the slider doesn't blank the screen. The tile level is chosen so tiles are never upscaled.

## Security notes

- Sessions are random values stored hashed; API tokens and invite tokens are shown once and stored hashed.
- `GET /blobs/<hash>.webp` needs no login: hashes are unguessable, but a hash taken from a private map's tile URL would still work. Treat private maps as "not listed" rather than "encrypted".
- Cookie-authenticated writes require a matching `Origin` header. Popups and share tags are escaped or rendered as text.
- Anyone who can log in via Discord can edit the main map as an editor; moderators and owners are granted explicitly.

## Conventions

- Authorization goes through `permissions.ts`; private resources answer 404 to people who can't see them.
- Input is validated with zod at the route boundary, and the types are shared with the client (`shared/` and the Hono client types).
- No raw SQL string building: Drizzle, or `sql` template tags.
- Images always go through the blob store; client file names are never used as paths.
- Keep dependencies few: ask whether it's under ~50 lines of our own code first.
