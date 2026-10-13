# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build ----
FROM node:24-alpine AS build
WORKDIR /app

# Manifests first so the dependency layer survives source-only changes.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY shared shared
COPY server server
COPY client client
RUN npm run build

# -------------------------------------------------------------- runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Stamped by CI so a running instance — and every GlitchTip event — can say
# which build it is.
ARG GROCER_VERSION=dev
ARG GROCER_BUILT_AT=
ENV GROCER_VERSION=$GROCER_VERSION
ENV GROCER_BUILT_AT=$GROCER_BUILT_AT

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
# Only the server needs runtime dependencies; the client ships as static files.
RUN npm ci --omit=dev --workspace server --include-workspace-root && npm cache clean --force

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist

# SQLite lives on a mounted volume so the data outlives the container.
ENV GROCER_DATA_DIR=/data \
    GROCER_CLIENT_DIR=/app/client/dist \
    PORT=8080 \
    HOST=0.0.0.0
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/server/src/index.js"]
