FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1 AS web
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY web/package.json web/
RUN bun install --frozen-lockfile
COPY tsconfig.base.json ./
COPY shared shared
COPY web web
RUN bun run --cwd web build

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package.json ./
COPY server server
COPY shared shared
COPY scripts scripts
# Bun links workspace dependencies through each package's own node_modules.
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/server/node_modules server/node_modules
COPY --from=deps /app/shared/node_modules shared/node_modules
COPY --from=web /app/web/dist web/dist
RUN mkdir /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/me`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "server/src/index.ts"]
