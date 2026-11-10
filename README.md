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

- `bun run dev` – server with watch
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
