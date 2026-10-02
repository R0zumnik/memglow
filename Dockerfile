# memglow — live 3D view of a Markdown memory folder.
#   docker build -t memglow .
#   docker run -d -p 4747:4747 -v /path/to/notes:/memory:ro \
#     -e MEMGLOW_TOKEN=... -e MEMGLOW_PASSWORD=... memglow
#
# Variant with Claude Code, for the assistant's "Claude Code subscription (no API key)" provider:
#   docker build --build-arg CLAUDE_CODE=1 -t memglow:claude .
# It installs the `claude` CLI at BUILD time (npm, about +230 MB, no download at run time, auto-update
# off). Sign-in: run `claude setup-token` on a computer where you are signed in and pass the token as
# CLAUDE_CODE_OAUTH_TOKEN (or type it in the page from http://127.0.0.1). The base image is unchanged.
FROM node:22-alpine
ARG CLAUDE_CODE=0
ARG CLAUDE_CODE_VERSION=latest
WORKDIR /app
COPY package.json server.js THIRD_PARTY_LICENSES LICENSE ./
COPY lib ./lib
COPY public ./public
COPY hooks ./hooks
RUN if [ "$CLAUDE_CODE" = "1" ]; then npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force; fi
ENV NODE_ENV=production \
    MEMORY_DIR=/memory \
    MEMGLOW_DATA_DIR=/data \
    MEMGLOW_DOCKER=1 \
    DISABLE_AUTOUPDATER=1 \
    HOST=0.0.0.0 \
    PORT=4747
# Read-only access to the notes is enough: memglow never writes to MEMORY_DIR. Its own data
# (Memory cost counters: note ids and numbers; set-up choices; keys typed in the page, mode 600)
# goes to /data — mount a volume to keep it.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4747/api/graph >/dev/null || exit 1
CMD ["node", "server.js"]
