# AOMC Map v2

Bun workspace: `server/` (Hono + Drizzle + SQLite), `shared/` (zod schemas, coordinate math), `web/` (frontend, not built yet).

## Bun for Node users

| Node | Bun |
|---|---|
| `npm install` | `bun install` |
| `npm run dev` | `bun run dev` |
| `npm test` | `bun test` |
| `npx <tool>` | `bunx <tool>` |

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
