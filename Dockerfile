FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY server server
COPY shared shared
RUN mkdir /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 3000
CMD ["bun", "server/src/index.ts"]
