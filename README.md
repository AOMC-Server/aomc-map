# AOMC Map v2

Bun workspace: `server/` (Hono + Drizzle + SQLite), `shared/` (zod schemas, coordinate math), `web/` (frontend, not built yet).

## Bun for Node users

| Node          | Bun           |
| ------------- | ------------- |
| `npm install` | `bun install` |
| `npm run dev` | `bun run dev` |
| `npm test`    | `bun test`    |
| `npx <tool>`  | `bunx <tool>` |

## Setup

1. `bun install`
2. `cp .env.example .env` and fill in the Discord OAuth credentials. The redirect URI is `<PUBLIC_URL>/auth/discord/callback`.
3. `bun run dev` (migrations and first-run setup happen on boot)

## Scripts

- `bun run dev` – server with watch (API on :3000)
- `bun run dev:web` – Vite dev server with hot reload, proxying `/api`, `/auth` and `/blobs` to :3000
- `bun run build` – production web build into `web/dist`, which the server serves (with SPA fallback)
- `bun test` – tests
- `bun run lint` – Biome
- `bun run db:generate` – generate a migration after editing `server/src/db/schema.ts`

## Notes

- All authorization lives in `server/src/permissions.ts`; private resources return 404 to users who can't see them.
- Blobs are served without auth, so a shared blob hash from a private map is accessible.

## Uploading tiles

```bash
curl -H "Authorization: Bearer aomc_..." \
  -F 'files[]=@Overworld_x-512_z0.png' -F 'files[]=@Overworld_x0_z0.png' \
  http://localhost:3000/api/maps/aomc/dimensions/overworld/uploads
# -> {"revisionId": 1}; poll GET /api/revisions/1 or stream GET /api/revisions/1/events (SSE)
```

- File names need `_x<X>_z<Z>` (block coordinates of the top-left corner), or send `coords` as a JSON array of `{x, z}` aligned with the files (after zip expansion). `.zip` archives are expanded and their paths ignored.
- Pure black pixels mean "no data". Later files in an upload never overwrite earlier ones with black.
- Tiles: `GET /api/maps/:map/dimensions/:dim/tiles/:zoom/:x/:y?rev=R` (302 to `/blobs/<hash>.webp`, or 204 if empty). Zoom 0 is 1 block per pixel; tile indices are `floor(block / tileSize)`.
- Moderators can `POST /api/revisions/:id/revert` and `/unrevert`. History is never rewritten, so older revs still show the reverted upload.
- Limits (env): `MAX_UPLOAD_BYTES`, `MAX_IMAGE_DIM`, `MAX_FILES_PER_UPLOAD`, `UPLOAD_RATE_LIMIT`, `MAX_ZOOM`.

## Viewer

URL state: `/?map=<slug>&dim=<slug>&x=&z=&zoom=&rev=`. `rev` is omitted when viewing head, `embed=1` hides all UI (for iframes), and `/` alone opens the default map. Zoom is a float: 0 is 1 block per pixel, negative magnifies (down to -4), positive zooms out (up to `MAX_ZOOM`).

Controls: drag/touch to pan (with inertia), wheel or pinch to zoom at the cursor, double-click to zoom in, arrow keys and `+`/`-`. Measure and Copy-coords tools are in the toolbar; Esc clears the measurement.

## Layers and features

Layers hold pins, lines and areas (polygons) and belong to one dimension of a map. Edits are append-only: every change adds a revision, and deleting adds a "deleted" revision, so nothing is lost.

- `GET /api/maps/:map/layers?dim=<slug>&at=<rev>` returns the layers visible to you with their features as of revision `at` (omit for now).
- `POST /api/maps/:map/layers`, `PATCH/DELETE /api/layers/:id` (delete is soft), `POST /api/layers/:id/features`, `PATCH/DELETE /api/features/:id`, `GET /api/features/:id/history`, `POST /api/features/:id/restore/:revisionId` (moderators).
- `GET /api/layers/:id/export` and `POST /api/layers/:id/import[?replace=1]` use a JSON array of `{type, name, popup, color, geometry}`; pins have `[x, z]`, lines and areas `[[x, z], ...]`, all integers within ±30,000,000. At most 5000 features per layer.
- Private layers are visible to map moderators and the layer's members only; everyone else gets a 404.
- Popups support only `**bold**`, `[links](https://…)` and line breaks, and are rendered as text, never HTML.

In the app: the **Layers** panel toggles visibility and creates layers; "Add feature" opens the editor, where you click the map to place points (drag a point to move it, Enter or Finish to complete, Esc to cancel).
