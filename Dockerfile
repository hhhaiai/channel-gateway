FROM node:22.22.2-bookworm-slim AS dependencies

WORKDIR /app
ARG CHANNEL_PROFILE=base

COPY package.json package-lock.json ./
COPY scripts/patch-openclaw-dist.mjs ./scripts/patch-openclaw-dist.mjs
COPY src/host-patch.js ./src/host-patch.js
COPY patches ./patches

RUN case "$CHANNEL_PROFILE" in \
      base) npm ci --omit=dev --omit=optional ;; \
      common) npm ci --omit=dev ;; \
      *) echo "CHANNEL_PROFILE must be base or common" >&2; exit 2 ;; \
    esac \
 && npm run verify:openclaw-patch \
 && npm cache clean --force

FROM node:22.22.2-bookworm-slim AS runtime

ENV NODE_ENV=production \
    CHANNEL_GATEWAY_DATA_DIR=/data \
    CHANNEL_GATEWAY_BIND=lan \
    CHANNEL_GATEWAY_PORT=18789
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json index.js openclaw.plugin.json ./
COPY bin ./bin
COPY src ./src
COPY scripts ./scripts
COPY patches ./patches
COPY licenses ./licenses

RUN mkdir -p /data/config /data/state /data/credentials /data/workspace \
 && chown -R node:node /data

USER node
EXPOSE 18789
CMD ["node", "bin/channel-gateway.js"]
